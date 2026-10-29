"use strict";

(() => {

const $ = id => document.getElementById(id);

const FRAME_VIDEO = 1;
const FRAME_AUDIO = 2;

const MAX_BUFFER = 1024 * 1024;

/* ========================================
   v27.3 音声同期設定
======================================== */

const AUDIO_TIMESLICE = 100;

// バッファ先端との差がこの値を超えたら補正
const AUDIO_MAX_LATENCY = 0.5;

// 補正後に残すバッファ
const AUDIO_TARGET_LATENCY = 0.18;

// 初回再生時の目標バッファ
const AUDIO_START_LATENCY = 0.18;

// 連続補正防止
const AUDIO_CORRECTION_INTERVAL = 1000;

// 再生開始直後の猶予
const AUDIO_START_GRACE = 300;

// 古い音声データの保持時間
const AUDIO_KEEP_BEHIND = 5;

// 受信待ちキュー上限
const AUDIO_QUEUE_LIMIT = 2 * 1024 * 1024;

// 古いバッファを削除する間隔
const AUDIO_CLEANUP_INTERVAL = 3000;

let audioLatency = 0;
let audioCorrections = 0;

let audioLastCorrection = 0;
let audioLastCleanup = 0;

let audioChunksSent = 0;
let audioChunksReceived = 0;

let audioLastReceiveTime = 0;

let audioSyncTimer = null;

let audioStartPending = false;
let audioStartTime = 0;

let audioCleanupRunning = false;

/* ========================================
   WebSocket
======================================== */

let ws = null;
let reconnectTimer = null;

let role = null;
let currentRoom = null;

let localStream = null;
let appliedSettings = null;

let senderStarting = false;
let settingsApplying = false;

let activeRooms = [];

/* ========================================
   映像送信
======================================== */

let worker = null;
let workerReady = false;
let workerBusy = false;
let workerMode = false;

let processor = null;
let processorReader = null;
let processorRunning = false;

let captureVideo = null;
let captureCanvas = null;
let captureContext = null;

let captureTimer = null;
let captureBusy = false;

let captureToken = 0;
let lastEncodeTime = 0;

/* ========================================
   音声
======================================== */

let audioRecorder = null;
let audioMime = "";

let audioMonitoring = false;

let audioInitialSettings = [];
let audioCurrentSettings = [];

let mediaSource = null;
let sourceBuffer = null;
let audioQueue = [];

let audioObjectURL = null;
let audioGeneration = 0;
let audioStarted = false;

let pendingAudioBytes = 0;

/* ========================================
   統計
======================================== */

let sentFrames = 0;
let sentVideoBytes = 0;
let sentAudioBytes = 0;
let skippedFrames = 0;

let receivedFrames = 0;
let receivedVideoBytes = 0;
let receivedAudioBytes = 0;

let senderHistory = {};
let receiverHistory = {};

let lastFrameAt = 0;

/* ========================================
   映像受信
======================================== */

let pendingBlob = null;
let decoding = false;
let receiverToken = 0;

const remoteCanvas = $("remoteCanvas");

const remoteContext = remoteCanvas.getContext(
  "2d",
  { alpha: false }
);

/* ========================================
   共通
======================================== */

function status(message) {
  $("status").textContent = message;
}

function signal(data) {
  if (ws?.readyState !== WebSocket.OPEN) {
    return false;
  }

  ws.send(JSON.stringify(data));
  return true;
}

function updateButtons() {
  const sending = role === "sender";
  const receiving = role === "receiver";

  $("sendButton").disabled =
    sending || receiving || senderStarting;

  $("stopButton").disabled = !sending;

  $("receiveButton").disabled =
    sending || receiving || senderStarting;

  $("leaveButton").disabled = !receiving;

  $("applyButton").disabled =
    !sending || settingsApplying;

  $("roomId").disabled =
    sending || receiving || senderStarting;

  $("audioShare").disabled = sending;

  const hasAudio =
    localStream?.getAudioTracks().length > 0;

  if ($("audioMonitorButton")) {
    $("audioMonitorButton").disabled = !hasAudio;
  }

  if ($("audioProcessingButton")) {
    $("audioProcessingButton").disabled = !hasAudio;
  }
}

function readSettings() {
  return {
    resolution: $("resolution").value,
    fps: Number($("fps").value),
    jpegQuality: Number($("jpegQuality").value),
    preview: $("preview").checked,
    audio: $("audioShare").checked
  };
}

function targetSize(settings) {
  if (settings.resolution === "native") {
    return null;
  }

  const height = Number(settings.resolution);

  return {
    width: Math.round(height * 16 / 9),
    height
  };
}

function initialConstraints(settings) {
  const video = {
    frameRate: { ideal: settings.fps }
  };

  const size = targetSize(settings);

  if (size) {
    video.width = { ideal: size.width };
    video.height = { ideal: size.height };
  }

  return video;
}

function currentCaptureSize() {
  return localStream
    ?.getVideoTracks()[0]
    ?.getSettings() || null;
}

function outputSize() {
  const actual = currentCaptureSize();

  if (
    !actual?.width ||
    !actual?.height ||
    !appliedSettings
  ) {
    return null;
  }

  const target = targetSize(appliedSettings);

  if (!target) {
    return {
      width: actual.width,
      height: actual.height
    };
  }

  const scale = Math.min(
    1,
    target.width / actual.width,
    target.height / actual.height
  );

  return {
    width: Math.max(
      1,
      Math.round(actual.width * scale)
    ),
    height: Math.max(
      1,
      Math.round(actual.height * scale)
    )
  };
}

/* ========================================
   音声診断互換
======================================== */

function audioSettingsText(settings) {
  if (!settings) return "取得できません";

  const value = key =>
    settings[key] === undefined
      ? "情報なし"
      : String(settings[key]);

  return [
    `エコーキャンセル: ${value("echoCancellation")}`,
    `ノイズ抑制: ${value("noiseSuppression")}`,
    `自動音量調整: ${value("autoGainControl")}`,
    `チャンネル数: ${value("channelCount")}`,
    `サンプルレート: ${value("sampleRate")}`
  ].join("\n");
}

function updateAudioDiagnostics() {
  const element = $("audioDiagnostics");

  if (!element) return;

  const tracks = localStream?.getAudioTracks() || [];

  if (!tracks.length) {
    element.textContent = "音声トラックなし";
    updateButtons();
    return;
  }

  audioCurrentSettings =
    tracks.map(track => track.getSettings());

  element.textContent =
`========== WebSocket音声診断 ==========

取得トラック数: ${tracks.length}

【取得直後】
${audioInitialSettings.map(audioSettingsText).join("\n\n")}

【現在】
${audioCurrentSettings.map(audioSettingsText).join("\n\n")}

音声コーデック:
${audioMime || "未開始"}

試聴:
${audioMonitoring ? "ON" : "OFF"}`;

  updateButtons();
}

async function disableAudioProcessing() {
  if (!localStream) return;

  for (const track of localStream.getAudioTracks()) {
    const capabilities = track.getCapabilities?.() || {};
    const constraints = {};

    for (const key of [
      "echoCancellation",
      "noiseSuppression",
      "autoGainControl"
    ]) {
      if (key in capabilities) {
        constraints[key] = false;
      }
    }

    if (!Object.keys(constraints).length) {
      continue;
    }

    try {
      await track.applyConstraints(constraints);
    } catch (error) {
      console.warn("Audio constraints:", error);
    }
  }

  updateAudioDiagnostics();

  status("音声処理OFFを要求しました");
}

function stopAudioMonitor() {
  const audio = $("audioMonitor");

  if (!audio) return;

  audio.pause();
  audio.srcObject = null;

  audioMonitoring = false;

  const button = $("audioMonitorButton");

  if (button) {
    button.textContent = "🎧 取得音声を試聴";
  }
}

async function toggleAudioMonitor() {
  if (audioMonitoring) {
    stopAudioMonitor();
    updateAudioDiagnostics();
    return;
  }

  const tracks = localStream?.getAudioTracks() || [];

  if (!tracks.length) return;

  const audio = $("audioMonitor");

  if (!audio) return;

  audio.srcObject = new MediaStream(tracks);
  audio.volume = 1;
  audio.muted = false;

  try {
    await audio.play();

    audioMonitoring = true;

    $("audioMonitorButton").textContent =
      "■ 試聴停止";

  } catch (error) {
    status(`試聴エラー: ${error.message}`);
  }

  updateAudioDiagnostics();
}

/* ========================================
   WebSocket
======================================== */

function connect() {
  if (
    ws &&
    (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    )
  ) {
    return;
  }

  const protocol =
    location.protocol === "https:" ? "wss:" : "ws:";

  const socket = new WebSocket(
    `${protocol}//${location.host}/video`
  );

  socket.binaryType = "arraybuffer";
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;

    status("✅ WebSocket接続完了");
  };

  socket.onmessage = event => {
    if (ws !== socket) return;

    if (event.data instanceof ArrayBuffer) {
      handleBinary(event.data);
      return;
    }

    try {
      handleMessage(JSON.parse(event.data));
    } catch (error) {
      console.warn("Message:", error);
    }
  };

  socket.onclose = () => {
    if (ws !== socket) return;

    ws = null;

    stopSender(false);
    stopReceiver(false);

    status("WebSocket切断。3秒後に再接続します");

    clearTimeout(reconnectTimer);

    reconnectTimer = setTimeout(connect, 3000);
  };

  socket.onerror = () => {
    if (ws !== socket) return;

    status("WebSocket通信エラー");
  };
}

function sendBinary(kind, buffer) {
  if (ws?.readyState !== WebSocket.OPEN) {
    return false;
  }

  const payload = new Uint8Array(
    buffer.byteLength + 1
  );

  payload[0] = kind;
  payload.set(new Uint8Array(buffer), 1);

  ws.send(payload);

  return true;
}

/* ========================================
   キャプチャ設定
======================================== */

async function applyCaptureSettings(settings) {
  const track = localStream?.getVideoTracks()[0];

  if (!track) return;

  const constraints = {
    frameRate: { ideal: settings.fps }
  };

  const size = targetSize(settings);

  if (size) {
    constraints.width = { ideal: size.width };
    constraints.height = { ideal: size.height };

  } else {
    const capabilities = track.getCapabilities?.();

    const width = capabilities?.width?.max;
    const height = capabilities?.height?.max;

    if (
      Number.isFinite(width) &&
      Number.isFinite(height)
    ) {
      constraints.width = { ideal: width };
      constraints.height = { ideal: height };
    }
  }

  try {
    await track.applyConstraints(constraints);
  } catch (error) {
    console.warn("Capture:", error);
  }

  updateCaptureInfo();
}

function updateCaptureInfo() {
  const actual = currentCaptureSize();

  if (!actual || !appliedSettings) {
    $("captureInfo").textContent =
      "画面共有を開始すると情報を表示します。";
    return;
  }

  const size = outputSize();

  $("captureInfo").textContent =
`========== WebSocketキャプチャ ==========

解像度:
${actual.width}×${actual.height}

設定FPS:
${actual.frameRate ?? "?"}

========== JPEG配信 ==========

送信解像度:
${size?.width ?? "?"}×${size?.height ?? "?"}

目標FPS:
${appliedSettings.fps}

JPEG品質:
${appliedSettings.jpegQuality}

処理方式:
${workerMode ? "VideoFrame + Worker" : "Canvas互換モード"}

音声トラック:
${localStream.getAudioTracks().length}

※実際の送信FPSは統計で確認できます。`;
}

function updatePreview() {
  const enabled = $("preview").checked;

  $("localVideo").style.display =
    enabled ? "block" : "none";

  $("localVideo").srcObject =
    enabled ? localStream : null;
}

/* ========================================
   Worker
======================================== */

async function startWorkerCapture() {
  if (
    typeof Worker === "undefined" ||
    typeof MediaStreamTrackProcessor === "undefined" ||
    typeof OffscreenCanvas === "undefined"
  ) {
    return false;
  }

  const track = localStream?.getVideoTracks()[0];

  if (!track) return false;

  try {
    worker = new Worker("/websocket-worker.js");

    workerReady = false;
    workerBusy = false;

    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Worker起動タイムアウト"));
      }, 3000);

      worker.onmessage = event => {
        const data = event.data;

        if (data.type === "ready") {
          clearTimeout(timeout);
          workerReady = true;
          resolve();
          return;
        }

        if (data.type === "frame") {
          workerBusy = false;

          if (
            role !== "sender" ||
            !workerMode
          ) {
            return;
          }

          if (
            ws?.readyState !== WebSocket.OPEN ||
            ws.bufferedAmount > MAX_BUFFER
          ) {
            skippedFrames++;
            return;
          }

          if (sendBinary(FRAME_VIDEO, data.buffer)) {
            sentFrames++;
            sentVideoBytes += data.buffer.byteLength;
          }

          return;
        }

        if (
          data.type === "skipped" ||
          data.type === "error"
        ) {
          workerBusy = false;
          skippedFrames++;

          if (data.type === "error") {
            console.warn("Worker:", data.message);
          }
        }
      };

      worker.onerror = error => {
        clearTimeout(timeout);
        reject(error);
      };
    });

    await ready;

    worker.postMessage({
      type: "settings",
      settings: {
        resolution: appliedSettings.resolution,
        jpegQuality: appliedSettings.jpegQuality
      }
    });

    processor = new MediaStreamTrackProcessor({ track });
    processorReader = processor.readable.getReader();

    processorRunning = true;
    workerMode = true;

    lastEncodeTime = 0;

    processVideoFrames();

    return true;

  } catch (error) {
    console.warn("Worker利用不可:", error);

    await stopWorkerCapture();

    return false;
  }
}

