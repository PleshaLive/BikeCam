import { logEv, addCandidate, recordIceServers } from "./diag.js";
import {
  getQueryFlag,
  parseCandidate,
  describeCandidate,
  fingerprintIceServer,
  maskSecret,
} from "./utils.js";

const DEFAULT_TURN_UDP = "turn:turn.raptors.life:3478?transport=udp";
const DEFAULT_TURN_TCP = "turns:turn.raptors.life:5349?transport=tcp";

function pushLog(event, payload) {
  try {
    logEv("turn", event, payload);
    if (Array.isArray(window.__webrtcLog)) {
      window.__webrtcLog.push({ t: new Date().toISOString(), event, payload });
    }
  } catch (error) {
    // ignore logging bridge errors
  }
}

function scrubServersForLog(servers) {
  return servers.map((entry) => {
    if (!entry) {
      return entry;
    }
    const masked = {
      ...entry,
      username: entry.username ? maskSecret(entry.username) : entry.username,
      credential: entry.credential ? maskSecret(entry.credential) : entry.credential,
    };
    if (Array.isArray(masked.urls)) {
      masked.urls = masked.urls.slice();
    }
    return masked;
  });
}

export async function buildTurnOnlyIceServers({ tcpOnly = false } = {}) {
  const turnFlag = getQueryFlag("turnOnly", 1);
  const tcpFlag = getQueryFlag("tcpOnly", tcpOnly ? 1 : 0);
  const forceRelay = turnFlag !== false;
  const tcpOnlyResolved = Boolean(tcpFlag || tcpOnly);

  const response = await fetch("/api/webrtc/turn-creds", { cache: "no-store" });
  if (!response.ok) {
    pushLog("turn_creds_error", { status: response.status });
    throw new Error(`TURN creds HTTP ${response.status}`);
  }

  const json = await response.json();
  const username = json?.username || "";
  const credential = json?.credential || "";
  const ttlSec = json?.ttlSec || null;

  const servers = [];
  if (!tcpOnlyResolved) {
    servers.push({ urls: [DEFAULT_TURN_UDP], username, credential });
  }
  servers.push({ urls: [DEFAULT_TURN_TCP], username, credential });

  const filtered = tcpOnlyResolved
    ? servers.filter((entry) => Array.isArray(entry.urls) ? entry.urls.some((url) => /transport=tcp/i.test(url)) : /transport=tcp/i.test(entry.urls))
    : servers;

  const masked = scrubServersForLog(filtered);
  pushLog("turn_config_fetched", { ttlSec, tcpOnly: tcpOnlyResolved, forceRelay, servers: masked });
  recordIceServers(filtered);

  return { iceServers: filtered, ttlSec, forceRelay, tcpOnly: tcpOnlyResolved };
}

function redactPayload(obj) {
  if (!obj) {
    return obj;
  }
  return JSON.parse(
    JSON.stringify(obj, (key, value) => {
      if (key === "username" || key === "credential") {
        return maskSecret(value);
      }
      return value;
    })
  );
}

function trackChannelBind(report) {
  let bound = false;
  report.forEach((entry) => {
    if (entry.type === "data-channel" && entry.label === "keepalive" && entry.state === "open") {
      bound = true;
    }
  });
  return bound;
}

function makeStatsSampler(pc) {
  let timer = null;
  const loop = async () => {
    try {
      const report = await pc.getStats(null);
      let selectedPair = null;
      let transport = null;
      report.forEach((entry) => {
        if (entry.type === "transport" && entry.selectedCandidatePairId) {
          transport = entry;
        }
      });
      if (transport?.selectedCandidatePairId) {
        selectedPair = report.get(transport.selectedCandidatePairId);
      }
      let relay = null;
      if (selectedPair) {
        relay = {
          id: selectedPair.id,
          state: selectedPair.state,
          nominated: Boolean(selectedPair.nominated),
          bytesSent: selectedPair.bytesSent,
          bytesReceived: selectedPair.bytesReceived,
          currentRoundTripTime: selectedPair.currentRoundTripTime,
          availableOutgoingBitrate: selectedPair.availableOutgoingBitrate,
          availableIncomingBitrate: selectedPair.availableIncomingBitrate,
        };
        const local = report.get(selectedPair.localCandidateId);
        const remote = report.get(selectedPair.remoteCandidateId);
        if (local || remote) {
          relay.local = local ? describeCandidate(parseCandidate(local.candidate || "")) : null;
          relay.remote = remote ? describeCandidate(parseCandidate(remote.candidate || "")) : null;
        }
      }
      pushLog("stats", {
        relay,
        channelBind: trackChannelBind(report),
      });
    } catch (error) {
      pushLog("stats_error", { message: error?.message || String(error) });
    }
    timer = setTimeout(loop, 1_000);
  };
  loop();
  return () => timer && clearTimeout(timer);
}

