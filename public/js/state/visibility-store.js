const VISIBILITY_SECTIONS = ["hidden", "quality", "forceTurn", "codec"];
const QUALITY_PRESETS = new Set(["low", "mid", "high"]);
const TRANSPORT_PRESETS = new Set(["auto", "udp", "tcp"]);
const CODEC_PRESETS = new Set(["default", "h264", "vp8"]);

function normalizeKey(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const key = String(value).trim();
  return key ? key : null;
}

function ensureState(input) {
  const base = input && typeof input === "object" ? { ...input } : {};
  VISIBILITY_SECTIONS.forEach((section) => {
    const bucket = base[section];
    base[section] = bucket && typeof bucket === "object" ? { ...bucket } : {};
  });
  return base;
}

function normalizeQuality(value) {
  const preset = typeof value === "string" ? value.trim().toLowerCase() : "";
  return QUALITY_PRESETS.has(preset) ? preset : null;
}

function normalizeTransport(value) {
  const preset = typeof value === "string" ? value.trim().toLowerCase() : "";
  return TRANSPORT_PRESETS.has(preset) ? preset : null;
}

function normalizeCodec(value) {
  const preset = typeof value === "string" ? value.trim().toLowerCase() : "";
  return CODEC_PRESETS.has(preset) ? preset : null;
}

function mergeState(target, delta) {
  const next = ensureState(target);
  let changed = false;

  if (!delta || typeof delta !== "object") {
    return { state: next, changed };
  }

  VISIBILITY_SECTIONS.forEach((section) => {
    const patch = delta[section];
    if (!patch || typeof patch !== "object") {
      return;
    }

    const bucket = next[section];
    Object.entries(patch).forEach(([rawKey, rawValue]) => {
      const key = normalizeKey(rawKey);
      if (!key) {
        return;
      }

      let normalizedValue;
      if (section === "hidden") {
        normalizedValue = rawValue === null ? null : Boolean(rawValue);
      } else if (section === "quality") {
        normalizedValue = rawValue === null ? null : normalizeQuality(rawValue);
      } else if (section === "forceTurn") {
        normalizedValue = rawValue === null ? null : normalizeTransport(rawValue);
      } else if (section === "codec") {
        normalizedValue = rawValue === null ? null : normalizeCodec(rawValue);
      }

      if (normalizedValue === undefined) {
        return;
      }

      if (normalizedValue === null) {
        if (Object.prototype.hasOwnProperty.call(bucket, key)) {
          delete bucket[key];
          changed = true;
        }
        return;
      }

      if (bucket[key] !== normalizedValue) {
        bucket[key] = normalizedValue;
        changed = true;
      }
    });
  });

  return { state: next, changed };
}

function statesEqual(a, b) {
  const left = ensureState(a);
  const right = ensureState(b);

  return VISIBILITY_SECTIONS.every((section) => {
    const leftBucket = left[section];
    const rightBucket = right[section];
    const leftKeys = Object.keys(leftBucket);
    const rightKeys = Object.keys(rightBucket);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every((key) => rightBucket[key] === leftBucket[key]);
  });
}

function coerceLegacyDelta(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(payload, "id") && Object.prototype.hasOwnProperty.call(payload, "visible")) {
    const key = normalizeKey(payload.id);
    if (!key) {
      return null;
    }
    const visible = Boolean(payload.visible);
    return {
      hidden: {
        [key]: visible ? null : true,
      },
    };
  }

  return null;
}

export class VisibilityStore {
  constructor({ fetchInitial, pushUpdate, onRemoteUpdate } = {}) {
    this._state = ensureState({});
    this._listeners = new Set();
    this._fetchInitial = typeof fetchInitial === "function" ? fetchInitial : async () => ({});
    this._pushUpdate = typeof pushUpdate === "function" ? pushUpdate : async () => ({ ok: true });
    this._ready = false;
    this._remoteCleanup = null;
    this._readyPromise = this._bootstrap();

    if (typeof onRemoteUpdate === "function") {
      const handler = (payload) => this._handleRemote(payload);
      const cleanup = onRemoteUpdate(handler);
      if (typeof cleanup === "function") {
        this._remoteCleanup = cleanup;
      }
    }
  }

