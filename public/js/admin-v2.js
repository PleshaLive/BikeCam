import {
	WS_BASE,
	PUBLIC_FORCE_TURN_DEFAULT,
	getTurnAdminKey,
	setTurnAdminKey,
	buildApiUrl,
} from "./shared/env.js";
import { createReceiverPc, listQualityPresets } from "./webrtc/pc-factory.js";
import startTileStats from "./webrtc/stats-panel.js";
import VisibilityStore from "../state/visibility-store.js";
import { parseCandidate } from "./webrtc/utils.js";

const SIGNAL_URL = WS_BASE;
const TURN_ENDPOINT = "/api/webrtc/turn-creds";
const ROSTER_ENDPOINT = "/api/admin/cameras";
const VISIBILITY_ENDPOINT = "/api/visibility";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1_000;
const NO_FRAMES_THRESHOLD_MS = 3_000;
const OFFER_TIMEOUT_MS = 15_000;
const RECONNECT_BACKOFF = [1_000, 2_000, 4_000, 8_000, 12_000];
const QUALITY_OPTIONS = listQualityPresets();
const DEFAULT_QUALITY = QUALITY_OPTIONS.includes("auto") ? "auto" : QUALITY_OPTIONS[0] || "auto";

const TILE_REASON = {
	ok: "Streaming",
	hidden: "HiddenByAdmin",
	noTrack: "NoTrack",
	noFrames: "NoFrames",
	autoplay: "AutoplayBlocked",
	iceFailed: "ICEFailed",
	connecting: "Connecting",
	paused: "Paused",
};

const dom = {
	tileGrid: document.getElementById("tileGrid"),
	emptyState: document.getElementById("emptyState"),
	tokenIndicator: document.getElementById("tokenIndicator"),
	summaryActive: document.querySelector("#summaryBar .summary-card:nth-child(1) strong"),
	summaryBitrate: document.querySelector("#summaryBar .summary-card:nth-child(2) strong"),
	summaryRtt: document.querySelector("#summaryBar .summary-card:nth-child(3) strong"),
	summaryRefreshed: document.querySelector("#summaryBar .summary-card:nth-child(4) strong"),
	muteAll: document.getElementById("muteAllBtn"),
	unmuteAll: document.getElementById("unmuteAllBtn"),
	freezeAll: document.getElementById("freezeAllBtn"),
	resumeAll: document.getElementById("resumeAllBtn"),
	reconnectAll: document.getElementById("reconnectAllBtn"),
	refreshTurn: document.getElementById("refreshTurnBtn"),
	reloadRoster: document.getElementById("reloadRosterBtn"),
	debugToggle: document.getElementById("debugToggleBtn"),
	forceTurnToggle: document.getElementById("forceTurnToggle"),
	turnKeyInput: document.getElementById("turnKeyInput"),
	applyTurnKey: document.getElementById("applyTurnKeyBtn"),
	debugPanel: document.getElementById("debugPanel"),
	debugOutput: document.getElementById("debugOutput"),
};

const debugBuffer = [];
const remoteVisibilityListeners = new Set();

const state = {
	tiles: new Map(),
	roster: new Map(),
	signal: null,
	turnOnly: Boolean(PUBLIC_FORCE_TURN_DEFAULT),
	visibilityStore: null,
	debugEnabled: false,
	focusedTile: null,
};

function logDebug(scope, event, payload) {
	const entry = {
		ts: new Date().toISOString(),
		scope,
		event,
		payload,
	};
	debugBuffer.push(entry);
	while (debugBuffer.length > 120) {
		debugBuffer.shift();
	}
	if (dom.debugOutput) {
		dom.debugOutput.textContent = debugBuffer
			.map((item) => `${item.ts} [${item.scope}] ${item.event} ${JSON.stringify(item.payload || {})}`)
			.join("\n");
	}
}

function normalizeNickname(name) {
	if (typeof name !== "string") {
		return null;
	}
	const trimmed = name.trim();
	if (!trimmed) {
		return null;
	}
	return trimmed.replace(/\s+/g, " ");
}

function nicknameKey(name) {
	const normalized = normalizeNickname(name);
	if (!normalized) {
		return null;
	}
	return normalized.replace(/\s+/g, "").toLowerCase();
}

function formatBitrate(kbps) {
	if (!Number.isFinite(kbps)) {
		return "--";
	}
	if (kbps >= 1_000) {
		return `${(kbps / 1_000).toFixed(2)} Mbps`;
	}
	return `${Math.max(0, Math.round(kbps))} kbps`;
}

function formatRtt(value) {
	if (!Number.isFinite(value)) {
		return "--";
	}
	return `${Math.max(0, Math.round(value))} ms`;
}

async function fetchJson(url, options = {}) {
	const response = await fetch(url, {
		method: options.method || "GET",
		headers: {
			Accept: "application/json",
			...options.headers,
		},
		body: options.body,
		credentials: options.credentials || "include",
		cache: "no-store",
	});
	if (!response.ok) {
		const message = `HTTP ${response.status}`;
		const error = new Error(message);
		error.status = response.status;
		throw error;
	}
	if (response.status === 204) {
		return null;
	}
	return response.json();
}

