const TURN_KEY_STORAGE = "admin.turnKey";

function safeWindow() {
  try {
    return typeof window === "undefined" ? null : window;
  } catch (error) {
    return null;
  }
}

function getRuntimeEnv() {
  const w = safeWindow();
  if (!w) {
    return {};
  }
  const envSources = [w.__ENV__, w.__env__, w.__APP_ENV__, w.__CONFIG__].filter(Boolean);
  if (!envSources.length) {
    return {};
  }
  return Object.assign({}, ...envSources);
}

function coerceString(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }
  const str = String(value).trim();
  return str ? str : fallback;
}

function coerceBoolean(value, fallback = false) {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const str = String(value).trim().toLowerCase();
  if (!str) {
    return fallback;
  }
  if (str === "1" || str === "true" || str === "yes" || str === "on") {
    return true;
  }
  if (str === "0" || str === "false" || str === "no" || str === "off") {
    return false;
  }
  return fallback;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function resolveLocationOrigin() {
  const w = safeWindow();
  if (!w) {
    return "";
  }
  try {
    return coerceString(w.location?.origin, "");
  } catch (error) {
    return "";
  }
}

function readStorage(key) {
  const w = safeWindow();
  if (!w || !w.localStorage) {
    return null;
  }
  try {
    return w.localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function writeStorage(key, value) {
  const w = safeWindow();
  if (!w || !w.localStorage) {
    return;
  }
  try {
    if (value === null || value === undefined) {
      w.localStorage.removeItem(key);
    } else {
      w.localStorage.setItem(key, value);
    }
  } catch (error) {
    // ignore storage failures
  }
}

function readQueryParams() {
  const w = safeWindow();
  if (!w) {
    return new URLSearchParams();
  }
  try {
    return new URL(w.location.href).searchParams;
  } catch (error) {
    return new URLSearchParams();
  }
}

const runtimeEnv = getRuntimeEnv();
const query = readQueryParams();

function resolveApiBase() {
  const preferred = coerceString(runtimeEnv.API_BASE || runtimeEnv.apiBase || safeWindow()?.API_BASE);
  if (preferred) {
    return stripTrailingSlash(preferred);
  }
  const origin = resolveLocationOrigin();
  if (origin) {
    return stripTrailingSlash(origin);
  }
  return "https://bikecam.onrender.com";
}

function resolveWsBase(apiBase) {
  const explicit = coerceString(runtimeEnv.WS_BASE || runtimeEnv.wsBase || safeWindow()?.WS_BASE);
  if (explicit) {
    return stripTrailingSlash(explicit);
  }
  if (apiBase.startsWith("https://")) {
    try {
      const url = new URL(apiBase);
      url.protocol = "wss:";
      return stripTrailingSlash(url.origin);
    } catch (error) {
      return "wss://bikecam.onrender.com";
    }
  }
  if (apiBase.startsWith("http://")) {
    try {
      const url = new URL(apiBase);
      url.protocol = "ws:";
      return stripTrailingSlash(url.origin);
    } catch (error) {
      return "ws://localhost:3000";
    }
  }
  const origin = resolveLocationOrigin();
  if (origin) {
    try {
      const url = new URL(origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return stripTrailingSlash(url.origin);
    } catch (error) {
      return "wss://bikecam.onrender.com";
    }
  }
  return "wss://bikecam.onrender.com";
}

function resolveTurnKey() {
  const fromQuery = coerceString(query.get("turnKey") || query.get("turn_key") || query.get("key"));
  if (fromQuery) {
    persistTurnKey(fromQuery);
    return fromQuery;
  }
  const envKey = coerceString(runtimeEnv.TURN_ADMIN_KEY || runtimeEnv.turnAdminKey || safeWindow()?.TURN_ADMIN_KEY);
  if (envKey) {
    persistTurnKey(envKey);
    return envKey;
  }
  const stored = coerceString(readStorage(TURN_KEY_STORAGE));
  if (stored) {
    return stored;
  }
  return "";
}

function resolveForceTurnDefault() {
  if (query.has("forceTurn")) {
    return coerceBoolean(query.get("forceTurn"), false);
  }
  return coerceBoolean(runtimeEnv.PUBLIC_FORCE_TURN_DEFAULT || runtimeEnv.forceTurnDefault, false);
}

function persistTurnKey(value) {
  if (!value) {
    writeStorage(TURN_KEY_STORAGE, "");
    return;
  }
  writeStorage(TURN_KEY_STORAGE, value);
  const w = safeWindow();
  if (w) {
    w.__TURN_ADMIN_KEY = value;
  }
}

const API_BASE = resolveApiBase();
const WS_BASE = resolveWsBase(API_BASE);
let turnAdminKey = resolveTurnKey();

export const PUBLIC_FORCE_TURN_DEFAULT = resolveForceTurnDefault();
export { API_BASE, WS_BASE };

export function getTurnAdminKey() {
  return turnAdminKey;
}

export function setTurnAdminKey(nextKey) {
  const value = coerceString(nextKey);
  if (value && value === turnAdminKey) {
    return turnAdminKey;
  }
  turnAdminKey = value;
  persistTurnKey(value);
  return turnAdminKey;
}

export function buildApiUrl(path) {
  const base = API_BASE;
  if (!path) {
    return base;
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}

export function buildWsUrl(path) {
  const base = WS_BASE;
  if (!path) {
    return base;
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}

export function readBooleanQueryFlag(name, fallback = false) {
  if (!name) {
    return fallback;
  }
  if (!query.has(name)) {
    return fallback;
  }
  return coerceBoolean(query.get(name), fallback);
}

export function readNumericQuery(name, fallback = 0) {
  if (!name) {
    return fallback;
  }
  const raw = query.get(name);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function ensureTurnKey(key) {
  if (key) {
    setTurnAdminKey(key);
  }
  return getTurnAdminKey();
}

export function resetStoredTurnKey() {
  setTurnAdminKey("");
}
