import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import dotenv from "dotenv";
import basicAuth from "express-basic-auth";
import path from "path";
import fs from "fs";
import { promises as fsPromises } from "fs";
import { fileURLToPath } from "url";
import crypto from "crypto";
import fetch from "node-fetch";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OWNER_IP = process.env.OWNER_IP || "127.0.0.1";
const ADMIN_DATA_DIR = path.join(__dirname, "data");
const ADMIN_CONFIG_PATH = path.join(ADMIN_DATA_DIR, "admin-config.json");
const PUBLIC_DIR = path.join(__dirname, "public");
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

  ensureQualityConfigShape(config);
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

let gsiState = {
  players: {},
  currentFocus: null,
  teamNames: {
    CT: null,
    T: null,
  },
};

let latestGSI = null;

const playerDirectory = {
  bySteamId: new Map(),
  byNameLower: new Map(),
  byObserverSlot: new Map(),
};

const forcedFallback = new Map();

const serverLogs = [];
const logStreamClients = new Set();
let nextLogId = 1;
const MAX_LOG_ENTRIES = 1000;
const LOG_HEARTBEAT_MS = 15000;

const QUALITY_PROFILES = {
  LOW: {
    maxBitrate: 400_000,
    maxFramerate: 20,
    scaleResolutionDownBy: 2,
  },
  MED: {
    maxBitrate: 1_200_000,
    maxFramerate: 30,
    scaleResolutionDownBy: 1.25,
  },
  HIGH: {
    maxBitrate: 2_400_000,
    maxFramerate: 60,
    scaleResolutionDownBy: 1,
  },
};

const QUALITY_PROFILE_NAMES = new Set(["LOW", "MED", "HIGH", "CUSTOM"]);
const QUALITY_PROFILE_ORDER = ["HIGH", "MED", "LOW"];
const DEFAULT_CUSTOM_PROFILE = {
  maxBitrate: 1_800_000,
  maxFramerate: 30,
  scaleResolutionDownBy: 1,
};

loadAdminConfig();

