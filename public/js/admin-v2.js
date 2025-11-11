import { API_BASE, WS_BASE } from "./endpoints.js";
import { createConnection, getConfig } from "./webrtc-support.js";

const FORCE_TURN_DEFAULT = true;
window.FORCE_TURN_DEFAULT = FORCE_TURN_DEFAULT;

const FORCE_TURN_STORAGE_KEY = "adminV2ForceTurn";
const BITRATE_OPTIONS = [300, 600, 1200, 2500];
const STATS_INTERVAL_MS = 2_000;
const ZERO_DATA_THRESHOLD_MS = 10_000;
const TOKEN_REFRESH_INTERVAL_MS = 25 * 60 * 1_000;
const ROSTER_REFRESH_MS = 30_000;
const MAX_DEBUG_ENTRIES = 120;

const state = {
  forceTurnOnly: true,
  globalMaxBitrate: 1_200,
  globalMute: false,
  globalPaused: false,
  sessions: new Map(),
  knownPublishers: new Map(),
  roster: new Map(),
  ws: null,
  wsReady: false,
  viewerRegistered: false,
  configTtlSec: null,
  lastConfigRefresh: 0,
  tokenTimer: null,
  rosterTimer: null,
  debugEnabled: false,
  debugEntries: [],
};

const dom = {
  summaryBar: document.getElementById("summaryBar"),
  tokenIndicator: document.getElementById("tokenIndicator"),
  tileGrid: document.getElementById("tileGrid"),
  emptyState: document.getElementById("emptyState"),
  muteAllBtn: document.getElementById("muteAllBtn"),
  unmuteAllBtn: document.getElementById("unmuteAllBtn"),
  freezeAllBtn: document.getElementById("freezeAllBtn"),
  resumeAllBtn: document.getElementById("resumeAllBtn"),
  maxBitrateSelect: document.getElementById("maxBitrateSelect"),
  forceTurnToggle: document.getElementById("forceTurnToggle"),
  refreshTurnBtn: document.getElementById("refreshTurnBtn"),
  reloadRosterBtn: document.getElementById("reloadRosterBtn"),
  debugToggleBtn: document.getElementById("debugToggleBtn"),
  debugPanel: document.getElementById("debugPanel"),
  debugOutput: document.getElementById("debugOutput"),
};

dom.summaryCards = {
  active: dom.summaryBar?.children?.[0]?.querySelector("strong") || null,
  bitrate: dom.summaryBar?.children?.[1]?.querySelector("strong") || null,
  rtt: dom.summaryBar?.children?.[2]?.querySelector("strong") || null,
  refreshed: dom.summaryBar?.children?.[3]?.querySelector("strong") || null,
};

(function init() {
  restoreForceTurnPreference();
  bindGlobalEvents();
  loadRoster().catch(() => {});
  primeTurnConfig().catch(() => {});
  connectWebSocket();
  scheduleTokenRefresh();
  scheduleRosterRefresh();
  updateSummary();
  updateEmptyState();
  window.addEventListener("beforeunload", cleanupAll);
})();

function bindGlobalEvents() {
  dom.muteAllBtn?.addEventListener("click", () => {
    state.globalMute = true;
    state.sessions.forEach((session) => setSessionMuted(session, true));
  });
  dom.unmuteAllBtn?.addEventListener("click", () => {
    state.globalMute = false;
    state.sessions.forEach((session) => setSessionMuted(session, false));
  });
  dom.freezeAllBtn?.addEventListener("click", () => {
    state.globalPaused = true;
    state.sessions.forEach((session) => setSessionPaused(session, true));
  });
  dom.resumeAllBtn?.addEventListener("click", () => {
    state.globalPaused = false;
    state.sessions.forEach((session) => setSessionPaused(session, false));
  });
  dom.maxBitrateSelect?.addEventListener("change", (event) => {
    const value = Number.parseInt(event.target.value, 10);
    if (BITRATE_OPTIONS.includes(value)) {
      state.globalMaxBitrate = value;
      state.sessions.forEach((session) => {
        session.maxBitrate = value;
        applyMaxBitrate(session).catch(() => {});
        if (session.dom?.bitrateSelect) {
          session.dom.bitrateSelect.value = String(value);
        }
      });
    }
  });
  dom.forceTurnToggle?.addEventListener("change", (event) => {
    const enabled = Boolean(event.target.checked);
    applyForceTurnPreference(enabled);
  });
  dom.refreshTurnBtn?.addEventListener("click", () => {
    performTokenRefresh(true).catch(() => {});
  });
  dom.reloadRosterBtn?.addEventListener("click", () => {
    loadRoster(true).catch(() => {});
  });
  dom.debugToggleBtn?.addEventListener("click", toggleDebugPanel);
}

function restoreForceTurnPreference() {
  let stored = null;
  try {
    stored = localStorage.getItem(FORCE_TURN_STORAGE_KEY);
  } catch (error) {
    stored = null;
  }
  state.forceTurnOnly = stored === null ? FORCE_TURN_DEFAULT : stored === "true";
  if (dom.forceTurnToggle) {
    dom.forceTurnToggle.checked = state.forceTurnOnly;
  }
}

function persistForceTurnPreference() {
  try {
    localStorage.setItem(FORCE_TURN_STORAGE_KEY, state.forceTurnOnly ? "true" : "false");
  } catch (error) {
    // ignore storage issues
  }
}