async function processVideoFrames() {
  const reader = processorReader;

  if (!reader) return;

  try {
    while (
      processorRunning &&
      reader === processorReader
    ) {
      const result = await reader.read();

      if (result.done) break;

      const frame = result.value;

      if (
        !processorRunning ||
        role !== "sender" ||
        !workerMode
      ) {
        frame.close();
        continue;
      }

      const now = performance.now();
      const interval = 1000 / appliedSettings.fps;

      if (
        now - lastEncodeTime < interval ||
        workerBusy ||
        ws?.readyState !== WebSocket.OPEN ||
        ws.bufferedAmount > MAX_BUFFER
      ) {
        frame.close();
        skippedFrames++;
        continue;
      }

      lastEncodeTime = now;
      workerBusy = true;

      try {
        worker.postMessage({
          type: "frame",
          frame
        }, [frame]);

      } catch (error) {
        workerBusy = false;
        skippedFrames++;

        frame.close();

        console.warn("VideoFrame:", error);
      }
    }

  } catch (error) {
    if (processorRunning) {
      console.warn("Processor:", error);

      await stopWorkerCapture();

      if (role === "sender" && localStream) {
        try {
          await startCanvasCapture();
          updateCaptureInfo();

        } catch (fallbackError) {
          status(
            `映像処理エラー: ${fallbackError.message}`
          );
        }
      }
    }
  }
}

