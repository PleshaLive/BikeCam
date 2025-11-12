import { ENV } from '/shared/env.js';
import {
  setAdminKey,
  fetchTurnCreds,
  getTurnState,
  clearTurnState,
} from '/webrtc/turn.js';
import { createReceiverPC } from '/webrtc/pc-factory.js';
import { attachStatsPanel } from '/diag/stats-panel.js';

const RETRY_MS = 30_000;
const TURN_MARGIN_MS = 5 * 60 * 1_000;

const tileTemplate = document.getElementById('tileTemplate');

const dom = {
  tiles: document.getElementById('tiles'),
  empty: document.getElementById('emptyHint'),
  alert: document.getElementById('alertBanner'),
  kRelays: document.getElementById('kpiRelays'),
  kBitrate: document.getElementById('kpiBitrate'),
  kRtt: document.getElementById('kpiRtt'),
  kRefresh: document.getElementById('kpiRefresh'),
  tokenAge: document.getElementById('tokenAge'),
  applyKey: document.getElementById('applyTurnKeyBtn'),
  keyInput: document.getElementById('turnKeyInput'),
  refreshTurn: document.getElementById('refreshTurnBtn'),
  forceTurn: document.getElementById('forceTurnOnly'),
  globalMaxBr: document.getElementById('globalMaxBr'),
  reconnectAll: document.getElementById('reconnectAll'),
  freezeAll: document.getElementById('freezeAll'),
  resumeAll: document.getElementById('resumeAll'),
  toggleDebug: document.getElementById('toggleDebug'),
  refreshRoster: document.getElementById('refreshRoster'),
  muteAll: document.getElementById('muteAllBtn'),
  unmuteAll: document.getElementById('unmuteAllBtn'),
};

const alerts = new Map();
const apiHealth = { roster: true, visibility: true };

const state = {
  roster: [],
  visibility: new Map(),
  tiles: new Map(),
  turnTimer: null,
  tokenTicker: null,
  debug: false,
  lastRosterFetch: null,
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    init().catch((error) => console.error('admin init failed', error));
  });
} else {
  init().catch((error) => console.error('admin init failed', error));
}

async function init() {
  if (!tileTemplate) {
    console.error('Tile template missing');
    return;
  }
  setupEvents();
  hydrateTurnKey();
  updateTokenAge();
  await Promise.allSettled([ensureTurn(), loadVisibility(), loadRoster()]);
  updateEmptyState();
}

function setupEvents() {
  dom.applyKey?.addEventListener('click', async () => {
    const key = dom.keyInput.value.trim();
    localStorage.setItem('admin.turnKey', key);
    setAdminKey(key);
    clearTurnState();
    await ensureTurn(true);
    restartAllTiles();
  });

  dom.refreshTurn?.addEventListener('click', async () => {
    await ensureTurn(true);
    restartAllTiles();
  });

  dom.forceTurn?.addEventListener('change', () => {
    state.tiles.forEach((tile) => {
      if (tile.pc?.__applyTurnOnly) {
        tile.pc.__applyTurnOnly(!!dom.forceTurn.checked).catch?.(() => {});
      }
    });
  });

  dom.globalMaxBr?.addEventListener('change', () => {
    state.tiles.forEach((tile) => {
      if (tile.pc?.__setMaxKbps) {
        tile.pc.__setMaxKbps(dom.globalMaxBr.value);
      }
    });
  });

  dom.reconnectAll?.addEventListener('click', () => {
    state.tiles.forEach((tile) => restartTile(tile));
  });

  dom.freezeAll?.addEventListener('click', () => {
    state.tiles.forEach((tile) => setTilePaused(tile, true));
  });

  dom.resumeAll?.addEventListener('click', () => {
    state.tiles.forEach((tile) => setTilePaused(tile, false));
  });

  dom.muteAll?.addEventListener('click', () => {
    state.tiles.forEach((tile) => setTileMuted(tile, true));
  });

  dom.unmuteAll?.addEventListener('click', () => {
    state.tiles.forEach((tile) => setTileMuted(tile, false));
  });

  dom.toggleDebug?.addEventListener('click', () => {
    state.debug = !state.debug;
    updateDebugState();
  });

  dom.refreshRoster?.addEventListener('click', () => {
    loadVisibility();
    loadRoster();
  });
}

