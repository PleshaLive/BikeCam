import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import bodyParser from "body-parser";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import dotenv from "dotenv";
import basicAuth from "express-basic-auth";
import path from "path";
import fs from "fs";
import { promises as fsPromises } from "fs";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OWNER_IP = process.env.OWNER_IP || "127.0.0.1";
const ADMIN_DATA_DIR = path.join(__dirname, "data");
const ADMIN_CONFIG_PATH = path.join(ADMIN_DATA_DIR, "admin-config.json");
const IPV4_REGEX = /^(25[0-5]|2[0-4]\d|[01]?\d\d?)(\.(25[0-5]|2[0-4]\d|[01]?\d\d?)){3}$/;
const STEAM_UNIVERSE_SHIFT = 56n;
const STEAM_TYPE_SHIFT = 52n;
const STEAM_INSTANCE_SHIFT = 32n;
const STEAM_TYPE_INDIVIDUAL = 1n;
const STEAM_INSTANCE_DESKTOP = 1n;

function buildSteam64(universe, type, instance, accountId) {
  return ((universe << STEAM_UNIVERSE_SHIFT) | (type << STEAM_TYPE_SHIFT) | (instance << STEAM_INSTANCE_SHIFT) | accountId).toString();
}

function steamLegacyTo64(value) {
  const match = /^STEAM_([0-5]):([0-1]):(\d+)$/.exec(value);
  if (!match) {
    return null;
  }

  const universe = BigInt(Number(match[1]));
  const yBit = BigInt(Number(match[2]));
  const legacyId = BigInt(match[3]);
  const accountId = legacyId * 2n + yBit;
  return buildSteam64(universe, STEAM_TYPE_INDIVIDUAL, STEAM_INSTANCE_DESKTOP, accountId);
}

function steam3To64(value) {
  const match = /^\[([A-Z]):([0-5]):(\d+)(?::(\d+))?]$/.exec(value);
  if (!match) {
    return null;
  }

  const typeChar = match[1];
  if (typeChar !== "U") {
    return null;
  }

  const universe = BigInt(Number(match[2]));
  const accountId = BigInt(match[3]);
  const instance = match[4] ? BigInt(Number(match[4])) : STEAM_INSTANCE_DESKTOP;
  return buildSteam64(universe, STEAM_TYPE_INDIVIDUAL, instance, accountId);
}

function normalizeSteamId(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d{5,}$/.test(trimmed)) {
    return trimmed;
  }

  const legacy = steamLegacyTo64(trimmed);
  if (legacy) {
    return legacy;
  }

  const steam3 = steam3To64(trimmed);
  if (steam3) {
    return steam3;
  }

  return null;
}

function parseSpectatorTarget(raw) {
  const result = {
    steamId: null,
    name: null,
    nameLower: null,
    slot: null,
  };

  if (raw === null || raw === undefined) {
    return result;
  }

  if (typeof raw === "number") {
    if (Number.isFinite(raw) && raw > 0) {
      if (raw > 999999) {
        result.steamId = Number.isSafeInteger(raw) ? String(raw) : String(Math.trunc(raw));
      } else {
        result.slot = Math.trunc(raw);
      }
    }
    return result;
  }

  if (typeof raw !== "string") {
    return result;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return result;
  }

  const normalizedSteam = normalizeSteamId(trimmed);
  if (normalizedSteam) {
    result.steamId = normalizedSteam;
    return result;
  }

  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      if (numeric > 999999) {
        result.steamId = trimmed;
      } else {
        result.slot = numeric;
      }
    }
    return result;
  }

  result.name = trimmed;
  result.nameLower = trimmed.toLowerCase();
  return result;
}

let adminConfig = { allowedIps: [] };

function normalizeIp(ip) {
  if (!ip) {
    return "";
  }
  if (ip.startsWith("::ffff:")) {
    return ip.slice(7);
  }
  if (ip === "::1") {
    return "127.0.0.1";
  }
  return ip;
}

function isValidIp(ip) {
  return IPV4_REGEX.test(ip);
}