async function stopWorkerCapture() {
  processorRunning = false;

  const reader = processorReader;

  processorReader = null;
  processor = null;

  if (reader) {
    try {
      await reader.cancel();
    } catch {}

    try {
      reader.releaseLock();
    } catch {}
  }

  if (worker) {
    worker.terminate();
    worker = null;
  }

  workerReady = false;
  workerBusy = false;
  workerMode = false;
}

/* ========================================
   Canvas互換
======================================== */

function stopCanvasCapture() {
  captureToken++;

  if (captureTimer !== null) {
    clearInterval(captureTimer);
    captureTimer = null;
  }

  captureBusy = false;

  if (captureVideo) {
    captureVideo.pause();
    captureVideo.srcObject = null;
    captureVideo.remove();
    captureVideo = null;
  }

  captureCanvas = null;
  captureContext = null;
}

async function captureCanvasFrame(token) {
  if (
    token !== captureToken ||
    captureBusy ||
    role !== "sender" ||
    !localStream ||
    ws?.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  if (ws.bufferedAmount > MAX_BUFFER) {
    skippedFrames++;
    return;
  }

  if (
    !captureVideo ||
    captureVideo.readyState <
      HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    return;
  }

  captureBusy = true;

  try {
    const size = outputSize();

    if (!size) return;

    if (
      captureCanvas.width !== size.width ||
      captureCanvas.height !== size.height
    ) {
      captureCanvas.width = size.width;
      captureCanvas.height = size.height;
    }

    captureContext.drawImage(
      captureVideo,
      0,
      0,
      size.width,
      size.height
    );

    const blob = await new Promise(resolve => {
      captureCanvas.toBlob(
        resolve,
        "image/jpeg",
        appliedSettings.jpegQuality
      );
    });

    if (!blob || token !== captureToken) return;

    if (blob.size > 1024 * 1024) {
      skippedFrames++;
      return;
    }

    const buffer = await blob.arrayBuffer();

    if (
      token !== captureToken ||
      role !== "sender"
    ) {
      return;
    }

    if (
      ws?.readyState === WebSocket.OPEN &&
      ws.bufferedAmount < MAX_BUFFER
    ) {
      if (sendBinary(FRAME_VIDEO, buffer)) {
        sentFrames++;
        sentVideoBytes += buffer.byteLength;
      }

    } else {
      skippedFrames++;
    }

  } catch (error) {
    console.warn("Canvas:", error);
    skippedFrames++;

  } finally {
    captureBusy = false;
  }
}

async function startCanvasCapture() {
  workerMode = false;

  captureCanvas = document.createElement("canvas");

  captureContext = captureCanvas.getContext(
    "2d",
    { alpha: false }
  );

  if (!captureContext) {
    throw new Error("Canvas初期化失敗");
  }

  captureVideo = document.createElement("video");

  captureVideo.autoplay = true;
  captureVideo.muted = true;
  captureVideo.playsInline = true;

  captureVideo.style.position = "fixed";
  captureVideo.style.width = "1px";
  captureVideo.style.height = "1px";
  captureVideo.style.opacity = "0";
  captureVideo.style.pointerEvents = "none";

  document.body.appendChild(captureVideo);

  captureVideo.srcObject = localStream;

  await captureVideo.play();

  startCanvasTimer();
}

function startCanvasTimer() {
  if (captureTimer !== null) {
    clearInterval(captureTimer);
  }

  const token = ++captureToken;

  captureTimer = setInterval(() => {
    captureCanvasFrame(token);
  }, 1000 / appliedSettings.fps);
}

async function startVideoCapture() {
  sentFrames = 0;
  sentVideoBytes = 0;
  skippedFrames = 0;

  senderHistory = {};

  const success = await startWorkerCapture();

  if (!success) {
    await startCanvasCapture();
  }

  updateCaptureInfo();
}

function stopVideoCapture() {
  processorRunning = false;

  if (processorReader) {
    const reader = processorReader;

    processorReader = null;
    processor = null;

    reader.cancel().catch(() => {});

    try {
      reader.releaseLock();
    } catch {}
  }

  if (worker) {
    worker.terminate();
    worker = null;
  }

  workerReady = false;
  workerBusy = false;
  workerMode = false;

  stopCanvasCapture();
}

/* ========================================
   音声送信 v27.3
======================================== */

function startAudioCapture() {
  const tracks = localStream?.getAudioTracks() || [];

  if (!tracks.length) {
    console.warn("音声トラックなし");
    return;
  }

  if (typeof MediaRecorder === "undefined") {
    console.warn("MediaRecorder非対応");
    return;
  }

  const mimeTypes = [
    "audio/webm;codecs=opus",
    "audio/webm"
  ];

  audioMime = mimeTypes.find(type =>
    MediaRecorder.isTypeSupported(type)
  ) || "";

  if (!audioMime) {
    console.warn("WebM/Opus非対応");
    return;
  }

  try {
    const stream = new MediaStream(tracks);

    audioRecorder = new MediaRecorder(stream, {
      mimeType: audioMime,
      audioBitsPerSecond: 256000
    });

    audioChunksSent = 0;

    let sendChain = Promise.resolve();

    const recorder = audioRecorder;

    recorder.ondataavailable = event => {
      if (
        role !== "sender" ||
        !event.data.size
      ) {
        return;
      }

      const blob = event.data;

      sendChain = sendChain.then(async () => {
        if (
          role !== "sender" ||
          audioRecorder !== recorder
        ) {
          return;
        }

        const buffer = await blob.arrayBuffer();

        if (
          buffer.byteLength > 256 * 1024 ||
          ws?.readyState !== WebSocket.OPEN ||
          ws.bufferedAmount > MAX_BUFFER
        ) {
          return;
        }

        if (sendBinary(FRAME_AUDIO, buffer)) {
          sentAudioBytes += buffer.byteLength;
          audioChunksSent++;
        }

      }).catch(error => {
        console.warn("Audio send:", error);
      });
    };

    recorder.onerror = error => {
      console.warn("MediaRecorder:", error);
    };

    recorder.start(AUDIO_TIMESLICE);

    updateAudioDiagnostics();

  } catch (error) {
    console.warn("Audio capture:", error);
    audioRecorder = null;
  }
}

function stopAudioCapture() {
  if (!audioRecorder) return;

  audioRecorder.ondataavailable = null;

  if (audioRecorder.state !== "inactive") {
    audioRecorder.stop();
  }

  audioRecorder = null;
}

/* ========================================
   音声バッファ情報
======================================== */

function getAudioBufferInfo() {
  const audio = $("remoteAudio");

  if (!audio || !audio.buffered.length) {
    return null;
  }

  try {
    const ranges = audio.buffered;
    const current = audio.currentTime;

    let index = -1;

    for (let i = 0; i < ranges.length; i++) {
      if (
        current >= ranges.start(i) - 0.05 &&
        current <= ranges.end(i) + 0.05
      ) {
        index = i;
        break;
      }
    }

    if (index === -1) {
      index = ranges.length - 1;
    }

    const start = ranges.start(index);
    const end = ranges.end(index);

    return {
      start,
      end,
      current,
      latency: Math.max(0, end - current)
    };

  } catch {
    return null;
  }
}

/* ========================================
   音声受信リセット
======================================== */

function resetAudioReceiver() {
  audioGeneration++;

  if (audioSyncTimer !== null) {
    clearInterval(audioSyncTimer);
    audioSyncTimer = null;
  }

  const oldBuffer = sourceBuffer;

  if (oldBuffer?.updating) {
    try {
      oldBuffer.abort();
    } catch {}
  }

  audioQueue = [];

  sourceBuffer = null;
  mediaSource = null;

  audioStarted = false;
  audioStartPending = false;
  audioStartTime = 0;

  pendingAudioBytes = 0;

  audioLatency = 0;
  audioCorrections = 0;

  audioLastCorrection = 0;
  audioLastCleanup = 0;

  audioChunksReceived = 0;
  audioLastReceiveTime = 0;

  audioCleanupRunning = false;

  const audio = $("remoteAudio");

  audio.pause();
  audio.playbackRate = 1;

  audio.removeAttribute("src");
  audio.load();

  if (audioObjectURL) {
    URL.revokeObjectURL(audioObjectURL);
    audioObjectURL = null;
  }

  $("audioStatus").textContent = "音声待機中";
}

/* ========================================
   MediaSource初期化
======================================== */

function initializeAudioReceiver() {
  const mime = "audio/webm;codecs=opus";

  if (
    typeof MediaSource === "undefined" ||
    !MediaSource.isTypeSupported(mime)
  ) {
    $("audioStatus").textContent =
      "WebM/Opus再生に非対応です";

    return false;
  }

  const generation = ++audioGeneration;
  const source = new MediaSource();

  mediaSource = source;

  audioObjectURL = URL.createObjectURL(source);

  const audio = $("remoteAudio");

  audio.src = audioObjectURL;
  audio.playbackRate = 1;

  source.addEventListener("sourceopen", () => {
    if (
      generation !== audioGeneration ||
      source.readyState !== "open"
    ) {
      return;
    }

    try {
      const buffer = source.addSourceBuffer(mime);

      sourceBuffer = buffer;
      buffer.mode = "sequence";

      buffer.addEventListener("updateend", () => {
        if (generation !== audioGeneration) {
          return;
        }

        audioCleanupRunning = false;

        tryStartAudio();

        // バッファ処理完了後に次の音声を追加
        flushAudioQueue();
      });

      buffer.addEventListener("error", error => {
        if (generation !== audioGeneration) return;

        console.warn("SourceBuffer:", error);

        $("audioStatus").textContent =
          "音声バッファエラー";
      });

      flushAudioQueue();

    } catch (error) {
      $("audioStatus").textContent =
        `音声初期化エラー: ${error.message}`;
    }

  }, { once: true });

  audioSyncTimer = setInterval(() => {
    if (generation !== audioGeneration) return;

    synchronizeAudio();
  }, 100);

  return true;
}

/* ========================================
   初回音声再生
======================================== */

function tryStartAudio() {
  if (
    audioStarted ||
    audioStartPending ||
    role !== "receiver"
  ) {
    return;
  }

  const audio = $("remoteAudio");
  const info = getAudioBufferInfo();

  if (!info) return;

  if (info.end - info.start < 0.08) {
    return;
  }

  audioStartPending = true;

  // 初回だけ最新音声に近い位置から再生
  const target = Math.max(
    info.start,
    info.end - AUDIO_START_LATENCY
  );

  try {
    if (target > audio.currentTime + 0.05) {
      audio.currentTime = target;
    }
  } catch (error) {
    console.warn("Audio start seek:", error);
  }

  audio.playbackRate = 1;

  const generation = audioGeneration;

  audio.play().then(() => {
    if (
      generation !== audioGeneration ||
      role !== "receiver"
    ) {
      return;
    }

    audioStarted = true;
    audioStartPending = false;

    audioStartTime = performance.now();

    $("audioStatus").textContent =
      "音声再生中（自動同期ON）";

  }).catch(error => {
    if (generation !== audioGeneration) return;

    audioStartPending = false;

    console.warn("Audio play:", error);

    $("audioStatus").textContent =
      "音声再生には操作が必要です";
  });
}

/* ========================================
   音声遅延修正 v27.3
======================================== */

function correctAudioLatency(info) {
  if (!audioStarted) return false;

  const audio = $("remoteAudio");

  if (!audio || audio.seeking) {
    return false;
  }

  const now = performance.now();

  // 初回再生直後は補正しない
  if (
    now - audioStartTime <
    AUDIO_START_GRACE
  ) {
    return false;
  }

  // 連続ジャンプを防止
  if (
    now - audioLastCorrection <
    AUDIO_CORRECTION_INTERVAL
  ) {
    return false;
  }

  // 0.5秒未満なら何もしない
  if (info.latency <= AUDIO_MAX_LATENCY) {
    return false;
  }

  // 最新音声から約0.18秒後ろを目標にする
  const target = Math.max(
    info.start,
    info.end - AUDIO_TARGET_LATENCY
  );

  const jump = target - audio.currentTime;

  if (jump < 0.1) {
    return false;
  }

  try {
    audio.currentTime = target;

    audio.playbackRate = 1;

    audioCorrections++;
    audioLastCorrection = now;

    audioLatency = AUDIO_TARGET_LATENCY;

    $("audioStatus").textContent =
      `音声同期補正: ${Math.round(jump * 1000)}ms`;

    return true;

  } catch (error) {
    console.warn("Audio correction:", error);
    return false;
  }
}

/* ========================================
   古い音声バッファ削除
======================================== */

function cleanupAudioBuffer() {
  if (
    !sourceBuffer ||
    sourceBuffer.updating ||
    mediaSource?.readyState !== "open" ||
    audioCleanupRunning
  ) {
    return;
  }

  const now = performance.now();

  if (
    now - audioLastCleanup <
    AUDIO_CLEANUP_INTERVAL
  ) {
    return;
  }

  const info = getAudioBufferInfo();

  if (!info) return;

  const removeEnd =
    info.current - AUDIO_KEEP_BEHIND;

  if (removeEnd <= info.start + 1) {
    return;
  }

  try {
    audioCleanupRunning = true;

    sourceBuffer.remove(
      info.start,
      removeEnd
    );

    audioLastCleanup = now;

  } catch (error) {
    audioCleanupRunning = false;

    console.warn("Audio cleanup:", error);
  }
}

/* ========================================
   音声同期監視
======================================== */

function synchronizeAudio() {
  if (role !== "receiver") return;

  const audio = $("remoteAudio");

  const info = getAudioBufferInfo();

  if (!info) return;

  audioLatency = info.latency;

  if (!audioStarted) {
    tryStartAudio();
    return;
  }

  // v27.2の可変再生速度方式は撤去
  audio.playbackRate = 1;

  // バッファが0.5秒以上先行したら補正
  correctAudioLatency(info);

  // 古い音声データを削除
  cleanupAudioBuffer();

  // 意図せず一時停止していたら再開
  if (
    audio.paused &&
    !audioStartPending
  ) {
    audio.play().catch(() => {});
  }
}

/* ========================================
   音声キュー
======================================== */

function flushAudioQueue() {
  if (
    !sourceBuffer ||
    sourceBuffer.updating ||
    !audioQueue.length ||
    mediaSource?.readyState !== "open"
  ) {
    return;
  }

  const buffer = audioQueue.shift();

  pendingAudioBytes = Math.max(
    0,
    pendingAudioBytes - buffer.byteLength
  );

  try {
    sourceBuffer.appendBuffer(buffer);

  } catch (error) {
    console.warn("Audio append:", error);

    $("audioStatus").textContent =
      `音声再生エラー: ${error.message}`;
  }
}

function receiveAudio(buffer) {
  if (role !== "receiver") return;

  receivedAudioBytes += buffer.byteLength;
  audioChunksReceived++;

  audioLastReceiveTime = performance.now();

  if (!mediaSource) {
    if (!initializeAudioReceiver()) return;
  }

  if (
    pendingAudioBytes + buffer.byteLength >
    AUDIO_QUEUE_LIMIT
  ) {
    $("audioStatus").textContent =
      "音声受信キューが増加しています";

    // WebMチャンクを途中で捨てると
    // MediaSourceの解析状態が壊れる可能性がある
    return;
  }

  audioQueue.push(buffer);
  pendingAudioBytes += buffer.byteLength;

  flushAudioQueue();
}

/* ========================================
   送信開始
======================================== */

async function startSender() {
  if (role || senderStarting) return;

  if (ws?.readyState !== WebSocket.OPEN) {
    status("WebSocketに接続されていません");
    return;
  }

  const room = $("roomId").value;

  if (!room.trim()) {
    status("ルームIDを入力してください");
    return;
  }

  senderStarting = true;
  updateButtons();

  const settings = readSettings();

  try {
    localStream =
      await navigator.mediaDevices.getDisplayMedia({
        video: initialConstraints(settings),
        audio: settings.audio
          ? {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            }
          : false
      });

    const track = localStream.getVideoTracks()[0];

    if (!track) {
      throw new Error("映像トラックなし");
    }

    audioInitialSettings =
      localStream.getAudioTracks().map(track =>
        track.getSettings()
      );

    role = "sender";
    currentRoom = room;
    appliedSettings = settings;

    track.onended = () => stopSender(true);

    await applyCaptureSettings(settings);

    updatePreview();
    updateAudioDiagnostics();

    signal({
      type: "join",
      role: "sender",
      room,
      name: $("senderName").value,
      memo: $("roomMemo").value
    });

    await startVideoCapture();

    sentAudioBytes = 0;

    if (settings.audio) {
      startAudioCapture();
    }

    updateCaptureInfo();
    updateButtons();
    renderRooms();

    status(
      `WebSocket配信開始: ${room}\n` +
      `映像処理: ${workerMode ? "Worker" : "Canvas"}`
    );

  } catch (error) {
    stopVideoCapture();
    stopAudioCapture();

    if (localStream) {
      for (const track of localStream.getTracks()) {
        track.stop();
      }
    }

    localStream = null;

    role = null;
    currentRoom = null;
    appliedSettings = null;

    status(`画面共有エラー: ${error.message}`);

    updateCaptureInfo();
    updateAudioDiagnostics();

  } finally {
    senderStarting = false;
    updateButtons();
  }
}

function stopSender(sendLeave = true) {
  if (role !== "sender") return;

  stopAudioMonitor();

  stopVideoCapture();
  stopAudioCapture();

  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.onended = null;
      track.stop();
    }
  }

  localStream = null;
  appliedSettings = null;

  $("localVideo").srcObject = null;
  $("senderStats").textContent = "未配信";

  role = null;
  currentRoom = null;

  if (sendLeave) {
    signal({ type: "leave" });
  }

  updateCaptureInfo();
  updateAudioDiagnostics();

  updateButtons();
  renderRooms();

  status("配信を停止しました");
}

