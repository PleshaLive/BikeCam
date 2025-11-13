import { buildApiUrl, getTurnAdminKey, setTurnAdminKey } from "../shared/env.js";

const TURN_ENDPOINT = "/api/webrtc/turn-creds";
const CACHE_SKEW_MS = 30_000;
const FALLBACK_TTL_SEC = 60;

let cachedConfig = null;
let cacheExpiresAt = 0;
let inflightPromise = null;

function normalizeIceServer(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const urls = entry.urls;
  if (!urls || (Array.isArray(urls) && urls.length === 0)) {
    return null;
  }
  const normalized = {
    urls,
  };
  if (typeof entry.username === "string" && entry.username.trim()) {
    normalized.username = entry.username;
  }
  if (typeof entry.credential === "string" && entry.credential.trim()) {
    normalized.credential = entry.credential;
  }
  return normalized;
}

function cloneConfig(config) {
  if (!config) {
    return null;
  }
  return {
    iceServers: config.iceServers.map((server) => ({
      urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
      username: server.username,
      credential: server.credential,
    })),
    ttlSec: config.ttlSec,
    fetchedAt: config.fetchedAt,
    expiresAt: config.expiresAt,
    raw: config.raw,
    publicIp: config.publicIp,
  };
}

async function requestTurnConfig() {
  const key = getTurnAdminKey();
  if (!key) {
    throw new Error("TURN admin key is missing. Provide ?turnKey=... or configure TURN_ADMIN_KEY.");
  }

  const url = new URL(buildApiUrl(TURN_ENDPOINT));
  url.searchParams.set("key", key);
  url.searchParams.set("t", Date.now().toString());

  const response = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch TURN creds: HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload && typeof payload.adminKey === "string" && payload.adminKey.trim()) {
    setTurnAdminKey(payload.adminKey.trim());
  }

  const rawUrls = Array.isArray(payload?.urls) ? payload.urls : payload?.urls ? [payload.urls] : [];
  const iceServers = Array.isArray(payload?.iceServers) && payload.iceServers.length
    ? payload.iceServers.map(normalizeIceServer).filter(Boolean)
    : rawUrls.length && payload?.username && payload?.credential
      ? [
          {
            urls: rawUrls,
            username: payload.username,
            credential: payload.credential,
          },
        ]
      : [];

  const now = Date.now();
  const ttlSec = Number.isFinite(Number(payload?.ttlSec)) && Number(payload.ttlSec) > 0 ? Number(payload.ttlSec) : FALLBACK_TTL_SEC;
  const expiresAt = now + ttlSec * 1_000;

  return {
    iceServers,
    ttlSec,
    fetchedAt: now,
    expiresAt,
    raw: payload,
    publicIp: typeof payload?.publicIp === "string" ? payload.publicIp : null,
  };
}

export async function getTurnConfig(options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const now = Date.now();

  if (!forceRefresh && cachedConfig && cacheExpiresAt > now) {
    return cloneConfig(cachedConfig);
  }

  if (!inflightPromise) {
    inflightPromise = (async () => {
      try {
        const config = await requestTurnConfig();
        const updatedNow = Date.now();
        cachedConfig = config;
        cacheExpiresAt = Math.max(config.expiresAt - CACHE_SKEW_MS, updatedNow + 5_000);
        return config;
      } finally {
        inflightPromise = null;
      }
    })();
  }

  try {
    const config = await inflightPromise;
    return cloneConfig(config);
  } catch (error) {
    inflightPromise = null;
    if (cachedConfig) {
      console.warn("[turn-config] using cached TURN credentials after fetch failure", error);
      return cloneConfig(cachedConfig);
    }
    throw error;
  }
}

export function invalidateTurnConfigCache() {
  cachedConfig = null;
  cacheExpiresAt = 0;
  inflightPromise = null;
}

export function maskIceServers(servers) {
  return (servers || []).map((server) => {
    if (!server) {
      return server;
    }
    const clone = { ...server };
    if (Array.isArray(clone.urls)) {
      clone.urls = [...clone.urls];
    }
    if (typeof clone.username === "string" && clone.username.length > 8) {
      clone.username = `${clone.username.slice(0, 4)}…${clone.username.slice(-4)}`;
    } else if (clone.username) {
      clone.username = "***";
    }
    if (clone.credential) {
      clone.credential = "***masked***";
    }
    return clone;
  });
}
