"use strict";

(() => {

const $ = id => document.getElementById(id);

/* ========================================
   WebSocket Caster v27.5
   Stable AV Sync Edition
======================================== */

const FRAME_VIDEO = 1;
const FRAME_AUDIO = 2;

const MAX_BUFFER = 1024 * 1024;

const VIDEO_HEADER_SIZE = 8;
const AUDIO_HEADER_SIZE = 13;

/* ========================================
   音声同期設定
======================================== */

// 通常時に確保する音声バッファ
const AUDIO_TARGET_BUFFER_MS = 250;

// この値を超えた状態が続いた場合に補正
const AUDIO_MAX_BUFFER_MS = 1600;

// 補正後に残す音声
const AUDIO_RECOVERY_BUFFER_MS = 350;

// 補正の最短間隔
const AUDIO_CORRECTION_COOLDOWN_MS = 5000;

// バッファ超過が継続する必要がある時間
const AUDIO_OVERFLOW_CONFIRM_MS = 500;

// 音声パケットの最大待機数
const AUDIO_PENDING_LIMIT = 40;

// 映像キュー
const VIDEO_QUEUE_LIMIT = 120;

// 音声時刻が古い場合の映像フォールバック
const AUDIO_CLOCK_TIMEOUT_MS = 500;

// 映像の最大待機時間
const VIDEO_MAX_WAIT_MS = 1800;

/* ========================================
   基本状態
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

let workerFrameTimestamp = 0;

/* ========================================
   音声
======================================== */

let audioContext = null;
let audioSource = null;
let audioNode = null;
let audioWorkletURL = null;

let audioGeneration = 0;
let audioReady = false;
let audioStarting = false;

let audioMode = "なし";
let audioSampleRate = 48000;
let audioChannels = 2;

let audioSendSequence = 0;
let audioReceiveSequence = 0;

let audioPlaybackTimestamp = 0;
let audioPlaybackReportedAt = 0;

let audioQueueDuration = 0;
let audioPlaying = false;

let audioCorrections = 0;
let audioDroppedPackets = 0;
let audioDroppedMs = 0;

let lastSyncCorrection = 0;

let pendingAudioPackets = [];

let audioMonitoring = false;

let audioInitialSettings = [];
let audioCurrentSettings = [];

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
let lastAudioPacketAt = 0;

/* ========================================
   映像受信
======================================== */

const remoteCanvas = $("remoteCanvas");

const remoteContext = remoteCanvas.getContext(
  "2d",
  { alpha: false }
);

let videoQueue = [];

let videoReceiverToken = 0;
let videoRenderTimer = null;

let videoDecodeBusy = false;

let latestVideoTimestamp = 0;
let lastVideoDisplayedTimestamp = 0;

let videoClockOffset = null;

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

function writeTimestamp(view, offset, timestamp) {
  view.setFloat64(offset, timestamp, true);
}

function readTimestamp(view, offset) {
  return view.getFloat64(offset, true);
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
    (localStream?.getAudioTracks().length || 0) > 0;

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
    frameRate: {
      ideal: settings.fps
    }
  };

  const size = targetSize(settings);

  if (size) {
    video.width = {
      ideal: size.width
    };

    video.height = {
      ideal: size.height
    };
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

function updateAudioDiagnostics() {
  const element = $("audioDiagnostics");

  if (!element) return;

  const tracks =
    localStream?.getAudioTracks() || [];

  audioCurrentSettings = tracks.map(
    track => track.getSettings()
  );

  element.textContent =
`========== WebSocket音声 ==========

方式:
${audioMode}

取得トラック数:
${tracks.length}

サンプルレート:
${audioSampleRate}

チャンネル数:
${audioChannels}

音声処理:
可能な範囲でOFF`;
}

async function disableAudioProcessing() {
  if (!localStream) return;

  for (const track of localStream.getAudioTracks()) {
    const capabilities =
      track.getCapabilities?.() || {};

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
    return;
  }

  const tracks =
    localStream?.getAudioTracks() || [];

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

/* ========================================
   バイナリ送信
======================================== */

function sendVideoBinary(buffer, timestamp) {
  if (ws?.readyState !== WebSocket.OPEN) {
    return false;
  }

  const payload = new ArrayBuffer(
    1 + VIDEO_HEADER_SIZE + buffer.byteLength
  );

  const view = new DataView(payload);

  view.setUint8(0, FRAME_VIDEO);

  writeTimestamp(view, 1, timestamp);

  new Uint8Array(payload, 9).set(
    new Uint8Array(buffer)
  );

  ws.send(payload);

  return true;
}

function sendAudioBinary(
  samples,
  timestamp,
  sampleRate,
  channels
) {
  if (ws?.readyState !== WebSocket.OPEN) {
    return false;
  }

  const payload = new ArrayBuffer(
    1 + AUDIO_HEADER_SIZE + samples.byteLength
  );

  const view = new DataView(payload);

  view.setUint8(0, FRAME_AUDIO);

  writeTimestamp(view, 1, timestamp);

  view.setUint32(9, sampleRate, true);
  view.setUint8(13, channels);

  new Uint8Array(payload, 14).set(
    new Uint8Array(
      samples.buffer,
      samples.byteOffset,
      samples.byteLength
    )
  );

  ws.send(payload);

  return true;
}

/* ========================================
   キャプチャ設定
======================================== */

async function applyCaptureSettings(settings) {
  const track =
    localStream?.getVideoTracks()[0];

  if (!track) return;

  const constraints = {
    frameRate: {
      ideal: settings.fps
    }
  };

  const size = targetSize(settings);

  if (size) {
    constraints.width = {
      ideal: size.width
    };

    constraints.height = {
      ideal: size.height
    };

  } else {
    const capabilities =
      track.getCapabilities?.();

    const width = capabilities?.width?.max;
    const height = capabilities?.height?.max;

    if (
      Number.isFinite(width) &&
      Number.isFinite(height)
    ) {
      constraints.width = {
        ideal: width
      };

      constraints.height = {
        ideal: height
      };
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

音声方式:
${audioMode}

音声トラック:
${localStream.getAudioTracks().length}`;
}

function updatePreview() {
  const enabled = $("preview").checked;

  $("localVideo").style.display =
    enabled ? "block" : "none";

  $("localVideo").srcObject =
    enabled ? localStream : null;
}

/* ========================================
   Worker映像送信
======================================== */

async function startWorkerCapture() {
  if (
    typeof Worker === "undefined" ||
    typeof MediaStreamTrackProcessor === "undefined" ||
    typeof OffscreenCanvas === "undefined"
  ) {
    return false;
  }

  const track =
    localStream?.getVideoTracks()[0];

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

          if (
            sendVideoBinary(
              data.buffer,
              workerFrameTimestamp
            )
          ) {
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

    processor = new MediaStreamTrackProcessor({
      track
    });

    processorReader =
      processor.readable.getReader();

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

      workerFrameTimestamp = Date.now();

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

    const timestamp = Date.now();

    const blob = await new Promise(resolve => {
      captureCanvas.toBlob(
        resolve,
        "image/jpeg",
        appliedSettings.jpegQuality
      );
    });

    if (!blob || token !== captureToken) {
      return;
    }

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
      if (sendVideoBinary(buffer, timestamp)) {
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
   AudioWorklet v27.5

   重要な修正:
   - 再生中パケットを含めたバッファ管理
   - 正確な残りサンプル数
   - 補正後の再計算
   - 連続補正防止
   - サンプルレート変換
======================================== */

const AUDIO_WORKLET_CODE = `

class CasterAudioProcessor extends AudioWorkletProcessor {

  constructor(options) {
    super();

    const settings =
      options.processorOptions || {};

    this.mode =
      settings.mode || "receiver";

    this.packetFrames = Math.max(
      128,
      Math.round(sampleRate * 0.02)
    );

    this.captureBuffer = new Float32Array(
      this.packetFrames * 2
    );

    this.captureOffset = 0;

    /*
      受信音声キュー

      queueFrames:
      待機中パケットと再生中パケットの
      残りサンプル数の合計。
    */

    this.queue = [];
    this.queueFrames = 0;

    this.currentPacket = null;
    this.packetOffset = 0;

    this.playing = false;
    this.muted = false;

    this.lastTimestamp = 0;

    this.renderedFrames = 0;
    this.reportCounter = 0;

    this.targetFrames = Math.round(
      sampleRate * ${AUDIO_TARGET_BUFFER_MS / 1000}
    );

    this.maxFrames = Math.round(
      sampleRate * ${AUDIO_MAX_BUFFER_MS / 1000}
    );

    this.recoveryFrames = Math.round(
      sampleRate * ${AUDIO_RECOVERY_BUFFER_MS / 1000}
    );

    this.cooldownFrames = Math.round(
      sampleRate * ${AUDIO_CORRECTION_COOLDOWN_MS / 1000}
    );

    this.confirmFrames = Math.round(
      sampleRate * ${AUDIO_OVERFLOW_CONFIRM_MS / 1000}
    );

    this.lastCorrectionFrame = -Infinity;

    this.overflowStartedFrame = -1;

    this.corrections = 0;

    this.port.onmessage = event => {
      const data = event.data;

      if (data.type === "packet") {
        this.addPacket(data);
      }

      if (data.type === "mute") {
        this.muted = !!data.value;
      }

      if (data.type === "reset") {
        this.reset();
      }
    };
  }

  reset() {
    this.queue = [];
    this.queueFrames = 0;

    this.currentPacket = null;
    this.packetOffset = 0;

    this.playing = false;

    this.lastTimestamp = 0;

    this.overflowStartedFrame = -1;
    this.lastCorrectionFrame = -Infinity;
  }

  /*
    サンプルレート変換

    送信側と受信側のAudioContextが
    異なるサンプルレートでも再生できるよう
    線形補間で変換する。
  */

  resample(samples, channels, sourceRate) {
    if (sourceRate === sampleRate) {
      return samples;
    }

    const sourceFrames =
      Math.floor(samples.length / channels);

    const outputFrames =
      Math.max(
        1,
        Math.round(
          sourceFrames * sampleRate / sourceRate
        )
      );

    const output = new Int16Array(
      outputFrames * channels
    );

    for (let i = 0; i < outputFrames; i++) {
      const position =
        i * sourceRate / sampleRate;

      const index = Math.min(
        sourceFrames - 1,
        Math.floor(position)
      );

      const next = Math.min(
        sourceFrames - 1,
        index + 1
      );

      const fraction =
        position - index;

      for (let channel = 0; channel < channels; channel++) {
        const a =
          samples[index * channels + channel];

        const b =
          samples[next * channels + channel];

        output[i * channels + channel] =
          Math.round(
            a + (b - a) * fraction
          );
      }
    }

    return output;
  }

  addPacket(data) {
    if (this.mode !== "receiver") {
      return;
    }

    const channels = Math.max(
      1,
      Math.min(2, data.channels || 2)
    );

    const sourceRate =
      data.sampleRate || sampleRate;

    if (
      sourceRate < 8000 ||
      sourceRate > 192000
    ) {
      return;
    }

    let samples = new Int16Array(
      data.buffer
    );

    samples = this.resample(
      samples,
      channels,
      sourceRate
    );

    const frames = Math.floor(
      samples.length / channels
    );

    if (!frames) return;

    const packet = {
      samples,
      channels,
      frames,
      timestamp: data.timestamp
    };

    this.queue.push(packet);
    this.queueFrames += frames;

    /*
      ここでは補正しない。

      v27.4では受信イベント中に補正していたが、
      今回は音声処理のprocess()側で
      一定時間の超過を確認してから補正する。
    */
  }

  /*
    再生中パケットを含む
    正確なバッファ量を再計算。
  */

  recalculateQueueFrames() {
    let total = 0;

    if (this.currentPacket) {
      total += Math.max(
        0,
        this.currentPacket.frames -
        this.packetOffset
      );
    }

    for (const packet of this.queue) {
      total += packet.frames;
    }

    this.queueFrames = total;

    return total;
  }

  /*
    v27.5 安定補正

    最新の音声を約350ms残して
    古いデータを破棄する。

    補正後は正確に残量を再計算。
  */

  recover() {
    const originalFrames =
      this.recalculateQueueFrames();

    if (
      originalFrames <=
      this.maxFrames
    ) {
      return;
    }

    const target =
      this.recoveryFrames;

    let dropped = 0;

    /*
      再生中パケットを破棄する場合、
      残りサンプルだけを減算。
    */

    if (this.currentPacket) {
      const remaining = Math.max(
        0,
        this.currentPacket.frames -
        this.packetOffset
      );

      dropped += remaining;

      this.currentPacket = null;
      this.packetOffset = 0;
    }

    /*
      古い待機パケットを破棄する。

      最新側に必要な量を残す。
    */

    let remainingFrames =
      originalFrames - dropped;

    while (
      this.queue.length > 1 &&
      remainingFrames -
        this.queue[0].frames >= target
    ) {
      const packet = this.queue.shift();

      remainingFrames -= packet.frames;
      dropped += packet.frames;
    }

    /*
      残りの先頭パケットも必要なら
      部分的にスキップする。
    */

    if (
      this.queue.length &&
      remainingFrames > target
    ) {
      const excess =
        remainingFrames - target;

      const packet = this.queue[0];

      const skip = Math.min(
        excess,
        packet.frames - 1
      );

      if (skip > 0) {
        packet.samples =
          packet.samples.subarray(
            skip * packet.channels
          );

        packet.timestamp +=
          skip / sampleRate * 1000;

        packet.frames -= skip;

        dropped += skip;
      }
    }

    const actualRemaining =
      this.recalculateQueueFrames();

    /*
      補正後は不足していなければ
      再生を継続する。
    */

    this.playing =
      actualRemaining >=
      this.targetFrames;

    this.lastCorrectionFrame =
      this.renderedFrames;

    this.overflowStartedFrame = -1;

    this.corrections++;

    this.port.postMessage({
      type: "correction",

      droppedMs:
        dropped / sampleRate * 1000,

      remainingMs:
        actualRemaining / sampleRate * 1000,

      timestamp:
        this.queue.length
          ? this.queue[0].timestamp
          : this.lastTimestamp
    });
  }

  /*
    補正判定

    1. 1600ms超過
    2. 500ms以上継続
    3. 前回補正から5秒以上
  */

  checkOverflow() {
    if (
      this.queueFrames <=
      this.maxFrames
    ) {
      this.overflowStartedFrame = -1;
      return;
    }

    if (
      this.overflowStartedFrame < 0
    ) {
      this.overflowStartedFrame =
        this.renderedFrames;

      return;
    }

    const overflowDuration =
      this.renderedFrames -
      this.overflowStartedFrame;

    if (
      overflowDuration <
      this.confirmFrames
    ) {
      return;
    }

    const sinceCorrection =
      this.renderedFrames -
      this.lastCorrectionFrame;

    if (
      sinceCorrection <
      this.cooldownFrames
    ) {
      return;
    }

    this.recover();
  }

  /*
    音声キャプチャ
  */

  capture(inputs) {
    const input = inputs[0];

    if (!input || !input.length) {
      return;
    }

    const left = input[0];
    const right = input[1] || left;

    for (let i = 0; i < left.length; i++) {
      const offset =
        this.captureOffset * 2;

      this.captureBuffer[offset] =
        left[i];

      this.captureBuffer[offset + 1] =
        right[i];

      this.captureOffset++;

      if (
        this.captureOffset >=
        this.packetFrames
      ) {
        const pcm = new Int16Array(
          this.packetFrames * 2
        );

        for (
          let j = 0;
          j < pcm.length;
          j++
        ) {
          const sample = Math.max(
            -1,
            Math.min(
              1,
              this.captureBuffer[j]
            )
          );

          pcm[j] = sample < 0
            ? Math.round(sample * 32768)
            : Math.round(sample * 32767);
        }

        /*
          audioContextの時間軸で
          キャプチャ時刻を通知。
        */

        this.port.postMessage({
          type: "capture",

          buffer: pcm.buffer,

          frames:
            this.packetFrames,

          sampleRate,

          contextTime:
            currentTime

        }, [pcm.buffer]);

        this.captureOffset = 0;
      }
    }
  }

  /*
    音声再生
  */

  playback(outputs) {
    const output = outputs[0];

    if (!output || !output.length) {
      return;
    }

    const left = output[0];
    const right = output[1] || left;

    left.fill(0);

    if (right !== left) {
      right.fill(0);
    }

    /*
      まずバッファを検査。
    */

    this.recalculateQueueFrames();

    this.checkOverflow();

    if (!this.playing) {
      if (
        this.queueFrames >=
        this.targetFrames
      ) {
        this.playing = true;

      } else {
        this.reportPlayback();
        return;
      }
    }

    for (let i = 0; i < left.length; i++) {

      if (!this.currentPacket) {
        this.currentPacket =
          this.queue.shift() || null;

        this.packetOffset = 0;
      }

      const packet =
        this.currentPacket;

      if (!packet) {
        /*
          音声不足。

          無音を出力して、
          次の音声が250ms蓄積するまで待つ。
        */

        this.playing = false;
        this.queueFrames = 0;

        break;
      }

      const offset =
        this.packetOffset *
        packet.channels;

      const l =
        packet.samples[offset] / 32768;

      const r =
        packet.channels > 1
          ? packet.samples[offset + 1] / 32768
          : l;

      if (!this.muted) {
        left[i] = l;

        if (right !== left) {
          right[i] = r;
        }
      }

      this.lastTimestamp =
        packet.timestamp +
        this.packetOffset /
        sampleRate * 1000;

      this.packetOffset++;

      this.queueFrames--;

      if (
        this.packetOffset >=
        packet.frames
      ) {
        this.currentPacket = null;
        this.packetOffset = 0;
      }
    }

    /*
      浮動的な誤差が累積しないよう
      定期的に残量を再計算。
    */

    this.recalculateQueueFrames();

    this.reportPlayback();
  }

  /*
    再生状態通知
  */

  reportPlayback() {
    this.reportCounter++;

    if (this.reportCounter < 8) {
      return;
    }

    this.reportCounter = 0;

    this.port.postMessage({
      type: "playback",

      timestamp:
        this.lastTimestamp,

      bufferedMs:
        this.queueFrames /
        sampleRate * 1000,

      playing:
        this.playing,

      packets:
        this.queue.length +
        (this.currentPacket ? 1 : 0)
    });
  }

  process(inputs, outputs) {
    this.renderedFrames +=
      outputs[0]?.[0]?.length || 128;

    if (this.mode === "sender") {
      this.capture(inputs);

      /*
        送信側は無音出力。
      */

      for (const output of outputs) {
        for (const channel of output) {
          channel.fill(0);
        }
      }

    } else {
      this.playback(outputs);
    }

    return true;
  }
}

registerProcessor(
  "caster-audio-processor",
  CasterAudioProcessor
);

`;

/* ========================================
   AudioWorklet初期化
======================================== */

async function createAudioContext(mode) {
  const Context =
    window.AudioContext ||
    window.webkitAudioContext;

  if (!Context) {
    throw new Error("AudioContext非対応");
  }

  const context = new Context({
    latencyHint: "interactive"
  });

  if (!context.audioWorklet) {
    await context.close();

    throw new Error("AudioWorklet非対応");
  }

  const blob = new Blob(
    [AUDIO_WORKLET_CODE],
    { type: "text/javascript" }
  );

  const url = URL.createObjectURL(blob);

  try {
    await context.audioWorklet.addModule(url);

  } catch (error) {
    URL.revokeObjectURL(url);

    await context.close();

    throw error;
  }

  let node;

  try {
    node = new AudioWorkletNode(
      context,
      "caster-audio-processor",
      {
        numberOfInputs:
          mode === "sender" ? 1 : 0,

        numberOfOutputs: 1,

        outputChannelCount: [2],

        processorOptions: {
          mode
        }
      }
    );

  } catch (error) {
    URL.revokeObjectURL(url);

    await context.close();

    throw error;
  }

  return {
    context,
    node,
    url
  };
}

/* ========================================
   音声送信
======================================== */

async function startAudioCapture() {
  const tracks =
    localStream?.getAudioTracks() || [];

  if (!tracks.length) {
    audioMode = "音声トラックなし";
    return;
  }

  const generation = ++audioGeneration;

  try {
    const result =
      await createAudioContext("sender");

    if (
      generation !== audioGeneration ||
      role !== "sender"
    ) {
      result.node.disconnect();
      URL.revokeObjectURL(result.url);

      await result.context.close();
      return;
    }

    audioContext = result.context;
    audioNode = result.node;
    audioWorkletURL = result.url;

    audioSampleRate =
      audioContext.sampleRate;

    audioChannels = 2;

    const stream =
      new MediaStream(tracks);

    audioSource =
      audioContext.createMediaStreamSource(
        stream
      );

    audioSource.connect(audioNode);

    audioNode.connect(
      audioContext.destination
    );

    audioMode = "AudioWorklet PCM16";

    audioSendSequence = 0;

    /*
      音声タイムスタンプの基準。

      AudioContextの時間軸をUnix時刻へ
      近似的に対応付ける。
    */

    const clockBase =
      Date.now() -
      audioContext.currentTime * 1000;

    audioNode.port.onmessage = event => {
      const data = event.data;

      if (
        generation !== audioGeneration ||
        role !== "sender"
      ) {
        return;
      }

      if (data.type !== "capture") {
        return;
      }

      const samples =
        new Int16Array(data.buffer);

      const duration =
        data.frames /
        data.sampleRate * 1000;

      /*
        AudioWorkletの処理時刻を使うことで、
        メインスレッドのメッセージ遅延が
        タイムスタンプへ直接反映されるのを抑える。
      */

      const timestamp =
        clockBase +
        data.contextTime * 1000 -
        duration;

      if (
        ws?.readyState !== WebSocket.OPEN ||
        ws.bufferedAmount > MAX_BUFFER
      ) {
        return;
      }

      if (
        sendAudioBinary(
          samples,
          timestamp,
          data.sampleRate,
          2
        )
      ) {
        sentAudioBytes +=
          samples.byteLength;

        audioSendSequence++;
      }
    };

    await audioContext.resume();

    audioReady = true;

    updateAudioDiagnostics();
    updateCaptureInfo();

  } catch (error) {
    console.warn("AudioWorklet送信:", error);

    audioMode =
      `音声利用不可: ${error.message}`;

    status(
      `映像配信中・音声エラー: ${error.message}`
    );
  }
}

/* ========================================
   音声停止
======================================== */

function stopAudioCapture() {
  audioGeneration++;

  audioReady = false;
  audioStarting = false;

  if (audioNode) {
    audioNode.port.onmessage = null;

    try {
      audioNode.disconnect();
    } catch {}

    audioNode = null;
  }

  if (audioSource) {
    try {
      audioSource.disconnect();
    } catch {}

    audioSource = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});

    audioContext = null;
  }

  if (audioWorkletURL) {
    URL.revokeObjectURL(audioWorkletURL);

    audioWorkletURL = null;
  }

  audioMode = "なし";
}

/* ========================================
   音声受信初期化
======================================== */

async function initializeAudioReceiver() {
  if (audioStarting || audioReady) {
    return;
  }

  audioStarting = true;

  const generation = ++audioGeneration;

  try {
    const result =
      await createAudioContext("receiver");

    if (
      generation !== audioGeneration ||
      role !== "receiver"
    ) {
      result.node.disconnect();
      URL.revokeObjectURL(result.url);

      await result.context.close();
      return;
    }

    audioContext = result.context;
    audioNode = result.node;
    audioWorkletURL = result.url;

    audioSampleRate =
      audioContext.sampleRate;

    audioNode.connect(
      audioContext.destination
    );

    audioNode.port.postMessage({
      type: "mute",
      value: $("remoteAudio").muted
    });

    audioNode.port.onmessage = event => {
      if (
        generation !== audioGeneration ||
        role !== "receiver"
      ) {
        return;
      }

      const data = event.data;

      if (data.type === "playback") {
        audioPlaybackTimestamp =
          data.timestamp;

        audioPlaybackReportedAt =
          performance.now();

        audioQueueDuration =
          data.bufferedMs;

        audioPlaying =
          data.playing;

        if (data.playing) {
          $("audioStatus").textContent =
            "PCM音声再生中";
        }
      }

      if (data.type === "correction") {
        audioCorrections++;

        audioDroppedPackets++;
        audioDroppedMs += data.droppedMs;

        lastSyncCorrection =
          performance.now();

        /*
          音声の補正位置に合わせて
          古い映像フレームを破棄する。
        */

        if (
          Number.isFinite(data.timestamp)
        ) {
          videoQueue = videoQueue.filter(
            frame =>
              frame.timestamp >=
              data.timestamp - 100
          );
        }

        $("audioStatus").textContent =
          `AV同期補正: ${Math.round(data.droppedMs)}ms`;
      }
    };

    await audioContext.resume();

    audioReady = true;

    audioMode = "AudioWorklet PCM16";

    $("audioStatus").textContent =
      "PCM音声受信中";

    flushPendingAudioPackets();

  } catch (error) {
    console.warn("AudioWorklet受信:", error);

    $("audioStatus").textContent =
      `音声再生エラー: ${error.message}`;

  } finally {
    if (generation === audioGeneration) {
      audioStarting = false;
    }
  }
}

/* ========================================
   音声受信
======================================== */

function receiveAudio(buffer) {
  if (role !== "receiver") return;

  if (
    buffer.byteLength <
    AUDIO_HEADER_SIZE + 2
  ) {
    return;
  }

  const view = new DataView(buffer);

  const timestamp =
    readTimestamp(view, 0);

  const sampleRate =
    view.getUint32(8, true);

  const channels =
    view.getUint8(12);

  if (
    !Number.isFinite(timestamp) ||
    sampleRate < 8000 ||
    sampleRate > 192000 ||
    channels < 1 ||
    channels > 2
  ) {
    return;
  }

  const samples =
    buffer.slice(AUDIO_HEADER_SIZE);

  if (
    samples.byteLength % (channels * 2)
  ) {
    return;
  }

  receivedAudioBytes +=
    samples.byteLength;

  audioReceiveSequence++;

  lastAudioPacketAt = Date.now();

  const packet = {
    buffer: samples,
    timestamp,
    sampleRate,
    channels
  };

  if (!audioReady) {
    pendingAudioPackets.push(packet);

    if (
      pendingAudioPackets.length >
      AUDIO_PENDING_LIMIT
    ) {
      pendingAudioPackets.shift();
    }

    initializeAudioReceiver();
    return;
  }

  audioNode.port.postMessage({
    type: "packet",
    ...packet
  }, [samples]);

  flushPendingAudioPackets();
}

function flushPendingAudioPackets() {
  if (!audioReady || !audioNode) {
    return;
  }

  while (pendingAudioPackets.length) {
    const packet =
      pendingAudioPackets.shift();

    audioNode.port.postMessage({
      type: "packet",
      ...packet
    }, [packet.buffer]);
  }
}

/* ========================================
   音声受信リセット
======================================== */

function resetAudioReceiver() {
  stopAudioCapture();

  pendingAudioPackets = [];

  audioReceiveSequence = 0;

  receivedAudioBytes = 0;

  audioPlaybackTimestamp = 0;
  audioPlaybackReportedAt = 0;

  audioQueueDuration = 0;
  audioPlaying = false;

  audioCorrections = 0;
  audioDroppedPackets = 0;
  audioDroppedMs = 0;

  lastSyncCorrection = 0;

  $("audioStatus").textContent =
    "音声待機中";
}

/* ========================================
   映像受信リセット
======================================== */

function clearVideoReceiver() {
  videoReceiverToken++;

  videoQueue = [];

  receivedFrames = 0;
  receivedVideoBytes = 0;

  receiverHistory = {};

  lastFrameAt = 0;

  latestVideoTimestamp = 0;
  lastVideoDisplayedTimestamp = 0;

  videoClockOffset = null;

  if (videoRenderTimer !== null) {
    clearInterval(videoRenderTimer);
    videoRenderTimer = null;
  }

  remoteCanvas.width = 0;
  remoteCanvas.height = 0;
}

/* ========================================
   JPEG受信
======================================== */

function receiveVideo(buffer) {
  if (role !== "receiver") return;

  if (
    buffer.byteLength <=
    VIDEO_HEADER_SIZE
  ) {
    return;
  }

  const view = new DataView(buffer);

  const timestamp =
    readTimestamp(view, 0);

  if (!Number.isFinite(timestamp)) {
    return;
  }

  const jpeg =
    buffer.slice(VIDEO_HEADER_SIZE);

  receivedVideoBytes +=
    jpeg.byteLength;

  latestVideoTimestamp = timestamp;

  const offset =
    Date.now() - timestamp;

  if (
    videoClockOffset === null ||
    offset < videoClockOffset
  ) {
    videoClockOffset = offset;
  }

  videoQueue.push({
    timestamp,
    jpeg
  });

  if (
    videoQueue.length >
    VIDEO_QUEUE_LIMIT
  ) {
    videoQueue.splice(
      0,
      videoQueue.length -
      VIDEO_QUEUE_LIMIT
    );
  }

  if (videoRenderTimer === null) {
    videoRenderTimer = setInterval(
      renderSynchronizedVideo,
      10
    );
  }
}

/* ========================================
   AV同期
======================================== */

function getEstimatedAudioTimestamp() {
  if (
    !audioReady ||
    !audioPlaying ||
    !audioPlaybackTimestamp
  ) {
    return null;
  }

  const elapsed =
    performance.now() -
    audioPlaybackReportedAt;

  /*
    AudioWorkletの報告が古ければ
    音声時刻を同期に使わない。

    古い時刻を使い続けると
    映像が停止する原因になる。
  */

  if (
    elapsed > AUDIO_CLOCK_TIMEOUT_MS
  ) {
    return null;
  }

  return (
    audioPlaybackTimestamp +
    Math.max(
      0,
      Math.min(100, elapsed)
    )
  );
}

/* ========================================
   映像描画
======================================== */

async function renderSynchronizedVideo() {
  if (
    role !== "receiver" ||
    videoDecodeBusy ||
    !videoQueue.length
  ) {
    return;
  }

  let selected = null;

  const audioTime =
    getEstimatedAudioTimestamp();

  if (audioTime !== null) {
    /*
      音声時刻に近い最新フレームを選択。
    */

    while (
      videoQueue.length &&
      videoQueue[0].timestamp <=
        audioTime + 30
    ) {
      selected = videoQueue.shift();
    }

    /*
      同期対象が長時間来ない場合、
      映像を永久には停止させない。
    */

    if (
      !selected &&
      videoQueue.length
    ) {
      const oldest =
        videoQueue[0];

      const estimatedAge =
        Date.now() -
        oldest.timestamp -
        (videoClockOffset || 0);

      if (
        estimatedAge >
        VIDEO_MAX_WAIT_MS
      ) {
        selected = videoQueue.pop();

        videoQueue = [];
      }
    }

  } else {
    /*
      音声がない、または音声時刻が古い場合。

      最新映像を表示する。
    */

    selected = videoQueue.pop();
    videoQueue = [];
  }

  if (!selected) return;

  videoDecodeBusy = true;

  const token = videoReceiverToken;

  try {
    const blob = new Blob(
      [selected.jpeg],
      { type: "image/jpeg" }
    );

    const bitmap =
      await createImageBitmap(blob);

    if (
      token !== videoReceiverToken ||
      role !== "receiver"
    ) {
      bitmap.close();
      return;
    }

    if (
      remoteCanvas.width !== bitmap.width
    ) {
      remoteCanvas.width =
        bitmap.width;
    }

    if (
      remoteCanvas.height !== bitmap.height
    ) {
      remoteCanvas.height =
        bitmap.height;
    }

    remoteContext.drawImage(
      bitmap,
      0,
      0
    );

    bitmap.close();

    receivedFrames++;
    lastFrameAt = Date.now();

    lastVideoDisplayedTimestamp =
      selected.timestamp;

  } catch (error) {
    console.warn("JPEG decode:", error);

  } finally {
    videoDecodeBusy = false;
  }
}

/* ========================================
   バイナリ受信
======================================== */

function handleBinary(buffer) {
  if (
    role !== "receiver" ||
    buffer.byteLength < 2
  ) {
    return;
  }

  const view = new DataView(buffer);

  const kind = view.getUint8(0);

  const payload = buffer.slice(1);

  if (kind === FRAME_VIDEO) {
    receiveVideo(payload);
  }

  if (kind === FRAME_AUDIO) {
    receiveAudio(payload);
  }
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

    const track =
      localStream.getVideoTracks()[0];

    if (!track) {
      throw new Error("映像トラックなし");
    }

    audioInitialSettings =
      localStream.getAudioTracks().map(
        track => track.getSettings()
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
      await startAudioCapture();
    }

    updateCaptureInfo();
    updateButtons();
    renderRooms();

    status(
      `WebSocket配信開始: ${room}\n` +
      `映像処理: ${workerMode ? "Worker" : "Canvas"}\n` +
      `音声: ${audioMode}`
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

/* ========================================
   送信停止
======================================== */

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

/* ========================================
   設定変更
======================================== */

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

    await applyCaptureSettings(
      appliedSettings
    );

    if (workerMode && worker) {
      worker.postMessage({
        type: "settings",
        settings: {
          resolution:
            appliedSettings.resolution,

          jpegQuality:
            appliedSettings.jpegQuality
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
   受信開始
======================================== */

function startReceiver(
  room = $("roomId").value
) {
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

/* ========================================
   受信停止
======================================== */

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
   サーバーメッセージ
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

      if (
        !role &&
        !$("roomId").dataset.edited
      ) {
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

        $("receiverStats").textContent =
          "配信終了";

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
    !(
      role === "sender" &&
      room.id === currentRoom
    )
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

/* ========================================
   配信情報更新
======================================== */

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

  return (
    (count - previous.count) / seconds
  ).toFixed(1);
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

    const audioMbps =
      audioRate === "?"
        ? "?"
        : (Number(audioRate) * 8 / 1e6).toFixed(2);

    $("senderStats").textContent =
`========== WebSocket送信 v27.5 ==========

【映像】
処理方式: ${workerMode ? "Worker" : "Canvas"}

目標FPS:
${appliedSettings?.fps ?? "?"}

実測送信FPS:
${fps}

送信累計:
${sentFrames}

スキップ累計:
${skippedFrames}

【音声】
方式:
${audioMode}

サンプルレート:
${audioSampleRate} Hz

チャンネル:
${audioChannels}

PCM送信パケット:
${audioSendSequence}

音声速度:
${audioMbps} Mbps

【通信】
映像速度:
${videoMbps} Mbps

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

    const audioTime =
      getEstimatedAudioTimestamp();

    const syncDifference =
      audioTime !== null &&
      lastVideoDisplayedTimestamp
        ? (
            lastVideoDisplayedTimestamp -
            audioTime
          ).toFixed(0)
        : "?";

    const sinceCorrection =
      lastSyncCorrection
        ? (
            (performance.now() -
            lastSyncCorrection) / 1000
          ).toFixed(1)
        : "なし";

    $("receiverStats").textContent =
`========== WebSocket受信 v27.5 ==========

【映像】
実測表示FPS:
${fps}

表示累計:
${receivedFrames}

解像度:
${remoteCanvas.width || "?"}×${remoteCanvas.height || "?"}

映像待機フレーム:
${videoQueue.length}

【音声】
方式:
${audioMode}

再生状態:
${audioPlaying ? "再生中" : "バッファ待機中"}

受信パケット:
${audioReceiveSequence}

音声バッファ:
${audioQueueDuration.toFixed(0)} ms

【安定同期】
補正開始閾値:
${AUDIO_MAX_BUFFER_MS} ms

補正後の目標:
${AUDIO_RECOVERY_BUFFER_MS} ms

自動補正回数:
${audioCorrections}

破棄した音声:
${audioDroppedMs.toFixed(0)} ms

前回補正から:
${sinceCorrection} 秒

【AV同期】
映像と音声の時刻差:
${syncDifference} ms

※送信側の推定タイムスタンプに基づく値です。

【通信】
映像受信速度:
${videoMbps} Mbps

映像受信累計:
${(receivedVideoBytes / 1024 / 1024).toFixed(2)} MB

音声受信累計:
${(receivedAudioBytes / 1024 / 1024).toFixed(2)} MB

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

$("stopButton").onclick =
  () => stopSender(true);

$("receiveButton").onclick =
  () => startReceiver();

$("leaveButton").onclick =
  () => stopReceiver(true);

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

  if (audioNode && role === "receiver") {
    audioNode.port.postMessage({
      type: "mute",
      value: audio.muted
    });
  }

  $("muteButton").textContent =
    audio.muted
      ? "🔇 ミュート中"
      : "🔊 音声ON";

  if (!audio.muted && audioContext) {
    audioContext.resume().catch(() => {});
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
