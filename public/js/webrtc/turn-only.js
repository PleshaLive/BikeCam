import { logEv, addCandidate, recordIceServers } from "./diag.js";
import { parseCandidate, describeCandidate } from "./utils.js";

const TURN_CREDS_ENDPOINT = "https://turn.raptors.life/api/webrtc/turn-creds";
const DEFAULT_TURN_UDP = "turn:turn.raptors.life:3478?transport=udp";
const DEFAULT_TURN_TCP = "turns:turn.raptors.life:5349?transport=tcp";
const ADMIN_KEY_QUERY_PARAM = "turnKey";
const ADMIN_KEY_STORAGE = "turnAdminKey";
const TURN_ERROR_BANNER_ID = "turn-creds-error-banner";
const DEFAULT_ADMIN_KEY = "admin123";

function persistAdminKey(value) {
	try {
		if (typeof window !== "undefined" && value) {
			window.__TURN_ADMIN_KEY = value;
			window.localStorage.setItem(ADMIN_KEY_STORAGE, value);
		}
	} catch (error) {
		// ignore storage issues
	}
}

function resolveAdminKey(options = {}) {
	const explicitKey = options && options.key ? String(options.key) : "";
	if (explicitKey) {
		persistAdminKey(explicitKey);
		return explicitKey;
	}
	const fallbackKey = options && typeof options.defaultKey === "string" && options.defaultKey ? options.defaultKey : DEFAULT_ADMIN_KEY;
	if (typeof window === "undefined") {
		return fallbackKey || null;
	}
	if (window.__TURN_ADMIN_KEY) {
		return window.__TURN_ADMIN_KEY;
	}
	let url = null;
	try {
		url = new URL(window.location.href);
	} catch (error) {
		url = null;
	}
	if (url) {
		const fromTurnParam = url.searchParams.get(ADMIN_KEY_QUERY_PARAM);
		if (fromTurnParam) {
			persistAdminKey(fromTurnParam);
			return fromTurnParam;
		}
		const fromGenericKey = url.searchParams.get("key");
		if (fromGenericKey) {
			persistAdminKey(fromGenericKey);
			return fromGenericKey;
		}
	}
	try {
		const stored = window.localStorage.getItem(ADMIN_KEY_STORAGE);
		if (stored) {
			return stored;
		}
	} catch (error) {
		// ignore storage issues
	}
	if (fallbackKey) {
		return fallbackKey;
	}
	return null;
}

function showTurnErrorBanner(status) {
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
	banner.textContent = `TURN CREDS ERROR (${status})`;
}

function maskServersForLog(servers) {
	return servers.map((entry) => {
		if (!entry) {
			return entry;
		}
		const clone = { ...entry };
		if (Array.isArray(clone.urls)) {
			clone.urls = clone.urls.slice();
		}
		if (clone.username && typeof clone.username === "string") {
			const value = clone.username;
			if (value.length > 8) {
				clone.username = `${value.slice(0, 4)}…${value.slice(-4)}`;
			} else {
				clone.username = "***masked***";
			}
		}
		if (clone.credential) {
			clone.credential = "***masked***";
		}
		return clone;
	});
}

function logTurn(event, payload) {
	logEv("turn", event, payload);
	try {
		console.log(`[turn] ${event}`, payload);
	} catch (error) {
		// ignore console issues
	}
}

function sanitizeIceError(event) {
	if (!event) {
		return null;
	}
	return {
		errorCode: event.errorCode,
		errorText: event.errorText,
		url: event.url,
		address: event.address,
		port: event.port,
	};
}

function appendCandidateRow(table, row) {
	table.push(row);
	while (table.length > 50) {
		table.shift();
	}
	try {
		console.table(table);
	} catch (error) {
		console.log("[candidate]", row);
	}
}

function trackChannelBind(report) {
	let bound = false;
	report.forEach((entry) => {
		if (entry.type === "data-channel" && entry.label === "keepalive" && entry.state === "open") {
			bound = true;
		}
	});
	return bound;
}

