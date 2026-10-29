"use strict";

(() => {
const $ = id => document.getElementById(id);

const MAX_BITRATE = 20_000_000;
const DISCONNECT_TIMEOUT = 8000;
const RESTART_COOLDOWN = 15000;

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

let ws = null;
let reconnectTimer = null;

let role = null;
let currentRoom = null;
let localStream = null;
let appliedSettings = null;

let originalCaptureSize = null;
let initialCaptureFPS = null;
let captureWarning = "";

let senderStarting = false;
let settingsApplying = false;

let receiverPeer = null;
let receiverGeneration = null;
let receiverHistory = {};

let generationCounter = 0;
const peers = new Map();
const senderHistory = new Map();
const pendingReceiverICE = new Map();

let activeRooms = [];

let receiverDisconnectedAt = 0;
let lastReceiverRestart = 0;

let senderSession = 0;
let receiverSession = 0;

let audioMonitoring = false;
let audioProcessingRequested = false;

let audioInitialSettings = [];
let audioCurrentSettings = [];

const receivedStream = new MediaStream();

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

  $("audioMonitorButton").disabled = !hasAudio;
  $("audioProcessingButton").disabled = !hasAudio;
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
    `${protocol}//${location.host}/signal`
  );

  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    status("✅ WebRTCシグナリング接続完了");
  };

  socket.onmessage = event => {
    if (ws !== socket) return;

    try {
      const data = JSON.parse(event.data);

      Promise.resolve(handleSignal(data)).catch(error => {
        console.error(error);
        status(`通信処理エラー: ${error.message}`);
      });

    } catch (error) {
      console.warn("Signal:", error);
    }
  };

  socket.onclose = () => {
    if (ws !== socket) return;

    ws = null;

    stopSender(false);
    stopReceiver(false);

    status("サーバーとの接続が切断されました");

    clearTimeout(reconnectTimer);

    reconnectTimer = setTimeout(connect, 3000);
  };

  socket.onerror = () => {
    if (ws !== socket) return;
    status("WebRTCシグナリング通信エラー");
  };
}

/* ========================================
   設定
======================================== */

function readSettings() {
  return {
    resolution: $("resolution").value,
    fps: $("fps").value,
    priority: $("priority").value,
    codec: $("codec").value,
    hint: $("hint").value,
    bitrate: $("bitrate").value,
    audio: $("audioShare").checked,
    preview: $("preview").checked
  };
}

