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

app.use(
  (req, res, next) => {

    res.set(
      "Cache-Control",
      "no-store"
    );

    next();

  }
);


// ============================================================
// Rooms
// ============================================================
//
// rooms
//   └ roomId
//       └ receivers
//           └ receiverId
//               ├ offer
//               └ answer
//
// ============================================================

const rooms =
  new Map();


function validRoomId(
  value
) {

  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,32}$/
      .test(value)
  );

}


function validReceiverId(
  value
) {

  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/
      .test(value)
  );

}


function validSignal(
  body
) {

  return (
    body &&
    typeof body.sessionId ===
      "string" &&
    body.sessionId.length >=
      8 &&
    body.sdp &&
    typeof body.sdp.type ===
      "string" &&
    typeof body.sdp.sdp ===
      "string"
  );

}


function createRoom(
  roomId
) {

  const room = {

    createdAt:
      Date.now(),

    receivers:
      new Map()

  };


  rooms.set(
    roomId,
    room
  );


  return room;

}


function getOrCreateRoom(
  roomId
) {

  return (
    rooms.get(roomId) ??
    createRoom(roomId)
  );

}


// ============================================================
// Cleanup
// ============================================================

setInterval(
  () => {

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
          now -
          receiver.updatedAt >
          EXPIRE_MS
        ) {

          room.receivers.delete(
            receiverId
          );

        }

      }


      if (
        room.receivers.size ===
          0 &&
        now -
        room.createdAt >
        EXPIRE_MS
      ) {

        rooms.delete(
          roomId
        );

      }

    }

  },

  60_000
);


// ============================================================
// Health
// ============================================================

app.get(
  "/health",
  (req, res) => {

    res.json({

      ok:
        true,

      service:
        "WebRTC Caster",

      rooms:
        rooms.size,

      time:
        Date.now()

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
      !validRoomId(
        roomId
      )
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

        updatedAt:
          Date.now(),

        offer:
          null,

        answer:
          null

      }
    );


    res.json({

      ok:
        true,

      room:
        roomId,

      receiverId

    });

  }
);


// ============================================================
// Receiver List
// ============================================================

app.get(
  "/api/room/:room/receivers",
  (req, res) => {

    const roomId =
      req.params.room;


    const room =
      rooms.get(
        roomId
      );


    if (!room) {

      return res.json({
        receivers: []
      });

    }


    res.json({

      receivers:
        [
          ...room.receivers.keys()
        ]

    });

  }
);


// ============================================================
// POST OFFER
// ============================================================

app.post(
  "/api/room/:room/peer/:receiver/offer",
  (req, res) => {

    const roomId =
      req.params.room;

    const receiverId =
      req.params.receiver;


    if (
      !validRoomId(
        roomId
      ) ||
      !validReceiverId(
        receiverId
      )
    ) {

      return res
        .status(400)
        .json({
          error:
            "Invalid ID"
        });

    }


    if (
      !validSignal(
        req.body
      )
    ) {

      return res
        .status(400)
        .json({
          error:
            "Invalid signal"
        });

    }


    const room =
      rooms.get(
        roomId
      );


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


    receiver.updatedAt =
      Date.now();


    receiver.offer = {

      sessionId:
        req.body.sessionId,

      createdAt:
        Date.now(),

      sdp:
        req.body.sdp

    };


    receiver.answer =
      null;


    res.json({
      ok: true
    });

  }
);


// ============================================================
// GET OFFER
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
// POST ANSWER
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
      !validSignal(
        req.body
      )
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


    receiver.updatedAt =
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
// GET ANSWER
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

  background: #101114;

  color: #eeeeee;

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

  background: #1b1d22;

  border:
    1px solid #333;

  border-radius:
    12px;

}


input {

  width: 100%;

  padding: 12px;

  color: white;

  background: #292c33;

  border:
    1px solid #555;

  border-radius:
    8px;

  font-size:
    22px;

}


button {

  margin:
    6px 3px;

  padding:
    12px 18px;

  border:
    none;

  border-radius:
    8px;

  color:
    white;

  background:
    #2868d8;

  font-size:
    16px;

  cursor:
    pointer;

}


button:hover {
  filter:
    brightness(1.15);
}


#senderConnect {
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
    15px 0;

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

  background:
    black;

  border-radius:
    0;

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
ルーム
</h2>

<input
  id="room"
  value="1111"
  maxlength="32"
>

</section>


<section>

<h2>
送信
</h2>


