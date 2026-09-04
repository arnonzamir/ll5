#!/usr/bin/env bash
# esq.sh — ad-hoc query against the PROD Elasticsearch, which is internal-only.
# Ships scripts/esq.js into the awareness container over SSH and runs it there
# against the container's ELASTICSEARCH_URL (credentials never leave the box).
#
#   scripts/esq.sh '/ll5_agent_journal/_count'
#   scripts/esq.sh '/ll5_agent_journal/_search' '{"size":1,"sort":[{"timestamp":"desc"}]}'
#   METHOD=PUT scripts/esq.sh '/some_index' '{"mappings":{...}}'     # PUT/DELETE via METHOD
#
# Path must start with '/'. Body present → POST (unless METHOD set). Same host and
# container as scripts/agent-baseline.sh — update both if either moves.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOST="${LL5_HOST:-root@95.216.23.208}"
AWARENESS="${LL5_AWARENESS_CONTAINER:-awareness-xkkcc0g4o48kkcows8488so4}"
B64=$(base64 < "$HERE/esq.js" | tr -d '\n')
PATH_ARG=$1; BODY=${2:-}
ssh -o BatchMode=yes "$HOST" \
  "docker exec $AWARENESS sh -lc 'echo $B64 | base64 -d > /tmp/esq.js; METHOD=${METHOD:-} node /tmp/esq.js \"\$1\" \"\$2\"' _ $(printf %q "$PATH_ARG") $(printf %q "$BODY")"
