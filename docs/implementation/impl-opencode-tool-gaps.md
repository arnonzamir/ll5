# Plan: Close the opencode tool gaps (multi-agent aware)

Gaps enumerated in `docs/claude-vs-opencode-tools.md`. This plan closes them, using
opencode's **multi-agent** support to put each tool behind the *right* agent/model
rather than forcing everything onto the single `build` agent + deepseek-v4-pro.

## Design principle — tool → agent → model

opencode.json can define many agents, each with its own `model`, `tools` allow/deny
map, and `permission`. Match the capability to the cheapest agent that can do it:

| Agent | Model | Purpose | Tool surface |
|---|---|---|---|
| `build` (main) | deepseek-v4-pro (text) | the companion | full text tools + delegates vision |
| `image-analyst` (NEW) | a **vision-capable** model | describe/answer about one image | image in → text out, nothing else |
| `narrative-consolidator` / `grounding-reviewer` / `reconcile-worker` | deepseek-v4-pro | workers | already locked down (unchanged) |

Key insight: the main agent stays on cheap text; vision is isolated to a subagent so
we don't pay a vision model for every turn, and workers never inherit privileged
tools. Per-agent restriction is enforced by each agent's `tools: {}` map in
opencode.json (workers already deny everything but their 4 tools → they can't reach
vault/system even after we add those MCPs).

---

## Tier 1 — trivial plugin tools (ll5-channel.ts) — low effort, do first

All are bare plugin tools added to `ll5-channel.ts` `tool: {}`, plus a safe-list
entry in `external-authority-gate.ts` where read-only.

| Tool | Impl | Gateway need | Gate | Agent(s) |
|---|---|---|---|---|
| `get_current_time` | pure-local (return now in user tz; tz from `awareness_get_situation` or env) | none | safe | all |
| `channel_health` | pure-local: GET gateway `/health`, return ok/degraded | uses existing `/health` | safe | all |
| `get_user_settings` | GET gateway `/user-settings` (exists, server.ts:585) | none new | safe (read-only) | all |
| `get_message` | GET a chat message by id | **NEW endpoint** `GET /chat/messages/:id` (verify; likely add) | safe (read-only) | all |
| `set_user_settings` | PATCH user settings | **NEW endpoint** `PATCH /user-settings` (only GET exists today) | state-changing → NOT safe-listed (user-initiated only) | `build` |

Effort: ~half a day. Closes 5 of the 6 channel-tool gaps. Add contract tests to
`tool-contracts.test.ts` mirroring the existing ones.

---

## Tier 2 — vision (`inspect_image`) — the multi-agent centerpiece

`inspect_image` in Claude just fetches the image and returns it as content for the
agent's **own** model to see. deepseek-v4-pro is text-only, so returning image bytes
to `build` is useless. Two options:

- **A (chosen): vision subagent.** Add `image-analyst` to opencode.json with a
  vision-capable model. The `inspect_image` plugin tool:
  1. fetches the image from the gateway (`/uploads/...`),
  2. spawns the `image-analyst` subagent **via the opencode SDK inside the plugin**
     (`client.session.create({ agent: "image-analyst" })` + a prompt carrying the
     image part + the caller's question),
  3. returns the subagent's text description to `build`.

  Doing the spawn *inside the plugin* (not via the agent's `task` tool) means the
  external-authority-gate's `task` deny stays intact — no gate change, no prompt-
  injection surface.

- **B (rejected): make `build` vision-capable.** Switching the whole main agent to a
  vision model is wasteful (every turn pays for vision) and may downgrade text
  quality. Only reconsider if a single model is both best-in-class text AND vision.

**Blocking decision — vision model source.** Verify the Zen catalog
(opencode.ai/zen) for a vision model. If none:
- add a second provider (e.g. an Anthropic/OpenAI vision model) with its own key in
  `~/.local/share/opencode/auth.json` (entrypoint already writes auth), and point
  `image-analyst.model` at it.
- Make it configurable: `image-analyst.model = {env:OPENCODE_VISION_MODEL}` with a
  documented default (mirrors the model-default pattern from `a63c39e`).

**Open question:** can an opencode plugin tool return image *content parts* to the
model, or only text? If it can AND we later get a vision main model, option B becomes
trivial. Probe this during implementation; it doesn't block option A.

Effort: ~1–2 days (subagent config + SDK spawn + image fetch + tests + the model
decision). Highest-value gap.

---

## Tier 3 — MCP servers (`vault`, `system`) — main-agent-only

Both are added to `opencode.json` `mcp: {}` (routed through the correlation-id proxy
like the other 6), and **denied to every worker** (workers already have closed tool
allowlists, so this is automatic; double-check after adding).

- **vault**: `"vault": { type: "remote", url: "http://127.0.0.1:4097/vault", ... }`
  and add `/vault` to the proxy's `MCP_ROUTES` (`mcp-vault.${MCP_BASE_DOMAIN}/mcp`).
  Security-sensitive: vault tools (`get_secret`, `list_secrets`) are ALREADY in the
  external-authority-gate safe-list, so they're allowed on any turn — reconfirm that
  is intended for opencode (Claude allows it). Browser-login / onboarding flows
  (DECISION-022) may need extra wiring — scope separately.
- **system**: Claude ran it as a stdio MCP (`packages/system/dist/index.js`) on the
  host. For the opencode container, either (a) bake `packages/system` into the image
  and run it as a stdio MCP, or (b) expose it as a remote MCP behind the proxy. (a)
  is closer to Claude but grows the image; (b) reuses the proxy. Pick (b) unless
  system needs host-local access the container can't proxy.

Effort: vault ~half a day (mostly config + security review); system ~1 day (build/run
decision).

---

## Tier 4 — workers / nice-to-haves

- `transcribe.py` (audio → text): only needed if inbound voice notes must be
  transcribed. Better as a **gateway-side** service than an agent tool (the gateway
  already ingests media). Defer until there's a voice-note use case.
- `get_current_time` already covered in Tier 1.

---

## Sequencing

1. **Tier 1** (quick wins, 5 tools) — ship first; add the 2 small gateway endpoints.
2. **Tier 2** (vision) — resolve the vision-model decision, then `image-analyst` +
   `inspect_image`.
3. **Tier 3** (vault, then system) — config + per-agent deny verification + security
   review.
4. **Tier 4** — only on demand.

## Cross-cutting

- Every new plugin tool: bare name; add to `external-authority-gate` safe-list only
  if read-only/local; add a `tool-contracts.test.ts` case.
- Every new agent: explicit `tools: {}` allow/deny + `permission` + `model`; add an
  `agent-frontmatter`-style assertion if defined as `.md`.
- Update `docs/claude-vs-opencode-tools.md` parity table as each gap closes.
- Verify per-agent tool isolation after adding vault/system (workers must NOT gain
  them) — add a config test that asserts each worker's `tools` map denies vault/system.
