#!/usr/bin/env bash
#
# Perplexity Direct Gateway — SwiftBar status + start/stop/restart.
# Backed by the Aurora-mode HTTP gateway (no CDP per request).
#
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.refreshOnOpen>true</swiftbar.refreshOnOpen>

set -uo pipefail
export PATH="/Users/matthew/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SELF="$0"
REPO="$HOME/perplexity-direct-gateway"
API_URL="http://127.0.0.1:8788"
LOG_DIR="$HOME/Library/Logs/perplexity-direct"
SESSION_FILE="$HOME/.perplexity-session.txt"
REFRESH_LABEL="ai.perplexity-direct.cookie-refresh"

bash_self() { # <action> <terminal> <refresh>
  echo "bash='$SELF' param1=$1 terminal=${2:-false} refresh=${3:-true}"
}

is_running() {
  nc -z 127.0.0.1 8788 >/dev/null 2>&1
}

# ─── Click actions ─────────────────────────────────────────────────────────
case "${1:-}" in
  start_server)
    if ! is_running; then
      mkdir -p "$LOG_DIR"
      cd "$REPO" || exit 1
      nohup node src/server.mjs >>"$LOG_DIR/server.log" 2>&1 &
      disown
    fi
    exit 0 ;;
  stop_server)
    pkill -f "node src/server.mjs" 2>/dev/null
    exit 0 ;;
  restart_server)
    pkill -f "node src/server.mjs" 2>/dev/null
    sleep 1
    mkdir -p "$LOG_DIR"
    cd "$REPO" || exit 1
    nohup node src/server.mjs >>"$LOG_DIR/server.log" 2>&1 &
    disown
    exit 0 ;;
  refresh_cookie_now)
    python3 "$HOME/perplexity-direct-gateway/ops/refresh-cookie.py" >/dev/null 2>&1
    exit 0 ;;
  open_server_log)  open -a TextEdit "$LOG_DIR/server.log" 2>/dev/null; exit 0 ;;
  open_refresh_log) open -a TextEdit "$LOG_DIR/token-refresh.out.log" 2>/dev/null; exit 0 ;;
  open_repo)        open "$REPO"; exit 0 ;;
esac

# ─── Status ────────────────────────────────────────────────────────────────
running=0
is_running && running=1

reachable=0
if [ "$running" -eq 1 ] && curl -s -o /dev/null -m 3 "$API_URL/health" 2>/dev/null; then
  reachable=1
fi

# Parse /health for detailed info
health_json=""
cookie_age_s=""
session_alive="false"
if [ "$reachable" -eq 1 ]; then
  health_json="$(curl -s -m 3 "$API_URL/health" 2>/dev/null)"
  cookie_age_s="$(echo "$health_json" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{ try { console.log(JSON.parse(d).cookieAgeSeconds||""); } catch { console.log(""); } });' 2>/dev/null)"
  session_alive="$(echo "$health_json" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{ try { console.log(JSON.parse(d).sessionAlive?"true":"false"); } catch { console.log("false"); } });' 2>/dev/null)"
fi

# Cookie file info
cookie_exists=false
cookie_file_age_s=""
if [ -f "$SESSION_FILE" ]; then
  cookie_exists=true
  cookie_file_age_s=$(( $(date +%s) - $(stat -f "%m" "$SESSION_FILE" 2>/dev/null || echo 0) ))
fi

# Refresh log age
refresh_log="$LOG_DIR/token-refresh.out.log"
refresh_age_s=""
if [ -f "$refresh_log" ]; then
  refresh_age_s=$(( $(date +%s) - $(stat -f "%m" "$refresh_log" 2>/dev/null || echo 0) ))
fi

# Overall status
if [ "$reachable" -eq 1 ] && [ "$session_alive" = "true" ]; then
  overall="🟢"; color="green"; state_label="running, session alive"
elif [ "$reachable" -eq 1 ]; then
  overall="🟡"; color="orange"; state_label="running, session stale — refresh cookie"
elif [ "$running" -eq 1 ]; then
  overall="🟡"; color="orange"; state_label="process alive, /health unreachable"
else
  overall="🔴"; color="red"; state_label="stopped"
fi

# Cookie detail
cookie_detail="no session file"
if [ "$cookie_exists" = true ]; then
  if [ -n "$cookie_age_s" ] && [ "$cookie_age_s" -ge 0 ] 2>/dev/null; then
    hrs=$((cookie_age_s / 3600))
    cookie_detail="cookie file updated ${hrs}h ago (gateway reports)"
  else
    hrs=$((cookie_file_age_s / 3600))
    cookie_detail="cookie file updated ~${hrs}h ago"
  fi
fi

refresh_detail=""
if [ -n "$refresh_age_s" ] && [ "$refresh_age_s" -ge 0 ] 2>/dev/null; then
  refresh_detail="last refresh attempt: $((refresh_age_s / 60))min ago"
fi

# ─── Menu ──────────────────────────────────────────────────────────────────
echo "${overall} PPLX-D | color=${color}"
echo "---"
echo "Perplexity Direct Gateway — ${state_label}"
echo "$API_URL"
echo "$cookie_detail"
[ -n "$refresh_detail" ] && echo "$refresh_detail"
echo "---"
if [ "$running" -eq 1 ]; then
  echo "⏹️ Stop server | $(bash_self stop_server false true)"
  echo "🔄 Restart server | $(bash_self restart_server false true)"
else
  echo "▶️ Start server | $(bash_self start_server false true)"
fi
echo "🔑 Refresh cookie now | $(bash_self refresh_cookie_now false true)"
echo "📄 View server log | $(bash_self open_server_log false false)"
echo "📄 View refresh log | $(bash_self open_refresh_log false false)"
echo "---"
echo "Models"
if [ "$reachable" -eq 1 ]; then
  models_json="$(curl -s -m 2 "$API_URL/v1/models" 2>/dev/null)"
  echo "$models_json" | node -e '
    let d = ""; process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => {
      try { JSON.parse(d).data.forEach((m) => console.log("--" + m.id)); } catch { console.log("--(unavailable)"); }
    });' 2>/dev/null
else
  for m in best sonar gemini gemini-thinking sonnet sonnet-thinking kimi glm grok grok-thinking nemotron; do echo "--$m"; done
fi
echo "Capabilities"
echo "--OpenAI-compatible /v1/chat/completions (streaming + non-streaming)"
echo "--File upload (90+ formats: PDF, DOCX, images, code, etc.)"
echo "--Citations in response"
echo "--Serial queue + human-like timing"
echo "--Zero CDP per request (Aurora-mode direct HTTP)"
echo "---"
echo "📂 Open repo | $(bash_self open_repo false false)"