<button id="senderStart">
① 画面共有を開始
</button>


<button id="senderConnect">
③ 受信者を確認・接続
</button>


<p class="small">

受信者が②を押す
→ 送信側で③
→ 受信者が④
→ 送信側でもう一度③

</p>


<div
  id="captureInfo"
  class="small">
</div>

</section>


<section>

<h2>
受信
</h2>


<button id="receiverJoin">
② 受信準備
</button>


<button id="receiverConnect">
④ 映像に接続
</button>


<button id="fullscreen">
⛶ 全画面表示
</button>


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

const senderPeers =
  new Map();


let stream =
  null;


let receiverId =
  null;


let receiverPeer =
  null;


const statusBox =
  document.getElementById(
    "status"
  );


const video =
  document.getElementById(
    "video"
  );


const captureInfo =
  document.getElementById(
    "captureInfo"
  );


// ============================================================
// UI
// ============================================================

function status(
  text
) {

  console.log(
    text
  );


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
// HTTP
// ============================================================

async function request(
  url,
  options = {}
) {

  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () =>
        controller.abort(),
      15000
    );


  try {

    const response =
      await fetch(
        url,
        {
          ...options,

          cache:
            "no-store",

          signal:
            controller.signal
        }
      );


    const data =
      await response.json();


    if (
      !response.ok
    ) {

      throw new Error(
        data.error ??
        "HTTP Error"
      );

    }


    return data;

  }

  catch (error) {

    if (
      error.name ===
      "AbortError"
    ) {

      throw new Error(
        "HTTP通信がタイムアウトしました"
      );

    }


    throw error;

  }

  finally {

    clearTimeout(
      timer
    );

  }

}


// ============================================================
// ICE gathering
// ============================================================

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

      let done =
        false;


      function finish() {

        if (done)
          return;


        done =
          true;


        clearTimeout(
          timer
        );


        pc.removeEventListener(
          "icegatheringstatechange",
          change
        );


        resolve();

      }


      function change() {

        console.log(
          "ICE:",
          pc.iceGatheringState
        );


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


// ============================================================
// PeerConnection
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


  pc.oniceconnectionstatechange =
    () => {

      console.log(
        "ICE connection:",
        pc.iceConnectionState
      );

    };


  return pc;

}


// ============================================================
// 720p制限
// ============================================================

async function add720pTrack(
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

    return sender;

  }


  const settings =
    track.getSettings();


  const width =
    settings.width ||
    1280;


  const height =
    settings.height ||
    720;


  // 1280x720の枠内に収める。
  // 1未満にはしないので拡大はしない。

  const scale =
    Math.max(
      1,

      width /
        1280,

      height /
        720
    );


  try {

    const parameters =
      sender.getParameters();


    if (
      !parameters.encodings ||
      parameters.encodings.length ===
        0
    ) {

      parameters.encodings =
        [{}];

    }


    parameters
      .encodings[0]
      .scaleResolutionDownBy =
        scale;


    parameters
      .encodings[0]
      .maxFramerate =
        30;


    // 2.5Mbps

    parameters
      .encodings[0]
      .maxBitrate =
        2500000;


    await sender
      .setParameters(
        parameters
      );


    console.log(
      "720p limit:",
      {
        width,
        height,
        scale,
        maxFramerate:
          30,
        maxBitrate:
          2500000
      }
    );

  }

  catch (error) {

    // ブラウザによっては
    // setParametersの一部制限を
    // 受け付けない場合がある。
    // WebRTCそのものは続行する。

    console.warn(
      "720p制限の適用失敗:",
      error
    );

  }


  return sender;

}


// ============================================================
// ① Sender start
// ============================================================

document
.getElementById(
  "senderStart"
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

          audio:
            false

        });


    const track =
      stream
        .getVideoTracks()[0];


    if (track) {

      // 動画・動きを優先
      try {

        track.contentHint =
          "motion";

      }

      catch {}


      const settings =
        track.getSettings();


      captureInfo.textContent =
        "キャプチャ: " +
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
        "送信上限: 1280×720 / 30fps / 2.5Mbps";


      track.onended =
        () => {

          status(
            "画面共有を終了しました"
          );


          for (
            const info
            of senderPeers.values()
          ) {

            info.pc.close();

          }


          senderPeers.clear();

        };

    }


    status(
      "① 完了\\n" +
      "受信者に②を押してもらってください。"
    );

  }

  catch (error) {

    console.error(
      error
    );


    status(
      "画面共有エラー\\n" +
      error.message
    );

  }

};