async function applySettings() {
  if (
    role !== "sender" ||
    !localStream ||
    settingsApplying
  ) {
    return;
  }

  settingsApplying = true;
  updateButtons();

  try {
    appliedSettings = readSettings();

    await applyCaptureSettings(appliedSettings);

    if (workerMode && worker) {
      worker.postMessage({
        type: "settings",
        settings: {
          resolution: appliedSettings.resolution,
          jpegQuality: appliedSettings.jpegQuality
        }
      });

    } else {
      startCanvasTimer();
    }

    updatePreview();
    updateCaptureInfo();

    status("設定を適用しました");

  } catch (error) {
    status(`設定変更エラー: ${error.message}`);

  } finally {
    settingsApplying = false;
    updateButtons();
  }
}

/* ========================================
   JPEG受信
======================================== */

function clearVideoReceiver() {
  receiverToken++;

  pendingBlob = null;
  decoding = false;

  receivedFrames = 0;
  receivedVideoBytes = 0;

  receiverHistory = {};
  lastFrameAt = 0;

  remoteCanvas.width = 0;
  remoteCanvas.height = 0;
}

function receiveVideo(buffer) {
  if (role !== "receiver") return;

  pendingBlob = new Blob(
    [buffer],
    { type: "image/jpeg" }
  );

  receivedVideoBytes += buffer.byteLength;

  if (!decoding) {
    decodeNextFrame();
  }
}