function hydrateTurnKey() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('turnKey') || params.get('key');
  const stored = localStorage.getItem('admin.turnKey');
  const key = (fromUrl || stored || '').trim();
  if (key) {
    dom.keyInput.value = key;
    setAdminKey(key);
  }
}

async function ensureTurn(force = false) {
  const key = dom.keyInput.value.trim();
  if (!key) {
    setAlert('danger', 'TURN CREDS ERROR');
    return false;
  }
  setAdminKey(key);
  const current = getTurnState();
  if (!force && current && current.expAt - TURN_MARGIN_MS > Date.now()) {
    startTokenTicker();
    clearAlert('danger');
    return true;
  }
  try {
    const token = await fetchTurnCreds();
    clearAlert('danger');
    scheduleTurnRefresh(token);
    startTokenTicker();
    localStorage.setItem('admin.turnKey', key);
    return true;
  } catch (error) {
    console.error('TURN fetch failed', error);
    setAlert('danger', 'TURN CREDS ERROR');
    if (state.turnTimer) {
      clearTimeout(state.turnTimer);
    }
    state.turnTimer = setTimeout(() => ensureTurn(true), RETRY_MS);
    return false;
  }
}

function scheduleTurnRefresh(info) {
  if (state.turnTimer) {
    clearTimeout(state.turnTimer);
  }
  if (!info) {
    return;
  }
  const delay = Math.max(30_000, info.expAt - Date.now() - TURN_MARGIN_MS);
  state.turnTimer = setTimeout(() => ensureTurn(true), delay);
}

function startTokenTicker() {
  if (state.tokenTicker) {
    clearInterval(state.tokenTicker);
  }
  state.tokenTicker = setInterval(updateTokenAge, 1_000);
  updateTokenAge();
}

function updateTokenAge() {
  const token = getTurnState();
  if (!token) {
    if (dom.tokenAge) {
      dom.tokenAge.textContent = 'age: --m • left: --m';
      dom.tokenAge.dataset.level = 'idle';
    }
    return;
  }
  const ageMinutes = Math.floor((Date.now() - token.ageStart) / 60_000);
  const leftMinutes = Math.max(0, Math.floor((token.expAt - Date.now()) / 60_000));
  if (dom.tokenAge) {
    dom.tokenAge.textContent = `age: ${ageMinutes}m • left: ${leftMinutes}m`;
    const level = leftMinutes <= 1 ? 'danger' : leftMinutes <= 5 ? 'warn' : 'ok';
    dom.tokenAge.dataset.level = level;
  }
}

async function loadRoster() {
  try {
    const response = await fetch(`${ENV.API_BASE}/api/admin/cameras`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`roster HTTP ${response.status}`);
    }
    const payload = await response.json();
    state.roster = normaliseRoster(payload);
    state.lastRosterFetch = Date.now();
    apiHealth.roster = true;
    updateApiAlert();
    renderRoster();
    updateRefreshTime();
    updateKpis();
  } catch (error) {
    console.error('Roster fetch failed', error);
    apiHealth.roster = false;
    updateApiAlert();
    setTimeout(loadRoster, RETRY_MS);
  }
}

async function loadVisibility() {
  try {
    const response = await fetch(`${ENV.API_BASE}/api/visibility`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`visibility HTTP ${response.status}`);
    }
    const payload = await response.json();
    let rawEntries = [];
    if (Array.isArray(payload)) {
      rawEntries = payload.map((item) => [item.id ?? item.cameraId ?? item.slot ?? '', item]);
    } else if (payload && typeof payload === 'object') {
      if (Array.isArray(payload.map)) {
        rawEntries = payload.map.map((item) => [item.id ?? item.cameraId ?? '', item]);
      } else if (Array.isArray(payload.visibility)) {
        rawEntries = payload.visibility.map((item) => [item.id ?? item.cameraId ?? '', item]);
      } else if (payload.visibility && typeof payload.visibility === 'object') {
        rawEntries = Object.entries(payload.visibility);
      } else if (payload.map && typeof payload.map === 'object') {
        rawEntries = Object.entries(payload.map);
      } else {
        rawEntries = Object.entries(payload);
      }
    }
    const normalized = rawEntries
      .map(([id, value]) => {
        const key = String(id || '').trim();
        if (!key) {
          return null;
        }
        if (typeof value === 'boolean') {
          return [key, value];
        }
        if (value && typeof value === 'object') {
          return [key, value.visible !== false];
        }
        return [key, value !== false];
      })
      .filter(Boolean);
    state.visibility = new Map(normalized);
    apiHealth.visibility = true;
    updateApiAlert();
    updateVisibilityForTiles();
  } catch (error) {
    console.error('Visibility fetch failed', error);
    apiHealth.visibility = false;
    updateApiAlert();
    setTimeout(loadVisibility, RETRY_MS);
  }
}

