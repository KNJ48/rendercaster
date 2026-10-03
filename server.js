import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import crypto from "node:crypto";


// ============================================================
// CONFIG
// ============================================================

const PORT =
  Number(
    process.env.PORT ||
    10000
  );


// ============================================================
// HTTP
// ============================================================

const app =
  express();


const server =
  http.createServer(
    app
  );


// ============================================================
// ROOMS
// ============================================================

const rooms =
  new Map();


function getRoom(id) {

  let room =
    rooms.get(id);


  if (!room) {

    room = {

      sender:
        null,

      receivers:
        new Map()

    };


    rooms.set(
      id,
      room
    );

  }


  return room;

}


// ============================================================
// WebSocket
// ============================================================

const wss =
  new WebSocketServer({

    server,

    path:
      "/signal"

  });


function send(
  ws,
  message
) {

  if (
    ws &&
    ws.readyState ===
      WebSocket.OPEN
  ) {

    ws.send(
      JSON.stringify(
        message
      )
    );

  }

}


// ============================================================
// SIGNALING
// ============================================================

wss.on(
  "connection",

  ws => {

    let roomId =
      null;

    let role =
      null;

    let receiverId =
      null;


    // ========================================================
    // MESSAGE
    // ========================================================

    ws.on(
      "message",

      raw => {

        try {

          const msg =
            JSON.parse(
              raw.toString()
            );


          // ==================================================
          // Sender join
          // ==================================================

          if (
            msg.type ===
            "sender-join"
          ) {

            roomId =
              String(
                msg.room ||
                ""
              );


            if (
              !/^[A-Za-z0-9_-]{1,32}$/
                .test(roomId)
            ) {

              send(
                ws,
                {
                  type:
                    "error",

                  message:
                    "Invalid room"
                }
              );

              return;

            }


            role =
              "sender";


            const room =
              getRoom(
                roomId
              );


            // 既存Senderを置換

            if (
              room.sender &&
              room.sender !==
                ws
            ) {

              send(
                room.sender,
                {
                  type:
                    "replaced"
                }
              );


              room.sender.close();

            }


            room.sender =
              ws;


            send(
              ws,
              {
                type:
                  "sender-ready"
              }
            );


            // 先に待っていたReceiverを通知

            for (
              const id
              of room.receivers.keys()
            ) {

              send(
                ws,
                {
                  type:
                    "receiver-joined",

                  receiverId:
                    id
                }
              );

            }


            return;

          }


          // ==================================================
          // Receiver join
          // ==================================================

          if (
            msg.type ===
            "receiver-join"
          ) {

            roomId =
              String(
                msg.room ||
                ""
              );


            if (
              !/^[A-Za-z0-9_-]{1,32}$/
                .test(roomId)
            ) {

              send(
                ws,
                {
                  type:
                    "error",

                  message:
                    "Invalid room"
                }
              );

              return;

            }


            role =
              "receiver";


            receiverId =
              crypto.randomUUID();


            const room =
              getRoom(
                roomId
              );


            room.receivers.set(
              receiverId,
              ws
            );


            send(
              ws,
              {
                type:
                  "receiver-ready",

                receiverId,

                senderOnline:
                  Boolean(
                    room.sender
                  )
              }
            );


            send(
              room.sender,
              {
                type:
                  "receiver-joined",

                receiverId
              }
            );


            return;

          }


          // ==================================================
          // Offer
          // ==================================================

          if (
            msg.type ===
            "offer" &&
            role ===
              "sender"
          ) {

            const room =
              rooms.get(
                roomId
              );


            const target =
              room?.receivers.get(
                msg.receiverId
              );


            send(
              target,
              {
                type:
                  "offer",

                receiverId:
                  msg.receiverId,

                sdp:
                  msg.sdp
              }
            );


            return;

          }


          // ==================================================
          // Answer
          // ==================================================

          if (
            msg.type ===
            "answer" &&
            role ===
              "receiver"
          ) {

            const room =
              rooms.get(
                roomId
              );


            send(
              room?.sender,
              {
                type:
                  "answer",

                receiverId,

                sdp:
                  msg.sdp
              }
            );


            return;

          }


          // ==================================================
          // ICE
          // ==================================================

          if (
            msg.type ===
            "ice"
          ) {

            const room =
              rooms.get(
                roomId
              );


            // Sender -> Receiver

            if (
              role ===
              "sender"
            ) {

              const target =
                room?.receivers.get(
                  msg.receiverId
                );


              send(
                target,
                {
                  type:
                    "ice",

                  receiverId:
                    msg.receiverId,

                  candidate:
                    msg.candidate
                }
              );

            }


            // Receiver -> Sender

            else if (
              role ===
              "receiver"
            ) {

              send(
                room?.sender,
                {
                  type:
                    "ice",

                  receiverId,

                  candidate:
                    msg.candidate
                }
              );

            }


            return;

          }

        }

        catch (error) {

          console.error(
            "WS message error:",
            error
          );

        }

      }

    );


    // ========================================================
    // CLOSE
    // ========================================================

    ws.on(
      "close",

      () => {

        if (!roomId)
          return;


        const room =
          rooms.get(
            roomId
          );


        if (!room)
          return;


        // Sender

        if (
          role ===
            "sender" &&
          room.sender ===
            ws
        ) {

          room.sender =
            null;


          for (
            const receiver
            of room.receivers.values()
          ) {

            send(
              receiver,
              {
                type:
                  "sender-left"
              }
            );

          }

        }


        // Receiver

        if (
          role ===
            "receiver" &&
          receiverId
        ) {

          room.receivers.delete(
            receiverId
          );


          send(
            room.sender,
            {
              type:
                "receiver-left",

              receiverId
            }
          );

        }


        if (
          !room.sender &&
          room.receivers.size ===
            0
        ) {

          rooms.delete(
            roomId
          );

        }

      }

    );

  }

);


