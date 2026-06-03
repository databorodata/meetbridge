---
name: Подготовка MeetBridge к публикации
overview: "Подготовить проект meet_assist к публичному релизу на GitHub: перевести всё на английский, почистить конфиг, убрать бинарник из отслеживания, добавить LICENSE, объединить документацию, переименовать в MeetBridge и написать подробный README."
todos:
  - id: translate-extension
    content: Перевести весь русский текст в meet-extension/ на английский (popup.html, popup.js, manifest.json, background.js, capture.js, dictation.js)
    status: completed
  - id: translate-root
    content: Перевести русский текст в start.sh, .env.example, whisper-server/requirements.txt
    status: completed
  - id: remove-internal-refs
    content: Убрать ссылки на help/, plan_meet.md, cli_cursor.md из комментариев в коде
    status: pending
  - id: rename-module
    content: Переименовать Go-модуль с meet_assist на meetbridge, обновить импорты в main.go
    status: completed
  - id: remove-repo-env
    content: Убрать MEET_BRIDGE_REPO из .env.example и start.sh, оставить -repo как опциональный флаг CLI
    status: completed
  - id: cleanup-gitignore
    content: Убрать из .gitignore записи только для разработки (Audio-Transcription и т.д.)
    status: pending
  - id: add-cli-config-check
    content: Добавить проверку/предупреждение о наличии cli-config.json в start.sh
    status: completed
  - id: add-license
    content: Добавить файл LICENSE (MIT)
    status: completed
  - id: delete-whisper-readme
    content: Удалить whisper-server/README.md, перенести содержимое в будущий корневой README
    status: pending
  - id: fix-placeholder
    content: Исправить захардкоженный русский placeholder-путь в popup.html
    status: completed
  - id: test-second-mac
    content: Протестировать свежий clone + start.sh на втором Mac
    status: pending
  - id: write-readme
    content: Написать подробный README.md на английском с таблицей моделей, инструкцией по PAT и схемой архитектуры
    status: completed
isProject: false
---

# MeetBridge: подготовка к публичному релизу

Проект будет опубликован как новый репозиторий (без истории коммитов). Ниже — полный список изменений, которые нужно сделать до `git init` + push.

---

## 1. Перевести всё на английский

Все пользовательские строки, комментарии в коде, сообщения в логах, тексты ошибок и UI должны быть на английском. Затронутые файлы:

**meet-extension/** (здесь больше всего русского текста):
- [popup.html](meet-extension/popup.html) — все подписи, placeholder'ы, текст кнопок, текст саммари, напоминания (строки 12, 20, 23-24, 29, 32-33 и т.д.)
- [popup.js](meet-extension/popup.js) — статусные сообщения вроде `"пауза"`, `"подключение…"`, `"мост недоступен"`, `"слушаю встречу"`, `"диктовка…"`, `"укажите repo"`, подписи кнопок `"Слушать встречу"`, `"Перестать слушать"`, `"Остановить запись вопроса"`, `"Спросить у агента"` и т.д. (строки 98, 115, 119, 209, 211, 218, 228-229, 260, 267 и т.д.)
- [popup.css](meet-extension/popup.css) — русского не ожидается, но проверить комментарии
- [manifest.json](meet-extension/manifest.json) — поле `"description"` (строка 5)
- [background.js](meet-extension/background.js) — русские сообщения в логах или комментарии
- [capture.js](meet-extension/capture.js) — комментарии, сообщения в логах
- [dictation.js](meet-extension/dictation.js) — комментарии, сообщения в логах
- [audio-processor.js](meet-extension/audio-processor.js) — комментарии

**bridge/** (в основном уже на английском, проверить):
- [main.go](bridge/cmd/meet-bridge/main.go) — сообщения в логах на строках 213, 217, 220, 232-233 уже на английском; проверить все комментарии
- [agentrun.go](bridge/internal/agentrun/agentrun.go) — комментарий на строке 2 ссылается на `plan_meet.md` и `cli_cursor.md` — убрать эти внутренние ссылки на доки
- [whispersetup.go](bridge/internal/whispersetup/whispersetup.go) — проверить комментарии

**Корневые файлы:**
- [start.sh](start.sh) — все echo-сообщения на русском (строки 16, 21-22, 25-26, 29, 34-37, 42, 47-49, 69, 78, 82-83, 87, 97, 110-111, 115, 119-120, 128-138) — перевести всё
- [.env.example](.env.example) — комментарии на русском (строки 1-2, 10-21, 25-27) — перевести всё
- [whisper-server/requirements.txt](whisper-server/requirements.txt) — русский комментарий на строке 1, ссылка на `help/whisper.md` — перевести, убрать ссылку

---

## 2. Убрать MEET_BRIDGE_REPO из .env и start.sh

Путь к репозиторию всегда задаётся через UI расширения, поэтому убираем обязательное требование `MEET_BRIDGE_REPO`:

**[start.sh](start.sh):**
- Удалить строки 24-27 (обязательная проверка MEET_BRIDGE_REPO, которая завершает скрипт с ошибкой)
- Изменить строку 70 с `"$BRIDGE_BIN" serve -repo "$MEET_BRIDGE_REPO" &` на просто `"$BRIDGE_BIN" serve &`
- Удалить строку 132 (`echo "  Repository: $MEET_BRIDGE_REPO"`)

**[.env.example](.env.example):**
- Удалить строки 25-28 (секцию MEET_BRIDGE_REPO целиком)

**[bridge/cmd/meet-bridge/main.go](bridge/cmd/meet-bridge/main.go):**
- Менять не нужно — флаг `-repo` уже по умолчанию `""`, а `/session/start` требует `repo_path` из запроса. Флаг `-repo` в команде `serve` остаётся как опциональный fallback для `/agent/ask`.

---

## 3. Убрать скомпилированный бинарник из git

Файл `bridge/meet-bridge` — это Mach-O arm64 бинарник, он уже в `.gitignore`, но отслеживается git'ом. Поскольку это будет свежий репозиторий, просто не включаем его. Добавить явный комментарий в `.gitignore`:

```gitignore
# Скомпилированный Go-бинарник (собирается автоматически через start.sh)
bridge/meet-bridge
```

---

## 4. Добавить LICENSE (MIT)

Создать `LICENSE` в корне со стандартным текстом MIT, copyright 2026.

---

## 5. Объединить документацию: удалить whisper-server/README.md, исправить битые ссылки

- Удалить [whisper-server/README.md](whisper-server/README.md) — его содержимое переносится в корневой README
- Убрать ссылку на `help/whisper.md` из [whisper-server/requirements.txt](whisper-server/requirements.txt), строка 1
- Убрать ссылки на `plan_meet.md` и `cli_cursor.md` из [bridge/internal/agentrun/agentrun.go](bridge/internal/agentrun/agentrun.go), строка 2

---

## 6. Единообразно переименовать в MeetBridge

Текущая несогласованность: `meet_assist` (Go-модуль), `MeetBridge` (manifest), `AI_git_assist` (старый GitHub-репозиторий).

Изменения:
- [bridge/go.mod](bridge/go.mod) — сменить модуль с `meet_assist/bridge` на `meetbridge/bridge`
- [bridge/cmd/meet-bridge/main.go](bridge/cmd/meet-bridge/main.go) — обновить импорты с `meet_assist/bridge/internal/...` на `meetbridge/bridge/internal/...`
- [bridge/internal/agentrun/agentrun.go](bridge/internal/agentrun/agentrun.go) — имя пакета остаётся `agentrun` (без изменений)
- [meet-extension/manifest.json](meet-extension/manifest.json) — `"name"` уже `"MeetBridge"`, ок
- [start.sh](start.sh) — обновить баннер с `meet_assist` на `MeetBridge` (строка 129)
- Имя корневой папки на твоё усмотрение (`meetbridge/` или `meet-bridge/` при публикации)

---

## 7. Почистить .gitignore для свежего репозитория

Текущий [.gitignore](.gitignore) ссылается на папки из разработки, которых не будет в новом репо. Удалить:
- `Audio-Transcription/` (строка 43)
- `achrome-extension-web-transcriptor-ai/` (строка 44)
- `audio_recorder/` (строка 45)
- `extension-meet-bridge/` (строка 46)
- строку `help/` можно оставить (на случай локальных заметок)

---

## 8. Исправить захардкоженный placeholder-путь

[popup.html](meet-extension/popup.html), строка 33:
```
placeholder="Например: /Users/username/projects/my-repo"
```
Заменить на английский: `placeholder="e.g. /home/user/projects/my-repo"`

---

## 9. UX-улучшения для публичного релиза

**a) Напоминание об установке cli-config.json:**
Добавить проверку в [start.sh](start.sh) — предупреждать, если `~/.cursor/cli-config.json` не существует, и выводить инструкцию по копированию.

**b) Захардкоженные порты:**
Добавить блок комментариев в начале [popup.js](meet-extension/popup.js) с пояснением, что `BRIDGE_BASE_URL` и `WHISPER_WS_URL` должны совпадать с портами bridge/whisper-сервера.

---

## 10. README.md (последний шаг, после тестирования)

Как обсуждали, README — финальный шаг после тестирования на втором Mac. Структура:

1. **Что такое MeetBridge** — один абзац + схема архитектуры
2. **Как это работает** — пронумерованные шаги
3. **Требования** — Chrome/Chromium (Edge, Brave, Opera), Cursor CLI, Go 1.22+, Python 3.10+; опционально: GitHub CLI `gh`
4. **Совместимость с браузерами** — только Chrome и Chromium-based. Firefox не поддерживается (используются `chrome.tabCapture` + offscreen documents — API, специфичные для Chrome)
5. **Установка** — пошагово (clone, .env, start.sh, загрузка расширения, копирование cli-config.json)
6. **Первый запуск** — предупредить про pip install ~3-5 GB + скачивание модели. Оценка времени: 5-10 минут при первом запуске.
7. **Сравнение моделей Whisper** — таблица в README:

| Модель | Параметры | Размер на диске | RAM (CPU) | Скорость | Точность (WER) | Лучше всего для |
|--------|-----------|-----------------|-----------|----------|----------------|-----------------|
| tiny | 39M | ~75 MB | ~273 MB | 10x | ~12% | Тесты, слабые устройства |
| base | 74M | ~142 MB | ~388 MB | 7x | ~10% | Машины с малыми ресурсами |
| small | 244M | ~466 MB | ~852 MB | 4x | ~7% | **Рекомендуется для CPU** |
| medium | 769M | ~1.5 GB | ~2.1 GB | 2x | ~5% | Лучше точность, нужно больше RAM |
| large-v3 | 1550M | ~2.9 GB | ~3.9 GB | 1x | ~3.5% | Только GPU, лучшая точность |

8. **Безопасность** — хранение CURSOR_API_KEY, пошаговая инструкция по созданию fine-grained PAT на GitHub (со ссылкой на github.com/settings/tokens?type=beta), что остаётся локально
9. **Известные ограничения** — только Chrome, задержка whisper на CPU, нет стриминга, список моделей может устареть
10. **Лицензия** — MIT

---

## Файлы, которые НЕ попадут в новый публичный репозиторий

Убедиться, что они исключены:
- `help/` (все рабочие заметки)
- `Audio-Transcription/` (референсный проект)
- `achrome-extension-web-transcriptor-ai/` (референсный проект)
- `audio_recorder/` (референсный проект)
- `extension-meet-bridge/` (пустой/старый)
- `.env` (секреты)
- `bridge/meet-bridge` (скомпилированный бинарник)
- `whisper-server/.venv/` (8 GB)

---

## Порядок выполнения

Фазы идут последовательно — каждая опирается на предыдущую:

**Фаза A: Чистка кода (без изменения функциональности)**
1. Перевести весь русский текст на английский
2. Убрать ссылки на внутренние доки (`help/`, `plan_meet.md`, `cli_cursor.md`)
3. Исправить placeholder-путь в popup.html
4. Переименовать модуль в `meetbridge` + обновить импорты

**Фаза B: Упрощение конфигурации**
5. Убрать MEET_BRIDGE_REPO из .env.example и start.sh
6. Почистить .gitignore
7. Добавить проверку cli-config.json в start.sh

**Фаза C: Добавление файлов**
8. Добавить LICENSE (MIT)
9. Удалить whisper-server/README.md

**Фаза D: Тестирование на втором Mac**
10. Свежий clone, запуск start.sh, проверка что всё работает

**Фаза E: Документация**
11. Написать README.md (после того как Фаза D подтвердит, что всё работает)