function requestedFPS(settings) {
  if (
    settings.fps === "auto" ||
    settings.fps === "browser"
  ) {
    return null;
  }

  return Number(settings.fps);
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

function initialCaptureConstraints(settings) {
  const video = {};

  const size = targetSize(settings);
  const fps = requestedFPS(settings);

  if (size) {
    video.width = { ideal: size.width };
    video.height = { ideal: size.height };
  }

  if (fps !== null) {
    video.frameRate = { ideal: fps };
  }

  return Object.keys(video).length ? video : true;
}

function displayConstraints(settings) {
  return {
    video: initialCaptureConstraints(settings),
    audio: settings.audio
      ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      : false
  };
}

function currentCaptureSize() {
  return localStream
    ?.getVideoTracks()[0]
    ?.getSettings() || null;
}

/* ========================================
   音声診断
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
    `サンプルレート: ${value("sampleRate")}`,
    `サンプルサイズ: ${value("sampleSize")}`
  ].join("\n");
}

function updateAudioDiagnostics() {
  const tracks = localStream?.getAudioTracks() || [];

  if (!tracks.length) {
    $("audioDiagnostics").textContent =
      "音声トラックなし\n共有画面で音声を有効にしてください。";

    updateButtons();
    return;
  }

  audioCurrentSettings =
    tracks.map(track => track.getSettings());

  $("audioDiagnostics").textContent =
`========== 音声診断 ==========

取得トラック数: ${tracks.length}

【取得直後】
${audioInitialSettings.map(audioSettingsText).join("\n\n")}

【現在】
${audioCurrentSettings.map(audioSettingsText).join("\n\n")}

試聴: ${audioMonitoring ? "ON" : "OFF"}

※「情報なし」は無効化成功を意味しません。
※音声処理OFFはブラウザが対応する場合のみ有効です。`;

  updateButtons();
}

async function disableAudioProcessing() {
  if (!localStream) return;

  const tracks = localStream.getAudioTracks();

  for (const track of tracks) {
    const supported = track.getCapabilities?.() || {};
    const constraints = {};

    for (const key of [
      "echoCancellation",
      "noiseSuppression",
      "autoGainControl"
    ]) {
      if (key in supported) {
        constraints[key] = false;
      }
    }

    if (!Object.keys(constraints).length) {
      console.log(
        "音声処理の制約がトラックに公開されていません"
      );
      continue;
    }

    try {
      await track.applyConstraints(constraints);
    } catch (error) {
      console.warn("Audio constraints:", error);
    }
  }

  audioProcessingRequested = true;
  updateAudioDiagnostics();

  status("音声処理OFFを要求しました。設定表示を確認してください");
}

function stopAudioMonitor() {
  const audio = $("audioMonitor");

  audio.pause();
  audio.srcObject = null;

  audioMonitoring = false;

  $("audioMonitorButton").textContent =
    "🎧 取得音声を試聴";
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

  audio.srcObject = new MediaStream(tracks);
  audio.volume = 1;
  audio.muted = false;

  try {
    await audio.play();

    audioMonitoring = true;

    $("audioMonitorButton").textContent =
      "■ 試聴停止";

  } catch (error) {
    console.warn("Audio monitor:", error);
    status(`音声試聴エラー: ${error.message}`);
  }

  updateAudioDiagnostics();
}

/* ========================================
   キャプチャ
======================================== */

async function applyCaptureConstraints(settings) {
  const track = localStream?.getVideoTracks()[0];

  if (!track) return;

  track.contentHint = settings.hint;

  captureWarning = "";

  const size = targetSize(settings);
  const fps = requestedFPS(settings);

  const constraints = {};

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

    } else if (originalCaptureSize) {
      constraints.width = {
        ideal: originalCaptureSize.width
      };

      constraints.height = {
        ideal: originalCaptureSize.height
      };
    }
  }

  if (fps !== null) {
    constraints.frameRate = { ideal: fps };
  }

  try {
    await track.applyConstraints(constraints);
  } catch (error) {
    captureWarning =
      `キャプチャ設定変更失敗: ${error.message}`;

    console.warn(error);
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

  const target = targetSize(appliedSettings);
  const fps = requestedFPS(appliedSettings);

  $("captureInfo").textContent =
`========== WebRTCキャプチャ ==========

開始直後:
${originalCaptureSize?.width ?? "?"}×${originalCaptureSize?.height ?? "?"}

開始直後FPS:
${initialCaptureFPS ?? "?"}

現在の解像度:
${actual.width}×${actual.height}

希望解像度:
${target ? `${target.width}×${target.height}` : "元画質"}

希望FPS:
${fps ?? "自動"}

設定FPS:
${actual.frameRate ?? "?"}

送信FPS上限:
${fps ?? "制限なし"}

${captureWarning}

※実測FPSは送信統計で確認してください。`;
}

function updatePreview() {
  const video = $("localVideo");
  const enabled = $("preview").checked;

  video.style.display =
    enabled ? "block" : "none";

  video.srcObject =
    enabled ? localStream : null;
}

/* ========================================
   WebRTCコーデック
======================================== */

function setCodecPreference(transceiver, codec) {
  if (codec === "auto") return;

  const capabilities =
    RTCRtpSender.getCapabilities?.("video");

  if (!capabilities) return;

  const preferred = [];
  const others = [];

  for (const item of capabilities.codecs) {
    const mime = item.mimeType.toLowerCase();

    const match =
      codec === "h264"
        ? mime === "video/h264"
        : mime === "video/vp8";

    (match ? preferred : others).push(item);
  }

  if (preferred.length) {
    try {
      transceiver.setCodecPreferences([
        ...preferred,
        ...others
      ]);
    } catch (error) {
      console.warn("Codec:", error);
    }
  }
}

function calculateScale(settings) {
  const actual = currentCaptureSize();
  const target = targetSize(settings);

  if (!actual || !target) return 1;

  return Math.max(
    1,
    actual.width / target.width,
    actual.height / target.height
  );
}

async function configureSender(sender, settings, track) {
  const params = sender.getParameters();

  if (!params.encodings?.length) {
    params.encodings = [{}];
  }

  const encoding = params.encodings[0];

  encoding.scaleResolutionDownBy =
    calculateScale(settings);

  if (settings.bitrate !== "auto") {
    encoding.maxBitrate = Math.min(
      Number(settings.bitrate),
      MAX_BITRATE
    );
  } else {
    delete encoding.maxBitrate;
  }

  const fps = requestedFPS(settings);

  if (fps !== null) {
    encoding.maxFramerate = fps;
  } else {
    delete encoding.maxFramerate;
  }

  params.degradationPreference = settings.priority;

  try {
    await sender.setParameters(params);
  } catch (error) {
    console.warn("Sender parameters:", error);
  }

  track.contentHint = settings.hint;
}

