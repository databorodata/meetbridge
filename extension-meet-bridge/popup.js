const DEFAULTS = {
  bridgeUrl: "http://127.0.0.1:7337",
  bridgeToken: "",
  repoPath: "/Users/nikita/projects/trails/trails-server",
  whisperWsUrl: "ws://127.0.0.1:9090",
  whisperModel: "small",
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

async function loadState() {
  const state = await chrome.storage.local.get(DEFAULTS);
  $("bridgeUrl").value = state.bridgeUrl;
  $("bridgeToken").value = state.bridgeToken;
  $("repoPath").value = state.repoPath;
  $("whisperWsUrl").value = state.whisperWsUrl || DEFAULTS.whisperWsUrl;
  $("whisperModel").value = state.whisperModel || DEFAULTS.whisperModel;
  $("sessionId").textContent = state.sessionId || "—";
  $("model").value = state.model || "auto";
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
  const state = await chrome.storage.local.get(DEFAULTS);
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
  const partial = {
    bridgeUrl: $("bridgeUrl").value.trim() || DEFAULTS.bridgeUrl,
    bridgeToken: $("bridgeToken").value,
    repoPath: $("repoPath").value.trim(),
    whisperWsUrl: $("whisperWsUrl").value.trim() || DEFAULTS.whisperWsUrl,
    whisperModel: $("whisperModel").value,
    model: $("model").value,
  };
  await saveState(partial);
  setStatus("ok", "сохранено");
}

async function onStartSession() {
  setStatus("idle", "start...");
  const state = await chrome.storage.local.get(DEFAULTS);
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
  const state = await chrome.storage.local.get(DEFAULTS);
  const sessionId = (await chrome.storage.local.get(DEFAULTS)).sessionId;
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
  const meeting = $("meetingContext").value || "";
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

async function main() {
  await loadState();
  setStatus("idle", "готово");
  $("answer").textContent = "(пусто)";

  $("saveSettings").addEventListener("click", onSave);
  $("health").addEventListener("click", onHealth);
  $("startSession").addEventListener("click", onStartSession);
  $("ask").addEventListener("click", onAsk);
}

main().catch((e) => {
  setStatus("bad", "ошибка");
  $("answer").textContent = String(e?.message || e);
});

