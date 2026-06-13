# DECISION-012: Correlation IDs, audit-as-complete-tool-ledger, and per-turn session accumulation

## Context

The proactivity eval pipeline (Phase 1 / 1.1) wants to *replay* a logged decision
under a candidate prompt to score prompt changes. Faithful replay needs the exact
tool I/O the agent saw at decision time — and an audit of where that data actually
lives showed:

- `ll5_app_log` records tool **calls** (name, duration, success) but never the args
  or the response — useless as a replay cassette.
- `ll5_audit_log` records **mutations** only (entity ids + a summary), via explicit
  `logAudit` calls — not reads, not full payloads.
- The domain stores (journal, GPS, messages) are **live and mutable** — replaying
  off them reconstructs "now", not "what the tool returned then".
- The only full-fidelity record of tool I/O is the **agent transcript**, which is
  not durable (Claude Code rotates/compacts it) and whose indexed copy
  (`ll5_session_history`, written once at SessionEnd) is **text-only**.

Separately, two latent reliability problems surfaced:

- **No correlation id anywhere.** Nothing ties the actions of one tool call —
  let alone one agent turn — together across app-log / audit / session.
- **Session capture is a single SessionEnd dump.** The agent (`claude`) restarts
  constantly (supervisor relaunch on every exit, autoheal, redeploy), so on a
  crash/kill/redeploy SessionEnd never fires and the **whole session is lost**.

## Decision

Make the **logging/audit layer the durable, complete, correlated record of every
tool call**, and make **session capture incremental and crash-safe**. Owner intent
(recorded): keep everything (no retention cap, no truncation), PII is acceptable on
this single-user personal server for now, and correlation ids span all actions.

### 1. Audit becomes the complete tool-call ledger (extend `ll5_audit_log`)
Extend `withToolLogging` (the one wrapper on all 6 MCPs, which already holds both
the args and the `result`) to write, per call, a full record into the **existing
`ll5_audit_log`** index (not a new index — keep domains simple, let the log-explorer
UI trace a concern end-to-end):

- Add a `kind` discriminator: `mutation` (today's semantic `logAudit` rows) vs
  `tool_call` (the new complete-I/O rows).
- New fields on `tool_call` rows: `tool_name`, `args`, `result`, `duration_ms`,
  `success`, `error_message`, plus the correlation ids below.
- **`args`/`result` are stored as non-indexed JSON** (ES `enabled:false` object or a
  JSON string). "Keep everything" + indexing every nested key would explode the
  mapping; we keep the bytes, not the inverted index, for payloads.

### 2. Correlation ids on every action
Widen the per-request context (each MCP already uses `AsyncLocalStorage<string>` for
`userId`) into a shared `@ll5/shared` request-context carrying `{ userId,
requestId, sessionId?, traceId? }`:

- **`request_id`** — generated at request entry; stamped on `app_log`, `audit`, and
  the tool-call ledger. Every row a single tool call produces shares it. Fully in
  our control; the bulk of "correlation everywhere".
- **`session_id` / `trace_id` (turn)** — propagated FROM the agent. The MCP
  `headersHelper` (`~/.ll5/get-mcp-auth.sh`) is the injection point: a SessionStart
  hook writes `session_id` (and per-trigger a `turn_id` derived from the trigger's
  `event_id` or a uuid) to a context file; the helper emits `X-LL5-Session-Id` /
  `X-LL5-Trace-Id`; `tokenAuthMiddleware` reads them into the context.
  - `session_id` is **reliable** (stable per session).
  - `turn_id` is **best-effort** — accurate only if Claude Code evaluates the helper
    per request (vs per-connection caching, unverified). Where stale/absent, the
    eval cassette falls back to matching ledger rows by `(user, tool, args,
    time-window)`, which the transcript pins exactly.
- The gateway (Express) gets a request-id middleware so its logs join the same trace.

### 3. Per-turn session accumulation (replaces the SessionEnd-only dump)
Save the session **incrementally as turns complete** instead of once at the end:

- SessionStart: create the session doc early (status `active`).
- Every turn (Stop hook, which already fires per turn): write the session-so-far
  (crash-safe — whatever completed is persisted). v1 reuses the existing
  text-extraction + `POST /sessions` (idempotent full overwrite, zero new infra);
  delta-append (O(n) vs O(n^2) transfer) and full-fidelity message content are
  follow-up optimizations.
- SessionEnd: finalize (status `ended`) — now a backstop, not the sole writer.

A session is then its turns; each turn its tool calls (ledger rows); each call its
full I/O — all joined by `session_id` / `trace_id`. The session store and the audit
ledger become two correlated views of one trace, which is the foundation for an
end-to-end "trace a concern" UI and for the eval cassette (a query, not a copy).

## Alternatives considered

- **New `ll5_tool_calls` index** instead of extending audit — rejected per owner
  preference: separate domains risk functionality getting lost and complicate an
  end-to-end trace UI.
- **Eval-pipeline copies its own cassette sidecar** — rejected: duplicates data the
  logging layer should own; a per-turn slice is also *smaller* than retaining whole
  transcripts, but a durable ledger removes the retention dependency entirely.
- **Pointer-into-transcript** — rejected as the primary mechanism: the transcript
  isn't durable and its indexed copy is lossy.
- **Retention cap / payload truncation / PII redaction** — deferred: owner chose
  keep-everything on a single-user server. Revisit before any multi-tenant use.

## Consequences

- `ll5_audit_log` grows fast (every tool call, full I/O, forever). Acceptable now;
  ES is under memory pressure, so retention/caps are the first thing to revisit.
- A complete tool-I/O ledger is the user's whole life in one index — internal-only
  ES (DECISION-011) is the current control; redaction is deferred.
- `turn_id` correlation is best-effort until agent-boundary propagation is verified.
- Touches the shared layer, all 6 MCP `server.ts`, the gateway, the agent hooks,
  and the session store — staged rollout required.

## Rollout (staged)

1. **Per-turn session accumulation** (deliver + test first; verify the agent comes
   back alive) — agent hooks + a small gateway tweak only; lowest blast radius.
2. Shared request-context + `request_id` on `app_log` / `audit`.
3. Audit-as-tool-ledger (full args/result via `withToolLogging`).
4. session_id / turn_id propagation (hooks -> headers-helper -> middleware).
5. UI to trace by correlation id; eval cassette = audit query + moment pointer.
