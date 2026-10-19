import express from "express";
import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.sendFile("index.html", {
    root: process.cwd()
  });
});

const wss = new WebSocketServer({
  server,
  path: "/signal",
  maxPayload: 1024 * 1024
});

const rooms = new Map();

function send(ws, data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
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

function cleanup(ws) {
  if (!ws.roomId) return;

  const room = rooms.get(ws.roomId);

  if (!room) {
    ws.roomId = null;
    ws.role = null;
    return;
  }

  if (ws.role === "sender" && room.sender === ws) {
    room.sender = null;

    for (const receiver of room.receivers.values()) {
      send(receiver, {
        type: "sender-left"
      });
    }
  }

  if (ws.role === "receiver") {
    if (room.receivers.get(ws.clientId) === ws) {
      room.receivers.delete(ws.clientId);

      send(room.sender, {
        type: "receiver-left",
        receiverId: ws.clientId
      });
    }
  }

  if (!room.sender && room.receivers.size === 0) {
    rooms.delete(ws.roomId);
  }

  ws.roomId = null;
  ws.role = null;
}

wss.on("connection", ws => {
  ws.clientId = crypto.randomUUID();
  ws.roomId = null;
  ws.role = null;

  ws.on("message", raw => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.type === "join") {
      cleanup(ws);

      const roomId = String(data.roomId || "").trim();
      const role = data.role;

      if (
        !/^[A-Za-z0-9_-]{1,32}$/.test(roomId) ||
        !["sender", "receiver"].includes(role)
      ) {
        send(ws, {
          type: "error",
          message: "ルームIDまたは役割が無効です"
        });
        return;
      }

      const room = getRoom(roomId);

      if (role === "sender") {
        if (room.sender && room.sender !== ws) {
          send(ws, {
            type: "error",
            message: "このルームには既に送信者がいます"
          });
          return;
        }

        room.sender = ws;
        ws.roomId = roomId;
        ws.role = "sender";

        send(ws, {
          type: "joined",
          role: "sender"
        });

        for (const [id, receiver] of room.receivers) {
          send(ws, {
            type: "receiver-joined",
            receiverId: id
          });

          send(receiver, {
            type: "sender-ready"
          });
        }
      } else {
        room.receivers.set(ws.clientId, ws);

        ws.roomId = roomId;
        ws.role = "receiver";

        send(ws, {
          type: "joined",
          role: "receiver"
        });

        if (room.sender) {
          send(room.sender, {
            type: "receiver-joined",
            receiverId: ws.clientId
          });

          send(ws, {
            type: "sender-ready"
          });
        }
      }

      return;
    }

    if (data.type === "leave") {
      cleanup(ws);
      return;
    }

    if (!ws.roomId) return;

    const room = rooms.get(ws.roomId);
    if (!room) return;

    // 送信者 → 受信者
    if (
      ws.role === "sender" &&
      ["offer", "ice"].includes(data.type)
    ) {
      const receiver = room.receivers.get(data.receiverId);

      send(receiver, {
        type: data.type,
        sdp: data.sdp,
        candidate: data.candidate,
        generation: data.generation
      });

      return;
    }

    // 受信者 → 送信者
    if (
      ws.role === "receiver" &&
      ["answer", "ice", "restart-request"].includes(data.type)
    ) {
      send(room.sender, {
        type: data.type,
        receiverId: ws.clientId,
        sdp: data.sdp,
        candidate: data.candidate,
        generation: data.generation
      });

      return;
    }
  });

  ws.on("close", () => cleanup(ws));

  ws.on("error", err => {
    console.error("WebSocket:", err.message);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `WebRTC Caster v20 running on port ${PORT}`
  );
});
