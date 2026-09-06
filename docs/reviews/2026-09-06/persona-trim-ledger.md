# Persona trim ledger — 2026-09-06 (DECISION-031 lever B)

`packages/ll5-run-shared/CLAUDE.md`: 97,477 → 62,581 bytes. Moved material lives in three new on-demand skills: `skills/media/SKILL.md` (11,193 B), `skills/vault-login/SKILL.md` (2,834 B), `skills/location/SKILL.md` (5,780 B), registered under "Event procedures (invoke on the event)". Every backticked identifier of the original (341) is present in the new persona or one of the three skills, except the intentionally removed `record_moment` / `inferred_sentiment` / `decision_mismatch` and four worked-example strings. Caps (200/400/600/1200), quiet hours 23:30–06:30, delivery modes, the act-by-default ladder, `[[draft …]]`, `[[silent]]`, `[[compact]]`, the 15 numbered Hard Rules and the interview/consolidate/situation-check invocations are unchanged in meaning. The Eval rule now specifies the `[[moment …]]` line (lever C).

| Section | Before | After | Where it went / why safe |
|---|---:|---:|---|
| Your Role | 5,862 | 5,018 | Prose; dropped the "dictionary vs partner" motto |
| Hard Rules | 13,118 | 10,016 | Rule 6 syntax → Scheduling (cross-ref); anecdotes in 12/14/15 cut; meaning intact |
| Time Awareness | 2,039 | 1,123 | Bullet list folded into one sentence (`set_timezone`/`google_user_settings` kept) |
| How to Act | 2,833 | 2,452 | Examples shortened |
| Location Intelligence | 6,633 | 3,137 | Snapshot fields, deduction examples, jamming detail, provenance tags, contextual list → `location`; all surface/notify rules kept |
| Response Language | 983 | 831 | Prose |
| One Event at a Time | 1,126 | 629 | Restated Rule 7 once |
| Your skills | 1,869 | 2,202 | +3 registrations |
| Working Your Future | 8,509 | 5,969 | "Schedule your attention" de-duplicated against Scheduling; `record_moment` → moment line |
| Ask to Understand | 2,120 | 1,259 | Examples cut to one each |
| Proactive Communication (+4 subsections) | 14,185 | 9,369 | Markers-vs-narrate merged into narrate; Self-Check lists merged; narrate when/not lists to one line |
| Narratives | 3,250 | 2,561 | Rules 4/5 cross-referenced |
| Session Memory | 10,455 | 7,434 | get_situation paragraphs merged; ISS-002 story shortened (numbers kept); new Eval rule |
| Emotional Contract | 1,129 | 757 | Rules 1/9 and caps cross-referenced |
| Media Handling | 10,428 | 1,033 | → `media` skill; pointer + standing rules |
| Vault logins | 2,298 | 714 | → `vault-login` skill; pointer + 4 hard rules |
| Capture Rules | 395 | 395 | Unchanged |
| Memory Model | 1,907 | 1,601 | Worked example to one line |
| Where Data Goes + Governed memory | 2,244 | 1,584 | Example quote dropped; all lesson tools kept |
| GTD Quick Reference | 852 | 709 | Left in place |
| Messaging | 5,001 | 3,547 | Priority table → one line; example trimmed |

Watch at the 09-07 checkpoint: media events handled (a `[Photo]` or voice note → `media` skill invoked), a vault login when one occurs, location lines still composed with the same rules.
