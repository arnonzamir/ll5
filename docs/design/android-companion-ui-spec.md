# LL5 Android — UI Design Specification (verbatim from the 2026-07-05 design pass)

Companion to `android-companion-ui.md` (synthesis) and
`android-companion-ui-interaction-model.md` (behavioral layer).

## 1. Information Architecture

**Four tabs:** `Today` (start destination) · `Needs You` · `Chat` · `Topics`.

- **Today** — the Tier C ambient anchor. Top app bar carries a single `Tune` icon
  opening **System**: a plain list screen linking Status, Data, Sensors, Settings,
  Approvals history. Plumbing doesn't earn tabs. Map and Shopping are doors inside
  Today, not tabs.
- **Needs You** — the only badge in the entire app (`error`-container tinted count).
  All other tabs render `badge = null` permanently; enforce via a single `LL5NavItem`
  wrapper that has no badge slot.
- **Chat** — demoted from start destination (the companion model: chat is where you
  discuss, not where you land). Deep links still open it directly.
- **Topics** — the re-ranked rail (replaces "Active" as a tab; narrative detail
  screens remain).

Tradeoff: Settings/Status/Data go to two-three taps; Chat loses home position.
Accepted — bottom-nav slots are the scarcest resource; plumbing is Tier D.
`EXTRA_NAV_TARGET` deep links extend: `needs_you`, `today`, per-card routes.

## 2. Claude-Code-Feel Chat

Dense, near-monochrome, left-anchored transcript — agent text is the page,
everything else is quiet chrome.

- **Agent message:** no bubble/container. Full-width text on plain `background`,
  `bodyLarge` (16sp/24sp), 16dp horizontal / 10dp vertical padding. Identity: 16dp
  terracotta **spark glyph** at the turn's start line (once per turn). No name label.
