import { fetchJson, getRetryDelay } from "./net.js";

const CAMERA_ENDPOINTS = ["/api/admin/cameras", "/api/cameras", "/api/stats"];
const GSI_ENDPOINT = "/api/gsi/state";
const TURN_ENDPOINT = "/api/webrtc/config";
const KICK_ENDPOINT = "/api/admin/kick";
const RECONNECT_ENDPOINT = "/api/admin/reconnect";
const STORAGE_KEY_FORCE_TURN = "forceTurnOnly";

const state = {
  cameras: [],
  gsi: null,
  turn: null,
  lastUpdated: null,
  retryAttempt: 0,
};

const dom = {
  message: document.getElementById("messageBox"),
  tabButtons: Array.from(document.querySelectorAll(".tab")),
  panels: Array.from(document.querySelectorAll(".panel")),
  cameraTable: document.getElementById("cameraTable"),
  cameraSummary: document.getElementById("cameraSummary"),
  gsiFocus: document.getElementById("gsiFocus"),
  gsiUpdated: document.getElementById("gsiUpdated"),
  gsiColumns: document.getElementById("gsiColumns"),
  gsiRaw: document.getElementById("gsiRaw"),
  turnTtl: document.getElementById("turnTtl"),
  turnCount: document.getElementById("turnCount"),
  turnJson: document.getElementById("turnJson"),
  diagLog: document.getElementById("diagLog"),
  statsLog: document.getElementById("statsLog"),
  forceTurnToggle: document.getElementById("forceTurnToggle"),
  refreshBtn: document.getElementById("refreshBtn"),
  reloadConfigBtn: document.getElementById("reloadConfigBtn"),
  copyConfigBtn: document.getElementById("copyConfigBtn"),
  refreshDiagBtn: document.getElementById("refreshDiagBtn"),
  downloadDiagBtn: document.getElementById("downloadDiagBtn"),
};

let refreshTimer = null;

function setMessage(text, isError = false) {
  if (!dom.message) {
    return;
  }
  dom.message.textContent = text || "";
  dom.message.classList.toggle("error", Boolean(isError));
}

function scheduleRefresh(delayMs) {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  refreshTimer = setTimeout(() => {
    loadAll(true).catch(() => {});
  }, delayMs);
}

function nowIso() {
  return new Date().toISOString();
}

async function loadAll(silent = false) {
  try {
    const [gsi, cameraPayload, turn] = await Promise.all([
      fetchGsiState(),
      fetchCameraSessions(),
      fetchTurnConfig(),
    ]);

    state.gsi = gsi;
    state.cameras = cameraPayload.cameras;
    state.turn = turn;
    state.lastUpdated = nowIso();
    state.retryAttempt = 0;

    const roster = mergePlayersWithCameras(gsi?.players || [], cameraPayload.cameras || []);

    renderCameraSummary(roster);
    renderCameraTable(roster);
    renderGsi(gsi);
    renderTurn(turn);
    if (!silent) {
      setMessage(`Refreshed at ${new Date().toLocaleTimeString()}`);
    }
    scheduleRefresh(5_000);
  } catch (error) {
    state.retryAttempt += 1;
    const delay = getRetryDelay(state.retryAttempt);
    setMessage(error.message || "Failed to refresh", true);
    scheduleRefresh(delay);
  }
}

async function fetchCameraSessions() {
  let lastError = null;
  for (const endpoint of CAMERA_ENDPOINTS) {
    try {
      const payload = await fetchJson(endpoint, { timeoutMs: 10_000 });
      if (payload && Array.isArray(payload.cameras)) {
        return {
          cameras: payload.cameras,
          updatedAt: payload.updatedAt || nowIso(),
        };
      }
      if (Array.isArray(payload)) {
        return { cameras: payload, updatedAt: nowIso() };
      }
    } catch (error) {
      lastError = error;
      if (error.status && error.status !== 404) {
        break;
      }
    }
  }
  throw lastError || new Error("Unable to load camera sessions");
}

async function fetchGsiState() {
  const payload = await fetchJson(GSI_ENDPOINT, { timeoutMs: 10_000 });
  return payload || {};
}

