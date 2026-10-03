import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import crypto from "node:crypto";


// ============================================================
// Config
// ============================================================

const PORT =
  Number(process.env.PORT || 10000);


// ============================================================
// Express
// ============================================================

const app =
  express();


const server =
  http.createServer(app);


// ============================================================
// WebSocket
// ============================================================

const wss =
  new WebSocketServer({
    server,
    path: "/signal"
  });


// ============================================================
// Rooms
// ============================================================
//
// room:
//
// {
//   sender: WebSocket | null,
//
//   receivers:
//     Map<receiverId, WebSocket>
// }
//
// ============================================================

const rooms =
  new Map();


function getRoom(
  id
) {

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
// Send JSON safely
// ============================================================

function send(
  ws,
  data
) {

  if (
    ws &&
    ws.readyState ===
      WebSocket.OPEN
  ) {

    ws.send(
      JSON.stringify(
        data
      )
    );

  }

}


// ============================================================
// WebSocket Signaling
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


    // --------------------------------------------------------
    // Message
    // --------------------------------------------------------

    ws.on(
      "message",

      raw => {

        try {

          const msg =
            JSON.parse(
              raw.toString()
            );


          // ==================================================
          // Sender joins
          // ==================================================

          if (
            msg.type ===
            "sender-join"
          ) {

            roomId =
              String(
                msg.room || ""
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


            // 既存Senderがいるなら切断
            if (
              room.sender &&
              room.sender !== ws
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


            // 先にReceiverが待っていた場合
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
          // Receiver joins
          // ==================================================

          if (
            msg.type ===
            "receiver-join"
          ) {

            roomId =
              String(
                msg.room || ""
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


            // Senderに通知
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
          // Sender -> Receiver
          // ==================================================

          if (
            msg.type ===
            "offer"
          ) {

            if (
              role !==
              "sender"
            ) {

              return;

            }


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
          // Receiver -> Sender
          // ==================================================

          if (
            msg.type ===
            "answer"
          ) {

            if (
              role !==
              "receiver"
            ) {

              return;

            }


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


    // --------------------------------------------------------
    // Close
    // --------------------------------------------------------

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


        // Sender left

        if (
          role ===
          "sender"
        ) {

          if (
            room.sender ===
            ws
          ) {

            room.sender =
              null;

          }


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


        // Receiver left

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
  box-sizing: border-box;
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

  max-width: 850px;

  margin: auto;

}


section {

  margin: 16px 0;

  padding: 20px;

  background:
    #1b1d22;

  border:
    1px solid #333;

  border-radius:
    12px;

}


input {

  width: 100%;

  padding: 12px;

  font-size: 22px;

  color: white;

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

  color: white;

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


#receiveButton {
  background:
    #2868d8;
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


#info {

  margin-top:
    12px;

  padding:
    10px;

  color:
    #aaa;

  background:
    #15171b;

  border-radius:
    8px;

  white-space:
    pre-wrap;

  font-size:
    13px;

  font-family:
    monospace;

}


video {

  display: block;

  width: 100%;

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
送信する
</h2>


<button id="sendButton">
🖥 画面を送信
</button>


<p class="small">
押した後、共有する画面を選択してください。
受信者は自動的に接続されます。
</p>


<div id="info">
未送信
</div>

</section>


<section>

<h2>
受信する
</h2>


<button id="receiveButton">
📺 画面を受信
</button>


<button id="fullscreen">
⛶ 全画面表示
</button>


<p class="small">
同じルームIDの送信者へ自動接続します。
</p>


<video
  id="video"
  autoplay
  playsinline
></video>


</section>


</main>


<script>

// ============================================================
// State
// ============================================================

let socket =
  null;


let mode =
  null;


let localStream =
  null;


let receiverPeer =
  null;


// Sender:
// receiverId -> RTCPeerConnection

const senderPeers =
  new Map();


// ICEがRemoteDescriptionより先に来た場合の待機場所

const pendingSenderICE =
  new Map();


let pendingReceiverICE =
  [];


const statusBox =
  document.getElementById(
    "status"
  );


const infoBox =
  document.getElementById(
    "info"
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
// WebSocket
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

          console.log(
            "WebSocket connected"
          );

          resolve();

        };


      socket.onerror =
        () => {

          reject(
            new Error(
              "シグナリングサーバーへ接続できません"
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
              "Signal error:",
              error
            );


            setStatus(
              "シグナリングエラー\\n" +
              error.message
            );

          }

        };


      socket.onclose =
        () => {

          console.log(
            "WebSocket closed"
          );

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
      "WebSocketが接続されていません"
    );

  }


  socket.send(
    JSON.stringify(
      data
    )
  );

}


// ============================================================
// Peer
// ============================================================

function createPeer() {

  const pc =
    new RTCPeerConnection({

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


  pc.onconnectionstatechange =
    () => {

      console.log(
        "WebRTC:",
        pc.connectionState
      );

    };


  return pc;

}


// ============================================================
// 720p / 20Mbps / resolution priority
// ============================================================

async function addVideoTrack(
  pc,
  track,
  stream
) {

  const sender =
    pc.addTrack(
      track,
      stream
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
        30;


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
      "Video parameter warning:",
      error
    );

  }

}


// ============================================================
// Sender creates peer automatically
// ============================================================

async function createSenderPeer(
  receiverId
) {

  if (
    senderPeers.has(
      receiverId
    )
  ) {

    return;

  }


  if (!localStream) {

    return;

  }


  const pc =
    createPeer();


  senderPeers.set(
    receiverId,
    pc
  );


  // ----------------------------------------------------------
  // ICE
  // ----------------------------------------------------------

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


  pc.onconnectionstatechange =
    () => {

      console.log(
        receiverId,
        pc.connectionState
      );


      updateSenderInfo();


      if (
        pc.connectionState ===
          "failed" ||
        pc.connectionState ===
          "closed"
      ) {

        pc.close();

        senderPeers.delete(
          receiverId
        );


        updateSenderInfo();

      }

    };


  // ----------------------------------------------------------
  // Track
  // ----------------------------------------------------------

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


  // ----------------------------------------------------------
  // Offer
  // ----------------------------------------------------------

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


  updateSenderInfo();

}


// ============================================================
// Sender info
// ============================================================

function updateSenderInfo() {

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


  infoBox.textContent =
    "接続中: " +
    connected +
    "台\\n" +
    "接続処理中を含む: " +
    senderPeers.size +
    "台\\n" +
    "最大映像: 1280×720 / 30fps\\n" +
    "帯域上限: 20Mbps / 受信者\\n" +
    "品質方針: 解像度優先";

}


// ============================================================
// Handle signaling
// ============================================================

async function handleSignal(
  msg
) {

  // ----------------------------------------------------------
  // Error
  // ----------------------------------------------------------

  if (
    msg.type ===
    "error"
  ) {

    throw new Error(
      msg.message
    );

  }


  // ----------------------------------------------------------
  // Sender ready
  // ----------------------------------------------------------

  if (
    msg.type ===
    "sender-ready"
  ) {

    setStatus(
      "送信準備完了\\n受信者を待っています..."
    );

    return;

  }


  // ----------------------------------------------------------
  // Receiver joined
  // ----------------------------------------------------------

  if (
    msg.type ===
    "receiver-joined" &&
    mode ===
      "sender"
  ) {

    console.log(
      "Receiver joined:",
      msg.receiverId
    );


    await createSenderPeer(
      msg.receiverId
    );


    return;

  }


  // ----------------------------------------------------------
  // Receiver left
  // ----------------------------------------------------------

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

    }


    updateSenderInfo();

    return;

  }


  // ----------------------------------------------------------
  // Answer
  // ----------------------------------------------------------

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


    // RemoteDescriptionより前に届いたICEを適用

    const pending =
      pendingSenderICE.get(
        msg.receiverId
      ) ?? [];


    for (
      const candidate
      of pending
    ) {

      await pc.addIceCandidate(
        candidate
      );

    }


    pendingSenderICE.delete(
      msg.receiverId
    );


    return;

  }


  // ----------------------------------------------------------
  // Receiver ready
  // ----------------------------------------------------------

  if (
    msg.type ===
    "receiver-ready"
  ) {

    if (
      msg.senderOnline
    ) {

      setStatus(
        "送信者を発見しました。\\n接続しています..."
      );

    }

    else {

      setStatus(
        "受信準備完了\\n送信者を待っています..."
      );

    }


    return;

  }


  // ----------------------------------------------------------
  // Offer
  // ----------------------------------------------------------

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

        const state =
          receiverPeer
            .connectionState;


        console.log(
          "Receiver:",
          state
        );


        if (
          state ===
          "connected"
        ) {

          setStatus(
            "接続成功！\\n映像を受信しています"
          );

        }


        if (
          state ===
          "failed"
        ) {

          setStatus(
            "WebRTC接続に失敗しました"
          );

        }

      };


    await receiverPeer
      .setRemoteDescription(
        msg.sdp
      );


    // Offerより先にICEが来ていた場合

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


  // ----------------------------------------------------------
  // ICE
  // ----------------------------------------------------------

  if (
    msg.type ===
    "ice"
  ) {

    // Sender receives Receiver ICE

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


    // Receiver receives Sender ICE

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
              ideal: 30,
              max: 30
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


      infoBox.textContent =
        "入力: " +
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
        "fps\\n" +
        "送信: 最大1280×720 / 30fps";


      track.onended =
        () => {

          for (
            const pc
            of senderPeers.values()
          ) {

            pc.close();

          }


          senderPeers.clear();


          if (
            socket &&
            socket.readyState ===
              WebSocket.OPEN
          ) {

            socket.close();

          }


          setStatus(
            "画面共有を終了しました"
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


    setStatus(
      "送信開始\\n受信者を待っています..."
    );

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

    console.error(
      error
    );


    setStatus(
      "受信エラー\\n" +
      error.message
    );

  }

};


// ============================================================
// Fullscreen
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
        "まだ映像を受信していません"
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

    else {

      throw new Error(
        "全画面表示に対応していません"
      );

    }

  }

  catch (error) {

    setStatus(
      "全画面エラー\\n" +
      error.message
    );

  }

};

</script>

</body>

</html>
`;


// ============================================================
// HTTP
// ============================================================

app.get(
  "/",
  (req, res) => {

    res
      .type("html")
      .send(HTML);

  }
);


app.get(
  "/health",
  (req, res) => {

    let receivers =
      0;


    for (
      const room
      of rooms.values()
    ) {

      receivers +=
        room.receivers.size;

    }


    res.json({

      ok:
        true,

      rooms:
        rooms.size,

      receivers,

      websocket:
        true,

      webrtc:
        true

    });

  }
);


// ============================================================
// Start
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "WebRTC Caster listening on",
      PORT
    );

  }
);