async function decodeNextFrame() {
  if (decoding) return;

  decoding = true;

  const token = receiverToken;

  try {
    while (
      token === receiverToken &&
      pendingBlob &&
      role === "receiver"
    ) {
      const blob = pendingBlob;
      pendingBlob = null;

      let bitmap;

      try {
        bitmap = await createImageBitmap(blob);
      } catch (error) {
        console.warn("JPEG:", error);
        continue;
      }

      if (
        token !== receiverToken ||
        role !== "receiver"
      ) {
        bitmap.close();
        break;
      }

      if (remoteCanvas.width !== bitmap.width) {
        remoteCanvas.width = bitmap.width;
      }

      if (remoteCanvas.height !== bitmap.height) {
        remoteCanvas.height = bitmap.height;
      }

      remoteContext.drawImage(bitmap, 0, 0);

      bitmap.close();

      receivedFrames++;
      lastFrameAt = Date.now();
    }

  } finally {
    if (token === receiverToken) {
      decoding = false;

      if (pendingBlob) {
        decodeNextFrame();
      }
    }
  }
}

function handleBinary(buffer) {
  if (
    role !== "receiver" ||
    buffer.byteLength < 2
  ) {
    return;
  }

  const kind = new Uint8Array(buffer)[0];
  const payload = buffer.slice(1);

  if (kind === FRAME_VIDEO) {
    receiveVideo(payload);
  }

  if (kind === FRAME_AUDIO) {
    receiveAudio(payload);
  }
}