async function fetchTurnConfig() {
  try {
    return await fetchJson(TURN_ENDPOINT, { timeoutMs: 10_000 });
  } catch (error) {
    return null;
  }
}

function mergePlayersWithCameras(players, cameras) {
  const catalog = Array.isArray(players) ? players : [];
  const sessions = Array.isArray(cameras) ? cameras : [];
  const sessionMap = new Map();

  sessions.forEach((session) => {
    if (!session || typeof session.nickname !== "string") {
      return;
    }
    const key = session.nickname.trim().toLowerCase();
    if (!key) {
      return;
    }
    sessionMap.set(key, session);
  });

  const result = [];
  catalog.forEach((player) => {
    if (!player || typeof player.name !== "string") {
      return;
    }
    const name = player.name.trim();
    const key = name.toLowerCase();
    const session = sessionMap.get(key) || null;
    const metrics = session?.metrics || {};

    result.push({
      name,
      team: player.team || "—",
      slot: Number.isFinite(player.observer_slot) ? player.observer_slot : "—",
      status: session ? (session.status || "ONLINE") : "OFFLINE",
      forcedFallback: Boolean(session?.forcedFallback),
      fps: Number.isFinite(metrics.fps) ? metrics.fps : 0,
      bitrate: Number.isFinite(metrics.bitrateKbps) ? metrics.bitrateKbps : 0,
      nickname: session?.nickname || name,
      key,
      session,
    });
    if (session) {
      sessionMap.delete(key);
    }
  });

  sessionMap.forEach((session, key) => {
    const metrics = session?.metrics || {};
    result.push({
      name: session.nickname || key,
      team: session.team || "—",
      slot: "—",
      status: session.status || "ONLINE",
      forcedFallback: Boolean(session.forcedFallback),
      fps: Number.isFinite(metrics.fps) ? metrics.fps : 0,
      bitrate: Number.isFinite(metrics.bitrateKbps) ? metrics.bitrateKbps : 0,
      nickname: session.nickname,
      key,
      session,
    });
  });

  result.sort((a, b) => {
    const teamA = (a.team || "").toUpperCase();
    const teamB = (b.team || "").toUpperCase();
    if (teamA !== teamB) {
      return teamA.localeCompare(teamB);
    }
    const slotA = Number.isFinite(a.slot) ? a.slot : 999;
    const slotB = Number.isFinite(b.slot) ? b.slot : 999;
    if (slotA !== slotB) {
      return slotA - slotB;
    }
    return a.name.localeCompare(b.name);
  });

  return result;
}

function renderCameraSummary(rows) {
  if (!dom.cameraSummary) {
    return;
  }
  dom.cameraSummary.innerHTML = "";
  const total = rows.length;
  const online = rows.filter((row) => row.status && row.status.toUpperCase() !== "OFFLINE").length;
  const offline = total - online;

  const entries = [
    { label: "Players", value: total },
    { label: "Online", value: online },
    { label: "Offline", value: offline },
  ];

  entries.forEach((item) => {
    const card = document.createElement("div");
    card.className = "card";

    const label = document.createElement("span");
    label.textContent = item.label;
    card.appendChild(label);

    const value = document.createElement("strong");
    value.textContent = String(item.value);
    card.appendChild(value);

    dom.cameraSummary.appendChild(card);
  });
}