function updateApiAlert() {
  if (apiHealth.roster && apiHealth.visibility) {
    clearAlert('warn');
  } else {
    setAlert('warn', 'API UNREACHABLE');
  }
}

function renderRoster() {
  const seen = new Set();
  state.roster.forEach((entry) => {
    const id = entry.id;
    if (!id) {
      return;
    }
    seen.add(id);
    const existing = state.tiles.get(id);
    if (existing) {
      existing.info = entry;
      updateTileHeader(existing);
      updateVisibilityButton(existing);
      if (entry.quality && existing.buttons.quality) {
        existing.quality = entry.quality;
        if ([...existing.buttons.quality.options].some((opt) => opt.value === entry.quality)) {
          existing.buttons.quality.value = entry.quality;
        }
      }
      const nextFallback = entry.fallback === 'mjpeg' ? 'mjpeg' : 'off';
      if (existing.fallback !== nextFallback) {
        existing.fallback = nextFallback;
        updateFallbackButton(existing);
        restartTile(existing);
      }
    } else {
      const tile = createTile(entry);
      state.tiles.set(id, tile);
      dom.tiles.appendChild(tile.el);
      startTile(tile);
    }
  });

  state.tiles.forEach((tile, id) => {
    if (!seen.has(id)) {
      destroyTile(tile, true);
      state.tiles.delete(id);
    }
  });

  updateEmptyState();
}

function createTile(entry) {
  const fragment = tileTemplate.content.firstElementChild.cloneNode(true);
  const video = fragment.querySelector('video');
  const tile = {
    id: entry.id,
    info: entry,
    el: fragment,
    video,
    buttons: {
      focus: fragment.querySelector('button[data-act="focus"]'),
      reconnect: fragment.querySelector('button[data-act="reconnect"]'),
      quality: fragment.querySelector('select[data-act="quality"]'),
      visibility: fragment.querySelector('button[data-act="visibility"]'),
      fallback: fragment.querySelector('button[data-act="fallback"]'),
    },
    pc: null,
    statsDetach: null,
    stats: null,
    stream: null,
    retryHandle: null,
    quality: entry.quality || 'auto',
    fallback: entry.fallback === 'mjpeg' ? 'mjpeg' : 'off',
    muted: true,
  };

  updateTileHeader(tile);
  updateFallbackButton(tile);
  updateVisibilityButton(tile);
  if (tile.buttons.quality) {
    if ([...tile.buttons.quality.options].some((opt) => opt.value === tile.quality)) {
      tile.buttons.quality.value = tile.quality;
    } else {
      tile.buttons.quality.value = 'auto';
      tile.quality = 'auto';
    }
  }

  tile.buttons.focus?.addEventListener('click', () => focusTile(tile));
  tile.buttons.reconnect?.addEventListener('click', () => restartTile(tile));
  tile.buttons.visibility?.addEventListener('click', () => toggleVisibility(tile));
  tile.buttons.fallback?.addEventListener('click', () => toggleFallback(tile));
  tile.buttons.quality?.addEventListener('change', (event) => {
    const preset = event.target.value;
    setTileQuality(tile, preset);
  });

  updateDebugState();

  return tile;
}

function updateTileHeader(tile) {
  const titleNode = tile.el.querySelector('.tile-title');
  const name = tile.info.name || tile.info.nickname || tile.info.id;
  if (titleNode) {
    titleNode.textContent = name;
  }
  tile.el.dataset.id = tile.id;
}

function updateEmptyState() {
  if (!dom.empty) {
    return;
  }
  dom.empty.style.display = state.tiles.size ? 'none' : 'block';
}