async function postJson(url, body, options = {}) {
	return fetchJson(url, {
		method: "POST",
		body: JSON.stringify(body),
		headers: {
			"Content-Type": "application/json",
			...(options.headers || {}),
		},
		credentials: options.credentials || "include",
	});
}

class TurnManager {
	constructor(onUpdate) {
		this.token = null;
		this.refreshTimer = null;
		this.onUpdate = typeof onUpdate === "function" ? onUpdate : () => {};
	}

	get info() {
		return this.token;
	}

	get iceServers() {
		return this.token?.iceServers || [];
	}

	get ttlSec() {
		return this.token?.ttlSec || null;
	}

	get expiresAt() {
		return this.token?.expiresAt || null;
	}

	get fetchedAt() {
		return this.token?.fetchedAt || null;
	}

	isExpiringSoon() {
		if (!this.expiresAt) {
			return true;
		}
		return Date.now() > this.expiresAt - TOKEN_REFRESH_MARGIN_MS;
	}

	async ensure(force = false) {
		if (!force && this.token && !this.isExpiringSoon()) {
			return this.token;
		}
		return this.refresh(force);
	}

	async refresh(force = false) {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		const key = getTurnAdminKey();
		if (!key) {
			throw new Error("TURN_ADMIN_KEY missing. Provide ?turnKey=... in URL or use the TURN key form.");
		}
		const url = new URL(buildApiUrl(TURN_ENDPOINT));
		url.searchParams.set("key", key);
		url.searchParams.set("t", Date.now().toString());
		logDebug("turn", "fetch", { url: url.toString() });
		const payload = await fetchJson(url.toString());
		if (payload && payload.adminKey) {
			setTurnAdminKey(payload.adminKey);
		}
		const ttlSecRaw = Number(payload?.ttlSec ?? payload?.ttl ?? 0);
		const ttlSec = Number.isFinite(ttlSecRaw) && ttlSecRaw > 0 ? ttlSecRaw : null;
		const fetchedAt = Date.now();
		const expiresAt = ttlSec ? fetchedAt + ttlSec * 1_000 : null;

		const urls = Array.isArray(payload?.urls) ? payload.urls : payload?.urls ? [payload.urls] : [];
		let iceServers = [];
		if (Array.isArray(payload?.iceServers) && payload.iceServers.length) {
			iceServers = payload.iceServers;
		} else if (urls.length && payload?.username && payload?.credential) {
			iceServers = [
				{
					urls,
					username: payload.username,
					credential: payload.credential,
				},
			];
		}

		this.token = {
			iceServers,
			ttlSec,
			fetchedAt,
			expiresAt,
			raw: payload,
		};
		this.onUpdate(this.token);
		this.scheduleRefresh();
		logDebug("turn", "ready", { ttlSec, iceServers: iceServers.length });
		return this.token;
	}

	scheduleRefresh() {
		if (!this.expiresAt) {
			return;
		}
		const refreshIn = Math.max(30_000, this.expiresAt - Date.now() - TOKEN_REFRESH_MARGIN_MS);
		this.refreshTimer = setTimeout(() => {
			this.refresh(true).catch((error) => logDebug("turn", "refresh-error", { message: error?.message || String(error) }));
		}, refreshIn);
	}

	indicatorText() {
		if (!this.token) {
			return "TURN token not loaded";
		}
		const ageMs = Date.now() - this.fetchedAt;
		const ageMinutes = Math.floor(ageMs / 60_000);
		if (!this.expiresAt) {
			return `Token age ${ageMinutes}m`;
		}
		const remaining = Math.max(0, this.expiresAt - Date.now());
		const remainingMinutes = Math.floor(remaining / 60_000);
		return `Token age ${ageMinutes}m • ${remainingMinutes}m left`;
	}
}

class SignalHub {
	constructor(url) {
		this.url = url;
		this.socket = null;
		this.queue = [];
		this.ready = false;
		this.listeners = new Map();
		this.reconnectTimer = null;
	}

	on(type, handler) {
		if (!this.listeners.has(type)) {
			this.listeners.set(type, new Set());
		}
		const set = this.listeners.get(type);
		set.add(handler);
		return () => set.delete(handler);
	}

	emit(type, payload) {
		const set = this.listeners.get(type);
		if (!set) {
			return;
		}
		set.forEach((handler) => {
			try {
				handler(payload);
			} catch (error) {
				logDebug("signal", "listener-error", { type, message: error?.message || String(error) });
			}
		});
	}

	connect() {
		if (this.socket) {
			try {
				this.socket.close();
			} catch (error) {
				// ignore
			}
		}
		const socket = new WebSocket(this.url);
		this.socket = socket;
		socket.addEventListener("open", () => {
			this.ready = true;
			this.send({ type: "HELLO", role: "viewer-admin" });
			this.flush();
			this.emit("open");
			logDebug("ws", "open", {});
		});
		socket.addEventListener("close", () => {
			this.ready = false;
			this.emit("close");
			logDebug("ws", "close", {});
			if (this.reconnectTimer) {
				return;
			}
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = null;
				this.connect();
			}, 2_000);
		});
		socket.addEventListener("error", (event) => {
			logDebug("ws", "error", { message: event?.message || "error" });
			try {
				socket.close();
			} catch (error) {
				// ignore
			}
		});
		socket.addEventListener("message", (event) => {
			let payload = null;
			try {
				payload = JSON.parse(event.data);
			} catch (error) {
				logDebug("signal", "parse-error", { message: error?.message || String(error) });
				return;
			}
			this.emit("message", payload);
			if (payload?.type) {
				this.emit(payload.type, payload);
			}
		});
	}

	send(message) {
		const serialized = JSON.stringify(message);
		if (this.ready && this.socket?.readyState === WebSocket.OPEN) {
			try {
				this.socket.send(serialized);
			} catch (error) {
				this.queue.push(serialized);
			}
			return;
		}
		this.queue.push(serialized);
	}

	flush() {
		while (this.ready && this.queue.length && this.socket?.readyState === WebSocket.OPEN) {
			const payload = this.queue.shift();
			try {
				this.socket.send(payload);
			} catch (error) {
				this.queue.unshift(payload);
				break;
			}
		}
	}
}

