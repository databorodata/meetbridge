# whisper-server (локальный WhisperLive)

Здесь лежит **`run_server.py`** (обёртка над WhisperLive, как в референсе `Audio-Transcription`) и **`requirements.txt`**.

## Что делает мост автоматически

При первом запуске **`meet-bridge serve`** (и при **`meet-bridge setup-whisper`**):

1. Определяется каталог `whisper-server` (рядом с бинарником `meet-bridge`, либо `MEET_WHISPER_ROOT`, либо `-whisper-root`).
2. Создаётся **`.venv/`** (если ещё нет или сломан импорт).
3. Выполняется **`pip install -r requirements.txt`**.
4. Проверяется `import whisper_live`.

Расширение Chrome это **не делает** (ограничение браузера); подготовку выполняет **только** мост на машине пользователя.

## Что нужно на системе

- **Python 3.10+** в `PATH` (рекомендуется 3.11, см. `help/whisper.md`).  
  Установка через Homebrew и т.п. остаётся на стороне пользователя или отдельного инсталлятора — мост **не** вызывает `brew` автоматически.

## Отключить автоматическую подготовку

```bash
export MEET_BRIDGE_SKIP_WHISPER_SETUP=1
# или
./meet-bridge serve -skip-whisper-setup ...
```

## Ручной запуск сервера (после setup)

Из каталога `whisper-server`:

```bash
source .venv/bin/activate
python3 run_server.py --host 127.0.0.1 --port 9090 --backend faster_whisper --device cpu --max_clients 2 --max_connection_time 3600 --beam_size 2
```

Дальше расширение подключается к `ws://127.0.0.1:9090` как раньше.