// ============================================================
// HTML
// ============================================================

const HTML = String.raw`
<!DOCTYPE html>

<html lang="ja">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>

<title>
WebRTC Caster
</title>


<style>

* {
  box-sizing:
    border-box;
}


html,
body {

  margin: 0;

  min-height: 100%;

  background:
    #101114;

  color:
    #eee;

  font-family:
    system-ui,
    sans-serif;

}


body {
  padding: 24px;
}


main {

  width: 100%;

  max-width: 900px;

  margin: auto;

}


section {

  margin:
    16px 0;

  padding:
    20px;

  background:
    #1b1d22;

  border:
    1px solid #333;

  border-radius:
    12px;

}


input {

  width:
    100%;

  padding:
    12px;

  font-size:
    22px;

  color:
    white;

  background:
    #292c33;

  border:
    1px solid #555;

  border-radius:
    8px;

}


button {

  margin:
    6px 3px;

  padding:
    13px 20px;

  border:
    none;

  border-radius:
    8px;

  color:
    white;

  background:
    #2868d8;

  font-size:
    17px;

  cursor:
    pointer;

}


button:hover {
  filter:
    brightness(1.12);
}


#sendButton {
  background:
    #16834b;
}


#fullscreen {
  background:
    #7544c7;
}


#status {

  min-height:
    60px;

  margin:
    16px 0;

  padding:
    15px;

  color:
    #90d8ff;

  background:
    #20232a;

  border-radius:
    8px;

  white-space:
    pre-wrap;

  font-family:
    monospace;

}


.info {

  margin-top:
    12px;

  padding:
    12px;

  color:
    #bbb;

  background:
    #15171b;

  border-radius:
    8px;

  white-space:
    pre-wrap;

  font-family:
    monospace;

  font-size:
    13px;

}


video {

  display:
    block;

  width:
    100%;

  max-height:
    75vh;

  margin-top:
    15px;

  background:
    black;

  border-radius:
    10px;

  object-fit:
    contain;

}


video:fullscreen {

  width:
    100vw;

  height:
    100vh;

  max-width:
    none;

  max-height:
    none;

  margin:
    0;

  border-radius:
    0;

  background:
    black;

  object-fit:
    contain;

}


.small {

  color:
    #aaa;

  font-size:
    14px;

}

</style>

</head>


<body>

<main>


<h1>
WebRTC Caster
</h1>


<div id="status">
準備完了
</div>


<section>

<h2>
ルームID
</h2>


<input
  id="room"
  value="1111"
  maxlength="32"
  autocomplete="off"
>

</section>


<section>

<h2>
送信
</h2>


<button id="sendButton">
🖥 画面を送信
</button>


<p class="small">
最大720p / 最大60FPS /
20Mbps / 受信端末。
解像度維持優先。
</p>


<div
  id="senderInfo"
  class="info">
未送信
</div>


<div
  id="senderStats"
  class="info">
送信統計：未接続
</div>


</section>


<section>

<h2>
受信
</h2>


<button id="receiveButton">
📺 画面を受信
</button>


<button id="fullscreen">
⛶ 全画面
</button>


<video
  id="video"
  autoplay
  playsinline
></video>


<div
  id="receiverStats"
  class="info">
受信統計：未接続
</div>


</section>


</main>


<script>

// ============================================================
// STATE
// ============================================================

let socket =
  null;


let mode =
  null;


let localStream =
  null;


let receiverPeer =
  null;


const senderPeers =
  new Map();


const pendingSenderICE =
  new Map();


let pendingReceiverICE =
  [];


const previousSenderStats =
  new Map();


let previousReceiverBytes =
  0;


let previousReceiverTime =
  0;


// ============================================================
// DOM
// ============================================================

const statusBox =
  document.getElementById(
    "status"
  );


const senderInfo =
  document.getElementById(
    "senderInfo"
  );


const senderStats =
  document.getElementById(
    "senderStats"
  );


const receiverStats =
  document.getElementById(
    "receiverStats"
  );


const video =
  document.getElementById(
    "video"
  );


// ============================================================
// UI
// ============================================================

function setStatus(
  text
) {

  console.log(text);

  statusBox.textContent =
    text;

}


function getRoom() {

  const room =
    document
      .getElementById(
        "room"
      )
      .value
      .trim();


  if (
    !/^[A-Za-z0-9_-]{1,32}$/
      .test(room)
  ) {

    throw new Error(
      "ルームIDが不正です"
    );

  }


  return room;

}


// ============================================================
// SOCKET
// ============================================================

function connectSocket() {

  return new Promise(
    (resolve, reject) => {

      if (
        socket &&
        socket.readyState ===
          WebSocket.OPEN
      ) {

        resolve();

        return;

      }


      const protocol =
        location.protocol ===
          "https:"
          ? "wss:"
          : "ws:";


      socket =
        new WebSocket(
          protocol +
          "//" +
          location.host +
          "/signal"
        );


      socket.onopen =
        () => {

          resolve();

        };


      socket.onerror =
        () => {

          reject(
            new Error(
              "WebSocket接続失敗"
            )
          );

        };


      socket.onmessage =
        async event => {

          try {

            const msg =
              JSON.parse(
                event.data
              );


            await handleSignal(
              msg
            );

          }

          catch (error) {

            console.error(
              error
            );

          }

        };

    }
  );

}


function signal(
  data
) {

  if (
    !socket ||
    socket.readyState !==
      WebSocket.OPEN
  ) {

    throw new Error(
      "WebSocket未接続"
    );

  }


  socket.send(
    JSON.stringify(
      data
    )
  );

}


// ============================================================
// PEER
// ============================================================

function createPeer() {

  return new RTCPeerConnection({

    iceServers: [

      {
        urls:
          "stun:stun.l.google.com:19302"
      },

      {
        urls:
          "stun:stun1.l.google.com:19302"
      }

    ]

  });

}


// ============================================================
// VIDEO SETTINGS
// ============================================================

async function addVideoTrack(
  pc,
  track,
  sourceStream
) {

  const sender =
    pc.addTrack(
      track,
      sourceStream
    );


  if (
    track.kind !==
      "video"
  ) {

    return;

  }


  const settings =
    track.getSettings();


  const width =
    settings.width ??
    1280;


  const height =
    settings.height ??
    720;


  const scale =
    Math.max(
      1,

      width /
        1280,

      height /
        720
    );


  try {

    const params =
      sender.getParameters();


    if (
      !params.encodings ||
      params.encodings.length ===
        0
    ) {

      params.encodings =
        [{}];

    }


    params
      .encodings[0]
      .scaleResolutionDownBy =
        scale;


    params
      .encodings[0]
      .maxFramerate =
        60;


    params
      .encodings[0]
      .maxBitrate =
        20_000_000;


    params
      .degradationPreference =
        "maintain-resolution";


    await sender
      .setParameters(
        params
      );

  }

  catch (error) {

    console.warn(
      "setParameters:",
      error
    );

  }

}


// ============================================================
// SENDER PEER
// ============================================================

async function createSenderPeer(
  receiverId
) {

  if (
    senderPeers.has(
      receiverId
    ) ||
    !localStream
  ) {

    return;

  }


  const pc =
    createPeer();


  senderPeers.set(
    receiverId,
    pc
  );


  pc.onicecandidate =
    event => {

      if (
        event.candidate
      ) {

        signal({

          type:
            "ice",

          receiverId,

          candidate:
            event.candidate

        });

      }

    };


  for (
    const track
    of localStream.getTracks()
  ) {

    await addVideoTrack(
      pc,
      track,
      localStream
    );

  }


  const offer =
    await pc.createOffer();


  await pc
    .setLocalDescription(
      offer
    );


  signal({

    type:
      "offer",

    receiverId,

    sdp:
      pc.localDescription

  });


  pc.onconnectionstatechange =
    () => {

      updateSenderOverview();

    };


  updateSenderOverview();

}


// ============================================================
// SENDER OVERVIEW
// ============================================================

function updateSenderOverview() {

  let connected =
    0;


  for (
    const pc
    of senderPeers.values()
  ) {

    if (
      pc.connectionState ===
      "connected"
    ) {

      connected++;

    }

  }


  senderInfo.textContent =
    "接続中: " +
    connected +
    "台\\n" +
    "Peer数: " +
    senderPeers.size +
    "台\\n" +
    "最大: 1280×720 / 60FPS\\n" +
    "最大20Mbps / 受信端末\\n" +
    "解像度優先";

}


// ============================================================
// SIGNAL
// ============================================================

async function handleSignal(
  msg
) {

  if (
    msg.type ===
    "error"
  ) {

    throw new Error(
      msg.message
    );

  }


  if (
    msg.type ===
    "sender-ready"
  ) {

    setStatus(
      "送信準備完了\\n受信者を待っています..."
    );

    return;

  }


  if (
    msg.type ===
      "receiver-joined" &&
    mode ===
      "sender"
  ) {

    await createSenderPeer(
      msg.receiverId
    );

    return;

  }


  if (
    msg.type ===
      "receiver-left" &&
    mode ===
      "sender"
  ) {

    const pc =
      senderPeers.get(
        msg.receiverId
      );


    if (pc) {

      pc.close();

      senderPeers.delete(
        msg.receiverId
      );

      previousSenderStats.delete(
        msg.receiverId
      );

    }


    updateSenderOverview();

    return;

  }


  if (
    msg.type ===
      "answer" &&
    mode ===
      "sender"
  ) {

    const pc =
      senderPeers.get(
        msg.receiverId
      );


    if (!pc)
      return;


    await pc
      .setRemoteDescription(
        msg.sdp
      );


    const waiting =
      pendingSenderICE.get(
        msg.receiverId
      ) ?? [];


    for (
      const candidate
      of waiting
    ) {

      await pc
        .addIceCandidate(
          candidate
        );

    }


    pendingSenderICE.delete(
      msg.receiverId
    );


    return;

  }


  if (
    msg.type ===
    "receiver-ready"
  ) {

    setStatus(
      msg.senderOnline
        ? "送信者を発見。接続しています..."
        : "送信者を待っています..."
    );

    return;

  }


  if (
    msg.type ===
      "offer" &&
    mode ===
      "receiver"
  ) {

    receiverPeer =
      createPeer();


    receiverPeer.ontrack =
      event => {

        if (
          event.streams &&
          event.streams[0]
        ) {

          video.srcObject =
            event.streams[0];


          video
            .play()
            .catch(
              console.error
            );

        }

      };


    receiverPeer.onicecandidate =
      event => {

        if (
          event.candidate
        ) {

          signal({

            type:
              "ice",

            candidate:
              event.candidate

          });

        }

      };


    receiverPeer
      .onconnectionstatechange =
      () => {

        if (
          receiverPeer
            .connectionState ===
          "connected"
        ) {

          setStatus(
            "接続成功！\\n映像受信中"
          );

        }


        if (
          receiverPeer
            .connectionState ===
          "failed"
        ) {

          setStatus(
            "WebRTC接続失敗"
          );

        }

      };


    await receiverPeer
      .setRemoteDescription(
        msg.sdp
      );


    for (
      const candidate
      of pendingReceiverICE
    ) {

      await receiverPeer
        .addIceCandidate(
          candidate
        );

    }


    pendingReceiverICE =
      [];


    const answer =
      await receiverPeer
        .createAnswer();


    await receiverPeer
      .setLocalDescription(
        answer
      );


    signal({

      type:
        "answer",

      sdp:
        receiverPeer
          .localDescription

    });


    return;

  }


  if (
    msg.type ===
    "ice"
  ) {

    // Sender

    if (
      mode ===
      "sender"
    ) {

      const pc =
        senderPeers.get(
          msg.receiverId
        );


      if (!pc)
        return;


      if (
        pc.remoteDescription
      ) {

        await pc
          .addIceCandidate(
            msg.candidate
          );

      }

      else {

        if (
          !pendingSenderICE.has(
            msg.receiverId
          )
        ) {

          pendingSenderICE.set(
            msg.receiverId,
            []
          );

        }


        pendingSenderICE
          .get(
            msg.receiverId
          )
          .push(
            msg.candidate
          );

      }


      return;

    }


    // Receiver

    if (
      mode ===
      "receiver"
    ) {

      if (
        receiverPeer &&
        receiverPeer
          .remoteDescription
      ) {

        await receiverPeer
          .addIceCandidate(
            msg.candidate
          );

      }

      else {

        pendingReceiverICE.push(
          msg.candidate
        );

      }

    }

  }

}


// ============================================================
// SEND BUTTON
// ============================================================

document
.getElementById(
  "sendButton"
)
.onclick =
async () => {

  try {

    mode =
      "sender";


    setStatus(
      "共有する画面を選択してください..."
    );


    localStream =
      await navigator
        .mediaDevices
        .getDisplayMedia({

          video: {

            frameRate: {
              ideal: 60,
              max: 60
            }

          },

          audio:
            false

        });


    const track =
      localStream
        .getVideoTracks()[0];


    if (track) {

      try {

        track.contentHint =
          "detail";

      }

      catch {}


      const settings =
        track.getSettings();


      senderInfo.textContent =
        "キャプチャ入力: " +
        (
          settings.width ??
          "?"
        ) +
        "×" +
        (
          settings.height ??
          "?"
        ) +
        " / " +
        (
          settings.frameRate ??
          "?"
        ) +
        "FPS\\n" +
        "送信上限: 1280×720 / 60FPS";


      track.onended =
        () => {

          for (
            const pc
            of senderPeers.values()
          ) {

            pc.close();

          }


          senderPeers.clear();


          socket?.close();


          setStatus(
            "画面共有終了"
          );

        };

    }


    await connectSocket();


    signal({

      type:
        "sender-join",

      room:
        getRoom()

    });

  }

  catch (error) {

    console.error(
      error
    );


    setStatus(
      "送信エラー\\n" +
      error.message
    );

  }

};


// ============================================================
// RECEIVE BUTTON
// ============================================================

document
.getElementById(
  "receiveButton"
)
.onclick =
async () => {

  try {

    mode =
      "receiver";


    setStatus(
      "受信準備中..."
    );


    await connectSocket();


    signal({

      type:
        "receiver-join",

      room:
        getRoom()

    });

  }

  catch (error) {

    setStatus(
      "受信エラー\\n" +
      error.message
    );

  }

};


// ============================================================
// FULLSCREEN
// ============================================================

document
.getElementById(
  "fullscreen"
)
.onclick =
async () => {

  try {

    if (
      !video.srcObject
    ) {

      throw new Error(
        "まだ映像がありません"
      );

    }


    if (
      video.requestFullscreen
    ) {

      await video
        .requestFullscreen();

    }

    else if (
      video.webkitEnterFullscreen
    ) {

      video
        .webkitEnterFullscreen();

    }

  }

  catch (error) {

    setStatus(
      "全画面エラー\\n" +
      error.message
    );

  }

};


// ============================================================
// RECEIVER STATS
// ============================================================

async function updateReceiverStats() {

  if (!receiverPeer)
    return;


  try {

    const stats =
      await receiverPeer
        .getStats();


    let inbound =
      null;


    stats.forEach(
      report => {

        if (
          report.type ===
            "inbound-rtp" &&
          (
            report.kind ===
              "video" ||
            report.mediaType ===
              "video"
          )
        ) {

          inbound =
            report;

        }

      }
    );


    if (!inbound)
      return;


    const width =
      inbound.frameWidth ??
      video.videoWidth ??
      "?";


    const height =
      inbound.frameHeight ??
      video.videoHeight ??
      "?";


    const fps =
      inbound.framesPerSecond ??
      "?";


    let codecName =
      "?";


    if (
      inbound.codecId
    ) {

      const codec =
        stats.get(
          inbound.codecId
        );


      if (
        codec?.mimeType
      ) {

        codecName =
          codec.mimeType;

      }

    }


    const now =
      performance.now();


    const bytes =
      inbound.bytesReceived ??
      0;


    let mbps =
      null;


    if (
      previousReceiverTime >
        0 &&
      now >
        previousReceiverTime
    ) {

      const seconds =
        (
          now -
          previousReceiverTime
        ) /
        1000;


      mbps =
        (
          (
            bytes -
            previousReceiverBytes
          ) *
          8
        ) /
        seconds /
        1_000_000;

    }


    previousReceiverBytes =
      bytes;


    previousReceiverTime =
      now;


    receiverStats.textContent =
      "実測受信\\n" +
      width +
      " × " +
      height +
      "\\n" +
      fps +
      " FPS\\n" +
      (
        mbps === null
          ? "Bitrate: 計測中"
          : "Bitrate: " +
            mbps.toFixed(2) +
            " Mbps"
      ) +
      "\\nCodec: " +
      codecName;

  }

  catch (error) {

    console.warn(
      "Receiver stats:",
      error
    );

  }

}


// ============================================================
// SENDER STATS
// ============================================================

async function updateSenderStats() {

  if (
    senderPeers.size ===
    0
  ) {

    senderStats.textContent =
      "送信統計：接続端末なし";

    return;

  }


  const lines =
    [];


  let index =
    1;


  for (
    const [id, pc]
    of senderPeers
  ) {

    try {

      const stats =
        await pc.getStats();


      let outbound =
        null;


      stats.forEach(
        report => {

          if (
            report.type ===
              "outbound-rtp" &&
            (
              report.kind ===
                "video" ||
              report.mediaType ===
                "video"
            )
          ) {

            outbound =
              report;

          }

        }
      );


      if (!outbound)
        continue;


      const now =
        performance.now();


      const bytes =
        outbound.bytesSent ??
        0;


      const previous =
        previousSenderStats.get(
          id
        );


      let mbps =
        null;


      if (previous) {

        const seconds =
          (
            now -
            previous.time
          ) /
          1000;


        if (
          seconds >
          0
        ) {

          mbps =
            (
              (
                bytes -
                previous.bytes
              ) *
              8
            ) /
            seconds /
            1_000_000;

        }

      }


      previousSenderStats.set(
        id,
        {
          bytes,
          time:
            now
        }
      );


      let codecName =
        "?";


      if (
        outbound.codecId
      ) {

        const codec =
          stats.get(
            outbound.codecId
          );


        if (
          codec?.mimeType
        ) {

          codecName =
            codec.mimeType;

        }

      }


      lines.push(
        "端末 " +
        index +
        "\\n" +
        (
          outbound.frameWidth ??
          "?"
        ) +
        " × " +
        (
          outbound.frameHeight ??
          "?"
        ) +
        " / " +
        (
          outbound.framesPerSecond ??
          "?"
        ) +
        " FPS\\n" +
        (
          mbps === null
            ? "Bitrate: 計測中"
            : "Bitrate: " +
              mbps.toFixed(2) +
              " Mbps"
        ) +
        "\\nCodec: " +
        codecName +
        "\\nState: " +
        pc.connectionState
      );


      index++;

    }

    catch (error) {

      console.warn(
        "Sender stats:",
        error
      );

    }

  }


  senderStats.textContent =
    lines.length
      ? "実測送信\\n\\n" +
        lines.join(
          "\\n\\n"
        )
      : "送信統計：計測中";

}


// ============================================================
// STATS TIMER
// ============================================================

setInterval(
  () => {

    updateReceiverStats();

    updateSenderStats();

  },

  1000
);

</script>

</body>

</html>
`;


// ============================================================
// PAGE
// ============================================================

app.get(
  "/",
  (req, res) => {

    res
      .type("html")
      .send(HTML);

  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {

    let receiverCount =
      0;


    for (
      const room
      of rooms.values()
    ) {

      receiverCount +=
        room.receivers.size;

    }


    res.json({

      ok:
        true,

      version:
        "4.0",

      rooms:
        rooms.size,

      receivers:
        receiverCount,

      signaling:
        "WebSocket",

      media:
        "WebRTC"

    });

  }
);


// ============================================================
// START
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "WebRTC Caster v4 running on port",
      PORT
    );

  }
);
