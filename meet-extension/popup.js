const DEFAULTS = {
  bridgeUrl: "http://127.0.0.1:7337",
  bridgeToken: "",
  repoPath: "",
  whisperWsUrl: "ws://127.0.0.1:9090",
  whisperModel: "small",
  whisperLanguage: "",
  whisperTask: "transcribe",
  whisperUseVad: true,
  contextWindowMinutes: 3,
  meetingContextAuto: true,
  sessionId: "",
  model: "auto",
};

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element: ${id}`);
  return el;
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

async function getBridgeState() {
  const state = await chrome.storage.local.get(DEFAULTS);
  state.bridgeUrl = $("bridgeUrl").value.trim() || state.bridgeUrl || DEFAULTS.bridgeUrl;
  state.bridgeToken = $("bridgeToken").value;
  return state;
}

async function loadState() {
  const state = await chrome.storage.local.get(DEFAULTS);
  $("bridgeUrl").value = state.bridgeUrl;
  $("bridgeToken").value = state.bridgeToken;
  $("repoPath").value = state.repoPath;
  $("whisperWsUrl").value = state.whisperWsUrl || DEFAULTS.whisperWsUrl;
  $("whisperModel").value = state.whisperModel || DEFAULTS.whisperModel;
  $("whisperLanguage").value = state.whisperLanguage ?? "";
  $("whisperTask").value = state.whisperTask || DEFAULTS.whisperTask;
  $("whisperUseVad").checked = state.whisperUseVad !== false;
  $("contextWindowMinutes").value = String(
    state.contextWindowMinutes ?? DEFAULTS.contextWindowMinutes
  );
  $("meetingContextAuto").checked = state.meetingContextAuto !== false;
  $("sessionId").textContent = state.sessionId || "—";
  $("model").value = state.model || "auto";

  if (state.meetingContextAuto !== false) {
    await refreshMeetingContextFromTranscript();
  }
  return state;
}

async function saveState(partial) {
  await chrome.storage.local.set(partial);
}

function buildHeaders(state) {
  const headers = { "Content-Type": "application/json" };
  if (state.bridgeToken && state.bridgeToken.trim() !== "") {
    headers["X-Bridge-Token"] = state.bridgeToken.trim();
  }
  return headers;
}

async function httpJSON(state, path, body) {
  const url = new URL(path, state.bridgeUrl).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(state),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`invalid JSON response (${res.status}): ${text}`);
  }
  return { status: res.status, json };
}

async function httpGET(state, path) {
  const url = new URL(path, state.bridgeUrl).toString();
  const res = await fetch(url, { method: "GET", headers: buildHeaders(state) });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`invalid JSON response (${res.status}): ${text}`);
  }
  return { status: res.status, json };
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

async function onHealth() {
  setStatus("idle", "проверяем...");
  const state = await getBridgeState();
  try {
    const { json } = await httpGET(state, "/health");
    if (json?.ok) {
      setStatus("ok", `ok • v${json.version}`);
      const w = json.whisper_live;
      $("sessionInfo").textContent = `Whisper TCP ${w?.reachable ? "ok" : "нет"} • ${w?.check_tcp || ""}`;
    } else {
      setStatus("bad", "ошибка");
      $("answer").textContent = pretty(json);
    }
  } catch (e) {
    setStatus("bad", "нет соединения");
    $("answer").textContent = String(e?.message || e);
  }
}

async function onSave() {
  const ctxMin = Number.parseFloat($("contextWindowMinutes").value);
  const partial = {
    bridgeUrl: $("bridgeUrl").value.trim() || DEFAULTS.bridgeUrl,
    bridgeToken: $("bridgeToken").value,
    repoPath: $("repoPath").value.trim(),
    whisperWsUrl: $("whisperWsUrl").value.trim() || DEFAULTS.whisperWsUrl,
    whisperModel: $("whisperModel").value,
    whisperLanguage: $("whisperLanguage").value.trim(),
    whisperTask: $("whisperTask").value,
    whisperUseVad: $("whisperUseVad").checked,
    contextWindowMinutes:
      Number.isFinite(ctxMin) && ctxMin > 0 ? ctxMin : DEFAULTS.contextWindowMinutes,
    meetingContextAuto: $("meetingContextAuto").checked,
    model: $("model").value,
  };
  await saveState(partial);
  setStatus("ok", "сохранено");
}

async function onStartSession() {
  setStatus("idle", "start...");
  const state = await getBridgeState();
  const repoPath = $("repoPath").value.trim();
  if (!repoPath) {
    setStatus("bad", "repo_path пуст");
    return;
  }
  try {
    const model = $("model").value || "auto";
    const whisperModel = $("whisperModel").value || "small";
    const whisperWsUrl = $("whisperWsUrl").value.trim() || DEFAULTS.whisperWsUrl;
    const { json } = await httpJSON(state, "/session/start", {
      repo_path: repoPath,
      branch: "main",
      options: {
        model,
        timeout_seconds: 600,
        whisper_model: whisperModel,
        whisper_ws_url: whisperWsUrl,
      },
    });
    if (!json?.ok) {
      setStatus("bad", "ошибка");
      $("answer").textContent = pretty(json);
      return;
    }
    await saveState({ sessionId: json.session_id });
    $("sessionId").textContent = json.session_id;
    $("sessionInfo").textContent = `head: ${json.git?.head || "—"} • agent: ${json.options?.model || model} • whisper: ${json.options?.whisper_model || whisperModel}`;
    setStatus("ok", "session ok");
  } catch (e) {
    setStatus("bad", "ошибка");
    $("answer").textContent = String(e?.message || e);
  }
}

async function onAsk() {
  setStatus("idle", "отправляем...");
  const state = await getBridgeState();
  const sessionId = state.sessionId;
  const question = $("question").value.trim();
  if (!question) {
    setStatus("bad", "question пуст");
    return;
  }
  if (!sessionId) {
    setStatus("bad", "нет session_id");
    $("answer").textContent = "Нажми Start session сначала.";
    return;
  }

  const ctxMin = Number.parseFloat($("contextWindowMinutes").value);
  await saveState({
    contextWindowMinutes:
      Number.isFinite(ctxMin) && ctxMin > 0 ? ctxMin : DEFAULTS.contextWindowMinutes,
  });

  let meeting = $("meetingContext").value || "";
  if ($("meetingContextAuto").checked) {
    meeting = await buildPromptContextText();
    $("meetingContext").value = meeting;
  }

  const model = $("model").value || "auto";

  try {
    const { json } = await httpJSON(state, "/agent/ask", {
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
    whisperWsUrl: $("whisperWsUrl").value.trim() || DEFAULTS.whisperWsUrl,
    whisperModel: $("whisperModel").value,
    whisperLanguage: $("whisperLanguage").value.trim(),
    whisperTask: $("whisperTask").value,
    whisperUseVad: $("whisperUseVad").checked,
    contextWindowMinutes:
      Number.isFinite(ctxMin) && ctxMin > 0 ? ctxMin : DEFAULTS.contextWindowMinutes,
  });
}

async function onStartCapture() {
  setStatus("idle", "захват…");
  try {
    await persistWhisperSettingsForCapture();
    const res = await chrome.runtime.sendMessage({ type: "START_CAPTURE" });
    if (res?.ok) {
      setStatus("ok", "захват");
      $("answer").textContent = "Смотрите закреплённую вкладку «захват». Вернитесь на вкладку встречи.";
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
      setStatus("ok", "готово");
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
    (async () => {
      const { meetingContextAuto = true } = await chrome.storage.local.get("meetingContextAuto");
      const auto = $("meetingContextAuto").checked && meetingContextAuto !== false;
      if (!auto) return;
      await refreshMeetingContextFromTranscript();
    })().catch(() => {});
  });
}

async function main() {
  await loadState();
  setStatus("idle", "готово");
  $("answer").textContent = "(пусто)";

  $("saveSettings").addEventListener("click", onSave);
  $("health").addEventListener("click", onHealth);
  $("startSession").addEventListener("click", onStartSession);
  $("ask").addEventListener("click", onAsk);
  $("startCapture").addEventListener("click", onStartCapture);
  $("stopCapture").addEventListener("click", onStopCapture);

  $("meetingContext").addEventListener("input", () => {
    $("meetingContextAuto").checked = false;
    saveState({ meetingContextAuto: false });
  });

  $("meetingContextAuto").addEventListener("change", () => {
    saveState({ meetingContextAuto: $("meetingContextAuto").checked });
    if ($("meetingContextAuto").checked) {
      refreshMeetingContextFromTranscript().catch(() => {});
    }
  });

  $("contextWindowMinutes").addEventListener("change", () => {
    const v = Number.parseFloat($("contextWindowMinutes").value);
    if (Number.isFinite(v) && v > 0) {
      saveState({ contextWindowMinutes: v });
      if ($("meetingContextAuto").checked) {
        refreshMeetingContextFromTranscript().catch(() => {});
      }
    }
  });

  setupStorageSync();
}

main().catch((e) => {
  setStatus("bad", "ошибка");
  $("answer").textContent = String(e?.message || e);
});
