#!/usr/bin/env bash
# LL5 Agent Watchdog — independent liveness monitor
#
# Runs OUTSIDE the agent container (host cron / systemd timer) and raises
# a system alert through the LL5 gateway's alert spine (→ agent message +
# FCM push to phone) when the agent stops responding.
#
# Unlike SMTP/Telegram-based watchdogs this uses the gateway's own alert
# mechanism, so it depends on the gateway being up. If both agent AND
# gateway are down, no notification can be sent (logs only).
#
# Install:
#   sudo cp docker/agent-watchdog.sh /usr/local/bin/ll5-watchdog
#   sudo chmod +x /usr/local/bin/ll5-watchdog
#
#   # As a systemd timer (preferred — gives you logging):
#   sudo cp docker/ll5-watchdog.service /etc/systemd/system/
#   sudo cp docker/ll5-watchdog.timer /etc/systemd/system/
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now ll5-watchdog.timer
#
# Env vars (set in the systemd service file):
#   LL5_PUBLIC_URL         — gateway public URL (default https://gateway.noninoni.click)
#   LL5_WATCHDOG_INTERVAL  — seconds between checks (default 300)
#   LL5_WATCHDOG_CURL_TIMEOUT — curl --max-time per probe (default 10)
#   LL5_WATCHDOG_DATA_DIR  — state directory (default /var/lib/ll5-watchdog)
#   LL5_WATCHDOG_NTH_FAIL  — alert every Nth consecutive failure (default 1)
#   LL5_WATCHDOG_RECOVERY_MSG — send "recovered" message (default true)

set -euo pipefail

# ── Config ─────────────────────────────────────────────────────────────────

PUBLIC_URL="${LL5_PUBLIC_URL:-https://gateway.noninoni.click}"
INTERVAL="${LL5_WATCHDOG_INTERVAL:-300}"
CURL_TIMEOUT="${LL5_WATCHDOG_CURL_TIMEOUT:-10}"
DATA_DIR="${LL5_WATCHDOG_DATA_DIR:-/var/lib/ll5-watchdog}"
NTH_FAIL="${LL5_WATCHDOG_NTH_FAIL:-1}"
SEND_RECOVERY="${LL5_WATCHDOG_RECOVERY_MSG:-true}"

STATE_FILE="${DATA_DIR}/state"
LOCK_FILE="${DATA_DIR}/lock"
LOG_FILE="${DATA_DIR}/watchdog.log"

# ── Helpers ────────────────────────────────────────────────────────────────

info()  { echo "[ll5-watchdog] $(date '+%Y-%m-%d %H:%M:%S') INFO  $*" | tee -a "$LOG_FILE" >&2; }
warn()  { echo "[ll5-watchdog] $(date '+%Y-%m-%d %H:%M:%S') WARN  $*" | tee -a "$LOG_FILE" >&2; }
error() { echo "[ll5-watchdog] $(date '+%Y-%m-%d %H:%M:%S') ERROR $*" | tee -a "$LOG_FILE" >&2; }

ensure_data_dir() {
  if [[ ! -d "$DATA_DIR" ]]; then
    mkdir -p "$DATA_DIR"
  fi
}

acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local pid
    pid=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      warn "Previous watchdog still running (pid $pid) — skipping"
      exit 0
    fi
    warn "Stale lock file — removing"
  fi
  echo "$$" > "$LOCK_FILE"
  trap 'rm -f "$LOCK_FILE"' EXIT
}

read_state() {
  if [[ -f "$STATE_FILE" ]]; then
    local last_status last_ts fail_count
    IFS='|' read -r last_status last_ts fail_count < "$STATE_FILE" 2>/dev/null || true
    echo "${last_status:-ok}" "${last_ts:-0}" "${fail_count:-0}"
  else
    echo "ok 0 0"
  fi
}

write_state() {
  local status="$1" ts="$2" count="$3"
  echo "${status}|${ts}|${count}" > "$STATE_FILE"
}

# ── Auth & Gateway API ─────────────────────────────────────────────────────

LIVENESS_KEY="service.agent-liveness"

extract_gateway_env() {
  if ! command -v docker &>/dev/null; then
    return 1
  fi
  local gateway_id
  gateway_id=$(docker ps -q -f name=gateway 2>/dev/null | head -1)
  if [[ -z "$gateway_id" ]]; then
    return 1
  fi
  docker inspect "$gateway_id" --format '{{json .Config.Env}}' 2>/dev/null
}

