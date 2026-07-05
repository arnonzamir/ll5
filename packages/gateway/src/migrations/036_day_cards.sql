-- 2026-07-05 — Android Phase 2 (Today card / ambient anchor).
--
-- One row per user per local calendar day: the agent's first-person "voice"
-- read (android-companion-ui.md §5a — Today LEADS with this, 1-2 sentences)
-- plus today's single focus ("one thing"). Written by the agent through
-- POST /today-card (chatAuth — the agent's channel holds a user token);
-- read by the phone through GET /me/today.
--
-- `day` is the user's local calendar day in their EFFECTIVE timezone at write
-- time (current GPS zone if recent, else home) — the same "today" the tray and
-- the schedulers use. The agent re-writes the row freely during the day; the
-- upsert keeps exactly one card per day. Schema is a FROZEN CONTRACT with the
-- Android app and the ll5-run persona (built concurrently).

CREATE TABLE IF NOT EXISTS day_cards (
  user_id    UUID NOT NULL,
  day        DATE NOT NULL,
  voice      TEXT,
  one_thing  TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, day)
);