async function primeTurnConfig() {
  try {
    const config = await getConfig(state.forceTurnOnly);
    state.lastConfigRefresh = Date.now();
    state.configTtlSec = config?.ttlSec || null;
    updateTokenIndicator();
    updateSummary();
    console.log("[admin-v2] TURN token primed", config?.ttlSec || "n/a");
  } catch (error) {
    logDebug("Failed to prime TURN config", error?.message || String(error));
    console.error("[admin-v2] initial TURN config failed", error);
  }
}

function scheduleTokenRefresh() {
  if (state.tokenTimer) {
    clearInterval(state.tokenTimer);
    state.tokenTimer = null;
  }
  state.tokenTimer = setInterval(() => {
    performTokenRefresh(false).catch(() => {});
  }, TOKEN_REFRESH_INTERVAL_MS);
}

function scheduleRosterRefresh() {
  if (state.rosterTimer) {
    clearInterval(state.rosterTimer);
    state.rosterTimer = null;
  }
  state.rosterTimer = setInterval(() => {
    loadRoster().catch(() => {});
  }, ROSTER_REFRESH_MS);
}

async function loadRoster(explicit = false) {
  try {
    const [cameraPayload, gsiPayload] = await Promise.all([
      fetchJson("/api/admin/cameras", { timeoutMs: 10_000 }),
      fetchJson("/api/gsi/state", { timeoutMs: 10_000 }).catch(() => null),
    ]);

    const roster = new Map();
    if (Array.isArray(cameraPayload?.cameras)) {
      cameraPayload.cameras.forEach((camera) => {
        if (!camera?.nickname) {
          return;
        }
        const key = normalizeKey(camera.nickname);
        if (!key) {
          return;
        }
        roster.set(key, {
          nickname: camera.nickname,
          team: camera.team || "",
          slot: camera.observerSlot || camera.slot || "",
        });
      });
    }

    const players = gsiPayload?.players || gsiPayload?.allplayers || null;
    if (players && typeof players === "object") {
      Object.values(players).forEach((player) => {
        const name = player?.name || player?.player_name || "";
        const key = normalizeKey(name);
        if (!key) {
          return;
        }
        const existing = roster.get(key) || {};
        roster.set(key, {
          nickname: existing.nickname || name,
          team: (player.team || existing.team || "").toUpperCase(),
          slot: Number.isFinite(player.observer_slot) ? player.observer_slot : existing.slot || "",
        });
      });
    }

    state.roster = roster;
    state.sessions.forEach(updateTileMeta);
    if (explicit) {
      logDebug("Roster refreshed", { size: roster.size });
    }
  } catch (error) {
    logDebug("Failed to load roster", error?.message || String(error));
    if (explicit) {
      console.warn("[admin-v2] roster refresh failed", error);
    }
  }
}

async function performTokenRefresh(manual) {
  try {
    const config = await getConfig(state.forceTurnOnly);
    state.lastConfigRefresh = Date.now();
    state.configTtlSec = config?.ttlSec || state.configTtlSec;
    updateTokenIndicator();
    console.log(`[admin-v2] TURN token refreshed${manual ? " (manual)" : ""}`);
    logDebug("TURN config refreshed", { ttlSec: config?.ttlSec || null, manual });

    const promises = [];
    state.sessions.forEach((session) => {
      if (session.connection) {
        promises.push(session.connection.refreshIceServers(state.forceTurnOnly));
      }
    });
    await Promise.all(promises);

    const renegotiations = [];
    state.sessions.forEach((session) => {
      if (session.pc) {
        renegotiations.push(renegotiateSession(session, manual ? "manual-token" : "token-refresh"));
      }
    });
    await Promise.allSettled(renegotiations);
    updateSummary();
  } catch (error) {
    updateTokenIndicator(error?.message || "Token refresh failed", "danger");
    logDebug("TURN refresh failed", error?.message || String(error));
    console.error("[admin-v2] TURN token refresh failed", error);
  }
}

function applyForceTurnPreference(enabled) {
  state.forceTurnOnly = Boolean(enabled);
  if (dom.forceTurnToggle) {
    dom.forceTurnToggle.checked = state.forceTurnOnly;
  }
  persistForceTurnPreference();
  updateTokenIndicator();
  const reason = state.forceTurnOnly ? "force-turn-enabled" : "force-turn-disabled";
  state.sessions.forEach((session) => {
    setSessionCandidateSummary(session, "Applying config…", state.forceTurnOnly ? "badge-ok" : "");
    if (session.connection) {
      session.connection.refreshIceServers(state.forceTurnOnly).catch(() => {});
    }
    renegotiateSession(session, reason).catch(() => {});
  });
}

function connectWebSocket() {
  if (state.ws) {
    try {
      state.ws.close();
    } catch (error) {
      // ignore
    }
    state.ws = null;
  }

  const socket = new WebSocket(WS_BASE);
  state.ws = socket;

  socket.addEventListener("open", () => {
    state.wsReady = true;
    state.viewerRegistered = false;
    sendSignal({ type: "HELLO", role: "viewer" });
    logDebug("Signal socket connected");
    console.log("[admin-v2] signaling connected");
  });

  socket.addEventListener("message", (event) => {
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    handleSignal(payload);
  });

  socket.addEventListener("close", () => {
    state.wsReady = false;
    state.viewerRegistered = false;
    logDebug("Signal socket closed, retrying soon");
    console.warn("[admin-v2] signaling closed, retrying");
    setTimeout(connectWebSocket, 2_000);
    state.sessions.forEach((session) => {
      setSessionStatus(session, "Reconnecting", "badge-warn");
      stopPeer(session);
    });
  });

  socket.addEventListener("error", (event) => {
    logDebug("Signal socket error", event?.message || "error");
    console.error("[admin-v2] signaling error", event);
  });
}