function extractStatsSummary(report, lastSample) {
	let transport = null;
	report.forEach((entry) => {
		if (entry.type === "transport" && entry.selectedCandidatePairId) {
			transport = entry;
		}
	});
	const summary = {
		relay: null,
		channelBind: trackChannelBind(report),
	};
	if (!transport?.selectedCandidatePairId) {
		return summary;
	}
	const pair = report.get(transport.selectedCandidatePairId);
	if (!pair) {
		return summary;
	}
	const now = Date.now();
	const bytesSent = pair.bytesSent || 0;
	const bytesReceived = pair.bytesReceived || 0;
	let outboundKbps = 0;
	let inboundKbps = 0;
	if (lastSample.ts) {
		const deltaTime = now - lastSample.ts;
		if (deltaTime > 0) {
			outboundKbps = Math.max(0, Math.round(((bytesSent - lastSample.sent) * 8) / deltaTime));
			inboundKbps = Math.max(0, Math.round(((bytesReceived - lastSample.received) * 8) / deltaTime));
		}
	}
	lastSample.ts = now;
	lastSample.sent = bytesSent;
	lastSample.received = bytesReceived;
	const local = report.get(pair.localCandidateId);
	const remote = report.get(pair.remoteCandidateId);
	summary.relay = {
		id: pair.id,
		state: pair.state,
		nominated: Boolean(pair.nominated),
		bytesSent,
		bytesReceived,
		availableOutgoingBitrate: pair.availableOutgoingBitrate || 0,
		availableIncomingBitrate: pair.availableIncomingBitrate || 0,
		currentRoundTripTime: pair.currentRoundTripTime || 0,
		outboundKbps,
		inboundKbps,
		local: local ? describeCandidate(parseCandidate(local.candidate || "")) : null,
		remote: remote ? describeCandidate(parseCandidate(remote.candidate || "")) : null,
	};
	return summary;
}

function startStatsSampler(pc) {
	let timer = null;
	const lastSample = { ts: 0, sent: 0, received: 0 };
	const loop = async () => {
		try {
			const report = await pc.getStats(null);
			logTurn("stats", extractStatsSummary(report, lastSample));
		} catch (error) {
			logTurn("stats_error", { message: error?.message || String(error) });
		}
		timer = setTimeout(loop, 1_000);
	};
	loop();
	return () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};
}

function createKeepAliveChannel(pc) {
	let timer = null;
	let channel = null;
	try {
		channel = pc.createDataChannel("keepalive", { ordered: false, maxRetransmits: 0 });
	} catch (error) {
		logTurn("keepalive_error", { message: error?.message || String(error) });
		return () => {};
	}
	try {
		pc.__turnKeepAliveChannel = channel;
	} catch (error) {
		// ignore binding issues
	}
	channel.addEventListener("open", () => logTurn("keepalive_open", {}));
	channel.addEventListener("close", () => logTurn("keepalive_close", {}));
	channel.addEventListener("error", (event) => {
		logTurn("keepalive_error", { message: event?.message || "error" });
	});
	timer = setInterval(() => {
		if (channel.readyState === "open") {
			try {
				channel.send("ping");
			} catch (error) {
				logTurn("keepalive_error", { message: error?.message || String(error) });
			}
		}
	}, 10_000);
	return () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		try {
			channel.close();
		} catch (error) {
			// ignore
		}
		try {
			pc.__turnKeepAliveChannel = null;
		} catch (error) {
			// ignore
		}
	};
}

function wrapAddIceCandidate(pc, forceRelay) {
	const originalAdd = pc.addIceCandidate.bind(pc);
	pc.addIceCandidate = async (candidate) => {
		if (candidate && candidate.candidate) {
			const raw = candidate.candidate;
			const lower = raw.toLowerCase();
			if (forceRelay && (lower.includes(" host ") || lower.includes(" srflx "))) {
				logTurn("candidate_filtered_remote", { candidate: raw });
				return Promise.resolve();
			}
			const parsed = parseCandidate(raw);
			addCandidate("remote", parsed, { dropped: false });
			logTurn("candidate_remote", {
				time: new Date().toISOString(),
				type: parsed?.type || "",
				protocol: parsed?.relayProtocol || parsed?.protocol || "",
				address: parsed?.ip && parsed?.port ? `${parsed.ip}:${parsed.port}` : "",
			});
		}
		return originalAdd(candidate);
	};
}