get_gateway_env_val() {
  local key="$1" json
  json=$(extract_gateway_env) || return 1
  python3 -c "
import sys, json
env = json.load(sys.stdin)
for e in env:
  k, _, v = e.partition('=')
  if k == '$key':
    print(v)
    sys.exit(0)
sys.exit(1)
" <<< "$json"
}

get_user_id() {
  # Try agent container first (has USER_ID), fall back to gateway
  if command -v docker &>/dev/null; then
    local container_id
    container_id=$(docker ps -q -f name=agent 2>/dev/null | head -1)
    if [[ -z "$container_id" ]]; then
      container_id=$(docker ps -q -f name=gateway 2>/dev/null | head -1)
    fi
    if [[ -n "$container_id" ]]; then
      docker inspect "$container_id" --format '{{json .Config.Env}}' 2>/dev/null | \
        python3 -c "
import sys, json
env = json.load(sys.stdin)
for e in env:
  k, _, v = e.partition('=')
  if k == 'USER_ID':
    print(v)
    sys.exit(0)
# Fallback: extract from AGENT_TOKEN/LL5_TOKEN
for e in env:
  k, _, v = e.partition('=')
  if k in ('AGENT_TOKEN', 'LL5_TOKEN'):
    import base64
    parts = v.split('.')
    if len(parts) == 3 and parts[0] == 'll5':
      try:
        pad = 4 - len(parts[1]) % 4
        if pad != 4: parts[1] += '=' * pad
        data = json.loads(base64.urlsafe_b64decode(parts[1]))
        print(data['uid'])
        sys.exit(0)
      except: pass
sys.exit(1)
" && return 0
    fi
  fi
  return 1
}

generate_auth_token() {
  local auth_secret user_id
  auth_secret=$(get_gateway_env_val AUTH_SECRET) || return 1
  user_id=$(get_user_id) || return 1
  python3 -c "
import hashlib, hmac, json, time, base64

payload = json.dumps({
    'uid': '$user_id',
    'role': 'superadmin',
    'iat': int(time.time()),
    'exp': int(time.time()) + 3600,
}, separators=(',', ':'))

b64 = base64.urlsafe_b64encode(payload.encode()).rstrip(b'=').decode()
sig = hmac.new(b'$auth_secret', b64.encode(), hashlib.sha256).hexdigest()[:32]
print(f'll5.{b64}.{sig}')
"
}

