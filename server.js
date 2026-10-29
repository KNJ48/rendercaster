import express from "express";
import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "url";
import path from "path";

const app = express();
const server = http.createServer(app);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/webrtc.js", (req, res) => {
  res.sendFile(path.join(__dirname, "webrtc.js"));
});

app.get("/websocket.html", (req, res) => {
  res.sendFile(path.join(__dirname, "websocket.html"));
});

app.get("/websocket.js", (req, res) => {
  res.sendFile(path.join(__dirname, "websocket.js"));
});

app.get("/websocket-worker.js", (req, res) => {
  res.sendFile(path.join(__dirname, "websocket-worker.js"));
});

/* ========================================
   WebSocketサーバー
======================================== */

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 1024 * 1024
});

const videoWSS = new WebSocketServer({
  noServer: true,
  maxPayload: 2 * 1024 * 1024,
  perMessageDeflate: false
});

server.on("upgrade", (request, socket, head) => {
  let pathname;

  try {
    pathname = new URL(
      request.url,
      "http://localhost"
    ).pathname;
  } catch {
    socket.destroy();
    return;
  }

  let target = null;

  if (pathname === "/signal") {
    target = wss;
  }

  if (pathname === "/video") {
    target = videoWSS;
  }

  if (!target) {
    socket.destroy();
    return;
  }

  target.handleUpgrade(
    request,
    socket,
    head,
    ws => {
      target.emit("connection", ws, request);
    }
  );
});

/* ========================================
   共通処理
======================================== */

const rooms = new Map();
const videoRooms = new Map();

function send(ws, data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function validRoom(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 100
  );
}

function cleanName(value) {
  if (typeof value !== "string") {
    return "ゲスト";
  }

  return value.trim().slice(0, 80) || "ゲスト";
}

function cleanMemo(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, 300);
}

function roman(n) {
  const values = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"]
  ];

  let result = "";

  for (const [value, symbol] of values) {
    while (n >= value) {
      result += symbol;
      n -= value;
    }
  }

  return result;
}

function nextRoomID(map) {
  for (let i = 1; i <= 3999; i++) {
    const id = roman(i);

    if (!map.has(id)) {
      return id;
    }
  }

  return crypto.randomUUID().slice(0, 8);
}

/* ========================================
   WebRTC v22.2
======================================== */

function activeRooms() {
  const list = [];

  for (const [id, room] of rooms) {
    if (room.sender) {
      list.push({
        id,
        name: room.name,
        memo: room.memo
      });
    }
  }

  return list;
}

function broadcastRooms() {
  const data = {
    type: "room-list",
    rooms: activeRooms(),
    suggestedRoom: nextRoomID(rooms)
  };

  for (const client of wss.clients) {
    send(client, data);
  }
}

function leave(ws) {
  const info = ws.roomInfo;

  if (!info) return;

  ws.roomInfo = null;

  const room = rooms.get(info.room);

  if (!room) return;

  if (
    info.role === "sender" &&
    room.sender === ws
  ) {
    room.sender = null;

    for (const receiver of room.receivers.values()) {
      send(receiver, {
        type: "sender-left"
      });
    }

    room.receivers.clear();

    rooms.delete(info.room);

  } else if (info.role === "receiver") {
    room.receivers.delete(info.id);

    send(room.sender, {
      type: "receiver-left",
      receiverId: info.id
    });

    if (
      !room.sender &&
      room.receivers.size === 0
    ) {
      rooms.delete(info.room);
    }
  }

  broadcastRooms();
}