class TileController {
	constructor({ key, nickname, container, turnManager, visibilityStore, signal }) {
		this.key = key;
		this.nickname = nickname;
		this.container = container;
		this.turnManager = turnManager;
		this.visibilityStore = visibilityStore;
		this.signal = signal;
		this.root = null;
		this.dom = {};
		this.pcBundle = null;
		this.stream = null;
		this.connectionId = null;
		this.audioMuted = true;
		this.videoPaused = false;
		this.quality = DEFAULT_QUALITY;
		this.selectedRid = null;
		this.statsStop = null;
		this.lastStats = null;
		this.lastFramesDecoded = 0;
		this.lastFrameTime = 0;
		this.autoplayBlocked = false;
		this.hiddenByAdmin = false;
		this.connectionState = "new";
		this.iceState = "new";
		this.offerTimer = null;
		this.reconnectAttempts = 0;
		this.reconnectTimer = null;
		this.visibilityUnsub = null;
		this.reason = TILE_REASON.connecting;
		this.rosterMeta = null;
		this.mount();
		this.subscribeVisibility();
	}

	mount() {
		const root = document.createElement("div");
		root.className = "tile";
		root.dataset.key = this.key;

		const header = document.createElement("div");
		header.className = "tile-header";
		const heading = document.createElement("div");
		const title = document.createElement("h3");
		title.textContent = this.nickname;
		heading.appendChild(title);
		const meta = document.createElement("div");
		meta.className = "tile-meta";
		meta.textContent = "Slot --";
		heading.appendChild(meta);
		header.appendChild(heading);
		const status = document.createElement("span");
		status.className = "tile-status badge-warn";
		status.textContent = "Connecting";
		header.appendChild(status);
		root.appendChild(header);

		const videoWrap = document.createElement("div");
		videoWrap.className = "video-wrap";
		const video = document.createElement("video");
		video.autoplay = true;
		video.playsInline = true;
		video.muted = true;
		video.disablePictureInPicture = true;
		video.controls = false;
		videoWrap.appendChild(video);

		const overlay = document.createElement("div");
		overlay.className = "video-overlay";
		const overlayStatus = document.createElement("span");
		overlayStatus.textContent = "ICE --";
		const overlayCandidate = document.createElement("span");
		overlayCandidate.textContent = "Candidate --";
		const overlayBitrate = document.createElement("span");
		overlayBitrate.textContent = "Bitrate --";
		const overlayFrames = document.createElement("span");
		overlayFrames.textContent = "Frames --";
		const overlayRtt = document.createElement("span");
		overlayRtt.textContent = "RTT --";
		const overlayToken = document.createElement("span");
		overlayToken.textContent = "Token --";
		overlay.append(overlayStatus, overlayCandidate, overlayBitrate, overlayFrames, overlayRtt, overlayToken);
		videoWrap.appendChild(overlay);

		const autoplayGate = document.createElement("button");
		autoplayGate.textContent = "Tap to start";
		autoplayGate.className = "autoplay-gate";
		autoplayGate.hidden = true;
		autoplayGate.addEventListener("click", () => {
			this.autoplayBlocked = false;
			this.tryPlay();
		});
		videoWrap.appendChild(autoplayGate);

		root.appendChild(videoWrap);

		const controls = document.createElement("div");
		controls.className = "tile-controls";
		const buttons = document.createElement("div");
		buttons.className = "control-buttons";

		const focusBtn = document.createElement("button");
		focusBtn.textContent = "Focus";
		focusBtn.addEventListener("click", () => this.focus());

		const muteBtn = document.createElement("button");
		muteBtn.textContent = "Unmute";
		muteBtn.addEventListener("click", () => this.setAudioMuted(!this.audioMuted));

		const pauseBtn = document.createElement("button");
		pauseBtn.textContent = "Pause";
		pauseBtn.addEventListener("click", () => this.setPaused(!this.videoPaused));

		const hideBtn = document.createElement("button");
		hideBtn.textContent = "Hide in Main";
		hideBtn.addEventListener("click", () => this.toggleVisibility());

		const reconnectBtn = document.createElement("button");
		reconnectBtn.textContent = "Reconnect";
		reconnectBtn.addEventListener("click", () => this.restart("manual"));

		const keyframeBtn = document.createElement("button");
		keyframeBtn.textContent = "Request Keyframe";
		keyframeBtn.addEventListener("click", () => this.requestKeyframe());

		const copyBtn = document.createElement("button");
		copyBtn.textContent = "Copy Debug";
		copyBtn.addEventListener("click", () => this.copyDebug());

		buttons.append(focusBtn, muteBtn, pauseBtn, hideBtn, reconnectBtn, keyframeBtn, copyBtn);
		controls.appendChild(buttons);

		const qualitySelect = document.createElement("select");
		QUALITY_OPTIONS.forEach((option) => {
			const node = document.createElement("option");
			node.value = option;
			node.textContent = option.toUpperCase();
			if (option === this.quality) {
				node.selected = true;
			}
			qualitySelect.appendChild(node);
		});
		qualitySelect.addEventListener("change", () => {
			this.setQuality(qualitySelect.value);
		});
		controls.appendChild(qualitySelect);
		root.appendChild(controls);

		const footer = document.createElement("div");
		footer.className = "tile-footer";
		const reasonLine = document.createElement("span");
		reasonLine.textContent = "Reason: Connecting";
		const errorLine = document.createElement("span");
		footer.append(reasonLine, errorLine);
		root.appendChild(footer);

		this.container.appendChild(root);

		this.root = root;
		this.dom = {
			title,
			meta,
			status,
			video,
			overlay,
			overlayStatus,
			overlayCandidate,
			overlayBitrate,
			overlayFrames,
			overlayRtt,
			overlayToken,
			autoplayGate,
			muteBtn,
			pauseBtn,
			hideBtn,
			qualitySelect,
			reasonLine,
			errorLine,
			focusBtn,
		};

		video.addEventListener("playing", () => {
			this.autoplayBlocked = false;
			this.updateAutoplayGate();
		});

		video.addEventListener("pause", () => {
			if (!this.videoPaused && !this.audioMuted) {
				this.tryPlay();
			}
		});
	}

