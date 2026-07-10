# Claude Code vs opencode — Agent Tool & Capability Parity

Snapshot: **2026-07-10.** Compares the two LL5 agent runtime variants tool-for-tool
so gaps are visible and future parity work is scoped. Sources: `ll5-run/.mcp.json`
+ `ll5-run/channel/ll5-channel.mjs` + `ll5-run/.claude/hooks/` (Claude) and
`ll5-run-opencode/opencode.json` + `.opencode/plugins/` + `scripts/` (opencode).

> Naming note: Claude names MCP tools `server__tool` (double underscore) and channel
> tools are MCP-prefixed; **opencode names MCP tools `server_tool` (single underscore)**
> and plugin tools by their **bare key**. This bit us hard (see `d5fe585`).

---

## 1. MCP data-plane servers (the shared repository tools)

| MCP server | Claude (`.mcp.json`) | opencode (`opencode.json`) | Notes |
|---|---|---|---|
| personal-knowledge | ✅ http | ✅ remote (via proxy) | |
| gtd | ✅ | ✅ | |
| awareness | ✅ | ✅ | |
| google (Claude: `ll5-calendar`) | ✅ | ✅ | key name differs |
| messaging (Claude: `ll5-messaging`) | ✅ | ✅ | key name differs |
| health | ✅ | ✅ | |
| **vault** | ✅ http | ❌ **MISSING** | opencode agent has no secret access |
| **system** | ✅ stdio (`packages/system`) | ❌ **MISSING** | host/system tools absent |
| ll5-channel | ✅ **stdio MCP** (`channel/ll5-channel.mjs`) | provided as **plugin tools**, not an MCP | different mechanism, see §2 |

**Auth mechanism differs:** Claude injects per-MCP auth via a `headersHelper`
(`~/.ll5/get-mcp-auth.sh`) on each http server; opencode routes ALL MCP calls through
a local **correlation-id proxy** sidecar (`scripts/correlation-id-proxy.ts`) that adds
`Authorization` + `X-LL5-Session-Id` + `X-LL5-Trace-Id`.

---

## 2. Agent-callable channel tools

Claude serves these from the `ll5-channel` stdio MCP (`channel/ll5-channel.mjs`, 16
tools). opencode serves them from the `ll5-channel.ts` plugin (`tool: {...}`, 10 tools).

| Tool | Claude | opencode | Notes |
|---|---|---|---|
| push_to_user | ✅ | ✅ | |
| reply | ✅ | ✅ | |
| narrate | ✅ | ✅ | |
| react | ✅ | ✅ | |
| new_conversation | ✅ | ✅ | |
| set_today_card | ✅ | ✅ | |
| add_tray_item | ✅ | ✅ | |
| save_image | ✅ | ✅ | |
| check_mcp_connectivity | ✅ | ✅ | opencode probe fixed (406) 2026-07-10 |
| record_moment | ✅ | ✅ | **added to opencode 2026-07-10** (`fa91358`) |
| **inspect_image** | ✅ | ❌ **MISSING** | vision / image analysis — real capability gap |
| **get_message** | ✅ | ❌ MISSING | fetch a specific chat message |
| **get_current_time** | ✅ | ❌ MISSING | agent has no clock tool (uses model/env) |
| **get_user_settings** | ✅ | ❌ MISSING | read user prefs |
| **set_user_settings** | ✅ | ❌ MISSING | write user prefs |
| **channel_health** | ✅ | ❌ MISSING | channel self-health |

**opencode missing 6 channel tools.** Highest-value gap: `inspect_image` (no vision).

---

## 3. Behavioral layer — Claude hooks vs opencode plugins

Claude uses shell/python hooks (PreToolUse/PostToolUse/Stop/SessionStart/PreCompact);
opencode uses TS plugins (`tool.execute.before/after`, `event`, `chat.message`,
`experimental.session.compacting`). Same intent, different substrate.

