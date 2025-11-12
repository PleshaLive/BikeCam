import { getLog, clearLog, pushLogToServer, getCandidates, clearCandidates, getRecordedIceServers } from "./webrtc/diag.js";
import { createTurnOnlyPeerConnection } from "./webrtc/turn-only.js";
import { getQueryFlag, valueOrDash } from "./webrtc/utils.js";

const dom = {
  accessGate: document.getElementById("accessGate"),
  statePanel: document.getElementById("statePanel"),
  serversPanel: document.getElementById("serversPanel"),
  logPanel: document.getElementById("logPanel"),
  candidatesPanel: document.getElementById("candidatesPanel"),
  stateDetails: document.getElementById("stateDetails"),
  statsDetails: document.getElementById("statsDetails"),
  pairDetails: document.getElementById("pairDetails"),
  serversDetails: document.getElementById("serversDetails"),
  candidateRows: document.getElementById("candidateRows"),
  logContainer: document.getElementById("logContainer"),
  scopeFilter: document.getElementById("scopeFilter"),
  eventFilter: document.getElementById("eventFilter"),
  textFilter: document.getElementById("textFilter"),
  reconnectBtn: document.getElementById("reconnectBtn"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  sendLogBtn: document.getElementById("sendLogBtn"),
  reloadBtn: document.getElementById("reloadBtn"),
  turnOnlyToggle: document.getElementById("turnOnlyToggle"),
  tcpOnlyToggle: document.getElementById("tcpOnlyToggle"),
  followToggle: document.getElementById("followToggle"),
};

const state = {
  pc: null,
  followLog: true,
  lastStats: null,
  filters: {
    scope: "",
    event: "",
    text: "",
  },
  statsTimer: null,
  logTimer: null,
  candidateTimer: null,
};

function hasAccess() {
  const url = new URL(window.location.href);
  const key = url.searchParams.get("key");
  if (!key) {
    return false;
  }
  return true;
}

function togglePanels(visible) {
  const method = visible ? "remove" : "add";
  dom.statePanel.classList[method]("hidden");
  dom.serversPanel.classList[method]("hidden");
  dom.logPanel.classList[method]("hidden");
  dom.candidatesPanel.classList[method]("hidden");
  dom.accessGate.classList[visible ? "add" : "remove"]("hidden");
}

async function initPeer() {
  if (state.pc) {
    try {
      if (typeof state.pc.__turnCleanup === "function") {
        state.pc.__turnCleanup();
      }
    } catch (error) {
      // ignore
    }
    try {
      state.pc.close();
    } catch (error) {
      // ignore
    }
    state.pc = null;
  }
  clearCandidates();
  state.lastStats = null;
  try {
    state.pc = await createTurnOnlyPeerConnection();
    renderServers();
  } catch (error) {
    dom.stateDetails.textContent = JSON.stringify({ error: error?.message || String(error) }, null, 2);
  }
}

function renderServers() {
  const servers = getRecordedIceServers();
  const context = state.pc?.__turnOnly || {};
  dom.serversDetails.textContent = JSON.stringify(
    {
      turnOnly: Boolean(context.forceRelay),
      tcpOnly: Boolean(context.tcpOnly),
      ttlSec: context.ttlSec ?? null,
      iceServers: servers,
    },
    null,
    2
  );
}

async function pollStats() {
  if (!state.pc) {
    return;
  }
  try {
    const report = await state.pc.getStats();
    const summary = extractSummary(report);
    dom.stateDetails.textContent = JSON.stringify(
      {
        iceGatheringState: state.pc.iceGatheringState,
        iceConnectionState: state.pc.iceConnectionState,
        connectionState: state.pc.connectionState,
        signalingState: state.pc.signalingState,
      },
      null,
      2
    );
    dom.pairDetails.textContent = JSON.stringify(summary.pair, null, 2);
    dom.statsDetails.textContent = JSON.stringify(summary.metrics, null, 2);
  } catch (error) {
    dom.statsDetails.textContent = JSON.stringify({ error: error?.message || String(error) }, null, 2);
  }
}

function extractSummary(report) {
  let selectedPair = null;
  const metrics = {
    availableIncomingBitrate: 0,
    availableOutgoingBitrate: 0,
    currentRoundTripTime: 0,
    bitrateSentKbps: 0,
    bitrateRecvKbps: 0,
    bytesSent: 0,
    bytesReceived: 0,
  };

  let transport = null;
  report.forEach((entry) => {
    if (entry.type === "transport" && entry.selectedCandidatePairId) {
      transport = entry;
    }
  });

  if (transport && transport.selectedCandidatePairId) {
    const pair = report.get(transport.selectedCandidatePairId);
    if (pair) {
      const local = report.get(pair.localCandidateId);
      const remote = report.get(pair.remoteCandidateId);
      selectedPair = {
        local,
        remote,
      };
      metrics.availableIncomingBitrate = Math.round(pair.availableIncomingBitrate || 0);
      metrics.availableOutgoingBitrate = Math.round(pair.availableOutgoingBitrate || 0);
      metrics.currentRoundTripTime = Math.round((pair.currentRoundTripTime || 0) * 1000);
      metrics.bytesSent = pair.bytesSent || 0;
      metrics.bytesReceived = pair.bytesReceived || 0;
      if (state.lastStats) {
        const deltaBytesSent = Math.max(0, metrics.bytesSent - state.lastStats.bytesSent);
        const deltaBytesRecv = Math.max(0, metrics.bytesReceived - state.lastStats.bytesReceived);
        const deltaTime = Math.max(1, Date.now() - state.lastStats.timestamp);
        metrics.bitrateSentKbps = Math.round((deltaBytesSent * 8) / deltaTime);
        metrics.bitrateRecvKbps = Math.round((deltaBytesRecv * 8) / deltaTime);
      }
      state.lastStats = {
        timestamp: Date.now(),
        bytesSent: metrics.bytesSent,
        bytesReceived: metrics.bytesReceived,
      };
    }
  }

  return { pair: selectedPair, metrics };
}

function renderLog() {
  const rows = getLog();
  const filterScope = state.filters.scope.trim().toLowerCase();
  const filterEvent = state.filters.event.trim().toLowerCase();
  const filterText = state.filters.text.trim().toLowerCase();

  dom.logContainer.innerHTML = "";
  rows.forEach((row) => {
    if (filterScope && !row.scope.toLowerCase().includes(filterScope)) {
      return;
    }
    if (filterEvent && !row.ev.toLowerCase().includes(filterEvent)) {
      return;
    }
    const payload = row.data ? JSON.stringify(row.data).toLowerCase() : "";
    if (filterText && !payload.includes(filterText)) {
      return;
    }
    const entry = document.createElement("div");
    entry.className = "log-entry";
    entry.innerHTML = `<strong>${new Date(row.t).toISOString()}</strong> [${row.scope}] ${row.ev}${row.data !== undefined ? `<pre>${JSON.stringify(row.data, null, 2)}</pre>` : ""}`;
    dom.logContainer.appendChild(entry);
  });
  if (state.followLog) {
    dom.logContainer.scrollTop = dom.logContainer.scrollHeight;
  }
}

function renderCandidates() {
  const rows = getCandidates();
  dom.candidateRows.innerHTML = "";
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const badgeClass = row.dropped ? "badge dropped" : `badge ${row.type || ""}`;
    tr.innerHTML = `
      <td>${new Date(row.t).toLocaleTimeString()}</td>
      <td>${row.direction}</td>
      <td><span class="${badgeClass}">${valueOrDash(row.type)}</span></td>
      <td>${valueOrDash(row.protocol)}${row.relayProtocol ? ` / ${row.relayProtocol}` : ""}</td>
      <td>${row.ip && row.port ? `${row.ip}:${row.port}` : "—"}</td>
      <td>${valueOrDash(row.foundation)}</td>
      <td>${row.relatedAddress ? `${row.relatedAddress}:${row.relatedPort || ""}` : "—"}</td>
      <td>${row.note || ""}</td>
    `;
    dom.candidateRows.appendChild(tr);
  });
}