/* ========================================
   受信
======================================== */

function startReceiver(room = $("roomId").value) {
  if (!room.trim()) {
    status("ルームIDを入力してください");
    return;
  }

  if (ws?.readyState !== WebSocket.OPEN) {
    status("WebSocketに接続されていません");
    return;
  }

  if (role === "sender" || senderStarting) {
    status("配信中は受信できません");
    return;
  }

  if (role === "receiver") {
    stopReceiver(true);
  }

  clearVideoReceiver();
  resetAudioReceiver();

  receivedAudioBytes = 0;

  role = "receiver";
  currentRoom = room;

  $("roomId").value = room;
  $("roomId").dataset.edited = "1";

  signal({
    type: "join",
    role: "receiver",
    room
  });

  updateButtons();
  status(`受信待機中: ${room}`);
}

function stopReceiver(sendLeave = true) {
  if (role !== "receiver") return;

  clearVideoReceiver();
  resetAudioReceiver();

  role = null;
  currentRoom = null;

  if (sendLeave) {
    signal({ type: "leave" });
  }

  $("receiverStats").textContent = "未接続";

  updateButtons();
  status("受信を停止しました");
}

/* ========================================
   メッセージ
======================================== */

function handleMessage(data) {
  switch (data.type) {

    case "hello":
      status(
        `✅ WebSocket接続完了\n` +
        `サーバーバージョン: ${data.version}`
      );
      break;

    case "room-list":
      activeRooms = data.rooms || [];

      renderRooms();

      if (!role && !$("roomId").dataset.edited) {
        $("roomId").value =
          data.suggestedRoom || "I";
      }
      break;

    case "joined":
      if (
        data.role === role &&
        data.room === currentRoom
      ) {
        status(`ルーム参加: ${data.room}`);
      }
      break;

    case "sender-ready":
      if (role === "receiver") {
        status("WebSocket映像を受信中...");
      }
      break;

    case "sender-left":
      if (role === "receiver") {
        clearVideoReceiver();
        resetAudioReceiver();

        $("receiverStats").textContent = "配信終了";
        status("配信が終了しました");
      }
      break;

    case "error":
      status(`エラー: ${data.message}`);

      if (role === "sender") {
        stopSender(true);
        status(`エラー: ${data.message}`);
      }
      break;
  }
}

