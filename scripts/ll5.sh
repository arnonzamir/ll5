#!/usr/bin/env bash
# ll5 — open a live opencode TUI on the agent container inside tmux.
# Usage: ll5 [attach|new|logs|restart|stop|exec|shell]
#
# attach (default) — attach to existing tmux session, create if absent
# new              — kill existing session and start fresh
# logs             — tail /tmp/opencode.log inside the container
# restart          — kill opencode serve and restart it
# stop             — kill opencode serve inside the container
# exec ARGS        — run `docker exec agent <ARGS>` with TTY
# shell            — open an interactive ssh shell on the host
set -euo pipefail

CONTAINER="${LL5_CONTAINER:-agent}"
SESSION="${LL5_TMUX_SESSION:-opencode}"
HOST="${LL5_HOST:-root@localhost}"
PORT="${LL5_SSH_PORT:-2222}"
PASS="${LL5_PASS:-agentdebug}"

SSH_BASE=(sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no -p "$PORT" "$HOST")
EXEC_BASE=(docker exec -it "$CONTAINER")

cmd="${1:-attach}"
shift || true

case "$cmd" in
  attach)
    "${SSH_BASE[@]}" "tmux has-session -t $SESSION 2>/dev/null \
      && tmux attach -t $SESSION \
      || (tmux new-session -s $SESSION -d 'cd /workspace && opencode 2>&1 | tee /tmp/opencode-cli.log' && tmux attach -t $SESSION)"
    ;;
  new)
    "${SSH_BASE[@]}" "tmux kill-session -t $SESSION 2>/dev/null; \
      tmux new-session -s $SESSION -d 'cd /workspace && opencode 2>&1 | tee /tmp/opencode-cli.log'; \
      sleep 1; tmux attach -t $SESSION"
    ;;
  logs)
    "${SSH_BASE[@]}" "docker exec $CONTAINER tail -n 200 -f /tmp/opencode.log"
    ;;
  restart)
    "${SSH_BASE[@]}" "docker exec $CONTAINER sh -c \
      'kill -9 \$(pgrep -f \"opencode serve\") 2>/dev/null || true; sleep 2; \
       cd /workspace && nohup opencode serve --hostname 0.0.0.0 --port 4096 \
         --print-logs --log-level DEBUG > /tmp/opencode.log 2>&1 &'"
    echo "opencode serve restarted"
    ;;
  stop)
    "${SSH_BASE[@]}" "docker exec $CONTAINER sh -c \
      'kill -9 \$(pgrep -f \"opencode serve\") 2>/dev/null || true; \
       pkill -f opencode 2>/dev/null || true'"
    echo "opencode stopped"
    ;;
  exec)
    "${SSH_BASE[@]}" "${EXEC_BASE[@]} $*"
    ;;
  shell)
    "${SSH_BASE[@]}"
    ;;
  *)
    echo "Usage: ll5 [attach|new|logs|restart|stop|exec|shell]" >&2
    exit 2
    ;;
esac
