#!/usr/bin/env bash
# start.sh — starts meet-bridge and WhisperLive with one command.
# Usage: ./start.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── load .env ──────────────────────────────────────────────────────────────
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/.env"
  set +a
else
  echo "[start] .env not found. Copy the template: cp .env.example .env"
  echo "[start] Using variables from the environment (export)."
fi

# ── required variables ──────────────────────────────────────────────────────
if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "[start] ERROR: CURSOR_API_KEY is not set. Add it to .env."
  exit 1
fi
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "[start] WARNING: GITHUB_TOKEN is not set — the agent cannot read GitHub issues/PRs."
fi

# ── cli-config.json check ─────────────────────────────────────────────────
if [[ ! -f "$HOME/.cursor/cli-config.json" ]]; then
  echo "[start] WARNING: ~/.cursor/cli-config.json not found."
  echo "        The agent may fail without Cursor CLI configuration."
  echo "        Copy it from your Cursor app: Cursor → Settings → Advanced → CLI"
  echo "        Or manually create it with your API key."
fi

# ── dependency checks ──────────────────────────────────────────────────────
if ! command -v agent &>/dev/null; then
  echo "[start] ERROR: 'agent' not found in PATH."
  echo "        Install Cursor CLI: curl https://cursor.com/install -fsSL | bash"
  echo "        Then add to ~/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\""
  exit 1
fi
if ! command -v go &>/dev/null; then
  echo "[start] ERROR: 'go' not found in PATH. Install Go: https://go.dev/dl/"
  exit 1
fi

# ── build bridge (if binary is missing) ────────────────────────────────────
BRIDGE_BIN="$SCRIPT_DIR/bridge/meet-bridge"
if [[ ! -f "$BRIDGE_BIN" ]]; then
  echo "[start] Building meet-bridge..."
  (cd "$SCRIPT_DIR/bridge" && go build -o meet-bridge ./cmd/meet-bridge)
  echo "[start] meet-bridge built."
fi

# ── stop all processes on exit ───────────────────────────────────────────────
PIDS=()
cleanup() {
  echo ""
  echo "[start] Stopping processes..."
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "[start] Done."
}
trap cleanup EXIT INT TERM

# ── start meet-bridge serve ──────────────────────────────────────────────────
# On first start the bridge creates whisper-server/.venv and installs deps (~2-5 min).
# Port 7337 opens only after setup completes.
echo "[start] Starting meet-bridge (port 7337)..."
echo "[start] First run: WhisperLive setup may take a few minutes — this is normal."
"$BRIDGE_BIN" serve &
BRIDGE_PID=$!
PIDS+=("$BRIDGE_PID")

# ── wait for bridge readiness (max 10 min) ─────────────────────────────────
echo "[start] Waiting for meet-bridge on port 7337..."
for i in $(seq 1 600); do
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "[start] ERROR: meet-bridge exited during startup. Check the logs above."
    exit 1
  fi
  if nc -z 127.0.0.1 7337 2>/dev/null; then
    echo "[start] meet-bridge ready (${i}s)."
    break
  fi
  if [[ $i -eq 600 ]]; then
    echo "[start] ERROR: meet-bridge did not start within 10 minutes."
    exit 1
  fi
  sleep 1
done

# ── start WhisperLive ────────────────────────────────────────────────────────
WHISPER_DIR="$SCRIPT_DIR/whisper-server"
WHISPER_PYTHON="$WHISPER_DIR/.venv/bin/python3"

echo "[start] Starting WhisperLive (port 9090)..."
"$WHISPER_PYTHON" "$WHISPER_DIR/run_server.py" \
  --host 127.0.0.1 \
  --port 9090 \
  --backend faster_whisper \
  --device cpu \
  --max_clients 2 \
  --max_connection_time 3600 \
  --beam_size 2 &
WHISPER_PID=$!
PIDS+=("$WHISPER_PID")

# ── wait for WhisperLive readiness (max 60 sec) ──────────────────────────────
echo "[start] Waiting for WhisperLive on port 9090..."
for i in $(seq 1 60); do
  if ! kill -0 "$WHISPER_PID" 2>/dev/null; then
    echo "[start] ERROR: WhisperLive exited during startup. Check the logs above."
    exit 1
  fi
  if nc -z 127.0.0.1 9090 2>/dev/null; then
    echo "[start] WhisperLive ready (${i}s)."
    break
  fi
  if [[ $i -eq 60 ]]; then
    echo "[start] ERROR: WhisperLive did not start within 60 seconds."
    exit 1
  fi
  sleep 1
done

# ── ready ────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  MeetBridge is running"
echo "  Bridge:      http://127.0.0.1:7337"
echo "  WhisperLive: ws://127.0.0.1:9090"
echo ""
echo "  Open Chrome → meeting tab → MeetBridge extension"
echo "  → set repository path in Settings → start listening"
echo ""
echo "  Stop: Ctrl+C"
echo "════════════════════════════════════════════════════════════"

wait
