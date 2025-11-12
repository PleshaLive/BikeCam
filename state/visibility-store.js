import { ENV } from '/shared/env.js';

const listeners = new Set();
let map = {}; // { [id]: true|false }
let ws;

function applyState(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const state = payload.state || payload.visibility || payload;
  if (!state || typeof state !== 'object') {
    return;
  }
  const hidden = state.hidden && typeof state.hidden === 'object' ? state.hidden : {};
  const next = {};
  Object.entries(hidden).forEach(([rawKey, rawValue]) => {
    if (!rawKey) {
      return;
    }
    const key = String(rawKey);
    next[key] = rawValue === true ? false : true;
  });
  map = next;
  notify();
}

function applyLegacyUpdate(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const id = payload.id ?? payload.slotId ?? payload.playerId;
  if (!id) {
    return;
  }
  map[String(id)] = Boolean(payload.visible);
  notify();
}

export async function loadVisibility() {
  try {
    const response = await fetch(`${ENV.API_BASE}/api/visibility`);
    if (response.ok) {
      const data = await response.json();
      applyState(data);
    }
  } catch (
    _error
  ) {
    // ignore fetch errors
  }
  try {
    ws = new WebSocket(`${ENV.WS_BASE}/ws`);
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'VISIBILITY_STATE') {
          applyState(message.state || message);
        } else if (message.type === 'visibility.update') {
          if (message.state) {
            applyState(message.state);
          } else {
            applyLegacyUpdate(message);
          }
        }
      } catch (
        _parseError
      ) {
        // ignore malformed payloads
      }
    };
  } catch (
    _error
  ) {
    // ignore websocket errors
  }
}

export function getVisible(id) {
  return map[id] !== false;
}

export async function setVisible(id, visible) {
  map[id] = !!visible;
  notify();
  try {
    await fetch(`${ENV.API_BASE}/api/visibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, visible }),
    });
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: 'visibility.set', id, visible }));
    }
  } catch (
    _error
  ) {
    // ignore set failures; local state already updated
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  listeners.forEach((fn) => fn(map));
}
