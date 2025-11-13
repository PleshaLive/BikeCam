import { API_BASE, DEBUG_WEBRTC } from "./endpoints.js";
import { computeInboundVideoMetrics } from "./stats.js";
import { getTurnConfig as fetchTurnConfig } from "./webrtc/turn-config.js";

const KEEPALIVE_INTERVAL_MS = 10_000;
const STATS_INTERVAL_MS = 15_000;
const ICE_DISCONNECT_GRACE_MS = 5_000;
const ICE_RECOVERY_TIMEOUT_MS = 10_000;
const RECONNECT_BACKOFF = [1_000, 2_000, 5_000, 10_000];

const FALLBACK_SETTINGS = {
	mjpeg: true,
	endpoint: `${API_BASE}/fallback/mjpeg`,
	heartbeatSeconds: 20,
	maxFps: 5,
};
const CACHE_SKEW_MS = 30_000;
const MIN_CACHE_MS = 15_000;
const TURN_ERROR_BANNER_ID = "turn-config-error-banner";

let turnErrorShown = false;

const configCache = {
	promise: null,
	value: null,
	expiresAt: 0,
};

const diagStore = createDiagStore();

if (typeof window !== "undefined") {
	if (!window.__webrtcDiag) {
		window.__webrtcDiag = {
			dump: () => ({ events: diagStore.events.slice(), stats: diagStore.stats.slice() }),
		};
	} else if (typeof window.__webrtcDiag.dump !== "function") {
		window.__webrtcDiag.dump = () => ({ events: diagStore.events.slice(), stats: diagStore.stats.slice() });
	}
}

function createDiagStore() {
	return {
		events: [],
		stats: [],
		pushEvent(event) {
			this.events.push(event);
			if (this.events.length > 100) {
				this.events.shift();
			}
		},
		pushStats(sample) {
			this.stats.push(sample);
			if (this.stats.length > 100) {
				this.stats.shift();
			}
		},
	};
}

function logDiag(type, payload = {}) {
	const entry = {
		type,
		timestamp: Date.now(),
		...payload,
	};
	diagStore.pushEvent(entry);
	if (DEBUG_WEBRTC) {
		console.debug(`[webrtc] ${type}`, payload);
	}
}

function cloneIceServers(iceServers) {
	return (iceServers || [])
		.map((entry) => {
			if (!entry || typeof entry !== "object") {
				return null;
			}
			const clone = { ...entry };
			if (Array.isArray(entry.urls)) {
				clone.urls = [...entry.urls];
			}
			return clone;
		})
		.filter(Boolean);
}
function isTurnUrl(url) {
	return typeof url === "string" && (url.startsWith("turn:") || url.startsWith("turns:"));
}

function filterTurnOnlyServers(servers) {
	return cloneIceServers(servers)
		.map((server) => {
			if (!server) {
				return null;
			}
			const urls = Array.isArray(server.urls) ? server.urls : server.urls ? [server.urls] : [];
			const filtered = urls.filter((url) => isTurnUrl(url));
			if (!filtered.length) {
				return null;
			}
			return {
				...server,
				urls: filtered.length === 1 ? filtered[0] : filtered,
			};
		})
		.filter(Boolean);
}

function buildResolvedConfig(base, forceTurnOnly) {
	const servers = forceTurnOnly ? filterTurnOnlyServers(base.iceServers) : cloneIceServers(base.iceServers);
	const fallbackSource = base?.fallback && typeof base.fallback === "object" ? base.fallback : null;
	return {
		iceServers: servers,
		fallback: fallbackSource ? { ...FALLBACK_SETTINGS, ...fallbackSource } : { ...FALLBACK_SETTINGS },
		ttlSec: base.ttlSec ?? null,
		fetchedAt: base.fetchedAt ?? Date.now(),
		expiresAt: base.expiresAt ?? null,
		publicIp: base.publicIp ?? null,
	};
}

function cloneResolvedConfig(config) {
	return {
		iceServers: cloneIceServers(config?.iceServers),
		fallback: { ...(config?.fallback || {}) },
		ttlSec: config?.ttlSec ?? null,
		fetchedAt: config?.fetchedAt ?? null,
		expiresAt: config?.expiresAt ?? null,
		publicIp: config?.publicIp ?? null,
	};
}

