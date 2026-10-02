// ============================================================
// Render WebRTC Caster
// 1 Sender : Multiple Receivers
// Deno / HTTP signaling / No WebSocket
// ============================================================

const PORT =
  Number(Deno.env.get("PORT") ?? "10000");

const EXPIRE_MS =
  10 * 60 * 1000;


// ============================================================
// Types
// ============================================================

type SDP = {
  type: string;
  sdp: string;
};

type OfferData = {
  receiverId: string;
  sessionId: string;
  createdAt: number;
  sdp: SDP;
};

type AnswerData = {
  receiverId: string;
  sessionId: string;
  createdAt: number;
  sdp: SDP;
};

type Room = {
  receivers: Set<string>;

  offers: Map<
    string,
    OfferData
  >;

  answers: Map<
    string,
    AnswerData
  >;

  createdAt: number;
};


const rooms =
  new Map<string, Room>();


// ============================================================
// Cleanup
// ============================================================

function cleanup() {

  const now =
    Date.now();


  for (
    const [roomId, room]
    of rooms
  ) {

    for (
      const [receiverId, offer]
      of room.offers
    ) {

      if (
        now - offer.createdAt >
        EXPIRE_MS
      ) {

        room.offers.delete(
          receiverId
        );

      }

    }


    for (
      const [receiverId, answer]
      of room.answers
    ) {

      if (
        now - answer.createdAt >
        EXPIRE_MS
      ) {

        room.answers.delete(
          receiverId
        );

      }

    }


    if (
      now - room.createdAt >
        EXPIRE_MS &&
      room.offers.size === 0 &&
      room.answers.size === 0
    ) {

      rooms.delete(
        roomId
      );

    }

  }

}


setInterval(
  cleanup,
  60_000
);


// ============================================================
// Utils
// ============================================================

function json(
  data: unknown,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store",

        "Access-Control-Allow-Origin":
          "*",

        "Access-Control-Allow-Methods":
          "GET, POST, DELETE, OPTIONS",

        "Access-Control-Allow-Headers":
          "Content-Type"
      }
    }
  );

}


function getRoom(
  roomId: string
) {

  let room =
    rooms.get(roomId);


  if (!room) {

    room = {
      receivers:
        new Set(),

      offers:
        new Map(),

      answers:
        new Map(),

      createdAt:
        Date.now()
    };


    rooms.set(
      roomId,
      room
    );

  }


  return room;

}


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

  color: #eee;

  font-family:
    system-ui,
    sans-serif;
}

body {
  padding: 24px;
}

main {
  width: 100%;

  max-width: 800px;

  margin: auto;
}

section {
  margin: 16px 0;

  padding: 20px;

  background: #1b1d22;

  border: 1px solid #333;

  border-radius: 12px;
}

input {
  width: 100%;

  padding: 12px;

  margin: 5px 0;

  color: white;

  background: #292c33;

  border: 1px solid #555;

  border-radius: 8px;

  font-size: 20px;
}

button {
  padding: 12px 18px;

  margin: 5px 2px;

  border: 0;

  border-radius: 8px;

  background: #2868d8;

  color: white;

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
  padding: 15px;

  margin: 15px 0;

  min-height: 50px;

  white-space: pre-wrap;

  background: #20232a;

  color: #90d8ff;

  border-radius: 8px;

  font-family: monospace;
}

video {
  display: block;

  width: 100%;

  max-height: 75vh;

  margin-top: 15px;

  background: black;

  object-fit: contain;

  border-radius: 10px;
}

