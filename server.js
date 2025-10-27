import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import bodyParser from "body-parser";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let gsiState = {
  players: {},
  currentFocus: null,
};

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Set();
const socketMeta = new Map();
const socketById = new Map();
const publishers = new Map();
let nextSocketId = 1;

const PORT = process.env.PORT || 3000;

function sendJson(target, payload) {
  if (!target || target.readyState !== WebSocket.OPEN) {
    return;
  }
  target.send(JSON.stringify(payload));
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function broadcastState() {
  broadcast({
    type: "STATE_UPDATE",
    currentFocus: gsiState.currentFocus,
  });
}

function dropViewerEntry(nickname, viewerSocketId, connectionId) {
  if (!nickname) {
    return;
  }

  const entry = publishers.get(nickname);
  if (!entry) {
    return;
  }

  const viewerSet = entry.viewers.get(viewerSocketId);
  if (!viewerSet) {
    return;
  }

  viewerSet.delete(connectionId);
  if (viewerSet.size === 0) {
    entry.viewers.delete(viewerSocketId);
  }
}

function detachPublisher(nickname, socket) {
  if (!nickname) {
    return;
  }

  const entry = publishers.get(nickname);
  if (!entry) {
    return;
  }

  if (socket && entry.socket !== socket) {
    return;
  }

  publishers.delete(nickname);

  for (const [viewerSocketId, connectionIds] of entry.viewers.entries()) {
    const viewerSocket = socketById.get(viewerSocketId);
    if (!viewerSocket) {
      continue;
    }

    for (const connectionId of connectionIds) {
      sendJson(viewerSocket, {
        type: "STREAM_ENDED",
        nickname,
        connectionId,
      });

      const viewerMeta = socketMeta.get(viewerSocket);
      if (viewerMeta) {
        viewerMeta.subscriptions.delete(connectionId);
      }
    }
  }

  if (gsiState.currentFocus === nickname) {
    gsiState.currentFocus = null;
    broadcastState();
  }
}

function stopViewerSubscription(meta, nickname, connectionId, notifyPublisher = true) {
  if (!meta || !connectionId) {
    return;
  }

  if (meta.subscriptions.has(connectionId)) {
    meta.subscriptions.delete(connectionId);
  }

  dropViewerEntry(nickname, meta.id, connectionId);

  if (!notifyPublisher) {
    return;
  }

  const entry = publishers.get(nickname);
  if (!entry) {
    return;
  }

  sendJson(entry.socket, {
    type: "VIEWER_DISCONNECTED",
    viewerSocketId: meta.id,
    connectionId,
    nickname,
  });
}

app.post("/api/gsi", (req, res) => {
  const data = req.body || {};

  if (data.allplayers && typeof data.allplayers === "object") {
    const updatedPlayers = {};

    for (const [steamId, player] of Object.entries(data.allplayers)) {
      if (!player) {
        continue;
      }

      updatedPlayers[steamId] = {
        name: player.name ?? "",
        team: player.team ?? "",
        health: player.state?.health ?? 0,
        observer_slot: player.observer_slot ?? null,
      };
    }

    gsiState.players = updatedPlayers;
  }

  if (data.player && data.player.name) {
    gsiState.currentFocus = data.player.name;
  }

  broadcastState();
  res.json({ ok: true });
});

app.get("/players", (req, res) => {
  const names = new Set();

  for (const player of Object.values(gsiState.players)) {
    if (player?.name) {
      names.add(player.name);
    }
  }

  res.json({ players: [...names].sort() });
});

app.get("/current-focus", (req, res) => {
  res.json({ currentFocus: gsiState.currentFocus });
});

app.get("/teams", (req, res) => {
  const teams = {};

  const players = Object.values(gsiState.players).filter((player) => player?.name);
  players.sort((a, b) => {
    const slotA = a?.observer_slot ?? 99;
    const slotB = b?.observer_slot ?? 99;
    if (slotA !== slotB) {
      return slotA - slotB;
    }
    return a.name.localeCompare(b.name);
  });

  for (const player of players) {
    const teamKey = (player.team || "unknown").toUpperCase();
    if (!teams[teamKey]) {
      teams[teamKey] = [];
    }
    teams[teamKey].push(player.name);
  }

  res.json({ teams });
});

app.get("/camera/:nickname", (_req, res) => {
  res.status(410).json({ error: "camera snapshots are not available in the WebRTC build" });
});

app.post("/admin/focus", (req, res) => {
  const nickname = req.body?.nickname;

  if (!nickname || typeof nickname !== "string") {
    res.status(400).json({ error: "nickname is required" });
    return;
  }

  gsiState.currentFocus = nickname;
  broadcastState();
  res.json({ ok: true, currentFocus: gsiState.currentFocus });
});

function handleHello(socket, meta, payload) {
  const role = typeof payload.role === "string" ? payload.role.trim().toLowerCase() : "";

  if (role === "publisher") {
    const nickname = typeof payload.nickname === "string" ? payload.nickname.trim() : "";
    if (!nickname) {
      sendJson(socket, { type: "ERROR", message: "nickname is required for publisher" });
      return;
    }

    if (meta.nickname && meta.nickname !== nickname) {
      detachPublisher(meta.nickname, socket);
    }

    const existing = publishers.get(nickname);
    if (existing && existing.socket !== socket) {
      detachPublisher(nickname, existing.socket);
    }

    let entry = publishers.get(nickname);
    if (!entry || entry.socket !== socket) {
      entry = { socket, viewers: new Map() };
      publishers.set(nickname, entry);
    }

    meta.role = "publisher";
    meta.nickname = nickname;
    sendJson(socket, { type: "PUBLISHER_REGISTERED", nickname });
    return;
  }

  if (role === "viewer" || role === "admin") {
    meta.role = role;
    sendJson(socket, { type: "VIEWER_REGISTERED", role });
    return;
  }

  sendJson(socket, { type: "ERROR", message: "unknown role" });
}

function handleViewerOffer(socket, meta, payload) {
  const connectionId = payload.connectionId;
  const nickname = typeof payload.nickname === "string" ? payload.nickname.trim() : "";

  if (!connectionId || !nickname) {
    return;
  }

  const entry = publishers.get(nickname);
  if (!entry) {
    sendJson(socket, {
      type: "STREAM_UNAVAILABLE",
      nickname,
      connectionId,
    });
    return;
  }

  meta.role = meta.role || "viewer";
  if (!meta.subscriptions.has(connectionId)) {
    meta.subscriptions.set(connectionId, nickname);
  }

  let viewerSet = entry.viewers.get(meta.id);
  if (!viewerSet) {
    viewerSet = new Set();
    entry.viewers.set(meta.id, viewerSet);
  }
  viewerSet.add(connectionId);

  sendJson(entry.socket, {
    type: "SIGNAL_VIEWER_OFFER",
    viewerSocketId: meta.id,
    connectionId,
    nickname,
    sdp: payload.sdp,
  });
}

function handleViewerIce(meta, payload) {
  const nickname = typeof payload.nickname === "string" ? payload.nickname.trim() : "";
  const connectionId = payload.connectionId;

  if (!nickname || !connectionId) {
    return;
  }

  const entry = publishers.get(nickname);
  if (!entry) {
    return;
  }

  sendJson(entry.socket, {
    type: "SIGNAL_VIEWER_CANDIDATE",
    viewerSocketId: meta.id,
    connectionId,
    nickname,
    candidate: payload.candidate,
  });
}

function handleViewerStop(socket, meta, payload) {
  const connectionId = payload.connectionId;
  const nickname = typeof payload.nickname === "string" ? payload.nickname.trim() : "";
  if (!connectionId || !nickname) {
    return;
  }
  stopViewerSubscription(meta, nickname, connectionId, true);
}

function handlePublisherAnswer(socket, meta, payload) {
  const viewerSocketId = payload.viewerSocketId;
  const connectionId = payload.connectionId;

  if (!viewerSocketId || !connectionId) {
    return;
  }

  const viewerSocket = socketById.get(viewerSocketId);
  if (!viewerSocket) {
    return;
  }

  sendJson(viewerSocket, {
    type: "SIGNAL_PUBLISHER_ANSWER",
    nickname: meta.nickname,
    connectionId,
    sdp: payload.sdp,
  });
}

function handlePublisherIce(socket, meta, payload) {
  const viewerSocketId = payload.viewerSocketId;
  const connectionId = payload.connectionId;

  if (!viewerSocketId || !connectionId) {
    return;
  }

  const viewerSocket = socketById.get(viewerSocketId);
  if (!viewerSocket) {
    return;
  }

  sendJson(viewerSocket, {
    type: "SIGNAL_PUBLISHER_CANDIDATE",
    nickname: meta.nickname,
    connectionId,
    candidate: payload.candidate,
  });
}

function handlePublisherPeerClosed(meta, payload) {
  const viewerSocketId = payload.viewerSocketId;
  const connectionId = payload.connectionId;
  if (!viewerSocketId || !connectionId) {
    return;
  }

  dropViewerEntry(meta.nickname, viewerSocketId, connectionId);

  const viewerSocket = socketById.get(viewerSocketId);
  if (viewerSocket) {
    sendJson(viewerSocket, {
      type: "STREAM_ENDED",
      nickname: meta.nickname,
      connectionId,
    });

    const viewerMeta = socketMeta.get(viewerSocket);
    if (viewerMeta) {
      viewerMeta.subscriptions.delete(connectionId);
    }
  }
}

wss.on("connection", (socket) => {
  clients.add(socket);

  const socketId = `ws-${nextSocketId++}`;
  const meta = {
    id: socketId,
    role: null,
    nickname: null,
    subscriptions: new Map(),
  };

  socketMeta.set(socket, meta);
  socketById.set(socketId, socket);

  sendJson(socket, {
    type: "WELCOME",
    socketId,
    currentFocus: gsiState.currentFocus,
  });

  socket.on("message", (rawMessage) => {
    let payload;

    try {
      payload = JSON.parse(rawMessage.toString());
    } catch (error) {
      return;
    }

    switch (payload?.type) {
      case "HELLO":
        handleHello(socket, meta, payload);
        break;
      case "VIEWER_OFFER":
        handleViewerOffer(socket, meta, payload);
        break;
      case "VIEWER_ICE":
        handleViewerIce(meta, payload);
        break;
      case "VIEWER_STOP":
        handleViewerStop(socket, meta, payload);
        break;
      case "PUBLISHER_ANSWER":
        if (meta.role === "publisher") {
          handlePublisherAnswer(socket, meta, payload);
        }
        break;
      case "PUBLISHER_ICE":
        if (meta.role === "publisher") {
          handlePublisherIce(socket, meta, payload);
        }
        break;
      case "PUBLISHER_PEER_CLOSED":
        if (meta.role === "publisher") {
          handlePublisherPeerClosed(meta, payload);
        }
        break;
      default:
        break;
    }
  });

  socket.on("close", () => {
    clients.delete(socket);

    const metaInfo = socketMeta.get(socket);
    if (!metaInfo) {
      socketById.delete(socketId);
      return;
    }

    if (metaInfo.role === "publisher" && metaInfo.nickname) {
      detachPublisher(metaInfo.nickname, socket);
    }

    if (metaInfo.role === "viewer") {
      const entries = Array.from(metaInfo.subscriptions.entries());
      for (const [connectionId, nickname] of entries) {
        stopViewerSubscription(metaInfo, nickname, connectionId, true);
      }
    }

    socketMeta.delete(socket);
    socketById.delete(socketId);
  });

  socket.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other service or set PORT to a free port.`);
    process.exit(1);
  }
  console.error("HTTP server error:", error);
});

wss.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    return;
  }
  console.error("WebSocket server error:", error);
});

server.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