function sendSignal(message) {
  if (!state.ws || !state.wsReady) {
    return;
  }
  try {
    state.ws.send(JSON.stringify(message));
  } catch (error) {
    logDebug("Failed to send signal", error?.message || String(error));
  }
}

function handleSignal(payload) {
  switch (payload?.type) {
    case "WELCOME":
      state.viewerRegistered = true;
      handleActivePublishers(payload.publishers || []);
      break;
    case "VIEWER_REGISTERED":
      state.viewerRegistered = true;
      break;
    case "ACTIVE_PUBLISHERS":
      handleActivePublishers(payload.publishers || []);
      break;
    case "SIGNAL_PUBLISHER_ANSWER":
      handlePublisherAnswer(payload);
      break;
    case "SIGNAL_PUBLISHER_CANDIDATE":
      handlePublisherCandidate(payload);
      break;
    case "STREAM_UNAVAILABLE":
    case "STREAM_ENDED":
      handleStreamUnavailable(payload);
      break;
    default:
      break;
  }
}

function handleActivePublishers(list) {
  const incoming = new Map();
  if (Array.isArray(list)) {
    list.forEach((name) => {
      const normalized = normalizeNickname(name);
      const key = normalizeKey(normalized);
      if (normalized && key) {
        incoming.set(key, normalized);
      }
    });
  }

  incoming.forEach((nickname, key) => {
    state.knownPublishers.set(key, nickname);
    const session = ensureSession(key, nickname);
    if (!session.pc && !session.connecting) {
      startSession(session, "initial").catch(() => {});
    }
  });

  state.sessions.forEach((session, key) => {
    if (!incoming.has(key)) {
      removeSession(session);
    }
  });

  updateEmptyState();
}

function handlePublisherAnswer(payload) {
  const nickname = normalizeNickname(payload?.nickname);
  const key = normalizeKey(nickname);
  if (!key) {
    return;
  }
  const session = state.sessions.get(key);
  if (!session || !session.pc || session.connectionId !== payload?.connectionId) {
    return;
  }
  session.pc.setRemoteDescription(payload.sdp).catch((error) => {
    session.lastError = error?.message || String(error);
    updateTileFooter(session);
    fullReconnectSession(session, "answer-error").catch(() => {});
  });
}

async function handlePublisherCandidate(payload) {
  const nickname = normalizeNickname(payload?.nickname);
  const key = normalizeKey(nickname);
  if (!key) {
    return;
  }
  const session = state.sessions.get(key);
  if (!session || !session.pc || session.connectionId !== payload?.connectionId) {
    return;
  }
  if (!payload?.candidate) {
    try {
      await session.pc.addIceCandidate(null);
    } catch (error) {
      logDebug("End-of-candidates failed", error?.message || String(error));
    }
    return;
  }
  const candidateType = extractCandidateType(payload.candidate.candidate || "");
  if (state.forceTurnOnly && candidateType && candidateType !== "relay") {
    logDebug("Dropped remote candidate", { nickname, candidateType });
    return;
  }
  try {
    await session.pc.addIceCandidate(payload.candidate);
  } catch (error) {
    session.lastError = error?.message || String(error);
    updateTileFooter(session);
  }
}

function handleStreamUnavailable(payload) {
  const nickname = normalizeNickname(payload?.nickname);
  const key = normalizeKey(nickname);
  if (!key) {
    return;
  }
  const session = state.sessions.get(key);
  if (!session) {
    return;
  }
  fullReconnectSession(session, "stream-unavailable").catch(() => {});
}

