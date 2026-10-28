"use strict";

const $ = id => document.getElementById(id);

let ws = null;

let role = null;
let currentRoom = null;

let localStream = null;

let captureVideo = null;
let captureCanvas = null;
let captureContext = null;

let sendTimer = null;
let sendingFrame = false;

let senderToken = 0;
let receiverToken = 0;

let appliedSettings = null;

let senderStarting = false;

let sentFrames = 0;
let sentBytes = 0;
let skippedFrames = 0;

let receivedFrames = 0;
let receivedBytes = 0;

let senderHistory = {};
let receiverHistory = {};

let pendingBlob = null;
let decoding = false;

let activeRooms = [];

let reconnectTimer = null;

let lastFrameAt = 0;

const remoteCanvas = $("remoteCanvas");

const remoteContext = remoteCanvas.getContext("2d", {
  alpha: false
});

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

  $("applyButton").disabled = !sending;

  $("roomId").disabled =
    sending || receiving || senderStarting;
}

/* ========================================
   WebSocket接続
======================================== */

function connect() {
  const protocol =
    location.protocol === "https:"
      ? "wss:"
      : "ws:";

  const socket = new WebSocket(
    `${protocol}//${location.host}/video`
  );

  socket.binaryType = "blob";

  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;

    status("WebSocket接続完了");
  };

  socket.onmessage = event => {
    if (ws !== socket) return;

    if (event.data instanceof Blob) {
      if (role === "receiver") {
        receiveFrame(event.data);
      }

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

    status("WebSocket切断。再接続します...");

    clearTimeout(reconnectTimer);

    reconnectTimer = setTimeout(connect, 3000);
  };

  socket.onerror = () => {
    if (ws !== socket) return;

    status("WebSocket通信エラー");
  };
}

/* ========================================
   設定
======================================== */

function readSettings() {
  return {
    resolution: $("resolution").value,
    fps: Number($("fps").value),
    jpegQuality: Number($("jpegQuality").value),
    preview: $("preview").checked
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

function currentCaptureSize() {
  const track = localStream?.getVideoTracks()[0];

  if (!track) return null;

  return track.getSettings();
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

  const output = outputSize();

  $("captureInfo").textContent =
`キャプチャ解像度: ${actual.width}×${actual.height}
キャプチャ設定FPS: ${actual.frameRate ?? "?"}

JPEG送信解像度: ${output?.width ?? "?"}×${output?.height ?? "?"}
目標FPS: ${appliedSettings.fps}
JPEG品質: ${appliedSettings.jpegQuality}

※実際のFPSは送信統計で確認できます。`;
}

/* ========================================
   送信プレビュー
======================================== */

function updatePreview() {
  const enabled = $("preview").checked;

  $("localVideo").style.display =
    enabled ? "block" : "none";

  $("localVideo").srcObject =
    enabled ? localStream : null;
}

/* ========================================
   JPEG送信
======================================== */

function stopCaptureLoop() {
  senderToken++;

  if (sendTimer !== null) {
    clearInterval(sendTimer);
    sendTimer = null;
  }

  sendingFrame = false;

  if (captureVideo) {
    captureVideo.pause();
    captureVideo.srcObject = null;
    captureVideo.remove();

    captureVideo = null;
  }

  captureCanvas = null;
  captureContext = null;
}

async function captureAndSend(token) {
  if (
    token !== senderToken ||
    sendingFrame ||
    role !== "sender" ||
    !localStream ||
    ws?.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  if (ws.bufferedAmount > 1024 * 1024) {
    skippedFrames++;
    return;
  }

  if (
    !captureVideo ||
    captureVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    !captureVideo.videoWidth ||
    !captureVideo.videoHeight
  ) {
    return;
  }

  sendingFrame = true;

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
      token !== senderToken ||
      role !== "sender" ||
      !blob
    ) {
      return;
    }

    if (
      blob.size > 1024 * 1024 ||
      ws?.readyState !== WebSocket.OPEN ||
      ws.bufferedAmount > 1024 * 1024
    ) {
      skippedFrames++;
      return;
    }

    ws.send(blob);

    sentFrames++;
    sentBytes += blob.size;

  } catch (error) {
    console.warn("JPEG capture:", error);
    skippedFrames++;

  } finally {
    if (token === senderToken) {
      sendingFrame = false;
    }
  }
}

function startCaptureLoop() {
  if (sendTimer !== null) {
    clearInterval(sendTimer);
  }

  const token = ++senderToken;

  sendingFrame = false;

  sendTimer = setInterval(() => {
    captureAndSend(token);
  }, 1000 / appliedSettings.fps);
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
        audio: false
      });

    role = "sender";
    currentRoom = room;
    appliedSettings = settings;

    const track = localStream.getVideoTracks()[0];

    track.onended = () => stopSender(true);

    await applyCaptureSettings(settings);

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

    sentFrames = 0;
    sentBytes = 0;
    skippedFrames = 0;

    senderHistory = {};

    startCaptureLoop();

    updatePreview();
    updateCaptureInfo();
    updateButtons();
    renderRooms();

    signal({
      type: "join",
      role: "sender",
      room,
      name: $("senderName").value,
      memo: $("roomMemo").value
    });

    status(`WebSocket配信開始: ${room}`);

  } catch (error) {
    stopCaptureLoop();

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

  stopCaptureLoop();

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
  if (role !== "sender" || !localStream) return;

  appliedSettings = readSettings();

  await applyCaptureSettings(appliedSettings);

  startCaptureLoop();

  updatePreview();
  updateCaptureInfo();

  status("設定を適用しました");
}

