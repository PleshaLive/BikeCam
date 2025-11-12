export class VisibilityStore {
  constructor({ fetchInitial, pushUpdate, onRemoteUpdate } = {}) {
    this._map = new Map();
    this._listeners = new Set();
    this._fetchInitial = typeof fetchInitial === "function" ? fetchInitial : async () => ({ map: {} });
    this._pushUpdate = typeof pushUpdate === "function" ? pushUpdate : async () => ({ ok: true });
    this._ready = false;
    this._readyPromise = this._bootstrap();
    this._remoteHandler = null;
    if (typeof onRemoteUpdate === "function") {
      const handler = (payload) => {
        if (!payload) {
          return;
        }
        const id = payload.id ?? payload.slotId ?? payload.playerId;
        if (!id) {
          return;
        }
        this._applyRemote(id, Boolean(payload.visible), payload);
      };
      const maybeCleanup = onRemoteUpdate(handler);
      if (typeof maybeCleanup === "function") {
        this._remoteHandler = maybeCleanup;
      }
    }
  }

  async _bootstrap() {
    try {
      const data = await this._fetchInitial();
      const map = data && typeof data === "object" ? data.map || data.visibility || data : {};
      Object.entries(map).forEach(([key, value]) => {
        if (!key) {
          return;
        }
        this._map.set(String(key), Boolean(value));
      });
    } catch (error) {
      // keep store empty on failure; callers can retry fetchInitial manually
    } finally {
      this._ready = true;
      this._notify();
    }
  }

  async ready() {
    return this._readyPromise;
  }

  destroy() {
    if (this._remoteHandler) {
      try {
        this._remoteHandler();
      } catch (error) {
        // ignore cleanup failures
      }
      this._remoteHandler = null;
    }
    this._listeners.clear();
  }

  get(id) {
    if (!id) {
      return true;
    }
    return this._map.get(String(id));
  }

  getAll() {
    return Object.fromEntries(this._map.entries());
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }
    this._listeners.add(listener);
    if (this._ready) {
      try {
        listener(this.getAll());
      } catch (error) {
        // ignore subscriber errors
      }
    }
    return () => {
      this._listeners.delete(listener);
    };
  }

  async set(id, visible) {
    if (!id) {
      return;
    }
    const key = String(id);
    const boolVisible = Boolean(visible);
    const prev = this._map.get(key);
    if (prev === boolVisible && this._ready) {
      // still propagate to backend to ensure they know admin intent
      this._pushUpdateSafe(key, boolVisible);
      return;
    }
    this._map.set(key, boolVisible);
    this._notify();
    await this._pushUpdateSafe(key, boolVisible);
  }

  _applyRemote(id, visible, payload) {
    const key = String(id);
    const boolVisible = Boolean(visible);
    const prev = this._map.get(key);
    if (prev === boolVisible && this._ready) {
      return;
    }
    this._map.set(key, boolVisible);
    this._notify(payload);
  }

  async _pushUpdateSafe(id, visible) {
    try {
      await this._pushUpdate({ id, visible });
    } catch (error) {
      // log in console but keep local state so that UI reflects choice
      console.warn("[visibility] push failed", { id, visible, error });
    }
  }

  _notify(payload) {
    const snapshot = this.getAll();
    this._listeners.forEach((listener) => {
      try {
        listener(snapshot, payload);
      } catch (error) {
        // ignore subscriber errors
      }
    });
  }
}

export default VisibilityStore;