function ensureOwnerIp(config) {
  if (!Array.isArray(config.allowedIps)) {
    config.allowedIps = [];
  }

  const exists = config.allowedIps.some(
    (entry) => normalizeIp(entry?.ip || entry) === OWNER_IP
  );
  if (!exists) {
    config.allowedIps.push({
      ip: OWNER_IP,
      label: "Primary owner",
      addedAt: new Date().toISOString(),
      addedBy: OWNER_IP,
    });
  }
}

function loadAdminConfig() {
  try {
    fs.mkdirSync(ADMIN_DATA_DIR, { recursive: true });
  } catch (error) {
    console.warn("Failed to prepare admin data directory", error);
  }

  let config = { allowedIps: [] };
  if (fs.existsSync(ADMIN_CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(ADMIN_CONFIG_PATH, "utf-8");
      config = JSON.parse(raw);
    } catch (error) {
      console.warn("Failed to parse admin config, using defaults", error);
    }
  }

  if (!Array.isArray(config.allowedIps)) {
    config.allowedIps = [];
  }

  config.allowedIps = config.allowedIps
    .map((entry) => {
      if (typeof entry === "string") {
        return {
          ip: normalizeIp(entry),
          label: "",
          addedAt: new Date().toISOString(),
          addedBy: "unknown",
        };
      }

      const normalizedIp = normalizeIp(entry?.ip);
      return {
        ip: normalizedIp,
        label: typeof entry?.label === "string" ? entry.label : "",
        addedAt: entry?.addedAt || new Date().toISOString(),
        addedBy: entry?.addedBy || "unknown",
      };
    })
    .filter((entry) => entry.ip && isValidIp(entry.ip));

  ensureOwnerIp(config);
  adminConfig = config;

  try {
    fs.writeFileSync(ADMIN_CONFIG_PATH, JSON.stringify(adminConfig, null, 2));
  } catch (error) {
    console.warn("Failed to persist admin config", error);
  }
}

async function persistAdminConfig() {
  await fsPromises.mkdir(ADMIN_DATA_DIR, { recursive: true });
  await fsPromises.writeFile(
    ADMIN_CONFIG_PATH,
    JSON.stringify(adminConfig, null, 2)
  );
}

function isIpAllowed(ip) {
  const normalized = normalizeIp(ip);
  if (!normalized) {
    return false;
  }
  if (normalized === "127.0.0.1" && process.env.ALLOW_LOCAL_ADMIN === "true") {
    return true;
  }
  return adminConfig.allowedIps.some((entry) => entry.ip === normalized);
}

loadAdminConfig();

let gsiState = {
  players: {},
  currentFocus: null,
  teamNames: {
    CT: null,
    T: null,
  },
};

const playerDirectory = {
  bySteamId: new Map(),
  byNameLower: new Map(),
  byObserverSlot: new Map(),
};

function rebuildPlayerDirectory(players) {
  playerDirectory.bySteamId.clear();
  playerDirectory.byNameLower.clear();
  playerDirectory.byObserverSlot.clear();

  if (!players || typeof players !== "object") {
    return;
  }

  for (const info of Object.values(players)) {
    if (!info) {
      continue;
    }

    const steamId = typeof info.steamId === "string" && info.steamId.trim() ? info.steamId.trim() : null;
    const name = typeof info.name === "string" ? info.name.trim() : "";
    const nameLower = name ? name.toLowerCase() : "";
    const observerSlotRaw = Number(info.observer_slot);
    const observerSlot = Number.isFinite(observerSlotRaw) && observerSlotRaw > 0 ? observerSlotRaw : null;

    if (steamId) {
      playerDirectory.bySteamId.set(steamId, info);
    }

    if (nameLower) {
      playerDirectory.byNameLower.set(nameLower, info);
    }

    if (observerSlot) {
      let bucket = playerDirectory.byObserverSlot.get(observerSlot);
      if (!bucket) {
        bucket = [];
        playerDirectory.byObserverSlot.set(observerSlot, bucket);
      }
      bucket.push(info);
    }
  }
}

function extractClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) {
    const candidate = forwarded.split(",")[0].trim();
    if (candidate) {
      return normalizeIp(candidate);
    }
  }
  return normalizeIp(req.ip || req.connection?.remoteAddress || "");
}