send_alert() {
  local severity="$1" summary="$2" value="${3:-}" expected="${4:-}" suggestion="${5:-}"

  local token
  token=$(generate_auth_token) || {
    warn "Cannot generate auth token (gateway unreachable?) — falling back to log-only"
    return 1
  }

  local body
  body=$(python3 -c "
import json
print(json.dumps({
    'key': '$LIVENESS_KEY',
    'severity': '$severity',
    'summary': '$summary',
    'value': '${value}' if '${value}' else None,
    'expected': '${expected}' if '${expected}' else None,
    'suggestion': '${suggestion}' if '${suggestion}' else None,
}))
")

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$CURL_TIMEOUT" \
    -X POST "${PUBLIC_URL}/alerts" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d "$body" 2>/dev/null || echo "000")

  if [[ "$http_code" == "200" ]]; then
    return 0
  else
    warn "Gateway /alerts returned HTTP ${http_code}"
    return 1
  fi
}

notify() {
  local severity="$1" summary="$2" value="$3" expected="$4" suggestion="$5"
  info "Alert queued: ${severity} — ${summary}"
  if ! send_alert "$severity" "$summary" "$value" "$expected" "$suggestion"; then
    warn "Failed to send alert via gateway"
  fi
}

# ── Agent health check ────────────────────────────────────────────────────

check_agent() {
  # Method 1: Docker container health (authoritative — works even if agent is
  # restarting its HTTP server but Docker still reports it alive).
  if command -v docker &>/dev/null; then
    local agent_container
    agent_container=$(docker ps -q -f name=agent 2>/dev/null | head -1)
    if [[ -n "$agent_container" ]]; then
      local health
      health=$(docker inspect "$agent_container" --format "{{.State.Health.Status}}" 2>/dev/null || echo "unknown")
      if [[ "$health" == "healthy" ]]; then
        return 0
      elif [[ "$health" == "starting" ]]; then
        return 1
      elif [[ "$health" == "unhealthy" ]]; then
        return 2
      fi
    fi
  fi

  # Method 2: Direct HTTP check on agent port
  local agent_port="${LL5_AGENT_PORT:-4096}"
  local agent_code
  agent_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:${agent_port}/" 2>/dev/null || echo "000")
  if [[ "$agent_code" == "200" || "$agent_code" == "302" || "$agent_code" == "404" ]]; then
    return 0
  fi

  return 2
}

# ── Main ──────────────────────────────────────────────────────────────────

main() {
  local mode="${1:-check}"
  ensure_data_dir

  case "$mode" in
    check)
      acquire_lock
      local state_info fail_count last_status last_ts
      state_info=$(read_state) || true
      last_status=$(echo "$state_info" | cut -d' ' -f1)
      last_ts=$(echo "$state_info" | cut -d' ' -f2)
      fail_count=$(echo "$state_info" | cut -d' ' -f3)

      local now
      now=$(date +%s)

      info "Checking agent health"

      local exit_code=0
      check_agent || exit_code=$?

      if [[ "$exit_code" -eq 0 ]]; then
        # Agent is healthy
        if [[ "$last_status" == "down" ]]; then
          local downtime=$(( (now - last_ts) / 60 ))
          info "Agent recovered (was down for ${downtime} minutes)"
          write_state "ok" "$now" "0"
          if [[ "$SEND_RECOVERY" == "true" ]]; then
            notify "info" "Agent recovered after ${downtime}m" \
              "healthy" "healthy" \
              "Agent is responding again after ${downtime} minutes of downtime."
          fi
        else
          info "Agent healthy"
          write_state "ok" "$now" "0"
        fi

      elif [[ "$exit_code" -eq 1 ]]; then
        # Degraded
        fail_count=$((fail_count + 1))
        if [[ "$last_status" != "down" ]]; then
          warn "Agent health degraded (attempt ${fail_count})"
          write_state "degraded" "$now" "$fail_count"
        fi
        if [[ $((fail_count % NTH_FAIL)) -eq 0 ]]; then
          notify "warning" "Agent health degraded" \
            "degraded (attempt ${fail_count})" "healthy" \
            "Docker health check returned 'starting'. SSH to server and investigate: docker ps"
        fi

      else
        # Critical — agent unreachable
        fail_count=$((fail_count + 1))
        if [[ "$last_status" != "down" ]]; then
          warn "Agent UNREACHABLE — alerting"
          write_state "down" "$now" "$fail_count"
          notify "critical" "Agent unreachable" \
            "unreachable" "healthy" \
            "SSH to server and investigate: docker ps && docker logs --tail 50 \$(docker ps -q -f name=agent)"
        else
          if [[ $((fail_count % NTH_FAIL)) -eq 0 ]]; then
            local downtime_min=$(( (now - last_ts) / 60 ))
            notify "critical" "Agent still unreachable (${downtime_min}m)" \
              "unreachable for ${downtime_min} minutes" "healthy" \
              "SSH to server and investigate: docker ps && docker logs --tail 50 \$(docker ps -q -f name=agent)"
          fi
          write_state "down" "$last_ts" "$fail_count"
        fi
      fi
      ;;

    status)
      local state_info fail_count last_status last_ts
      state_info=$(read_state) || true
      last_status=$(echo "$state_info" | cut -d' ' -f1)
      last_ts=$(echo "$state_info" | cut -d' ' -f2)
      fail_count=$(echo "$state_info" | cut -d' ' -f3)
      if [[ "$last_status" == "down" ]]; then
        local now
        now=$(date +%s)
        local downtime=$(( (now - last_ts) / 60 ))
        echo "Status: DOWN for ${downtime} minutes (${fail_count} failed checks)"
      elif [[ "$last_status" == "degraded" ]]; then
        echo "Status: DEGRADED (${fail_count} failed checks)"
      else
        echo "Status: OK"
      fi
      ;;

    reset)
      write_state "ok" "$(date +%s)" "0"
      info "State reset to OK"
      ;;

    test-notify)
      notify "warning" "Watchdog test notification" \
        "test" "healthy" \
        "This is a test alert to verify the watchdog → gateway → FCM pipeline."
      ;;

    *)
      echo "Usage: $0 {check|status|reset|test-notify}"
      echo ""
      echo "Commands:"
      echo "  check        Run one health-check cycle (meant for cron/systemd timer)"
      echo "  status       Show current state"
      echo "  reset        Reset state to healthy"
      echo "  test-notify  Send a test alert to verify the notification pipeline"
      exit 1
      ;;
  esac
}

main "$@"
