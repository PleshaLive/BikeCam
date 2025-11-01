(function () {
  const defaultConfig = {
    iceServers: [
      {
        urls: ["stun:stun.l.google.com:19302"],
      },
    ],
    fallback: {
      mjpeg: true,
      endpoint: "/fallback/mjpeg",
      heartbeatSeconds: 20,
      maxFps: 5,
    },
  };

  let cachedConfig = null;
  let inflightPromise = null;

  function cloneIceServers(list) {
    if (!Array.isArray(list)) {
      return [];
    }
    return list.map((entry) => {
      const clone = { ...entry };
      if (Array.isArray(entry.urls)) {
        clone.urls = [...entry.urls];
      }
      return clone;
    });
  }

  function cloneConfig(config) {
    return {
      iceServers: cloneIceServers(config?.iceServers) || [],
      fallback: { ...(config?.fallback || {}) },
    };
  }

  function mergeConfig(base, overrides) {
    const result = cloneConfig(base || defaultConfig);

    if (overrides) {
      if (Array.isArray(overrides.iceServers) && overrides.iceServers.length) {
        result.iceServers = cloneIceServers(overrides.iceServers);
      }

      if (overrides.fallback && typeof overrides.fallback === "object") {
        result.fallback = {
          ...result.fallback,
          ...overrides.fallback,
        };
      }
    }

    return result;
  }

  async function requestRemoteConfig() {
    try {
      const response = await fetch("/api/webrtc/config", { cache: "no-store" });
      if (!response.ok) {
        return mergeConfig(defaultConfig, null);
      }
      const data = await response.json();
      return mergeConfig(defaultConfig, data);
    } catch (error) {
      return mergeConfig(defaultConfig, null);
    }
  }

  async function resolveConfig() {
    if (cachedConfig) {
      return cloneConfig(cachedConfig);
    }

    if (!inflightPromise) {
      inflightPromise = requestRemoteConfig()
        .catch(() => mergeConfig(defaultConfig, null))
        .then((config) => {
          cachedConfig = config;
          inflightPromise = null;
          return config;
        });
    }

    const config = await inflightPromise;
    return cloneConfig(config);
  }

  function currentFallbackEndpoint() {
    const endpoint = cachedConfig?.fallback?.endpoint || defaultConfig.fallback.endpoint;
    return typeof endpoint === "string" && endpoint.length ? endpoint : defaultConfig.fallback.endpoint;
  }

  window.WebRTC_SUPPORT = {
    async getConfig() {
      return resolveConfig();
    },
    hasWebRTCSupport() {
      return typeof window !== "undefined" && typeof window.RTCPeerConnection === "function";
    },
    createMjpegUrl(nickname) {
      if (!nickname) {
        return "";
      }
      const basePath = currentFallbackEndpoint().replace(/\/$/, "");
      const safeName = encodeURIComponent(nickname);
      return `${basePath}/${safeName}?t=${Date.now()}`;
    },
  };
})();