function showTurnErrorBanner(message) {
	if (typeof document === "undefined") {
		return;
	}
	let banner = document.getElementById(TURN_ERROR_BANNER_ID);
	if (!banner) {
		banner = document.createElement("div");
		banner.id = TURN_ERROR_BANNER_ID;
		banner.style.position = "fixed";
		banner.style.top = "0";
		banner.style.left = "0";
		banner.style.right = "0";
		banner.style.zIndex = "9999";
		banner.style.padding = "12px";
		banner.style.background = "#b00020";
		banner.style.color = "#fff";
		banner.style.fontFamily = "system-ui, sans-serif";
		banner.style.textAlign = "center";
		document.body.appendChild(banner);
	}
	banner.textContent = message;
}

function notifyTurnError(error) {
	const message = error?.message || String(error);
	console.error("[ICE] TURN configuration error", error);
	if (turnErrorShown) {
		return;
	}
	turnErrorShown = true;
	showTurnErrorBanner(`TURN connectivity issue: ${message}`);
	if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
		try {
			window.dispatchEvent(new CustomEvent("turn-config-error", { detail: { message } }));
		} catch (dispatchError) {
			// ignore dispatch issues
		}
	}
}

function normalizeTurnPayload(payload) {
	const fallbackSource = payload?.fallback && typeof payload.fallback === "object"
		? payload.fallback
		: payload?.raw?.fallback && typeof payload.raw.fallback === "object"
			? payload.raw.fallback
			: null;
	return {
		iceServers: cloneIceServers(payload?.iceServers),
		ttlSec: payload?.ttlSec ?? null,
		fetchedAt: payload?.fetchedAt ?? Date.now(),
		expiresAt: payload?.expiresAt ?? null,
		fallback: fallbackSource ? { ...fallbackSource } : null,
		publicIp: typeof payload?.publicIp === "string"
			? payload.publicIp
			: typeof payload?.raw?.publicIp === "string"
				? payload.raw.publicIp
				: null,
	};
}

async function resolveConfig(forceTurnOnly = false) {
	const now = Date.now();
	if (configCache.value && configCache.expiresAt > now) {
		return buildResolvedConfig(configCache.value, forceTurnOnly);
	}

	if (!configCache.promise) {
		configCache.promise = (async () => {
			const turnPayload = await fetchTurnConfig();
			const normalized = normalizeTurnPayload(turnPayload);
			const expiry = normalized.expiresAt ?? Date.now() + 60_000;
			normalized.expiresAt = expiry;
			configCache.value = normalized;
			configCache.expiresAt = Math.max(expiry - CACHE_SKEW_MS, Date.now() + MIN_CACHE_MS);
			return normalized;
		})()
			.catch((error) => {
				configCache.promise = null;
				throw error;
			})
			.finally(() => {
				configCache.promise = null;
			});
	}

	try {
		const base = await configCache.promise;
		return buildResolvedConfig(base, forceTurnOnly);
	} catch (error) {
		notifyTurnError(error);
		if (configCache.value) {
			return buildResolvedConfig(configCache.value, forceTurnOnly);
		}
		return {
			iceServers: [],
			fallback: { ...FALLBACK_SETTINGS },
			ttlSec: null,
			fetchedAt: Date.now(),
			expiresAt: Date.now() + MIN_CACHE_MS,
			publicIp: null,
		};
	}
}

export async function getConfig(forceTurnOnly = false) {
	const config = await resolveConfig(forceTurnOnly);
	return cloneResolvedConfig(config);
}

export function hasWebRTCSupport() {
	return typeof window !== "undefined" && typeof window.RTCPeerConnection === "function";
}

export async function createConnection(options = {}) {
	const managed = new ManagedConnection(options);
	await managed.init();
	return managed;
}

export async function createPeerConnection(forceRelay = false, options = {}) {
	const managed = await createConnection({ ...options, forceTurnOnly: forceRelay });
	return managed.pc;
}

export function createMjpegUrl(nickname) {
	if (!nickname) {
		return "";
	}

	const safeName = encodeURIComponent(nickname);
	return `${API_BASE}/fallback/mjpeg/${safeName}?t=${Date.now()}`;
}

