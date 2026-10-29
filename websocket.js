"use strict";

(() => {

const $ = id => document.getElementById(id);

/* ========================================
   WebSocket Caster v27.4
   AV Sync Experiment
======================================== */

const FRAME_VIDEO = 1;
const FRAME_AUDIO = 2;

const MAX_BUFFER = 1024 * 1024;

/*
  v27.4 バイナリ形式

  映像:
  [1byte 種別]
  [8byte タイムスタンプ]
  [JPEG]

  音声:
  [1byte 種別]
  [8byte タイムスタンプ]
  [4byte サンプルレート]
  [1byte チャンネル数]
  [PCM Int16]

  タイムスタンプはUnix時刻ミリ秒。
  音声の時刻はチャンク先頭サンプルの推定時刻。
*/

const VIDEO_HEADER_SIZE = 8;
const AUDIO_HEADER_SIZE = 13;

/* ========================================
   同期設定
======================================== */

const AUDIO_PACKET_MS = 20;

// 通常再生で確保する音声バッファ
const AUDIO_TARGET_BUFFER_MS = 220;

// 音声がこれ以上蓄積した場合に補正
const AUDIO_MAX_BUFFER_MS = 1500;

// 補正直後に残す音声
const AUDIO_RECOVERY_BUFFER_MS = 250;

// 大きな補正の最短間隔
const SYNC_COOLDOWN_MS = 5000;

// 映像フレーム保持数
const VIDEO_QUEUE_LIMIT = 120;

// 映像フレームを待つ最大時間
const VIDEO_MAX_WAIT_MS = 1500;

// タイムスタンプ補正の上限
const MAX_CLOCK_OFFSET_MS = 10000;

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
   AudioWorklet
======================================== */

let audioContext = null;
let audioSource = null;
let audioNode = null;

let audioWorkletURL = null;

let audioMode = "なし";
let audioSampleRate = 48000;
let audioChannels = 2;

let audioSendSequence = 0;
let audioReceiveSequence = 0;

let audioCapturedAt = 0;

let audioGeneration = 0;

let audioReady = false;
let audioStarting = false;

let audioPlaybackTimestamp = 0;
let audioPlaybackReportedAt = 0;

let audioQueueDuration = 0;

let audioCorrections = 0;
let audioDroppedPackets = 0;

let lastSyncCorrection = 0;

let audioClockOffset = null;

let audioMonitorEnabled = false;

/* ========================================
   音声フォールバック・診断互換
======================================== */

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

  audioCurrentSettings = tracks.map(track =>
    track.getSettings()
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

  if ($("audioMonitorButton")) {
    $("audioMonitorButton").textContent =
      "🎧 取得音声を試聴";
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
   WebSocket接続
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

    status(
      "WebSocket切断。3秒後に再接続します"
    );

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
    new Uint8Array(samples.buffer)
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

    const width =
      capabilities?.width?.max;

    const height =
      capabilities?.height?.max;

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
    worker = new Worker(
      "/websocket-worker.js"
    );

    workerReady = false;
    workerBusy = false;

    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error("Worker起動タイムアウト")
        );
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

            sentVideoBytes +=
              data.buffer.byteLength;
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
            console.warn(
              "Worker:",
              data.message
            );
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
        resolution:
          appliedSettings.resolution,

        jpegQuality:
          appliedSettings.jpegQuality
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
    console.warn(
      "Worker利用不可:",
      error
    );

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

      const interval =
        1000 / appliedSettings.fps;

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

      /*
        VideoFrameが取得された時点の時刻を
        JPEGフレームに対応付ける。

        Workerは同時に1フレームだけ処理する。
      */

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

        console.warn(
          "VideoFrame:",
          error
        );
      }
    }

  } catch (error) {
    if (processorRunning) {
      console.warn(
        "Processor:",
        error
      );

      await stopWorkerCapture();

      if (
        role === "sender" &&
        localStream
      ) {
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

    if (
      !blob ||
      token !== captureToken
    ) {
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
      if (
        sendVideoBinary(
          buffer,
          Date.now()
        )
      ) {
        sentFrames++;

        sentVideoBytes +=
          buffer.byteLength;
      }

    } else {
      skippedFrames++;
    }

  } catch (error) {
    console.warn(
      "Canvas:",
      error
    );

    skippedFrames++;

  } finally {
    captureBusy = false;
  }
}

async function startCanvasCapture() {
  workerMode = false;

  captureCanvas =
    document.createElement("canvas");

  captureContext =
    captureCanvas.getContext(
      "2d",
      { alpha: false }
    );

  if (!captureContext) {
    throw new Error(
      "Canvas初期化失敗"
    );
  }

  captureVideo =
    document.createElement("video");

  captureVideo.autoplay = true;
  captureVideo.muted = true;
  captureVideo.playsInline = true;

  captureVideo.style.position = "fixed";
  captureVideo.style.width = "1px";
  captureVideo.style.height = "1px";
  captureVideo.style.opacity = "0";
  captureVideo.style.pointerEvents = "none";

  document.body.appendChild(
    captureVideo
  );

  captureVideo.srcObject =
    localStream;

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

  const success =
    await startWorkerCapture();

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
   AudioWorkletプログラム
======================================== */

const AUDIO_WORKLET_CODE = `

class CasterAudioProcessor extends AudioWorkletProcessor {

  constructor(options) {
    super();

    const settings =
      options.processorOptions || {};

    this.mode = settings.mode || "receiver";

    this.packetFrames = Math.max(
      128,
      Math.round(sampleRate * 0.02)
    );

    this.captureBuffer = new Float32Array(
      this.packetFrames * 2
    );

    this.captureOffset = 0;

    this.queue = [];

    this.queueFrames = 0;

    this.playing = false;

    this.currentPacket = null;
    this.packetOffset = 0;

    this.lastTimestamp = 0;

    this.reportCounter = 0;

    this.muted = false;

    this.targetFrames = Math.round(
      sampleRate * 0.22
    );

    this.maxFrames = Math.round(
      sampleRate * 1.5
    );

    this.recoveryFrames = Math.round(
      sampleRate * 0.25
    );

    this.lastCorrectionFrame = -Infinity;
    this.renderedFrames = 0;

    this.port.onmessage = event => {
      const data = event.data;

      if (data.type === "packet") {
        this.addPacket(data);
      }

      if (data.type === "mute") {
        this.muted = !!data.value;
      }

      if (data.type === "reset") {
        this.queue = [];
        this.queueFrames = 0;
        this.currentPacket = null;
        this.packetOffset = 0;
        this.playing = false;
        this.lastTimestamp = 0;
      }
    };
  }

  addPacket(data) {
    if (this.mode !== "receiver") return;

    const samples = new Int16Array(
      data.buffer
    );

    const channels = Math.max(
      1,
      Math.min(2, data.channels || 2)
    );

    const frames = Math.floor(
      samples.length / channels
    );

    if (!frames) return;

    const packet = {
      samples,
      channels,
      frames,
      timestamp: data.timestamp,
      sampleRate: data.sampleRate || sampleRate
    };

    this.queue.push(packet);

    this.queueFrames += frames;

    const bufferedMs =
      this.queueFrames / sampleRate * 1000;

    const canCorrect =
      this.renderedFrames -
      this.lastCorrectionFrame >
      sampleRate * 5;

    if (
      bufferedMs > 1500 &&
      canCorrect
    ) {
      this.recover();
    }
  }

  recover() {
    const target = Math.round(
      sampleRate * 0.25
    );

    let dropped = 0;

    /*
      古い音声を破棄して、
      新しい音声を約250ms残す。
    */

    while (
      this.queueFrames > target &&
      this.queue.length > 1
    ) {
      const packet = this.queue.shift();

      this.queueFrames -= packet.frames;

      dropped += packet.frames;
    }

    this.currentPacket = null;
    this.packetOffset = 0;

    this.lastCorrectionFrame =
      this.renderedFrames;

    this.port.postMessage({
      type: "correction",
      droppedMs:
        dropped / sampleRate * 1000
    });
  }

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
          j < this.packetFrames * 2;
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

        this.port.postMessage({
          type: "capture",
          buffer: pcm.buffer,
          frames: this.packetFrames,
          sampleRate
        }, [pcm.buffer]);

        this.captureOffset = 0;
      }
    }
  }

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

    if (!this.playing) {
      if (
        this.queueFrames >=
        this.targetFrames
      ) {
        this.playing = true;
      } else {
        return;
      }
    }

    for (let i = 0; i < left.length; i++) {

      if (!this.currentPacket) {
        this.currentPacket =
          this.queue.shift() || null;

        this.packetOffset = 0;
      }

      const packet = this.currentPacket;

      if (!packet) {
        this.playing = false;
        break;
      }

      const offset =
        this.packetOffset *
        packet.channels;

      const l =
        packet.samples[offset] / 32768;

      const r = packet.channels > 1
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
        packet.sampleRate * 1000;

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

    this.reportCounter++;

    if (
      this.reportCounter >= 8
    ) {
      this.reportCounter = 0;

      this.port.postMessage({
        type: "playback",
        timestamp: this.lastTimestamp,

        bufferedMs:
          this.queueFrames /
          sampleRate * 1000,

        playing: this.playing
      });
    }
  }

  process(inputs, outputs) {
    this.renderedFrames +=
      outputs[0]?.[0]?.length || 128;

    if (this.mode === "sender") {
      this.capture(inputs);

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
  if (
    typeof AudioContext === "undefined" &&
    typeof webkitAudioContext === "undefined"
  ) {
    throw new Error(
      "AudioContext非対応"
    );
  }

  const Context =
    window.AudioContext ||
    window.webkitAudioContext;

  const context = new Context({
    latencyHint: "interactive"
  });

  if (!context.audioWorklet) {
    await context.close();

    throw new Error(
      "AudioWorklet非対応"
    );
  }

  const blob = new Blob(
    [AUDIO_WORKLET_CODE],
    { type: "text/javascript" }
  );

  const url = URL.createObjectURL(blob);

  try {
    await context.audioWorklet.addModule(url);

  } catch (error) {
    await context.close();

    URL.revokeObjectURL(url);

    throw error;
  }

  const node = new AudioWorkletNode(
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

  audioWorkletURL = url;

  return {
    context,
    node
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
      await result.context.close();
      return;
    }

    audioContext = result.context;
    audioNode = result.node;

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

    /*
      AudioWorkletを動作させるため、
      無音出力を接続する。

      送信音声をスピーカーへ流さない。
    */

    audioNode.connect(
      audioContext.destination
    );

    audioMode = "AudioWorklet PCM16";

    audioSendSequence = 0;

    audioCapturedAt = Date.now();

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
        チャンク末尾を受け取った時刻から
        音声チャンク先頭の時刻を推定。
      */

      const timestamp =
        Date.now() - duration;

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
    console.warn(
      "AudioWorklet送信:",
      error
    );

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
    URL.revokeObjectURL(
      audioWorkletURL
    );

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

      await result.context.close();

      return;
    }

    audioContext = result.context;
    audioNode = result.node;

    audioSampleRate =
      audioContext.sampleRate;

    audioNode.connect(
      audioContext.destination
    );

    const audio = $("remoteAudio");

    audioNode.port.postMessage({
      type: "mute",
      value: audio.muted
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

        if (data.playing) {
          $("audioStatus").textContent =
            "PCM音声再生中";
        }
      }

      if (data.type === "correction") {
        audioCorrections++;

        audioDroppedPackets++;

        lastSyncCorrection =
          performance.now();

        /*
          音声が追いついたら、
          古い映像フレームも削除する。
        */

        discardOldVideoFrames();

        $("audioStatus").textContent =
          `音声同期補正: ${Math.round(data.droppedMs)}ms`;
      }
    };

    await audioContext.resume();

    audioReady = true;

    audioMode = "AudioWorklet PCM16";

    $("audioStatus").textContent =
      "PCM音声受信中";

  } catch (error) {
    console.warn(
      "AudioWorklet受信:",
      error
    );

    $("audioStatus").textContent =
      `音声再生エラー: ${error.message}`;

  } finally {
    audioStarting = false;
  }
}

/* ========================================
   音声受信
======================================== */

let pendingAudioPackets = [];

function receiveAudio(buffer) {
  if (role !== "receiver") return;

  if (
    buffer.byteLength <
    AUDIO_HEADER_SIZE + 2
  ) {
    return;
  }

  receivedAudioBytes +=
    buffer.byteLength;

  const view =
    new DataView(buffer);

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

  audioReceiveSequence++;

  lastAudioPacketAt = Date.now();

  /*
    初回受信時刻から時計差を推定する。

    送信側と受信側の時計差、および
    ネットワーク遅延が混ざった概算値。
  */

  const offset =
    Date.now() - timestamp;

  if (
    audioClockOffset === null ||
    offset < audioClockOffset
  ) {
    audioClockOffset = offset;
  }

  if (!audioReady) {
    pendingAudioPackets.push({
      buffer: samples,
      timestamp,
      sampleRate,
      channels
    });

    if (
      pendingAudioPackets.length > 50
    ) {
      pendingAudioPackets.shift();
    }

    initializeAudioReceiver();
    return;
  }

  audioNode.port.postMessage({
    type: "packet",
    buffer: samples,
    timestamp,
    sampleRate,
    channels
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

  audioCorrections = 0;
  audioDroppedPackets = 0;

  lastSyncCorrection = 0;

  audioClockOffset = null;

  audioStarting = false;

  $("audioStatus").textContent =
    "音声待機中";
}

/* ========================================
   映像受信
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
   JPEGフレーム受信
======================================== */

function receiveVideo(buffer) {
  if (role !== "receiver") return;

  if (
    buffer.byteLength <=
    VIDEO_HEADER_SIZE
  ) {
    return;
  }

  const view =
    new DataView(buffer);

  const timestamp =
    readTimestamp(view, 0);

  if (!Number.isFinite(timestamp)) {
    return;
  }

  const jpeg =
    buffer.slice(VIDEO_HEADER_SIZE);

  receivedVideoBytes +=
    jpeg.byteLength;

  latestVideoTimestamp =
    timestamp;

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
   映像・音声同期
======================================== */

function getEstimatedAudioTimestamp() {
  if (
    !audioReady ||
    !audioPlaybackTimestamp
  ) {
    return null;
  }

  const elapsed =
    performance.now() -
    audioPlaybackReportedAt;

  /*
    AudioWorkletから最後に報告された
    再生時刻を使う。

    ただし推定時間は最大100ms。
  */

  return (
    audioPlaybackTimestamp +
    Math.max(
      0,
      Math.min(100, elapsed)
    )
  );
}

function discardOldVideoFrames() {
  const audioTime =
    getEstimatedAudioTimestamp();

  if (audioTime === null) {
    return;
  }

  while (
    videoQueue.length > 1 &&
    videoQueue[1].timestamp <
      audioTime - 100
  ) {
    videoQueue.shift();
  }
}

let videoDecodeBusy = false;

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

  /*
    音声がある場合は、
    音声の再生時刻に近い映像を選ぶ。

    音声がない場合は最新フレームを表示。
  */

  if (audioTime !== null) {
    while (
      videoQueue.length &&
      videoQueue[0].timestamp <=
        audioTime + 30
    ) {
      selected =
        videoQueue.shift();
    }

    /*
      音声が長時間止まった場合は
      映像も永久には停止させない。
    */

    if (
      !selected &&
      videoQueue.length &&
      Date.now() -
        videoQueue[0].timestamp >
        VIDEO_MAX_WAIT_MS +
        (videoClockOffset || 0)
    ) {
      selected =
        videoQueue.pop();

      videoQueue = [];
    }

  } else {
    selected =
      videoQueue.pop();

    videoQueue = [];
  }

  if (!selected) return;

  videoDecodeBusy = true;

  const token =
    videoReceiverToken;

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
    console.warn(
      "JPEG decode:",
      error
    );

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

  const view =
    new DataView(buffer);

  const kind =
    view.getUint8(0);

  const payload =
    buffer.slice(1);

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

  if (
    ws?.readyState !== WebSocket.OPEN
  ) {
    status(
      "WebSocketに接続されていません"
    );
    return;
  }

  const room =
    $("roomId").value;

  if (!room.trim()) {
    status(
      "ルームIDを入力してください"
    );
    return;
  }

  senderStarting = true;

  updateButtons();

  const settings =
    readSettings();

  try {
    localStream =
      await navigator.mediaDevices.getDisplayMedia({
        video:
          initialConstraints(settings),

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
      throw new Error(
        "映像トラックなし"
      );
    }

    audioInitialSettings =
      localStream.getAudioTracks().map(
        track => track.getSettings()
      );

    role = "sender";
    currentRoom = room;

    appliedSettings = settings;

    track.onended = () =>
      stopSender(true);

    await applyCaptureSettings(
      settings
    );

    updatePreview();

    updateAudioDiagnostics();

    signal({
      type: "join",
      role: "sender",
      room,

      name:
        $("senderName").value,

      memo:
        $("roomMemo").value
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
      `映像処理: ${
        workerMode ? "Worker" : "Canvas"
      }\n` +
      `音声: ${audioMode}`
    );

  } catch (error) {
    stopVideoCapture();
    stopAudioCapture();

    if (localStream) {
      for (
        const track of
        localStream.getTracks()
      ) {
        track.stop();
      }
    }

    localStream = null;

    role = null;
    currentRoom = null;

    appliedSettings = null;

    status(
      `画面共有エラー: ${error.message}`
    );

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
    for (
      const track of
      localStream.getTracks()
    ) {
      track.onended = null;
      track.stop();
    }
  }

  localStream = null;
  appliedSettings = null;

  $("localVideo").srcObject = null;

  $("senderStats").textContent =
    "未配信";

  role = null;
  currentRoom = null;

  if (sendLeave) {
    signal({
      type: "leave"
    });
  }

  updateCaptureInfo();
  updateAudioDiagnostics();

  updateButtons();
  renderRooms();

  status(
    "配信を停止しました"
  );
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
    appliedSettings =
      readSettings();

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

    status(
      "設定を適用しました"
    );

  } catch (error) {
    status(
      `設定変更エラー: ${error.message}`
    );

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
    status(
      "ルームIDを入力してください"
    );
    return;
  }

  if (
    ws?.readyState !== WebSocket.OPEN
  ) {
    status(
      "WebSocketに接続されていません"
    );
    return;
  }

  if (
    role === "sender" ||
    senderStarting
  ) {
    status(
      "配信中は受信できません"
    );
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

  status(
    `受信待機中: ${room}`
  );
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
    signal({
      type: "leave"
    });
  }

  $("receiverStats").textContent =
    "未接続";

  updateButtons();

  status(
    "受信を停止しました"
  );
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
      activeRooms =
        data.rooms || [];

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
        status(
          `ルーム参加: ${data.room}`
        );
      }
      break;

    case "sender-ready":
      if (role === "receiver") {
        status(
          "WebSocket映像を受信中..."
        );
      }
      break;

    case "sender-left":
      if (role === "receiver") {
        clearVideoReceiver();
        resetAudioReceiver();

        $("receiverStats").textContent =
          "配信終了";

        status(
          "配信が終了しました"
        );
      }
      break;

    case "error":
      status(
        `エラー: ${data.message}`
      );

      if (role === "sender") {
        stopSender(true);

        status(
          `エラー: ${data.message}`
        );
      }
      break;
  }
}

/* ========================================
   ルーム一覧
======================================== */

function renderRooms() {
  const container =
    $("roomList");

  container.replaceChildren();

  const visible =
    activeRooms.filter(room =>
      !(
        role === "sender" &&
        room.id === currentRoom
      )
    );

  $("roomCount").textContent =
    `現在 ${visible.length} 件の配信があります`;

  if (!visible.length) {
    const p =
      document.createElement("p");

    p.className = "small";

    p.textContent =
      "現在、ほかに配信中のルームはありません。";

    container.appendChild(p);
    return;
  }

  for (const room of visible) {
    const card =
      document.createElement("div");

    card.className = "room-card";

    const title =
      document.createElement("div");

    title.className = "room-title";

    title.textContent =
      `🟢 ${room.id}`;

    const name =
      document.createElement("div");

    name.className = "room-name";

    name.textContent =
      `配信者：${room.name}`;

    card.append(title, name);

    if (room.memo) {
      const memo =
        document.createElement("div");

      memo.className = "room-memo";

      memo.textContent =
        room.memo;

      card.appendChild(memo);
    }

    const button =
      document.createElement("button");

    button.className = "room-watch";

    button.textContent = "📺 視聴";

    button.disabled =
      role === "sender" ||
      senderStarting;

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

    name:
      $("senderName").value,

    memo:
      $("roomMemo").value
  });
}

/* ========================================
   統計
======================================== */

function rate(history, key, count) {
  const now =
    performance.now();

  const previous =
    history[key];

  history[key] = {
    count,
    time: now
  };

  if (!previous) return "?";

  const seconds =
    (now - previous.time) / 1000;

  if (seconds <= 0) return "?";

  return (
    (count - previous.count) /
    seconds
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
        : (
            Number(videoRate) *
            8 / 1e6
          ).toFixed(2);

    const audioMbps =
      audioRate === "?"
        ? "?"
        : (
            Number(audioRate) *
            8 / 1e6
          ).toFixed(2);

    $("senderStats").textContent =
`========== WebSocket送信 v27.4 ==========

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
        : (
            Number(videoRate) *
            8 / 1e6
          ).toFixed(2);

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

    const audioDelay =
      audioClockOffset !== null &&
      audioTime !== null
        ? (
            Date.now() -
            audioTime -
            audioClockOffset
          ).toFixed(0)
        : "?";

    $("receiverStats").textContent =
`========== WebSocket受信 v27.4 ==========

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
${audioReady ? "AudioWorklet動作中" : "待機中"}

受信パケット:
${audioReceiveSequence}

音声バッファ:
${audioQueueDuration.toFixed(0)} ms

自動補正回数:
${audioCorrections}

【AV同期】
映像と音声の時刻差:
${syncDifference} ms

音声の推定追加遅延:
${audioDelay} ms

※時刻差は送信側で取得した
推定タイムスタンプに基づきます。

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

$("roomId").addEventListener(
  "input",
  () => {
    $("roomId").dataset.edited = "1";
  }
);

$("senderName").addEventListener(
  "input",
  updateMetadata
);

$("roomMemo").addEventListener(
  "input",
  updateMetadata
);

$("sendButton").onclick =
  startSender;

$("stopButton").onclick =
  () => stopSender(true);

$("receiveButton").onclick =
  () => startReceiver();

$("leaveButton").onclick =
  () => stopReceiver(true);

$("applyButton").onclick =
  applySettings;

$("preview").onchange =
  updatePreview;

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

  if (
    !audio.muted &&
    audioContext
  ) {
    audioContext.resume().catch(() => {});
  }
};

/* ========================================
   初期化
======================================== */

$("remoteVideo").classList.add(
  "hidden"
);

$("remoteCanvas").classList.remove(
  "hidden"
);

connect();

updateButtons();
updatePreview();

setInterval(
  updateStats,
  1000
);

setInterval(() => {
  signal({
    type: "ping"
  });
}, 15000);

})();