/* ========================================
   JPEG受信
======================================== */

function clearReceiver() {
  receiverToken++;

  pendingBlob = null;
  decoding = false;

  receivedFrames = 0;
  receivedBytes = 0;

  receiverHistory = {};
  lastFrameAt = 0;

  remoteCanvas.width = 0;
  remoteCanvas.height = 0;
}

function receiveFrame(blob) {
  if (role !== "receiver") return;

  pendingBlob = blob;

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
      receivedBytes += blob.size;

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

  clearReceiver();

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

  clearReceiver();

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
   WebSocketメッセージ
======================================== */

function handleMessage(data) {
  switch (data.type) {
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
      status(`ルーム参加: ${data.room}`);
      break;

    case "sender-ready":
      status("WebSocket映像を受信中...");
      break;

    case "sender-left":
      if (role === "receiver") {
        clearReceiver();
        status("配信が終了しました");
      }
      break;

    case "error":
      status(`エラー: ${data.message}`);
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
   名前・メモ更新
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

    const byteRate = rate(
      senderHistory,
      "bytes",
      sentBytes
    );

    const mbps =
      byteRate === "?"
        ? "?"
        : (Number(byteRate) * 8 / 1e6).toFixed(2);

    $("senderStats").textContent =
`========== WebSocket送信 ==========

目標FPS: ${appliedSettings?.fps ?? "?"}
実測送信FPS: ${fps}
送信累計: ${sentFrames}
スキップ累計: ${skippedFrames}

通信速度: ${mbps} Mbps
送信累計: ${(sentBytes / 1024 / 1024).toFixed(2)} MB
送信バッファ: ${ws?.bufferedAmount ?? "?"} bytes
`;
  }

  if (role === "receiver") {
    const fps = rate(
      receiverHistory,
      "frames",
      receivedFrames
    );

    const byteRate = rate(
      receiverHistory,
      "bytes",
      receivedBytes
    );

    const mbps =
      byteRate === "?"
        ? "?"
        : (Number(byteRate) * 8 / 1e6).toFixed(2);

    $("receiverStats").textContent =
`========== WebSocket受信 ==========

実測表示FPS: ${fps}
表示累計: ${receivedFrames}

解像度: ${remoteCanvas.width || "?"}×${remoteCanvas.height || "?"}

通信速度: ${mbps} Mbps
受信累計: ${(receivedBytes / 1024 / 1024).toFixed(2)} MB
最終フレーム:
${lastFrameAt ? `${Date.now() - lastFrameAt} ms前` : "未受信"}
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

$("fullscreen").onclick = () => {
  remoteCanvas.requestFullscreen?.();
};

/* ========================================
   初期化
======================================== */

connect();

updateButtons();
updatePreview();

setInterval(updateStats, 1000);
