(function () {
  const defaultConfig = {
    iceServers: [
      {
        urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"],
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
  let fetchPromise = null;

  function cloneIceServers(iceServers) {
    return iceServers.map((entry) => ({ ...entry, urls: Array.isArray(entry.urls) ? [...entry.urls] : entry.urls }));
  }

  function applyConfigOverrides(base, overrides) {
    const result = {
      iceServers: cloneIceServers(base.iceServers || []),
      fallback: { ...(base.fallback || {}) },
    };

    if (overrides) {
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

  async function fetchConfig() {
    if (cachedConfig) {
      return cachedConfig;
    }

    if (!fetchPromise) {
      fetchPromise = (async () => {
        try {
          const response = await fetch("/api/webrtc/config", { cache: "no-store" });
          if (response.ok) {
            const data = await response.json();
            cachedConfig = applyConfigOverrides(defaultConfig, data);
            return cachedConfig;
          }
        } catch (error) {
          // ignore fetch errors, fall back to defaults
        }

        cachedConfig = applyConfigOverrides(defaultConfig, null);
        return cachedConfig;
      })();
    }

    return fetchPromise;
  }

  function cloneConfig(config) {
    return {
      iceServers: cloneIceServers(config.iceServers || []),
      fallback: { ...(config.fallback || {}) },
    };
  }

  function createMjpegUrl(nickname, fallbackConfig) {
    if (!nickname) {
      return "";
    }

    const safeName = encodeURIComponent(nickname);
    const endpoint = fallbackConfig?.endpoint || defaultConfig.fallback.endpoint;
    return `${endpoint.replace(/\/$/, "")}/${safeName}?t=${Date.now()}`;
  }

  window.WebRTC_SUPPORT = {
    async getConfig() {
      const config = await fetchConfig();
      return cloneConfig(config);
    },
    hasWebRTCSupport() {
      return typeof window !== "undefined" && typeof window.RTCPeerConnection === "function";
    },
    createMjpegUrl(nickname) {
      return createMjpegUrl(nickname, cachedConfig || defaultConfig);
    },
  };
})();
