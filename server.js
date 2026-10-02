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

const rooms =
  new Map();


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
    body.sessionId.length >= 8 &&
    body.sdp &&
    typeof body.sdp.type ===
      "string" &&
    typeof body.sdp.sdp ===
      "string"
  );

}


function createRoom(roomId) {

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


function getOrCreateRoom(roomId) {

  return (
    rooms.get(roomId) ??
    createRoom(roomId)
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
        now - receiver.updatedAt >
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

      version:
        "2.0",

      rooms:
        rooms.size,

      time:
        Date.now()

    });

  }
);


// ============================================================
// Receiver Join
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

        updatedAt:
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
// Receiver List
// ============================================================

app.get(
  "/api/room/:room/receivers",
  (req, res) => {

    const room =
      rooms.get(
        req.params.room
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
// Offer POST
// ============================================================

app.post(
  "/api/room/:room/peer/:receiver/offer",
  (req, res) => {

    const roomId =
      req.params.room;

    const receiverId =
      req.params.receiver;


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
// Offer GET
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
// Answer POST
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
// Answer GET
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
  box-sizing:
    border-box;
}


html,
body {

  margin: 0;

  min-height: 100%;

  color: #eee;

  background:
    #101114;

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
    12px 18px;

  border: 0;

  border-radius:
    8px;

  font-size:
    16px;

  color:
    white;

  background:
    #2868d8;

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

  min-height: 60px;

  margin:
    15px 0;

  padding:
    15px;

  white-space:
    pre-wrap;

  color:
    #90d8ff;

  background:
    #20232a;

  border-radius:
    8px;

  font-family:
    monospace;

}


.info {

  margin-top:
    12px;

  padding:
    10px;

  white-space:
    pre-wrap;

  color:
    #aaa;

  background:
    #15171b;

  border-radius:
    8px;

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

受信側で②
→ 送信側で③
→ 受信側で④
→ 送信側でもう一度③

</p>


<div
  id="captureInfo"
  class="info">
未キャプチャ
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


const captureInfo =
  document.getElementById(
    "captureInfo"
  );


const video =
  document.getElementById(
    "video"
  );


// ============================================================
// Helpers
// ============================================================

function status(text) {

  console.log(text);

  statusBox.textContent =
    text;

}


function getRoom() {

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
// ICE
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
          changed
        );


        resolve();

      }


      function changed() {

        if (
          pc.iceGatheringState ===
          "complete"
        ) {

          finish();

        }

      }


      pc.addEventListener(
        "icegatheringstatechange",
        changed
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
        "ICE:",
        pc.iceConnectionState
      );

    };


  return pc;

}


// ============================================================
// Video sender setup
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

    return sender;

  }


  const settings =
    track.getSettings();


  const width =
    settings.width ??
    1280;


  const height =
    settings.height ??
    720;


  // ==========================================================
  // 最大720p
  //
  // 1920x1080 -> 1.5
  // 2560x1440 -> 2
  // 3840x2160 -> 3
  //
  // 720p未満は拡大しない
  // ==========================================================

  const scale =
    Math.max(
      1,
      width / 1280,
      height / 720
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


    // 最大720p

    parameters
      .encodings[0]
      .scaleResolutionDownBy =
        scale;


    // 最大30fps

    parameters
      .encodings[0]
      .maxFramerate =
        30;


    // 最大20Mbps

    parameters
      .encodings[0]
      .maxBitrate =
        20_000_000;


    // --------------------------------------------------------
    // 回線が苦しい場合：
    //
    // 解像度を落とすより
    // フレームレートを先に犠牲にしてほしい
    // --------------------------------------------------------

    parameters
      .degradationPreference =
        "maintain-resolution";


    await sender
      .setParameters(
        parameters
      );


    console.log(
      "Video sender:",
      {
        source:
          width +
          "x" +
          height,

        scale,

        maxBitrate:
          20_000_000,

        maxFramerate:
          30,

        degradationPreference:
          "maintain-resolution"
      }
    );

  }

  catch (error) {

    console.warn(
      "送信パラメータの適用に失敗:",
      error
    );

  }


  return sender;

}


// ============================================================
// ① Sender Start
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

      // --------------------------------------------------------
      // 文字・細部を優先
      // --------------------------------------------------------

      try {

        track.contentHint =
          "detail";

      }

      catch {}


      const settings =
        track.getSettings();


      captureInfo.textContent =
        "入力映像: " +
        (
          settings.width ??
          "?"
        ) +
        "×" +
        (
          settings.height ??
          "?"
        ) +
        "\\n入力FPS: " +
        (
          settings.frameRate ??
          "?"
        ) +
        "\\n送信解像度: 最大1280×720" +
        "\\n送信FPS: 最大30" +
        "\\n帯域上限: 20 Mbps / 受信者" +
        "\\n品質方針: 解像度優先";


      track.onended =
        () => {

          for (
            const info
            of senderPeers.values()
          ) {

            info.pc.close();

          }


          senderPeers.clear();


          status(
            "画面共有を終了しました"
          );

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
        "先に①を実行してください"
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


    let answers =
      0;


    for (
      const id
      of data.receivers
    ) {

      // ======================================================
      // Existing peer
      // ======================================================

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


              answers++;

            }

          }

          catch {

            // Answer未作成なら無視

          }

        }


        continue;

      }


      // ======================================================
      // New peer
      // ======================================================

      const pc =
        createPeer();


      for (
        const track
        of stream.getTracks()
      ) {

        await addVideoTrack(
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
      "新規Offer: " +
      newPeers +
      "\\n" +
      "Answer適用: " +
      answers +
      "\\n\\n" +
      "新規受信者は④を押してください。\\n" +
      "その後、送信側で③をもう一度押します。"
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

          status(
            "接続成功！\\n" +
            "解像度優先モードで受信中"
          );

        }


        if (
          state ===
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
      "WebRTC Caster v2 running on port",
      PORT
    );

  }
);
