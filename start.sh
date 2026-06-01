#!/usr/bin/env bash
# start.sh — запускает meet-bridge и WhisperLive одной командой.
# Использование: ./start.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── загрузка .env ──────────────────────────────────────────────────────────────
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/.env"
  set +a
else
  echo "[start] .env не найден. Скопируй шаблон: cp .env.example .env"
  echo "[start] Используются переменные из окружения (export)."
fi

# ── проверка обязательных переменных ──────────────────────────────────────────
if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "[start] ОШИБКА: CURSOR_API_KEY не задан. Укажи его в .env."
  exit 1
fi
if [[ -z "${MEET_BRIDGE_REPO:-}" ]]; then
  echo "[start] ОШИБКА: MEET_BRIDGE_REPO не задан. Укажи абсолютный путь к репозиторию в .env."
  exit 1
fi
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "[start] ПРЕДУПРЕЖДЕНИЕ: GITHUB_TOKEN не задан — агент не сможет читать GitHub issues/PR."
fi

# ── проверка зависимостей ──────────────────────────────────────────────────────
if ! command -v agent &>/dev/null; then
  echo "[start] ОШИБКА: 'agent' не найден в PATH."
  echo "        Установи Cursor CLI: curl https://cursor.com/install -fsSL | bash"
  echo "        Затем добавь в ~/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\""
  exit 1
fi
if ! command -v go &>/dev/null; then
  echo "[start] ОШИБКА: 'go' не найден в PATH. Установи Go: https://go.dev/dl/"
  exit 1
fi

# ── сборка моста (если бинарь отсутствует) ────────────────────────────────────
BRIDGE_BIN="$SCRIPT_DIR/bridge/meet-bridge"
if [[ ! -f "$BRIDGE_BIN" ]]; then
  echo "[start] Собираю meet-bridge..."
  (cd "$SCRIPT_DIR/bridge" && go build -o meet-bridge ./cmd/meet-bridge)
  echo "[start] meet-bridge собран."
fi

# ── остановка всех процессов при выходе ───────────────────────────────────────
PIDS=()
cleanup() {
  echo ""
  echo "[start] Останавливаю процессы..."
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "[start] Готово."
}
trap cleanup EXIT INT TERM

# ── запуск meet-bridge serve ──────────────────────────────────────────────────
# Мост при старте сам создаёт whisper-server/.venv и ставит зависимости (первый запуск ~2-5 мин).
# Сервер начинает слушать порт 7337 только после завершения setup.
echo "[start] Запускаю meet-bridge (порт 7337)..."
echo "[start] При первом запуске установка WhisperLive займёт несколько минут — это нормально."
"$BRIDGE_BIN" serve -repo "$MEET_BRIDGE_REPO" &
BRIDGE_PID=$!
PIDS+=("$BRIDGE_PID")

# ── ожидание готовности моста (макс. 10 мин) ─────────────────────────────────
echo "[start] Жду пока meet-bridge поднимется на порту 7337..."
for i in $(seq 1 600); do
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "[start] ОШИБКА: meet-bridge упал при старте. Проверь логи выше."
    exit 1
  fi
  if nc -z 127.0.0.1 7337 2>/dev/null; then
    echo "[start] meet-bridge готов (${i}s)."
    break
  fi
  if [[ $i -eq 600 ]]; then
    echo "[start] ОШИБКА: meet-bridge не поднялся за 10 минут."
    exit 1
  fi
  sleep 1
done

# ── запуск WhisperLive ────────────────────────────────────────────────────────
WHISPER_DIR="$SCRIPT_DIR/whisper-server"
WHISPER_PYTHON="$WHISPER_DIR/.venv/bin/python3"

echo "[start] Запускаю WhisperLive (порт 9090)..."
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

# ── ожидание готовности WhisperLive (макс. 60 сек) ───────────────────────────
echo "[start] Жду WhisperLive на порту 9090..."
for i in $(seq 1 60); do
  if ! kill -0 "$WHISPER_PID" 2>/dev/null; then
    echo "[start] ОШИБКА: WhisperLive упал при старте. Проверь логи выше."
    exit 1
  fi
  if nc -z 127.0.0.1 9090 2>/dev/null; then
    echo "[start] WhisperLive готов (${i}s)."
    break
  fi
  if [[ $i -eq 60 ]]; then
    echo "[start] ОШИБКА: WhisperLive не поднялся за 60 секунд."
    exit 1
  fi
  sleep 1
done

# ── всё готово ────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  meet_assist запущен"
echo "  Мост:        http://127.0.0.1:7337"
echo "  WhisperLive: ws://127.0.0.1:9090"
echo "  Репозиторий: $MEET_BRIDGE_REPO"
echo ""
echo "  Открой Chrome → вкладку с встречей → расширение MeetBridge"
echo "  → укажи путь к репозиторию в Настройках → «Начать работу»"
echo ""
echo "  Остановить: Ctrl+C"
echo "════════════════════════════════════════════════════════════"

wait