function normalizeNickname(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeKey(value) {
  if (!value) {
    return "";
  }
  return value.replace(/\s+/g, "").toLowerCase();
}

function ensureSession(key, nickname) {
  let session = state.sessions.get(key);
  if (!session) {
    session = {
      key,
      nickname,
      connectionId: null,
      connection: null,
      pc: null,
      stream: null,
      connectTimer: null,
      statsTimer: null,
      connecting: false,
      connected: false,
      audioMuted: state.globalMute,
      videoPaused: state.globalPaused,
      maxBitrate: state.globalMaxBitrate,
      zeroDataSince: null,
      lastStatsSample: null,
      lastError: "",
      lastIceState: "new",
      renegotiating: false,
      pendingRenegotiation: null,
      dom: null,
      debug: {
        lastLocalCandidate: null,
        lastRemoteCandidate: null,
        selectedPair: null,
      },
    };
    state.sessions.set(key, session);
    createTile(session);
  } else if (nickname && session.nickname !== nickname) {
    session.nickname = nickname;
    updateTileMeta(session);
  }
  return session;
}

async function startSession(session, reason) {
  if (!state.viewerRegistered || session.connecting) {
    return;
  }
  session.connecting = true;
  session.connectionId = createConnectionId();
  setSessionStatus(session, "Connecting", "badge-warn");
  session.lastError = "";
  updateTileFooter(session);

  try {
    session.connection = await createConnection({
      forceTurnOnly: state.forceTurnOnly,
      label: session.nickname,
      onReconnectNeeded: () => {
        renegotiateSession(session, "managed-reconnect").catch(() => {});
      },
      onStateChange: (evt) => {
        if (evt?.type === "ice") {
          session.lastIceState = evt.state;
          updateTileFooter(session);
          if (evt.state === "failed" || evt.state === "disconnected") {
            renegotiateSession(session, `ice-${evt.state}`).catch(() => {});
          }
        }
      },
    });
  } catch (error) {
    session.connecting = false;
    session.lastError = error?.message || String(error);
    setSessionStatus(session, "Failed", "badge-fail");
    updateTileFooter(session);
    scheduleReconnect(session, reason);
    return;
  }

  session.pc = session.connection.pc;
  applyMaxBitrate(session).catch(() => {});

  session.pc.addEventListener("icecandidate", (event) => {
    if (!event.candidate) {
      return;
    }
    const candidate = event.candidate.candidate || "";
    const candidateType = extractCandidateType(candidate);
    if (candidate.includes(".local")) {
      return;
    }
    if (state.forceTurnOnly && candidateType && candidateType !== "relay") {
      logDebug("Dropped local candidate", { nickname: session.nickname, candidateType });
      return;
    }
    session.debug.lastLocalCandidate = candidate;
    sendSignal({
      type: "VIEWER_ICE",
      nickname: session.nickname,
      connectionId: session.connectionId,
      candidate: event.candidate,
    });
  });

  session.pc.addEventListener("iceconnectionstatechange", () => {
    const stateName = session.pc.iceConnectionState;
    session.lastIceState = stateName;
    if (session.dom?.iceState) {
      session.dom.iceState.textContent = `State: ${stateName}`;
    }
    updateTileFooter(session);
    console.log(`[admin-v2] ${session.nickname} ice=${stateName}`);
    if (stateName === "failed") {
      renegotiateSession(session, "ice-failed").catch(() => {});
    } else if (stateName === "disconnected") {
      session.zeroDataSince = Date.now();
    }
  });

  session.pc.addEventListener("connectionstatechange", () => {
    const pcState = session.pc.connectionState;
    session.connected = pcState === "connected";
    if (pcState === "connected") {
      setSessionStatus(session, "Connected", "badge-ok");
    } else if (pcState === "failed") {
      setSessionStatus(session, "Failed", "badge-fail");
      fullReconnectSession(session, "pc-failed").catch(() => {});
    } else if (pcState === "disconnected") {
      setSessionStatus(session, "Disconnected", "badge-warn");
      renegotiateSession(session, "pc-disconnected").catch(() => {});
    }
    updateTileFooter(session);
  });

  session.pc.addEventListener("track", (event) => {
    const [stream] = event.streams || [];
    if (!stream) {
      return;
    }
    session.stream = stream;
    if (session.dom?.video) {
      session.dom.video.srcObject = stream;
      if (!session.audioMuted) {
        session.dom.video.muted = false;
        session.dom.video.play().catch(() => {});
      }
    }
    applyMuteStateToStream(session);
    applyPauseStateToStream(session);
    setSessionStatus(session, "Streaming", "badge-ok");
  });

  startStatsLoop(session);
  await createAndSendOffer(session, reason);
  session.connecting = false;
}

async function createAndSendOffer(session, reason) {
  if (!session.pc) {
    return;
  }
  try {
    const offer = await session.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    const sanitized = sanitizeSdp(offer.sdp || "");
    await session.pc.setLocalDescription({ type: offer.type, sdp: sanitized });
    sendSignal({
      type: "VIEWER_OFFER",
      nickname: session.nickname,
      connectionId: session.connectionId,
      sdp: session.pc.localDescription,
      meta: { reason },
    });
    console.log(`[admin-v2] offer sent for ${session.nickname} (${reason})`);
  } catch (error) {
    session.lastError = error?.message || String(error);
    updateTileFooter(session);
    fullReconnectSession(session, "offer-failed").catch(() => {});
  }
}

function sanitizeSdp(sdp) {
  if (!sdp) {
    return sdp;
  }
  let result = sdp.replace(/a=candidate:.*\.local.*\r?\n/gi, "");
  if (state.forceTurnOnly) {
    result = result.replace(/a=candidate:.* typ (?!relay)[a-z]+.*\r?\n/gi, "");
  }
  return result;
}

function startStatsLoop(session) {
  if (session.statsTimer) {
    clearInterval(session.statsTimer);
    session.statsTimer = null;
  }
  session.statsTimer = setInterval(() => {
    collectStats(session).catch(() => {});
  }, STATS_INTERVAL_MS);
  collectStats(session).catch(() => {});
}

async function collectStats(session) {
  if (!session.pc || session.pc.connectionState === "closed") {
    return;
  }
  const report = await session.pc.getStats(null);
  const stats = analyzeStats(session, report);
  updateSessionStats(session, stats);
  if (session.dom) {
    session.dom.statBitrate.textContent = `${stats.bitrateKbps} kbps`;
    session.dom.statFps.textContent = `${stats.fps}`;
    session.dom.statRtt.textContent = `${stats.rttMs} ms`;
    session.dom.statLoss.textContent = `${stats.packetLoss}%`;
    session.dom.statState.textContent = stats.iceState;
  }
  setSessionCandidateSummary(session, `Candidate: ${stats.candidateType || "--"}`, stats.candidateBadge);
  if (state.forceTurnOnly && stats.candidateType && stats.candidateType !== "relay") {
    renegotiateSession(session, "non-relay-detected").catch(() => {});
  }
  if (stats.deltaBytes === 0) {
    if (!session.zeroDataSince) {
      session.zeroDataSince = Date.now();
    } else if (Date.now() - session.zeroDataSince > ZERO_DATA_THRESHOLD_MS) {
      renegotiateSession(session, "stats-zero").catch(() => {});
    }
  } else {
    session.zeroDataSince = null;
  }
  session.debug.selectedPair = stats.selectedPair;
  if (stats.remoteCandidate) {
    session.debug.lastRemoteCandidate = stats.remoteCandidate;
  }
  updateTileFooter(session);
  updateSummary();
}

function analyzeStats(session, report) {
  const result = {
    bitrateKbps: 0,
    fps: 0,
    rttMs: 0,
    packetLoss: 0,
    iceState: session.pc?.iceConnectionState || "new",
    candidateType: session.stats?.candidateType || "--",
    candidateBadge: "",
    deltaBytes: 0,
    selectedPair: null,
    remoteCandidate: null,
  };

  let inbound = null;
  let videoTrack = null;
  const candidatePairs = new Map();
  const remoteCandidates = new Map();
  const localCandidates = new Map();
  let transport = null;

  report.forEach((entry) => {
    if (!entry) {
      return;
    }
    switch (entry.type) {
      case "inbound-rtp":
        if (!inbound && entry.kind === "video" && !entry.isRemote) {
          inbound = entry;
        }
        break;
      case "track":
        if (!videoTrack && entry.kind === "video") {
          videoTrack = entry;
        }
        break;
      case "candidate-pair":
        candidatePairs.set(entry.id, entry);
        break;
      case "remote-candidate":
        remoteCandidates.set(entry.id, entry);
        break;
      case "local-candidate":
        localCandidates.set(entry.id, entry);
        break;
      case "transport":
        transport = entry;
        break;
      default:
        break;
    }
  });

  if (transport && transport.selectedCandidatePairId) {
    const pair = candidatePairs.get(transport.selectedCandidatePairId);
    if (pair) {
      result.selectedPair = pair;
    }
  }

  if (!result.selectedPair) {
    candidatePairs.forEach((pair) => {
      if (!result.selectedPair && pair.state === "succeeded" && pair.nominated) {
        result.selectedPair = pair;
      }
    });
  }

  if (result.selectedPair) {
    const remote = remoteCandidates.get(result.selectedPair.remoteCandidateId);
    if (remote) {
      result.candidateType = remote.candidateType || result.candidateType;
      result.remoteCandidate = remote.candidate || null;
    }
    if (typeof result.selectedPair.currentRoundTripTime === "number") {
      result.rttMs = Math.round(result.selectedPair.currentRoundTripTime * 1_000);
    }
  }

  if (inbound) {
    const timestamp = inbound.timestamp || 0;
    const bytes = inbound.bytesReceived || 0;
    const packets = inbound.packetsReceived || 0;
    const lost = inbound.packetsLost || 0;
    const prev = session.lastStatsSample;
    if (prev && timestamp > prev.timestamp && bytes >= prev.bytes) {
      const deltaBytes = bytes - prev.bytes;
      const deltaTime = timestamp - prev.timestamp;
      if (deltaTime > 0) {
        result.bitrateKbps = Math.max(0, Math.round((deltaBytes * 8) / deltaTime));
      }
      const packetDelta = packets + lost - prev.packetsTotal;
      const lostDelta = lost - prev.packetsLost;
      if (packetDelta > 0 && lostDelta >= 0) {
        result.packetLoss = Math.min(100, Math.round((lostDelta / packetDelta) * 100));
      }
      result.deltaBytes = deltaBytes;
    }
    session.lastStatsSample = {
      timestamp,
      bytes,
      packetsTotal: packets + lost,
      packetsLost: lost,
    };
  }

  if (videoTrack && typeof videoTrack.framesPerSecond === "number") {
    result.fps = Math.round(videoTrack.framesPerSecond);
  }

  if (result.candidateType === "relay") {
    result.candidateBadge = "badge-ok";
  } else if (result.candidateType && result.candidateType !== "--") {
    result.candidateBadge = "badge-warn";
  }

  return result;
}

function updateSessionStats(session, stats) {
  session.stats = stats;
}

function setSessionCandidateSummary(session, text, badgeClass = "") {
  if (!session.dom?.candidate) {
    return;
  }
  session.dom.candidate.textContent = text;
  session.dom.candidate.className = badgeClass ? badgeClass : "";
  if (session.dom.iceState) {
    session.dom.iceState.textContent = `State: ${session.lastIceState}`;
  }
}

function setSessionStatus(session, label, badgeClass) {
  if (!session.dom?.status) {
    return;
  }
  session.dom.status.textContent = label;
  session.dom.status.className = badgeClass ? `tile-status ${badgeClass}` : "tile-status";
}

function updateTileFooter(session) {
  if (!session.dom) {
    return;
  }
  session.dom.footerState.textContent = `ICE: ${session.lastIceState}`;
  const errorText = session.lastError ? `Last error: ${session.lastError}` : "";
  session.dom.footerError.textContent = errorText;
  session.dom.footerError.className = errorText ? "error" : "";
  if (state.debugEnabled) {
    updateDebugPanel();
  }
}

function createTile(session) {
  if (session.dom?.root) {
    return;
  }

  const root = document.createElement("div");
  root.className = "tile";
  root.dataset.key = session.key;

  const header = document.createElement("div");
  header.className = "tile-header";
  const heading = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = session.nickname;
  heading.appendChild(title);
  const meta = document.createElement("div");
  meta.className = "tile-meta";
  meta.textContent = formatMeta(session.key);
  heading.appendChild(meta);
  header.appendChild(heading);
  const status = document.createElement("span");
  status.className = "tile-status";
  status.textContent = "Idle";
  header.appendChild(status);
  root.appendChild(header);

  const videoWrap = document.createElement("div");
  videoWrap.className = "video-wrap";
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.disablePictureInPicture = true;
  videoWrap.appendChild(video);
  const overlay = document.createElement("div");
  overlay.className = "video-overlay";
  const candidateLabel = document.createElement("span");
  candidateLabel.textContent = "Candidate: --";
  overlay.appendChild(candidateLabel);
  const iceLabel = document.createElement("span");
  iceLabel.textContent = "State: --";
  overlay.appendChild(iceLabel);
  videoWrap.appendChild(overlay);
  root.appendChild(videoWrap);

  const statsRow = document.createElement("div");
  statsRow.className = "stats-row";
  const bitrateNode = createStatNode("Bitrate");
  const fpsNode = createStatNode("FPS");
  const rttNode = createStatNode("RTT");
  const lossNode = createStatNode("Loss");
  const stateNode = createStatNode("ICE");
  statsRow.append(bitrateNode.root, fpsNode.root, rttNode.root, lossNode.root, stateNode.root);
  root.appendChild(statsRow);

  const controls = document.createElement("div");
  controls.className = "tile-controls";
  const controlButtons = document.createElement("div");
  controlButtons.className = "control-buttons";
  const muteBtn = document.createElement("button");
  muteBtn.textContent = session.audioMuted ? "Unmute" : "Mute";
  muteBtn.addEventListener("click", () => {
    setSessionMuted(session, !session.audioMuted);
  });
  const pauseBtn = document.createElement("button");
  pauseBtn.textContent = session.videoPaused ? "Resume" : "Pause";
  pauseBtn.addEventListener("click", () => {
    setSessionPaused(session, !session.videoPaused);
  });
  const reconnectBtn = document.createElement("button");
  reconnectBtn.textContent = "Reconnect";
  reconnectBtn.addEventListener("click", () => {
    fullReconnectSession(session, "manual").catch(() => {});
  });
  controlButtons.append(muteBtn, pauseBtn, reconnectBtn);
  controls.appendChild(controlButtons);
  const bitrateSelect = document.createElement("select");
  BITRATE_OPTIONS.forEach((option) => {
    const node = document.createElement("option");
    node.value = String(option);
    node.textContent = `${option}`;
    if (option === session.maxBitrate) {
      node.selected = true;
    }
    bitrateSelect.appendChild(node);
  });
  bitrateSelect.addEventListener("change", () => {
    const value = Number.parseInt(bitrateSelect.value, 10);
    if (BITRATE_OPTIONS.includes(value)) {
      session.maxBitrate = value;
      applyMaxBitrate(session).catch(() => {});
    }
  });
  controls.appendChild(bitrateSelect);
  root.appendChild(controls);

  const footer = document.createElement("div");
  footer.className = "tile-footer";
  const footerState = document.createElement("span");
  footerState.textContent = "ICE: new";
  footer.appendChild(footerState);
  const footerError = document.createElement("span");
  footer.appendChild(footerError);
  root.appendChild(footer);

  dom.tileGrid?.appendChild(root);
  updateEmptyState();

  session.dom = {
    root,
    status,
    meta,
    video,
    candidate: candidateLabel,
    iceState: iceLabel,
    statBitrate: bitrateNode.value,
    statFps: fpsNode.value,
    statRtt: rttNode.value,
    statLoss: lossNode.value,
    statState: stateNode.value,
    muteBtn,
    pauseBtn,
    reconnectBtn,
    bitrateSelect,
    footerState,
    footerError,
  };

  updateTileMeta(session);
  updateTileFooter(session);
}

function createStatNode(label) {
  const span = document.createElement("span");
  const title = document.createTextNode(label);
  const value = document.createElement("strong");
  value.textContent = "--";
  span.append(title, value);
  return { root: span, value };
}

function updateTileMeta(session) {
  if (!session.dom?.meta) {
    return;
  }
  const meta = state.roster.get(session.key);
  if (!meta) {
    session.dom.meta.textContent = "Team ?, Slot ?";
    return;
  }
  const team = meta.team ? meta.team.toUpperCase() : "?";
  const slot = meta.slot !== undefined && meta.slot !== null && meta.slot !== "" ? meta.slot : "?";
  session.dom.meta.textContent = `${team} • Slot ${slot}`;
}

function applyMuteStateToStream(session) {
  if (!session.stream) {
    return;
  }
  session.stream.getAudioTracks().forEach((track) => {
    track.enabled = !session.audioMuted;
  });
  if (session.dom?.video) {
    session.dom.video.muted = session.audioMuted;
    if (!session.audioMuted) {
      session.dom.video.play().catch(() => {});
    }
  }
  if (session.dom?.muteBtn) {
    session.dom.muteBtn.textContent = session.audioMuted ? "Unmute" : "Mute";
  }
}

function applyPauseStateToStream(session) {
  if (!session.stream) {
    return;
  }
  session.stream.getVideoTracks().forEach((track) => {
    track.enabled = !session.videoPaused;
  });
  if (session.dom?.pauseBtn) {
    session.dom.pauseBtn.textContent = session.videoPaused ? "Resume" : "Pause";
  }
}

function setSessionMuted(session, muted) {
  session.audioMuted = Boolean(muted);
  applyMuteStateToStream(session);
}

function setSessionPaused(session, paused) {
  session.videoPaused = Boolean(paused);
  applyPauseStateToStream(session);
}

async function applyMaxBitrate(session) {
  if (!session.pc) {
    return;
  }
  const encKbps = session.maxBitrate;
  const tasks = session.pc.getSenders().map(async (sender) => {
    if (!sender.track || sender.track.kind !== "video") {
      return;
    }
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = encKbps ? encKbps * 1_000 : undefined;
      await sender.setParameters(params);
    } catch (error) {
      session.lastError = error?.message || String(error);
      updateTileFooter(session);
    }
  });
  await Promise.allSettled(tasks);
}

