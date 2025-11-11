import { logEv, addCandidate, recordIceServers } from "./diag.js";
import { getQueryFlag, parseCandidate, describeCandidate, fingerprintIceServer } from "./utils.js";

async function fetchIceServers() {
  const response = await fetch("/api/webrtc/config", { cache: "no-store" });
  if (!response.ok) {
    const error = new Error(`ICE config HTTP ${response.status}`);
    logEv("ice", "config_error", { status: response.status });
    throw error;
  }
  const json = await response.json();
  const iceServers = Array.isArray(json.iceServers) ? json.iceServers : [];
  const ttlSec = json.ttlSec || json.ttl || null;
  logEv("ice", "config_fetched", { ttlSec });
  return { iceServers, ttlSec };
}

function filterTurnServers(servers, { forceTurnOnly, tcpOnly }) {
  if (!Array.isArray(servers)) {
    return [];
  }
  const filtered = [];
  servers.forEach((entry) => {
    if (!entry) {
      return;
    }
    const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    const turnOnly = urls.filter((url) => typeof url === "string" && url.trim().toLowerCase().startsWith("turn"));
    if (!turnOnly.length) {
      return;
    }
    const tcpOnlyUrls = tcpOnly
      ? turnOnly.filter((url) => url.toLowerCase().startsWith("turns:") || /transport=tcp/i.test(url))
      : turnOnly;
    if (!tcpOnlyUrls.length && tcpOnly) {
      return;
    }
    filtered.push({ ...entry, urls: tcpOnly ? tcpOnlyUrls : turnOnly });
  });
  return filtered;
}

function noteIceServersForLog(servers) {
  recordIceServers(servers);
  const compact = servers.map((server) => fingerprintIceServer(server));
  logEv("ice", "servers_applied", { servers: compact });
}

function wrapAddIceCandidate(pc, forceTurnOnly) {
  const original = pc.addIceCandidate.bind(pc);
  pc.addIceCandidate = async (candidate) => {
    if (candidate && candidate.candidate) {
      const parsed = parseCandidate(candidate.candidate);
      addCandidate("remote", parsed, { dropped: false });
      logEv("signal", "candidate_remote", describeCandidate(parsed));
      if (forceTurnOnly && parsed && parsed.type && parsed.type !== "relay") {
        logEv("signal", "candidate_remote_dropped", parsed);
        return Promise.resolve();
      }
    }
    try {
      return await original(candidate);
    } catch (error) {
      logEv("signal", "error", { message: error?.message || String(error) });
      throw error;
    }
  };
}

function setupWindowHelpers(pc) {
  try {
    window.pc = pc;
    window.dumpStats = async () => {
      const report = await pc.getStats();
      const summary = [];
      report.forEach((entry) => {
        if (entry.type === "candidate-pair" && entry.state === "succeeded" && entry.nominated) {
          summary.push({
            id: entry.id,
            currentRoundTripTime: entry.currentRoundTripTime,
            availableOutgoingBitrate: entry.availableOutgoingBitrate,
            availableIncomingBitrate: entry.availableIncomingBitrate,
            bytesSent: entry.bytesSent,
            bytesReceived: entry.bytesReceived,
          });
        }
      });
      console.table(summary);
    };
    window.selected = async () => {
      const report = await pc.getStats();
      let transport = null;
      report.forEach((entry) => {
        if (entry.type === "transport" && entry.selectedCandidatePairId) {
          transport = entry;
        }
      });
      if (!transport || !transport.selectedCandidatePairId) {
        console.warn("No selected pair");
        return;
      }
      const pair = report.get(transport.selectedCandidatePairId);
      if (!pair) {
        console.warn("Pair missing");
        return;
      }
      const local = report.get(pair.localCandidateId);
      const remote = report.get(pair.remoteCandidateId);
      console.log("Selected pair", { pair, local, remote });
    };
  } catch (error) {
    // ignore window binding issues
  }
}

function extractSummaryCandidates(report) {
  let transport = null;
  report.forEach((entry) => {
    if (entry.type === "transport" && entry.selectedCandidatePairId) {
      transport = entry;
    }
  });
  if (!transport) {
    return null;
  }
  const pair = report.get(transport.selectedCandidatePairId);
  if (!pair) {
    return null;
  }
  const local = report.get(pair.localCandidateId);
  const remote = report.get(pair.remoteCandidateId);
  return { pair, local, remote };
}

export async function createTurnOnlyPeerConnection(opts = {}) {
  const forceTurnOnly = opts.forceTurnOnly ?? getQueryFlag("turnOnly", 1);
  const tcpOnly = opts.tcpOnly ?? getQueryFlag("tcpOnly", 0);

  const { iceServers, ttlSec } = await fetchIceServers();
  const servers = forceTurnOnly ? filterTurnServers(iceServers, { forceTurnOnly, tcpOnly }) : iceServers;
  noteIceServersForLog(servers);

  const config = {
    iceServers: servers,
    iceTransportPolicy: forceTurnOnly ? "relay" : "all",
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    sdpSemantics: "unified-plan",
    iceCandidatePoolSize: 0,
  };

  const pc = new RTCPeerConnection(config);
  setupWindowHelpers(pc);
  wrapAddIceCandidate(pc, forceTurnOnly);

  logEv("pc", "created", { forceTurnOnly, tcpOnly, ttlSec });

  pc.addEventListener("icegatheringstatechange", () => {
    logEv("pc", "icegatheringstate", pc.iceGatheringState);
  });
  pc.addEventListener("iceconnectionstatechange", () => {
    logEv("pc", "iceconnectionstate", pc.iceConnectionState);
  });
  pc.addEventListener("connectionstatechange", () => {
    logEv("pc", "connectionstate", pc.connectionState);
  });
  pc.addEventListener("signalingstatechange", () => {
    logEv("pc", "signalingstate", pc.signalingState);
  });
  pc.addEventListener("negotiationneeded", () => {
    logEv("pc", "negotiationneeded");
  });
  pc.addEventListener("track", (event) => {
    const track = event.track;
    logEv("pc", "track", { kind: track.kind, id: track.id, label: track.label });
  });
  pc.addEventListener("icecandidate", (event) => {
    if (!event.candidate) {
      logEv("pc", "icecandidate", null);
      return;
    }
    const candidate = event.candidate.candidate || "";
    const parsed = parseCandidate(candidate);
    const desc = describeCandidate(parsed);
    if (forceTurnOnly && parsed && parsed.type && parsed.type !== "relay") {
      addCandidate("local", parsed, { dropped: true, note: "non-relay filtered" });
      logEv("pc", "candidate_dropped", desc);
      return;
    }
    addCandidate("local", parsed, { dropped: false });
    logEv("pc", "candidate", desc);
    pc.dispatchEvent(
      new CustomEvent("turncandidate", {
        detail: { candidate: event.candidate, parsed },
      })
    );
  });
  pc.addEventListener("icecandidateerror", (event) => {
    logEv("pc", "icecandidateerror", {
      url: event.url,
      errorCode: event.errorCode,
      errorText: event.errorText,
      address: event.address,
      port: event.port,
    });
  });

  pc.__turnOnly = {
    forceTurnOnly,
    tcpOnly,
    ttlSec,
    getSelectedPair: async () => {
      const report = await pc.getStats();
      return extractSummaryCandidates(report);
    },
  };

  return pc;
}

export async function dumpSelectedPair(pc) {
  const report = await pc.getStats();
  return extractSummaryCandidates(report);
}