- **User message:** full-width block on `surfaceContainerHigh` (#1A1D23), 8dp radius,
  **3dp accent bar on the start edge** (start, not left — RTL flips correctly).
- **Activity (tool) rows:** collapsed band — one row, monospace `labelMedium`,
  `onSurfaceVariant`, lead `Terminal` glyph, `4 actions · web_search, log_habit…`,
  trailing chevron. Expands in-place to terminal-trace rows: 32dp, monospace tool
  name + one-line arg summary, per-row tick/cross, 1dp start rule. No chip borders.
- **Thinking/streaming:** thinking = italic 70%-alpha one-line shimmer while live,
  collapsible after. Streaming text ends in a 2dp accent **block caret**. No
  typing-dots bubble.
- **Timestamps:** none inline; centered monospace `labelSmall` divider when gap
  > 20 min; long-press sheet for exact times.
- **Reply-to:** 2-line quote block above the message, 2dp outline start rule, tap
  scrolls to parent. **Reactions:** tight row of 16dp monochrome outline icons +
  count under the target block; existing 6-reaction sheet unchanged.
- **Color restraint:** exactly three foregrounds — onSurface #E6E4DF,
  onSurfaceVariant #9BA0A8, accent #D97757 (spark, links, send, caret only).
- **Input bar:** single-line field on `surfaceContainer`, monospace `>_` placeholder,
  accent send icon, attachments/mic behind one `+`.
- **Prerequisite:** Markwon-in-AndroidView → Compose-native markdown (mikepenz
  multiplatform-markdown-renderer or AnnotatedString builder). Code blocks:
  monospace on `surfaceContainerHigh`, forced LTR inside RTL paragraphs
  (`textDirection = Content`, code spans `Ltr`).

```
┌────────────────────────────────────┐
│ ✳ LL5                        ⋯     │
│────────────────────────────────────│
│           — Wed 14:20 —            │
│ ▌ מה קורה עם הפגישה עם חן?         │  <- user block, start-bar (RTL)
│                                    │
│ ✳ Checked the thread — she         │
│   confirmed Thursday 14:00.        │
│   ▸ 3 actions · search_topics…     │  <- collapsed activity band
│   I added prep notes to the        │
│   topic. Want a reminder?          │
│   ⊙2                               │  <- reaction row
│                                    │
│ ▌ yes, morning of                  │
│ ✳ Done — Thu 08:30.▊               │  <- streaming caret
│────────────────────────────────────│
│ >_ Message              [+]  [➤]  │
└────────────────────────────────────┘
```

## 3. Needs You Tray

**Entry:** badged tab (primary) + a pinned one-line summary row atop Today
("2 need you →"). No third entry point.

**Screen:** LazyColumn of cards, newest-deadline-first, 12dp gaps, silent refresh
on resume.

**Card anatomy (shared skeleton):**
1. Type glyph + label — `labelSmall` `onSurfaceVariant` (`Medication · habit`)
2. The one question — `titleMedium` 16sp/600. Never a paragraph.
3. Context line — `bodySmall`, one line max, optional.
4. Answer chips — `FilledTonalButton`s, ≥48dp, max 3. Habit: `Done` / `Skip` (Skip
   morphs in-place to `Deliberate` / `Excused` — no dialog; long-press = note).
   Approval: `Approve` / `Deny`. Review: A/B/C — recommendation is the only FILLED
   (accent-container) chip, alternatives outlined. Staged: `Keep` / `Drop` mini-list.
5. **Escalation-honesty line** — bottom, monospace `labelSmall`, clock glyph:
   `escalates to alarm 09:25 · your rule` ("your rule" links to the contract
   editor). Always visible — the card's contract seal.
6. `Talk about this` — end-aligned TextButton → Chat with context preloaded.

Answer = 150ms fade-and-collapse; direct MCP write; failure surfaces inline in red
(no silent errors), success has no toast.

**Empty state:** `Nothing needs you` + `quiet since 14:20`, plain background, no
illustration, badge disappears entirely (no gray zero).

```
┌────────────────────────────────────┐
│ Needs You (3)                      │
│┌──────────────────────────────────┐│
││ ◉ Ritalin · habit                ││
││ Morning dose — taken?            ││
││ [ Done ]  [ Skip ]               ││
││ ⏱ escalates to alarm 09:25 ·     ││
││   your rule        Talk about ↗  ││
│└──────────────────────────────────┘│
│┌──────────────────────────────────┐│
││ ⛨ Vault · approval               ││
││ Allow login to bank site?        ││
││ leumi.co.il · agent session      ││
││ [ Approve ]  [ Deny ]            ││
││ ⏱ expires in 10 min → denied     ││
│└──────────────────────────────────┘│
│┌──────────────────────────────────┐│
││ ▤ Weekly review · decision 1/3   ││
││ Park the ROI ingest project?     ││
││ [A Park ✓rec] (B Keep) (C Kill)  ││
││ ⏱ Thu default: A · disclosed     ││
│└──────────────────────────────────┘│
└────────────────────────────────────┘
```

## 4. Today Card / Home

Single scroll, four sections, 24dp spacing — exhausted in five seconds.
1. Needs You summary row (only when count > 0), accent, tap → tray.
2. Now/Next: next calendar item (`titleMedium` + monospace time + provenance line
   `calendar as of 08:00` when stale); today's one decision/focus (`bodyLarge`);
   `Tomorrow:` one thing in `onSurfaceVariant`.
3. Habit dots strip: per habit — name + 14 day-dots (8dp: filled=done,
   outline=missed, half-tone=excused). No numbers, no flames.
4. Doors row: two quiet OutlinedCards — `Map` (static caption "family: home · you:
   office") and `Lists` (shopping + today's actions). App-bar gear → System.

Quiet state: leads with `Quiet since 14:20 — nothing needs you` (`titleMedium`),
dots below. Silence = success state.

**Widget (Glance):** tomorrow's one thing (one line) over today's habit dots.
Tap → Today. No refresh, no counts. Dark surface matching app background.

## 5. Topics Rail

Hard cap 5 rows + `All topics →` (existing searchable list = Tier D archive).

Row (72dp, two lines):
- Line 1: title `titleSmall` + exactly ONE why-now signal, priority-ordered:
  (a) open-loop glyph (small half-open accent circle = "you owe an answer"),
  (b) calendar-proximity tonal chip (`Thu 14:00`, monospace `labelSmall`),
  (c) nothing — recency is not celebrated.
- Line 2: last substantive line `bodySmall` `onSurfaceVariant`, one line; status as
  a leading word (`waiting · `) in `labelSmall`, never a colored pill.
- No unread counts, no read-state bolding, no row timestamps (anti-feed).

Detail-view upgrades (minimal): provenance labels on facts (`seen 9:40` vs
`inferred` italic + dotted underline); open-loop banner ("You haven't replied to
Dana — open in Chat"); chat escape hatch. Nothing else.

## 6. GTD Surfaces

**(a) Inbox swipe triage** — full-screen card stack, entered ONLY via a tray item.
Card: item text `titleLarge` centered, source + captured date monospace below.
Gestures with fade-in edge glyphs: right=keep (agent files), left=trash,
up=someday, down=do-now (≤2 min). 150ms exits, no bounce. Card 10 → end card:
`10 done · 36 remain` with `Again` / `Later`. No guilt copy. RTL: swipes stay
physical (spatial, not reading-order); glyph hints make it self-evident.

**(b) Weekly-review decision cards** — tray cards (§3 style): question, agent's
one-line reasoning (expandable), A/B/C with pre-filled recommendation, expiry
disclosure. After expiry: one-day non-interactive receipt card — `No answer by
Thu — applied A as agreed`, dismissible.

**(c) Shopping checklist** — Today → Lists. Store-name headers + 48dp checkbox
rows; checked items sink to collapsed `Done (4)`. One add-field per store (the one
sanctioned free-text field — capture, not composition). Footer per store,
`labelSmall`: `pings once near store · never at home`. Uses existing
GeofenceRepository.

**(d) Todos — "Today's actions"** — Lists' second pane. Read-mostly, ≤7 rows the
agent chose: checkbox + text + context word. Two affordances: check off,
swipe-start = defer ("tomorrow", logged as agent input). OMITTED deliberately:
project browser, action editor, due-date pickers, filters, horizons, manual add,
reordering. Footer: `Discuss the list →` → Chat. A viewport onto the agent's plan,
not a manager.

## 7. Map

**Engine: Google Maps Compose** (GMS Xiaomi; Play Services location/geofencing
already a dependency; Compose-native markers — no new AndroidView; MapLibre would
add ~5MB native libs + style upkeep for one user. Tile parity with dashboard's
Leaflet is a non-goal; data parity is).

Entry: Map door on Today → full-screen route. Not a tab.

Content: tracked devices as initialed dots with provenance in the info window
(`seen 9:40`; italic `inferred: home` when stale > 30 min); own trail TODAY-ONLY
behind a `Today's trail` toggle, simplified polyline; saved places as outline pins;
dark map style matching palette.

NOT shown: live follow mode, movement animation, speed/heading, history scrubber
for others, "last seen Xm ago" countdowns. Snapshots with honest timestamps — calm
answer to "where is everyone," not a surveillance feed.

## 8. Visual Language

- Dark-first hand-tuned palette: background #0F1115, surface #14161B,
  surfaceContainer #1A1D23, surfaceContainerHigh #22252C, outline #33373F,
  onSurface #E6E4DF, onSurfaceVariant #9BA0A8. Single accent #D97757 (terracotta),
  onAccent #1A0F0A, container #3A241B. Muted semantics: success #7BAE7F, warning
  #D9A05B, error #E5645A (container #3A1D1B for the tray badge). Light theme later.
- **Material You dynamic color: dropped** (`dynamicColor = false`) — one owned
  accent IS the identity; wallpaper-seeded schemes would repaint it arbitrarily.
- Typography: Inter (Hebrew via Noto fallback — verify 400/600 weight match).
  Scale 12/14/16/20/24, weights 400/500/600. **JetBrains Mono** for tool names,
  timestamps, code, escalation lines — never on Hebrew content; code spans force LTR.
- Motion: 120-200ms standard decelerate; no springs/overshoot; checkoffs
  fade-and-collapse; zero celebratory motion; respect reduced-motion.
- Icons: Material Symbols Outlined, 20dp, monochrome `onSurfaceVariant`; accent
  reserved for spark mark + open-loop glyph.

## 9. Build Sequence

- **Phase 1 — Foundation + Tray:** theme retokenize + drop dynamic color + type
  scale (S); 4-tab nav + System screen + deep links (M); Needs You tray with
  one-tap MCP writes, escalation lines, badge (L). Biometric approvals gate and
  CriticalAlertService untouched — the tray precedes the alarm, never replaces it;
  verify MIUI alarm path end-to-end after nav changes.
- **Phase 2 — Ambient anchor:** Today screen (M), Glance widget (M), shared
  habit-dots component (S), quiet state (S).
- **Phase 3 — Chat restyle (independent, high-visibility):** markdown migration
  incl. RTL/code-direction tests (L, prerequisite); message anatomy + activity
  bands + streaming (M); reactions/reply re-skin (S).
- **Phase 4 — Additive:** topics re-rank row + rail cap (S UI; ranking server-side);
  inbox swipe triage (M); review receipt cards (S); Lists — shopping + today's
  actions (M); Map on maps-compose (M).