function scheduleReconnect(session, reason) {
  setTimeout(() => {
    if (!session.pc) {
      startSession(session, reason).catch(() => {});
    }
  }, 2_000);
}

async function renegotiateSession(session, reason) {
  if (!session.pc || session.renegotiating) {
    if (session.renegotiating) {
      session.pendingRenegotiation = reason;
    }
    return;
  }
  session.renegotiating = true;
  session.pendingRenegotiation = null;
  console.log(`[admin-v2] renegotiate ${session.nickname} (${reason})`);
  logDebug("Renegotiation started", { nickname: session.nickname, reason });
  try {
    if (session.pc.restartIce) {
      session.pc.restartIce();
    }
    await createAndSendOffer(session, reason);
  } catch (error) {
    session.lastError = error?.message || String(error);
    updateTileFooter(session);
    await fullReconnectSession(session, `${reason}-fallback`);
  } finally {
    console.log(`[admin-v2] renegotiate complete ${session.nickname} (${reason})`);
    session.renegotiating = false;
    logDebug("Renegotiation completed", { nickname: session.nickname, reason });
    if (session.pendingRenegotiation) {
      const followReason = session.pendingRenegotiation;
      session.pendingRenegotiation = null;
      renegotiateSession(session, `${followReason}-queued`).catch(() => {});
    }
  }
}

