#!/usr/bin/env bash

# Move to the script's directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
RUN_STAMP="$(date +%Y%m%d_%H%M%S)"
SERVER_LOG="$LOG_DIR/server_$RUN_STAMP.log"
TUNNEL_LOG="$LOG_DIR/cloudflared_$RUN_STAMP.log"
SERVER_PID=""
TUNNEL_PID=""

# 1. Start Auto-Sync Python Server in background
if [ -f "server.py" ]; then
    python3 server.py 8000 >"$SERVER_LOG" 2>&1 &
    SERVER_PID=$!
else
    python3 -m http.server 8000 >/dev/null 2>&1 &
    SERVER_PID=$!
fi

# 2. Clean up both processes when stopping the script
cleanup() {
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
    [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

# 3. Confirm the persistence API is alive before publishing it.
SERVER_READY=""
for _ in $(seq 1 50); do
    if curl -fsS http://localhost:8000/api/status >/dev/null 2>&1; then
        SERVER_READY="yes"
        break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "Cold Calling server failed to start. See: $SERVER_LOG"
        exit 1
    fi
    sleep 0.2
done
if [ -z "$SERVER_READY" ]; then
    echo "Cold Calling server did not become ready. See: $SERVER_LOG"
    exit 1
fi

# 4. Prefer a named tunnel because it keeps one stable browser origin.
if [ -n "${ESC_TUNNEL_NAME:-}" ]; then
    cloudflared tunnel run --url http://localhost:8000 "$ESC_TUNNEL_NAME" >"$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    URL="${ESC_PUBLIC_URL:-your configured Cloudflare hostname}"
    TUNNEL_MODE="named/stable"
elif [ -n "${TUNNEL_TOKEN_FILE:-}" ]; then
    cloudflared tunnel run --url http://localhost:8000 --token-file "$TUNNEL_TOKEN_FILE" >"$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    URL="${ESC_PUBLIC_URL:-your configured Cloudflare hostname}"
    TUNNEL_MODE="token/stable"
else
    cloudflared tunnel --url http://localhost:8000 >"$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    TUNNEL_MODE="quick/temporary"

    URL=""
    while [ -z "$URL" ]; do
        if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
            echo "cloudflared failed to start. Local server: http://localhost:8000"
            echo "See: $TUNNEL_LOG"
            wait "$SERVER_PID"
            exit 1
        fi
        URL=$(grep -m 1 -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null)
        sleep 0.2
    done
fi

# 5. Display the accessible URLs and persistence mode.
echo "=========================================="
echo "⚡ ESC Cold Call Copilot is Live (Auto-Sync Active)!"
echo "🌐 Local URL:  http://localhost:8000"
echo "🚀 Public URL: $URL"
echo "🔒 Tunnel mode: $TUNNEL_MODE"
echo "💾 Host data: $SCRIPT_DIR/pipeline_state.json"
echo "📸 Host snapshots: $SCRIPT_DIR/snapshots/"
echo "🧾 Logs: $SERVER_LOG and $TUNNEL_LOG"
echo "=========================================="
if [ "$TUNNEL_MODE" = "quick/temporary" ]; then
    echo "WARNING: this URL changes on every run. Use a named tunnel for reliable browser recovery."
fi

# Keep tunnel active until Ctrl+C
wait "$TUNNEL_PID"
