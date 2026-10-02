import express from "express";
import crypto from "node:crypto";

const app = express();

const PORT =
  Number(process.env.PORT || 10000);

const EXPIRE_MS =
  10 * 60 * 1000;


// ============================================================
// Middleware
// ============================================================

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use((req, res, next) => {
  res.set(
    "Cache-Control",
    "no-store"
  );

  next();
});


// ============================================================
// Rooms
// ============================================================
//
// room = {
//   createdAt,
//   receivers: Map<receiverId, {
//      createdAt,
//      offer,
//      answer
//   }>
// }
//
// ============================================================

const rooms =
  new Map();


function getOrCreateRoom(roomId) {

  let room =
    rooms.get(roomId);

  if (!room) {

    room = {
      createdAt:
        Date.now(),

      receivers:
        new Map()
    };

    rooms.set(
      roomId,
      room
    );
  }

  return room;
}


function validRoomId(value) {

  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,32}$/
      .test(value)
  );
}


function validReceiverId(value) {

  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/
      .test(value)
  );
}


function validSignal(body) {

  return (
    body &&
    typeof body.sessionId ===
      "string" &&

    body.sdp &&
    typeof body.sdp.type ===
      "string" &&

    typeof body.sdp.sdp ===
      "string"
  );
}


// ============================================================
// Cleanup
// ============================================================

setInterval(() => {

  const now =
    Date.now();

  for (
    const [roomId, room]
    of rooms
  ) {

    for (
      const [receiverId, receiver]
      of room.receivers
    ) {

      if (
        now - receiver.createdAt >
        EXPIRE_MS
      ) {

        room.receivers.delete(
          receiverId
        );

      }

    }


    if (
      room.receivers.size === 0 &&
      now - room.createdAt >
        EXPIRE_MS
    ) {

      rooms.delete(
        roomId
      );

    }

  }

}, 60_000);


// ============================================================
// Health
// ============================================================

app.get(
  "/health",
  (req, res) => {

    res.json({
      ok: true,
      service:
        "WebRTC Caster",
      rooms:
        rooms.size
    });

  }
);


// ============================================================
// Receiver JOIN
// ============================================================

app.post(
  "/api/room/:room/receiver",
  (req, res) => {

    const roomId =
      req.params.room;


    if (
      !validRoomId(roomId)
    ) {

      return res
        .status(400)
        .json({
          error:
            "Invalid room"
        });

    }


    const room =
      getOrCreateRoom(
        roomId
      );


    const receiverId =
      crypto.randomUUID();


    room.receivers.set(
      receiverId,
      {
        createdAt:
          Date.now(),

        offer:
          null,

        answer:
          null
      }
    );


    res.json({
      ok: true,

      room:
        roomId,

      receiverId
    });

  }
);


// ============================================================
// Sender: receiver list
// ============================================================

app.get(
  "/api/room/:room/receivers",
  (req, res) => {

    const roomId =
      req.params.room;


    const room =
      rooms.get(roomId);


    if (!room) {

      return res.json({
        receivers: []
      });

    }


    res.json({

      receivers:
        [...room.receivers.keys()]

    });

  }
);


// ============================================================
// OFFER POST
// ============================================================

app.post(
  "/api/room/:room/peer/:receiver/offer",
  (req, res) => {

    const {
      room: roomId,
      receiver: receiverId
    } = req.params;


    if (
      !validRoomId(roomId) ||
      !validReceiverId(receiverId)
    ) {

      return res
        .status(400)
        .json({
          error:
            "Invalid ID"
        });

    }


    if (
      !validSignal(req.body)
    ) {

      return res
        .status(400)
        .json({
          error:
            "Invalid signal"
        });

    }


    const room =
      rooms.get(roomId);


    const receiver =
      room?.receivers.get(
        receiverId
      );


    if (!receiver) {

      return res
        .status(404)
        .json({
          error:
            "Receiver not found"
        });

    }


    receiver.createdAt =
      Date.now();


    receiver.offer = {

      sessionId:
        req.body.sessionId,

      createdAt:
        Date.now(),

      sdp:
        req.body.sdp

    };


    // 古いAnswerを破棄

    receiver.answer =
      null;


    res.json({
      ok: true
    });

  }
);


// ============================================================
// OFFER GET
// ============================================================

app.get(
  "/api/room/:room/peer/:receiver/offer",
  (req, res) => {

    const room =
      rooms.get(
        req.params.room
      );


    const receiver =
      room?.receivers.get(
        req.params.receiver
      );


    if (
      !receiver?.offer
    ) {

      return res
        .status(404)
        .json({
          error:
            "Offer not found"
        });

    }


    res.json(
      receiver.offer
    );

  }
);


// ============================================================
// ANSWER POST
// ============================================================