	subscribeVisibility() {
		if (!this.visibilityStore) {
			return;
		}
		this.visibilityUnsub = this.visibilityStore.subscribe((map) => {
			const visible = map[this.key];
			const hidden = visible === false;
			this.hiddenByAdmin = hidden;
			this.updateVisibility();
			this.dom.hideBtn.textContent = hidden ? "Show in Main" : "Hide in Main";
		});
	}

	updateVisibility() {
		if (!this.root) {
			return;
		}
		this.root.classList.toggle("tile-hidden", this.hiddenByAdmin);
		if (this.hiddenByAdmin) {
			this.setReason(TILE_REASON.hidden);
		}
	}

	setNickname(nickname) {
		const normalized = normalizeNickname(nickname) || this.nickname;
		this.nickname = normalized;
		if (this.dom.title) {
			this.dom.title.textContent = normalized;
		}
	}

	setRosterMeta(meta) {
		this.rosterMeta = meta;
		if (!this.dom.meta) {
			return;
		}
		if (!meta) {
			this.dom.meta.textContent = "Slot --";
			return;
		}
		const team = meta.team ? meta.team.toUpperCase() : "?";
		const slot = meta.slot !== undefined && meta.slot !== null ? meta.slot : "?";
		this.dom.meta.textContent = `${team} • Slot ${slot}`;
	}

	focus() {
		if (state.focusedTile && state.focusedTile !== this) {
			state.focusedTile.root?.classList.remove("tile-active");
		}
		state.focusedTile = this;
		this.root?.classList.add("tile-active");
		this.root?.scrollIntoView({ behavior: "smooth", block: "center" });
	}

	setAudioMuted(muted) {
		this.audioMuted = Boolean(muted);
		if (this.dom.muteBtn) {
			this.dom.muteBtn.textContent = this.audioMuted ? "Unmute" : "Mute";
		}
		if (this.dom.video) {
			this.dom.video.muted = this.audioMuted;
		}
		if (this.stream) {
			this.stream.getAudioTracks().forEach((track) => {
				track.enabled = !this.audioMuted;
			});
		}
		if (!this.audioMuted) {
			this.tryPlay();
		}
	}

	setPaused(paused) {
		this.videoPaused = Boolean(paused);
		if (this.dom.pauseBtn) {
			this.dom.pauseBtn.textContent = this.videoPaused ? "Resume" : "Pause";
		}
		if (this.pcBundle?.setPaused) {
			this.pcBundle.setPaused(this.videoPaused);
		}
		if (!this.videoPaused && this.dom.video && this.dom.video.paused) {
			this.tryPlay();
		}
		if (this.videoPaused) {
			this.setReason(TILE_REASON.paused);
		}
	}

	setQuality(preset) {
		if (!QUALITY_OPTIONS.includes(preset)) {
			preset = DEFAULT_QUALITY;
		}
		this.quality = preset;
		if (this.pcBundle?.applyQualityPreset) {
			this.pcBundle.applyQualityPreset(preset, this.dom.video);
		}
	}

	toggleVisibility() {
		if (!this.visibilityStore) {
			return;
		}
		const next = this.hiddenByAdmin ? true : false;
		this.visibilityStore.set(this.key, next).catch(() => {});
	}

	async start(reason = "initial") {
		await this.restart(reason);
	}

	async restart(reason = "reconnect") {
		this.clearReconnectTimer();
		this.destroyPeer();
		try {
			await this.createPeer(reason);
		} catch (error) {
			this.handleError("create-peer", error);
			this.scheduleReconnect();
		}
	}

