/**
 * Capture active tab audio → WhisperLive WebSocket.
 * Adapted from Audio-Transcription/options.js (without on-page overlay).
 */

let cleanupDone = false;
let isServerReady = false;
let lastForwardedText = "";
let currentUuid = "";
let socketOpenHandled = false;

let socket = null;
let stream = null;
let audioContext = null;
let mediaStream = null;
let recorder = null;

function captureTabAudio() {
  return new Promise((resolve) => {
    try {
      chrome.tabCapture.capture({ audio: true, video: false }, (s) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(s || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/[ \t\r]+/g, " ").trim();
}

function resampleTo16kHZ(audioData, origSampleRate = 44100) {
  const data = new Float32Array(audioData);
  const targetLength = Math.round(data.length * (16000 / origSampleRate));
  if (targetLength <= 1 || data.length <= 1) {
    return new Float32Array(data);
  }
  const resampledData = new Float32Array(targetLength);
  const springFactor = (data.length - 1) / (targetLength - 1);
  resampledData[0] = data[0];
  resampledData[targetLength - 1] = data[data.length - 1];
  for (let i = 1; i < targetLength - 1; i++) {
    const index = i * springFactor;
    const leftIndex = Math.floor(index);
    const rightIndex = Math.ceil(index);
    const fraction = index - leftIndex;
    resampledData[i] =
      data[leftIndex] + (data[rightIndex] - data[leftIndex]) * fraction;
  }
  return resampledData;
}

function generateUUID() {
  let dt = new Date().getTime();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (dt + Math.random() * 16) % 16 | 0;
    dt = Math.floor(dt / 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
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

function forwardToBackground(rawPayload) {
  const text = extractTranscriptText(rawPayload);
  if (!text || text === lastForwardedText) return;
  lastForwardedText = text;
  try {
    chrome.runtime.sendMessage({
      type: "transcript-chunk",
      payload: typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload),
    });
  } catch {
    /* ignore */
  }
}

function closeSocketQuietly() {
  try {
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      socket.close(1000, "Client disconnected");
    }
  } catch {
    /* ignore */
  }
  socket = null;
}

function cleanupAudioResources() {
  try {
    if (recorder) {
      recorder.port.onmessage = null;
      recorder.disconnect();
    }
  } catch {
    /* ignore */
  }
  recorder = null;

  try {
    if (mediaStream) {
      mediaStream.disconnect();
    }
  } catch {
    /* ignore */
  }
  mediaStream = null;

  try {
    if (audioContext) {
      audioContext.close();
    }
  } catch {
    /* ignore */
  }
  audioContext = null;

  try {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
  } catch {
    /* ignore */
  }
  stream = null;
}

function cleanupAndClose() {
  if (cleanupDone) return;
  cleanupDone = true;
  closeSocketQuietly();
  cleanupAudioResources();
  isServerReady = false;
  lastForwardedText = "";
  currentUuid = "";
  try {
    chrome.runtime.sendMessage({ type: "capture-stopped" });
  } catch {
    /* ignore */
  }
}

async function startRecord(option) {
  cleanupDone = false;
  isServerReady = false;
  lastForwardedText = "";
  currentUuid = generateUUID();
  socketOpenHandled = false;

  const media = await captureTabAudio();
  if (!media) {
    cleanupAndClose();
    return;
  }
  stream = media;
  stream.oninactive = () => cleanupAndClose();

  let ws;
  try {
    ws = new WebSocket(`ws://${option.host}:${option.port}/`);
    socket = ws;
  } catch {
    cleanupAndClose();
    return;
  }

  ws.onopen = function () {
    socketOpenHandled = true;
    try {
      ws.send(
        JSON.stringify({
          uid: currentUuid,
          language: option.language,
          task: option.task,
          model: option.modelSize,
          use_vad: option.useVad,
        })
      );
    } catch {
      cleanupAndClose();
    }
  };

  ws.onerror = function () {
    cleanupAndClose();
  };

  ws.onclose = function () {
    if (!cleanupDone) {
      cleanupAndClose();
    }
  };

  ws.onmessage = async (event) => {
    if (cleanupDone) return;
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data.uid !== currentUuid) return;

    if (data.status === "WAIT") {
      cleanupAndClose();
      return;
    }
    if (data.message === "DISCONNECT") {
      cleanupAndClose();
      return;
    }

    const transcriptText = extractTranscriptText(data);
    if (!isServerReady) {
      isServerReady = true;
      if (!transcriptText) return;
    }
    if (!transcriptText) return;
    forwardToBackground(event.data);
  };

  const context = new AudioContext();
  audioContext = context;

  try {
    const processorUrl = chrome.runtime.getURL("audio-processor.js");
    await context.audioWorklet.addModule(processorUrl);
  } catch (e) {
    console.error("AudioWorklet load failed:", e);
    cleanupAndClose();
    return;
  }

  const src = context.createMediaStreamSource(media);
  const workletNode = new AudioWorkletNode(context, "audio-capture-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
  });
  mediaStream = src;
  recorder = workletNode;

  workletNode.port.onmessage = (event) => {
    if (cleanupDone || !context || !isServerReady) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      const inputData = event.data;
      const audioData16kHz = resampleTo16kHZ(inputData, context.sampleRate);
      socket.send(audioData16kHz);
    } catch {
      /* ignore */
    }
  };

  src.connect(workletNode);
  src.connect(context.destination);

  window.addEventListener("beforeunload", () => cleanupAndClose(), { once: true });
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.action) {
    return false;
  }
  const { type, data } = request || {};
  if (!type) {
    return false;
  }
  switch (type) {
    case "start_capture":
      startRecord(data);
      sendResponse({ success: true });
      return true;
    case "STOP":
      cleanupAndClose();
      sendResponse({ success: true });
      return true;
    default:
      return false;
  }
});