async function fullReconnectSession(session, reason) {
  if (!session) {
    return;
  }
  console.log(`[admin-v2] reconnect ${session.nickname} (${reason})`);
  logDebug("Full reconnect", { nickname: session.nickname, reason });
  stopPeer(session);
  await startSession(session, reason);
}

function stopPeer(session) {
  if (session.statsTimer) {
    clearInterval(session.statsTimer);
    session.statsTimer = null;
  }
  if (session.connectTimer) {
    clearTimeout(session.connectTimer);
    session.connectTimer = null;
  }
  if (session.connection) {
    session.connection.destroy();
    session.connection = null;
  }
  if (session.pc) {
    try {
      session.pc.close();
    } catch (error) {
      // ignore
    }
    session.pc = null;
  }
  if (session.stream) {
    session.stream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (error) {
        // ignore
      }
    });
    session.stream = null;
  }
  if (session.dom?.video) {
    session.dom.video.srcObject = null;
  }
  if (session.dom?.statBitrate) {
    session.dom.statBitrate.textContent = "--";
  }
  if (session.dom?.statFps) {
    session.dom.statFps.textContent = "--";
  }
  if (session.dom?.statRtt) {
    session.dom.statRtt.textContent = "--";
  }
  if (session.dom?.statLoss) {
    session.dom.statLoss.textContent = "--";
  }
  if (session.dom?.statState) {
    session.dom.statState.textContent = "--";
  }
  if (session.dom?.candidate) {
    session.dom.candidate.textContent = "Candidate: --";
    session.dom.candidate.className = "";
  }
  if (session.dom?.iceState) {
    session.dom.iceState.textContent = "State: --";
  }
  session.connecting = false;
  session.connected = false;
  session.zeroDataSince = null;
  session.lastStatsSample = null;
  session.stats = null;
  setSessionStatus(session, "Idle", "");
}