function renderCameraTable(rows) {
  if (!dom.cameraTable) {
    return;
  }

  dom.cameraTable.innerHTML = "";
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.textContent = "No players available";
    cell.className = "muted";
    row.appendChild(cell);
    dom.cameraTable.appendChild(row);
    return;
  }

  rows.forEach((rowData) => {
    const row = document.createElement("tr");

    const name = document.createElement("td");
    name.textContent = rowData.name;
    row.appendChild(name);

    const team = document.createElement("td");
    team.textContent = rowData.team || "—";
    row.appendChild(team);

    const slot = document.createElement("td");
    slot.textContent = rowData.slot === "—" ? "—" : String(rowData.slot);
    row.appendChild(slot);

    const status = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.classList.add(rowData.status && rowData.status.toUpperCase() === "OFFLINE" ? "offline" : "online");
    pill.textContent = rowData.status || "UNKNOWN";
    if (rowData.forcedFallback) {
      pill.textContent += " • MJPEG";
    }
    status.appendChild(pill);
    row.appendChild(status);

    const fps = document.createElement("td");
    fps.textContent = rowData.fps ? `${Math.round(rowData.fps)} fps` : "—";
    row.appendChild(fps);

    const bitrate = document.createElement("td");
    bitrate.textContent = rowData.bitrate ? `${Math.round(rowData.bitrate)} kbps` : "—";
    row.appendChild(bitrate);

    const actions = document.createElement("td");
    const container = document.createElement("div");
    container.className = "row-actions";

    const reconnectBtn = document.createElement("button");
    reconnectBtn.type = "button";
    reconnectBtn.textContent = "Reconnect";
    reconnectBtn.addEventListener("click", () => requestReconnect(rowData.nickname));
    container.appendChild(reconnectBtn);

    const kickBtn = document.createElement("button");
    kickBtn.type = "button";
    kickBtn.textContent = "Kick";
    kickBtn.className = "danger";
    kickBtn.addEventListener("click", () => requestKick(rowData.nickname));
    container.appendChild(kickBtn);

    actions.appendChild(container);
    row.appendChild(actions);

    dom.cameraTable.appendChild(row);
  });
}

function renderGsi(gsi) {
  if (!gsi) {
    dom.gsiFocus.textContent = "—";
    dom.gsiUpdated.textContent = "—";
    dom.gsiColumns.innerHTML = "";
    dom.gsiRaw.textContent = "{}";
    return;
  }

  dom.gsiFocus.textContent = gsi.currentFocus || "—";
  dom.gsiUpdated.textContent = formatTimestamp(gsi.updatedAt);

  const grouped = new Map();
  (gsi.players || []).forEach((player) => {
    const team = (player.team || "UNKNOWN").toUpperCase();
    if (!grouped.has(team)) {
      grouped.set(team, []);
    }
    grouped.get(team).push(player);
  });

  dom.gsiColumns.innerHTML = "";
  grouped.forEach((players, team) => {
    players.sort((a, b) => {
      const slotA = Number.isFinite(a.observer_slot) ? a.observer_slot : 999;
      const slotB = Number.isFinite(b.observer_slot) ? b.observer_slot : 999;
      if (slotA !== slotB) {
        return slotA - slotB;
      }
      return (a.name || "").localeCompare(b.name || "");
    });

    const wrapper = document.createElement("div");
    const heading = document.createElement("h3");
    heading.textContent = team;
    heading.style.marginBottom = "8px";
    heading.style.letterSpacing = "0.12em";
    heading.style.textTransform = "uppercase";
    heading.style.color = "var(--muted)";
    heading.style.fontSize = "0.85rem";
    wrapper.appendChild(heading);

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>Player</th><th>Slot</th></tr>";
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    players.forEach((player) => {
      const tr = document.createElement("tr");
      const nameCell = document.createElement("td");
      nameCell.textContent = player.name || player.id || "—";
      tr.appendChild(nameCell);
      const slotCell = document.createElement("td");
      slotCell.textContent = Number.isFinite(player.observer_slot) ? String(player.observer_slot) : "—";
      tr.appendChild(slotCell);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrapper.appendChild(table);
    dom.gsiColumns.appendChild(wrapper);
  });

  dom.gsiRaw.textContent = JSON.stringify(gsi.raw || {}, null, 2);
}

function renderTurn(turn) {
  if (!turn) {
    dom.turnTtl.textContent = "—";
    dom.turnCount.textContent = "—";
    dom.turnJson.textContent = "[]";
    return;
  }
  const ttl = turn.ttlSec || turn.ttl || null;
  dom.turnTtl.textContent = ttl ? `${ttl}s` : "—";
  dom.turnCount.textContent = Array.isArray(turn.iceServers) ? String(turn.iceServers.length) : "—";
  dom.turnJson.textContent = JSON.stringify(turn, null, 2);
}

function renderDiagnostics() {
  if (!dom.diagLog || !dom.statsLog) {
    return;
  }

  const diag = typeof window !== "undefined" && window.__webrtcDiag && typeof window.__webrtcDiag.dump === "function"
    ? window.__webrtcDiag.dump()
    : { events: [], stats: [] };

  dom.diagLog.innerHTML = "";
  diag.events.slice(-12).reverse().forEach((entry) => {
    const box = document.createElement("div");
    box.className = "diagnostic-entry";
    box.textContent = `${formatTimestamp(entry.timestamp)} • ${entry.type}`;
    if (entry.label) {
      box.textContent += ` (${entry.label})`;
    }
    dom.diagLog.appendChild(box);
  });

  dom.statsLog.textContent = JSON.stringify(diag.stats.slice(-10), null, 2);
}

function formatTimestamp(value) {
  if (!value) {
    return "—";
  }
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }
    return date.toLocaleString();
  } catch (error) {
    return String(value);
  }
}