function requireAdminAccess(req, res, next) {
  const clientIp = extractClientIp(req);
  if (!isIpAllowed(clientIp)) {
    if (req.accepts(["json", "html"]) === "json") {
      res.status(403).json({ error: "Forbidden" });
    } else {
      res.status(403).send("Forbidden");
    }
    return;
  }
  req.adminClientIp = clientIp;
  next();
}

function collectPublisherStats() {
  const stats = [];

  for (const [nickname, entry] of publishers.entries()) {
    let connectionCount = 0;
    const viewers = [];

    for (const [viewerSocketId, connectionIds] of entry.viewers.entries()) {
      const size = connectionIds.size;
      connectionCount += size;
      viewers.push({ viewerSocketId, connections: size });
    }

    stats.push({
      nickname,
      connections: connectionCount,
      viewerCount: connectionCount,
      uniqueViewers: viewers.length,
      viewers,
    });
  }

  stats.sort((a, b) => a.nickname.localeCompare(b.nickname));
  return stats;
}

const allowedOrigins = [
  "https://bikecam.onrender.com",
  "https://raptors.life",
  "http://localhost:3000",
];

const adminUser = process.env.ADMIN_USER || "admin";
const adminPass = process.env.ADMIN_PASS || "changeme";

const app = express();
app.set("trust proxy", true);
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS: " + origin));
    },
  })
);
app.use(compression());
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use(bodyParser.json({ limit: "5mb" }));

app.use(
  ["/admin.html", "/admin", "/admin-panel", "/api/admin", "/api/admin/*"],
  basicAuth({
    users: { [adminUser]: adminPass },
    challenge: true,
  })
);

app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Set();
const socketMeta = new Map();
const socketById = new Map();
const publishers = new Map();
let nextSocketId = 1;

const PORT = process.env.PORT || 3000;
const SITE_LINKS = [
  { label: "Main Focus", href: "/main-gb-full-27.html" },
  { label: "CT Cameras", href: "/ct-side-gb-27.html" },
  { label: "T Cameras", href: "/t-side-gb-27.html" },
  { label: "Register Camera", href: "/register.html" },
];

const ICE_SERVER_CONFIG = loadIceServerConfig();
const MJPEG_BOUNDARY = "frame";
const fallbackFrames = new Map();
const fallbackClients = new Map();

function loadIceServerConfig() {
  const defaults = [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:global.stun.twilio.com:3478",
      ],
    },
  ];

  const parsed = [];
  const envConfig = process.env.ICE_SERVERS;

  if (envConfig) {
    try {
      const value = JSON.parse(envConfig);
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry && typeof entry === "object" && entry.urls) {
            parsed.push(entry);
          }
        }
      }
    } catch (error) {
      console.warn("Failed to parse ICE_SERVERS. Using defaults.", error);
    }
  }

  if (parsed.length === 0) {
    parsed.push(...defaults);
  }

  const turnUrl = process.env.TURN_URL || process.env.TURN_SERVER || "";
  if (turnUrl) {
    const urls = turnUrl
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (urls.length) {
      parsed.push({
        urls,
        username: process.env.TURN_USERNAME || process.env.TURN_USER || "",
        credential:
          process.env.TURN_PASSWORD || process.env.TURN_CREDENTIAL || "",
      });
    }
  }

  return parsed;
}

app.get("/api/webrtc/config", (req, res) => {
  res.json({
    iceServers: ICE_SERVER_CONFIG,
    fallback: {
      mjpeg: true,
      endpoint: "/fallback/mjpeg",
      heartbeatSeconds: 20,
      maxFps: 5,
    },
  });
});

function writeMjpegFrame(res, frame) {
  if (!res || res.writableEnded || !frame?.buffer) {
    return;
  }

  try {
    res.write(`--${MJPEG_BOUNDARY}\r\n`);
    res.write(`Content-Type: ${frame.mimeType || "image/jpeg"}\r\n`);
    res.write(`Content-Length: ${frame.buffer.length}\r\n\r\n`);
    res.write(frame.buffer);
    res.write("\r\n");
  } catch (error) {
    try {
      res.end();
    } catch (endError) {
      // ignore ending errors
    }
  }
}