app.post(
  "/api/room/:room/peer/:receiver/answer",
  (req, res) => {

    const room =
      rooms.get(
        req.params.room
      );


    const receiver =
      room?.receivers.get(
        req.params.receiver
      );


    if (
      !receiver?.offer
    ) {

      return res
        .status(404)
        .json({
          error:
            "Offer not found"
        });

    }


    if (
      !validSignal(req.body)
    ) {

      return res
        .status(400)
        .json({
          error:
            "Invalid signal"
        });

    }


    if (
      receiver.offer
        .sessionId !==
      req.body.sessionId
    ) {

      return res
        .status(409)
        .json({
          error:
            "Session mismatch"
        });

    }


    receiver.createdAt =
      Date.now();


    receiver.answer = {

      sessionId:
        req.body.sessionId,

      createdAt:
        Date.now(),

      sdp:
        req.body.sdp

    };


    res.json({
      ok: true
    });

  }
);


// ============================================================
// ANSWER GET
// ============================================================

app.get(
  "/api/room/:room/peer/:receiver/answer",
  (req, res) => {

    const room =
      rooms.get(
        req.params.room
      );


    const receiver =
      room?.receivers.get(
        req.params.receiver
      );


    if (
      !receiver?.answer
    ) {

      return res
        .status(404)
        .json({
          error:
            "Answer not found"
        });

    }


    res.json(
      receiver.answer
    );

  }
);


// ============================================================
// Web UI
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

body {

  margin: 0;
  padding: 24px;

  color: #eee;
  background: #101114;

  font-family:
    system-ui,
    sans-serif;

}

main {

  width: 100%;
  max-width: 800px;

  margin: auto;

}

section {

  padding: 20px;
  margin: 16px 0;

  background: #1b1d22;

  border: 1px solid #333;
  border-radius: 12px;

}

input {

  width: 100%;

  padding: 12px;

  font-size: 22px;

  color: white;
  background: #272a30;

  border: 1px solid #555;
  border-radius: 8px;

}

button {

  margin: 5px 3px;
  padding: 12px 18px;

  border: 0;
  border-radius: 8px;

  color: white;
  background: #2868d8;

  font-size: 16px;

  cursor: pointer;

}

button:hover {
  filter: brightness(1.15);
}

#fullscreen {
  background: #7544c7;
}

#status {

  min-height: 60px;

  padding: 15px;
  margin: 15px 0;

  white-space: pre-wrap;

  color: #90d8ff;
  background: #20232a;

  border-radius: 8px;

  font-family: monospace;

}

video {

  display: block;

  width: 100%;

  max-height: 75vh;

  margin-top: 15px;

  background: black;

  border-radius: 10px;

  object-fit: contain;

}

video:fullscreen {

  width: 100vw;
  height: 100vh;

  max-width: none;
  max-height: none;

  margin: 0;

  border-radius: 0;

  background: black;

  object-fit: contain;

}

