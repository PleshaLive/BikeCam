import { scrubSecrets, scrubIceServersForUi } from "./utils.js";

const MAX = 2000;
const logBuffer = [];
const candidateBuffer = [];
let lastIceServers = [];

function push(row) {
  logBuffer.push(row);
  if (logBuffer.length > MAX) {
    logBuffer.shift();
  }
  try {
    window.__webrtcLast = { scope: row.scope, ev: row.ev, data: row.data };
  } catch (error) {
    // ignore
  }
}

export function logEv(scope, ev, data) {
  const payload = scrubSecrets(data);
  push({ t: Date.now(), scope, ev, data: payload });
}

export function getLog() {
  return [...logBuffer];
}

export function clearLog() {
  logBuffer.length = 0;
  candidateBuffer.length = 0;
}

export async function pushLogToServer() {
  try {
    await fetch("/api/webrtc/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ts: Date.now(), log: getLog(), candidates: getCandidates() }),
    });
  } catch (error) {
    // ignore — endpoint optional
  }
}

export function recordIceServers(servers) {
  if (!Array.isArray(servers)) {
    lastIceServers = [];
    return;
  }
  lastIceServers = scrubIceServersForUi(servers);
}

export function getRecordedIceServers() {
  return [...lastIceServers];
}

export function addCandidate(direction, candidate, meta = {}) {
  if (!candidate) {
    return;
  }
  candidateBuffer.push({
    t: Date.now(),
    direction,
    type: candidate.type || "",
    protocol: candidate.protocol || "",
    relayProtocol: candidate.relayProtocol || "",
    ip: candidate.ip || "",
    port: candidate.port || "",
    priority: candidate.priority || 0,
    foundation: candidate.foundation || "",
    relatedAddress: candidate.relatedAddress || "",
    relatedPort: candidate.relatedPort || "",
    raw: candidate.raw,
    dropped: Boolean(meta.dropped),
    note: meta.note || "",
  });
  if (candidateBuffer.length > MAX) {
    candidateBuffer.shift();
  }
}

export function getCandidates() {
  return [...candidateBuffer];
}

export function clearCandidates() {
  candidateBuffer.length = 0;
}

try {
  window.__webrtcLog = {
    dump: getLog,
    clear: clearLog,
    push: pushLogToServer,
    candidates: getCandidates,
  };
} catch (error) {
  // ignore
}