function updateRefreshTime() {
  if (!dom.kRefresh) {
    return;
  }
  dom.kRefresh.textContent = state.lastRosterFetch ? new Date(state.lastRosterFetch).toLocaleTimeString() : '--';
}

async function startTile(tile) {
  clearTimeout(tile.retryHandle);
  tile.retryHandle = null;

  if (tile.fallback === 'mjpeg') {
    destroyPeer(tile);
    tile.el.dataset.fallback = 'mjpeg';
    tile.video.srcObject = null;
    tile.video.load();
    return;
  }

  const turnReady = await ensureTurn();
  if (!turnReady) {
    scheduleTileRetry(tile);
    return;
  }

  destroyPeer(tile);
  tile.el.dataset.fallback = 'off';

  const pc = createReceiverPC({
    forceTurnOnly: !!dom.forceTurn?.checked,
    maxKbps: dom.globalMaxBr?.value || 'Auto',
    onTrack: (stream) => handleTrack(tile, stream),
  });

  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      scheduleTileRetry(tile);
    }
  });

  tile.pc = pc;
  tile.statsDetach = attachStatsPanel({
    pc,
    video: tile.video,
    hostEl: tile.el,
    onStats: (stats) => {
      tile.stats = stats;
      updateKpis();
    },
  });
  updateDebugState();

  try {
    const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    const response = await fetch(`${ENV.API_BASE}/api/webrtc/viewer/answer?id=${encodeURIComponent(tile.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offer.sdp,
    });
    if (!response.ok) {
      throw new Error(`answer HTTP ${response.status}`);
    }
    const answerSdp = await response.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  } catch (error) {
    console.error('Negotiation failed', error);
    setAlert('warn', 'NEGOTIATION ERROR');
    scheduleTileRetry(tile);
  }
}

function handleTrack(tile, stream) {
  if (tile.stream && tile.stream !== stream) {
    tile.stream.getTracks().forEach((track) => track.stop());
  }
  tile.stream = stream;
  tile.video.srcObject = stream;
  setTileMuted(tile, tile.muted);
  tile.video.play().catch(() => {});
}

function scheduleTileRetry(tile) {
  if (tile.retryHandle) {
    return;
  }
  tile.retryHandle = setTimeout(() => startTile(tile), RETRY_MS);
}

function restartTile(tile) {
  destroyPeer(tile);
  startTile(tile);
}

function destroyPeer(tile) {
  if (tile.statsDetach) {
    tile.statsDetach();
    tile.statsDetach = null;
  }
  if (tile.pc) {
    try {
      tile.pc.close();
    } catch (error) {
      console.warn('pc close error', error);
    }
    tile.pc = null;
  }
  if (tile.stream) {
    tile.stream.getTracks().forEach((track) => track.stop());
    tile.stream = null;
  }
  tile.video.srcObject = null;
  tile.video.load();
  tile.stats = null;
  updateKpis();
}

function destroyTile(tile, removeElement) {
  clearTimeout(tile.retryHandle);
  tile.retryHandle = null;
  destroyPeer(tile);
  if (removeElement) {
    tile.el.remove();
  }
  updateKpis();
}

function focusTile(tile) {
  tile.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function setTileMuted(tile, muted) {
  tile.muted = muted;
  tile.video.muted = muted;
  if (tile.stream) {
    tile.stream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }
}

function setTilePaused(tile, paused) {
  if (!tile.pc) {
    return;
  }
  tile.pc.getTransceivers().forEach((transceiver) => {
    if (transceiver.receiver?.track?.kind === 'video') {
      try {
        transceiver.direction = paused ? 'inactive' : 'recvonly';
      } catch (error) {
        console.warn('transceiver direction error', error);
      }
    }
  });
  if (paused) {
    tile.video.pause();
  } else {
    tile.video.play().catch(() => {});
  }
}

async function setTileQuality(tile, preset) {
  const prev = tile.quality;
  tile.quality = preset;
  tile.buttons.quality.value = preset;
  try {
    await fetch(`${ENV.API_BASE}/api/admin/quality/${encodeURIComponent(tile.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset }),
    });
  } catch (error) {
    console.error('Quality update failed', error);
    setAlert('warn', 'API UNREACHABLE');
    tile.quality = prev;
    tile.buttons.quality.value = prev;
  }
}