function broadcastFallbackFrame(nickname, record) {
  const key = normalizeNicknameKey(nickname);
  if (!key || !record) {
    return;
  }

  const clients = fallbackClients.get(key);
  if (!clients || clients.size === 0) {
    return;
  }

  for (const res of Array.from(clients)) {
    if (!res || res.writableEnded) {
      clients.delete(res);
      continue;
    }
    writeMjpegFrame(res, record);
  }

  if (clients.size === 0) {
    fallbackClients.delete(key);
  }
}

function clearFallbackForNickname(nickname) {
  const key = normalizeNicknameKey(nickname);
  if (!key) {
    return;
  }

  fallbackFrames.delete(key);

  const clients = fallbackClients.get(key);
  if (!clients) {
    return;
  }

  for (const res of clients) {
    try {
      res.end();
    } catch (error) {
      // ignore client end errors
    }
  }

  fallbackClients.delete(key);
}

function normalizeNicknameKey(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : "";
}

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

function getActivePublishers() {
  return Array.from(publishers.keys()).sort((a, b) => a.localeCompare(b));
}

function broadcastPublisherList() {
  broadcast({
    type: "ACTIVE_PUBLISHERS",
    publishers: getActivePublishers(),
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

  clearFallbackForNickname(nickname);
  broadcastPublisherList();
}

function stopViewerSubscription(
  meta,
  nickname,
  connectionId,
  notifyPublisher = true
) {
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
        steamId,
        name: player.name ?? "",
        team: player.team ?? "",
        health: player.state?.health ?? 0,
        observer_slot: player.observer_slot ?? null,
      };
    }

    gsiState.players = updatedPlayers;
  }

  if (data.player && typeof data.player === "object") {
    let observerSlot = Number(data.player.observer_slot);
    if (!Number.isFinite(observerSlot)) observerSlot = null;

    const spectargetRaw =
      data.player.spectarget ?? data.player?.state?.spectarget ?? null;

    const playerSteamId = String(data.player.steamid ?? "");
    const targetMeta = parseSpectatorTarget(spectargetRaw);
    const playerEntries = Object.values(gsiState.players);

    let focusName = null;

    if (targetMeta.steamId && targetMeta.steamId !== playerSteamId) {
      const directTarget = gsiState.players[targetMeta.steamId];
      if (directTarget?.name && directTarget.name.trim()) {
        focusName = directTarget.name.trim();
      }
    }

    if (!focusName && targetMeta.nameLower) {
      for (const info of playerEntries) {
        if (!info || info.steamId === playerSteamId) {
          continue;
        }

        const candidateName = typeof info.name === "string" ? info.name.trim() : "";
        if (!candidateName) {
          continue;
        }

        if (candidateName.toLowerCase() === targetMeta.nameLower) {
          focusName = candidateName;
          break;
        }
      }
    }

    if (!focusName) {
      const slotQueue = [];
      const pushSlot = (value) => {
        if (typeof value !== "number") {
          return;
        }
        if (!Number.isFinite(value) || value <= 0) {
          return;
        }
        if (!slotQueue.includes(value)) {
          slotQueue.push(value);
        }
      };

  pushSlot(targetMeta.slot);
      pushSlot(observerSlot);

      if (slotQueue.length) {
        for (const desiredSlot of slotQueue) {
          for (const info of playerEntries) {
            if (!info || info.steamId === playerSteamId) {
              continue;
            }

            const targetSlot = Number(info.observer_slot);
            if (Number.isFinite(targetSlot) && targetSlot === desiredSlot && info.name && info.name.trim()) {
              focusName = info.name.trim();
              break;
            }
          }

          if (focusName) {
            break;
          }
        }
      }
    }

    gsiState.currentFocus = focusName || null;
  } else {
    // если нет блока player в payload — сбрасываем фокус, чтобы Full_CAM не залипал123
    gsiState.currentFocus = null;
  }

  if (data.map && typeof data.map === "object") {
    const mapInfo = data.map;
    if (mapInfo.team_ct && typeof mapInfo.team_ct === "object") {
      const ctName = mapInfo.team_ct.name;
      if (typeof ctName === "string" && ctName.trim()) {
        gsiState.teamNames.CT = ctName.trim();
      }
    }

    if (mapInfo.team_t && typeof mapInfo.team_t === "object") {
      const tName = mapInfo.team_t.name;
      if (typeof tName === "string" && tName.trim()) {
        gsiState.teamNames.T = tName.trim();
      }
    }
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

  const players = Object.values(gsiState.players).filter(
    (player) => player?.name
  );
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

  res.json({
    teams,
    teamNames: {
      CT: gsiState.teamNames.CT,
      T: gsiState.teamNames.T,
    },
  });
});

