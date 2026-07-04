# DECISION-023 — Ephemeral sandbox VMs: the agent can rent a small machine, never touch ours

Status: proposed — 2026-07-04 (blocked on a user-side prerequisite, see Consequences)

## Context

The agent sometimes needs a real machine: run untrusted or heavy code, try a tool
that shouldn't pollute the agent container, network experiments, throwaway
builds. Giving it more power on the production box is the wrong direction — the
box runs the user's life. The right shape is an **on-demand small VM** that is
born clean, does one job, and reliably dies.

## Decision

1. **Hetzner Cloud, in a SEPARATE project.** The structural safety decision: the
   API token the agent-facing tools use belongs to a dedicated Hetzner project
   ("ll5-sandbox") that contains nothing else. The agent gains no path to the
   production server, its networks, or its snapshots — project isolation does
   what no allowlist could.

2. **Gateway-owned lifecycle, agent-facing tools.** New tools (system/awareness
   MCP surface, gateway executes): `sandbox_create({purpose, ttl_minutes<=240})`
   → small server (allowlist: cx22/cax11 class), fresh ephemeral SSH keypair,
   labels `ll5-sandbox=1, expires_at=<ts>`; `sandbox_exec({id, command})` over
   SSH; `sandbox_destroy({id})`. Caps: max 2 concurrent, max TTL 4h, create
   rate-limited.

3. **The reaper is deterministic, not agentic.** A gateway scheduler
   (`SandboxReaper`, 5-min tick) lists servers in the sandbox project and
   deletes anything past its `expires_at` label or unlabeled — regardless of
   what the agent thinks. Orphan cost risk is bounded by machinery, not by the
   agent remembering (the same principle as every scheduler shipped this week).
   Monthly spend worst case ≈ 2 × smallest instance running 24/7 ≈ pocket money;
   normal case: cents per burst.

4. **No secrets travel.** Sandboxes get no LL5 tokens, no vault access, no
   tailnet. Results come back through `sandbox_exec` stdout or explicit file
   pull. Anything the sandbox produces is treated as untrusted input.

## Alternatives considered

- **Docker-in-Docker / extra container on the box**: shares kernel, IO, and blast
  radius with production; the Apr 16 and Immich incidents showed host contention
  is real. Rejected for untrusted/heavy work.
- **Firecracker/microVM on the box**: right isolation, same shared-hardware
  contention + ops burden. Rejected for now.
- **Cloud-run per-task (Fly machines, Modal, etc.)**: fine products, but Hetzner
  keeps billing/vendor surface unified with existing infra and the hcloud API is
  trivially simple. Revisit if start latency (~30-60s) becomes a real constraint.

## Consequences

- **User prerequisite (blocking):** create the Hetzner project "ll5-sandbox" and
  an API token scoped to it (Hetzner console → project → Security → API tokens →
  Read/Write), then hand the token over for the gateway env. Tokens cannot create
  projects, so this one step must be human.
- New surface: hcloud client, 3 tools, one reaper scheduler + tests; persona
  section on when a sandbox is warranted vs the agent's own container.
- Cost telemetry: reaper logs create/destroy + runtime minutes to app_log, so
  the health probe / weekly review can see sandbox spend patterns.
