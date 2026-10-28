"use strict";

const $ = id => document.getElementById(id);

const FRAME_VIDEO = 1;
const FRAME_AUDIO = 2;

const MAX_VIDEO_BUFFER = 1024 * 1024;

let ws = null;
let reconnectTimer = null;

let role = null;
let currentRoom = null;

let localStream = null;
let appliedSettings = null;

let senderStarting = false;
let settingsApplying = false;

let activeRooms = [];

let worker = null;
let workerMode = false;

let captureVideo = null;
let captureCanvas = null;
let captureContext = null;
let captureTimer = null;

let captureBusy = false;
let captureToken = 0;

let audioRecorder = null;
let audioMime = "";

let sentFrames = 0;
let sentVideoBytes = 0;
let sentAudioBytes = 0;
let skippedFrames = 0;

let receivedFrames = 0;
let receivedVideoBytes = 0;
let receivedAudioBytes = 0;

let senderHistory = {};
let receiverHistory = {};

let pendingBlob = null;
let decoding = false;
let receiverToken = 0;

let lastFrameAt = 0;

let mediaSource = null;
let sourceBuffer = null;
let audioQueue = [];
let audioObjectURL = null;
let audioGeneration = 0;
let audioStarted = false;
let pendingAudioBytes = 0;

const remoteCanvas = $("remoteCanvas");

const remoteContext = remoteCanvas.getContext(
  "2d",
  {
    alpha: false
  }
);

/* ========================================
   共通
======================================== */

function status(message) {
  $("status").textContent = message;
}

