import { parseCandidate } from "./utils.js";

const QUALITY_PRESETS = {
  auto: {
    degradationPreference: "balanced",
    contentHint: "motion",
    scale: 1,
  },
  low: {
    degradationPreference: "maintain-framerate",
    contentHint: "motion",
    scale: 0.6,
  },
  mid: {
    degradationPreference: "balanced",
    contentHint: "motion",
    scale: 0.82,
  },
  high: {
    degradationPreference: "maintain-resolution",
    contentHint: "detail",
    scale: 1,
  },
};

function describeCandidateType(candidate) {
  if (!candidate) {
    return null;
  }
  const parsed = typeof candidate === "string" ? parseCandidate(candidate) : candidate;
  return parsed?.type || null;
}

function ensureRecvTransceivers(pc) {
  if (!pc || typeof pc.addTransceiver !== "function") {
    return;
  }
  const presentKinds = new Set();
  if (typeof pc.getTransceivers === "function") {
    pc.getTransceivers().forEach((transceiver) => {
      const kind = transceiver?.receiver?.track?.kind;
      if (kind) {
        presentKinds.add(kind);
      }
    });
  }
  if (!presentKinds.has("video")) {
    pc.addTransceiver("video", { direction: "recvonly" });
  }
  if (!presentKinds.has("audio")) {
    pc.addTransceiver("audio", { direction: "recvonly" });
  }
}