/* ========================================
   PeerConnection
======================================== */

function closeSenderPeer(receiverId) {
  const entry = peers.get(receiverId);

  if (entry) {
    entry.pc.onicecandidate = null;
    entry.pc.onconnectionstatechange = null;

    entry.pc.close();
    peers.delete(receiverId);
  }

  senderHistory.delete(receiverId);
}

async function makeOffer(receiverId) {
  if (
    role !== "sender" ||
    !localStream ||
    !appliedSettings
  ) {
    return;
  }

  const session = senderSession;

  closeSenderPeer(receiverId);

  const pc = new RTCPeerConnection(rtcConfig);
  const generation = ++generationCounter;

  const entry = {
    pc,
    generation,
    disconnectedAt: 0,
    lastRestart: Date.now(),
    pendingICE: []
  };

  peers.set(receiverId, entry);

  const isCurrent = () =>
    role === "sender" &&
    senderSession === session &&
    peers.get(receiverId) === entry;

  pc.onicecandidate = event => {
    if (!event.candidate || !isCurrent()) return;

    signal({
      type: "ice",
      receiverId,
      generation,
      candidate: event.candidate
    });
  };

  pc.onconnectionstatechange = () => {
    if (!isCurrent()) return;

    if (pc.connectionState === "connected") {
      entry.disconnectedAt = 0;
    }
  };

  try {
    for (const track of localStream.getTracks()) {
      if (!isCurrent()) return;

      if (track.kind === "video") {
        const transceiver = pc.addTransceiver(track, {
          direction: "sendonly",
          streams: [localStream]
        });

        setCodecPreference(
          transceiver,
          appliedSettings.codec
        );

        await configureSender(
          transceiver.sender,
          appliedSettings,
          track
        );

      } else {
        const transceiver = pc.addTransceiver(track, {
          direction: "sendonly",
          streams: [localStream]
        });

        /*
         * 音楽向けOpusを優先する。
         *
         * SDPの詳細調整は今回は行わず、
         * ブラウザの音声エンコードを利用する。
         */
        const capabilities =
          RTCRtpSender.getCapabilities?.("audio");

        const codecs = capabilities?.codecs || [];

        const opus = codecs.filter(codec =>
          codec.mimeType.toLowerCase() === "audio/opus"
        );

        if (opus.length) {
          try {
            transceiver.setCodecPreferences([
              ...opus,
              ...codecs.filter(codec =>
                codec.mimeType.toLowerCase() !== "audio/opus"
              )
            ]);
          } catch (error) {
            console.warn("Audio codec:", error);
          }
        }
      }
    }

    if (!isCurrent()) return;

    const offer = await pc.createOffer();

    if (!isCurrent()) return;

    await pc.setLocalDescription(offer);

    if (!isCurrent()) return;

    signal({
      type: "offer",
      receiverId,
      generation,
      sdp: pc.localDescription
    });

  } catch (error) {
    if (isCurrent()) {
      closeSenderPeer(receiverId);
    }

    console.error("Offer:", error);
  }
}

/* ========================================
   送信
======================================== */

