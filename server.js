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

const wss = new WebSocketServer({
  server,
  path: "/signal",
  maxPayload: 2 * 1024 * 1024,
  perMessageDeflate: false
});

const rooms = new Map();

const MAX_FRAME_SIZE = 1024 * 1024;
const MAX_BUFFERED = 2 * 1024 * 1024;

function send(ws, data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function cleanRoom(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 100
  ) {
    return null;
  }

  return value;
}

function cleanName(value) {
  return typeof value === "string"
    ? value.trim().slice(0, 80) || "ゲスト"
    : "ゲスト";
}

function cleanMemo(value) {
  return typeof value === "string"
    ? value.trim().slice(0, 300)
    : "";
}

function roman(number) {
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
    while (number >= value) {
      result += symbol;
      number -= value;
    }
  }

  return result;
}

function nextRoom() {
  for (let i = 1; i <= 3999; i++) {
    const id = roman(i);

    if (!rooms.get(id)?.sender) {
      return id;
    }
  }

  return crypto.randomUUID().slice(0, 8);
}

function roomList() {
  return [...rooms.entries()]
    .filter(([, room]) => room.sender)
    .map(([id, room]) => ({
      id,
      name: room.name,
      memo: room.memo,
      mode: room.mode
    }));
}

function broadcastRooms() {
  const message = {
    type: "room-list",
    rooms: roomList(),
    suggestedRoom: nextRoom()
  };

  for (const ws of wss.clients) {
    send(ws, message);
  }
}

function leave(ws) {
  const info = ws.info;

  if (!info) return;

  ws.info = null;

  const room = rooms.get(info.room);

  if (!room) return;

  if (info.role === "sender" && room.sender === ws) {
    room.sender = null;

    for (const receiver of room.receivers.values()) {
      send(receiver, {
        type: "sender-left"
      });
    }

    room.receivers.clear();
    rooms.delete(info.room);
  }

  if (info.role === "receiver") {
    room.receivers.delete(info.id);

    send(room.sender, {
      type: "receiver-left",
      receiverId: info.id
    });

    if (!room.sender && !room.receivers.size) {
      rooms.delete(info.room);
    }
  }

  broadcastRooms();
}

wss.on("connection", ws => {
  ws.info = null;

  send(ws, {
    type: "room-list",
    rooms: roomList(),
    suggestedRoom: nextRoom()
  });

  ws.on("message", (raw, isBinary) => {

    /*
     * WebSocket映像転送
     *
     * バイナリデータはJPEG画像として扱う。
     * 配信者以外からの映像データは転送しない。
     */
    if (isBinary) {
      const info = ws.info;

      if (!info || info.role !== "sender") return;

      const room = rooms.get(info.room);

      if (
        !room ||
        room.sender !== ws ||
        room.mode !== "websocket"
      ) {
        return;
      }

      if (
        raw.length === 0 ||
        raw.length > MAX_FRAME_SIZE
      ) {
        return;
      }

      for (const receiver of room.receivers.values()) {
        if (
          receiver.readyState !== WebSocket.OPEN ||
          receiver.bufferedAmount > MAX_BUFFERED
        ) {
          continue;
        }

        receiver.send(raw, {
          binary: true
        });
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
      leave(ws);
      return;
    }

    if (data.type === "join") {
      const id = cleanRoom(data.room);

      if (!id) {
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

      const existing = rooms.get(id);

      // 参加失敗で現在のルームを失わないよう先に確認
      if (
        data.role === "sender" &&
        existing?.sender &&
        existing.sender !== ws
      ) {
        send(ws, {
          type: "error",
          message: "このルームは配信中です"
        });
        return;
      }

      leave(ws);

      let room = rooms.get(id);

      if (!room) {
        room = {
          sender: null,
          receivers: new Map(),
          name: "ゲスト",
          memo: "",
          mode: "webrtc"
        };

        rooms.set(id, room);
      }

      if (data.role === "sender") {
        room.sender = ws;
        room.name = cleanName(data.name);
        room.memo = cleanMemo(data.memo);

        room.mode =
          data.mode === "websocket"
            ? "websocket"
            : "webrtc";

        ws.info = {
          room: id,
          role: "sender"
        };

        send(ws, {
          type: "joined",
          room: id,
          role: "sender"
        });

      } else {
        const receiverId = crypto.randomUUID();

        room.receivers.set(receiverId, ws);

        ws.info = {
          room: id,
          role: "receiver",
          id: receiverId
        };

        send(ws, {
          type: "joined",
          room: id,
          role: "receiver",
          receiverId,
          mode: room.mode
        });

        if (room.sender && room.mode === "webrtc") {
          send(room.sender, {
            type: "receiver-joined",
            receiverId
          });
        }
      }

      broadcastRooms();
      return;
    }

    const info = ws.info;

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

    if (room.mode !== "webrtc") return;

    if (
      data.type === "offer" &&
      info.role === "sender" &&
      room.sender === ws
    ) {
      send(room.receivers.get(data.receiverId), {
        type: "offer",
        sdp: data.sdp,
        generation: data.generation
      });
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
    }

    if (data.type === "ice") {
      if (info.role === "sender" && room.sender === ws) {
        send(room.receivers.get(data.receiverId), {
          type: "ice",
          candidate: data.candidate,
          generation: data.generation
        });
      } else if (info.role === "receiver") {
        send(room.sender, {
          type: "ice",
          receiverId: info.id,
          candidate: data.candidate,
          generation: data.generation
        });
      }
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

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`WebRTC Caster v23 listening on ${PORT}`);
});