	clearReconnectTimer() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	destroyPeer() {
		if (this.statsStop) {
			this.statsStop();
			this.statsStop = null;
		}
		if (this.pcBundle?.pc) {
			try {
				this.pcBundle.pc.close();
			} catch (error) {
				// ignore
			}
		}
		this.pcBundle = null;
		this.connectionId = null;
		if (this.offerTimer) {
			clearTimeout(this.offerTimer);
			this.offerTimer = null;
		}
	}

	async createPeer(reason) {
		const token = await this.turnManager.ensure();
		if (!token || !Array.isArray(token.iceServers) || !token.iceServers.length) {
			throw new Error("TURN configuration unavailable");
		}
		const bundle = createReceiverPc({
			iceServers: token.iceServers,
			turnOnly: state.turnOnly,
			logger: (scope, payload) => logDebug(`tile:${this.key}`, scope, payload),
			onTrack: (event) => this.handleTrack(event),
			onIceCandidate: (candidate) => this.handleLocalCandidate(candidate),
			onConnectionStateChange: (status) => this.handleConnectionState(status),
			onIceStateChange: (status) => this.handleIceState(status),
		});
		bundle.applyQualityPreset(this.quality, this.dom.video);
		this.pcBundle = bundle;
		this.reconnectAttempts = 0;
		this.connectionId = `tile-${this.key}-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
		this.setStatus("Negotiating", "badge-warn");
		this.reason = TILE_REASON.connecting;
		this.updateReasonLabel();

		const { pc } = bundle;
		const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
		await pc.setLocalDescription(offer);
		this.offerTimer = setTimeout(() => {
			this.handleError("offer-timeout", new Error("Publisher did not answer"));
			this.scheduleReconnect();
		}, OFFER_TIMEOUT_MS);
		this.signal.send({
			type: "VIEWER_OFFER",
			nickname: this.nickname,
			connectionId: this.connectionId,
			sdp: pc.localDescription,
			meta: { reason },
		});
		this.startStatsLoop();
	}

	handleTrack(event) {
		const [stream] = event.streams || [];
		if (!stream) {
			return;
		}
		if (this.stream && this.stream !== stream) {
			this.stream.getTracks().forEach((track) => track.stop());
		}
		this.stream = stream;
		if (this.dom.video) {
			this.dom.video.srcObject = stream;
			this.tryPlay();
		}
		this.setAudioMuted(this.audioMuted);
	}

	handleLocalCandidate(candidate) {
		if (!this.connectionId) {
			return;
		}
		this.signal.send({
			type: "VIEWER_ICE",
			nickname: this.nickname,
			connectionId: this.connectionId,
			candidate,
		});
	}

	handleRemoteCandidate(payload) {
		if (!payload) {
			return;
		}
		if (!this.pcBundle?.pc) {
			return;
		}
		if (payload.connectionId !== this.connectionId) {
			return;
		}
		if (!payload.candidate) {
			this.pcBundle.pc.addIceCandidate(null).catch((error) => this.handleError("remote-candidate-null", error));
			return;
		}
		const candidateType = parseCandidate(payload.candidate.candidate || "")?.type;
		if (state.turnOnly && candidateType && candidateType !== "relay") {
			logDebug(`tile:${this.key}`, "remote-candidate-filtered", { candidateType });
			return;
		}
		this.pcBundle.pc.addIceCandidate(payload.candidate).catch((error) => this.handleError("remote-candidate", error));
	}

	async handleAnswer(payload) {
		if (!this.pcBundle?.pc) {
			return;
		}
		if (payload.connectionId !== this.connectionId) {
			return;
		}
		if (this.offerTimer) {
			clearTimeout(this.offerTimer);
			this.offerTimer = null;
		}
		let description = payload.sdp;
		if (typeof description === "string") {
			description = { type: "answer", sdp: description };
		}
		if (this.selectedRid && this.pcBundle.applySimulcastPreference) {
			description = await this.pcBundle.applySimulcastPreference(description, this.selectedRid);
		}
		await this.pcBundle.pc.setRemoteDescription(description);
		this.setStatus("Streaming", "badge-ok");
	}

	handleConnectionState(state) {
		this.connectionState = state;
		if (state === "connected") {
			this.setStatus("Streaming", "badge-ok");
			this.reason = TILE_REASON.ok;
			this.updateReasonLabel();
		} else if (state === "failed") {
			this.setStatus("Failed", "badge-fail");
			this.reason = TILE_REASON.iceFailed;
			this.updateReasonLabel();
			this.scheduleReconnect();
		} else if (state === "disconnected") {
			this.setStatus("Disconnected", "badge-warn");
			this.scheduleReconnect();
		}
	}

	handleIceState(state) {
		this.iceState = state;
	}

	scheduleReconnect() {
		this.clearReconnectTimer();
		const delay = RECONNECT_BACKOFF[Math.min(this.reconnectAttempts, RECONNECT_BACKOFF.length - 1)];
		this.reconnectAttempts += 1;
		this.reconnectTimer = setTimeout(() => {
			this.restart("reconnect").catch(() => {});
		}, delay);
	}

	tryPlay() {
		if (!this.dom.video) {
			return;
		}
		const playPromise = this.dom.video.play?.();
		if (playPromise && typeof playPromise.then === "function") {
			playPromise
				.then(() => {
					this.autoplayBlocked = false;
					this.updateAutoplayGate();
				})
				.catch(() => {
					this.autoplayBlocked = true;
					this.updateAutoplayGate();
				});
		}
	}

	updateAutoplayGate() {
		if (!this.dom.autoplayGate) {
			return;
		}
		this.dom.autoplayGate.hidden = !this.autoplayBlocked;
		if (this.autoplayBlocked) {
			this.setReason(TILE_REASON.autoplay);
		}
	}

	startStatsLoop() {
		if (!this.pcBundle?.pc) {
			return;
		}
		this.statsStop = startTileStats(this.pcBundle.pc, this.dom.video, (summary) => this.handleStats(summary));
	}

	handleStats(summary) {
		this.lastStats = summary;
		if (!summary) {
			return;
		}
		if (this.dom.overlayStatus) {
			this.dom.overlayStatus.textContent = `ICE ${summary.iceState} | Conn ${summary.connectionState}`;
		}
		if (this.dom.overlayCandidate) {
			const candidateText = summary.candidateType ? `Cand ${summary.candidateType}` : "Cand --";
			this.dom.overlayCandidate.textContent = candidateText;
		}
		if (this.dom.overlayBitrate) {
			this.dom.overlayBitrate.textContent = `Bitrate ${formatBitrate(summary.bitrateKbps)}`;
		}
		if (this.dom.overlayFrames) {
			const decoded = summary.framesDecoded || 0;
			const dropped = summary.framesDropped || 0;
			this.dom.overlayFrames.textContent = `Frames ${decoded}/${dropped}`;
		}
		if (this.dom.overlayRtt) {
			this.dom.overlayRtt.textContent = `RTT ${formatRtt(summary.rttMs)}`;
		}
		if (this.dom.overlayToken && this.turnManager) {
			this.dom.overlayToken.textContent = this.turnManager.indicatorText();
		}

		const framesDecoded = summary.framesDecoded || 0;
		if (framesDecoded > this.lastFramesDecoded) {
			this.lastFramesDecoded = framesDecoded;
			this.lastFrameTime = performance.now();
			if (this.reason === TILE_REASON.noFrames) {
				this.reason = TILE_REASON.ok;
			}
		}

		const elapsedSinceFrame = performance.now() - (this.lastFrameTime || 0);
		if (
			framesDecoded === 0 &&
			(this.connectionState === "connected" || this.iceState === "connected") &&
			elapsedSinceFrame > NO_FRAMES_THRESHOLD_MS
		) {
			this.reason = TILE_REASON.noFrames;
			this.updateReasonLabel();
		} else if (!this.hiddenByAdmin && !this.autoplayBlocked && framesDecoded > 0) {
			this.reason = TILE_REASON.ok;
			this.updateReasonLabel();
		}

		updateSummary();
	}

	handleStreamUnavailable() {
		this.scheduleReconnect();
	}

	setStatus(text, badge) {
		if (!this.dom.status) {
			return;
		}
		this.dom.status.textContent = text;
		this.dom.status.className = badge ? `tile-status ${badge}` : "tile-status";
	}

	updateReasonLabel(error) {
		if (!this.dom.reasonLine) {
			return;
		}
		const reasonText = this.hiddenByAdmin
			? "Hidden by admin"
			: this.autoplayBlocked
			? "Autoplay blocked"
			: this.reason === TILE_REASON.noFrames
			? "No frames decoded"
			: this.reason === TILE_REASON.noTrack
			? "No track"
			: this.reason === TILE_REASON.iceFailed
			? "ICE failed"
			: this.reason === TILE_REASON.paused
			? "Paused"
			: "Streaming";
		this.dom.reasonLine.textContent = `Reason: ${reasonText}`;
		if (this.dom.errorLine) {
			this.dom.errorLine.textContent = error ? `Error: ${error}` : "";
			this.dom.errorLine.className = error ? "error" : "";
		}
	}

	setReason(reason, error) {
		this.reason = reason;
		this.updateReasonLabel(error);
	}

	requestKeyframe() {
		if (this.pcBundle?.requestKeyframe) {
			const ok = this.pcBundle.requestKeyframe();
			if (!ok) {
				this.handleError("keyframe", new Error("requestKeyFrame unsupported"));
			}
		}
	}

	copyDebug() {
		const snapshot = {
			key: this.key,
			nickname: this.nickname,
			connectionId: this.connectionId,
			connectionState: this.connectionState,
			iceState: this.iceState,
			stats: this.lastStats,
			reason: this.reason,
			turn: this.turnManager?.info || null,
		};
		const text = JSON.stringify(snapshot, null, 2);
		if (navigator.clipboard?.writeText) {
			navigator.clipboard.writeText(text).catch(() => {});
		}
	}

	handleError(scope, error) {
		const message = error?.message || String(error);
		logDebug(`tile:${this.key}`, scope, { message });
		this.updateReasonLabel(message);
	}

	onTokenRefreshed() {
		if (!this.pcBundle?.updateIceServers) {
			return;
		}
		const servers = this.turnManager?.iceServers || [];
		this.pcBundle.updateIceServers(servers).then(() => {
			if (this.pcBundle?.pc?.restartIce) {
				try {
					this.pcBundle.pc.restartIce();
				} catch (error) {
					this.handleError("restartIce", error);
				}
			} else {
				this.restart("ice-refresh").catch(() => {});
			}
		});
	}

	stop() {
		this.destroyPeer();
		this.stream?.getTracks().forEach((track) => track.stop());
		this.stream = null;
		if (this.visibilityUnsub) {
			this.visibilityUnsub();
		}
		this.root?.remove();
	}
}

const turnManager = new TurnManager((token) => {
	updateTokenIndicator(token);
	tilesForEach((tile) => tile.onTokenRefreshed());
});

const signalHub = new SignalHub(SIGNAL_URL);
state.signal = signalHub;

function tilesForEach(callback) {
	state.tiles.forEach((tile) => {
		try {
			callback(tile);
		} catch (error) {
			logDebug("tiles", "callback-error", { message: error?.message || String(error) });
		}
	});
}

function updateEmptyState() {
	if (!dom.emptyState || !dom.tileGrid) {
		return;
	}
	const hasTiles = state.tiles.size > 0;
	dom.emptyState.style.display = hasTiles ? "none" : "block";
}

function updateTokenIndicator(token = turnManager.info) {
	if (!dom.tokenIndicator) {
		return;
	}
	dom.tokenIndicator.classList.remove("warn", "danger");
	if (!token) {
		dom.tokenIndicator.textContent = "Loading TURN token…";
		return;
	}
	const ageMs = Date.now() - token.fetchedAt;
	const ttl = token.ttlSec ? token.ttlSec * 1_000 : null;
	let message = `Token age ${Math.floor(ageMs / 60_000)}m`;
	if (ttl) {
		const remaining = Math.max(0, ttl - ageMs);
		const remainingMinutes = Math.floor(remaining / 60_000);
		message += ` • ${remainingMinutes}m left`;
		const ratio = ttl ? ageMs / ttl : 0;
		if (ratio > 0.85) {
			dom.tokenIndicator.classList.add("danger");
		} else if (ratio > 0.7) {
			dom.tokenIndicator.classList.add("warn");
		}
	}
	dom.tokenIndicator.textContent = message;
}

function updateSummary() {
	let relays = 0;
	let totalBitrate = 0;
	let rttSum = 0;
	let rttCount = 0;
	state.tiles.forEach((tile) => {
		const stats = tile.lastStats;
		if (!stats) {
			return;
		}
		if (stats.candidateType === "relay") {
			relays += 1;
		}
		if (Number.isFinite(stats.bitrateKbps)) {
			totalBitrate += stats.bitrateKbps;
		}
		if (Number.isFinite(stats.rttMs)) {
			rttSum += stats.rttMs;
			rttCount += 1;
		}
	});
	if (dom.summaryActive) {
		dom.summaryActive.textContent = String(relays);
	}
	if (dom.summaryBitrate) {
		dom.summaryBitrate.textContent = formatBitrate(totalBitrate);
	}
	if (dom.summaryRtt) {
		dom.summaryRtt.textContent = rttCount ? formatRtt(rttSum / rttCount) : "--";
	}
	if (dom.summaryRefreshed) {
		const fetchedAt = turnManager.fetchedAt;
		dom.summaryRefreshed.textContent = fetchedAt ? new Date(fetchedAt).toLocaleTimeString() : "--";
	}
}

async function ensureVisibilityStore() {
	if (state.visibilityStore) {
		return state.visibilityStore;
	}
	const store = new VisibilityStore({
		fetchInitial: async () => fetchJson(buildApiUrl(VISIBILITY_ENDPOINT)),
		pushUpdate: ({ id, visible }) => postJson(buildApiUrl(VISIBILITY_ENDPOINT), { id, visible }),
		onRemoteUpdate: (handler) => {
			remoteVisibilityListeners.add(handler);
			return () => remoteVisibilityListeners.delete(handler);
		},
	});
	state.visibilityStore = store;
	await store.ready();
	return store;
}

function emitRemoteVisibility(payload) {
	remoteVisibilityListeners.forEach((fn) => {
		try {
			fn(payload);
		} catch (error) {
			// ignore
		}
	});
}

async function loadRoster() {
	try {
		const payload = await fetchJson(buildApiUrl(ROSTER_ENDPOINT));
		const roster = new Map();
		if (Array.isArray(payload?.cameras)) {
			payload.cameras.forEach((camera) => {
				if (!camera?.nickname) {
					return;
				}
				const key = nicknameKey(camera.nickname);
				if (!key) {
					return;
				}
				roster.set(key, {
					slot: camera.observerSlot ?? camera.slot ?? "?",
					team: camera.team ?? "?",
				});
			});
		}
		state.roster = roster;
		state.tiles.forEach((tile, key) => {
			tile.setRosterMeta(roster.get(key));
		});
		logDebug("roster", "loaded", { size: roster.size });
	} catch (error) {
		logDebug("roster", "error", { message: error?.message || String(error) });
	}
}

async function ensureTile(key, nickname) {
	let tile = state.tiles.get(key);
	if (tile) {
		tile.setNickname(nickname);
		tile.setRosterMeta(state.roster.get(key));
		return tile;
	}
	const visibilityStore = await ensureVisibilityStore();
	tile = new TileController({
		key,
		nickname,
		container: dom.tileGrid,
		turnManager,
		visibilityStore,
		signal: signalHub,
	});
	tile.setRosterMeta(state.roster.get(key));
	state.tiles.set(key, tile);
	tile.start("initial").catch((error) => tile.handleError("start", error));
	updateEmptyState();
	return tile;
}

function cleanupMissingTiles(activeKeys) {
	const toRemove = [];
	state.tiles.forEach((tile, key) => {
		if (!activeKeys.has(key)) {
			toRemove.push(key);
		}
	});
	toRemove.forEach((key) => {
		const tile = state.tiles.get(key);
		if (tile) {
			tile.stop();
		}
		state.tiles.delete(key);
	});
	updateEmptyState();
	updateSummary();
}

function bindControls() {
	dom.muteAll?.addEventListener("click", () => tilesForEach((tile) => tile.setAudioMuted(true)));
	dom.unmuteAll?.addEventListener("click", () => tilesForEach((tile) => tile.setAudioMuted(false)));
	dom.freezeAll?.addEventListener("click", () => tilesForEach((tile) => tile.setPaused(true)));
	dom.resumeAll?.addEventListener("click", () => tilesForEach((tile) => tile.setPaused(false)));
	dom.reconnectAll?.addEventListener("click", () => tilesForEach((tile) => tile.restart("global")));
	dom.refreshTurn?.addEventListener("click", () => {
		turnManager
			.refresh(true)
			.then(() => updateTokenIndicator())
			.catch((error) => logDebug("turn", "manual-refresh-error", { message: error?.message || String(error) }));
	});
	dom.reloadRoster?.addEventListener("click", () => loadRoster());
	dom.debugToggle?.addEventListener("click", () => toggleDebug());
	dom.forceTurnToggle?.addEventListener("change", (event) => {
		state.turnOnly = Boolean(event.target.checked);
		tilesForEach((tile) => tile.restart("turn-toggle"));
	});
	dom.applyTurnKey?.addEventListener("click", () => {
		const value = dom.turnKeyInput?.value?.trim();
		if (value) {
			setTurnAdminKey(value);
			turnManager.refresh(true).catch((error) => logDebug("turn", "key-refresh-error", { message: error?.message || String(error) }));
		}
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "d" || event.key === "D") {
			toggleDebug();
		}
		if (event.key === "t" || event.key === "T") {
			if (dom.forceTurnToggle) {
				dom.forceTurnToggle.checked = !dom.forceTurnToggle.checked;
				dom.forceTurnToggle.dispatchEvent(new Event("change"));
			}
		}
		if (event.key === "r" || event.key === "R") {
			if (state.focusedTile) {
				state.focusedTile.restart("keyboard");
			}
		}
	});
}

function toggleDebug() {
	state.debugEnabled = !state.debugEnabled;
	if (dom.debugPanel) {
		dom.debugPanel.style.display = state.debugEnabled ? "grid" : "none";
	}
	tilesForEach((tile) => tile.root?.classList.toggle("tile-debug", state.debugEnabled));
}

function handlePublishers(list) {
	const incoming = new Map();
	if (Array.isArray(list)) {
		list.forEach((name) => {
			const normalized = normalizeNickname(name);
			const key = nicknameKey(normalized);
			if (normalized && key) {
				incoming.set(key, normalized);
			}
		});
	}
	const ensurePromises = [];
	incoming.forEach((nickname, key) => {
		ensurePromises.push(ensureTile(key, nickname));
	});
	Promise.allSettled(ensurePromises).then(() => updateSummary());
	cleanupMissingTiles(incoming);
}

function handleSignalMessage(payload) {
	switch (payload?.type) {
		case "WELCOME":
			handlePublishers(payload.publishers || []);
			break;
		case "ACTIVE_PUBLISHERS":
			handlePublishers(payload.publishers || []);
			break;
		case "SIGNAL_PUBLISHER_ANSWER": {
			const key = nicknameKey(payload.nickname);
			const tile = key ? state.tiles.get(key) : null;
			tile?.handleAnswer(payload);
			break;
		}
		case "SIGNAL_PUBLISHER_CANDIDATE": {
			const key = nicknameKey(payload.nickname);
			const tile = key ? state.tiles.get(key) : null;
			tile?.handleRemoteCandidate(payload);
			break;
		}
		case "STREAM_UNAVAILABLE":
		case "STREAM_ENDED": {
			const key = nicknameKey(payload.nickname);
			const tile = key ? state.tiles.get(key) : null;
			tile?.handleStreamUnavailable(payload);
			break;
		}
		case "visibility.update":
			emitRemoteVisibility(payload);
			break;
		default:
			break;
	}
}

async function bootstrap() {
	bindControls();
	if (dom.forceTurnToggle) {
		dom.forceTurnToggle.checked = state.turnOnly;
	}
	await ensureVisibilityStore();
	await loadRoster();
	await turnManager.ensure();
	updateTokenIndicator();
	signalHub.on("message", handleSignalMessage);
	signalHub.connect();
	updateEmptyState();
}

bootstrap().catch((error) => {
	logDebug("init", "failed", { message: error?.message || String(error) });
});