app.get("/admin-panel", requireAdminAccess, (_req, res) => {
  res.sendFile(path.join(__dirname, "private", "admin.html"));
});

app.get("/api/admin/dashboard", requireAdminAccess, (_req, res) => {
  res.json({
    allowedIps: adminConfig.allowedIps,
    publishers: collectPublisherStats(),
    currentFocus: gsiState.currentFocus,
    teamNames: gsiState.teamNames,
    roster: Object.values(gsiState.players),
    siteLinks: SITE_LINKS,
    ownerIp: OWNER_IP,
    updatedAt: new Date().toISOString(),
  });
});

app.post("/api/admin/allowed-ips", requireAdminAccess, async (req, res) => {
  const rawIp = typeof req.body?.ip === "string" ? req.body.ip.trim() : "";
  const normalizedIp = normalizeIp(rawIp);
  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";

  if (!normalizedIp || !isValidIp(normalizedIp)) {
    res.status(400).json({ error: "Invalid IPv4 address" });
    return;
  }

  if (adminConfig.allowedIps.some((entry) => entry.ip === normalizedIp)) {
    res.status(409).json({ error: "IP address already allowed" });
    return;
  }

  const newEntry = {
    ip: normalizedIp,
    label,
    addedAt: new Date().toISOString(),
    addedBy: req.adminClientIp,
  };

  adminConfig.allowedIps.push(newEntry);
  try {
    await persistAdminConfig();
  } catch (error) {
    console.error("Failed to persist admin config", error);
    res.status(500).json({ error: "Failed to save configuration" });
    return;
  }

  res.json({ ok: true, allowedIps: adminConfig.allowedIps });
});

app.delete("/api/admin/allowed-ips/:ip", requireAdminAccess, async (req, res) => {
  const normalizedIp = normalizeIp(req.params?.ip);

  if (!normalizedIp || !isValidIp(normalizedIp)) {
    res.status(400).json({ error: "Invalid IPV4 address" });
    return;
  }

  if (normalizedIp === OWNER_IP) {
    res.status(400).json({ error: "Primary owner IP cannot be removed" });
    return;
  }

  const index = adminConfig.allowedIps.findIndex(
    (entry) => entry.ip === normalizedIp
  );
  if (index === -1) {
    res.status(404).json({ error: "IP address not found" });
    return;
  }

  adminConfig.allowedIps.splice(index, 1);

  try {
    await persistAdminConfig();
  } catch (error) {
    console.error("Failed to persist admin config", error);
    res.status(500).json({ error: "Failed to save configuration" });
    return;
  }

  res.json({ ok: true, allowedIps: adminConfig.allowedIps });
});

app.post("/api/admin/kick", requireAdminAccess, (req, res) => {
  const nickname =
    typeof req.body?.nickname === "string" ? req.body.nickname.trim() : "";
  if (!nickname) {
    res.status(400).json({ error: "nickname is required" });
    return;
  }

  const entry = publishers.get(nickname);
  if (!entry) {
    res.status(404).json({ error: "No active camera with that nickname" });
    return;
  }

  detachPublisher(nickname, entry.socket);
  res.json({ ok: true, nickname });
});

app.get("/camera/:nickname", (_req, res) => {
  res
    .status(410)
    .json({ error: "camera snapshots are not available in the WebRTC build" });
});

app.post("/admin/focus", requireAdminAccess, (req, res) => {
  const nickname = req.body?.nickname;

  if (!nickname || typeof nickname !== "string") {
    res.status(400).json({ error: "nickname is required" });
    return;
  }

  gsiState.currentFocus = nickname;
  broadcastState();
  res.json({ ok: true, currentFocus: gsiState.currentFocus });
});