function removeSession(session) {
  stopPeer(session);
  if (session.dom?.root) {
    session.dom.root.remove();
  }
  state.sessions.delete(session.key);
  state.knownPublishers.delete(session.key);
  updateSummary();
  updateEmptyState();
}

function createConnectionId() {
  return `admin-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

function extractCandidateType(candidate) {
  if (typeof candidate !== "string") {
    return "";
  }
  const match = candidate.match(/ typ ([a-z]+)/);
  return match ? match[1] : "";
}

function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = options.timeoutMs || 0;
  const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null;
  const targetUrl = typeof url === "string" && !/^https?:/i.test(url) ? `${API_BASE}${url}` : url;
  return fetch(targetUrl, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    credentials: "include",
    cache: "no-store",
    signal: controller.signal,
  })
    .then((response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
    })
    .finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
}

function updateSummary() {
  let activeRelays = 0;
  let totalBitrate = 0;
  let totalRtt = 0;
  let rttCount = 0;

  state.sessions.forEach((session) => {
    if (session.stats?.candidateType === "relay" && session.connected) {
      activeRelays += 1;
    }
    if (Number.isFinite(session.stats?.bitrateKbps)) {
      totalBitrate += session.stats.bitrateKbps;
    }
    if (Number.isFinite(session.stats?.rttMs) && session.stats.rttMs > 0) {
      totalRtt += session.stats.rttMs;
      rttCount += 1;
    }
  });

  const avgRtt = rttCount ? Math.round(totalRtt / rttCount) : 0;
  if (dom.summaryCards.active) {
    dom.summaryCards.active.textContent = `${activeRelays}`;
  }
  if (dom.summaryCards.bitrate) {
    dom.summaryCards.bitrate.textContent = `${Math.round(totalBitrate)} kbps`;
  }
  if (dom.summaryCards.rtt) {
    dom.summaryCards.rtt.textContent = `${avgRtt} ms`;
  }
  if (dom.summaryCards.refreshed) {
    dom.summaryCards.refreshed.textContent = state.lastConfigRefresh
      ? new Date(state.lastConfigRefresh).toLocaleTimeString()
      : "--";
  }
}

function updateTokenIndicator(message, severity) {
  if (!dom.tokenIndicator) {
    return;
  }
  dom.tokenIndicator.classList.remove("warn", "danger");
  if (message) {
    dom.tokenIndicator.textContent = message;
    if (severity === "warn" || severity === "danger") {
      dom.tokenIndicator.classList.add(severity);
    }
    return;
  }
  if (!state.lastConfigRefresh) {
    dom.tokenIndicator.textContent = "Waiting for TURN config…";
    return;
  }
  const ageMs = Date.now() - state.lastConfigRefresh;
  const ageMinutes = Math.floor(ageMs / 60_000);
  const ttlMs = (state.configTtlSec || 0) * 1_000;
  let status = `Token age ${ageMinutes}m`;
  if (ttlMs) {
    const remaining = Math.max(0, ttlMs - ageMs);
    const remainingMin = Math.floor(remaining / 60_000);
    status += ` • ${remainingMin}m left`;
    const ratio = ttlMs ? ageMs / ttlMs : 0;
    if (ratio > 0.85) {
      dom.tokenIndicator.classList.add("danger");
    } else if (ratio > 0.7) {
      dom.tokenIndicator.classList.add("warn");
    }
  }
  dom.tokenIndicator.textContent = status;
}

function updateEmptyState() {
  if (!dom.emptyState) {
    return;
  }
  dom.emptyState.style.display = state.sessions.size ? "none" : "block";
}

function formatMeta(key) {
  const record = state.roster.get(key);
  if (!record) {
    return "Team ?, Slot ?";
  }
  const team = record.team ? record.team.toUpperCase() : "?";
  const slot = record.slot !== undefined && record.slot !== null && record.slot !== "" ? record.slot : "?";
  return `${team} • Slot ${slot}`;
}

function toggleDebugPanel() {
  state.debugEnabled = !state.debugEnabled;
  if (dom.debugPanel) {
    dom.debugPanel.style.display = state.debugEnabled ? "grid" : "none";
  }
  if (state.debugEnabled) {
    updateDebugPanel();
  }
}

function logDebug(message, details) {
  const entry = {
    time: new Date().toISOString(),
    message,
    details: details || null,
  };
  state.debugEntries.push(entry);
  if (state.debugEntries.length > MAX_DEBUG_ENTRIES) {
    state.debugEntries.shift();
  }
  if (state.debugEnabled) {
    updateDebugPanel();
  }
}

function updateDebugPanel() {
  if (!dom.debugOutput) {
    return;
  }
  const lines = state.debugEntries.slice(-40).map((entry) => {
    const detail = entry.details ? ` ${JSON.stringify(entry.details)}` : "";
    return `[${entry.time}] ${entry.message}${detail}`;
  });
  dom.debugOutput.textContent = lines.join("\n") || "Debug output will appear here.";
  dom.debugOutput.scrollTop = dom.debugOutput.scrollHeight;

  const activePairs = [];
  state.sessions.forEach((session) => {
    if (session.debug?.selectedPair) {
      activePairs.push(`${session.nickname}: ${session.debug.selectedPair.localCandidateId} -> ${session.debug.selectedPair.remoteCandidateId}`);
    }
  });
  if (activePairs.length) {
    dom.debugOutput.textContent += `\nPairs:\n${activePairs.join("\n")}`;
  }
}

function cleanupAll() {
  if (state.tokenTimer) {
    clearInterval(state.tokenTimer);
    state.tokenTimer = null;
  }
  if (state.rosterTimer) {
    clearInterval(state.rosterTimer);
    state.rosterTimer = null;
  }
  state.sessions.forEach(stopPeer);
  if (state.ws) {
    try {
      state.ws.close();
    } catch (error) {
      // ignore
    }
    state.ws = null;
  }
}
