/** Local bridge and WhisperLive URLs (not shown in UI). */
const BRIDGE_BASE_URL = "http://127.0.0.1:7337";
const WHISPER_WS_URL = "ws://127.0.0.1:9090";

const WORK_LOG_PREFIX = "[meet-bridge:work]";
const EMPTY_LABEL = "(empty)";

const DEFAULTS = {
  repoPath: "",
  whisperModel: "small",
  whisperLanguage: "en",
  contextWindowSeconds: 180,
  sessionId: "",
  model: "auto",
  modelCustom: "",
};

let isCapturing = false;
let isDictating = false;

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
  el.className = `status-bar status--${kind}`;
  el.textContent = text;
}

async function buildPromptContextText() {
  const { meetTranscriptDeltas = [], contextWindowSeconds: storedSec } = await chrome.storage.local.get([
    "meetTranscriptDeltas",
    "contextWindowSeconds",
  ]);
  const raw =
    $("contextWindowSeconds")?.value ?? String(storedSec ?? DEFAULTS.contextWindowSeconds);
  const seconds = Number.parseFloat(String(raw));
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULTS.contextWindowSeconds;
  const ms = s * 1000;
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

function getSelectedModel() {
  const val = $("model").value;
  if (val === "custom") {
    return $("modelCustom").value.trim() || "auto";
  }
  return val;
}

function updateSendButtonState() {
  $("btnSendToAgent").disabled = !$("question").value.trim();
}

async function loadState() {
  const state = await chrome.storage.local.get(DEFAULTS);
  $("repoPath").value = state.repoPath;
  $("whisperModel").value = state.whisperModel || DEFAULTS.whisperModel;
  $("whisperLanguage").value = state.whisperLanguage ?? "";
  $("contextWindowSeconds").value = String(
    state.contextWindowSeconds ?? DEFAULTS.contextWindowSeconds
  );
  $("model").value = state.model || "auto";
  $("modelCustom").value = state.modelCustom || "";
  
  // Show/hide custom model input
  const isCustom = $("model").value === "custom";
  $("modelCustom").classList.toggle("field__input--hidden", !isCustom);

  const { dictationDraftText = "", questionDraftText = "", lastAnswer = EMPTY_LABEL } = await chrome.storage.local.get([
    "dictationDraftText",
    "questionDraftText",
    "lastAnswer",
  ]);
  $("question").value = questionDraftText || dictationDraftText || "";
  $("answer").textContent = lastAnswer === "(пусто)" ? EMPTY_LABEL : lastAnswer;

  await refreshMeetingContextFromTranscript();

  updateSendButtonState();

  // Restore button state
  const { capturing = false, dictating = false } = await chrome.storage.local.get(["capturing", "dictating"]);
  isCapturing = capturing;
  isDictating = dictating;
  if (isCapturing) {
    $("btnCapture").textContent = "Stop listening";
    $("btnCapture").classList.add("btn--active");
  }
  if (isDictating) {
    $("btnDictation").textContent = "Stop recording question";
    $("btnDictation").classList.add("btn--active");
  }

  // Dismissable reminder
  const { reminderDismissed = false } = await chrome.storage.local.get("reminderDismissed");
  if (reminderDismissed) {
    $("reminder").style.display = "none";
  }

  updateSendButtonState();
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
  const ctxSec = Number.parseFloat($("contextWindowSeconds").value);
  await saveState({
    repoPath: $("repoPath").value.trim(),
    whisperModel: $("whisperModel").value,
    whisperLanguage: $("whisperLanguage").value.trim(),
    contextWindowSeconds:
      Number.isFinite(ctxSec) && ctxSec > 0 ? ctxSec : DEFAULTS.contextWindowSeconds,
    model: $("model").value,
    modelCustom: $("modelCustom").value.trim(),
  });
}

function setupAutosaveSettings() {
  const ids = [
    "repoPath",
    "whisperModel",
    "whisperLanguage",
  ];
  for (const id of ids) {
    const el = $(id);
    el.addEventListener("change", () => {
      persistAllFromInputs().catch(() => {});
    });
  }
}

async function onToggleCapture() {
  if (isCapturing) {
    // Stop capture (do NOT clear transcript!)
    const res = await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    if (res?.ok) {
      isCapturing = false;
      await saveState({ capturing: false });
      $("btnCapture").textContent = "Listen to meeting";
      $("btnCapture").classList.remove("btn--active");
      setStatus("ok", "paused");
    }
  } else {
    // Health + session first, then capture
    setStatus("idle", "connecting…");
    const repoPath = $("repoPath").value.trim();
    if (!repoPath) {
      setStatus("bad", "set repo in Settings");
      return;
    }
    await persistWhisperSettingsForCapture();

    try {
      workLog("health", `GET ${getBridgeBaseUrl()}/health`);
      const h = await httpGET("/health");
      if (h.status !== 200 || !h.json?.ok) {
        workLog("health_fail", `status=${h.status} ok=${h.json?.ok}`);
        setStatus("bad", "bridge unavailable");
        $("answer").textContent = "meet-bridge is not running. Run ./start.sh";
        return;
      }
      workLog("health_ok", `v=${h.json?.version ?? "?"}`);

      const model = getSelectedModel();
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
        setStatus("bad", "session not created");
        $("answer").textContent = pretty(json);
        return;
      }
      await saveState({ sessionId: json.session_id });
      workLog("session_ok", `session_id=${json.session_id}`);

      workLog("capture", "START_CAPTURE");
      const cap = await chrome.runtime.sendMessage({ type: "START_CAPTURE", preserveTranscript: true });
      if (!cap?.ok) {
        workLog("capture_fail", cap?.error || "unknown");
        setStatus("bad", cap?.error || "capture failed to start");
        return;
      }
      workLog("capture_ok", "ok");
      isCapturing = true;
      // Reset captureWasPaused: this is a fresh start (not a resume)
      await saveState({ capturing: true, captureWasPaused: false });
      $("btnCapture").textContent = "Stop listening";
      $("btnCapture").classList.add("btn--active");
      setStatus("ok", "listening to meeting");
    } catch (e) {
      workLog("error", String(e?.message || e));
      setStatus("bad", "error");
      $("answer").textContent = String(e?.message || e);
    }
  }
}