| Function | Claude hook | opencode plugin | Parity |
|---|---|---|---|
| Memory write-intercept | `memory-intercept.sh` | `memory-intercept.ts` | ✅ |
| Memory recall | `memory-recall.sh` | `memory-recall.ts` | ✅ |
| External-authority gate (Rule 13) | `external-authority-gate.sh` | `external-authority-gate.ts` | ✅ |
| Cron/scheduling block | `cron-block.sh` | `cron-block.ts` | ✅ |
| Repo-write block | `repo-write-block.sh` | `repo-write-block.ts` | ✅ |
| Session start / re-ground | `session-start.sh` | `session-start.ts` | ✅ |
| Session save / history | `session-save.sh` | `session-history.ts` | ✅ |
| Stop-mirror (fallback reply) | `stop-mirror.sh` | `stop-mirror.ts` | ✅ |
| Narration watchdog ("still on it") | `narration-watchdog.sh` | `narration-watchdog.ts` | ✅ |
| Eval recorder (proactivity dataset) | `eval-record.sh` | `eval-recorder.ts` | ✅ (parity reached 2026-07-10) |
| Activity marker | `activity-marker.sh` | `activity-marker.ts` | ✅ |
| Pre-compact backup | `precompact-backup.sh` | `precompact-backup.ts` | ✅ |
| File-changed notify | `file-changed.sh` | `file-changed.ts` | ✅ |
| Token check | `check-token.sh` | folded into `session-start.ts` | ≈ |
| CLI input mirror | `cli-input-mirror.sh` | `turn-context.ts` (parses `[meta]`) | ≈ (different mechanism) |
| MCP auth injection | `get-mcp-auth.sh` (headersHelper) | `correlation-id-injector.ts` + proxy | ≈ |
| Compaction handling | Claude Code native | `compaction.ts` | opencode-only (native gap) |
| Tool-result telemetry | channel MCP self-reports | `tool-telemetry.ts` | opencode-only (added 2026-07-10) |

- **opencode-only plugins** (adapt to opencode's model): `correlation-id-injector`,
  `compaction`, `turn-context`, `tool-telemetry`.
- **Claude-only hooks**: `check-token`, `cli-input-mirror` (behavior folded elsewhere
  in opencode).

---

## 4. Background workers / scripts

| Worker | Claude (`scripts/`) | opencode (`scripts/`) | Notes |
|---|---|---|---|
| Narrative consolidation loop | `narrative-loop.sh` (`claude -p`) | `narrative-loop.ts` (SDK) | ✅ |
| Reconcile loop | `reconcile-loop.sh` | `reconcile-loop.ts` | ✅ (defer bug fixed `09357b6`) |
| Continuity probe | `continuity-probe.sh` | `continuity-probe.ts` | ✅ |
| MCP autoheal | `mcp-autoheal.sh` / `reconnect-mcps.sh` | `autoheal.ts` | ✅ |
| Session backup | (via `session-save` hook) | `session-backup.ts` | ≈ |
| Correlation-id proxy | N/A (headersHelper) | `correlation-id-proxy.ts` | opencode-only |
| Token generation | `get-mcp-auth.sh` | `generate-token.ts` | ≈ |
| Session register | N/A (channel bridge) | `register-session.ts` | opencode-only |
| Audio transcription | `transcribe.py` | ❌ MISSING | |
| Type-to-terminal | `type-to-terminal.sh` | ❌ MISSING | Claude-CLI-specific |
| Browser auth | `get-browser-auth.sh` | ❌ (vault absent) | |

---

## 5. Trigger mechanism

| | Claude | opencode |
|---|---|---|
| Agent invocation | `claude -p` subprocess via channel bridge | HTTP `POST /session/:id/prompt_async` (gateway `agent-trigger.ts`) |
| Turn metadata | passed to hooks (env/stdin) | prepended `[meta] {...}` text part → `turn-context.ts` |
| Model | Anthropic Claude (subscription) | `opencode/deepseek-v4-pro` (Zen paid) |

---

## 6. Open parity gaps (opencode, ranked)

1. **`inspect_image` (vision)** — no image analysis. High. Historic Claude blind-spot
   (`inspect_image` 2-day outage) — opencode never had it.
2. **`vault` MCP** — no secret access (browser-login/credentials flows unavailable).
3. **`system` MCP** — no host/system tools.
4. **User-settings tools** (`get_user_settings` / `set_user_settings`) — can't read/write
   prefs via tool.
5. **`get_message` / `get_current_time` / `channel_health`** — minor conveniences.
6. **`transcribe.py`** — no audio transcription worker.

## 7. Reached parity (2026-07-10 session)

- MCP tool naming corrected to single-underscore (`d5fe585`).
- MCP-connectivity probe 406 fixed + raise/clear alert (`c217d02`).
- Narration "still on it" backstop, tool telemetry (`c217d02`).
- Reconcile worker defer bug (`09357b6`).
- Eval recorder: ground-truth decision + grounding/close/pencil counts (`6d5b88c`).
- `record_moment` tool + `decision_claimed`/`decision_mismatch` (`fa91358`).
- Model single-default `deepseek-v4-pro` + provider-var typo (`a63c39e` / ll5 env).
- CI variant→ll5 auto-deploy (deploy-only dispatch) fixed.
