import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 10000);

const rooms = new Map();

const wss = new WebSocketServer({
  server,
  path: "/signal",
  maxPayload: 256 * 1024
});

function validRoom(id) {
  return typeof id === "string" &&
    /^[A-Za-z0-9_-]{1,32}$/.test(id);
}

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      sender: null,
      receivers: new Map()
    });
  }

  return rooms.get(id);
}

function send(ws, data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function cleanup(ws) {
  if (!ws.roomId) return;

  const room = rooms.get(ws.roomId);
  if (!room) return;

  if (ws.role === "sender" && room.sender === ws) {
    room.sender = null;

    for (const receiver of room.receivers.values()) {
      send(receiver, { type: "sender-left" });
    }
  }

  if (ws.role === "receiver" && ws.receiverId) {
    if (room.receivers.get(ws.receiverId) === ws) {
      room.receivers.delete(ws.receiverId);

      send(room.sender, {
        type: "receiver-left",
        receiverId: ws.receiverId
      });
    }
  }

  if (!room.sender && room.receivers.size === 0) {
    rooms.delete(ws.roomId);
  }

  ws.roomId = null;
  ws.role = null;
  ws.receiverId = null;
}

wss.on("connection", ws => {
  ws.roomId = null;
  ws.role = null;
  ws.receiverId = null;
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());

      if (
        msg.type === "sender-join" ||
        msg.type === "receiver-join"
      ) {
        const roomId = String(msg.room || "");

        if (!validRoom(roomId)) {
          send(ws, {
            type: "error",
            message: "ルームIDが不正です"
          });
          return;
        }

        if (ws.roomId) {
          send(ws, {
            type: "error",
            message: "既にルームに参加しています"
          });
          return;
        }

        const room = getRoom(roomId);

        if (msg.type === "sender-join") {
          if (room.sender && room.sender !== ws) {
            send(ws, {
              type: "error",
              message: "既に送信者がいます"
            });
            return;
          }

          ws.roomId = roomId;
          ws.role = "sender";
          room.sender = ws;

          send(ws, { type: "sender-ready" });

          for (const receiverId of room.receivers.keys()) {
            send(ws, {
              type: "receiver-joined",
              receiverId
            });
          }
        } else {
          ws.roomId = roomId;
          ws.role = "receiver";
          ws.receiverId = crypto.randomUUID();

          room.receivers.set(ws.receiverId, ws);

          send(ws, {
            type: "receiver-ready",
            senderOnline: Boolean(room.sender)
          });

          send(room.sender, {
            type: "receiver-joined",
            receiverId: ws.receiverId
          });
        }

        return;
      }

      if (!ws.roomId) return;

      const room = rooms.get(ws.roomId);
      if (!room) return;

      if (msg.type === "offer" && ws.role === "sender") {
        if (room.sender !== ws) return;

        send(room.receivers.get(msg.receiverId), {
          type: "offer",
          sdp: msg.sdp
        });
        return;
      }

      if (msg.type === "answer" && ws.role === "receiver") {
        send(room.sender, {
          type: "answer",
          receiverId: ws.receiverId,
          sdp: msg.sdp
        });
        return;
      }

      if (msg.type === "ice") {
        if (ws.role === "sender" && room.sender === ws) {
          send(room.receivers.get(msg.receiverId), {
            type: "ice",
            candidate: msg.candidate
          });
        } else if (
          ws.role === "receiver" &&
          room.receivers.get(ws.receiverId) === ws
        ) {
          send(room.sender, {
            type: "ice",
            receiverId: ws.receiverId,
            candidate: msg.candidate
          });
        }
      }

    } catch (error) {
      console.error("Signal error:", error);
    }
  });

  ws.on("close", () => cleanup(ws));
  ws.on("error", console.error);
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

app.get("/", (req, res) => {
  res.sendFile("index.html", {
    root: process.cwd()
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "8.0",
    rooms: rooms.size,
    clients: wss.clients.size
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`WebRTC Caster v8 on port ${PORT}`);
});
