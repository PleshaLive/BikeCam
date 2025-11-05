// Updated for TURN server integration
import { API_BASE } from "./endpoints.js";

const STATIC_CONFIG = {
  iceServers: [
    {
      urls: [
        "turn:turn.raptors.life:3478?transport=udp",
        "turn:turn.raptors.life:3478?transport=tcp",
        "turns:turn.raptors.life:5349",
      ],
      username: "streamer",
      credential: "VeryStrongPass123",
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

async function fetchRemoteConfig() {
  try {
    const response = await fetch(`${API_BASE}/api/webrtc/config`, {
      cache: "no-store",
      credentials: "include",
    });
    if (!response.ok) {
      return applyConfigOverrides(STATIC_CONFIG, null);
    }

    const data = await response.json();
    return applyConfigOverrides(STATIC_CONFIG, data);
  } catch (error) {
    return applyConfigOverrides(STATIC_CONFIG, null);
  }
}

function cloneConfig(config) {
  return {
    iceServers: cloneIceServers(config.iceServers),
    fallback: { ...(config.fallback || {}) },
  };
}

export async function getConfig() {
  if (!cachedConfig) {
    cachedConfig = applyConfigOverrides(STATIC_CONFIG, null);
    if (!fetchPromise) {
      fetchPromise = fetchRemoteConfig()
        .then((config) => {
          cachedConfig = config;
          return config;
        })
        .catch(() => cachedConfig);
    }

    await fetchPromise;
  }

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
  const endpoint = cachedConfig?.fallback?.endpoint || STATIC_CONFIG.fallback.endpoint;
  return `${endpoint.replace(/\/$/, "")}/${safeName}?t=${Date.now()}`;
}
