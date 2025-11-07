// Updated for TURN server integration
import { API_BASE } from "./endpoints.js";

const REMOTE_CONFIG_ENDPOINT = `${API_BASE}/api/webrtc/config`;
const FETCH_RETRY_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 300;

const STATIC_CONFIG = {
  iceServers: [
    {
      urls: [
        "turns:turn.raptors.life:5349",
        "turn:turn.raptors.life:3478",
      ],
      username: "user",
      credential: "pass",
    },
    {
      urls: ["stun:stun.l.google.com:19302"],
    },
  ],
  fallback: {
    mjpeg: true,
    endpoint: `${API_BASE}/fallback/mjpeg`,
    heartbeatSeconds: 20,
    maxFps: 5,
  },
};

let cachedConfig = null;
let fetchPromise = null;

function cloneIceServers(iceServers) {
  return (iceServers || []).map((entry) => ({
    ...entry,
    urls: Array.isArray(entry.urls) ? [...entry.urls] : entry.urls,
  }));
}

function applyConfigOverrides(base, overrides) {
  const result = {
    iceServers: cloneIceServers(base.iceServers),
    fallback: { ...(base.fallback || {}) },
  };

  if (overrides && typeof overrides === "object") {
    if (Array.isArray(overrides.iceServers) && overrides.iceServers.length) {
      result.iceServers = cloneIceServers(overrides.iceServers);
    }

    if (overrides.fallback && typeof overrides.fallback === "object") {
      result.fallback = {
        ...(base.fallback || {}),
        ...overrides.fallback,
      };
    }
  }

  return result;
}

function cloneConfig(config) {
  return {
    iceServers: cloneIceServers(config.iceServers),
    fallback: { ...(config.fallback || {}) },
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchRemoteConfig() {
  for (let attempt = 1; attempt <= FETCH_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(REMOTE_CONFIG_ENDPOINT, {
        cache: "no-store",
        credentials: "include",
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        console.warn("[ICE] fallback to static", error?.message);
        if (attempt < FETCH_RETRY_ATTEMPTS) {
          await delay(FETCH_RETRY_DELAY_MS);
          continue;
        }
        return null;
      }

      return response.json();
    } catch (error) {
      console.warn("[ICE] fallback to static", error?.message);
      if (attempt < FETCH_RETRY_ATTEMPTS) {
        await delay(FETCH_RETRY_DELAY_MS);
        continue;
      }
      return null;
    }
  }

  return null;
}

export async function getConfig() {
  if (!cachedConfig) {
    cachedConfig = cloneConfig(STATIC_CONFIG);
  }

  if (!fetchPromise) {
    fetchPromise = fetchRemoteConfig().then((remoteConfig) => {
      if (remoteConfig) {
        cachedConfig = applyConfigOverrides(STATIC_CONFIG, remoteConfig);
      }
      return cachedConfig;
    });
  }

  await fetchPromise;
  return cloneConfig(cachedConfig);
}

export function hasWebRTCSupport() {
  return typeof window !== "undefined" && typeof window.RTCPeerConnection === "function";
}

export function createMjpegUrl(nickname) {
  if (!nickname) {
    return "";
  }

  const safeName = encodeURIComponent(nickname);
  return `${API_BASE}/fallback/mjpeg/${safeName}?t=${Date.now()}`;
}