export function createReceiverPc({
  iceServers = [],
  turnOnly = false,
  tcpOnly = false,
  logger = () => {},
  onTrack,
  onIceCandidate,
  onConnectionStateChange,
  onIceStateChange,
} = {}) {
  const config = {
    iceServers: Array.isArray(iceServers) ? iceServers : [],
    bundlePolicy: "balanced",
    sdpSemantics: "unified-plan",
  };
  if (tcpOnly && config.iceServers.length) {
    config.iceServers = config.iceServers.map((entry) => {
      if (!entry) {
        return entry;
      }
      const urls = Array.isArray(entry.urls) ? entry.urls : entry.urls ? [entry.urls] : [];
      const filtered = urls.filter((url) => /transport=tcp/i.test(url));
      if (!filtered.length) {
        return entry;
      }
      return {
        ...entry,
        urls: filtered.length === 1 ? filtered[0] : filtered,
      };
    });
  }
  const pc = new RTCPeerConnection(config);
  ensureRecvTransceivers(pc);

  let enforceRelay = Boolean(turnOnly);
  let localCandidateSeen = null;
  let remoteCandidateSeen = null;

  const state = {
    quality: "auto",
    overlayScale: 1,
  };

  const guardRelayCandidate = (candidate, direction) => {
    if (!candidate) {
      return true;
    }
    const raw = typeof candidate === "string" ? candidate : candidate.candidate;
    if (typeof raw !== "string" || !raw) {
      return true;
    }
    const type = describeCandidateType(raw);
    if (direction === "local") {
      localCandidateSeen = type || localCandidateSeen;
    } else {
      remoteCandidateSeen = type || remoteCandidateSeen;
    }
    if (!enforceRelay) {
      return true;
    }
    if (!type) {
      return true;
    }
    if (type === "relay") {
      return true;
    }
    logger("candidate-filter", { direction, type, raw });
    return false;
  };

  pc.addEventListener("icecandidate", (event) => {
    if (!event.candidate) {
      if (typeof onIceCandidate === "function") {
        onIceCandidate(null);
      }
      return;
    }
    if (!guardRelayCandidate(event.candidate, "local")) {
      return;
    }
    if (typeof onIceCandidate === "function") {
      onIceCandidate(event.candidate);
    }
  });

  pc.addEventListener("iceconnectionstatechange", () => {
    if (typeof onIceStateChange === "function") {
      onIceStateChange(pc.iceConnectionState);
    }
  });

  pc.addEventListener("connectionstatechange", () => {
    if (typeof onConnectionStateChange === "function") {
      onConnectionStateChange(pc.connectionState);
    }
  });

  pc.addEventListener("track", (event) => {
    if (typeof onTrack === "function") {
      onTrack(event);
    }
  });

  const qualityTargets = new Map();

  function applyQualityPreset(presetKey, videoEl) {
    const preset = QUALITY_PRESETS[presetKey] || QUALITY_PRESETS.auto;
    state.quality = presetKey in QUALITY_PRESETS ? presetKey : "auto";
    state.overlayScale = preset.scale || 1;
    const transceivers = typeof pc.getTransceivers === "function" ? pc.getTransceivers() : [];
    transceivers.forEach((transceiver) => {
      if (transceiver?.receiver?.track?.kind !== "video") {
        return;
      }
      try {
        if (typeof transceiver.setDegradationPreference === "function" && preset.degradationPreference) {
          transceiver.setDegradationPreference(preset.degradationPreference);
        }
      } catch (error) {
        // ignore unsupported APIs
      }
      if (transceiver.receiver && preset.contentHint && "contentHint" in transceiver.receiver) {
        try {
          transceiver.receiver.contentHint = preset.contentHint;
        } catch (error) {
          // ignore unsupported contentHint
        }
      }
      if (transceiver.receiver?.track && preset.contentHint && "contentHint" in transceiver.receiver.track) {
        try {
          transceiver.receiver.track.contentHint = preset.contentHint;
        } catch (error) {
          // ignore unsupported contentHint on track
        }
      }
      qualityTargets.set(transceiver.mid || transceiver, preset);
    });
    if (videoEl && preset.scale && preset.scale !== 1) {
      videoEl.style.transform = `scale(${preset.scale})`;
    } else if (videoEl) {
      videoEl.style.transform = "";
    }
    return presetKey;
  }

  function requestKeyframe() {
    if (typeof pc.getReceivers !== "function") {
      return false;
    }
    let requested = false;
    pc.getReceivers().forEach((receiver) => {
      if (receiver.track?.kind !== "video") {
        return;
      }
      if (typeof receiver.requestKeyFrame === "function") {
        try {
          receiver.requestKeyFrame();
          requested = true;
        } catch (error) {
          // ignore request failures
        }
      }
    });
    return requested;
  }

  function setPaused(paused) {
    if (typeof pc.getTransceivers !== "function") {
      return;
    }
    pc.getTransceivers().forEach((transceiver) => {
      if (!transceiver || transceiver.receiver?.track?.kind !== "video") {
        return;
      }
      try {
        transceiver.direction = paused ? "inactive" : "recvonly";
      } catch (error) {
        // ignore unsupported direction changes
      }
    });
  }

  async function updateIceServers(iceServersNext) {
    try {
      pc.setConfiguration({
        iceServers: Array.isArray(iceServersNext) ? iceServersNext : [],
        bundlePolicy: "balanced",
        sdpSemantics: "unified-plan",
      });
    } catch (error) {
      logger("config-error", { message: error?.message || String(error) });
    }
  }

  function setTurnOnly(enabled) {
    enforceRelay = Boolean(enabled);
    return enforceRelay;
  }

  async function applySimulcastPreference(description, rid) {
    if (!description || !description.sdp) {
      return description;
    }
    if (!rid) {
      return description;
    }
    const sdp = description.sdp.split(/\r?\n/);
    const filtered = [];
    let insideVideo = false;
    for (const line of sdp) {
      if (/^m=video /i.test(line)) {
        insideVideo = true;
        filtered.push(line);
        continue;
      }
      if (insideVideo && /^m=/.test(line)) {
        insideVideo = false;
      }
      if (insideVideo && /^a=rid:/i.test(line)) {
        const ridMatch = line.match(/^a=rid:([^\s]+)/i);
        if (ridMatch && ridMatch[1] !== rid) {
          continue;
        }
      }
      if (insideVideo && /^a=simulcast:/i.test(line)) {
        const parts = line.split(" ");
        if (parts.length >= 2) {
          const streams = parts.slice(1).join(" ");
          const rewritten = streams.replace(/([;,])\s*/g, "$1");
          const candidates = rewritten.split(/[,;]/).filter(Boolean);
          const next = candidates.filter((entry) => entry === rid || entry.endsWith(`:${rid}`));
          if (next.length) {
            filtered.push(`a=simulcast:recv ${next.join(",")}`);
            continue;
          }
        }
      }
      filtered.push(line);
    }
    return {
      type: description.type,
      sdp: filtered.join("\r\n"),
    };
  }

  function getState() {
    return {
      quality: state.quality,
      turnOnly: enforceRelay,
      localCandidate: localCandidateSeen,
      remoteCandidate: remoteCandidateSeen,
    };
  }

  return {
    pc,
    applyQualityPreset,
    requestKeyframe,
    setPaused,
    updateIceServers,
    setTurnOnly,
    applySimulcastPreference,
    getState,
  };
}

export function listQualityPresets() {
  return Object.keys(QUALITY_PRESETS);
}

export { QUALITY_PRESETS };
