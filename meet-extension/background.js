/**
 * Сервис-воркер: вкладка capture, приём транскрипта, буфер дельт для окна контекста.
 */

let captureTabId = null;

function normalizeWhitespace(text) {
  return String(text || "").replace(/[ \t\r]+/g, " ").trim();
}

function extractTranscriptText(payload) {
  let data = payload;
  try {
    if (typeof payload === "string") {
      data = JSON.parse(payload);
    }
  } catch {
    return "";
  }
  if (Array.isArray(data?.segments)) {
    return normalizeWhitespace(
      data.segments.map((seg) => (typeof seg?.text === "string" ? seg.text : "")).join("\n")
    );
  }
  if (typeof data?.text === "string") {
    return normalizeWhitespace(data.text);
  }
  return "";
}

function parseWsUrl(wsUrl) {
  const u = new URL(wsUrl);
  const port = u.port || (u.protocol === "wss:" ? "443" : "80");
  return { host: u.hostname, port: String(port) };
}

async function clearTranscriptBuffer() {
  await chrome.storage.local.set({
    meetTranscriptPrev: "",
    meetTranscriptDeltas: [],
  });
}

async function appendTranscriptDelta(rawPayload) {
  const text = extractTranscriptText(rawPayload);
  if (!text) return;

  const { meetTranscriptPrev = "", meetTranscriptDeltas = [] } = await chrome.storage.local.get([
    "meetTranscriptPrev",
    "meetTranscriptDeltas",
  ]);

  let delta = text;
  if (meetTranscriptPrev && text.startsWith(meetTranscriptPrev)) {
    delta = text.slice(meetTranscriptPrev.length);
  }

  await chrome.storage.local.set({ meetTranscriptPrev: text });

  const trimmed = delta.trim();
  if (!trimmed) return;

  const next = meetTranscriptDeltas.concat([{ ts: Date.now(), text: trimmed }]);
  while (next.length > 20000) {
    next.shift();
  }
  await chrome.storage.local.set({ meetTranscriptDeltas: next });
}

async function ensureCaptureTab() {
  if (captureTabId != null) {
    try {
      await chrome.tabs.get(captureTabId);
      return captureTabId;
    } catch {
      captureTabId = null;
    }
  }

  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL("capture.html"),
    active: false,
    pinned: true,
  });
  captureTabId = tab.id;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("timeout waiting for capture tab"));
    }, 15000);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId === tab.id && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        setTimeout(resolve, 300);
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });

  return tab.id;
}

async function sendToCaptureTab(tabId, message) {
  const max = 8;
  let lastErr = "";
  for (let i = 0; i < max; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return;
    } catch (e) {
      lastErr = String(e?.message || e);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(lastErr || "capture tab не отвечает");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "transcript-chunk") {
    appendTranscriptDelta(msg.payload).catch(() => {});
    return false;
  }

  if (msg?.type === "capture-stopped") {
    chrome.storage.local.set({ capturing: false }).catch(() => {});
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
    return false;
  }

  if (msg?.type === "START_CAPTURE") {
    (async () => {
      try {
        await clearTranscriptBuffer();
        await chrome.storage.local.set({
          capturing: true,
          meetingContextUserLock: false,
        });
        chrome.action.setBadgeBackgroundColor({ color: "#2d7a4d" });
        chrome.action.setBadgeText({ text: "●" });

        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!active?.id) {
          sendResponse({ ok: false, error: "Нет активной вкладки — выберите вкладку с встречей." });
          return;
        }

        const meetTabId = active.id;

        const s = await chrome.storage.local.get([
          "whisperWsUrl",
          "whisperModel",
          "whisperLanguage",
          "whisperTask",
          "whisperUseVad",
        ]);
        const wsUrl = (s.whisperWsUrl || "ws://127.0.0.1:9090").trim();
        const { host, port } = parseWsUrl(wsUrl);

        const tabId = await ensureCaptureTab();

        await chrome.tabs.update(meetTabId, { active: true });
        await new Promise((r) => setTimeout(r, 150));

        const lang = (s.whisperLanguage || "").trim();
        await sendToCaptureTab(tabId, {
          type: "start_capture",
          data: {
            currentTabId: meetTabId,
            host,
            port,
            language: lang || null,
            task: s.whisperTask || "transcribe",
            modelSize: s.whisperModel || "small",
            useVad: s.whisperUseVad !== false,
          },
        });
        sendResponse({ ok: true });
      } catch (e) {
        await chrome.storage.local.set({ capturing: false });
        chrome.action.setBadgeText({ text: "" }).catch(() => {});
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg?.type === "STOP_CAPTURE") {
    (async () => {
      try {
        if (captureTabId != null) {
          try {
            await chrome.tabs.sendMessage(captureTabId, { type: "STOP" });
          } catch {
            /* ignore */
          }
        }
        await chrome.storage.local.set({ capturing: false });
        chrome.action.setBadgeText({ text: "" });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  return false;
});