class ManagedConnection {
	constructor(options) {
		this.forceTurnOnly = Boolean(options.forceTurnOnly);
		this.onStats = typeof options.onStats === "function" ? options.onStats : null;
		this.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;
		this.onReconnectNeeded = typeof options.onReconnectNeeded === "function" ? options.onReconnectNeeded : null;
		this.label = options.label || "connection";
		this.pc = null;
		this.keepAliveChannel = null;
		this.keepAliveTimer = null;
		this.statsTimer = null;
		this.restartTimer = null;
		this.recoveryTimer = null;
		this.reconnectAttempt = 0;
		this.closed = false;
	}

	async init() {
		const config = await resolveConfig(this.forceTurnOnly);
		const rtcConfig = {
			iceServers: cloneIceServers(config.iceServers),
			iceTransportPolicy: this.forceTurnOnly ? "relay" : "all",
			bundlePolicy: "max-bundle",
			sdpSemantics: "unified-plan",
		};

		this.pc = new RTCPeerConnection(rtcConfig);
		this.pc.__managed = this;

		this.attachEventHandlers();
		this.setupKeepAlive();
		this.setupStatsLoop();

		logDiag("pc-created", { label: this.label, forceTurnOnly: this.forceTurnOnly });
	}

	attachEventHandlers() {
		if (!this.pc) {
			return;
		}

		this.pc.addEventListener("iceconnectionstatechange", () => {
			const state = this.pc.iceConnectionState;
			logDiag("ice-state", { label: this.label, state });
			if (this.onStateChange) {
				this.onStateChange({ type: "ice", state });
			}
			this.handleIceState(state);
		});

		this.pc.addEventListener("connectionstatechange", () => {
			const state = this.pc.connectionState;
			logDiag("pc-state", { label: this.label, state });
			if (this.onStateChange) {
				this.onStateChange({ type: "connection", state });
			}
			this.handleConnectionState(state);
		});

		if (DEBUG_WEBRTC) {
			this.pc.addEventListener("icecandidate", (event) => {
				if (event.candidate) {
					console.debug(`[webrtc] candidate ${this.label}`, event.candidate.type, event.candidate.protocol);
				} else {
					console.debug(`[webrtc] ice gathering complete ${this.label}`);
				}
			});
		}
	}

	setupKeepAlive() {
		if (!this.pc) {
			return;
		}

		try {
			this.keepAliveChannel = this.pc.createDataChannel("keepalive", {
				ordered: false,
				maxRetransmits: 0,
			});
		} catch (error) {
			logDiag("keepalive-error", { label: this.label, message: error?.message || String(error) });
			return;
		}

		const sendPing = () => {
			if (!this.keepAliveChannel || this.keepAliveChannel.readyState !== "open") {
				return;
			}
			try {
				this.keepAliveChannel.send("ping");
			} catch (error) {
				logDiag("keepalive-send-error", { label: this.label, message: error?.message || String(error) });
			}
		};

		this.keepAliveChannel.addEventListener("open", () => {
			sendPing();
			this.keepAliveTimer = setInterval(sendPing, KEEPALIVE_INTERVAL_MS);
		});

		this.keepAliveChannel.addEventListener("close", () => {
			if (this.keepAliveTimer) {
				clearInterval(this.keepAliveTimer);
				this.keepAliveTimer = null;
			}
		});

		this.keepAliveChannel.addEventListener("error", (event) => {
			logDiag("keepalive-channel-error", { label: this.label, message: event?.message || "error" });
		});
	}

	setupStatsLoop() {
		if (!this.pc || typeof this.pc.getStats !== "function") {
			return;
		}

		const pollStats = async () => {
			if (!this.pc || this.closed) {
				return;
			}
			try {
				const report = await this.pc.getStats(null);
				const sample = computeInboundVideoMetrics(report);
				const payload = { ...sample, label: this.label };
				diagStore.pushStats(payload);
				if (this.onStats) {
					this.onStats(sample, report);
				}
			} catch (error) {
				logDiag("stats-error", { label: this.label, message: error?.message || String(error) });
			}
		};

		this.statsTimer = setInterval(pollStats, STATS_INTERVAL_MS);
		// prime loop quickly
		pollStats().catch(() => {});
	}