function scheduleLoops() {
  if (state.statsTimer) {
    clearInterval(state.statsTimer);
  }
  if (state.logTimer) {
    clearInterval(state.logTimer);
  }
  if (state.candidateTimer) {
    clearInterval(state.candidateTimer);
  }
  state.statsTimer = setInterval(pollStats, 2_000);
  state.logTimer = setInterval(renderLog, 2_000);
  state.candidateTimer = setInterval(() => {
    renderCandidates();
  }, 2_000);
  pollStats().catch(() => {});
  renderLog();
  renderCandidates();
}

function bindEvents() {
  dom.reconnectBtn.addEventListener("click", () => {
    initPeer().then(() => {
      scheduleLoops();
    });
  });
  dom.clearLogBtn.addEventListener("click", () => {
    clearLog();
    clearCandidates();
    renderLog();
    renderCandidates();
  });
  dom.sendLogBtn.addEventListener("click", () => {
    pushLogToServer().catch(() => {});
  });
  dom.reloadBtn.addEventListener("click", () => {
    const url = new URL(window.location.href);
    url.searchParams.set("v", Date.now().toString());
    window.location.href = url.toString();
  });
  dom.turnOnlyToggle.addEventListener("change", () => {
    updateFlags({ turnOnly: dom.turnOnlyToggle.checked ? "1" : "0" });
  });
  dom.tcpOnlyToggle.addEventListener("change", () => {
    updateFlags({ tcpOnly: dom.tcpOnlyToggle.checked ? "1" : "0" });
  });
  dom.followToggle.addEventListener("change", (event) => {
    state.followLog = Boolean(event.target.checked);
  });
  dom.scopeFilter.addEventListener("input", (event) => {
    state.filters.scope = event.target.value;
    renderLog();
  });
  dom.eventFilter.addEventListener("input", (event) => {
    state.filters.event = event.target.value;
    renderLog();
  });
  dom.textFilter.addEventListener("input", (event) => {
    state.filters.text = event.target.value;
    renderLog();
  });
}

function updateFlags(flags) {
  const url = new URL(window.location.href);
  Object.entries(flags).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  url.searchParams.set("v", Date.now().toString());
  window.location.href = url.toString();
}

function applyInitialFlags() {
  dom.turnOnlyToggle.checked = getQueryFlag("turnOnly", 0);
  dom.tcpOnlyToggle.checked = getQueryFlag("tcpOnly", 0);
}

(function bootstrap() {
  bindEvents();
  applyInitialFlags();
  const unlocked = hasAccess();
  togglePanels(unlocked);
  if (!unlocked) {
    return;
  }
  initPeer().then(() => {
    scheduleLoops();
  });
})();
