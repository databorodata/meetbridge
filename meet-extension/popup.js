/** Локальные URL моста и WhisperLive (не показываются в UI). */
const BRIDGE_BASE_URL = "http://127.0.0.1:7337";
const WHISPER_WS_URL = "ws://127.0.0.1:9090";

const WORK_LOG_PREFIX = "[meet-assist:work]";

const DEFAULTS = {
  repoPath: "",
  whisperModel: "small",
  whisperLanguage: "",
  whisperUseVad: true,
  pauseMeetingWhileDictating: true,
  contextWindowMinutes: 3,
  sessionId: "",
  model: "auto",
};

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element: ${id}`);
  return el;
}

function workLog(step, detail) {
  const ts = new Date().toISOString();
  const line = `${WORK_LOG_PREFIX} ${ts} ${step}${detail != null ? ` ${detail}` : ""}`;
  console.log(line);
  chrome.runtime.sendMessage({ type: "POPUP_WORK_LOG", line }).catch(() => {});
}

function setStatus(kind, text) {
  const el = $("status");
  el.className = `status status--${kind}`;
  el.textContent = text;
}

async function buildPromptContextText() {
  const { meetTranscriptDeltas = [], contextWindowMinutes: storedMin } = await chrome.storage.local.get([
    "meetTranscriptDeltas",
    "contextWindowMinutes",
  ]);
  const raw =
    $("contextWindowMinutes")?.value ?? String(storedMin ?? DEFAULTS.contextWindowMinutes);
  const minutes = Number.parseFloat(String(raw));
  const m = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULTS.contextWindowMinutes;
  const ms = m * 60 * 1000;
  const cutoff = Date.now() - ms;
  return meetTranscriptDeltas
    .filter((d) => d.ts >= cutoff)
    .map((d) => d.text)
    .join("\n");
}

async function refreshMeetingContextFromTranscript() {
  const text = await buildPromptContextText();
  $("meetingContext").value = text;
}

function getBridgeBaseUrl() {
  return BRIDGE_BASE_URL;
}

async function getBridgeState() {
  const state = await chrome.storage.local.get(DEFAULTS);
  state.bridgeUrl = getBridgeBaseUrl();
  return state;
}

async function loadState() {
  const state = await chrome.storage.local.get(DEFAULTS);
  $("repoPath").value = state.repoPath;
  $("whisperModel").value = state.whisperModel || DEFAULTS.whisperModel;
  $("whisperLanguage").value = state.whisperLanguage ?? "";
  $("whisperUseVad").checked = state.whisperUseVad !== false;
  $("pauseMeetingWhileDictating").checked = state.pauseMeetingWhileDictating !== false;
  $("contextWindowMinutes").value = String(
    state.contextWindowMinutes ?? DEFAULTS.contextWindowMinutes
  );
  $("sessionId").textContent = state.sessionId || "—";
  $("model").value = state.model || "auto";

  const { dictationDraftText = "", questionDraftText = "" } = await chrome.storage.local.get([
    "dictationDraftText",
    "questionDraftText",
  ]);
  $("question").value = questionDraftText || dictationDraftText || "";

  await refreshMeetingContextFromTranscript();
  return state;
}

async function saveState(partial) {
  await chrome.storage.local.set(partial);
}

function buildHeaders() {
  return { "Content-Type": "application/json" };
}

async function httpJSON(path, body) {
  const url = new URL(path, getBridgeBaseUrl()).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`invalid JSON response (${res.status}): ${text.slice(0, 400)}`);
  }
  return { status: res.status, json, rawBody: text };
}

async function httpGET(path) {
  const url = new URL(path, getBridgeBaseUrl()).toString();
  const res = await fetch(url, { method: "GET", headers: buildHeaders() });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`invalid JSON response (${res.status}): ${text.slice(0, 400)}`);
  }
  return { status: res.status, json, rawBody: text };
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

async function persistAllFromInputs() {
  const ctxMin = Number.parseFloat($("contextWindowMinutes").value);
  await saveState({
    repoPath: $("repoPath").value.trim(),
    whisperModel: $("whisperModel").value,
    whisperLanguage: $("whisperLanguage").value.trim(),
    whisperUseVad: $("whisperUseVad").checked,
    pauseMeetingWhileDictating: $("pauseMeetingWhileDictating").checked,
    contextWindowMinutes:
      Number.isFinite(ctxMin) && ctxMin > 0 ? ctxMin : DEFAULTS.contextWindowMinutes,
    model: $("model").value,
  });
}

async function onSave() {
  await persistAllFromInputs();
  setStatus("ok", "сохранено");
}

function setupAutosaveSettings() {
  const ids = [
    "repoPath",
    "whisperModel",
    "whisperLanguage",
    "whisperUseVad",
    "pauseMeetingWhileDictating",
  ];
  for (const id of ids) {
    const el = $(id);
    el.addEventListener("change", () => {
      persistAllFromInputs().catch(() => {});
    });
  }
}

async function onStartWork() {
  setStatus("idle", "запуск…");
  $("answer").textContent = "";

  const repoPath = $("repoPath").value.trim();
  if (!repoPath) {
    workLog("error", "repo_path пуст — укажите в «Настройках»");
    setStatus("bad", "укажите repo в настройках");
    $("answer").textContent = "Откройте «Настройки» и укажите путь к git-репозиторию.";
    return;
  }

  await persistWhisperSettingsForCapture();

  try {
    workLog("health", `GET ${getBridgeBaseUrl()}/health`);
    const h = await httpGET("/health");
    if (h.status !== 200 || !h.json?.ok) {
      workLog("health_fail", `status=${h.status} ok=${h.json?.ok}`);
      setStatus("bad", "мост недоступен");
      $("answer").textContent = pretty(h.json) || h.rawBody?.slice(0, 500) || "ошибка";
      return;
    }
    workLog("health_ok", `v=${h.json?.version ?? "?"}`);

    const model = $("model").value || "auto";
    const whisperModel = $("whisperModel").value || "small";
    workLog("session_start", `POST /session/start repo=${repoPath.slice(0, 48)}…`);
    const { json, status } = await httpJSON("/session/start", {
      repo_path: repoPath,
      branch: "main",
      options: {
        model,
        timeout_seconds: 600,
        whisper_model: whisperModel,
        whisper_ws_url: WHISPER_WS_URL,
      },
    });
    if (status !== 200 || !json?.ok) {
      workLog("session_fail", `status=${status}`);
      setStatus("bad", "сессия не создана");
      $("answer").textContent = pretty(json);
      return;
    }
    await saveState({ sessionId: json.session_id });
    $("sessionId").textContent = json.session_id;
    workLog("session_ok", `session_id=${json.session_id}`);

    workLog("capture", "START_CAPTURE");
    const cap = await chrome.runtime.sendMessage({ type: "START_CAPTURE" });
    if (!cap?.ok) {
      workLog("capture_fail", cap?.error || "unknown");
      setStatus("bad", "захват не запущен");
      $("answer").textContent = cap?.error || "не удалось";
      return;
    }
    workLog("capture_ok", "ok");
    setStatus("ok", "работаем • захват включён");
    $("answer").textContent =
      "Смотрите закреплённую вкладку «захват». Вернитесь на вкладку встречи.";
  } catch (e) {
    workLog("error", String(e?.message || e));
    setStatus("bad", "ошибка");
    $("answer").textContent = String(e?.message || e);
  }
}

async function onAsk() {
  setStatus("idle", "отправляем…");
  const state = await getBridgeState();
  const sessionId = state.sessionId;
  const question = $("question").value.trim();
  if (!question) {
    setStatus("bad", "вопрос пуст");
    return;
  }
  if (!sessionId) {
    setStatus("bad", "нет session_id");
    $("answer").textContent = "Сначала нажмите «Начать работу» (создаётся сессия).";
    return;
  }

  const ctxMin = Number.parseFloat($("contextWindowMinutes").value);
  await saveState({
    contextWindowMinutes:
      Number.isFinite(ctxMin) && ctxMin > 0 ? ctxMin : DEFAULTS.contextWindowMinutes,
  });

  const meeting = await buildPromptContextText();
  $("meetingContext").value = meeting;

  const model = $("model").value || "auto";

  try {
    const { json } = await httpJSON("/agent/ask", {
      session_id: sessionId,
      meeting_context: meeting,
      question_prompt: question,
      options: { model, timeout_seconds: 600 },
    });
    if (!json?.ok) {
      setStatus("bad", "agent: ошибка");
      $("answer").textContent = pretty(json);
      return;
    }
    setStatus("ok", "готово");
    $("answer").textContent = json.agent?.stdout || "(пусто)";
  } catch (e) {
    setStatus("bad", "ошибка");
    $("answer").textContent = String(e?.message || e);
  }
}

async function persistWhisperSettingsForCapture() {
  const ctxMin = Number.parseFloat($("contextWindowMinutes").value);
  await chrome.storage.local.set({
    whisperWsUrl: WHISPER_WS_URL,
    whisperModel: $("whisperModel").value,
    whisperLanguage: $("whisperLanguage").value.trim(),
    whisperTask: "transcribe",
    whisperUseVad: $("whisperUseVad").checked,
    pauseMeetingWhileDictating: $("pauseMeetingWhileDictating").checked,
    contextWindowMinutes:
      Number.isFinite(ctxMin) && ctxMin > 0 ? ctxMin : DEFAULTS.contextWindowMinutes,
  });
}

async function onStartDictation() {
  setStatus("idle", "диктовка…");
  try {
    await persistWhisperSettingsForCapture();
    const res = await chrome.runtime.sendMessage({ type: "START_DICTATION" });
    if (res?.ok) {
      setStatus("ok", "диктовка");
    } else {
      setStatus("bad", "ошибка");
      $("answer").textContent = res?.error || "не удалось";
    }
  } catch (e) {
    setStatus("bad", "ошибка");
    $("answer").textContent = String(e?.message || e);
  }
}

async function onStopDictation() {
  setStatus("idle", "стоп…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "STOP_DICTATION" });
    if (res?.ok) {
      setStatus("ok", "готово");
      const { dictationDraftText = "" } = await chrome.storage.local.get("dictationDraftText");
      if (dictationDraftText) {
        $("question").value = dictationDraftText;
        await chrome.storage.local.set({ questionDraftText: dictationDraftText });
      }
    } else {
      setStatus("bad", "ошибка");
      $("answer").textContent = res?.error || "не удалось";
    }
  } catch (e) {
    setStatus("bad", "ошибка");
    $("answer").textContent = String(e?.message || e);
  }
}

async function onStopCapture() {
  setStatus("idle", "стоп…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    if (res?.ok) {
      setStatus("ok", "захват остановлен");
    } else {
      setStatus("bad", "ошибка");
      $("answer").textContent = res?.error || "не удалось";
    }
  } catch (e) {
    setStatus("bad", "ошибка");
    $("answer").textContent = String(e?.message || e);
  }
}

function setupStorageSync() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes.meetTranscriptDeltas) return;
    refreshMeetingContextFromTranscript().catch(() => {});
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes.dictationDraftText) return;
    const next = changes.dictationDraftText.newValue || "";
    (async () => {
      const s = await chrome.storage.local.get("dictating");
      if (!s.dictating) return;
      if (document.activeElement === $("question")) return;
      $("question").value = next;
      await chrome.storage.local.set({ questionDraftText: next });
    })().catch(() => {});
  });
}

async function main() {
  await loadState();
  setStatus("idle", "готово");
  $("answer").textContent = "(пусто)";

  $("btnStartWork").addEventListener("click", onStartWork);
  $("saveSettings").addEventListener("click", onSave);
  $("ask").addEventListener("click", onAsk);
  $("stopCapture").addEventListener("click", onStopCapture);
  $("startDictation").addEventListener("click", onStartDictation);
  $("stopDictation").addEventListener("click", onStopDictation);

  $("question").addEventListener("input", () => {
    chrome.storage.local.set({ questionDraftText: $("question").value }).catch(() => {});
  });

  $("contextWindowMinutes").addEventListener("change", () => {
    persistAllFromInputs()
      .then(() => refreshMeetingContextFromTranscript())
      .catch(() => {});
  });

  $("model").addEventListener("change", () => {
    persistAllFromInputs().catch(() => {});
  });

  setupAutosaveSettings();
  setupStorageSync();
}

main().catch((e) => {
  setStatus("bad", "ошибка");
  $("answer").textContent = String(e?.message || e);
});
