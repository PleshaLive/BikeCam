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

let cameras = {};

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Set();
const PORT = process.env.PORT || 3000;

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

function broadcastState() {
  const payload = JSON.stringify({
    type: "STATE_UPDATE",
    currentFocus: gsiState.currentFocus,
  });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function broadcastFocusFrame(nickname) {
  if (!nickname) {
    return;
  }

  const camera = cameras[nickname];
  if (!camera) {
    return;
  }

  const payload = JSON.stringify({
    type: "FOCUS_FRAME",
    nickname,
    frame: camera.lastFrameBase64,
    updatedAt: camera.updatedAt,
  });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }

  broadcastCameraFrame(nickname);
}

function findPlayerByNickname(nickname) {
  if (!nickname) {
    return null;
  }

  for (const player of Object.values(gsiState.players)) {
    if (player?.name === nickname) {
      return player;
    }
  }

  return null;
}

function getTeamForNickname(nickname) {
  const player = findPlayerByNickname(nickname);
  if (!player?.team) {
    return null;
  }
  return player.team.toUpperCase();
}

function broadcastCameraFrame(nickname) {
  const camera = cameras[nickname];
  if (!camera) {
    return;
  }

  const payload = JSON.stringify({
    type: "PLAYER_FRAME",
    nickname,
    frame: camera.lastFrameBase64,
    updatedAt: camera.updatedAt,
    team: getTeamForNickname(nickname),
  });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
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
  broadcastFocusFrame(gsiState.currentFocus);
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

app.get("/camera/:nickname", (req, res) => {
  const nickname = req.params.nickname;
  const camera = cameras[nickname];

  if (!camera) {
    res.status(404).json({ error: "no camera for this player" });
    return;
  }

  res.json({ nickname, frame: camera.lastFrameBase64, updatedAt: camera.updatedAt });
});

app.post("/admin/focus", (req, res) => {
  const nickname = req.body?.nickname;

  if (!nickname || typeof nickname !== "string") {
    res.status(400).json({ error: "nickname is required" });
    return;
  }

  gsiState.currentFocus = nickname;
  broadcastState();
  broadcastFocusFrame(gsiState.currentFocus);
  res.json({ ok: true, currentFocus: gsiState.currentFocus });
});

wss.on("connection", (socket) => {
  clients.add(socket);

  const cameraSnapshots = Object.entries(cameras).map(([nickname, camera]) => ({
    nickname,
    frame: camera.lastFrameBase64,
    updatedAt: camera.updatedAt,
    team: getTeamForNickname(nickname),
  }));

  socket.send(
    JSON.stringify({
      type: "WELCOME",
      currentFocus: gsiState.currentFocus,
      cameras: cameraSnapshots,
    })
  );

  if (gsiState.currentFocus) {
    const camera = cameras[gsiState.currentFocus];
    if (camera && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "FOCUS_FRAME",
          nickname: gsiState.currentFocus,
          frame: camera.lastFrameBase64,
          updatedAt: camera.updatedAt,
        })
      );
    }
  }

  socket.on("message", (rawMessage) => {
    let message;

    try {
      message = JSON.parse(rawMessage.toString());
    } catch (error) {
      return;
    }

    if (message?.type === "CAM_FRAME") {
      const nickname = message.nickname;
      const frame = message.frame;

      if (typeof nickname === "string" && typeof frame === "string" && nickname.trim()) {
        cameras[nickname] = {
          lastFrameBase64: frame,
          updatedAt: Date.now(),
        };

        if (gsiState.currentFocus === nickname) {
          broadcastFocusFrame(nickname);
        } else {
          broadcastCameraFrame(nickname);
        }
      }
    }

    if (message?.type === "SET_FOCUS") {
      const nickname = message.nickname;

      if (typeof nickname === "string" && nickname.trim()) {
        gsiState.currentFocus = nickname;
        broadcastState();
        broadcastFocusFrame(gsiState.currentFocus);
      }
    }
  });

  socket.on("close", () => {
    clients.delete(socket);
  });

  socket.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
