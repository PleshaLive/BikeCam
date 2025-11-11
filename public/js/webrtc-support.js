// Updated for TURN server integration
import { API_BASE, DEBUG_WEBRTC } from "./endpoints.js";

const REMOTE_CONFIG_ENDPOINT = `${API_BASE}/api/webrtc/config`;
const FETCH_RETRY_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 300;

const STATIC_CONFIG = {
  iceServers: [
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

let resolvedConfigPromise = null;

function cloneIceServers(iceServers) {
  return (iceServers || []).map((entry) => {
    if (!entry || typeof entry !== "object") {
      return null;
    }
    const cloned = { ...entry };
    if (Array.isArray(entry.urls)) {
      cloned.urls = [...entry.urls];
    }
    return cloned;
  }).filter(Boolean);
}

function cloneConfig(config) {
  return {
    iceServers: cloneIceServers(config.iceServers),
    fallback: { ...(config.fallback || {}) },
  };
}

function mergeConfig(remote) {
  const base = cloneConfig(STATIC_CONFIG);
  if (!remote || typeof remote !== "object") {
    return base;
  }

  const merged = {
    iceServers: base.iceServers,
    fallback: { ...base.fallback },
  };

  if (Array.isArray(remote.iceServers) && remote.iceServers.length) {
    merged.iceServers = cloneIceServers(remote.iceServers);
  }

  if (remote.fallback && typeof remote.fallback === "object") {
    merged.fallback = {
      ...merged.fallback,
      ...remote.fallback,
    };
  }

  return merged;
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
        throw new Error(`HTTP ${response.status}`);
      }

      return response.json();
    } catch (error) {
      if (attempt === FETCH_RETRY_ATTEMPTS) {
        console.warn("[ICE] remote config fetch failed", error);
        break;
      }
      await delay(FETCH_RETRY_DELAY_MS * attempt);
    }
  }

  return null;
}

async function resolveConfig() {
  if (!resolvedConfigPromise) {
    resolvedConfigPromise = (async () => {
      const remote = await fetchRemoteConfig();
      if (remote) {
        return mergeConfig(remote);
      }
      return cloneConfig(STATIC_CONFIG);
    })().catch((error) => {
      console.warn("[ICE] using static fallback", error);
      return cloneConfig(STATIC_CONFIG);
    });
  }

  return resolvedConfigPromise;
}

export async function getConfig() {
  const config = await resolveConfig();
  return cloneConfig(config);
}

export function hasWebRTCSupport() {
  return typeof window !== "undefined" && typeof window.RTCPeerConnection === "function";
}

export async function createPeerConnection(forceRelay = false) {
  const config = await resolveConfig();
  const options = {
    iceServers: cloneIceServers(config.iceServers),
  };

  if (forceRelay) {
    options.iceTransportPolicy = "relay";
  }

  const pc = new RTCPeerConnection(options);

  if (DEBUG_WEBRTC) {
    const debugLabel = forceRelay ? "[WebRTC relay]" : "[WebRTC auto]";
    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        const { candidate } = event;
        console.debug(
          `${debugLabel} ICE candidate`,
          candidate?.type || "unknown",
          candidate?.protocol || "",
          candidate?.candidate || ""
        );
      } else {
        console.debug(`${debugLabel} ICE gathering complete`);
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      console.debug(`${debugLabel} connection state`, pc.connectionState);
    });
  }

  return pc;
}

export function createMjpegUrl(nickname) {
  if (!nickname) {
    return "";
  }

  const safeName = encodeURIComponent(nickname);
  return `${API_BASE}/fallback/mjpeg/${safeName}?t=${Date.now()}`;
}
