# LL5 Mobile — Interaction Model (Behavioral Layer)

Governing constraint: attention is the scarce resource; proven physics: "only deterministic machinery survives" and "one concrete question beats a menu." The app is a tool for closing loops, not an engagement surface — optimize for fewer, better app opens.

## 1. Attention Architecture — four tiers

Question that defines a tier: what does the system have the right to do to the user's attention?

- **Tier A — Interrupt (rings through silence).** Habit-contract critical steps only (Ritalin STREAM_ALARM — proven "meaningful motivation push") + genuine safety/system-critical. Always the LAST step of a visible escalation, never first contact. If A ever fires for something skippable, trust in the alarm channel dies (health-critical).
- **Tier B — Needs You (persistent tray, visible count).** Mandated reaction, not this second. Zeigarnik: visible count keeps loops open where chat scroll lets them fake-close. Commitment device: impossible to un-see, cheap to clear. No variable reward: tray contains only questions, never content/novelty. Contents: habit checks (notify/alert steps), vault site approvals, contact-permission approvals, weekly review's ≤3 decisions, tickler confirmations, evening-close pick-up/drop calls.
- **Tier C — Ambient (glanceable, zero obligation).** NO badges, NO unread counts ever (badge on ambient = compulsive-checking bait; this tool must refuse engagement-app mechanics). Contents: brief/close bodies (the one question goes to B), Today card (today's decision, tomorrow's one thing, booked preps, habit dots), topics rail, relay summaries. Answers "what's true now," never "what did you miss."
- **Tier D — Archival.** Full history, journal, narratives, habit log, past briefs. Search/navigate only, never pushed.

Mapping: habit critical→A; habit notify/second-ask→B; vault/contact approvals→B; review 3 decisions→B; brief/close→C body + B question; WA relays→C; topics→C; non-critical system alerts→C/D (stop making ops the user's job); confirm-ticklers→B.

## 2. The "Needs You" Surface

- Entry: any event carrying a requires_response contract → tray item {type, one-line question, answer affordances, created_at, escalation policy}. Enters silently (count changes, no notification) unless its escalation step says otherwise. Fixes "published where the user doesn't look": persistent home independent of scroll.
- One-tap answers = direct MCP writes, no conversation round-trip (fixes dose-taken-never-logged):
  - Habit: Done / Skip → skip expands to deliberate|excused (2 taps max; excused-neutral streaks per DECISION-019). Long-press = note. Answer calls log_habit_outcome and silences remaining escalation.
  - Approvals: Approve / Deny with minimal inline context. Never behind a detail screen.
  - Review decisions: card with agent's recommendation pre-highlighted + 2 alternatives, A/B/C chips (status-quo bias in system's favor: agent analyzed, user ratifies).
  - Staged items (evening close): Keep / Drop per item.
- Escalation honesty on ignore: every item shows its own future ("escalates to alarm at 09:25", "auto-logs missed at midnight", "expires Friday — default applied"). The user consented at contract creation; the app reminds him of his own rules, never nags. Auto-missed displayed as consequence, not hidden.
- Chat remains the place to DISCUSS: every tray card has a "talk about this" escape hatch opening the thread with context preloaded (agency).

## 3. Micro-Productivity Patterns

- **Inbox swipe triage**: card stack, one item per card; right=keep(→action, agent infers context/energy), left=trash, up=someday, down=do-now(≤2min). Sessions capped at 10 cards ("10 more remain — again or later?"). Entry via tray item after weekly solo review; never a standing badge.
- **Weekly review = 3 cards** with A/B/C chips; report body is Tier C. Cards expire next Thursday with the agent's default applied AND disclosed → review always concludes (KPI 1/1).
- **Tomorrow's one thing as home-screen widget**: one line + habit status dots. One item only. Tap → Today card. If the user only ever glances at the widget, the app succeeds.
- **Shopping = geofenced checklist**: checkboxes grouped by store; silent Tier C; promotes to ONE notify ping only near a relevant store with non-empty list. Never at home.
- **What NOT to build**: full GTD manager (project browser, action editor, context filters, horizons). Mobile GTD = rot magnet transferring maintenance labor to the user. Phone GTD verbs: capture, triage (swipe), decide (cards). Everything else is the agent's job via beats.

## 4. Topics Ranking — "latest and most meaningful now"

Pure recency = variable-reward feed + rewards volume (chatty groups outrank a quiet thread where he owes an answer). Existing blend (recency .6/status .2/open-threads .1/volume .1) is recency-dominant and volume is actively harmful.

V1 (existing data only):
- 0.35 open-loop-involving-user (unanswered thread he owes — gated on visibility:full; open GTD action/waiting-for linked; undelivered commitment)
- 0.30 calendar proximity (topic's people/subject in an event ≤48h out — the Hen lesson)
- 0.25 recency of last substantive activity
- 0.10 status weight
- 0.00 volume (drop)
Emotional weight → v2 (sentiment inference is trust-expensive when wrong). V1 proxy: user-initiated messages count 3× toward open-loop. **Cap the rail at 5 topics** — longer = a menu, menus die.

## 5. Companion-Relationship Principles → UI implications

1. **Honesty over impression management**: provenance affordances — "seen 9:40" vs "inferred" styled distinctly; stale data labeled ("calendar as of 08:00"). Never dress a guess as a reading.
2. **Agency preservation**: every escalating item links to its own contract ("your rule: alarm after 3 asks — edit"); every one-tap surface has the chat escape hatch; archive proposals, never silent deletes.
3. **Celebration without gamification**: streaks = quiet calendar strip (done/missed/excused dots), no confetti/badges/streak-dread; broken streaks show excused days so the number never lies; two-skips coaching arrives as words (named observation + smaller doorway), not iconography.
4. **Silence is a feature**: "quiet since 14:20 — nothing needs you" as a positive Today-card state; zero-badge is the designed resting state; no pull-to-refresh novelty.
5. **Effort asymmetry**: system pays, user decides — finished analysis + one-tap ratification, never homework; nothing on mobile requires free text (anything bigger gets scheduled into a beat).
6. **Failure disclosure**: "no answer by Thu — applied option A as agreed" — plain, never passive-aggressive.

## 6. Top 8 Ranked

1. Needs You tray + one-tap habit logging (closes done-but-unlogged; every mandate gets a home)
2. Escalation-honesty display (cheap; converts nagging → contract-keeping; protects Tier A)
3. Tomorrow's-one-thing widget / Today card (ambient anchor; DECISION-018 §5)
4. Weekly-review decision cards with expiring defaults (guarantees weekly KPI)
5. Inbox swipe triage, capped sessions (attacks 46-item rot)
6. Tier separation of notifications (relays/topics stop pinging like mandates; C loses all badges) — direct fix for the fatigue that killed engagement
7. Topics re-rank (open-loop + calendar proximity, volume dropped, cap 5)
8. Geofenced shopping checklist (flagship "no app opened" moment)

Through-line: the tray is the mobile expression of the system's law — deterministic machinery with honest contracts survives; whatever depends on the user happening to scroll decays.