	handleIceState(state) {
		if (state === "connected" || state === "completed") {
			this.resetRecovery();
			return;
		}

		if (state === "disconnected") {
			this.scheduleIceRestart(false);
		} else if (state === "failed") {
			this.scheduleIceRestart(true);
		}
	}

	handleConnectionState(state) {
		if (state === "connected") {
			this.resetRecovery();
		} else if (state === "failed") {
			this.scheduleIceRestart(true);
		}
	}

	scheduleIceRestart(force) {
		if (!this.pc || this.closed) {
			return;
		}

		if (!this.restartTimer) {
			this.restartTimer = setTimeout(() => {
				this.restartTimer = null;
				this.tryRestart(force);
			}, ICE_DISCONNECT_GRACE_MS);
		}
	}

	tryRestart(force) {
		if (!this.pc || this.closed) {
			return;
		}

		if (typeof this.pc.restartIce === "function") {
			try {
				this.pc.restartIce();
				logDiag("ice-restart", { label: this.label, force });
			} catch (error) {
				logDiag("ice-restart-error", { label: this.label, message: error?.message || String(error) });
				this.requestFullReconnect("restart-error");
				return;
			}
			this.armRecoveryTimer();
		} else {
			this.requestFullReconnect("restart-unsupported");
		}
	}

	armRecoveryTimer() {
		if (this.recoveryTimer) {
			clearTimeout(this.recoveryTimer);
		}
		this.recoveryTimer = setTimeout(() => {
			this.requestFullReconnect("restart-timeout");
		}, ICE_RECOVERY_TIMEOUT_MS);
	}

	resetRecovery() {
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		if (this.recoveryTimer) {
			clearTimeout(this.recoveryTimer);
			this.recoveryTimer = null;
		}
		this.reconnectAttempt = 0;
	}

	requestFullReconnect(reason) {
		if (this.closed) {
			return;
		}

		this.reconnectAttempt += 1;
		const attempt = this.reconnectAttempt;
		const delay = RECONNECT_BACKOFF[Math.min(attempt - 1, RECONNECT_BACKOFF.length - 1)];
		logDiag("reconnect-needed", { label: this.label, reason, attempt, delay });

		if (this.onReconnectNeeded) {
			this.onReconnectNeeded({ reason, attempt, delay, connection: this });
		}
	}

	async refreshIceServers(forceTurnOnly) {
		this.forceTurnOnly = typeof forceTurnOnly === "boolean" ? forceTurnOnly : this.forceTurnOnly;
		const config = await resolveConfig(this.forceTurnOnly);
		if (!this.pc) {
			return;
		}
		try {
			this.pc.setConfiguration({
				iceServers: cloneIceServers(config.iceServers),
				iceTransportPolicy: this.forceTurnOnly ? "relay" : "all",
			});
			logDiag("pc-config-refreshed", { label: this.label, forceTurnOnly: this.forceTurnOnly });
		} catch (error) {
			logDiag("pc-config-error", { label: this.label, message: error?.message || String(error) });
		}
	}

	close() {
		this.destroy();
	}

	destroy() {
		if (this.closed) {
			return;
		}
		this.closed = true;

		if (this.keepAliveTimer) {
			clearInterval(this.keepAliveTimer);
			this.keepAliveTimer = null;
		}
		if (this.statsTimer) {
			clearInterval(this.statsTimer);
			this.statsTimer = null;
		}
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		if (this.recoveryTimer) {
			clearTimeout(this.recoveryTimer);
			this.recoveryTimer = null;
		}

		if (this.keepAliveChannel) {
			try {
				this.keepAliveChannel.close();
			} catch (error) {
				// ignore
			}
			this.keepAliveChannel = null;
		}

		if (this.pc) {
			try {
				this.pc.close();
			} catch (error) {
				// ignore
			}
			this.pc = null;
		}

		logDiag("pc-destroyed", { label: this.label });
	}

	getDiagnostics() {
		return {
			label: this.label,
			forceTurnOnly: this.forceTurnOnly,
			reconnectAttempt: this.reconnectAttempt,
			closed: this.closed,
		};
	}
}