app.post("/api/fallback/frame", (req, res) => {
  const nicknameRaw = typeof req.body?.nickname === "string" ? req.body.nickname : "";
  const framePayload = typeof req.body?.frame === "string" ? req.body.frame : "";
  const mimeType =
    typeof req.body?.mimeType === "string" && req.body.mimeType
      ? req.body.mimeType
      : "image/jpeg";

  const nicknameKey = normalizeNicknameKey(nicknameRaw);
  if (!nicknameKey || !framePayload) {
    res.status(400).json({ error: "nickname and frame are required" });
    return;
  }

  const buffer = Buffer.from(framePayload, "base64");
  if (!buffer.length) {
    res.status(400).json({ error: "frame is empty" });
    return;
  }

  if (buffer.length > 2_000_000) {
    res.status(413).json({ error: "frame is too large" });
    return;
  }

  const record = {
    buffer,
    mimeType,
    updatedAt: Date.now(),
  };

  fallbackFrames.set(nicknameKey, record);
  broadcastFallbackFrame(nicknameKey, record);

  res.json({ ok: true });
});

app.get("/fallback/mjpeg/:nickname", (req, res) => {
  const nicknameKey = normalizeNicknameKey(req.params.nickname);
  if (!nicknameKey) {
    res.status(400).send("nickname is required");
    return;
  }

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader(
    "Content-Type",
    `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`
  );

  let clients = fallbackClients.get(nicknameKey);
  if (!clients) {
    clients = new Set();
    fallbackClients.set(nicknameKey, clients);
  }

  clients.add(res);

  const record = fallbackFrames.get(nicknameKey);
  if (record) {
    writeMjpegFrame(res, record);
  }

  req.on("close", () => {
    clients.delete(res);
    if (clients.size === 0) {
      fallbackClients.delete(nicknameKey);
    }
  });
});

function handleHello(socket, meta, payload) {
  const role = typeof payload.role === "string" ? payload.role.trim().toLowerCase() : "";

  if (role === "publisher") {
    const nickname = typeof payload.nickname === "string" ? payload.nickname.trim() : "";
    if (!nickname) {
      sendJson(socket, { type: "ERROR", message: "nickname is required for publisher" });
      return;
    }

    const existing = publishers.get(nickname);
    if (existing && existing.socket !== socket) {
      sendJson(socket, {
        type: "ERROR",
        message: "Nickname already in use. Wait until it is released.",
      });
      return;
    }

    if (meta.nickname && meta.nickname !== nickname) {
      detachPublisher(meta.nickname, socket);
    }

    let entry = existing;
    if (!entry || entry.socket !== socket) {
      entry = { socket, viewers: new Map() };
      publishers.set(nickname, entry);
    }

    meta.role = "publisher";
    meta.nickname = nickname;
    sendJson(socket, { type: "PUBLISHER_REGISTERED", nickname });
    broadcastPublisherList();
    return;
  }

  if (role === "viewer" || role === "admin") {
    meta.role = role;
    sendJson(socket, { type: "VIEWER_REGISTERED", role });
    sendJson(socket, { type: "ACTIVE_PUBLISHERS", publishers: getActivePublishers() });
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
  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });

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
    publishers: getActivePublishers(),
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

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try {
        const meta = socketMeta.get(ws);

        if (meta) {
          if (meta.role === "publisher" && meta.nickname) {
            detachPublisher(meta.nickname, ws);
          } else if (meta.role === "viewer" && meta.subscriptions instanceof Map) {
            for (const [connectionId, nickname] of meta.subscriptions.entries()) {
              stopViewerSubscription(meta, nickname, connectionId, true);
            }
          }

          if (meta.id) {
            socketById.delete(meta.id);
          }
        }

        socketMeta.delete(ws);
        clients.delete(ws);
      } catch (error) {
        // ignore cleanup issues during heartbeat pruning
      }

      try {
        ws.terminate();
      } catch (error) {
        // ignore termination errors
      }
      return;
    }

    ws.isAlive = false;
    try {
      ws.ping();
    } catch (error) {
      // ignore ping errors
    }
  });

  broadcastPublisherList();
}, 30_000);

heartbeatInterval.unref?.();

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Stop the other service or set PORT to a free port.`
    );
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