async function stopDictation() {
  if (!isDictating) return false;
  // Send stop, but reset UI and state regardless of response:
  // background may return ok:false if the dictation tab already closed,
  // but audio recording still stopped and text is in storage.
  await chrome.runtime.sendMessage({ type: "STOP_DICTATION" }).catch(() => {});
  isDictating = false;
  await saveState({ dictating: false });
  $("btnDictation").textContent = "Ask the agent";
  $("btnDictation").classList.remove("btn--active");
  // Brief pause so the last chunk can be written to storage
  await new Promise((r) => setTimeout(r, 400));
  const { dictationDraftText = "" } = await chrome.storage.local.get("dictationDraftText");
  if (dictationDraftText) {
    $("question").value = dictationDraftText;
    await saveState({ questionDraftText: dictationDraftText });
  }
  updateSendButtonState();
  return true;
}

async function onToggleDictation() {
  if (isDictating) {
    const stopped = await stopDictation();
    if (stopped) setStatus("ok", "question recorded");
  } else {
    await persistWhisperSettingsForCapture();
    const res = await chrome.runtime.sendMessage({ type: "START_DICTATION" });
    if (res?.ok) {
      isDictating = true;
      await saveState({ dictating: true });
      $("btnDictation").textContent = "Stop recording question";
      $("btnDictation").classList.add("btn--active");
      setStatus("ok", "dictating…");
    } else {
      setStatus("bad", res?.error || "error");
    }
  }
}

async function onSendToAgent() {
  if (isDictating) {
    await stopDictation();
  }

  // Disable button while request is in flight — prevents duplicates
  const sendBtn = $("btnSendToAgent");
  sendBtn.disabled = true;
  sendBtn.textContent = "Waiting for answer…";

  setStatus("idle", "sending…");
  const state = await getBridgeState();
  const sessionId = state.sessionId;
  const question = $("question").value.trim();
  if (!question) {
    setStatus("bad", "question is empty");
    sendBtn.textContent = "Send to agent";
    updateSendButtonState();
    return;
  }
  if (!sessionId) {
    setStatus("bad", "no session_id");
    $("answer").textContent = 'Click "Listen to meeting" first (creates a session).';
    sendBtn.textContent = "Send to agent";
    updateSendButtonState();
    return;
  }

  const ctxSec = Number.parseFloat($("contextWindowSeconds").value);
  await saveState({
    contextWindowSeconds:
      Number.isFinite(ctxSec) && ctxSec > 0 ? ctxSec : DEFAULTS.contextWindowSeconds,
  });

  const meeting = await buildPromptContextText();
  $("meetingContext").value = meeting;

  const model = getSelectedModel();

  try {
    const { json } = await httpJSON("/agent/ask", {
      session_id: sessionId,
      meeting_context: meeting,
      question_prompt: question,
      options: { model, timeout_seconds: 600 },
    });
    if (!json?.ok) {
      setStatus("bad", "agent: error");
      $("answer").textContent = pretty(json);
      return;
    }
    setStatus("ok", "ready");
    const answerText = json.agent?.stdout || EMPTY_LABEL;
    $("answer").textContent = answerText;
    await chrome.storage.local.set({ lastAnswer: answerText, reminderDismissed: false });
    // Show reminder again — user can change repo before the next question
    $("reminder").style.display = "";
  } catch (e) {
    setStatus("bad", "error");
    $("answer").textContent = String(e?.message || e);
  } finally {
    sendBtn.textContent = "Send to agent";
    updateSendButtonState();
  }
}

