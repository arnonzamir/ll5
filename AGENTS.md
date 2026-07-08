Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman lite|full|ultra|wenyan
Stop: "stop caveman" or "normal mode"

Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.

Boundaries: code/commits/PRs written normal.

## Local dev commands

Script: `scripts/ll5.sh` (symlinked to `/usr/local/bin/ll5` on dev machines).

| Command       | Action                                                                |
| ------------- | --------------------------------------------------------------------- |
| `ll5`         | attach to (or create) tmux session `opencode` on agent container     |
| `ll5 new`     | kill + restart opencode TUI in tmux                                   |
| `ll5 logs`    | tail last 200 lines of `/tmp/opencode.log`                            |
| `ll5 restart` | restart `opencode serve` (HTTP API on port 4096)                      |
| `ll5 stop`    | kill opencode inside container                                        |
| `ll5 exec …`  | run `docker exec agent …` with TTY                                    |
| `ll5 shell`   | open raw ssh shell on the bun agent container                         |

Defaults (override via env vars):
- `LL5_CONTAINER=agent`
- `LL5_TMUX_SESSION=opencode`
- `LL5_HOST=root@localhost`
- `LL5_SSH_PORT=2222` (port mapped from agent container on host)
- `LL5_PASS=agentdebug`

Wire to Termius: 1 host entry → `95.216.23.208` user root key auth. After connect run `ll5`. Snippets optional.

## Variant switch

- Active variant env var on host env: `AGENT_VARIANT`
  - `claude` → `js8owk0g0cgog800ckc8ww0s-105937860264` (legacy gateway client)
  - `opencode` → `agent` container, opencode on :4096 inside
- Single rollback = `AGENT_VARIANT=claude` + redeploy.