function signal(data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }

  return false;
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
  const size = targetSize(settings);

  const video = {
    frameRate: {
      ideal: settings.fps
    }
  };

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

  if (!actual?.width || !actual?.height) {
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

function updateCaptureInfo() {
  const actual = currentCaptureSize();

  if (!actual || !appliedSettings) {
    $("captureInfo").textContent =
      "画面共有を開始すると情報を表示します。";

    return;
  }

  const size = outputSize();

  $("captureInfo").textContent =
`========== キャプチャ ==========

解像度: ${actual.width}×${actual.height}
設定FPS: ${actual.frameRate ?? "?"}

========== JPEG ==========

送信解像度: ${size?.width ?? "?"}×${size?.height ?? "?"}
目標FPS: ${appliedSettings.fps}
JPEG品質: ${appliedSettings.jpegQuality}

========== 処理方式 ==========

${workerMode
  ? "MediaStreamTrackProcessor + Worker"
  : "Canvas互換モード"}

音声トラック:
${localStream.getAudioTracks().length
  ? "取得成功"
  : "なし"}

※FPSは送信統計で確認できます。`;
}

function updatePreview() {
  const enabled = $("preview").checked;

  $("localVideo").style.display =
    enabled ? "block" : "none";

  $("localVideo").srcObject =
    enabled ? localStream : null;
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
    location.protocol === "https:"
      ? "wss:"
      : "ws:";

  const socket = new WebSocket(
    `${protocol}//${location.host}/video`
  );

  socket.binaryType = "arraybuffer";

  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;

    status("WebSocket接続完了");
  };

  socket.onmessage = event => {
    if (ws !== socket) return;

    if (event.data instanceof ArrayBuffer) {
      handleBinary(event.data);
      return;
    }

    let data;

    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    handleMessage(data);
  };

  socket.onclose = () => {
    if (ws !== socket) return;

    ws = null;

    stopSender(false);
    stopReceiver(false);

    status("サーバー切断。再接続します...");

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

function sendBinary(kind, buffer) {
  if (ws?.readyState !== WebSocket.OPEN) {
    return false;
  }

  const payload = new Uint8Array(
    buffer.byteLength + 1
  );

  payload[0] = kind;

  payload.set(
    new Uint8Array(buffer),
    1
  );

  ws.send(payload);

  return true;
}

/* ========================================
   キャプチャ設定
======================================== */

async function applyCaptureSettings(settings) {
  const track = localStream?.getVideoTracks()[0];

  if (!track) return;

  const size = targetSize(settings);

  const constraints = {
    frameRate: {
      ideal: settings.fps
    }
  };

  if (size) {
    constraints.width = {
      ideal: size.width
    };

    constraints.height = {
      ideal: size.height
    };
  }

  try {
    await track.applyConstraints(constraints);
  } catch (error) {
    console.warn("Capture constraints:", error);
  }

  updateCaptureInfo();
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

  const track = localStream.getVideoTracks()[0];

  let workerTrack;

  try {
    workerTrack = track.clone();

    worker = new Worker(
      "/websocket-worker.js"
    );

    worker.onmessage = event => {
      const data = event.data;

      if (data.type === "ready") {
        status("Worker映像配信を開始しました");
      }

      if (data.type === "frame") {
        if (
          role !== "sender" ||
          !workerMode
        ) {
          return;
        }

        if (
          ws?.readyState !== WebSocket.OPEN ||
          ws.bufferedAmount > MAX_VIDEO_BUFFER
        ) {
          skippedFrames++;
          return;
        }

        if (
          sendBinary(
            FRAME_VIDEO,
            data.buffer
          )
        ) {
          sentFrames++;
          sentVideoBytes += data.buffer.byteLength;
        }

        skippedFrames = Math.max(
          skippedFrames,
          data.skippedFrames || 0
        );
      }

      if (data.type === "error") {
        console.error("Worker:", data.message);
        status(`Workerエラー: ${data.message}`);
      }
    };

    worker.onerror = error => {
      console.error("Worker:", error);
    };

    worker.postMessage({
      type: "start",
      track: workerTrack,
      settings: {
        fps: appliedSettings.fps,
        resolution: appliedSettings.resolution,
        jpegQuality: appliedSettings.jpegQuality
      }
    }, [workerTrack]);

    workerMode = true;

    return true;

  } catch (error) {
    console.warn(
      "Worker非対応。Canvasへ切替:",
      error
    );

    worker?.terminate();
    worker = null;

    try {
      workerTrack?.stop();
    } catch {}

    return false;
  }
}

/* ========================================
   Canvas互換モード
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

  if (ws.bufferedAmount > MAX_VIDEO_BUFFER) {
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

    captureCanvas.width = size.width;
    captureCanvas.height = size.height;

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
      token !== captureToken ||
      !blob
    ) {
      return;
    }

    const buffer = await blob.arrayBuffer();

    if (
      token !== captureToken ||
      buffer.byteLength > 1024 * 1024
    ) {
      skippedFrames++;
      return;
    }

    if (
      ws?.readyState === WebSocket.OPEN &&
      ws.bufferedAmount < MAX_VIDEO_BUFFER
    ) {
      sendBinary(FRAME_VIDEO, buffer);

      sentFrames++;
      sentVideoBytes += buffer.byteLength;

    } else {
      skippedFrames++;
    }

  } catch (error) {
    console.warn(error);
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
    {
      alpha: false
    }
  );

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

/* ========================================
   映像送信開始・停止
======================================== */

async function startVideoCapture() {
  sentFrames = 0;
  sentVideoBytes = 0;
  skippedFrames = 0;

  const success = await startWorkerCapture();

  if (!success) {
    await startCanvasCapture();
  }

  updateCaptureInfo();
}

function stopVideoCapture() {
  if (worker) {
    worker.postMessage({
      type: "stop"
    });

    worker.terminate();
    worker = null;
  }

  workerMode = false;

  stopCanvasCapture();
}

/* ========================================
   音声送信
======================================== */

function startAudioCapture() {
  const tracks = localStream?.getAudioTracks() || [];

  if (!tracks.length) {
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
    console.warn("Opus録音に非対応");
    return;
  }

  try {
    const audioStream = new MediaStream(tracks);

    audioRecorder = new MediaRecorder(
      audioStream,
      {
        mimeType: audioMime,
        audioBitsPerSecond: 128000
      }
    );

    audioRecorder.ondataavailable = async event => {
      if (
        role !== "sender" ||
        !event.data.size
      ) {
        return;
      }

      try {
        const buffer =
          await event.data.arrayBuffer();

        if (
          buffer.byteLength > 256 * 1024 ||
          ws?.readyState !== WebSocket.OPEN
        ) {
          return;
        }

        if (
          ws.bufferedAmount > MAX_VIDEO_BUFFER
        ) {
          return;
        }

        if (
          sendBinary(FRAME_AUDIO, buffer)
        ) {
          sentAudioBytes += buffer.byteLength;
        }

      } catch (error) {
        console.warn("Audio send:", error);
      }
    };

    /*
     * 約250msごとに音声チャンク生成
     */
    audioRecorder.start(250);

  } catch (error) {
    console.warn("Audio capture:", error);
    audioRecorder = null;
  }
}

function stopAudioCapture() {
  if (audioRecorder) {
    audioRecorder.ondataavailable = null;

    if (audioRecorder.state !== "inactive") {
      audioRecorder.stop();
    }

    audioRecorder = null;
  }
}

/* ========================================
   音声受信
======================================== */

function resetAudioReceiver() {
  audioGeneration++;

  audioQueue = [];
  sourceBuffer = null;
  mediaSource = null;

  audioStarted = false;
  pendingAudioBytes = 0;

  const audio = $("remoteAudio");

  audio.pause();
  audio.removeAttribute("src");
  audio.load();

  if (audioObjectURL) {
    URL.revokeObjectURL(audioObjectURL);
    audioObjectURL = null;
  }

  $("audioStatus").textContent =
    "音声待機中";
}

function initializeAudioReceiver() {
  if (!window.MediaSource) {
    $("audioStatus").textContent =
      "このブラウザは音声再生方式に非対応です";

    return false;
  }

  const mime = "audio/webm;codecs=opus";

  if (!MediaSource.isTypeSupported(mime)) {
    $("audioStatus").textContent =
      "WebM/Opus再生に非対応です";

    return false;
  }

  const generation = ++audioGeneration;

  mediaSource = new MediaSource();

  audioObjectURL =
    URL.createObjectURL(mediaSource);

  const audio = $("remoteAudio");

  audio.src = audioObjectURL;

  mediaSource.addEventListener(
    "sourceopen",
    () => {
      if (
        generation !== audioGeneration ||
        mediaSource.readyState !== "open"
      ) {
        return;
      }

      try {
        sourceBuffer =
          mediaSource.addSourceBuffer(mime);

        sourceBuffer.mode = "sequence";

        sourceBuffer.addEventListener(
          "updateend",
          () => {
            if (
              generation !== audioGeneration
            ) {
              return;
            }

            flushAudioQueue();
          }
        );

        flushAudioQueue();

      } catch (error) {
        console.warn("Audio SourceBuffer:", error);

        $("audioStatus").textContent =
          `音声初期化エラー: ${error.message}`;
      }
    },
    {
      once: true
    }
  );

  return true;
}

function flushAudioQueue() {
  if (
    !sourceBuffer ||
    sourceBuffer.updating ||
    !audioQueue.length
  ) {
    return;
  }

  if (
    !mediaSource ||
    mediaSource.readyState !== "open"
  ) {
    return;
  }

  const buffer = audioQueue.shift();

  pendingAudioBytes -= buffer.byteLength;

  try {
    sourceBuffer.appendBuffer(buffer);

    const audio = $("remoteAudio");

    if (!audioStarted) {
      audioStarted = true;

      audio.play().catch(() => {
        $("audioStatus").textContent =
          "音声再生には画面の操作が必要です";
      });
    }

    /*
     * 遅延が大きくなった場合は
     * 再生位置をライブ側に近づける。
     */
    if (
      audio.buffered.length &&
      audio.readyState >= 2
    ) {
      const end = audio.buffered.end(
        audio.buffered.length - 1
      );

      if (end - audio.currentTime > 1.5) {
        audio.currentTime = Math.max(
          0,
          end - 0.4
        );
      }
    }

  } catch (error) {
    console.warn("Audio append:", error);

    $("audioStatus").textContent =
      `音声デコードエラー: ${error.message}`;
  }
}

function receiveAudio(buffer) {
  if (role !== "receiver") return;

  receivedAudioBytes += buffer.byteLength;

  if (!mediaSource) {
    if (!initializeAudioReceiver()) {
      return;
    }
  }

  /*
   * キューが増えすぎた場合は
   * 音声遅延を警告。
   *
   * WebMチャンクを途中で捨てると
   * デコードが壊れる可能性があるため、
   * 無条件に間引かない。
   */
  if (pendingAudioBytes > 2 * 1024 * 1024) {
    $("audioStatus").textContent =
      "音声バッファが増加しています";

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
      });

    role = "sender";
    currentRoom = room;
    appliedSettings = settings;

    const track = localStream.getVideoTracks()[0];

    if (!track) {
      throw new Error(
        "映像トラックを取得できませんでした"
      );
    }

    track.onended = () => {
      stopSender(true);
    };

    await applyCaptureSettings(settings);

    updatePreview();

    signal({
      type: "join",
      role: "sender",
      room,
      name: $("senderName").value,
      memo: $("roomMemo").value
    });

    await startVideoCapture();

    if (settings.audio) {
      startAudioCapture();
    }

    senderHistory = {};
    sentAudioBytes = 0;

    updateCaptureInfo();
    updateButtons();
    renderRooms();

    status(`WebSocket配信開始: ${room}`);

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
    signal({
      type: "leave"
    });
  }

  updateCaptureInfo();
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

    await applyCaptureSettings(appliedSettings);

    if (workerMode && worker) {
      worker.postMessage({
        type: "settings",
        settings: {
          fps: appliedSettings.fps,
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
    {
      type: "image/jpeg"
    }
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
        console.warn("JPEG decode:", error);
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

  const view = new Uint8Array(buffer);

  const kind = view[0];

  const payload = buffer.slice(1);

  if (kind === FRAME_VIDEO) {
    receiveVideo(payload);
  }

  if (kind === FRAME_AUDIO) {
    receiveAudio(payload);
  }
}

/* ========================================
   受信開始
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
    signal({
      type: "leave"
    });
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

    case "room-list": {
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
    }

    case "joined": {
      if (
        data.role !== role ||
        data.room !== currentRoom
      ) {
        break;
      }

      status(`ルーム参加: ${data.room}`);
      break;
    }

    case "sender-ready": {
      if (role === "receiver") {
        status("WebSocket映像を受信中...");
      }

      break;
    }

    case "sender-left": {
      if (role === "receiver") {
        clearVideoReceiver();
        resetAudioReceiver();

        $("receiverStats").textContent =
          "配信終了";

        status("配信が終了しました");
      }

      break;
    }

    case "error": {
      status(`エラー: ${data.message}`);

      /*
       * 配信開始時のエラーなら
       * 画面共有を停止する。
       */
      if (role === "sender") {
        stopSender(true);
        status(`エラー: ${data.message}`);
      }

      break;
    }
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
   メタデータ更新
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
        : (
          Number(videoRate) * 8 / 1e6
        ).toFixed(2);

    const audioKbps =
      audioRate === "?"
        ? "?"
        : (
          Number(audioRate) * 8 / 1000
        ).toFixed(1);

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
          Number(videoRate) * 8 / 1e6
        ).toFixed(2);

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

$("stopButton").onclick = () => {
  stopSender(true);
};

$("receiveButton").onclick = () => {
  startReceiver();
};

$("leaveButton").onclick = () => {
  stopReceiver(true);
};

$("applyButton").onclick = applySettings;

$("preview").onchange = updatePreview;

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

connect();

updateButtons();
updatePreview();

setInterval(updateStats, 1000);