function logEvent(type, message, detail = null) {
  const entry = {
    id: nextLogId++,
    timestamp: new Date().toISOString(),
    type,
    message,
  };

  if (detail && typeof detail === "object" && Object.keys(detail).length) {
    entry.detail = detail;
  }

  serverLogs.push(entry);
  if (serverLogs.length > MAX_LOG_ENTRIES) {
    serverLogs.shift();
  }

  const payload = `event: log\ndata:${JSON.stringify(entry)}\n\n`;
  for (const client of logStreamClients) {
    try {
      client.write(payload);
    } catch (error) {
      logStreamClients.delete(client);
    }
  }
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

function sanitizeQualityParams(input, fallback = DEFAULT_CUSTOM_PROFILE) {
  const base = fallback || DEFAULT_CUSTOM_PROFILE;
  const source = input && typeof input === "object" ? input : {};

  const bitrate = clampNumber(source.maxBitrate, 100_000, 8_000_000, base.maxBitrate);
  const framerate = clampNumber(source.maxFramerate, 10, 120, base.maxFramerate);
  const scale = clampNumber(
    source.scaleResolutionDownBy,
    1,
    4,
    base.scaleResolutionDownBy
  );

  return {
    maxBitrate: Math.round(bitrate),
    maxFramerate: Math.round(framerate),
    scaleResolutionDownBy: Number(scale.toFixed(2)),
  };
}

function normalizeProfileName(value) {
  const name = typeof value === "string" ? value.trim().toUpperCase() : "";
  return QUALITY_PROFILE_NAMES.has(name) ? name : null;
}

function ensureQualityConfigShape(config) {
  if (!config.quality || typeof config.quality !== "object") {
    config.quality = {};
  }

  const quality = config.quality;
  const defaultProfile = normalizeProfileName(quality.defaultProfile) || "HIGH";
  quality.defaultProfile = defaultProfile;
  quality.defaultCustom = sanitizeQualityParams(quality.defaultCustom, DEFAULT_CUSTOM_PROFILE);

  const overrides = {};
  if (quality.cameraOverrides && typeof quality.cameraOverrides === "object") {
    for (const [rawKey, rawValue] of Object.entries(quality.cameraOverrides)) {
      const nickname = sanitizeNickname(rawValue?.nickname || rawKey);
      const key = normalizeNicknameKey(nickname || rawKey);
      if (!key) {
        continue;
      }

      const profileName = normalizeProfileName(
        (rawValue && typeof rawValue === "object" ? rawValue.profile : rawValue) || ""
      );
      if (!profileName) {
        continue;
      }

      const entry = {
        profile: profileName,
        nickname: nickname || rawValue?.nickname || rawKey,
      };

      if (profileName === "CUSTOM") {
        const customSource =
          (rawValue && typeof rawValue === "object" && (rawValue.custom || rawValue.params || rawValue.settings)) ||
          null;
        entry.custom = sanitizeQualityParams(customSource, quality.defaultCustom);
      }

      overrides[key] = entry;
    }
  }

  quality.cameraOverrides = overrides;
  return quality;
}

function resolveQualityProfile(profileName, customOverride) {
  const normalized = normalizeProfileName(profileName) || "HIGH";
  if (normalized === "CUSTOM") {
    return sanitizeQualityParams(
      customOverride,
      adminConfig.quality?.defaultCustom || DEFAULT_CUSTOM_PROFILE
    );
  }

  const base = QUALITY_PROFILES[normalized] || QUALITY_PROFILES.HIGH;
  return { ...base };
}

function getEffectiveQualityForKey(key) {
  const quality = adminConfig.quality || {};
  const overrides = quality.cameraOverrides || {};
  const override = key ? overrides[key] : null;

  const profileName = normalizeProfileName(override?.profile) || quality.defaultProfile || "HIGH";
  const params = resolveQualityProfile(
    profileName,
    profileName === "CUSTOM" ? override?.custom : quality.defaultCustom
  );

  return {
    profile: profileName,
    params,
    source: override ? "override" : "default",
  };
}

function sendQualityProfileUpdate(entry) {
  if (!entry || !entry.socket) {
    return;
  }

  const effective = getEffectiveQualityForKey(entry.key);
  sendJson(entry.socket, {
    type: "QUALITY_PROFILE",
    nickname: entry.nickname,
    profile: effective.profile,
    params: effective.params,
  });
}

function notifyQualityProfileForKey(key) {
  const entry = key ? publishers.get(key) : null;
  if (entry) {
    sendQualityProfileUpdate(entry);
  }
}

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

function getForcedFallbackList() {
  return Array.from(forcedFallback.values()).sort((a, b) => a.localeCompare(b));
}

function broadcastForcedFallback() {
  broadcast({
    type: "FORCED_FALLBACK",
    nicknames: getForcedFallbackList(),
  });
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

  for (const entry of publishers.values()) {
    let connectionCount = 0;
    const viewers = [];

    for (const [viewerSocketId, connectionIds] of entry.viewers.entries()) {
      const size = connectionIds.size;
      connectionCount += size;
      viewers.push({ viewerSocketId, connections: size });
    }

    const effectiveQuality = getEffectiveQualityForKey(entry.key);

    stats.push({
      nickname: entry.nickname,
      connections: connectionCount,
      viewerCount: connectionCount,
      uniqueViewers: viewers.length,
      viewers,
      forcedFallback: forcedFallback.has(entry.key),
      qualityProfile: effectiveQuality.profile,
    });
  }

  stats.sort((a, b) => a.nickname.localeCompare(b.nickname));
  return stats;
}

const adminUser = process.env.ADMIN_USER || "admin";
const adminPass = process.env.ADMIN_PASS || "changeme";

const app = express();
app.set("trust proxy", true);
// Updated for TURN server integration
const corsOptions = {
  origin: ["https://bikecam.onrender.com"],
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(compression());
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use("/api/fallback/frame", express.json({ limit: "3mb" }));
app.use(express.json({ limit: "1mb" }));

const adminAuthMiddleware = basicAuth({
  users: { [adminUser]: adminPass },
  challenge: true,
});

const ADMIN_PATHS = [
  "/admin.html",
  "/admin",
  "/admin-panel",
  "/api/admin",
  "/api/admin/*",
  "/logs",
  "/api/logs",
  "/api/logs/*",
];

app.use(ADMIN_PATHS, (req, res, next) => {
  const clientIp = extractClientIp(req);
  if (isIpAllowed(clientIp)) {
    req.adminClientIp = clientIp;
    next();
    return;
  }
  adminAuthMiddleware(req, res, next);
});

// Updated for TURN server integration: expose static frontend assets
app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "main-gb-full-27.html"));
});

app.get("/register.html", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "register.html"));
});

app.get("/admin.html", (_req, res) => {
  res.redirect(302, "/admin-panel");
});

app.get("/assets/team-logos.json", async (_req, res) => {
  try {
    const response = await fetch("https://waywayway-production.up.railway.app/teams", { timeout: 8000 });
    if (!response.ok) {
      res.status(502).json({ error: "Upstream failed", status: response.status });
      return;
    }
    const data = await response.json();
    res.set("Cache-Control", "public, max-age=300");
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: "Proxy error", detail: String(error) });
  }
});