// ============================================================
// ② Receiver Join
// ============================================================

document
.getElementById(
  "receiverJoin"
)
.onclick =
async () => {

  try {

    const result =
      await request(

        "/api/room/" +
        encodeURIComponent(
          getRoom()
        ) +
        "/receiver",

        {
          method:
            "POST"
        }

      );


    receiverId =
      result.receiverId;


    status(
      "② 完了\\n" +
      "受信準備ができました。\\n" +
      "送信側で③を押してください。"
    );

  }

  catch (error) {

    console.error(
      error
    );


    status(
      "受信準備エラー\\n" +
      error.message
    );

  }

};


// ============================================================
// ③ Sender Connect
// ============================================================

document
.getElementById(
  "senderConnect"
)
.onclick =
async () => {

  try {

    if (!stream) {

      throw new Error(
        "先に①で画面共有を開始してください"
      );

    }


    const room =
      getRoom();


    const data =
      await request(

        "/api/room/" +
        encodeURIComponent(
          room
        ) +
        "/receivers"

      );


    let newPeers =
      0;


    let connectedAnswers =
      0;


    for (
      const id
      of data.receivers
    ) {

      // ======================================================
      // Existing Peer
      // ======================================================

      if (
        senderPeers.has(
          id
        )
      ) {

        const info =
          senderPeers.get(
            id
          );


        if (
          !info.pc
            .remoteDescription
        ) {

          try {

            const answer =
              await request(

                "/api/room/" +
                encodeURIComponent(
                  room
                ) +
                "/peer/" +
                encodeURIComponent(
                  id
                ) +
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


              connectedAnswers++;

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


      // ======================================================
      // New Peer
      // ======================================================

      const pc =
        createPeer();


      for (
        const track
        of stream.getTracks()
      ) {

        await add720pTrack(
          pc,
          track,
          stream
        );

      }


      const offer =
        await pc
          .createOffer();


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
        encodeURIComponent(
          room
        ) +
        "/peer/" +
        encodeURIComponent(
          id
        ) +
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


      newPeers++;

    }


    status(
      "③ 処理完了\\n\\n" +
      "受信者: " +
      data.receivers.length +
      "人\\n" +
      "新規接続準備: " +
      newPeers +
      "人\\n" +
      "Answer適用: " +
      connectedAnswers +
      "人\\n\\n" +
      "新規受信者は④を押してください。\\n" +
      "④の後、送信側で③をもう一度押します。"
    );

  }

  catch (error) {

    console.error(
      error
    );


    status(
      "送信接続エラー\\n" +
      error.message
    );

  }

};


// ============================================================
// ④ Receiver Connect
// ============================================================

document
.getElementById(
  "receiverConnect"
)
.onclick =
async () => {

  try {

    if (!receiverId) {

      throw new Error(
        "先に②を実行してください"
      );

    }


    const room =
      getRoom();


    status(
      "Offerを取得しています..."
    );


    const offer =
      await request(

        "/api/room/" +
        encodeURIComponent(
          room
        ) +
        "/peer/" +
        encodeURIComponent(
          receiverId
        ) +
        "/offer"

      );


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


    receiverPeer
      .onconnectionstatechange =
      () => {

        console.log(
          "Receiver WebRTC:",
          receiverPeer.connectionState
        );


        if (
          receiverPeer
            .connectionState ===
          "connected"
        ) {

          status(
            "接続成功！\\n最大720pで受信中"
          );

        }


        if (
          receiverPeer
            .connectionState ===
          "failed"
        ) {

          status(
            "WebRTC接続に失敗しました"
          );

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
      encodeURIComponent(
        room
      ) +
      "/peer/" +
      encodeURIComponent(
        receiverId
      ) +
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
      "④ 完了\\n" +
      "送信側で③をもう一度押してください。"
    );

  }

  catch (error) {

    console.error(
      error
    );


    status(
      "受信接続エラー\\n" +
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

    if (!video.srcObject) {

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
        "Fullscreen API非対応です"
      );

    }

  }

  catch (error) {

    console.error(
      error
    );


    status(
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
// UI
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
// 404
// ============================================================

app.use(
  (req, res) => {

    res
      .status(404)
      .json({
        error:
          "Not found"
      });

  }
);


// ============================================================
// Start
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "WebRTC Caster running on port",
      PORT
    );

  }
);