async function startSender() {
  if (role || senderStarting) return;

  if (ws?.readyState !== WebSocket.OPEN) {
    status("サーバーに接続されていません");
    return;
  }

  const room = $("roomId").value;

  if (!room.trim()) {
    status("ルームIDを入力してください");
    return;
  }

  const settings = readSettings();

  senderStarting = true;
  updateButtons();

  try {
    localStream =
      await navigator.mediaDevices.getDisplayMedia(
        displayConstraints(settings)
      );

    const track = localStream.getVideoTracks()[0];

    if (!track) {
      throw new Error("映像トラックがありません");
    }

    audioInitialSettings =
      localStream.getAudioTracks().map(track =>
        track.getSettings()
      );

    audioProcessingRequested = false;

    const initial = track.getSettings();

    originalCaptureSize = {
      width: initial.width,
      height: initial.height
    };

    initialCaptureFPS = initial.frameRate ?? null;

    role = "sender";
    currentRoom = room;
    appliedSettings = settings;

    senderSession++;

    track.onended = () => {
      stopSender(true);
    };

    await applyCaptureConstraints(settings);

    updatePreview();
    updateAudioDiagnostics();

    signal({
      type: "join",
      role: "sender",
      room,
      name: $("senderName").value,
      memo: $("roomMemo").value
    });

    status(`WebRTC配信開始: ${room}`);

    renderRooms();

  } catch (error) {
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

function stopSender(sendLeave = true) {
  if (role !== "sender") return;

  senderSession++;

  stopAudioMonitor();

  for (const id of [...peers.keys()]) {
    closeSenderPeer(id);
  }

  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.onended = null;
      track.stop();
    }
  }

  localStream = null;
  appliedSettings = null;

  originalCaptureSize = null;
  initialCaptureFPS = null;

  $("localVideo").srcObject = null;
  $("senderStats").textContent = "未配信";

  role = null;
  currentRoom = null;

  if (sendLeave) {
    signal({ type: "leave" });
  }

  updateCaptureInfo();
  updateAudioDiagnostics();

  renderRooms();
  updateButtons();

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
    const settings = readSettings();

    await applyCaptureConstraints(settings);

    appliedSettings = settings;

    updateCaptureInfo();
    updatePreview();

    for (const receiverId of [...peers.keys()]) {
      if (role !== "sender") break;

      await makeOffer(receiverId);
    }

    status("設定を適用しました");

  } catch (error) {
    status(`設定変更エラー: ${error.message}`);

  } finally {
    settingsApplying = false;
    updateButtons();
  }
}

/* ========================================
   受信
======================================== */

function clearReceivedStream() {
  for (const track of receivedStream.getTracks()) {
    receivedStream.removeTrack(track);
  }

  $("remoteVideo").srcObject = null;
}

function stopReceiver(sendLeave = true) {
  if (role !== "receiver") return;

  receiverSession++;

  if (receiverPeer) {
    receiverPeer.close();
    receiverPeer = null;
  }

  receiverGeneration = null;
  receiverHistory = {};

  pendingReceiverICE.clear();

  clearReceivedStream();

  role = null;
  currentRoom = null;

  if (sendLeave) {
    signal({ type: "leave" });
  }

  $("receiverStats").textContent = "未接続";

  updateButtons();
  status("受信を停止しました");
}

function startReceiver(room = $("roomId").value) {
  if (!room.trim()) {
    status("ルームIDを入力してください");
    return;
  }

  if (ws?.readyState !== WebSocket.OPEN) {
    status("サーバーに接続されていません");
    return;
  }

  if (role === "sender" || senderStarting) {
    status("配信中は受信できません");
    return;
  }

  if (role === "receiver") {
    stopReceiver(true);
  }

  receiverSession++;

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

async function handleOffer(data) {
  if (role !== "receiver") return;

  const session = receiverSession;

  if (
    receiverGeneration !== null &&
    data.generation <= receiverGeneration
  ) {
    return;
  }

  if (receiverPeer) {
    receiverPeer.close();
  }

  clearReceivedStream();

  const pc = new RTCPeerConnection(rtcConfig);

  receiverPeer = pc;
  receiverGeneration = data.generation;

  receiverHistory = {};
  receiverDisconnectedAt = 0;

  const isCurrent = () =>
    role === "receiver" &&
    receiverSession === session &&
    receiverPeer === pc;

  pc.ontrack = event => {
    if (!isCurrent()) return;

    if (!receivedStream.getTrackById(event.track.id)) {
      receivedStream.addTrack(event.track);
    }

    const video = $("remoteVideo");

    if (video.srcObject !== receivedStream) {
      video.srcObject = receivedStream;
    }

    video.play().catch(() => {});
  };

  pc.onicecandidate = event => {
    if (!event.candidate || !isCurrent()) return;

    signal({
      type: "ice",
      generation: data.generation,
      candidate: event.candidate
    });
  };

  pc.onconnectionstatechange = () => {
    if (!isCurrent()) return;

    if (pc.connectionState === "connected") {
      receiverDisconnectedAt = 0;
      status(`受信接続完了: ${currentRoom}`);
    }
  };

  try {
    await pc.setRemoteDescription(data.sdp);

    if (!isCurrent()) return;

    const answer = await pc.createAnswer();

    if (!isCurrent()) return;

    await pc.setLocalDescription(answer);

    if (!isCurrent()) return;

    signal({
      type: "answer",
      generation: data.generation,
      sdp: pc.localDescription
    });

    const pending =
      pendingReceiverICE.get(data.generation) || [];

    pendingReceiverICE.delete(data.generation);

    for (const candidate of pending) {
      if (!isCurrent()) break;

      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn("Receiver ICE:", error);
      }
    }

  } catch (error) {
    if (isCurrent()) {
      status(`受信接続エラー: ${error.message}`);
    }
  }
}