app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Set();
const socketMeta = new Map();
const socketById = new Map();
const publishers = new Map();
let nextSocketId = 1;

function getPublisherByNickname(input) {
  const key = normalizeNicknameKey(input);
  if (!key) {
    return { key: "", entry: null };
  }
  const entry = publishers.get(key) || null;
  return { key, entry };
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const SITE_LINKS = [
  { label: "Main Focus", href: "/main-gb-full-27.html" },
  { label: "CT Cameras", href: "/ct-side-gb-27.html" },
  { label: "T Cameras", href: "/t-side-gb-27.html" },
  { label: "Register Camera", href: "/register.html" },
];


const MJPEG_BOUNDARY = "frame";
const fallbackFrames = new Map();
const fallbackClients = new Map();

const TURN_SECRET = process.env.TURN_STATIC_AUTH_SECRET || "7f7125d43be5b0c1c50e99a578e97102";

function genTurnRestCred({ secret, ttlSec = 3600, userId = "pm-camera" }) {
  const now = Math.floor(Date.now() / 1000);
  const username = `${now + ttlSec}:${userId}`;      // формат "expires:userId"
  const credential = crypto.createHmac("sha1", secret)
    .update(username)
    .digest("base64");
  return { username, credential, ttlSec };
}

app.get("/api/webrtc/config", (req, res) => {
  const { username, credential, ttlSec } = genTurnRestCred({
    secret: TURN_SECRET,
    ttlSec: 3600,
    userId: "pm-camera"
  });

  res.json({
    iceServers: [
      {
        urls: [
          "stun:turn.raptors.life:3478",
          "turn:turn.raptors.life:3478?transport=udp",
          "turns:turn.raptors.life:5349?transport=tcp"
        ],
        username,
        credential
      },
      // (опционально) Google STUN в хвост:
      { urls: ["stun:stun.l.google.com:19302"] }
    ],
    ttlSec
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

function sanitizeNickname(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\s+/g, " ");
}

function normalizeNicknameKey(value) {
  const sanitized = sanitizeNickname(value);
  if (!sanitized) {
    return "";
  }

  return sanitized.replace(/\s+/g, "").toLowerCase();
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
  return Array.from(publishers.values())
    .map((entry) => entry.nickname)
    .sort((a, b) => a.localeCompare(b));
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

  const { entry } = getPublisherByNickname(nickname);
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

  const { key, entry } = getPublisherByNickname(nickname);
  if (!entry) {
    return;
  }

  if (socket && entry.socket !== socket) {
    return;
  }

  publishers.delete(key);
  logEvent("publisher", "Publisher detached", { nickname: entry.nickname });

  for (const [viewerSocketId, connectionIds] of entry.viewers.entries()) {
    const viewerSocket = socketById.get(viewerSocketId);
    if (!viewerSocket) {
      continue;
    }

    for (const connectionId of connectionIds) {
      sendJson(viewerSocket, {
        type: "STREAM_ENDED",
        nickname: entry.nickname,
        connectionId,
      });

      const viewerMeta = socketMeta.get(viewerSocket);
      if (viewerMeta) {
        viewerMeta.subscriptions.delete(connectionId);
      }
    }
  }

  if (
    typeof gsiState.currentFocus === "string" &&
    normalizeNicknameKey(gsiState.currentFocus) === key
  ) {
    gsiState.currentFocus = null;
    broadcastState();
    logEvent("focus", "Focus cleared because publisher detached", {
      nickname: entry.nickname,
    });
  }

  clearFallbackForNickname(entry.nickname);
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

  const { entry } = getPublisherByNickname(nickname);
  if (!entry) {
    return;
  }

  sendJson(entry.socket, {
    type: "VIEWER_DISCONNECTED",
    viewerSocketId: meta.id,
    connectionId,
    nickname: entry.nickname,
  });
}

app.post("/api/gsi", (req, res) => {
  const data = req.body || {};
  latestGSI = data;
  const previousFocus = gsiState.currentFocus;

  if (data.allplayers && typeof data.allplayers === "object") {
    const updatedPlayers = {};

    for (const [steamId, player] of Object.entries(data.allplayers)) {
      if (!player) {
        continue;
      }

      const primarySteamId = normalizeSteamId(player.steamid ?? steamId) ?? normalizeSteamId(steamId) ?? String(steamId);
      const name = typeof player.name === "string" ? player.name.trim() : "";
      const observerSlotRaw = Number(player.observer_slot);
      const observerSlot = Number.isFinite(observerSlotRaw) && observerSlotRaw > 0 ? observerSlotRaw : null;
      const health = Number(player.state?.health ?? 0);

      updatedPlayers[primarySteamId] = {
        steamId: primarySteamId,
        rawSteamId: typeof player.steamid === "string" ? player.steamid : String(steamId),
        name,
        team: typeof player.team === "string" ? player.team : "",
        health: Number.isFinite(health) ? health : 0,
        observer_slot: observerSlot,
        observer_slot_raw: player.observer_slot ?? null,
      };

      if (name) {
        updatedPlayers[primarySteamId].nameLower = name.toLowerCase();
      }
    }

    gsiState.players = updatedPlayers;
    rebuildPlayerDirectory(gsiState.players);
  }

  if (data.player && typeof data.player === "object") {
    const spectargetRaw =
      data.player.spectarget ?? data.player?.state?.spectarget ?? null;

    const pickName = (info) => {
      if (!info) {
        return null;
      }
      const value = typeof info.name === "string" ? info.name.trim() : "";
      return value || null;
    };

    let focusName = null;

    if (
      spectargetRaw !== null &&
      spectargetRaw !== undefined &&
      !(typeof spectargetRaw === "string" && !spectargetRaw.trim())
    ) {
      const targetMeta = parseSpectatorTarget(spectargetRaw);

      if (targetMeta.steamId) {
        focusName = pickName(gsiState.players[targetMeta.steamId]);
        if (!focusName && data.allplayers && typeof data.allplayers === "object") {
          focusName = pickName(data.allplayers[targetMeta.steamId]);
        }
      }

      if (!focusName && Number.isFinite(targetMeta.slot) && targetMeta.slot > 0) {
        const bucket = playerDirectory.byObserverSlot.get(targetMeta.slot);
        if (Array.isArray(bucket)) {
          for (const info of bucket) {
            focusName = pickName(info);
            if (focusName) {
              break;
            }
          }
        }
      }

      if (!focusName && targetMeta.nameLower) {
        focusName = pickName(playerDirectory.byNameLower.get(targetMeta.nameLower));
      }

      if (!focusName && data.allplayers && typeof data.allplayers === "object") {
        const directKey = String(spectargetRaw);
        focusName = pickName(data.allplayers[directKey]);
      }

      if (!focusName && targetMeta.name) {
        focusName = targetMeta.name.trim();
      }
    }

    if (!focusName) {
      const directName = pickName(data.player);
      if (directName) {
        focusName = directName;
      }
    }

    if (!focusName) {
      const observerSlot = Number(data.player?.observer_slot ?? data.player?.state?.observer_slot);
      if (Number.isFinite(observerSlot) && observerSlot > 0) {
        const bucket = playerDirectory.byObserverSlot.get(observerSlot);
        if (Array.isArray(bucket)) {
          for (const info of bucket) {
            focusName = pickName(info);
            if (focusName) {
              break;
            }
          }
        }
      }
    }

    if (!focusName) {
      const steamId = normalizeSteamId(data.player?.steamid);
      if (steamId) {
        focusName = pickName(gsiState.players[steamId] || data.allplayers?.[steamId]);
      }
    }

    gsiState.currentFocus = focusName || null;
  } else {
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
  if (previousFocus !== gsiState.currentFocus) {
    logEvent("focus", "Focus updated", {
      previous: previousFocus,
      next: gsiState.currentFocus,
    });
  }
  res.json({ ok: true });
});

app.get("/players", (req, res) => {
  const source = latestGSI && typeof latestGSI === "object" ? latestGSI.allplayers : null;
  const records = [];

  if (source && typeof source === "object") {
    for (const key of Object.keys(source)) {
      const entry = source[key] || {};
      const id = typeof entry.steamid === "string" && entry.steamid.trim() ? entry.steamid.trim() : String(key);
      const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id;
      const team = typeof entry.team === "string" && entry.team.trim() ? entry.team.trim() : null;
      const observerSlotRaw = entry.observer_slot ?? entry.observer_slot_raw ?? null;
      const observerSlot = Number.isFinite(Number(observerSlotRaw)) ? Number(observerSlotRaw) : null;

      records.push({
        id,
        name,
        team,
        observer_slot: observerSlot,
        state: entry.state && typeof entry.state === "object" ? entry.state : null,
      });
    }
  } else {
    for (const player of Object.values(gsiState.players)) {
      if (!player) {
        continue;
      }
      const id = typeof player.steamId === "string" && player.steamId.trim() ? player.steamId.trim() : player.rawSteamId || "";
      const name = typeof player.name === "string" && player.name.trim() ? player.name.trim() : id || "Player";
      const observerSlot = Number.isFinite(Number(player.observer_slot)) ? Number(player.observer_slot) : null;
      const team = typeof player.team === "string" && player.team.trim() ? player.team.trim() : null;

      records.push({
        id: id || name,
        name,
        team,
        observer_slot: observerSlot,
        state: null,
      });
    }
  }

  records.sort((a, b) => {
    const teamA = (a.team || "").toUpperCase();
    const teamB = (b.team || "").toUpperCase();
    if (teamA !== teamB) {
      return teamA.localeCompare(teamB);
    }
    const slotA = Number.isFinite(a.observer_slot) ? a.observer_slot : 999;
    const slotB = Number.isFinite(b.observer_slot) ? b.observer_slot : 999;
    if (slotA !== slotB) {
      return slotA - slotB;
    }
    return a.name.localeCompare(b.name);
  });

  res.json({ players: records });
});

app.get("/current-focus", (req, res) => {
  res.json({ currentFocus: gsiState.currentFocus });
});

app.get("/api/current-focus", (req, res) => {
  res.json({ currentFocus: gsiState.currentFocus });
});

app.get("/teams", (req, res) => {
  const payload = latestGSI && typeof latestGSI === "object" ? latestGSI : {};
  const source = payload.allplayers && typeof payload.allplayers === "object" ? payload.allplayers : {};
  const hints = {
    CT: typeof payload?.map?.team_ct?.name === "string" && payload.map.team_ct.name.trim()
      ? payload.map.team_ct.name.trim()
      : gsiState.teamNames.CT,
    T: typeof payload?.map?.team_t?.name === "string" && payload.map.team_t.name.trim()
      ? payload.map.team_t.name.trim()
      : gsiState.teamNames.T,
  };

  const teamMap = new Map();

  const ensureTeam = (id) => {
    const normalized = (id || "UNKNOWN").toUpperCase();
    if (!teamMap.has(normalized)) {
      const hintName = hints[normalized] || normalized;
      teamMap.set(normalized, {
        id: normalized,
        name: hintName || normalized,
        players: [],
        logo: null,
        altLogo: null,
        colors: null,
      });
    }
    return teamMap.get(normalized);
  };

  for (const key of Object.keys(source)) {
    const entry = source[key] || {};
    const teamIdRaw = typeof entry.team === "string" && entry.team.trim() ? entry.team.trim() : "UNKNOWN";
  const teamBucket = ensureTeam(teamIdRaw);

    const playerId = typeof entry.steamid === "string" && entry.steamid.trim() ? entry.steamid.trim() : String(key);
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : playerId;
    const observerSlotRaw = entry.observer_slot ?? entry.observer_slot_raw ?? null;
    const observerSlot = Number.isFinite(Number(observerSlotRaw)) ? Number(observerSlotRaw) : null;

    teamBucket.players.push({
      id: playerId,
      name,
      observer_slot: observerSlot,
    });
  }

  // ensure hints captured even without players
  for (const key of Object.keys(hints)) {
    if (!hints[key]) {
      continue;
    }
  ensureTeam(key);
  const existing = teamMap.get(key);
    if (existing) {
      existing.name = hints[key];
    }
  }

  const teams = Array.from(teamMap.values()).map((team) => {
    team.players.sort((a, b) => {
      const slotA = Number.isFinite(a.observer_slot) ? a.observer_slot : 999;
      const slotB = Number.isFinite(b.observer_slot) ? b.observer_slot : 999;
      if (slotA !== slotB) {
        return slotA - slotB;
      }
      return a.name.localeCompare(b.name);
    });
    return team;
  });

  res.json({ teams });
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
    forcedFallback: getForcedFallbackList(),
    quality: {
      defaultProfile: adminConfig.quality?.defaultProfile || "HIGH",
      defaultParams: resolveQualityProfile(
        adminConfig.quality?.defaultProfile,
        adminConfig.quality?.defaultCustom
      ),
      overrides: Object.entries(adminConfig.quality?.cameraOverrides || {}).map(
        ([key, value]) => ({
          key,
          nickname: value.nickname,
          profile: value.profile,
          params: resolveQualityProfile(
            value.profile,
            value.profile === "CUSTOM" ? value.custom : adminConfig.quality?.defaultCustom
          ),
        })
      ),
    },
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
  logEvent("admin", "IP allowlisted", {
    ip: normalizedIp,
    label,
    admin: req.adminClientIp,
  });
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
  logEvent("admin", "IP removed from allowlist", {
    ip: normalizedIp,
    admin: req.adminClientIp,
  });
});

app.post("/api/admin/kick", requireAdminAccess, (req, res) => {
  const nickname =
    typeof req.body?.nickname === "string" ? req.body.nickname.trim() : "";
  if (!nickname) {
    res.status(400).json({ error: "nickname is required" });
    return;
  }

  const { entry } = getPublisherByNickname(nickname);
  if (!entry) {
    res.status(404).json({ error: "No active camera with that nickname" });
    return;
  }

  detachPublisher(entry.nickname, entry.socket);
  logEvent("admin", "Publisher kicked", {
    nickname: entry.nickname,
    admin: req.adminClientIp,
  });
  res.json({ ok: true, nickname: entry.nickname });
});

app.post("/api/admin/fallback", requireAdminAccess, (req, res) => {
  const nickname = sanitizeNickname(req.body?.nickname);
  const key = normalizeNicknameKey(nickname);
  const mode =
    typeof req.body?.mode === "string" ? req.body.mode.trim().toLowerCase() : "";

  if (!key || !nickname) {
    res.status(400).json({ error: "nickname is required" });
    return;
  }

  const enable = mode === "mjpeg" || mode === "fallback" || mode === "force";

  if (enable) {
    forcedFallback.set(key, nickname);
  } else {
    forcedFallback.delete(key);
  }

  broadcastForcedFallback();
  logEvent("fallback", enable ? "Forced MJPEG enabled" : "Forced MJPEG cleared", {
    nickname,
    admin: req.adminClientIp,
  });
  res.json({ ok: true, forcedFallback: getForcedFallbackList() });
});

app.get("/api/admin/quality", requireAdminAccess, (_req, res) => {
  ensureQualityConfigShape(adminConfig);
  const quality = adminConfig.quality;

  const overrides = Object.entries(quality.cameraOverrides || {}).map(
    ([key, value]) => ({
      key,
      nickname: value.nickname,
      profile: value.profile,
      params: resolveQualityProfile(
        value.profile,
        value.profile === "CUSTOM" ? value.custom : quality.defaultCustom
      ),
    })
  );

  res.json({
    availableProfiles: {
      LOW: { ...QUALITY_PROFILES.LOW },
      MED: { ...QUALITY_PROFILES.MED },
      HIGH: { ...QUALITY_PROFILES.HIGH },
      CUSTOM: resolveQualityProfile("CUSTOM", quality.defaultCustom),
    },
    default: {
      profile: quality.defaultProfile,
      params: resolveQualityProfile(quality.defaultProfile, quality.defaultCustom),
      custom: quality.defaultCustom,
    },
    overrides,
  });
});

app.post("/api/admin/quality/default", requireAdminAccess, async (req, res) => {
  ensureQualityConfigShape(adminConfig);
  const quality = adminConfig.quality;

  const profileName = normalizeProfileName(req.body?.profile);
  if (!profileName) {
    res.status(400).json({ error: "Unknown profile" });
    return;
  }

  if (req.body?.custom) {
    quality.defaultCustom = sanitizeQualityParams(req.body.custom, quality.defaultCustom);
  }

  if (profileName === "CUSTOM") {
    quality.defaultCustom = sanitizeQualityParams(req.body?.custom, quality.defaultCustom);
  }

  quality.defaultProfile = profileName;

  try {
    await persistAdminConfig();
  } catch (error) {
    console.error("Failed to persist quality default", error);
    res.status(500).json({ error: "Failed to save configuration" });
    return;
  }

  for (const entry of publishers.values()) {
    if (!quality.cameraOverrides[entry.key]) {
      sendQualityProfileUpdate(entry);
    }
  }

  logEvent("admin", "Default quality profile updated", {
    profile: profileName,
    admin: req.adminClientIp,
  });

  res.json({
    ok: true,
    default: {
      profile: quality.defaultProfile,
      params: resolveQualityProfile(quality.defaultProfile, quality.defaultCustom),
      custom: quality.defaultCustom,
    },
  });
});

app.post("/api/admin/quality/camera", requireAdminAccess, async (req, res) => {
  ensureQualityConfigShape(adminConfig);
  const quality = adminConfig.quality;

  const nickname = sanitizeNickname(req.body?.nickname);
  const key = normalizeNicknameKey(nickname);
  if (!key || !nickname) {
    res.status(400).json({ error: "nickname is required" });
    return;
  }

  const requestedProfileRaw = typeof req.body?.profile === "string" ? req.body.profile.trim() : "";
  const requestedProfile = normalizeProfileName(requestedProfileRaw);
  const removeOverride =
    !requestedProfile || requestedProfileRaw.toLowerCase() === "inherit" || req.body?.remove === true;

  if (removeOverride) {
    const existed = Boolean(quality.cameraOverrides[key]);
    delete quality.cameraOverrides[key];

    try {
      await persistAdminConfig();
    } catch (error) {
      console.error("Failed to persist quality override removal", error);
      res.status(500).json({ error: "Failed to save configuration" });
      return;
    }

    notifyQualityProfileForKey(key);
    if (existed) {
      logEvent("admin", "Camera quality override cleared", {
        nickname,
        admin: req.adminClientIp,
      });
    }

    res.json({ ok: true, override: null });
    return;
  }

  if (!requestedProfile) {
    res.status(400).json({ error: "Unknown profile" });
    return;
  }

  const override = {
    profile: requestedProfile,
    nickname,
  };

  if (requestedProfile === "CUSTOM") {
    override.custom = sanitizeQualityParams(req.body?.custom, quality.defaultCustom);
  }

  quality.cameraOverrides[key] = override;

  try {
    await persistAdminConfig();
  } catch (error) {
    console.error("Failed to persist quality override", error);
    res.status(500).json({ error: "Failed to save configuration" });
    return;
  }

  notifyQualityProfileForKey(key);
  logEvent("admin", "Camera quality override updated", {
    nickname,
    profile: requestedProfile,
    admin: req.adminClientIp,
  });

  res.json({
    ok: true,
    override: {
      key,
      nickname,
      profile: override.profile,
      params: resolveQualityProfile(
        override.profile,
        override.profile === "CUSTOM" ? override.custom : quality.defaultCustom
      ),
    },
  });
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
  logEvent("focus", "Focus manually set", { nickname, admin: req.adminClientIp });
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
    logEvent("error", "Fallback frame rejected", {
      nickname: nicknameRaw,
      reason: "missing data",
    });
    res.status(400).json({ error: "nickname and frame are required" });
    return;
  }

  const buffer = Buffer.from(framePayload, "base64");
  if (!buffer.length) {
    logEvent("error", "Fallback frame rejected", {
      nickname: nicknameKey,
      reason: "empty buffer",
    });
    res.status(400).json({ error: "frame is empty" });
    return;
  }

  if (buffer.length > 2_000_000) {
    logEvent("error", "Fallback frame rejected", {
      nickname: nicknameKey,
      reason: "frame too large",
      size: buffer.length,
    });
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

app.post("/api/publisher/quality-event", (req, res) => {
  const nickname = sanitizeNickname(req.body?.nickname);
  const key = normalizeNicknameKey(nickname);

  if (!nickname || !key) {
    res.status(400).json({ error: "nickname is required" });
    return;
  }

  const entry = publishers.get(key);
  const fromProfile = normalizeProfileName(req.body?.fromProfile) || req.body?.fromProfile || null;
  const toProfile = normalizeProfileName(req.body?.toProfile) || req.body?.toProfile || null;
  const reason = typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim() : "auto";
  const metrics = req.body?.metrics && typeof req.body.metrics === "object" ? req.body.metrics : undefined;

  logEvent("quality", "Publisher quality profile adjusted", {
    nickname: (entry && entry.nickname) || nickname,
    fromProfile,
    toProfile,
    reason,
    metrics,
  });

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

app.get("/logs", requireAdminAccess, (_req, res) => {
  res.sendFile(path.join(__dirname, "private", "logs.html"));
});

app.get("/api/logs/export", requireAdminAccess, (_req, res) => {
  res.json({ logs: serverLogs });
});

app.get("/api/logs/stream", requireAdminAccess, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const client = res;
  logStreamClients.add(client);
  logEvent("admin", "Log stream connected", { admin: req.adminClientIp });

  const snapshot = `event: snapshot\ndata:${JSON.stringify(serverLogs)}\n\n`;
  try {
    client.write(snapshot);
  } catch (error) {
    // ignore snapshot failures
  }

  req.on("close", () => {
    logStreamClients.delete(client);
    logEvent("admin", "Log stream disconnected", { admin: req.adminClientIp });
  });
});

function handleHello(socket, meta, payload) {
  const role = typeof payload.role === "string" ? payload.role.trim().toLowerCase() : "";

  if (role === "publisher") {
    const nickname = sanitizeNickname(payload.nickname);
    const key = normalizeNicknameKey(nickname);

    if (!nickname || !key) {
      sendJson(socket, { type: "ERROR", message: "nickname is required for publisher" });
      logEvent("error", "Publisher HELLO missing nickname", {});
      return;
    }

    const { entry: existing } = getPublisherByNickname(nickname);
    if (existing && existing.socket !== socket) {
      sendJson(socket, {
        type: "ERROR",
        message: "Nickname already in use. Wait until it is released.",
      });
      logEvent("publisher", "Publisher rejected due to duplicate nickname", {
        nickname,
      });
      return;
    }

    if (meta.nicknameKey && meta.nicknameKey !== key) {
      detachPublisher(meta.nickname, socket);
    }

    let entry = existing;
    if (!entry || entry.socket !== socket) {
      entry = { socket, viewers: new Map(), nickname, key };
      publishers.set(key, entry);
    } else {
      entry.nickname = nickname;
      entry.key = key;
    }

    meta.role = "publisher";
    meta.nickname = nickname;
    meta.nicknameKey = key;

    const effectiveQuality = getEffectiveQualityForKey(key);
    sendJson(socket, {
      type: "PUBLISHER_REGISTERED",
      nickname,
      qualityProfile: effectiveQuality,
    });
    sendQualityProfileUpdate(entry);
    logEvent("publisher", "Publisher registered", { nickname });
    broadcastPublisherList();
    return;
  }

  if (role === "viewer" || role === "admin") {
    meta.role = role;
    sendJson(socket, { type: "VIEWER_REGISTERED", role });
    sendJson(socket, { type: "ACTIVE_PUBLISHERS", publishers: getActivePublishers() });
    sendJson(socket, { type: "FORCED_FALLBACK", nicknames: getForcedFallbackList() });
    logEvent("viewer", "Viewer connected", { role, socketId: meta.id });
    return;
  }

  sendJson(socket, { type: "ERROR", message: "unknown role" });
  logEvent("error", "Unknown role in HELLO", { role: payload.role });
}

function handleViewerOffer(socket, meta, payload) {
  const connectionId = payload.connectionId;
  const nickname = sanitizeNickname(payload.nickname);
  const key = normalizeNicknameKey(nickname);

  if (!connectionId || !key) {
    return;
  }

  const entry = publishers.get(key);
  if (!entry) {
    sendJson(socket, {
      type: "STREAM_UNAVAILABLE",
      nickname,
      connectionId,
    });
    logEvent("viewer", "Viewer offer rejected because publisher missing", {
      nickname,
      socketId: meta.id,
    });
    return;
  }

  meta.role = meta.role || "viewer";
  if (!meta.subscriptions.has(connectionId)) {
    meta.subscriptions.set(connectionId, entry.nickname);
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
    nickname: entry.nickname,
    sdp: payload.sdp,
  });
  logEvent("viewer", "Viewer offer forwarded", {
    nickname: entry.nickname,
    socketId: meta.id,
    connectionId,
  });
}

function handleViewerIce(meta, payload) {
  const nickname = sanitizeNickname(payload.nickname);
  const key = normalizeNicknameKey(nickname);
  const connectionId = payload.connectionId;

  if (!key || !connectionId) {
    return;
  }

  const entry = publishers.get(key);
  if (!entry) {
    return;
  }

  sendJson(entry.socket, {
    type: "SIGNAL_VIEWER_CANDIDATE",
    viewerSocketId: meta.id,
    connectionId,
    nickname: entry.nickname,
    candidate: payload.candidate,
  });
}

function handleViewerStop(socket, meta, payload) {
  const connectionId = payload.connectionId;
  const nickname = sanitizeNickname(payload.nickname);
  if (!connectionId || !nickname) {
    return;
  }
  stopViewerSubscription(meta, nickname, connectionId, true);
  logEvent("viewer", "Viewer stopped subscription", {
    nickname,
    socketId: meta.id,
    connectionId,
  });
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
    forcedFallback: getForcedFallbackList(),
  });
  logEvent("socket", "WebSocket connected", {
    socketId,
    remote: socket._socket?.remoteAddress || null,
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
      logEvent("socket", "WebSocket closed", {
        socketId,
      });
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
    logEvent("socket", "WebSocket closed", {
      socketId,
      role: metaInfo.role,
      nickname: metaInfo.nickname || null,
    });
  });

  socket.on("error", (error) => {
    console.error("WebSocket error:", error);
    logEvent("error", "WebSocket error", {
      socketId,
      message: error?.message || String(error),
    });
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
        // ignore cleanup issues during heartbeat pruning322
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

const logHeartbeatInterval = setInterval(() => {
  if (logStreamClients.size === 0) {
    return;
  }
  const payload = `event: ping\ndata:${Date.now()}\n\n`;
  for (const client of logStreamClients) {
    try {
      client.write(payload);
    } catch (error) {
      logStreamClients.delete(client);
    }
  }
}, LOG_HEARTBEAT_MS);

logHeartbeatInterval.unref?.();

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

server.listen(PORT, HOST, () => {
  console.log(`Server running on ${HOST}:${PORT}`);
  logEvent("system", "Server started", { host: HOST, port: PORT });
});