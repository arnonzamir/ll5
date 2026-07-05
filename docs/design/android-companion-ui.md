# Android Companion UI — Redesign Review (2026-07-05)

Status: DESIGN REVIEW — awaiting user approval before implementation.
Inputs: codebase inventory (Explore pass), interaction model (UX-research pass with
personal-productivity + behavioral-psychology lenses), concrete UI spec (UI-design pass).
Grounded throughout in the Jun 25 – Jul 2 audit and the companion program
(DECISION-018/019/020) — the app is the mobile expression of the same law:
deterministic machinery with honest contracts survives; whatever depends on
scroll-luck decays.

---

## 0. Synthesis — the one idea

Today the app delivers everything through one chat stream plus side tabs, so a
medication escalation, a vault approval, a weekly-review decision, and a WhatsApp
group joke all compete in the same scroll. The redesign separates content by **what
the system has the right to do to the user's attention**:

| Tier | Right | Surface |
|---|---|---|
| A Interrupt | ring through silence | CriticalAlertService (unchanged; habit critical + true emergencies only) |
| B Needs You | persistent count until answered | NEW tray — the app's ONLY badge |
| C Ambient | be glanceable, never call | Today card + widget, topics rail, chat bodies — ZERO badges |
| D Archive | be searchable | full chat/journal/narratives/history |

Everything the user spitballed lands inside this frame: mandated-reaction reminders
= the tray; topics "latest and most meaningful now" = re-ranked Tier C rail; todos +
shopping = deliberately minimal Lists under Today; map = a door in Today; GTD review
= tray decision cards + swipe triage; Claude-Code chat = the Tier C/D restyle.

Explicit anti-goals (as binding as the goals): no badges on ambient surfaces, no
unread states, no gamification, no full GTD manager on mobile, no free-text-required
flows, no surveillance-feel map. The app must minimize compulsive checking.

## 1. Current state (condensed from the inventory)

5-tab Compose/Material3 app (Chat / Active / Status / Data / Settings), minSdk 26.
Chat is well-engineered (optimistic echo, SSE + 30s reconciliation, reactions +
reply-to already wired, Markwon-in-AndroidView markdown — the one structural debt).
Approvals screen is biometric-gated; 4-level FCM incl. the MIUI-hardened
CriticalAlertService. Narratives "Active" tab uses server relevance sort. Large
unused backend surface: journal, media, shopping, GTD inbox/actions, tracked-devices
map data, user-settings, vault approved-sites — all live endpoints the dashboard
consumes and mobile ignores. Full inventory: see the Explore-pass report (session
2026-07-05); key files: ui/navigation/AppNavigation.kt, ui/chat/ChatScreen.kt,
ui/theme/Theme.kt.

## 2. Interaction model (behavioral layer — authoritative)

See `docs/design/android-companion-ui-interaction-model.md` (checked in alongside
this doc, verbatim from the review pass). Load-bearing decisions:

- **Needs You tray**: every mandated-reaction item (habit checks, vault/contact
  approvals, review decisions, evening-close pick-up/drop, confirm-ticklers) gets a
  persistent home with one-tap answers that are DIRECT MCP WRITES (a habit "Done"
  calls log_habit_outcome — closing the observed dose-taken-never-logged gap).
- **Escalation honesty**: every tray item displays its own future ("escalates to
  alarm 09:25 · your rule", "auto-logs missed at midnight", "Thu default: A") —
  contract-keeping, not nagging; protects the Tier A alarm channel's trust.
- **Topics ranking v1** (server-side change, personal-knowledge relevance):
  0.35 open-loop-involving-user (visibility:full-gated) + 0.30 calendar proximity
  ≤48h + 0.25 recency + 0.10 status + **0.00 volume (dropped)**; user-initiated
  messages ×3 toward open-loop; rail capped at 5. Emotional weight deferred to v2.
- **Mobile GTD = capture, triage, decide** — nothing else. Swipe triage capped at
  10 cards/session; review decisions as A/B/C cards with expiring disclosed
  defaults; todos = read-mostly "today's actions" viewport (check off / defer only).
- **Companion principles → UI**: provenance styling ("seen 9:40" vs "inferred");
  every escalation links to its own editable contract; streaks as quiet dot strips
  (excused-neutral, no confetti); "quiet since 14:20 — nothing needs you" as a
  designed success state; failure disclosure in plain words.

## 3. UI specification (design layer — authoritative)

See `docs/design/android-companion-ui-spec.md` (checked in alongside, verbatim).
Load-bearing decisions:

- **IA**: 4 tabs — Today (start) · Needs You (only badge) · Chat · Topics; Status/
  Data/Settings/Sensors demoted to a System screen behind Today's app-bar gear.
  Chat deliberately loses home position (it's where you discuss, not where you land).
- **Claude-Code chat feel**: no-bubble dense transcript — agent text full-width on
  the background with a terracotta spark glyph per turn; user messages as
  start-edge-accent-bar blocks; tool activity as collapsed monospace bands expanding
  to terminal-trace rows; streaming block caret; timestamps only as gap dividers;
  three foreground colors total. Prerequisite: Markwon → Compose-native markdown
  (RTL paragraphs + forced-LTR code spans).
- **Visual language**: dark-first hand-tuned palette (bg #0F1115, single accent
  #D97757 terracotta), Material You dynamic color DROPPED, Inter + JetBrains Mono
  (mono never on Hebrew content), 120-200ms non-celebratory motion.
- **Map**: Google Maps Compose (GMS device, Compose-native, no new AndroidView);
  snapshots with honest timestamps, today-only own trail behind a toggle, no live
  follow/countdown patterns.
- **Widget**: Glance — tomorrow's one thing + today's habit dots, tap → Today.

## 4. Roadmap (proposed)

| Phase | Contents | Size |
|---|---|---|
| 1 Foundation + Tray | theme retokenize, 4-tab nav + System screen, Needs You tray with one-tap MCP writes + escalation lines + badge; verify MIUI alarm path untouched | L |
| 2 Ambient anchor | Today screen, Glance widget, shared habit-dots component, quiet state | M |
| 3 Chat restyle | markdown migration (prereq, L), message anatomy + activity bands + streaming, reactions/reply re-skin | L |
| 4 Additive | topics re-rank (server + row UI), inbox swipe triage, review receipt cards, Lists (shopping geofenced + today's actions), Map | M-L |

Backend work implied: `requires_response` contract on system events feeding the
tray (gateway) + tray-item answer endpoints (mostly existing MCP tools; new thin
gateway routes where the app can't speak MCP); topics ranking change
(personal-knowledge `narrativeRelevance` v2 + open-loop/calendar inputs); shopping/
actions read endpoints already exist. Phase 5 of DECISION-018 (Today card) is
delivered by Phase 2 here — the beat-engagement data gate is satisfied by the probe.

## 5. Decisions needing the user

1. Approve the 4-tab IA (Chat loses start position; Status/Data/Settings behind a
   gear).
2. Approve dropping Material You dynamic color for the owned dark palette.
3. Tray answers as direct writes (no confirmation dialogs) — comfortable?
4. Topics rail hard cap of 5 (full list one tap away) — acceptable?
5. Map engine: Google Maps Compose (vs MapLibre self-hosted) — fine with GMS
   dependency?
6. Phase order — tray first (highest trust/data payoff) vs chat restyle first
   (highest visible change). Recommendation: tray first.