/* ========================================
   ルーム一覧
======================================== */

function renderRooms() {
  const container = $("roomList");

  container.replaceChildren();

  const visible = activeRooms.filter(room =>
    !(role === "sender" && room.id === currentRoom)
  );

  $("roomCount").textContent =
    `現在 ${visible.length} 件の配信があります`;

  if (!visible.length) {
    const p = document.createElement("p");

    p.className = "small";
    p.textContent =
      "現在、ほかに配信中のルームはありません。";

    container.appendChild(p);
    return;
  }

  for (const room of visible) {
    const card = document.createElement("div");
    card.className = "room-card";

    const title = document.createElement("div");
    title.className = "room-title";
    title.textContent = `🟢 ${room.id}`;

    const name = document.createElement("div");
    name.className = "room-name";
    name.textContent = `配信者：${room.name}`;

    card.append(title, name);

    if (room.memo) {
      const memo = document.createElement("div");

      memo.className = "room-memo";
      memo.textContent = room.memo;

      card.appendChild(memo);
    }

    const button = document.createElement("button");

    button.className = "room-watch";
    button.textContent = "📺 視聴";

    button.disabled =
      role === "sender" || senderStarting;

    button.onclick = () => {
      startReceiver(room.id);

      remoteCanvas.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    };

    card.appendChild(button);
    container.appendChild(card);
  }
}