async function requestKick(nickname) {
  if (!nickname) {
    return;
  }
  if (!window.confirm(`Kick camera for ${nickname}?`)) {
    return;
  }
  try {
    await fetchJson(KICK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname }),
      timeoutMs: 10_000,
    });
    setMessage(`Kick command sent to ${nickname}`);
    await loadAll(true);
  } catch (error) {
    setMessage(error.message || "Kick failed", true);
  }
}

async function requestReconnect(nickname) {
  if (!nickname) {
    return;
  }
  try {
    await fetchJson(RECONNECT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname }),
      timeoutMs: 10_000,
    });
    setMessage(`Reconnect triggered for ${nickname}`);
    await loadAll(true);
  } catch (error) {
    setMessage(error.message || "Reconnect failed", true);
  }
}

function applyForceTurnFromStorage() {
  if (!dom.forceTurnToggle) {
    return;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY_FORCE_TURN);
    dom.forceTurnToggle.checked = raw === "true";
  } catch (error) {
    dom.forceTurnToggle.checked = false;
  }
}

function handleForceTurnToggle(event) {
  const checked = Boolean(event.target?.checked);
  try {
    if (checked) {
      localStorage.setItem(STORAGE_KEY_FORCE_TURN, "true");
    } else {
      localStorage.removeItem(STORAGE_KEY_FORCE_TURN);
    }
    setMessage(checked ? "Force TURN only enabled" : "Force TURN only disabled");
  } catch (error) {
    setMessage("Unable to persist preference", true);
  }
}

async function copyTurnConfig() {
  if (!state.turn) {
    setMessage("Nothing to copy", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.turn, null, 2));
    setMessage("TURN config copied to clipboard");
  } catch (error) {
    setMessage("Clipboard is unavailable", true);
  }
}

function downloadDiagnostics() {
  const dump = typeof window !== "undefined" && window.__webrtcDiag && typeof window.__webrtcDiag.dump === "function"
    ? window.__webrtcDiag.dump()
    : { events: [], stats: [] };
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `webrtc-diag-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function bindEvents() {
  if (dom.refreshBtn) {
    dom.refreshBtn.addEventListener("click", () => loadAll().catch(() => {}));
  }
  if (dom.reloadConfigBtn) {
    dom.reloadConfigBtn.addEventListener("click", () => loadAll(true).catch(() => {}));
  }
  if (dom.copyConfigBtn) {
    dom.copyConfigBtn.addEventListener("click", () => copyTurnConfig());
  }
  if (dom.refreshDiagBtn) {
    dom.refreshDiagBtn.addEventListener("click", () => renderDiagnostics());
  }
  if (dom.downloadDiagBtn) {
    dom.downloadDiagBtn.addEventListener("click", () => downloadDiagnostics());
  }
  if (dom.forceTurnToggle) {
    dom.forceTurnToggle.addEventListener("change", handleForceTurnToggle);
  }
  dom.tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.tab;
      dom.tabButtons.forEach((tab) => tab.classList.toggle("active", tab === button));
      dom.panels.forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === target));
      if (target === "diagnostics") {
        renderDiagnostics();
      }
    });
  });
}

function init() {
  bindEvents();
  applyForceTurnFromStorage();
  loadAll().catch((error) => {
    setMessage(error.message || "Initial load failed", true);
  });
}

init();

export { mergePlayersWithCameras };