function attachDiagnostics(pc, { forceRelay, candidateTable }) {
	const stopStats = startStatsSampler(pc);
	const stopKeepAlive = createKeepAliveChannel(pc);

	pc.addEventListener("iceconnectionstatechange", () => {
		logTurn("pc_ice", {
			state: pc.iceConnectionState,
			gathering: pc.iceGatheringState,
			signaling: pc.signalingState,
		});
	});
	pc.addEventListener("connectionstatechange", () => {
		logTurn("pc_conn", { state: pc.connectionState });
	});
	pc.addEventListener("signalingstatechange", () => {
		logTurn("pc_sig", { state: pc.signalingState });
	});
	pc.addEventListener("icegatheringstatechange", () => {
		logTurn("pc_gather", { state: pc.iceGatheringState });
	});
	pc.addEventListener("icecandidateerror", (event) => {
		logTurn("ice_error", sanitizeIceError(event));
	});
	pc.addEventListener("icecandidate", (event) => {
		if (!event.candidate) {
			logTurn("candidate_complete", {});
			return;
		}
		const raw = event.candidate.candidate || "";
		const lower = raw.toLowerCase();
		if (forceRelay && (lower.includes(" host ") || lower.includes(" srflx "))) {
			logTurn("candidate_filtered_local", { candidate: raw });
			return;
		}
		const parsed = parseCandidate(raw);
		addCandidate("local", parsed, { dropped: false });
		const row = {
			time: new Date().toISOString(),
			direction: "local",
			type: parsed?.type || "",
			protocol: parsed?.relayProtocol || parsed?.protocol || "",
			address: parsed?.ip && parsed?.port ? `${parsed.ip}:${parsed.port}` : "",
		};
		appendCandidateRow(candidateTable, row);
		logTurn("candidate_local", row);
	});

	wrapAddIceCandidate(pc, forceRelay);

	return () => {
		stopStats();
		stopKeepAlive();
	};
}

function ensureTurnEndpoints(servers) {
	if (!Array.isArray(servers)) {
		return [];
	}
	const list = servers.map((entry) => {
		if (!entry) {
			return entry;
		}
		const clone = { ...entry };
		if (Array.isArray(clone.urls)) {
			clone.urls = clone.urls.slice();
		}
		return clone;
	});
	const findCredentials = list.find((entry) => entry && entry.username && entry.credential);
	const username = findCredentials?.username || "";
	const credential = findCredentials?.credential || "";
	const hasUrl = (target) =>
		list.some((entry) => {
			if (!entry) {
				return false;
			}
			const urls = Array.isArray(entry.urls) ? entry.urls : entry.urls ? [entry.urls] : [];
			return urls.some((url) => typeof url === "string" && url.toLowerCase() === target.toLowerCase());
		});
	if (username && credential) {
		if (!hasUrl(DEFAULT_TURN_UDP)) {
			list.push({ urls: [DEFAULT_TURN_UDP], username, credential });
		}
		if (!hasUrl(DEFAULT_TURN_TCP)) {
			list.push({ urls: [DEFAULT_TURN_TCP], username, credential });
		}
	}
	return list;
}

function applyTcpOnlyFilter(servers, tcpOnly) {
	if (!tcpOnly) {
		return servers;
	}
	return servers
		.map((entry) => {
			if (!entry) {
				return null;
			}
			const urls = Array.isArray(entry.urls) ? entry.urls : entry.urls ? [entry.urls] : [];
			const filtered = urls.filter((url) => typeof url === "string" && /transport=tcp/i.test(url));
			if (!filtered.length) {
				return null;
			}
			return {
				...entry,
				urls: filtered.length === 1 ? filtered[0] : filtered,
			};
		})
		.filter(Boolean);
}

function resolveForceRelay(options = {}) {
	let fromQuery = null;
	try {
		const url = new URL(window.location.href);
		if (url.searchParams.has("turnOnly")) {
			fromQuery = url.searchParams.get("turnOnly") === "1";
		}
	} catch (error) {
		fromQuery = null;
	}
	if (fromQuery !== null) {
		return fromQuery;
	}
	if (Object.prototype.hasOwnProperty.call(options, "forceRelay")) {
		return Boolean(options.forceRelay);
	}
	return false;
}

function resolveTcpOnly(options = {}) {
	let fromQuery = null;
	try {
		const url = new URL(window.location.href);
		if (url.searchParams.has("tcpOnly")) {
			fromQuery = url.searchParams.get("tcpOnly") === "1";
		}
	} catch (error) {
		fromQuery = null;
	}
	if (fromQuery !== null) {
		return fromQuery;
	}
	if (Object.prototype.hasOwnProperty.call(options, "tcpOnly")) {
		return Boolean(options.tcpOnly);
	}
	return false;
}

