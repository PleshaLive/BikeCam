const REQUEST_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const FALLBACK_TTL_SEC = 120;
const PUBLIC_STUN: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302"] }];

export interface TurnConfig {
  iceServers: RTCIceServer[];
  ttl: number;
  fetchedAt: number;
  staleAt: number;
  freshUntil: number;
  degraded: boolean;
  allowOrigin: string | null;
  source: "network" | "cache" | "fallback";
  raw: unknown;
}

export interface TurnFetchOptions {
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

interface CacheEntry extends TurnConfig {}

let cache: CacheEntry | null = null;
let inFlight: Promise<TurnConfig> | null = null;

function resolveEndpoint(): string {
  const fromEnv = import.meta.env?.VITE_TURN_ENDPOINT;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return fromEnv.trim();
  }
  return "/api/turn";
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeIceServers(servers: unknown): RTCIceServer[] {
  if (!Array.isArray(servers)) {
    return [];
  }
  return servers
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const urls = (entry as RTCIceServer).urls;
      if (!urls) {
        return null;
      }
      const normalized: RTCIceServer = {
        urls,
        username: typeof (entry as RTCIceServer).username === "string" ? (entry as RTCIceServer).username : undefined,
        credential: typeof (entry as RTCIceServer).credential === "string" ? (entry as RTCIceServer).credential : undefined,
      };
      return normalized;
    })
    .filter((entry): entry is RTCIceServer => Boolean(entry));
}

function maskValue(value: string | undefined | null): string | undefined {
  if (!value) {
    return value ?? undefined;
  }
  if (value.length <= 4) {
    return "***";
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function logSummary(scope: string, payload: Record<string, unknown>) {
  console.info(`[turnClient] ${scope}`, payload);
}

function buildFallback(error: unknown): TurnConfig {
  const now = Date.now();
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  const result: TurnConfig = {
    iceServers: PUBLIC_STUN,
    ttl: FALLBACK_TTL_SEC,
    fetchedAt: now,
    staleAt: now + FALLBACK_TTL_SEC * 1_000,
    freshUntil: now + Math.max(30_000, (FALLBACK_TTL_SEC * 1_000) / 2),
    degraded: true,
    allowOrigin: null,
    source: "fallback",
    raw: { fallback: true, error: message },
  };
  logSummary("fallback", { message });
  cache = result;
  return result;
}

function cacheUsable(entry: CacheEntry | null): entry is CacheEntry {
  if (!entry) {
    return false;
  }
  return Date.now() < entry.freshUntil;
}

function setCache(entry: TurnConfig) {
  cache = entry;
}

async function fetchTurnConfig(options: TurnFetchOptions): Promise<TurnConfig> {
  const endpoint = resolveEndpoint();
  let attempt = 0;
  let lastError: unknown = null;

  while (attempt < MAX_ATTEMPTS) {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    attempt += 1;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const external = options.signal;
    const abortHandler = () => controller.abort();
    external?.addEventListener("abort", abortHandler, { once: true });

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });

      clearTimeout(timeout);
      external?.removeEventListener("abort", abortHandler);

      if (!response.ok) {
        throw new Error(`TURN endpoint responded with HTTP ${response.status}`);
      }

      const allowOrigin = response.headers.get("access-control-allow-origin");
      const data = await response.json();
      const iceServers = sanitizeIceServers(data?.iceServers);
      const ttl = Number.isFinite(Number(data?.ttl)) && Number(data.ttl) > 0 ? Number(data.ttl) : 3600;
      const now = Date.now();
      const entry: TurnConfig = {
        iceServers: iceServers.length ? iceServers : PUBLIC_STUN,
        ttl,
        fetchedAt: now,
        staleAt: now + ttl * 1_000,
        freshUntil: now + Math.max(30_000, (ttl * 1_000) / 2),
        degraded: !iceServers.length,
        allowOrigin,
        source: "network",
        raw: data,
      };

      const masked = iceServers.map((server) => ({
        urls: server.urls,
        username: maskValue(server.username),
        credential: server.credential ? "***masked***" : undefined,
      }));
      logSummary("success", {
        ttl,
        degraded: entry.degraded,
        allowOrigin,
        servers: masked,
      });

      setCache(entry);
      return entry;
    } catch (error) {
      clearTimeout(timeout);
      external?.removeEventListener("abort", abortHandler);
      lastError = error;
      if (options.signal?.aborted) {
        throw error;
      }
      if (attempt < MAX_ATTEMPTS) {
        await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }

  return buildFallback(lastError);
}

export function invalidateTurnCache() {
  cache = null;
}

export async function getTurnConfig(options: TurnFetchOptions = {}): Promise<TurnConfig> {
  if (!options.forceRefresh && cacheUsable(cache)) {
    const cached = cache as TurnConfig;
    logSummary("cache-hit", {
      ttl: cached.ttl,
      degraded: cached.degraded,
      expiresInMs: cached.staleAt - Date.now(),
    });
    return {
      ...cached,
      source: cached.source === "fallback" ? "fallback" : "cache",
    };
  }

  if (!inFlight) {
    inFlight = fetchTurnConfig(options).finally(() => {
      inFlight = null;
    });
  }

  try {
    const result = await inFlight;
    return result;
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    return buildFallback(error);
  }
}