function wrapIceCandidate(pc, forceRelay) {
  const originalAdd = pc.addIceCandidate.bind(pc);
  pc.addIceCandidate = async (candidate) => {
    if (candidate && candidate.candidate) {
      const parsed = parseCandidate(candidate.candidate);
      addCandidate("remote", parsed, { dropped: false });
      logEv("signal", "candidate_remote", describeCandidate(parsed));
      if (forceRelay && parsed?.type && parsed.type !== "relay") {
        pushLog("candidate_filtered_remote", { type: parsed.type });
        return Promise.resolve();
      }
    }
    return originalAdd(candidate);
  };
}

function attachDiagnostics(pc, forceRelay) {
  pc.addEventListener("iceconnectionstatechange", () => {
    pushLog("pc_ice", {
      iceConnectionState: pc.iceConnectionState,
      iceGatheringState: pc.iceGatheringState,
      signalingState: pc.signalingState,
      connectionState: pc.connectionState,
    });
  });
  pc.addEventListener("connectionstatechange", () => {
    pushLog("pc_conn", {
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
    });
  });
  pc.addEventListener("signalingstatechange", () => {
    pushLog("pc_sig", { signalingState: pc.signalingState });
  });
  pc.addEventListener("icegatheringstatechange", () => {
    pushLog("pc_gather", { state: pc.iceGatheringState });
  });
  pc.addEventListener("icecandidateerror", (event) => {
    pushLog("ice_error", redactPayload(event));
  });
  pc.addEventListener("icecandidate", (event) => {
    if (!event.candidate) {
      pushLog("candidate_complete", {});
      return;
    }
    const raw = event.candidate.candidate || "";
    const parsed = parseCandidate(raw);
    const desc = describeCandidate(parsed);
    if (forceRelay && parsed?.type && parsed.type !== "relay") {
      pushLog("candidate_filtered_local", { candidate: desc });
      return;
    }
    addCandidate("local", parsed, { dropped: false });
    pushLog("candidate_local", { candidate: desc });
  });

  wrapIceCandidate(pc, forceRelay);
}

export async function createRelayOnlyPC(opts = {}) {
  const { iceServers, ttlSec, forceRelay, tcpOnly } = await buildTurnOnlyIceServers(opts);

  const config = {
    iceServers,
    iceTransportPolicy: forceRelay ? "relay" : "all",
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 0,
    sdpSemantics: "unified-plan",
  };

  const pc = new RTCPeerConnection(config);
  attachDiagnostics(pc, forceRelay);
  const stopStats = makeStatsSampler(pc);

  const keepalive = pc.createDataChannel("keepalive", { ordered: false, maxRetransmits: 0 });
  const interval = setInterval(() => {
    if (keepalive.readyState === "open") {
      try {
        keepalive.send("ping");
      } catch (error) {
        pushLog("keepalive_error", { message: error?.message || String(error) });
      }
    }
  }, 10_000);
  keepalive.addEventListener("close", () => pushLog("keepalive_close", {}));
  keepalive.addEventListener("open", () => pushLog("keepalive_open", {}));

  pc.__turnOnly = {
    forceRelay,
    tcpOnly,
    ttlSec,
    stopStats: () => {
      stopStats();
      clearInterval(interval);
    },
  };

  pushLog("pc_created", {
    forceRelay,
    tcpOnly,
    ttlSec,
    servers: scrubServersForLog(iceServers),
  });

  return pc;
}

export async function createTurnOnlyPeerConnection(opts = {}) {
  return createRelayOnlyPC(opts);
}

export async function dumpSelectedPair(pc) {
  const report = await pc.getStats();
  const result = {};
  let transport = null;
  report.forEach((entry) => {
    if (entry.type === "transport" && entry.selectedCandidatePairId) {
      transport = entry;
    }
  });
  if (!transport?.selectedCandidatePairId) {
    return null;
  }
  const pair = report.get(transport.selectedCandidatePairId);
  if (!pair) {
    return null;
  }
  result.pair = pair;
  result.local = report.get(pair.localCandidateId);
  result.remote = report.get(pair.remoteCandidateId);
  return result;
}
