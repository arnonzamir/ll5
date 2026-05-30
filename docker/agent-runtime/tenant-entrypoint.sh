#!/bin/bash
# ============================================================================
# LL5 per-tenant agent entrypoint (BYO-agent platform, P4).
#
# This is the entrypoint for the NEW `ll5-agent-tenant` image. It is a thin
# wrapper around the SAME workspace as the existing single-admin `ll5-agent`
# image (it is built FROM that image), differing in exactly three ways so the
# existing admin image and its deployment are left completely untouched:
#
#   1. Credentials are read from a mounted 0600 env-file ($LL5_AGENT_ENV_FILE),
#      never from `-e VAR=...` / argv (not visible in `ps` or `docker inspect`).
#   2. The LL5 token is the orchestrator-issued AGENT token, written directly to
#      $HOME/.ll5/token — NO username/PIN /auth/token login.
#   3. Claude authenticates with the tenant's own ANTHROPIC_API_KEY (BYO LLM),
#      not a CLAUDE_CODE_OAUTH_TOKEN subscription token.
#
# Plus: a background heartbeat loop POSTs /me/agent/heartbeat so the orchestrator
# knows this runtime is alive.
#
# Everything else (settings.json, .claude.json onboarding skip, get-mcp-auth.sh,
# .mcp.server.json, the tmux + ll5-server supervisor, mcp-autoheal, the wait
# loop) is reused verbatim from the base image's workspace.
# ============================================================================
set -e

# --- (1) Load creds from the mounted 0600 env-file (never argv) -------------
: "${LL5_AGENT_ENV_FILE:=/run/ll5/agent.env}"
if [ -f "$LL5_AGENT_ENV_FILE" ]; then
  set -a; . "$LL5_AGENT_ENV_FILE"; set +a
  echo "[tenant-entrypoint] loaded creds from $LL5_AGENT_ENV_FILE"
fi

# --- Required tenant inputs --------------------------------------------------
: "${LL5_USER_ID:?Missing LL5_USER_ID}"
: "${LL5_AGENT_TOKEN:?Missing LL5_AGENT_TOKEN (orchestrator-issued ll5 agent token)}"
: "${ANTHROPIC_API_KEY:?Missing ANTHROPIC_API_KEY the tenants own Anthropic key}"
: "${LL5_GATEWAY_URL:=https://gateway.noninoni.click}"
LL5_PROCESSOR_ID="${LL5_PROCESSOR_ID:-tenant-$LL5_USER_ID}"
: "${LL5_HEARTBEAT_SEC:=60}"
export HOME="${HOME:-/data/home}"
export LL5_GATEWAY_URL LL5_PROCESSOR_ID ANTHROPIC_API_KEY LL5_USER_ID

mkdir -p "$HOME/.ll5" "$HOME/.claude"
cp /workspace/ll5-run/docker/tmux.conf "$HOME/.tmux.conf"

# --- Claude Code first-run / permission setup (identical to base image) -----
cat > "$HOME/.claude/settings.json" <<'JSON'
{
  "env": { "DISABLE_AUTOUPDATER": "1" },
  "skipAutoPermissionPrompt": true,
  "permissions": { "defaultMode": "auto" }
}
JSON
if [ ! -f "$HOME/.claude.json" ] || ! python3 -c "import json,sys; sys.exit(0 if json.load(open('$HOME/.claude.json')).get('hasCompletedOnboarding') else 1)" 2>/dev/null; then
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  cat > "$HOME/.claude.json" <<EOF
{
  "hasCompletedOnboarding": true,
  "lastOnboardingVersion": "1.0.120",
  "theme": "dark",
  "numStartups": 1,
  "firstStartTime": "$NOW",
  "autoUpdates": false,
  "projects": {
    "/workspace/ll5-run": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true,
      "projectOnboardingSeenCount": 1,
      "hasClaudeMdExternalIncludesApproved": true,
      "hasClaudeMdExternalIncludesWarningShown": true
    }
  }
}
EOF
fi
cp /workspace/ll5-run/scripts/get-mcp-auth.sh "$HOME/.ll5/get-mcp-auth.sh"
chmod +x "$HOME/.ll5/get-mcp-auth.sh"

echo "[tenant-entrypoint] claude --version: $(claude --version 2>&1 || echo CLAUDE_VERSION_FAILED)"
echo "[tenant-entrypoint] tenant user_id: $LL5_USER_ID  gateway: $LL5_GATEWAY_URL"
echo "[tenant-entrypoint] ANTHROPIC_API_KEY: $([ -n "${ANTHROPIC_API_KEY:-}" ] && echo "set (${#ANTHROPIC_API_KEY} chars)" || echo UNSET)"

# --- (2) Write the orchestrator-issued agent token directly -----------------
# (Base image logs in with username+PIN here; tenants use the agent token.)
printf '%s' "$LL5_AGENT_TOKEN" > "$HOME/.ll5/token"
chmod 600 "$HOME/.ll5/token"
echo "[tenant-entrypoint] agent token written to $HOME/.ll5/token (channel MCP refreshes it)"

# Static server .mcp.json (auth is dynamic via get-mcp-auth.sh → ~/.ll5/token)
cp /workspace/ll5-run/.mcp.server.json /workspace/ll5-run/.mcp.json

# --- Heartbeat loop: tell the orchestrator we're alive ----------------------
(
  while true; do
    T=$(cat "$HOME/.ll5/token" 2>/dev/null || echo "")
    if [ -n "$T" ]; then
      curl -fsS --max-time 10 -X POST "$LL5_GATEWAY_URL/me/agent/heartbeat" \
        -H "Authorization: Bearer $T" >/dev/null 2>&1 || true
    fi
    sleep "$LL5_HEARTBEAT_SEC"
  done
) &
echo "[tenant-entrypoint] heartbeat loop started (every ${LL5_HEARTBEAT_SEC}s → /me/agent/heartbeat)"

# --- (3) Launch the SAME supervisor in tmux, with ANTHROPIC_API_KEY ----------
tmux -u new-session -d -s ll5 -c /workspace/ll5-run \
  -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
  -e "LL5_GATEWAY_URL=$LL5_GATEWAY_URL" \
  -e "LL5_PROCESSOR_ID=$LL5_PROCESSOR_ID" \
  -e "TZ=${TZ:-Asia/Jerusalem}" \
  -e "LANG=${LANG:-en_US.UTF-8}" \
  -e "LC_ALL=${LC_ALL:-en_US.UTF-8}" \
  -e "TERM=${TERM:-xterm-256color}" \
  "exec ./ll5-server"

sleep 1
tmux pipe-pane -t ll5 -o "cat >> $HOME/.ll5/claude.log"
: > "$HOME/.ll5/claude.log"
tail -F "$HOME/.ll5/claude.log" 2>/dev/null &

# Auto-dismiss any first-run prompts (identical to base image)
(
  sleep 15
  tmux send-keys -t ll5 Down Enter 2>/dev/null || true
  sleep 6
  for i in 1 2 3 4; do tmux send-keys -t ll5 Enter 2>/dev/null || true; sleep 6; done
) &

/workspace/ll5-run/scripts/mcp-autoheal-server.sh &
echo "[tenant-entrypoint] agent started in tmux 'll5' for tenant $LL5_USER_ID"

# Keep the container alive while the agent session lives (Coolify/orchestrator restarts on exit)
while tmux has-session -t ll5 2>/dev/null; do
  sleep 30
done
echo "[tenant-entrypoint] tmux session ended — exiting so the runtime is restarted"
