# DECISION-030 — Assertive proactivity and concentrated style, enforced at the boundary

**Date:** 2026-09-05 · **Status:** accepted (Arnon, same day) · **Follows:** DECISION-028 (#5 pending), DECISION-029

## Context

Seven days of direct chat (Aug 29 – Sep 5): 217 agent messages to 40 from the user (5.4:1); ~68% agent-initiated, so initiation is not the gap. Daily median length 150–435 chars, p90 600–1,100; the two rituals 1,500–1,950 chars with headings, bold and numbered lists. 19 initiated messages between 01:00 and 05:00 local (the WhatsApp-alert reflex, ISS-013). On proactive triggers over three days: suppress 399 / ping_now 43 / ping_later 15, and the baseline showed 79% of `ping_later` were hollow, 4 loops closed and 14 items penciled in 15 days.

The persona has said the right words since the Aug 19 commit — "concentrated by default", "brevity is respect", "match energy", "insist on preparation" — and the outputs did not move. Adjectives in a 600-line prompt lose to the model's default register. The pattern on the user's screen: "still off unless you tell me otherwise — if you want to go, say so and I'll firm the time" — two hedges and a request for input where the assertive line is "Telling the group you're out at 17:00 unless you stop me."

Arnon's decisions: (1) act by default, but outgoing rules bind — where a conversation is read-only the agent says "I'll tell them by X" only if allowed, otherwise "you should tell them: …" with a copy-and-open affordance in the apps; (2) hard quiet hours 23:30–06:30, "critical" = safety and family only; (3) length caps enforced by the tool, mirroring the user's register, state-aware delivery, and metrics.

## Decision

1. **Message kinds with caps enforced by the channel tool** (`channel/ll5-channel.mjs`): `push_to_user` kind `notice` ≤ 200 chars (default), `brief` ≤ 600 chars and ≤ 3 items (the two rituals), `detail` ≤ 1200 (only on request); `reply` kind `reply` ≤ 400, `detail` ≤ 1200. No markdown headings or bold outside `detail`. An over-length message is refused with the count and the agent rewrites — the same mechanism that made the MCP result caps hold when prose did not.
2. **Quiet hours, gateway-enforced.** `POST /chat/messages` holds an agent-initiated (`proactive: true`), non-critical message when the delivery mode is `sleep` or `quiet_hours` (default 23:30–06:30 local, `user_settings.quiet_hours_start/end` override) and the user has not written in the last 30 minutes; rows go to `held_messages` (migration 046) and `QuietHoursReleaseScheduler` delivers one digest when the window ends. Replies are never held. System alerts skip the phone push inside quiet hours (`alerting.ts`).
3. **Delivery mode, computed by the gateway** (`utils/delivery-mode.ts`, `GET /me/delivery-mode`): `sleep` (phone sleep-classify ≥ 0.7 within 20 min) > `quiet_hours` > `driving` (location motion within 10 min) > `meeting` (a real calendar event in progress) > `sick` (the agent's own `active_context` says so) > `normal`. The channel MCP stamps `delivery_mode` and a one-line hint on every inbound envelope, so the agent never has to remember to check.
4. **Persona: act-by-default ladder + mirroring + drafts.** Reversible/low stakes → do it, one-line report; medium → do it tentatively with a deadline so silence resolves it; high → ask with a recommended default and a deadline. One question per message. Mirror the user's length and register. Where the agent may not message a contact/group, it hands over a `[[draft to="…" via="whatsapp"]]…[[/draft]]` block; the dashboard renders it as a card with Copy and "Copy & open WhatsApp" (`wa.me/?text=`). Android: follow-up in the app repo.
5. **Metrics** in `scripts/agent-baseline.sh`: outbound median/p90/max chars, initiated share, night pushes, messages by kind — so 2026-09-12 shows whether the behaviour moved.
6. **Structural deferral** — DECISION-028 #5 + ISS-004 (`ping_later` must carry a wake/tickler id) — pulled forward as the next batch.

## Alternatives considered

- **Prompt-only.** Tried since August; no effect on the measured lengths.
- **Stop-hook truncation.** A hook cannot edit a message that was already sent; refusing at the tool is the only point where the agent still holds the pen.
- **Agent-side quiet hours (persona rule).** Rejected: the 01:00–05:00 pushes happened with the rule in place; a hold the agent cannot bypass is the only reliable form.

## Consequences

- A refused message costs one extra tool round-trip; a held push appears the next morning as a digest line, not as a 3 AM notification.
- The agent must learn the `kind` argument; until the persona roll lands, defaults apply (`notice`/`reply`) and long rituals will be refused — expected on day one.
- Delivery mode is heuristic (`sick` is a text match on the agent's own notes); a wrong mode shortens a message, it never suppresses a critical one.
- Verification: the 2026-09-06 checkpoint (no held-message leaks at night; digest at 06:30; refusals in the transcript followed by a shorter resend) and the 2026-09-12 readout (median chars, initiated share, night pushes, hollow deferrals).