wss.on("connection", ws => {
  send(ws, {
    type: "room-list",
    rooms: activeRooms(),
    suggestedRoom: nextRoomID(rooms)
  });

  ws.on("message", raw => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.type === "leave") {
      leave(ws);
      return;
    }

    if (data.type === "join") {
      const id = data.room;

      if (!validRoom(id)) {
        send(ws, {
          type: "error",
          message: "ルームIDは1〜100文字で入力してください"
        });

        return;
      }

      if (
        data.role !== "sender" &&
        data.role !== "receiver"
      ) {
        return;
      }

      leave(ws);

      let room = rooms.get(id);

      if (!room) {
        room = {
          sender: null,
          receivers: new Map(),
          name: "ゲスト",
          memo: ""
        };

        rooms.set(id, room);
      }

      if (data.role === "sender") {
        if (
          room.sender &&
          room.sender !== ws
        ) {
          send(ws, {
            type: "error",
            message: "このルームでは既に配信中です"
          });

          return;
        }

        room.sender = ws;
        room.name = cleanName(data.name);
        room.memo = cleanMemo(data.memo);

        ws.roomInfo = {
          room: id,
          role: "sender"
        };

        send(ws, {
          type: "joined",
          role: "sender",
          room: id
        });

        for (const [receiverId] of room.receivers) {
          send(ws, {
            type: "receiver-joined",
            receiverId
          });
        }

      } else {
        const receiverId = crypto.randomUUID();

        room.receivers.set(receiverId, ws);

        ws.roomInfo = {
          room: id,
          role: "receiver",
          id: receiverId
        };

        send(ws, {
          type: "joined",
          role: "receiver",
          room: id,
          receiverId
        });

        if (room.sender) {
          send(room.sender, {
            type: "receiver-joined",
            receiverId
          });

          send(ws, {
            type: "sender-ready"
          });
        }
      }

      broadcastRooms();
      return;
    }

    const info = ws.roomInfo;

    if (!info) return;

    const room = rooms.get(info.room);

    if (!room) return;

    if (data.type === "update-room") {
      if (
        info.role !== "sender" ||
        room.sender !== ws
      ) {
        return;
      }

      room.name = cleanName(data.name);
      room.memo = cleanMemo(data.memo);

      broadcastRooms();
      return;
    }

    if (
      data.type === "offer" &&
      info.role === "sender"
    ) {
      send(room.receivers.get(data.receiverId), {
        type: "offer",
        sdp: data.sdp,
        generation: data.generation
      });

      return;
    }

    if (
      data.type === "answer" &&
      info.role === "receiver"
    ) {
      send(room.sender, {
        type: "answer",
        receiverId: info.id,
        sdp: data.sdp,
        generation: data.generation
      });

      return;
    }

    if (data.type === "ice") {
      if (info.role === "sender") {
        send(room.receivers.get(data.receiverId), {
          type: "ice",
          candidate: data.candidate,
          generation: data.generation
        });

      } else {
        send(room.sender, {
          type: "ice",
          receiverId: info.id,
          candidate: data.candidate,
          generation: data.generation
        });
      }

      return;
    }

    if (
      data.type === "restart-request" &&
      info.role === "receiver"
    ) {
      send(room.sender, {
        type: "restart-request",
        receiverId: info.id,
        generation: data.generation
      });
    }
  });

  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});

/* ========================================
   WebSocket映像・音声専用
======================================== */

function videoRoomList() {
  const list = [];

  for (const [id, room] of videoRooms) {
    if (room.sender) {
      list.push({
        id,
        name: room.name,
        memo: room.memo
      });
    }
  }

  return list;
}

function broadcastVideoRooms() {
  const data = {
    type: "room-list",
    rooms: videoRoomList(),
    suggestedRoom: nextRoomID(videoRooms)
  };

  for (const client of videoWSS.clients) {
    send(client, data);
  }
}

function leaveVideo(ws) {
  const info = ws.videoRoomInfo;

  if (!info) return;

  ws.videoRoomInfo = null;

  const room = videoRooms.get(info.room);

  if (!room) return;

  if (
    info.role === "sender" &&
    room.sender === ws
  ) {
    /*
     * 受信者はルームに残して、
     * 次の配信開始を待てるようにする。
     */
    room.sender = null;
    room.audioInit = null;

    for (const receiver of room.receivers) {
      send(receiver, {
        type: "sender-left"
      });
    }

    if (room.receivers.size === 0) {
      videoRooms.delete(info.room);
    }

  } else if (info.role === "receiver") {
    room.receivers.delete(ws);

    if (
      !room.sender &&
      room.receivers.size === 0
    ) {
      videoRooms.delete(info.room);
    }
  }

  broadcastVideoRooms();
}

