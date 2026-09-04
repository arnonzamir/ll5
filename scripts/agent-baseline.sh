#!/usr/bin/env bash
# agent-baseline.sh — one-command re-measure of the LL5 agent baseline
# (docs/reviews/2026-09-04/agent-baseline.md), printed as Markdown on stdout.
#
# usage: scripts/agent-baseline.sh [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--user UUID]
#                                  > docs/reviews/<date>/agent-baseline.md
# defaults: --until today (UTC), --since 7 days before it (the last 7 full days
# plus today so far); user = the single live user. Days are inclusive.
#
# Transport only — all logic lives in scripts/agent-baseline.py:
#   1. python builds the ES request list; it is shipped base64-encoded, with
#      scripts/agent-baseline-esq.js, into the awareness container over SSH and
#      executed there against its ELASTICSEARCH_URL (ES is internal-only on the
#      box; credentials never leave the container and are never printed).
#   2. the GTD SQL runs via psql inside the postgres container the same way.
#   3. python renders the document from the two raw outputs.
# Override the box/containers with LL5_SSH_HOST, LL5_AWARENESS_CONTAINER,
# LL5_POSTGRES_CONTAINER, LL5_SSH_KEY.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SSH_HOST="${LL5_SSH_HOST:-root@95.216.23.208}"
SSH_KEY="${LL5_SSH_KEY:-$HOME/.ssh/id_ed25519}"
AWARENESS="${LL5_AWARENESS_CONTAINER:-awareness-xkkcc0g4o48kkcows8488so4}"
POSTGRES="${LL5_POSTGRES_CONTAINER:-postgres-xkkcc0g4o48kkcows8488so4}"
USER_ID="f08f46b3-0a9c-41ae-9e6a-294c697424e4"
UNTIL="$(date -u +%Y-%m-%d)"
SINCE=""
BASELINE="docs/reviews/2026-09-04/agent-baseline.md"   # relative to the repo root

while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    --until) UNTIL="$2"; shift 2 ;;
    --user) USER_ID="$2"; shift 2 ;;
    --baseline) BASELINE="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$SINCE" ]; then
  if date -u -v-7d +%Y-%m-%d >/dev/null 2>&1; then
    SINCE="$(date -u -j -f %Y-%m-%d "$UNTIL" -v-7d +%Y-%m-%d)"   # macOS
  else
    SINCE="$(date -u -d "$UNTIL -7 days" +%Y-%m-%d)"               # GNU
  fi
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/agent-baseline.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
PY="$HERE/agent-baseline.py"

# 1. Elasticsearch, inside the awareness container.
python3 "$PY" queries --since "$SINCE" --until "$UNTIL" --user "$USER_ID" > "$TMP/queries.json"
JS64="$(base64 < "$HERE/agent-baseline-esq.js" | tr -d '\n')"
Q64="$(base64 < "$TMP/queries.json" | tr -d '\n')"
echo "agent-baseline: ES ($SINCE → $UNTIL) via $AWARENESS ..." >&2
ssh -o BatchMode=yes -i "$SSH_KEY" "$SSH_HOST" \
  "docker exec $AWARENESS sh -lc 'echo $JS64 | base64 -d > /tmp/agent-baseline-esq.js; echo $Q64 | base64 -d > /tmp/agent-baseline-q.json; node /tmp/agent-baseline-esq.js /tmp/agent-baseline-q.json'" \
  > "$TMP/es.json"
[ -s "$TMP/es.json" ] || { echo "agent-baseline: empty ES response" >&2; exit 1; }

# 2. GTD, inside the postgres container.
python3 "$PY" queries --sql --since "$SINCE" --until "$UNTIL" --user "$USER_ID" > "$TMP/gtd.sql"
S64="$(base64 < "$TMP/gtd.sql" | tr -d '\n')"
echo "agent-baseline: GTD via $POSTGRES ..." >&2
ssh -o BatchMode=yes -i "$SSH_KEY" "$SSH_HOST" \
  "docker exec $POSTGRES sh -lc 'echo $S64 | base64 -d > /tmp/agent-baseline.sql; psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -q -f /tmp/agent-baseline.sql'" \
  > "$TMP/pg.txt"

# 3. Render (from the repo root so the frozen-baseline path is the doc-relative one).
cd "$ROOT"
python3 "$PY" render --since "$SINCE" --until "$UNTIL" --user "$USER_ID" \
  --es "$TMP/es.json" --pg "$TMP/pg.txt" --baseline "$BASELINE"