.small {
  color: #aaa;
  font-size: 14px;
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
ルーム
</h2>

<input
  id="room"
  value="1111"
>

</section>


<section>

<h2>
送信
</h2>

<button id="startSender">
① 画面共有
</button>

<button id="connectReceivers">
③ 受信者を接続
</button>

<p class="small">
受信者が②を押したあと③。受信者が④を押したら③をもう一度。
</p>

</section>


<section>

<h2>
受信
</h2>

<button id="joinReceiver">
② 受信準備
</button>

<button id="finishReceiver">
④ 接続
</button>

<button id="fullscreen">
⛶ 全画面
</button>

<video
  id="video"
  autoplay
  playsinline
></video>

</section>

</main>


<script>

const statusBox =
  document.getElementById(
    "status"
  );

const video =
  document.getElementById(
    "video"
  );


let stream =
  null;

let receiverId =
  null;

let receiverPeer =
  null;


// sender側

const senderPeers =
  new Map();


function status(text) {

  console.log(text);

  statusBox.textContent =
    text;

}


function room() {

  const value =
    document
      .getElementById("room")
      .value
      .trim();


  if (
    !/^[A-Za-z0-9_-]{1,32}$/
      .test(value)
  ) {

    throw new Error(
      "ルームIDが不正です"
    );

  }


  return value;

}


async function request(
  path,
  options = {}
) {

  const response =
    await fetch(
      path,
      {
        ...options,
        cache: "no-store"
      }
    );


  const data =
    await response.json();


  if (!response.ok) {

    throw new Error(
      data.error ??
      "HTTP Error"
    );

  }


  return data;

}


function waitICE(
  pc,
  timeout = 10000
) {

  if (
    pc.iceGatheringState ===
    "complete"
  ) {

    return Promise.resolve();

  }


  return new Promise(
    resolve => {

      let done = false;


      function finish() {

        if (done)
          return;

        done = true;

        clearTimeout(timer);

        pc.removeEventListener(
          "icegatheringstatechange",
          change
        );

        resolve();

      }


      function change() {

        if (
          pc.iceGatheringState ===
          "complete"
        ) {

          finish();

        }

      }


      pc.addEventListener(
        "icegatheringstatechange",
        change
      );


      const timer =
        setTimeout(
          finish,
          timeout
        );

    }
  );

}


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
// ① Sender
// ============================================================

document
.getElementById(
  "startSender"
)
.onclick =
async () => {

  try {

    status(
      "共有する画面を選択してください..."
    );


    stream =
      await navigator
        .mediaDevices
        .getDisplayMedia({

          video: {
            frameRate: {
              ideal: 30,
              max: 30
            }
          },

          audio: false

        });


    status(
      "画面共有準備完了"
    );

  }

  catch (e) {

    status(
      "送信エラー\\n" +
      e.message
    );

  }

};


// ============================================================
// ② Receiver
// ============================================================

document
.getElementById(
  "joinReceiver"
)
.onclick =
async () => {

  try {

    const result =
      await request(

        "/api/room/" +
        encodeURIComponent(room()) +
        "/receiver",

        {
          method: "POST"
        }

      );


    receiverId =
      result.receiverId;


    status(
      "受信準備完了\\n" +
      "Receiver ID: " +
      receiverId +
      "\\n\\n送信側で③を押してください。"
    );

  }

  catch (e) {

    status(
      "受信準備エラー\\n" +
      e.message
    );

  }

};


// ============================================================
// ③ Sender
// ============================================================

document
.getElementById(
  "connectReceivers"
)
.onclick =
async () => {

  try {

    if (!stream) {

      throw new Error(
        "先に①を実行してください"
      );

    }


    const data =
      await request(

        "/api/room/" +
        encodeURIComponent(room()) +
        "/receivers"

      );


    for (
      const id
      of data.receivers
    ) {

      // ----------------------------------
      // 既存Peer
      // ----------------------------------

      if (
        senderPeers.has(id)
      ) {

        const info =
          senderPeers.get(id);


        if (
          !info.pc.remoteDescription
        ) {

          try {

            const answer =
              await request(

                "/api/room/" +
                encodeURIComponent(room()) +
                "/peer/" +
                encodeURIComponent(id) +
                "/answer"

              );


            if (
              answer.sessionId ===
              info.sessionId
            ) {

              await info.pc
                .setRemoteDescription(
                  answer.sdp
                );

            }

          }

          catch (error) {

            console.log(
              "Answer not ready:",
              id
            );

          }

        }


        continue;

      }


      // ----------------------------------
      // New receiver
      // ----------------------------------

      const pc =
        createPeer();


      for (
        const track
        of stream.getTracks()
      ) {

        pc.addTrack(
          track,
          stream
        );

      }


      const offer =
        await pc.createOffer();


      await pc
        .setLocalDescription(
          offer
        );


      await waitICE(
        pc
      );


      const sessionId =
        crypto.randomUUID();


      senderPeers.set(
        id,
        {
          pc,
          sessionId
        }
      );


      await request(

        "/api/room/" +
        encodeURIComponent(room()) +
        "/peer/" +
        encodeURIComponent(id) +
        "/offer",

        {

          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({

              sessionId,

              sdp:
                pc.localDescription

            })

        }

      );

    }


    status(
      "受信者: " +
      data.receivers.length +
      "人\\n\\n" +
      "新規受信者は④を押してください。\\n" +
      "④の後、③をもう一度押します。"
    );

  }

  catch (e) {

    status(
      "接続処理エラー\\n" +
      e.message
    );

  }

};


// ============================================================
// ④ Receiver
// ============================================================

document
.getElementById(
  "finishReceiver"
)
.onclick =
async () => {

  try {

    if (!receiverId) {

      throw new Error(
        "先に②を実行してください"
      );

    }


    const offer =
      await request(

        "/api/room/" +
        encodeURIComponent(room()) +
        "/peer/" +
        encodeURIComponent(receiverId) +
        "/offer"

      );


    receiverPeer =
      createPeer();


    receiverPeer.ontrack =
      event => {

        if (
          event.streams[0]
        ) {

          video.srcObject =
            event.streams[0];

        }

      };


    await receiverPeer
      .setRemoteDescription(
        offer.sdp
      );


    const answer =
      await receiverPeer
        .createAnswer();


    await receiverPeer
      .setLocalDescription(
        answer
      );


    await waitICE(
      receiverPeer
    );


    await request(

      "/api/room/" +
      encodeURIComponent(room()) +
      "/peer/" +
      encodeURIComponent(receiverId) +
      "/answer",

      {

        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({

            sessionId:
              offer.sessionId,

            sdp:
              receiverPeer
                .localDescription

          })

      }

    );


    status(
      "Answer送信完了\\n" +
      "送信側で③をもう一度押してください。"
    );

  }

  catch (e) {

    status(
      "受信エラー\\n" +
      e.message
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

    if (!video.srcObject) {

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

  catch (e) {

    status(
      "全画面エラー\\n" +
      e.message
    );

  }

};

</script>

</body>
</html>
`;


// ============================================================
// Start
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "WebRTC Caster listening on port",
      PORT
    );

  }
);
