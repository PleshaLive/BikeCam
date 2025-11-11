const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Perform a fetch with AbortController timeout support.
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [options]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const signals = [controller.signal];
  if (signal) {
    signals.push(signal);
  }

  let combinedSignal;
  if (signals.length === 1) {
    combinedSignal = signals[0];
  } else {
    combinedSignal = anySignal(signals);
  }

  try {
    return await fetch(url, { ...rest, signal: combinedSignal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch JSON with timeout and optional fallback parser.
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
export async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) {
    const message = await safeExtractError(response);
    const error = new Error(message || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.json().catch(() => ({}));
}

async function safeExtractError(response) {
  try {
    const payload = await response.json();
    if (payload && typeof payload === "object") {
      return payload.error || payload.message || null;
    }
  } catch (error) {
    // ignore parse errors
  }
  return response.statusText || null;
}

/**
 * Combine multiple AbortSignals into one.
 * @param {AbortSignal[]} signals
 * @returns {AbortSignal}
 */
function anySignal(signals) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort();
      break;
    }
    sig.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

/**
 * Calculate the next retry interval with exponential backoff.
 * @param {number} attempt
 * @returns {number}
 */
export function getRetryDelay(attempt) {
  if (attempt <= 0) {
    return 5_000;
  }
  const delay = Math.min(5_000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
  return delay;
}