async function toggleVisibility(tile) {
  const visible = state.visibility.get(tile.id) !== false;
  const nextVisible = !visible;
  try {
    await fetch(`${ENV.API_BASE}/api/visibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: tile.id, visible: nextVisible }),
    });
    state.visibility.set(tile.id, nextVisible);
    updateVisibilityButton(tile);
  } catch (error) {
    console.error('Visibility update failed', error);
    setAlert('warn', 'API UNREACHABLE');
  }
}

function updateVisibilityForTiles() {
  state.tiles.forEach((tile) => updateVisibilityButton(tile));
}

function updateVisibilityButton(tile) {
  const visible = state.visibility.get(tile.id) !== false;
  tile.el.classList.toggle('tile-hidden', !visible);
  if (tile.buttons.visibility) {
    tile.buttons.visibility.textContent = visible ? 'HIDE IN MAIN' : 'SHOW IN MAIN';
  }
}

async function toggleFallback(tile) {
  const next = tile.fallback === 'mjpeg' ? 'off' : 'mjpeg';
  const prev = tile.fallback;
  try {
    await fetch(`${ENV.API_BASE}/api/admin/fallback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: tile.id, mode: next }),
    });
    tile.fallback = next;
    updateFallbackButton(tile);
    restartTile(tile);
  } catch (error) {
    console.error('Fallback toggle failed', error);
    setAlert('warn', 'API UNREACHABLE');
    tile.fallback = prev;
    updateFallbackButton(tile);
  }
}

function updateFallbackButton(tile) {
  if (tile.buttons.fallback) {
    tile.buttons.fallback.textContent = tile.fallback === 'mjpeg' ? 'FALLBACK: MJPEG' : 'FALLBACK: OFF';
  }
  tile.el.dataset.fallback = tile.fallback;
}

function updateDebugState() {
  const display = state.debug ? 'block' : 'none';
  state.tiles.forEach((tile) => {
    tile.el.querySelectorAll('.debug').forEach((node) => {
      node.style.display = display;
    });
  });
}

function restartAllTiles() {
  state.tiles.forEach((tile) => restartTile(tile));
}

function updateKpis() {
  let relayCount = 0;
  let bitrateTotal = 0;
  let bitrateSamples = 0;
  let rttTotal = 0;
  let rttSamples = 0;

  state.tiles.forEach((tile) => {
    if (!tile.stats) {
      return;
    }
    if (tile.stats.bitrate) {
      bitrateTotal += tile.stats.bitrate;
      bitrateSamples += 1;
    }
    if (tile.stats.relay) {
      relayCount += 1;
    }
    if (tile.stats.rtt) {
      rttTotal += tile.stats.rtt;
      rttSamples += 1;
    }
  });

  if (dom.kRelays) {
    dom.kRelays.textContent = String(relayCount);
  }
  if (dom.kBitrate) {
    dom.kBitrate.textContent = bitrateSamples ? `${Math.round(bitrateTotal)} kbps` : '--';
  }
  if (dom.kRtt) {
    dom.kRtt.textContent = rttSamples ? `${Math.round(rttTotal / rttSamples)} ms` : '--';
  }
}

function setAlert(level, message) {
  alerts.set(level, message);
  renderAlert();
}

function clearAlert(level) {
  alerts.delete(level);
  renderAlert();
}

function renderAlert() {
  if (!dom.alert) {
    return;
  }
  let level = null;
  if (alerts.has('danger')) {
    level = 'danger';
  } else if (alerts.has('warn')) {
    level = 'warn';
  }
  if (!level) {
    dom.alert.className = 'alert';
    dom.alert.textContent = '';
    return;
  }
  dom.alert.className = `alert alert-${level} show`;
  dom.alert.textContent = alerts.get(level);
}

function normaliseRoster(payload) {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.cameras)
    ? payload.cameras
    : [];
  return source
    .map((item) => {
      const id = String(item.id || item.nickname || item.name || item.cameraId || '').trim();
      if (!id) {
        return null;
      }
      const quality = String(item.quality || item.preset || 'auto').toLowerCase();
      const fallback = String(item.fallback || item.mode || 'off').toLowerCase();
      return {
        id,
        name: item.name || item.nickname || id,
        slot: item.slot ?? item.observerSlot ?? null,
        quality,
        fallback,
      };
    })
    .filter(Boolean);
}