/* ========================================
   シグナリング
======================================== */

async function handleSignal(data) {
  switch (data.type) {

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

    case "receiver-joined":
      if (role === "sender") {
        await makeOffer(data.receiverId);
      }
      break;

    case "receiver-left":
      if (role === "sender") {
        closeSenderPeer(data.receiverId);
      }
      break;

    case "sender-ready":
      if (role === "receiver") {
        status("配信者に接続中...");
      }
      break;

    case "sender-left":
      if (role === "receiver") {
        receiverSession++;

        receiverPeer?.close();
        receiverPeer = null;

        receiverGeneration = null;
        receiverHistory = {};

        pendingReceiverICE.clear();

        clearReceivedStream();

        $("receiverStats").textContent =
          "配信終了";

        status("配信が終了しました");
      }
      break;

    case "offer":
      await handleOffer(data);
      break;

    case "answer": {
      if (role !== "sender") break;

      const entry = peers.get(data.receiverId);

      if (
        !entry ||
        entry.generation !== data.generation
      ) {
        break;
      }

      try {
        await entry.pc.setRemoteDescription(data.sdp);

        if (peers.get(data.receiverId) !== entry) break;

        const pending = entry.pendingICE.splice(0);

        for (const candidate of pending) {
          if (peers.get(data.receiverId) !== entry) break;

          try {
            await entry.pc.addIceCandidate(candidate);
          } catch (error) {
            console.warn("Sender ICE:", error);
          }
        }

      } catch (error) {
        console.warn("Answer:", error);
      }

      break;
    }

    case "ice": {
      if (role === "sender") {
        const entry = peers.get(data.receiverId);

        if (
          !entry ||
          entry.generation !== data.generation
        ) {
          break;
        }

        if (entry.pc.remoteDescription) {
          try {
            await entry.pc.addIceCandidate(data.candidate);
          } catch (error) {
            console.warn("Sender ICE:", error);
          }
        } else {
          entry.pendingICE.push(data.candidate);
        }

      } else if (role === "receiver") {
        if (
          receiverGeneration !== null &&
          data.generation < receiverGeneration
        ) {
          break;
        }

        if (
          data.generation === receiverGeneration &&
          receiverPeer?.remoteDescription
        ) {
          try {
            await receiverPeer.addIceCandidate(
              data.candidate
            );
          } catch (error) {
            console.warn("Receiver ICE:", error);
          }

        } else {
          if (!pendingReceiverICE.has(data.generation)) {
            pendingReceiverICE.set(data.generation, []);
          }

          pendingReceiverICE
            .get(data.generation)
            .push(data.candidate);
        }
      }

      break;
    }

    case "restart-request": {
      if (role !== "sender") break;

      const entry = peers.get(data.receiverId);

      if (
        entry &&
        entry.generation === data.generation
      ) {
        await makeOffer(data.receiverId);
      }

      break;
    }

    case "error":
      status(`エラー: ${data.message}`);

      if (role === "sender" && peers.size === 0) {
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

      $("remoteVideo").scrollIntoView({
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

function delta(report, history, key) {
  const count = report[key];

  if (typeof count !== "number") return "?";

  const previous = history[key];

  history[key] = {
    count,
    time: report.timestamp
  };

  if (!previous) return "?";

  const seconds =
    (report.timestamp - previous.time) / 1000;

  if (seconds <= 0) return "?";

  return ((count - previous.count) / seconds).toFixed(1);
}

function bitrate(report, history, key) {
  const value = delta(report, history, key);

  return value === "?"
    ? "?"
    : (Number(value) * 8 / 1e6).toFixed(2);
}

function codecName(report, reports) {
  return reports.get(report.codecId)?.mimeType || "?";
}

async function updateSenderStats() {
  if (role !== "sender" || !localStream) return;

  const track = localStream.getVideoTracks()[0];

  if (!track) return;

  const settings = track.getSettings();

  let text =
`========== WebRTC送信 ==========

キャプチャ:
${settings.width}×${settings.height}

設定FPS:
${settings.frameRate ?? "?"}

音声トラック:
${localStream.getAudioTracks().length}

`;

  if (!peers.size) {
    text += "受信者の接続待ち...\n";
  }

  for (const [id, entry] of peers) {
    try {
      const reports = await entry.pc.getStats();

      if (peers.get(id) !== entry) continue;

      const video = [...reports.values()].find(
        report =>
          report.type === "outbound-rtp" &&
          report.kind === "video"
      );

      if (!video) continue;

      let history = senderHistory.get(id);

      if (!history) {
        history = {};
        senderHistory.set(id, history);
      }

      const fps = delta(
        video,
        history,
        "framesEncoded"
      );

      const sentFPS = delta(
        video,
        history,
        "framesSent"
      );

      const mbps = bitrate(
        video,
        history,
        "bytesSent"
      );

      text +=
`========== 送信先 ${id.slice(0, 8)} ==========

状態: ${entry.pc.connectionState}
Codec: ${codecName(video, reports)}

解像度:
${video.frameWidth ?? "?"}×${video.frameHeight ?? "?"}

実測エンコードFPS: ${fps}
実測送出FPS: ${sentFPS}
WebRTC FPS: ${video.framesPerSecond ?? "?"}

通信速度: ${mbps} Mbps
品質制限: ${video.qualityLimitationReason ?? "?"}

`;
    } catch (error) {
      console.warn("Sender stats:", error);
    }
  }

  $("senderStats").textContent = text;
}

async function updateReceiverStats() {
  if (role !== "receiver" || !receiverPeer) return;

  const pc = receiverPeer;

  try {
    const reports = await pc.getStats();

    if (receiverPeer !== pc) return;

    const video = [...reports.values()].find(
      report =>
        report.type === "inbound-rtp" &&
        report.kind === "video"
    );

    if (!video) return;

    const fps = delta(
      video,
      receiverHistory,
      "framesReceived"
    );

    const decoded = delta(
      video,
      receiverHistory,
      "framesDecoded"
    );

    const mbps = bitrate(
      video,
      receiverHistory,
      "bytesReceived"
    );

    $("receiverStats").textContent =
`========== WebRTC受信 ==========

状態: ${pc.connectionState}
Codec: ${codecName(video, reports)}

解像度:
${video.frameWidth ?? "?"}×${video.frameHeight ?? "?"}

実測受信FPS: ${fps}
実測デコードFPS: ${decoded}

通信速度: ${mbps} Mbps
パケットロス: ${video.packetsLost ?? "?"}
破棄フレーム: ${video.framesDropped ?? "?"}
`;

  } catch (error) {
    console.warn("Receiver stats:", error);
  }
}

/* ========================================
   自動復旧
======================================== */

function watchdog() {
  const now = Date.now();

  if (role === "sender") {
    for (const [id, entry] of peers) {
      const state = entry.pc.connectionState;

      if (state === "connected") {
        entry.disconnectedAt = 0;
        continue;
      }

      if (
        state === "failed" ||
        state === "disconnected"
      ) {
        if (!entry.disconnectedAt) {
          entry.disconnectedAt = now;
        }

        if (
          now - entry.disconnectedAt > DISCONNECT_TIMEOUT &&
          now - entry.lastRestart > RESTART_COOLDOWN
        ) {
          entry.lastRestart = now;
          makeOffer(id).catch(console.error);
        }
      }
    }
  }

  if (role === "receiver" && receiverPeer) {
    const state = receiverPeer.connectionState;

    if (state === "connected") {
      receiverDisconnectedAt = 0;

    } else if (
      state === "failed" ||
      state === "disconnected"
    ) {
      if (!receiverDisconnectedAt) {
        receiverDisconnectedAt = now;
      }

      if (
        now - receiverDisconnectedAt > DISCONNECT_TIMEOUT &&
        now - lastReceiverRestart > RESTART_COOLDOWN
      ) {
        lastReceiverRestart = now;

        signal({
          type: "restart-request",
          generation: receiverGeneration
        });
      }
    }
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

$("audioMonitorButton").onclick = toggleAudioMonitor;

$("audioProcessingButton").onclick =
  disableAudioProcessing;

$("fullscreen").onclick = () => {
  $("remoteVideo").requestFullscreen?.();
};

$("muteButton").onclick = () => {
  const video = $("remoteVideo");

  video.muted = !video.muted;

  $("muteButton").textContent =
    video.muted
      ? "🔇 ミュート中"
      : "🔊 音声ON";
};

/* ========================================
   初期化
======================================== */

$("remoteVideo").classList.remove("hidden");
$("remoteCanvas").classList.add("hidden");

connect();

updateButtons();
updatePreview();

setInterval(updateSenderStats, 1000);
setInterval(updateReceiverStats, 1000);
setInterval(watchdog, 1000);

})();
