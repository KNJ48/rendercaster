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

const MAX_FRAME_SIZE = 1024 * 1024;

const wss = new WebSocketServer({
  server,
  path: "/signal",
  maxPayload: 2 * 1024 * 1024,
  perMessageDeflate: false
});

const rooms = new Map();

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

function nextRoomID() {
  for (let i = 1; i <= 3999; i++) {
    const id = roman(i);

    if (!rooms.has(id)) {
      return id;
    }
  }

  return crypto.randomUUID().slice(0, 8);
}

function activeRooms() {
  const list = [];

  for (const [id, room] of rooms) {
    if (room.sender) {
      list.push({
        id,
        name: room.name,
        memo: room.memo,
        mode: room.mode
      });
    }
  }

  return list;
}

function broadcastRooms() {
  const data = {
    type: "room-list",
    rooms: activeRooms(),
    suggestedRoom: nextRoomID()
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

  if (info.role === "sender" && room.sender === ws) {
    room.sender = null;

    for (const receiver of room.receivers.values()) {
      send(receiver, { type: "sender-left" });
    }

    room.receivers.clear();
    rooms.delete(info.room);

  } else if (info.role === "receiver") {
    if (room.receivers.get(info.id) === ws) {
      room.receivers.delete(info.id);

      send(room.sender, {
        type: "receiver-left",
        receiverId: info.id
      });
    }

    if (!room.sender && room.receivers.size === 0) {
      rooms.delete(info.room);
    }
  }

  broadcastRooms();
}

wss.on("connection", ws => {

  send(ws, {
    type: "room-list",
    rooms: activeRooms(),
    suggestedRoom: nextRoomID()
  });

  ws.on("message", (raw, isBinary) => {

    /*
     * WebSocket映像転送
     *
     * JPEG画像をバイナリで受信し、
     * 同じルームの受信者へ転送する。
     */
    if (isBinary) {
      const info = ws.roomInfo;

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

      /*
       * 重複ルームへの配信は拒否する。
       * 既存の参加状態は変更しない。
       */
      if (
        data.role === "sender" &&
        rooms.get(id)?.sender &&
        rooms.get(id).sender !== ws
      ) {
        send(ws, {
          type: "error",
          message: "このルームでは既に配信中です"
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

        ws.roomInfo = {
          room: id,
          role: "sender"
        };

        send(ws, {
          type: "joined",
          role: "sender",
          room: id,
          mode: room.mode
        });

        for (const [receiverId, receiver] of room.receivers) {
          send(receiver, {
            type: "sender-ready",
            mode: room.mode
          });

          if (room.mode === "webrtc") {
            send(ws, {
              type: "receiver-joined",
              receiverId
            });
          }
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
          receiverId,
          mode: room.sender ? room.mode : null
        });

        if (room.sender) {
          if (room.mode === "webrtc") {
            send(room.sender, {
              type: "receiver-joined",
              receiverId
            });
          }

          send(ws, {
            type: "sender-ready",
            mode: room.mode
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

    /*
     * 以下はv22.2のWebRTCシグナリング。
     */
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
      if (
        info.role === "sender" &&
        room.sender === ws
      ) {
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

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`WebRTC Caster v24 running on port ${PORT}`);
});
