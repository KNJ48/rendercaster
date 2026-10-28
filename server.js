import express from "express";
import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "url";
import path from "path";

const app = express();
const server = http.createServer(app);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ========================================
   HTML / JavaScript
======================================== */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/websocket.html", (req, res) => {
  res.sendFile(path.join(__dirname, "websocket.html"));
});

app.get("/websocket.js", (req, res) => {
  res.sendFile(path.join(__dirname, "websocket.js"));
});

/* ========================================
   WebSocketサーバー
======================================== */

/*
 * WebRTCシグナリング専用
 */
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 1024 * 1024
});

/*
 * WebSocket映像配信専用
 */
const videoWSS = new WebSocketServer({
  noServer: true,
  maxPayload: 2 * 1024 * 1024,
  perMessageDeflate: false
});

/*
 * v25.1
 *
 * HTTP Upgradeを明示的に振り分ける。
 *
 * 複数のWebSocketServerが同じUpgradeを
 * 処理しないようにする。
 */
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

  if (pathname === "/signal") {
    wss.handleUpgrade(
      request,
      socket,
      head,
      ws => {
        wss.emit("connection", ws, request);
      }
    );

    return;
  }

  if (pathname === "/video") {
    videoWSS.handleUpgrade(
      request,
      socket,
      head,
      ws => {
        videoWSS.emit("connection", ws, request);
      }
    );

    return;
  }

  socket.destroy();
});

/* ========================================
   ルーム管理
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
  if (typeof value !== "string") return "ゲスト";
  return value.trim().slice(0, 80) || "ゲスト";
}

function cleanMemo(value) {
  if (typeof value !== "string") return "";
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
   WebRTCルーム一覧
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

/* ========================================
   WebRTC退出
======================================== */

function leave(ws) {
  const info = ws.roomInfo;
  if (!info) return;

  ws.roomInfo = null;

  const room = rooms.get(info.room);
  if (!room) return;

  if (info.role === "sender" && room.sender === ws) {
    room.sender = null;

    for (const receiver of room.receivers.values()) {
      send(receiver, { type: "sender-left" });
    }

    room.receivers.clear();
    rooms.delete(info.room);

  } else if (info.role === "receiver") {
    room.receivers.delete(info.id);

    send(room.sender, {
      type: "receiver-left",
      receiverId: info.id
    });

    if (!room.sender && room.receivers.size === 0) {
      rooms.delete(info.room);
    }
  }

  broadcastRooms();
}

/* ========================================
   WebRTCシグナリング（v22.2）
======================================== */

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

      if (data.role !== "sender" && data.role !== "receiver") {
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
        if (room.sender && room.sender !== ws) {
          send(ws, {
            type: "error",
            message: "このルームでは既に配信中です"
          });

          if (!room.sender && room.receivers.size === 0) {
            rooms.delete(id);
          }

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
      if (info.role !== "sender" || room.sender !== ws) return;

      room.name = cleanName(data.name);
      room.memo = cleanMemo(data.memo);

      broadcastRooms();
      return;
    }

    if (data.type === "offer" && info.role === "sender") {
      send(room.receivers.get(data.receiverId), {
        type: "offer",
        sdp: data.sdp,
        generation: data.generation
      });
      return;
    }

    if (data.type === "answer" && info.role === "receiver") {
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

    if (data.type === "restart-request" && info.role === "receiver") {
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
   WebSocket映像ルーム一覧
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

/* ========================================
   WebSocket映像ルーム退出
======================================== */

function leaveVideo(ws) {
  const info = ws.videoRoomInfo;
  if (!info) return;

  ws.videoRoomInfo = null;

  const room = videoRooms.get(info.room);
  if (!room) return;

  if (info.role === "sender" && room.sender === ws) {
    for (const receiver of room.receivers) {
      send(receiver, {
        type: "sender-left"
      });
    }

    videoRooms.delete(info.room);

  } else if (info.role === "receiver") {
    room.receivers.delete(ws);

    if (!room.sender && room.receivers.size === 0) {
      videoRooms.delete(info.room);
    }
  }

  broadcastVideoRooms();
}

/* ========================================
   WebSocket映像配信
======================================== */

videoWSS.on("connection", ws => {
  send(ws, {
    type: "room-list",
    rooms: videoRoomList(),
    suggestedRoom: nextRoomID(videoRooms)
  });

  ws.on("message", (raw, isBinary) => {

    /*
     * JPEG画像を受信者へ中継
     */
    if (isBinary) {
      const info = ws.videoRoomInfo;

      if (!info || info.role !== "sender") return;

      const room = videoRooms.get(info.room);

      if (!room || room.sender !== ws) return;

      if (
        raw.length === 0 ||
        raw.length > 1024 * 1024
      ) {
        return;
      }

      for (const receiver of room.receivers) {
        if (
          receiver.readyState === WebSocket.OPEN &&
          receiver.bufferedAmount < 2 * 1024 * 1024
        ) {
          receiver.send(raw, {
            binary: true
          });
        }
      }

      return;
    }

    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
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

      /*
       * 重複配信の拒否
       */
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
          memo: ""
        };

        videoRooms.set(id, room);
      }

      if (data.role === "sender") {
        room.sender = ws;
        room.name = cleanName(data.name);
        room.memo = cleanMemo(data.memo);

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
    `WebRTC Caster v25.1 running on port ${PORT}`
  );
});