async function persistWhisperSettingsForCapture() {
  const ctxSec = Number.parseFloat($("contextWindowSeconds").value);
  await chrome.storage.local.set({
    whisperWsUrl: WHISPER_WS_URL,
    whisperModel: $("whisperModel").value,
    whisperLanguage: $("whisperLanguage").value.trim(),
    whisperTask: "transcribe",
    whisperUseVad: true,
    pauseMeetingWhileDictating: true,
    contextWindowSeconds:
      Number.isFinite(ctxSec) && ctxSec > 0 ? ctxSec : DEFAULTS.contextWindowSeconds,
  });
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
    if (!isDictating) return;
    const next = changes.dictationDraftText.newValue || "";
    if (document.activeElement === $("question")) return;
    $("question").value = next;
    chrome.storage.local.set({ questionDraftText: next }).catch(() => {});
    updateSendButtonState();
  });
}

async function main() {
  await loadState();
  setStatus("idle", "ready");

  $("btnCapture").addEventListener("click", onToggleCapture);
  $("btnDictation").addEventListener("click", onToggleDictation);
  $("btnSendToAgent").addEventListener("click", onSendToAgent);

  $("dismissReminder").addEventListener("click", () => {
    $("reminder").style.display = "none";
    chrome.storage.local.set({ reminderDismissed: true });
  });

  $("clearMeeting").addEventListener("click", async () => {
    $("meetingContext").value = "";
    await chrome.storage.local.set({ meetTranscriptDeltas: [] });
  });

  $("copyMeeting").addEventListener("click", () => {
    const text = $("meetingContext").value.trim();
    if (text) navigator.clipboard.writeText(text).catch(() => {});
  });

  $("clearQuestion").addEventListener("click", async () => {
    $("question").value = "";
    await chrome.storage.local.set({ questionDraftText: "", dictationDraftText: "" });
    updateSendButtonState();
  });

  $("copyQuestion").addEventListener("click", () => {
    const text = $("question").value.trim();
    if (text) navigator.clipboard.writeText(text).catch(() => {});
  });

  $("clearAnswer").addEventListener("click", async () => {
    $("answer").textContent = EMPTY_LABEL;
    await chrome.storage.local.set({ lastAnswer: EMPTY_LABEL });
  });

  $("copyAnswer").addEventListener("click", () => {
    const text = $("answer").textContent.trim();
    if (text && text !== EMPTY_LABEL) navigator.clipboard.writeText(text).catch(() => {});
  });

  $("question").addEventListener("input", () => {
    chrome.storage.local.set({ questionDraftText: $("question").value }).catch(() => {});
    updateSendButtonState();
  });

  $("contextWindowSeconds").addEventListener("change", () => {
    persistAllFromInputs()
      .then(() => refreshMeetingContextFromTranscript())
      .catch(() => {});
  });

  $("model").addEventListener("change", () => {
    const isCustom = $("model").value === "custom";
    $("modelCustom").classList.toggle("field__input--hidden", !isCustom);
    persistAllFromInputs().catch(() => {});
  });

  $("modelCustom").addEventListener("change", () => {
    persistAllFromInputs().catch(() => {});
  });

  $("btnReset").addEventListener("click", async () => {
    if (!confirm("Reset everything? Transcript, question, and answer will be cleared.")) return;

    // Stop all active processes
    if (isCapturing) {
      await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
      isCapturing = false;
    }
    if (isDictating) {
      await chrome.runtime.sendMessage({ type: "STOP_DICTATION" }).catch(() => {});
      isDictating = false;
    }

    // Clear storage
    await chrome.storage.local.set({
      meetTranscriptDeltas: [],
      meetTranscriptPrev: "",
      dictationDraftText: "",
      dictationTranscriptDeltas: [],
      dictationTranscriptPrev: "",
      questionDraftText: "",
      lastAnswer: EMPTY_LABEL,
      capturing: false,
      dictating: false,
      captureWasPaused: false,
      reminderDismissed: false,
      sessionId: "",
    });

    // Reset UI
    $("meetingContext").value = "";
    $("question").value = "";
    $("answer").textContent = EMPTY_LABEL;
    $("btnCapture").textContent = "Listen to meeting";
    $("btnCapture").classList.remove("btn--active");
    $("btnDictation").textContent = "Ask the agent";
    $("btnDictation").classList.remove("btn--active");
    $("reminder").style.display = "";
    updateSendButtonState();
    setStatus("idle", "ready");
  });

  setupAutosaveSettings();
  setupStorageSync();
}

main().catch((e) => {
  setStatus("bad", "error");
  $("answer").textContent = String(e?.message || e);
});