export async function fetchTurnCreds(options = {}) {
	const adminKey = resolveAdminKey(options);
	if (!adminKey) {
		showTurnErrorBanner("missing-key");
		const error = new Error("TURN admin key missing");
		error.code = "turn-key-missing";
		console.error("[turn] turn_creds_error", error);
		logTurn("creds_error", { reason: "missing-key" });
		throw error;
	}
	const url = new URL(TURN_CREDS_ENDPOINT);
	url.searchParams.set("key", adminKey);
	url.searchParams.set("t", Date.now().toString());
	try {
		const response = await fetch(url.toString(), { cache: "no-store" });
		if (!response.ok) {
			showTurnErrorBanner(response.status || "error");
			const error = new Error(`TURN creds HTTP ${response.status}`);
			console.error("[turn] turn_creds_error", error);
			logTurn("creds_error", { status: response.status });
			throw error;
		}
		const json = await response.json();
		const iceServers = Array.isArray(json?.iceServers) ? json.iceServers : [];
		const ttlSec = json?.ttlSec || null;
		const masked = maskServersForLog(iceServers);
		console.info("[turn] creds", { ttlSec, iceServers: masked });
		logTurn("creds", { ttlSec, servers: masked });
		return { ttlSec, iceServers };
	} catch (error) {
		showTurnErrorBanner("fetch-error");
		console.error("[turn] turn_creds_error", error);
		logTurn("creds_exception", { message: error?.message || String(error) });
		throw error;
	}
}

export async function buildTurnOnlyIceServers(options = {}) {
	const creds = await fetchTurnCreds(options);
	const baseServers = ensureTurnEndpoints(creds.iceServers);
	const tcpOnly = resolveTcpOnly(options);
	const finalServers = applyTcpOnlyFilter(baseServers, tcpOnly);
	recordIceServers(finalServers);
	const forceRelay = resolveForceRelay(options);
	logTurn("config_ready", {
		ttlSec: creds.ttlSec || null,
		turnOnly: forceRelay,
		tcpOnly,
		servers: maskServersForLog(finalServers),
	});
	return {
		iceServers: finalServers,
		ttlSec: creds.ttlSec || null,
		forceRelay,
		tcpOnly,
	};
}

function instantiateTurnOnlyPc(ice, options = {}) {
	if (!ice || !Array.isArray(ice.iceServers)) {
		throw new Error("invalid ICE configuration");
	}
	const forceRelay = Object.prototype.hasOwnProperty.call(ice, "forceRelay")
		? Boolean(ice.forceRelay)
		: resolveForceRelay(options);
	const tcpOnly = Object.prototype.hasOwnProperty.call(ice, "tcpOnly") ? Boolean(ice.tcpOnly) : resolveTcpOnly(options);
	const servers = applyTcpOnlyFilter(ensureTurnEndpoints(ice.iceServers), tcpOnly);
	const config = {
		iceServers: servers,
		iceTransportPolicy: forceRelay ? "relay" : "all",
		bundlePolicy: "max-bundle",
		rtcpMuxPolicy: "require",
		iceCandidatePoolSize: 0,
		sdpSemantics: "unified-plan",
	};
	const pc = new RTCPeerConnection(config);
	const candidateTable = [];
	const cleanup = attachDiagnostics(pc, { forceRelay, candidateTable });
	const teardown = () => {
		cleanup();
		try {
			if (pc.__turnOnly) {
				pc.__turnOnly.keepAliveChannel = null;
			}
		} catch (error) {
			// ignore
		}
	};
	pc.__turnCleanup = teardown;
	pc.__turnCandidates = candidateTable;
	pc.__turnOnly = {
		forceRelay,
		tcpOnly,
		ttlSec: ice.ttlSec || null,
		iceServers: servers,
		keepAliveChannel: pc.__turnKeepAliveChannel || null,
		stop: teardown,
	};
	try {
		window.__turnPc = pc;
		window.__turnCandidates = candidateTable;
	} catch (error) {
		// ignore window binding
	}
	logTurn("pc_created", {
		forceRelay,
		tcpOnly,
		ttlSec: ice.ttlSec || null,
		servers: maskServersForLog(servers),
	});
	return pc;
}

export async function createRelayOnlyPC(options = {}) {
	return buildTurnOnlyPc(options);
}

export async function createTurnOnlyPeerConnection(options = {}) {
	return createRelayOnlyPC(options);
}

export async function buildTurnOnlyPc(options = {}) {
	const ice = await buildTurnOnlyIceServers(options);
	return instantiateTurnOnlyPc(ice, options);
}

export function buildTurnOnlyPcWithConfig(ice, options = {}) {
	return instantiateTurnOnlyPc(ice, options);
}

export async function dumpSelectedPair(pc) {
	const report = await pc.getStats();
	let transport = null;
	report.forEach((entry) => {
		if (entry.type === "transport" && entry.selectedCandidatePairId) {
			transport = entry;
		}
	});
	if (!transport?.selectedCandidatePairId) {
		return null;
	}
	const pair = report.get(transport.selectedCandidatePairId);
	if (!pair) {
		return null;
	}
	return {
		pair,
		local: report.get(pair.localCandidateId),
		remote: report.get(pair.remoteCandidateId),
	};
}