function updateMetadata() {
  if (role !== "sender") return;

  signal({
    type: "update-room",
    name: $("senderName").value,
    memo: $("roomMemo").value
  });
}

/* ========================================
   統計
======================================== */

function rate(history, key, count) {
  const now = performance.now();
  const previous = history[key];

  history[key] = {
    count,
    time: now
  };

  if (!previous) return "?";

  const seconds =
    (now - previous.time) / 1000;

  if (seconds <= 0) return "?";

  return ((count - previous.count) / seconds).toFixed(1);
}

function updateStats() {
  if (role === "sender") {
    const fps = rate(
      senderHistory,
      "frames",
      sentFrames
    );

    const videoRate = rate(
      senderHistory,
      "videoBytes",
      sentVideoBytes
    );

    const audioRate = rate(
      senderHistory,
      "audioBytes",
      sentAudioBytes
    );

    const videoMbps =
      videoRate === "?"
        ? "?"
        : (Number(videoRate) * 8 / 1e6).toFixed(2);

    const audioKbps =
      audioRate === "?"
        ? "?"
        : (Number(audioRate) * 8 / 1000).toFixed(1);

    $("senderStats").textContent =
`========== WebSocket送信 ==========

【映像】
処理方式: ${workerMode ? "Worker" : "Canvas"}
目標FPS: ${appliedSettings?.fps ?? "?"}
実測送信FPS: ${fps}
送信累計: ${sentFrames}
スキップ累計: ${skippedFrames}

【通信】
映像速度: ${videoMbps} Mbps
音声速度: ${audioKbps} Kbps

【音声 v27.3】
方式: MediaRecorder / WebM Opus
目標ビットレート: 256 Kbps
送信間隔設定: ${AUDIO_TIMESLICE} ms

音声送信チャンク:
${audioChunksSent}

映像送信累計:
${(sentVideoBytes / 1024 / 1024).toFixed(2)} MB

音声送信累計:
${(sentAudioBytes / 1024 / 1024).toFixed(2)} MB

WebSocketバッファ:
${ws?.bufferedAmount ?? "?"} bytes
`;
  }

  if (role === "receiver") {
    const fps = rate(
      receiverHistory,
      "frames",
      receivedFrames
    );

    const videoRate = rate(
      receiverHistory,
      "videoBytes",
      receivedVideoBytes
    );

    const videoMbps =
      videoRate === "?"
        ? "?"
        : (Number(videoRate) * 8 / 1e6).toFixed(2);

    const audio = $("remoteAudio");
    const info = getAudioBufferInfo();

    const latencyText = info
      ? `${(info.latency * 1000).toFixed(0)} ms`
      : "計測待機中";

    const audioState = !mediaSource
      ? "音声未受信"
      : audioStarted
        ? audio.paused
          ? "一時停止中"
          : "再生中"
        : "再生準備中";

    $("receiverStats").textContent =
`========== WebSocket受信 ==========

【映像】
実測表示FPS: ${fps}
表示累計: ${receivedFrames}

解像度:
${remoteCanvas.width || "?"}×${remoteCanvas.height || "?"}

【通信】
映像受信速度: ${videoMbps} Mbps

映像受信累計:
${(receivedVideoBytes / 1024 / 1024).toFixed(2)} MB

音声受信累計:
${(receivedAudioBytes / 1024 / 1024).toFixed(2)} MB

【音声同期 v27.3】
再生状態:
${audioState}

音声バッファ先端との差:
${latencyText}

許容バッファ遅延:
${AUDIO_MAX_LATENCY * 1000} ms

補正後の目標遅延:
${AUDIO_TARGET_LATENCY * 1000} ms

自動補正回数:
${audioCorrections}

再生速度:
${audio.playbackRate.toFixed(3)} 倍

受信チャンク累計:
${audioChunksReceived}

未処理キュー:
${audioQueue.length} チャンク

未処理データ:
${(pendingAudioBytes / 1024).toFixed(1)} KB

※バッファ先端との差は
映像との実際の同期誤差ではありません。

最終映像フレーム:
${lastFrameAt
  ? `${Date.now() - lastFrameAt} ms前`
  : "未受信"}
`;
  }
}

/* ========================================
   イベント
======================================== */

$("roomId").addEventListener("input", () => {
  $("roomId").dataset.edited = "1";
});

$("senderName").addEventListener(
  "input",
  updateMetadata
);

$("roomMemo").addEventListener(
  "input",
  updateMetadata
);

$("sendButton").onclick = startSender;
$("stopButton").onclick = () => stopSender(true);

$("receiveButton").onclick = () => startReceiver();
$("leaveButton").onclick = () => stopReceiver(true);

$("applyButton").onclick = applySettings;
$("preview").onchange = updatePreview;

if ($("audioMonitorButton")) {
  $("audioMonitorButton").onclick =
    toggleAudioMonitor;
}

if ($("audioProcessingButton")) {
  $("audioProcessingButton").onclick =
    disableAudioProcessing;
}

$("fullscreen").onclick = () => {
  remoteCanvas.requestFullscreen?.();
};

$("muteButton").onclick = () => {
  const audio = $("remoteAudio");

  audio.muted = !audio.muted;

  $("muteButton").textContent =
    audio.muted
      ? "🔇 ミュート中"
      : "🔊 音声ON";

  if (!audio.muted) {
    audio.play().catch(() => {});
  }
};

/* ========================================
   初期化
======================================== */

$("remoteVideo").classList.add("hidden");
$("remoteCanvas").classList.remove("hidden");

connect();

updateButtons();
updatePreview();

setInterval(updateStats, 1000);

setInterval(() => {
  signal({ type: "ping" });
}, 15000);

})();