videoWSS.on("connection", ws => {
  send(ws, {
    type: "hello",
    version: "26.1"
  });

  send(ws, {
    type: "room-list",
    rooms: videoRoomList(),
    suggestedRoom: nextRoomID(videoRooms)
  });

  ws.on("message", (raw, isBinary) => {

    /* ====================================
       映像・音声中継
    ==================================== */

    if (isBinary) {
      const info = ws.videoRoomInfo;

      if (
        !info ||
        info.role !== "sender"
      ) {
        return;
      }

      const room = videoRooms.get(info.room);

      if (
        !room ||
        room.sender !== ws ||
        raw.length < 2
      ) {
        return;
      }

      const kind = raw[0];

      if (kind !== 1 && kind !== 2) {
        return;
      }

      const limit =
        kind === 1
          ? 1024 * 1024
          : 256 * 1024;

      if (raw.length > limit + 1) {
        return;
      }

      if (
        kind === 2 &&
        !room.audioInit
      ) {
        room.audioInit = Buffer.from(raw);
      }

      for (const receiver of room.receivers) {
        if (
          receiver.readyState !== WebSocket.OPEN
        ) {
          continue;
        }

        if (
          receiver.bufferedAmount >
          2 * 1024 * 1024
        ) {
          continue;
        }

        receiver.send(raw, {
          binary: true
        });
      }

      return;
    }

    /* ====================================
       JSONメッセージ
    ==================================== */

    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.type === "ping") {
      send(ws, {
        type: "pong",
        time: Date.now()
      });

      return;
    }

    if (data.type === "leave") {
      leaveVideo(ws);
      return;
    }

    if (data.type === "join") {
      const id = data.room;

      if (!validRoom(id)) {
        send(ws, {
          type: "error",
          message: "ルームIDが不正です"
        });

        return;
      }

      if (
        data.role !== "sender" &&
        data.role !== "receiver"
      ) {
        return;
      }

      if (
        data.role === "sender" &&
        videoRooms.get(id)?.sender &&
        videoRooms.get(id).sender !== ws
      ) {
        send(ws, {
          type: "error",
          message: "このルームでは既に配信中です"
        });

        return;
      }

      leaveVideo(ws);

      let room = videoRooms.get(id);

      if (!room) {
        room = {
          sender: null,
          receivers: new Set(),
          name: "ゲスト",
          memo: "",
          audioInit: null
        };

        videoRooms.set(id, room);
      }

      if (data.role === "sender") {
        room.sender = ws;
        room.name = cleanName(data.name);
        room.memo = cleanMemo(data.memo);
        room.audioInit = null;

        ws.videoRoomInfo = {
          room: id,
          role: "sender"
        };

        send(ws, {
          type: "joined",
          role: "sender",
          room: id
        });

        for (const receiver of room.receivers) {
          send(receiver, {
            type: "sender-ready"
          });
        }

      } else {
        room.receivers.add(ws);

        ws.videoRoomInfo = {
          room: id,
          role: "receiver"
        };

        send(ws, {
          type: "joined",
          role: "receiver",
          room: id
        });

        if (room.sender) {
          send(ws, {
            type: "sender-ready"
          });

          if (room.audioInit) {
            ws.send(room.audioInit, {
              binary: true
            });
          }
        }
      }

      broadcastVideoRooms();
      return;
    }

    const info = ws.videoRoomInfo;

    if (!info) return;

    const room = videoRooms.get(info.room);

    if (!room) return;

    if (
      data.type === "update-room" &&
      info.role === "sender" &&
      room.sender === ws
    ) {
      room.name = cleanName(data.name);
      room.memo = cleanMemo(data.memo);

      broadcastVideoRooms();
    }
  });

  ws.on("close", () => leaveVideo(ws));
  ws.on("error", () => leaveVideo(ws));
});

/* ========================================
   起動
======================================== */

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `WebRTC Caster v26.1 running on port ${PORT}`
  );
});