video:fullscreen {
  width: 100vw;

  height: 100vh;

  max-width: none;

  max-height: none;

  margin: 0;

  object-fit: contain;

  background: black;
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
  maxlength="32"
>

</section>


<section>

<h2>
送信する
</h2>

<button id="senderStart">
① 画面共有を開始
</button>

<p class="small">
受信者が②を押した後、「受信者を確認」を押してください。
</p>

<button id="checkReceivers">
③ 受信者を確認・接続
</button>

</section>


<section>

<h2>
受信する
</h2>

<button id="receiverJoin">
② 受信準備
</button>

<button id="receiverFinish">
④ 映像に接続
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

const API =
  location.origin;


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


// Sender:
//
// receiverId
//   ↓
// RTCPeerConnection

const senderPeers =
  new Map();


let receiverPeer =
  null;

let receiverId =
  null;

let receiverSession =
  null;


// ============================================================
// UI
// ============================================================

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


// ============================================================
// Fetch
// ============================================================

async function request(
  path,
  options = {}
) {

  const response =
    await fetch(
      API + path,
      {
        ...options,

        cache:
          "no-store"
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


// ============================================================
// Peer
// ============================================================

function peer() {

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
      "共有する画面を選択..."
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


    status(
      "画面共有準備完了。\\n受信者に②を押してもらってください。"
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
// ② Receiver joins
// ============================================================

document
.getElementById(
  "receiverJoin"
)
.onclick =
async () => {

  try {

    receiverId =
      crypto.randomUUID();


    receiverSession =
      crypto.randomUUID();


    await request(

      "/room/" +
      encodeURIComponent(room()) +
      "/receivers",

      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            receiverId:
              receiverId
          })
      }

    );


    status(
      "受信準備完了。\\n送信者に③を押してもらってください。"
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
// ③ Sender sees receivers
// ============================================================

document
.getElementById(
  "checkReceivers"
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

        "/room/" +
        encodeURIComponent(room()) +
        "/receivers"

      );


    let created =
      0;


    for (
      const id
      of data.receivers
    ) {

      if (
        senderPeers.has(id)
      ) {

        // Answerがあれば適用
        try {

          const answer =
            await request(

              "/room/" +
              encodeURIComponent(room()) +
              "/peer/" +
              encodeURIComponent(id) +
              "/answer"

            );


          const existing =
            senderPeers.get(id);


          if (
            !existing.remoteDescription
          ) {

            await existing
              .setRemoteDescription(
                answer.sdp
              );

          }

        }

        catch {
          // Answer未作成なら無視
        }


        continue;

      }


      const pc =
        peer();


      senderPeers.set(
        id,
        pc
      );


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


      pc._sessionId =
        sessionId;


      await request(

        "/room/" +
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

              sessionId:
                sessionId,

              sdp:
                pc.localDescription

            })
        }

      );


      created++;

    }


    status(
      "受信者数: " +
      data.receivers.length +
      "\\n新規Offer: " +
      created +
      "\\n\\n受信側で④を押してください。"
    );

  }

  catch (e) {

    status(
      "接続準備エラー\\n" +
      e.message
    );

  }

};


// ============================================================
// ④ Receiver gets own offer
// ============================================================

document
.getElementById(
  "receiverFinish"
)
.onclick =
async () => {

  try {

    if (!receiverId) {

      throw new Error(
        "先に②を押してください"
      );

    }


    const offer =
      await request(

        "/room/" +
        encodeURIComponent(room()) +
        "/peer/" +
        encodeURIComponent(receiverId) +
        "/offer"

      );


    receiverPeer =
      peer();


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

      "/room/" +
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
      "Answer送信完了。\\n送信者にもう一度③を押してもらってください。"
    );

  }

  catch (e) {

    status(
      "接続エラー\\n" +
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
        "映像がありません"
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
// Server
// ============================================================

Deno.serve(
  {
    port:
      PORT,

    hostname:
      "0.0.0.0"
  },

  async req => {

    cleanup();


    const url =
      new URL(
        req.url
      );


    if (
      req.method ===
      "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status: 204,

          headers: {
            "Access-Control-Allow-Origin":
              "*",

            "Access-Control-Allow-Methods":
              "GET, POST, DELETE, OPTIONS",

            "Access-Control-Allow-Headers":
              "Content-Type"
          }
        }
      );

    }


    // UI

    if (
      url.pathname ===
      "/"
    ) {

      return new Response(
        HTML,
        {
          headers: {
            "Content-Type":
              "text/html; charset=utf-8"
          }
        }
      );

    }


    // Health

    if (
      url.pathname ===
      "/health"
    ) {

      return json({
        ok: true,
        rooms:
          rooms.size
      });

    }


    // ========================================================
    // Receivers
    // ========================================================

    let match =
      url.pathname.match(
        /^\/room\/([A-Za-z0-9_-]{1,32})\/receivers$/
      );


    if (match) {

      const roomId =
        match[1];


      const room =
        getRoom(
          roomId
        );


      if (
        req.method ===
        "POST"
      ) {

        const body =
          await req.json();


        if (
          typeof body.receiverId !==
          "string"
        ) {

          return json(
            {
              error:
                "receiverId required"
            },
            400
          );

        }


        room.receivers.add(
          body.receiverId
        );


        return json({
          ok:
            true
        });

      }


      if (
        req.method ===
        "GET"
      ) {

        return json({
          receivers:
            [
              ...room.receivers
            ]
        });

      }

    }


    // ========================================================
    // Offer / Answer for each receiver
    // ========================================================

    match =
      url.pathname.match(
        /^\/room\/([A-Za-z0-9_-]{1,32})\/peer\/([A-Za-z0-9_-]{1,64})\/(offer|answer)$/
      );


    if (match) {

      const roomId =
        match[1];


      const receiverId =
        match[2];


      const kind =
        match[3];


      const room =
        getRoom(
          roomId
        );


      const storage =
        kind === "offer"
          ? room.offers
          : room.answers;


      // GET

      if (
        req.method ===
        "GET"
      ) {

        const data =
          storage.get(
            receiverId
          );


        if (!data) {

          return json(
            {
              error:
                kind +
                " not found"
            },
            404
          );

        }


        return json(
          data
        );

      }


      // POST

      if (
        req.method ===
        "POST"
      ) {

        const body =
          await req.json();


        if (
          typeof body.sessionId !==
            "string" ||
          !body.sdp
        ) {

          return json(
            {
              error:
                "Invalid signal"
            },
            400
          );

        }


        if (
          kind ===
          "answer"
        ) {

          const offer =
            room.offers.get(
              receiverId
            );


          if (!offer) {

            return json(
              {
                error:
                  "Offer not found"
              },
              409
            );

          }


          if (
            offer.sessionId !==
            body.sessionId
          ) {

            return json(
              {
                error:
                  "Session mismatch"
              },
              409
            );

          }

        }


        storage.set(
          receiverId,
          {

            receiverId,

            sessionId:
              body.sessionId,

            createdAt:
              Date.now(),

            sdp:
              body.sdp

          }
        );


        return json({
          ok:
            true
        });

      }

    }


    return json(
      {
        error:
          "Not found"
      },
      404
    );

  }
);