  async _bootstrap() {
    try {
      const payload = await this._fetchInitial();
      const state = payload && typeof payload === "object" ? payload.state || payload.visibility || payload.map || payload : {};
      this._replaceState(state);
    } catch (error) {
      // ignore bootstrap errors; store stays empty
    } finally {
      this._ready = true;
      this._notify();
    }
  }

  async ready() {
    return this._readyPromise;
  }

  destroy() {
    if (this._remoteCleanup) {
      try {
        this._remoteCleanup();
      } catch (error) {
        // ignore cleanup errors
      }
    }
    this._remoteCleanup = null;
    this._listeners.clear();
  }

  snapshot() {
    return {
      hidden: { ...this._state.hidden },
      quality: { ...this._state.quality },
      forceTurn: { ...this._state.forceTurn },
      codec: { ...this._state.codec },
    };
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }
    this._listeners.add(listener);
    if (this._ready) {
      try {
        listener(this.snapshot());
      } catch (error) {
        // ignore subscriber errors
      }
    }
    return () => {
      this._listeners.delete(listener);
    };
  }

  isHidden(id, state = this._state) {
    const key = normalizeKey(id);
    if (!key) {
      return false;
    }
    return Boolean(state.hidden?.[key]);
  }

  getVisibility(id, state = this._state) {
    const key = normalizeKey(id);
    if (!key) {
      return {
        hidden: false,
        quality: null,
        forceTurn: null,
        codec: null,
      };
    }
    return {
      hidden: Boolean(state.hidden?.[key]),
      quality: state.quality?.[key] ?? null,
      forceTurn: state.forceTurn?.[key] ?? null,
      codec: state.codec?.[key] ?? null,
    };
  }

  async set(id, visible) {
    const shouldHide = !Boolean(visible);
    await this.setHidden(id, shouldHide);
  }

  async setHidden(id, hidden) {
    const key = normalizeKey(id);
    if (!key) {
      return;
    }
    const delta = {
      hidden: {
        [key]: hidden ? true : null,
      },
    };
    this._applyDelta(delta);
    await this._pushUpdateSafe(delta);
  }

  async updateSection(section, key, value) {
    if (!VISIBILITY_SECTIONS.includes(section)) {
      return;
    }
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey) {
      return;
    }
    const delta = {
      [section]: {
        [normalizedKey]: value,
      },
    };
    this._applyDelta(delta);
    await this._pushUpdateSafe(delta);
  }

  _applyDelta(delta) {
    const { state, changed } = mergeState(this._state, delta);
    if (changed) {
      this._state = state;
      this._notify(delta);
    }
  }

  _replaceState(nextState) {
    const normalized = ensureState(nextState);
    if (statesEqual(this._state, normalized)) {
      return;
    }
    this._state = normalized;
    this._notify(normalized);
  }

  async _pushUpdateSafe(delta) {
    try {
      await this._pushUpdate(delta);
    } catch (error) {
      console.warn("[visibility] push failed", { delta, error });
    }
  }

  _handleRemote(payload) {
    if (!payload || typeof payload !== "object") {
      return;
    }

    if (payload.state && typeof payload.state === "object") {
      this._replaceState(payload.state);
      return;
    }

    if (payload.delta && typeof payload.delta === "object") {
      this._applyDelta(payload.delta);
      return;
    }

    const legacy = coerceLegacyDelta(payload);
    if (legacy) {
      this._applyDelta(legacy);
    }
  }

  _notify(extra) {
    const snapshot = this.snapshot();
    this._listeners.forEach((listener) => {
      try {
        listener(snapshot, extra);
      } catch (error) {
        // ignore subscriber errors
      }
    });
  }
}

export default VisibilityStore;
