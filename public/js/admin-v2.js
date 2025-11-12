import { API_BASE, WS_BASE } from "./endpoints.js";
import { logEv } from "./webrtc/diag.js";
import { getQueryFlag, parseCandidate } from "./webrtc/utils.js";

const FORCE_TURN_STORAGE_KEY = "adminV2ForceTurn";
const BITRATE_OPTIONS = [300, 600, 1200, 2500];
const STATS_INTERVAL_MS = 15_000;
const ZERO_DATA_THRESHOLD_MS = 15_000;
const TOKEN_REFRESH_INTERVAL_MS = 20 * 60 * 1_000;
const ROSTER_REFRESH_MS = 30_000;
const MAX_DEBUG_ENTRIES = 120;
const ICE_RECONNECT_DELAYS = [500, 1_000, 2_000, 4_000, 8_000];

const dom = {
	summaryBar: document.getElementById("summaryBar"),
	tokenIndicator: document.getElementById("tokenIndicator"),
	tileGrid: document.getElementById("tileGrid"),
	emptyState: document.getElementById("emptyState"),
	muteAllBtn: document.getElementById("muteAllBtn"),
	unmuteAllBtn: document.getElementById("unmuteAllBtn"),
	freezeAllBtn: document.getElementById("freezeAllBtn"),
	resumeAllBtn: document.getElementById("resumeAllBtn"),
	maxBitrateSelect: document.getElementById("maxBitrateSelect"),
	forceTurnToggle: document.getElementById("forceTurnToggle"),
	refreshTurnBtn: document.getElementById("refreshTurnBtn"),
	reloadRosterBtn: document.getElementById("reloadRosterBtn"),
	debugToggleBtn: document.getElementById("debugToggleBtn"),
	debugPanel: document.getElementById("debugPanel"),
	debugOutput: document.getElementById("debugOutput"),
	tcpOnlyToggle: null,
	reconnectBtn: null,
	fatalBanner: null,
};

dom.summaryCards = {
	active: dom.summaryBar?.children?.[0]?.querySelector("strong") || null,
	bitrate: dom.summaryBar?.children?.[1]?.querySelector("strong") || null,
	rtt: dom.summaryBar?.children?.[2]?.querySelector("strong") || null,
	refreshed: dom.summaryBar?.children?.[3]?.querySelector("strong") || null,
};

const state = {
	forceTurnOnly: true,
	tcpOnlyPreferred: false,
	sessions: new Map(),
	roster: new Map(),
	ws: null,
	wsReady: false,
	viewerRegistered: false,
	currentKey: null,
	currentSession: null,
	connection: null,
	statsTimer: null,
	zeroTrafficSince: null,
	zeroTrafficRestarted: false,
	checkingSince: null,
	lastStatsSample: null,
	debugEnabled: false,
	debugEntries: [],
	tokenTimer: null,
	rosterTimer: null,
	lastConfigRefresh: 0,
	configTtlSec: null,
	lastCandidateWarningType: null,
};

const signalQueue = [];

const diagState = {
	iceState: "new",
	connectionState: "new",
	candidateType: "--",
	relayIp: null,
	bitrateKbps: 0,
	rttMs: 0,
	selectedPair: null,
	outgoingBitrateKbps: 0,
};

try {
	window.__webrtcDiag = {
		snapshot: () => ({ ...diagState }),
	};
} catch (error) {
	// ignore window assignment issues
}

function log(scope, event, payload) {
	logEv(scope, event, payload);
	try {
		if (typeof window.__webrtcLog === "function" && window.__webrtcLog !== log) {
			window.__webrtcLog(scope, event, payload);
		}
	} catch (error) {
		// ignore logging bridge errors
	}
}

try {
	window.__webrtcLog = log;
} catch (error) {
	// ignore window assignment failures
}

const pcManager = {
	pc: null,
	dc: null,
	keepAliveDc: null,
	keepAliveTimer: null,
	creating: false,
	createdCount: 0,
	maxPcCount: 8,
		reconnectAttempts: 0,
	maxReconnectAttempts: 4,
	reconnectTimer: null,
	negotiationTimer: null,
	negotiationQueued: false,
	negotiating: false,
	lastOptions: { turnOnly: true, tcpOnly: false },
	session: null,
	context: null,
	fallbackAttempted: false,
	autoCleanupRegistered: false,
	connectionFailTimer: null,
	gatheredCandidates: [],
	lastSelectedPairId: null,

	setSession(session) {
		this.session = session || null;
	},

	setContext(context) {
		this.context = context || null;
	},

	resetNegotiationDebounce() {
		if (this.negotiationTimer) {
			clearTimeout(this.negotiationTimer);
			this.negotiationTimer = null;
		}
		this.negotiationQueued = false;
	},

	async destroy(reason = "destroy", options = {}) {
		const { preserveContext = false } = options;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.connectionFailTimer) {
			clearTimeout(this.connectionFailTimer);
			this.connectionFailTimer = null;
		}
		this.resetNegotiationDebounce();
		const pc = this.pc;
		const diagChannel = this.dc;
		const keepAliveDc = this.keepAliveDc;
		this.pc = null;
		this.dc = null;
		if (this.keepAliveTimer) {
			clearInterval(this.keepAliveTimer);
			this.keepAliveTimer = null;
		}
		if (diagChannel) {
			try {
				diagChannel.close();
			} catch (error) {
				// ignore
			}
		}
		if (keepAliveDc) {
			try {
				keepAliveDc.close();
			} catch (error) {
				// ignore
			}
		}
		this.keepAliveDc = null;
		this.creating = false;
		this.negotiating = false;

		stopStatsLoop();
		diagState.bitrateKbps = 0;
		diagState.rttMs = 0;
		diagState.relayIp = null;
		diagState.candidateType = "--";
		diagState.selectedPair = null;
		diagState.iceState = "closed";
		diagState.connectionState = "closed";
		diagState.outgoingBitrateKbps = 0;
		this.gatheredCandidates = [];
		this.lastSelectedPairId = null;
		state.checkingSince = null;
		state.zeroTrafficSince = null;
		state.zeroTrafficRestarted = false;
		state.lastCandidateWarningType = null;

		if (pc) {
			try {
				const senders = typeof pc.getSenders === "function" ? pc.getSenders() : [];
				senders.forEach((sender) => {
					try {
						if (sender.track) {
							sender.track.stop();
						}
					} catch (error) {
						// ignore
					}
				});
			} catch (error) {
				// ignore
			}

			try {
				const receivers = typeof pc.getReceivers === "function" ? pc.getReceivers() : [];
				receivers.forEach((receiver) => {
					try {
						if (receiver.track) {
							receiver.track.stop();
						}
					} catch (error) {
						// ignore
					}
				});
			} catch (error) {
				// ignore
			}

			try {
				const transceivers = typeof pc.getTransceivers === "function" ? pc.getTransceivers() : [];
				transceivers.forEach((transceiver) => {
					try {
						transceiver.stop?.();
					} catch (error) {
						// ignore
					}
				});
			} catch (error) {
				// ignore
			}

			try {
				pc.onicecandidate = null;
				pc.onicecandidateerror = null;
				pc.onicegatheringstatechange = null;
				pc.oniceconnectionstatechange = null;
				pc.onconnectionstatechange = null;
				pc.onnegotiationneeded = null;
				pc.ontrack = null;
				pc.close();
			} catch (error) {
				// ignore close errors
			}
		}

		if (this.session) {
			clearSessionMedia(this.session);
			setSessionStatus(this.session, "Idle", "");
			setSessionCandidateSummary(this.session, "Candidate: --");
			updateTileFooter(this.session);
		}

		if (state.connection && !preserveContext) {
			sendStop(state.connection, reason);
			clearConnectionContext();
		}

		log("admin", "pc-destroyed", { reason });
	},

	async create(options = {}) {
		if (this.creating) {
			return this.pc;
		}
		if (!this.session) {
			throw new Error("no session selected");
		}
		if (this.pc) {
			throw new Error("pc already exists; call destroy first");
		}
		this.creating = true;

		const turnOnly = options.turnOnly !== undefined ? Boolean(options.turnOnly) : true;
		const tcpOnly = options.tcpOnly !== undefined ? Boolean(options.tcpOnly) : false;
		this.lastOptions = { turnOnly, tcpOnly };

		if (this.createdCount >= this.maxPcCount) {
			this.creating = false;
			throw new Error("PC limit reached");
		}

		try {
			const { iceServers, ttlSec } = await fetchIceConfig({ turnOnly, tcpOnly });
			const config = {
				iceServers,
				iceTransportPolicy: turnOnly ? "relay" : "all",
				bundlePolicy: "max-bundle",
				rtcpMuxPolicy: "require",
				iceCandidatePoolSize: 2,
				sdpSemantics: "unified-plan",
			};
			log("ice", "servers_applied", { count: iceServers.length, tcpOnly, turnOnly });

			const pc = new RTCPeerConnection(config);
			this.pc = pc;
			this.createdCount += 1;
			this.fallbackAttempted = tcpOnly;
			this.gatheredCandidates = [];
			this.lastSelectedPairId = null;
			state.zeroTrafficRestarted = false;
			state.zeroTrafficSince = null;
			this.attachEvents(pc);
			this.ensureRecvOnly(pc);
			this.createDiagChannel(pc);
			this.setupKeepAlive(pc);
			console.log("[pc] created", { turnOnly, tcpOnly });
			log("admin", "pc created", { turnOnly, tcpOnly, ttlSec });
			return pc;
		} finally {
			this.creating = false;
		}
	},

	async negotiate({ reason = "manual", iceRestart = false } = {}) {
		if (!this.pc) {
			throw new Error("no pc");
		}
		if (this.negotiating) {
			this.negotiationQueued = { reason, iceRestart };
			return;
		}
		if (!this.context) {
			throw new Error("no connection context");
		}

		this.negotiating = true;
		log("admin", "negotiate-start", { reason, iceRestart });

		try {
			const offer = await this.pc.createOffer({ iceRestart });
			await this.pc.setLocalDescription(offer);
			const answer = await sendOffer(offer);
			await this.pc.setRemoteDescription(answer);

			const localSdp = this.pc.localDescription?.sdp || "";
			const hasRelay = / typ relay /i.test(localSdp);
			if (!hasRelay) {
				log("admin", "non-relay-detected", {
					reason,
					tcpOnly: this.lastOptions.tcpOnly,
					turnOnly: this.lastOptions.turnOnly,
				});
				console.warn("[ice] nonrelay", { reason, tcpOnly: this.lastOptions.tcpOnly, turnOnly: this.lastOptions.turnOnly });
				if (!this.lastOptions.tcpOnly && !this.fallbackAttempted) {
					this.fallbackAttempted = true;
					const fallbackTurnOnly = this.lastOptions.turnOnly !== undefined ? this.lastOptions.turnOnly : true;
					const fallbackOptions = { turnOnly: fallbackTurnOnly, tcpOnly: true };
					this.lastOptions = fallbackOptions;
					log("admin", "tcp-fallback", { reason });
					const session = this.session;
					const fallbackContext = prepareConnectionContext(session, fallbackOptions, "tcp-fallback");
					this.setContext(fallbackContext);
					await this.create(fallbackOptions);
					return this.negotiate({ reason: "tcp-fallback" });
				}
				showFatal("No relay candidates from TURN. Check TURN creds/ports.");
				throw new Error("non-relay-detected");
			}

			log("admin", "relay-detected", {
				reason,
				tcpOnly: this.lastOptions.tcpOnly,
				turnOnly: this.lastOptions.turnOnly,
			});
			console.log("[ice] relay_detected", { reason, tcpOnly: this.lastOptions.tcpOnly, turnOnly: this.lastOptions.turnOnly });
			this.reconnectAttempts = 0;
			return true;
		} catch (error) {
			log("admin", "offer-failed", { message: error?.message || String(error), reason });
			if (this.context && typeof this.context.rejectAnswer === "function") {
				this.context.rejectAnswer(error);
			}
			throw error;
		} finally {
			this.negotiating = false;
			const queued = this.negotiationQueued;
			this.negotiationQueued = false;
			if (queued) {
				this.negotiate(queued).catch((err) => {
					log("admin", "negotiate-error", { message: err?.message || String(err) });
				});
			}
		}
	},

	scheduleReconnect(reason, overrides = {}) {
		const session = this.session || state.currentSession;
		if (!session) {
			return;
		}

		const turnOnly =
			overrides.turnOnly !== undefined
				? Boolean(overrides.turnOnly)
				: this.lastOptions.turnOnly !== undefined
					? Boolean(this.lastOptions.turnOnly)
					: Boolean(state.forceTurnOnly);
		const tcpOnly =
			overrides.tcpOnly !== undefined
				? Boolean(overrides.tcpOnly)
				: this.lastOptions.tcpOnly !== undefined
					? Boolean(this.lastOptions.tcpOnly)
					: Boolean(state.tcpOnlyPreferred);
		const options = { turnOnly, tcpOnly };

		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			showFatal("Relay not available. Check TURN.");
			return;
		}

		const delayIndex = Math.min(this.reconnectAttempts, ICE_RECONNECT_DELAYS.length - 1);
		const delay = ICE_RECONNECT_DELAYS[delayIndex];
		this.reconnectAttempts += 1;
		log("admin", "reconnect", {
			reason,
			attempt: this.reconnectAttempts,
			delay,
			tcpOnly,
			turnOnly,
		});

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
		}

		this.reconnectTimer = setTimeout(async () => {
			try {
				await this.destroy(`reconnect-${reason}`);
				const context = prepareConnectionContext(session, options, `reconnect-${reason}`);
				this.setSession(session);
				this.setContext(context);
				await this.create(options);
				await this.negotiate({ reason: `reconnect-${reason}`, iceRestart: true });
			} catch (error) {
				log("admin", "reconnect-failed", { reason, message: error?.message || String(error) });
				this.scheduleReconnect(reason, options);
			}
		}, delay);
	},

	async rebuildNow(reason = "rebuild", overrides = {}) {
		const session = this.session || state.currentSession;
		if (!session) {
			return;
		}
		const turnOnly =
			overrides.turnOnly !== undefined
				? Boolean(overrides.turnOnly)
				: this.lastOptions.turnOnly !== undefined
					? Boolean(this.lastOptions.turnOnly)
					: Boolean(state.forceTurnOnly);
		const tcpOnly =
			overrides.tcpOnly !== undefined
				? Boolean(overrides.tcpOnly)
				: this.lastOptions.tcpOnly !== undefined
					? Boolean(this.lastOptions.tcpOnly)
					: Boolean(state.tcpOnlyPreferred);
		const options = { turnOnly, tcpOnly };
		await this.destroy(reason);
		const context = prepareConnectionContext(session, options, reason);
		this.setSession(session);
		this.setContext(context);
		await this.create(options);
		await this.negotiate({ reason, iceRestart: true });
	},

	attachEvents(pc) {
		pc.addEventListener("icecandidate", (event) => {
			if (!event.candidate) {
				console.log("[gather] complete", this.gatheredCandidates);
				log("gather", "complete", { relays: this.gatheredCandidates });
				log("pc", "candidate", { complete: true });
				return;
			}
			const parsed = parseCandidate(event.candidate.candidate || "");
			const type = parsed?.type || "";
			log("pc", "candidate", { type, protocol: parsed?.protocol || "" });
			const forcingRelay = this.lastOptions.turnOnly !== undefined ? this.lastOptions.turnOnly : state.forceTurnOnly;
			if (type && type !== "relay") {
				console.warn("[leak] non-relay candidate seen", { role: "local", type, candidate: event.candidate.candidate });
				if (forcingRelay) {
					log("pc", "candidate_dropped", { type, note: "non-relay" });
					return;
				}
			}
			const relayDescriptor = {
				foundation: parsed?.foundation || "",
				type: parsed?.type || "",
				protocol: parsed?.protocol || "",
				relayProtocol: parsed?.relayProtocol || "",
				address: parsed?.ip ? `${parsed.ip}${parsed.port ? `:${parsed.port}` : ""}` : "",
			};
			this.gatheredCandidates.push(relayDescriptor);
			sendLocalCandidate(event.candidate);
		});

		pc.addEventListener("icecandidateerror", (event) => {
			log("pc", "candidate_error", {
				code: event.errorCode,
				text: event.errorText,
				url: event.url,
				address: event.address,
				port: event.port,
			});
		});

		pc.addEventListener("icegatheringstatechange", () => {
			log("pc", "gather", { state: pc.iceGatheringState });
			if (pc.iceGatheringState === "gathering") {
				this.gatheredCandidates = [];
				console.log("[gather] start");
				log("gather", "start", {});
			}
		});

		pc.addEventListener("iceconnectionstatechange", () => {
			console.log("[ice]", pc.iceConnectionState);
			log("pc", "ice", { state: pc.iceConnectionState });
			diagState.iceState = pc.iceConnectionState;
			if (this.session) {
				this.session.lastIceState = pc.iceConnectionState;
				updateTileFooter(this.session);
				if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
					this.armRestartWatchdog(pc.iceConnectionState);
				} else if (this.connectionFailTimer) {
					clearTimeout(this.connectionFailTimer);
					this.connectionFailTimer = null;
				}
			}
		});

		pc.addEventListener("connectionstatechange", () => {
			console.log("[pc]", pc.connectionState);
			log("pc", "conn", { state: pc.connectionState });
			if (pc.connectionState === "checking") {
				state.checkingSince = Date.now();
				state.zeroTrafficRestarted = false;
			} else if (pc.connectionState === "connected") {
				state.checkingSince = null;
				state.zeroTrafficRestarted = false;
			} else if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
				state.checkingSince = null;
			}
			diagState.connectionState = pc.connectionState;
			if (!this.session) {
				return;
			}
			if (pc.connectionState === "connected") {
				setSessionStatus(this.session, "Connected", "badge-ok");
				if (this.session.dom?.video && this.session.dom.video.paused) {
					this.session.dom.video.play().catch(() => {});
				}
				if (this.connectionFailTimer) {
					clearTimeout(this.connectionFailTimer);
					this.connectionFailTimer = null;
				}
			} else if (pc.connectionState === "failed") {
				setSessionStatus(this.session, "Failed", "badge-fail");
				this.armRestartWatchdog(pc.connectionState);
			} else if (pc.connectionState === "disconnected") {
				setSessionStatus(this.session, "Disconnected", "badge-warn");
				this.armRestartWatchdog(pc.connectionState);
			}
			updateTileFooter(this.session);
		});

		pc.addEventListener("negotiationneeded", () => {
			if (this.negotiationTimer) {
				clearTimeout(this.negotiationTimer);
			}
			this.negotiationTimer = setTimeout(() => {
				this.negotiationTimer = null;
				this.negotiate({ reason: "auto" }).catch((error) => {
					log("admin", "offer-failed", { message: error?.message || String(error), reason: "auto" });
					if (String(error || "").includes("non-relay")) {
						this.scheduleReconnect("non-relay", {
							tcpOnly: true,
							turnOnly: this.lastOptions.turnOnly,
						});
					} else {
						this.scheduleReconnect("offer", { turnOnly: this.lastOptions.turnOnly });
					}
				});
			}, 300);
		});

		pc.addEventListener("track", (event) => {
			const [stream] = event.streams || [];
			if (!this.session || !stream) {
				return;
			}
			this.session.stream = stream;
			if (this.session.dom?.video) {
				this.session.dom.video.srcObject = stream;
				this.session.dom.video.muted = true;
				this.session.dom.video.play().catch(() => {});
			}
			applyMuteStateToStream(this.session);
			applyPauseStateToStream(this.session);
			setSessionStatus(this.session, "Streaming", "badge-ok");
		});
	},

	armRestartWatchdog(stateLabel) {
		if (this.connectionFailTimer) {
			return;
		}
		this.connectionFailTimer = setTimeout(() => {
			this.connectionFailTimer = null;
			if (!this.pc) {
				return;
			}
			const currentState = this.pc.connectionState;
			const currentIce = this.pc.iceConnectionState;
			if (currentState === stateLabel || currentIce === stateLabel) {
				if (typeof this.pc.restartIce === "function") {
					try {
						this.pc.restartIce();
						console.log("[pc] restarted", { state: currentState, ice: currentIce });
						log("pc", "restarted", { state: currentState, ice: currentIce });
					} catch (error) {
						log("pc", "restart-error", { message: error?.message || String(error) });
						this.scheduleReconnect("restart-failed", {
							tcpOnly: this.lastOptions.tcpOnly,
							turnOnly: this.lastOptions.turnOnly,
						});
					}
				} else {
					this.scheduleReconnect("restart-unsupported", {
						tcpOnly: this.lastOptions.tcpOnly,
						turnOnly: this.lastOptions.turnOnly,
					});
				}
			}
		}, 5_000);
	},

	createDiagChannel(pc) {
		try {
			this.dc = pc.createDataChannel("diag");
			this.dc.addEventListener("open", () => {
				log("dc", "open", {});
			});
			this.dc.addEventListener("close", () => {
				log("dc", "close", {});
			});
			this.dc.addEventListener("error", (event) => {
				log("dc", "error", { message: event?.message || "error" });
			});
		} catch (error) {
			log("dc", "create-error", { message: error?.message || String(error) });
		}
	},

	setupKeepAlive(pc) {
		try {
			this.keepAliveDc = pc.createDataChannel("keepalive", {
				ordered: false,
				maxRetransmits: 0,
			});
		} catch (error) {
			console.warn("[pc] keepalive channel error", error);
			return;
		}

		const sendPing = () => {
			if (!this.keepAliveDc || this.keepAliveDc.readyState !== "open") {
				return;
			}
			try {
				this.keepAliveDc.send("ping");
			} catch (error) {
				console.warn("[pc] keepalive send failed", error);
			}
		};

		this.keepAliveDc.addEventListener("open", () => {
			sendPing();
			if (this.keepAliveTimer) {
				clearInterval(this.keepAliveTimer);
			}
			this.keepAliveTimer = setInterval(sendPing, 10_000);
		});

		this.keepAliveDc.addEventListener("close", () => {
			if (this.keepAliveTimer) {
				clearInterval(this.keepAliveTimer);
				this.keepAliveTimer = null;
			}
		});

		this.keepAliveDc.addEventListener("error", (event) => {
			console.warn("[pc] keepalive error", event?.message || event);
		});
	},

	ensureRecvOnly(pc) {
		if (!pc || typeof pc.addTransceiver !== "function") {
			return;
		}
		try {
			const kinds = new Set();
			const existing = typeof pc.getTransceivers === "function" ? pc.getTransceivers() : [];
			existing.forEach((transceiver) => {
				if (transceiver?.receiver?.track?.kind) {
					kinds.add(transceiver.receiver.track.kind);
				}
			});
			if (!kinds.has("video")) {
				pc.addTransceiver("video", { direction: "recvonly" });
			}
		} catch (error) {
			log("admin", "transceiver-error", { message: error?.message || String(error) });
		}
	},
};

registerAutoCleanup(pcManager);

(function init() {
	restoreForceTurnPreference();
	restoreTcpPreference();
	injectTcpOnlyToggle();
	injectReconnectButton();
	bindGlobalEvents();
	updateSummary();
	updateEmptyState();
	primeTurnConfig().catch(() => {});
	loadRoster().catch(() => {});
	connectWebSocket();
	scheduleTokenRefresh();
	scheduleRosterRefresh();
})();

function bindGlobalEvents() {
	dom.muteAllBtn?.addEventListener("click", () => {
		const session = state.currentSession;
		if (session) {
			setSessionMuted(session, true);
		}
	});

	dom.unmuteAllBtn?.addEventListener("click", () => {
		const session = state.currentSession;
		if (session) {
			setSessionMuted(session, false);
		}
	});

	dom.freezeAllBtn?.addEventListener("click", () => {
		const session = state.currentSession;
		if (session) {
			setSessionPaused(session, true);
		}
	});

	dom.resumeAllBtn?.addEventListener("click", () => {
		const session = state.currentSession;
		if (session) {
			setSessionPaused(session, false);
		}
	});

	dom.maxBitrateSelect?.addEventListener("change", (event) => {
		const session = state.currentSession;
		const value = Number.parseInt(event.target.value, 10);
		if (!session || !BITRATE_OPTIONS.includes(value)) {
			return;
		}
		session.maxBitrate = value;
		applyMaxBitrate(session).catch(() => {});
	});

	dom.forceTurnToggle?.addEventListener("change", (event) => {
		applyForceTurnPreference(Boolean(event.target.checked));
	});

	dom.tcpOnlyToggle?.addEventListener("change", (event) => {
		state.tcpOnlyPreferred = Boolean(event.target.checked);
		pcManager.scheduleReconnect("tcp-toggle", {
			tcpOnly: state.tcpOnlyPreferred,
			turnOnly: state.forceTurnOnly,
		});
	});

	dom.refreshTurnBtn?.addEventListener("click", () => {
		primeTurnConfig()
			.then(() => {
				pcManager.scheduleReconnect("token-refresh", {
					tcpOnly: state.tcpOnlyPreferred,
					turnOnly: state.forceTurnOnly,
				});
			})
			.catch(() => {});
	});

	dom.reloadRosterBtn?.addEventListener("click", () => {
		loadRoster(true).catch(() => {});
	});

	dom.debugToggleBtn?.addEventListener("click", toggleDebugPanel);

	dom.reconnectBtn?.addEventListener("click", () => {
		pcManager.scheduleReconnect("button", {
			tcpOnly: state.tcpOnlyPreferred,
			turnOnly: state.forceTurnOnly,
		});
	});
}

function injectTcpOnlyToggle() {
	if (!dom.forceTurnToggle) {
		return;
	}
	const row = dom.forceTurnToggle.closest(".control-row");
	if (!row || !row.parentElement) {
		return;
	}
	const newRow = document.createElement("div");
	newRow.className = "control-row";
	const label = document.createElement("label");
	label.className = "toggle";
	label.textContent = "Prefer TCP TURN";
	const input = document.createElement("input");
	input.type = "checkbox";
	input.id = "tcpOnlyToggle";
	input.checked = Boolean(state.tcpOnlyPreferred);
	label.appendChild(input);
	newRow.appendChild(label);
	row.parentElement.appendChild(newRow);
	dom.tcpOnlyToggle = input;
}

function injectReconnectButton() {
	const group = dom.refreshTurnBtn?.parentElement;
	if (!group) {
		return;
	}
	const button = document.createElement("button");
	button.textContent = "Reconnect";
	group.appendChild(button);
	dom.reconnectBtn = button;
}

function restoreForceTurnPreference() {
	let stored = null;
	try {
		stored = localStorage.getItem(FORCE_TURN_STORAGE_KEY);
	} catch (error) {
		stored = null;
	}
	let forceTurn = stored === null ? true : stored === "true";
	try {
		const url = new URL(window.location.href);
		if (url.searchParams.has("turnOnly")) {
			forceTurn = getQueryFlag("turnOnly", forceTurn ? 1 : 0);
		}
	} catch (error) {
		// ignore URL parse errors
	}
	state.forceTurnOnly = forceTurn;
	if (dom.forceTurnToggle) {
		dom.forceTurnToggle.checked = state.forceTurnOnly;
		dom.forceTurnToggle.disabled = true;
	}
	pcManager.lastOptions = {
		...pcManager.lastOptions,
		turnOnly: state.forceTurnOnly,
	};
}

function restoreTcpPreference() {
	let preferred = false;
	try {
		const url = new URL(window.location.href);
		if (url.searchParams.has("tcpOnly")) {
			preferred = getQueryFlag("tcpOnly", 0);
		}
	} catch (error) {
		preferred = false;
	}
	state.tcpOnlyPreferred = preferred;
	if (dom.tcpOnlyToggle) {
		dom.tcpOnlyToggle.checked = preferred;
	}
	pcManager.lastOptions = {
		...pcManager.lastOptions,
		tcpOnly: state.tcpOnlyPreferred,
	};
}

function persistForceTurnPreference() {
	try {
		localStorage.setItem(FORCE_TURN_STORAGE_KEY, state.forceTurnOnly ? "true" : "false");
	} catch (error) {
		// ignore storage errors
	}
}

function applyForceTurnPreference(enabled) {
	state.forceTurnOnly = Boolean(enabled);
	if (dom.forceTurnToggle) {
		dom.forceTurnToggle.checked = state.forceTurnOnly;
	}
 	pcManager.lastOptions = {
		...pcManager.lastOptions,
		turnOnly: state.forceTurnOnly,
	};
	persistForceTurnPreference();
	updateTokenIndicator();
	pcManager.scheduleReconnect("force-toggle", {
		tcpOnly: state.tcpOnlyPreferred,
		turnOnly: state.forceTurnOnly,
	});
}

async function primeTurnConfig() {
	try {
		const { ttlSec } = await fetchIceConfig({ turnOnly: state.forceTurnOnly, tcpOnly: state.tcpOnlyPreferred });
		state.lastConfigRefresh = Date.now();
		state.configTtlSec = ttlSec || null;
		updateTokenIndicator();
		updateSummary();
		logDebug("TURN token primed", { ttlSec: ttlSec || null });
	} catch (error) {
		logDebug("Failed to prime TURN config", error?.message || String(error));
	}
}

function scheduleTokenRefresh() {
	if (state.tokenTimer) {
		clearInterval(state.tokenTimer);
	}
	state.tokenTimer = setInterval(() => {
		primeTurnConfig()
			.then(() => {
				pcManager.scheduleReconnect("token-interval", {
					tcpOnly: state.tcpOnlyPreferred,
					turnOnly: state.forceTurnOnly,
				});
			})
			.catch(() => {});
	}, TOKEN_REFRESH_INTERVAL_MS);
}

function scheduleRosterRefresh() {
	if (state.rosterTimer) {
		clearInterval(state.rosterTimer);
	}
	state.rosterTimer = setInterval(() => {
		loadRoster().catch(() => {});
	}, ROSTER_REFRESH_MS);
}

async function loadRoster(explicit = false) {
	try {
		const [cameraPayload, gsiPayload] = await Promise.all([
			fetchJson("/api/admin/cameras", { timeoutMs: 10_000 }),
			fetchJson("/api/gsi/state", { timeoutMs: 10_000 }).catch(() => null),
		]);

		const roster = new Map();
		if (Array.isArray(cameraPayload?.cameras)) {
			cameraPayload.cameras.forEach((camera) => {
				if (!camera?.nickname) {
					return;
				}
				const key = normalizeKey(camera.nickname);
				if (!key) {
					return;
				}
				roster.set(key, {
					nickname: camera.nickname,
					team: camera.team || "",
					slot: camera.observerSlot || camera.slot || "",
				});
			});
		}

		const players = gsiPayload?.players || gsiPayload?.allplayers || null;
		if (players && typeof players === "object") {
			Object.values(players).forEach((player) => {
				const name = player?.name || player?.player_name || "";
				const key = normalizeKey(name);
				if (!key) {
					return;
				}
				const existing = roster.get(key) || {};
				roster.set(key, {
					nickname: existing.nickname || name,
					team: (player.team || existing.team || "").toUpperCase(),
					slot: Number.isFinite(player.observer_slot) ? player.observer_slot : existing.slot || "",
				});
			});
		}

		state.roster = roster;
		state.sessions.forEach(updateTileMeta);
		if (explicit) {
			logDebug("Roster refreshed", { size: roster.size });
		}
	} catch (error) {
		if (explicit) {
			logDebug("Failed to load roster", error?.message || String(error));
		}
	}
}

function connectWebSocket() {
	if (state.ws) {
		try {
			state.ws.close();
		} catch (error) {
			// ignore
		}
	}

	const socket = new WebSocket(WS_BASE);
	state.ws = socket;

	socket.addEventListener("open", () => {
		state.wsReady = true;
		state.viewerRegistered = false;
		sendSignal({ type: "HELLO", role: "viewer" });
		flushSignalQueue();
		logDebug("Signal socket connected");
	});

	socket.addEventListener("message", (event) => {
		try {
			const payload = JSON.parse(event.data);
			handleSignal(payload);
		} catch (error) {
			// ignore bad payloads
		}
	});

	socket.addEventListener("close", () => {
		state.wsReady = false;
		state.viewerRegistered = false;
		logDebug("Signal socket closed; retrying");
		setTimeout(connectWebSocket, 2_000);
	});

	socket.addEventListener("error", (event) => {
		logDebug("Signal socket error", event?.message || "error");
	});
}

function sendSignal(message) {
	const payload = JSON.stringify(message);
	if (!state.ws || !state.wsReady) {
		signalQueue.push(payload);
		return;
	}
	try {
		state.ws.send(payload);
	} catch (error) {
		signalQueue.push(payload);
	}
}

function flushSignalQueue() {
	while (state.wsReady && signalQueue.length) {
		const payload = signalQueue.shift();
		try {
			state.ws.send(payload);
		} catch (error) {
			signalQueue.unshift(payload);
			break;
		}
	}
}

function handleSignal(payload) {
	switch (payload?.type) {
		case "WELCOME":
			state.viewerRegistered = true;
			handleActivePublishers(payload.publishers || []);
			break;
		case "VIEWER_REGISTERED":
			state.viewerRegistered = true;
			break;
		case "ACTIVE_PUBLISHERS":
			handleActivePublishers(payload.publishers || []);
			break;
		case "SIGNAL_PUBLISHER_ANSWER":
			handlePublisherAnswer(payload);
			break;
		case "SIGNAL_PUBLISHER_CANDIDATE":
			handlePublisherCandidate(payload);
			break;
		case "STREAM_UNAVAILABLE":
		case "STREAM_ENDED":
			handleStreamUnavailable(payload);
			break;
		default:
			break;
	}
}

function handleActivePublishers(list) {
	const incoming = new Map();
	if (Array.isArray(list)) {
		list.forEach((name) => {
			const nickname = normalizeNickname(name);
			const key = normalizeKey(nickname);
			if (nickname && key) {
				incoming.set(key, nickname);
			}
		});
	}

	incoming.forEach((nickname, key) => {
		ensureSession(key, nickname);
	});

	state.sessions.forEach((session, key) => {
		if (!incoming.has(key)) {
			removeSession(session);
		}
	});

	if (!state.currentSession) {
		const firstKey = incoming.keys().next();
		if (!firstKey.done) {
			const session = state.sessions.get(firstKey.value);
			if (session) {
				setActiveSession(session, "initial");
			}
		}
	}

	updateEmptyState();
}

function ensureSession(key, nickname) {
	let session = state.sessions.get(key);
	if (!session) {
		session = {
			key,
			nickname,
			stream: null,
			audioMuted: true,
			videoPaused: false,
			maxBitrate: 1_200,
			lastError: "",
			lastIceState: "new",
			stats: null,
			lastStatsSample: null,
			dom: null,
		};
		state.sessions.set(key, session);
		createTile(session);
	} else if (nickname && session.nickname !== nickname) {
		session.nickname = nickname;
		if (session.dom?.title) {
			session.dom.title.textContent = nickname;
		}
	}
	updateTileMeta(session);
	return session;
}

function createTile(session) {
	const root = document.createElement("div");
	root.className = "tile";
	root.dataset.key = session.key;

	const header = document.createElement("div");
	header.className = "tile-header";
	const heading = document.createElement("div");
	const title = document.createElement("h3");
	title.textContent = session.nickname;
	heading.appendChild(title);
	const meta = document.createElement("div");
	meta.className = "tile-meta";
	heading.appendChild(meta);
	header.appendChild(heading);
	const status = document.createElement("span");
	status.className = "tile-status";
	status.textContent = "Idle";
	header.appendChild(status);
	root.appendChild(header);

	const videoWrap = document.createElement("div");
	videoWrap.className = "video-wrap";
	const video = document.createElement("video");
	video.autoplay = true;
	video.playsInline = true;
	video.muted = true;
	video.disablePictureInPicture = true;
	videoWrap.appendChild(video);
	const overlay = document.createElement("div");
	overlay.className = "video-overlay";
	const candidateLabel = document.createElement("span");
	candidateLabel.textContent = "Candidate: --";
	overlay.appendChild(candidateLabel);
	const iceLabel = document.createElement("span");
	iceLabel.textContent = "State: --";
	overlay.appendChild(iceLabel);
	videoWrap.appendChild(overlay);
	root.appendChild(videoWrap);

	const statsRow = document.createElement("div");
	statsRow.className = "stats-row";
	const bitrateNode = createStatNode("Bitrate");
	const fpsNode = createStatNode("FPS");
	const rttNode = createStatNode("RTT");
	const lossNode = createStatNode("Loss");
	const stateNode = createStatNode("ICE");
	statsRow.append(bitrateNode.root, fpsNode.root, rttNode.root, lossNode.root, stateNode.root);
	root.appendChild(statsRow);

	const controls = document.createElement("div");
	controls.className = "tile-controls";
	const controlButtons = document.createElement("div");
	controlButtons.className = "control-buttons";
	const connectBtn = document.createElement("button");
	connectBtn.textContent = "Focus";
	connectBtn.addEventListener("click", () => {
		setActiveSession(session, "manual");
	});
	const muteBtn = document.createElement("button");
	muteBtn.textContent = session.audioMuted ? "Unmute" : "Mute";
	muteBtn.addEventListener("click", () => {
		setSessionMuted(session, !session.audioMuted);
	});
	const pauseBtn = document.createElement("button");
	pauseBtn.textContent = session.videoPaused ? "Resume" : "Pause";
	pauseBtn.addEventListener("click", () => {
		setSessionPaused(session, !session.videoPaused);
	});
	controlButtons.append(connectBtn, muteBtn, pauseBtn);
	controls.appendChild(controlButtons);

	const bitrateSelect = document.createElement("select");
	BITRATE_OPTIONS.forEach((option) => {
		const node = document.createElement("option");
		node.value = String(option);
		node.textContent = `${option}`;
		if (option === session.maxBitrate) {
			node.selected = true;
		}
		bitrateSelect.appendChild(node);
	});
	bitrateSelect.addEventListener("change", () => {
		const value = Number.parseInt(bitrateSelect.value, 10);
		if (BITRATE_OPTIONS.includes(value)) {
			session.maxBitrate = value;
			applyMaxBitrate(session).catch(() => {});
		}
	});
	controls.appendChild(bitrateSelect);
	root.appendChild(controls);

	const footer = document.createElement("div");
	footer.className = "tile-footer";
	const footerState = document.createElement("span");
	footerState.textContent = "ICE: new";
	const footerError = document.createElement("span");
	footer.append(footerState, footerError);
	root.appendChild(footer);

	dom.tileGrid?.appendChild(root);

	session.dom = {
		root,
		title,
		meta,
		status,
		video,
		candidate: candidateLabel,
		iceState: iceLabel,
		statBitrate: bitrateNode.value,
		statFps: fpsNode.value,
		statRtt: rttNode.value,
		statLoss: lossNode.value,
		statState: stateNode.value,
		connectBtn,
		muteBtn,
		pauseBtn,
		bitrateSelect,
		footerState,
		footerError,
	};

	updateTileMeta(session);
	updateTileFooter(session);
}

function createStatNode(label) {
	const span = document.createElement("span");
	const title = document.createTextNode(label);
	const value = document.createElement("strong");
	value.textContent = "--";
	span.append(title, value);
	return { root: span, value };
}

function setActiveSession(session, reason) {
	if (!session) {
		return;
	}
	if (state.currentKey === session.key) {
		pcManager.scheduleReconnect(reason || "manual", {
			tcpOnly: state.tcpOnlyPreferred,
			turnOnly: state.forceTurnOnly,
		});
		return;
	}

	if (state.currentSession) {
		state.currentSession.dom?.root.classList.remove("tile-active");
	}

	state.currentKey = session.key;
	state.currentSession = session;
	session.dom?.root.classList.add("tile-active");

	pcManager.setSession(session);
	startConnection(reason || "switch").catch((error) => {
		session.lastError = error?.message || String(error);
		setSessionStatus(session, "Failed", "badge-fail");
		updateTileFooter(session);
	});
}

async function startConnection(reason) {
	const session = state.currentSession;
	if (!session || !state.viewerRegistered) {
		return;
	}

	pcManager.setSession(session);
	await pcManager.destroy("pre-start");

	pcManager.reconnectAttempts = 0;
	clearSessionMedia(session);
	setSessionStatus(session, "Connecting", "badge-warn");
	session.lastError = "";
	updateTileFooter(session);

	const options = { turnOnly: state.forceTurnOnly, tcpOnly: state.tcpOnlyPreferred };
	const context = prepareConnectionContext(session, options, reason || "initial");
	pcManager.setContext(context);

	try {
		await pcManager.create(options);
		await pcManager.negotiate({ reason: reason || "initial" });
		startStatsLoop();
	} catch (error) {
		session.lastError = error?.message || String(error);
		updateTileFooter(session);
		pcManager.scheduleReconnect(reason || "start", {
			tcpOnly: state.tcpOnlyPreferred,
			turnOnly: state.forceTurnOnly,
		});
		throw error;
	}
}

function prepareConnectionContext(session, options, reason) {
	if (!session) {
		throw new Error("no session");
	}

	clearConnectionContext();

	const connectionId = createConnectionId();
	let answerTimer = null;
	let resolveAnswer;
	let rejectAnswer;
	const answerPromise = new Promise((resolve, reject) => {
		resolveAnswer = resolve;
		rejectAnswer = reject;
	});
	answerTimer = setTimeout(() => {
		rejectAnswer(new Error("answer-timeout"));
	}, 15_000);

	const context = {
		session,
		nickname: session.nickname,
		key: session.key,
		connectionId,
		options,
		reason,
		answerPromise,
		resolveAnswer: (sdp) => {
			if (answerTimer) {
				clearTimeout(answerTimer);
				answerTimer = null;
			}
			resolveAnswer(sdp);
		},
		rejectAnswer: (error) => {
			if (answerTimer) {
				clearTimeout(answerTimer);
				answerTimer = null;
			}
			rejectAnswer(error);
		},
	};

	state.connection = context;
	return context;
}

function clearConnectionContext() {
	if (state.connection && typeof state.connection.rejectAnswer === "function") {
		state.connection.rejectAnswer(new Error("context-cleared"));
	}
	state.connection = null;
}

async function sendOffer(offer) {
	if (!state.connection) {
		throw new Error("no connection context");
	}
	if (!state.wsReady) {
		throw new Error("signal-not-ready");
	}

	sendSignal({
		type: "VIEWER_OFFER",
		nickname: state.connection.nickname,
		connectionId: state.connection.connectionId,
		sdp: offer,
		meta: { reason: state.connection.reason },
	});
	log("signal", "offer", {
		nickname: state.connection.nickname,
		connectionId: state.connection.connectionId,
	});
	return state.connection.answerPromise;
}

function sendLocalCandidate(candidate) {
	if (!candidate || !state.connection) {
		return;
	}
	sendSignal({
		type: "VIEWER_ICE",
		nickname: state.connection.nickname,
		connectionId: state.connection.connectionId,
		candidate,
	});
}

function sendStop(context, reason) {
	if (!context || !context.nickname || !context.connectionId) {
		return;
	}
	sendSignal({
		type: "VIEWER_STOP",
		nickname: context.nickname,
		connectionId: context.connectionId,
		reason,
	});
}

function handlePublisherAnswer(payload) {
	if (!state.connection) {
		return;
	}
	const nickname = normalizeNickname(payload?.nickname);
	const key = normalizeKey(nickname);
	if (!key || key !== state.connection.key || payload?.connectionId !== state.connection.connectionId) {
		return;
	}
	const sdp = payload.sdp;
	state.connection.resolveAnswer(typeof sdp === "string" ? { type: "answer", sdp } : sdp);
}

function handlePublisherCandidate(payload) {
	if (!state.connection || !pcManager.pc) {
		return;
	}
	const nickname = normalizeNickname(payload?.nickname);
	const key = normalizeKey(nickname);
	if (!key || key !== state.connection.key || payload?.connectionId !== state.connection.connectionId) {
		return;
	}

	if (!payload.candidate) {
		pcManager.pc.addIceCandidate(null).catch(() => {});
		return;
	}

	const parsed = parseCandidate(payload.candidate.candidate || "");
	const forcingRelay = state.forceTurnOnly;
	if (parsed?.type && parsed.type !== "relay") {
		console.warn("[leak] non-relay candidate seen", { role: "remote", type: parsed.type, candidate: payload.candidate.candidate });
		if (forcingRelay) {
			log("signal", "candidate_remote_dropped", { type: parsed.type });
			return;
		}
	}

	pcManager.pc.addIceCandidate(payload.candidate).catch((error) => {
		logDebug("Remote candidate failed", error?.message || String(error));
	});
}

function handleStreamUnavailable(payload) {
	if (!state.connection) {
		return;
	}
	const nickname = normalizeNickname(payload?.nickname);
	const key = normalizeKey(nickname);
	if (!key || key !== state.connection.key) {
		return;
	}
	pcManager.scheduleReconnect("stream", {
		tcpOnly: state.tcpOnlyPreferred,
		turnOnly: state.forceTurnOnly,
	});
}

function setSessionMuted(session, muted) {
	session.audioMuted = Boolean(muted);
	applyMuteStateToStream(session);
}

function setSessionPaused(session, paused) {
	session.videoPaused = Boolean(paused);
	applyPauseStateToStream(session);
}

function applyMuteStateToStream(session) {
	if (!session.stream) {
		return;
	}
	session.stream.getAudioTracks().forEach((track) => {
		track.enabled = !session.audioMuted;
	});
	if (session.dom?.video) {
		session.dom.video.muted = true;
		if (!session.audioMuted) {
			session.dom.video.muted = false;
		}
		session.dom.video.play().catch(() => {});
	}
	if (session.dom?.muteBtn) {
		session.dom.muteBtn.textContent = session.audioMuted ? "Unmute" : "Mute";
	}
}

function applyPauseStateToStream(session) {
	if (!session.stream) {
		return;
	}
	session.stream.getVideoTracks().forEach((track) => {
		track.enabled = !session.videoPaused;
	});
	if (session.dom?.pauseBtn) {
		session.dom.pauseBtn.textContent = session.videoPaused ? "Resume" : "Pause";
	}
}

async function applyMaxBitrate(session) {
	if (!pcManager.pc) {
		return;
	}
	const encKbps = session.maxBitrate;
	const senders = pcManager.pc.getSenders();
	await Promise.allSettled(
		senders.map(async (sender) => {
			if (!sender.track || sender.track.kind !== "video") {
				return;
			}
			const params = sender.getParameters();
			if (!params.encodings || !params.encodings.length) {
				params.encodings = [{}];
			}
			params.encodings[0].maxBitrate = encKbps ? encKbps * 1_000 : undefined;
			await sender.setParameters(params);
		})
	);
}

function clearSessionMedia(session) {
	if (session.stream) {
		session.stream.getTracks().forEach((track) => {
			try {
				track.stop();
			} catch (error) {
				// ignore
			}
		});
		session.stream = null;
	}
	if (session.dom?.video) {
		session.dom.video.srcObject = null;
	}
	if (session.dom?.statBitrate) {
		session.dom.statBitrate.textContent = "--";
	}
	if (session.dom?.statFps) {
		session.dom.statFps.textContent = "--";
	}
	if (session.dom?.statRtt) {
		session.dom.statRtt.textContent = "--";
	}
	if (session.dom?.statLoss) {
		session.dom.statLoss.textContent = "--";
	}
	if (session.dom?.statState) {
		session.dom.statState.textContent = "--";
	}
	session.stats = null;
	session.lastStatsSample = null;
	setSessionCandidateSummary(session, "Candidate: --");
}

function setSessionStatus(session, label, badgeClass) {
	if (!session.dom?.status) {
		return;
	}
	session.dom.status.textContent = label;
	session.dom.status.className = badgeClass ? `tile-status ${badgeClass}` : "tile-status";
}

function setSessionCandidateSummary(session, text, badgeClass = "") {
	if (!session.dom?.candidate) {
		return;
	}
	session.dom.candidate.textContent = text;
	session.dom.candidate.className = badgeClass;
	if (session.dom.iceState) {
		session.dom.iceState.textContent = `State: ${session.lastIceState}`;
	}
}

function updateTileFooter(session) {
	if (!session.dom) {
		return;
	}
	session.dom.footerState.textContent = `ICE: ${session.lastIceState}`;
	session.dom.footerError.textContent = session.lastError ? `Last error: ${session.lastError}` : "";
	session.dom.footerError.className = session.lastError ? "error" : "";
	if (state.debugEnabled) {
		updateDebugPanel();
	}
}

function updateTileMeta(session) {
	if (!session.dom?.meta) {
		return;
	}
	const meta = state.roster.get(session.key);
	if (!meta) {
		session.dom.meta.textContent = "Team ?, Slot ?";
		return;
	}
	const team = meta.team ? meta.team.toUpperCase() : "?";
	const slot = meta.slot !== undefined && meta.slot !== null && meta.slot !== "" ? meta.slot : "?";
	session.dom.meta.textContent = `${team} • Slot ${slot}`;
}

function removeSession(session) {
	if (!session) {
		return;
	}
	if (state.currentKey === session.key) {
		pcManager.destroy("session-removed").catch(() => {});
		state.currentKey = null;
		state.currentSession = null;
	}
	clearSessionMedia(session);
	session.dom?.root.remove();
	state.sessions.delete(session.key);
	updateSummary();
	updateEmptyState();
}

function startStatsLoop() {
	stopStatsLoop();
	state.statsTimer = setInterval(() => {
		collectStats().catch(() => {});
	}, STATS_INTERVAL_MS);
	collectStats().catch(() => {});
}

function stopStatsLoop() {
	if (state.statsTimer) {
		clearInterval(state.statsTimer);
		state.statsTimer = null;
	}
}

async function collectStats() {
	if (!pcManager.pc || !state.currentSession) {
		return;
	}
	try {
		const report = await pcManager.pc.getStats();
		const stats = analyzeStats(state.currentSession, report);
		state.currentSession.stats = stats;
		if (state.currentSession.dom) {
			state.currentSession.dom.statBitrate.textContent = `${stats.bitrateKbps} kbps`;
			state.currentSession.dom.statFps.textContent = `${stats.fps}`;
			state.currentSession.dom.statRtt.textContent = `${stats.rttMs} ms`;
			state.currentSession.dom.statLoss.textContent = `${stats.packetLoss}%`;
			state.currentSession.dom.statState.textContent = stats.iceState;
		}
		if (stats.candidateType) {
			const badge = stats.candidateType === "relay" ? "badge-ok" : "badge-warn";
			let candidateText = `Candidate: ${stats.candidateType}`;
			if (stats.availableOutgoingBitrateKbps > 0) {
				candidateText += ` • Out: ${stats.availableOutgoingBitrateKbps} kbps`;
			}
			setSessionCandidateSummary(state.currentSession, candidateText, badge);
			if (stats.candidateType !== "relay" && state.lastCandidateWarningType !== stats.candidateType) {
				console.warn("[leak] non-relay candidate seen", { role: "selected", type: stats.candidateType });
				state.lastCandidateWarningType = stats.candidateType;
			}
			if (stats.candidateType === "relay") {
				state.lastCandidateWarningType = null;
			}
		}
		diagState.bitrateKbps = stats.bitrateKbps;
		diagState.rttMs = stats.rttMs;
		diagState.relayIp = stats.relayAddress || null;
		diagState.candidateType = stats.candidateType !== undefined ? stats.candidateType : diagState.candidateType;
		diagState.selectedPair = stats.selectedPair ? { ...stats.selectedPair, availableOutgoingBitrateKbps: stats.availableOutgoingBitrateKbps } : null;
		diagState.outgoingBitrateKbps = stats.availableOutgoingBitrateKbps;
		const zeroFlow = stats.deltaPairBytes === 0 && stats.deltaBytes === 0;
		if (zeroFlow) {
			const now = Date.now();
			if (state.checkingSince && now - state.checkingSince > ZERO_DATA_THRESHOLD_MS && !state.zeroTrafficRestarted) {
				if (typeof pcManager.pc.restartIce === "function") {
					try {
						pcManager.pc.restartIce();
						console.log("[pc] restartIce triggered after zero flow");
						log("pc", "restart-zero-flow", {});
						state.zeroTrafficRestarted = true;
					} catch (error) {
						log("pc", "restart-error", { message: error?.message || String(error) });
					}
				}
				state.zeroTrafficSince = now;
			} else {
				if (!state.zeroTrafficSince) {
					state.zeroTrafficSince = now;
				} else if (now - state.zeroTrafficSince > ZERO_DATA_THRESHOLD_MS) {
					pcManager
						.rebuildNow("zero-traffic", { tcpOnly: state.tcpOnlyPreferred, turnOnly: state.forceTurnOnly })
						.catch(() => {});
					state.zeroTrafficSince = now;
				}
			}
		} else {
			state.zeroTrafficSince = null;
			if (stats.deltaPairBytes > 0 || stats.deltaBytes > 0) {
				state.zeroTrafficRestarted = false;
			}
		}
		updateSummary();
	} catch (error) {
		logDebug("Stats loop failed", error?.message || String(error));
	}
}

function analyzeStats(session, report) {
	const result = {
		bitrateKbps: 0,
		fps: 0,
		rttMs: 0,
		packetLoss: 0,
		iceState: pcManager.pc?.iceConnectionState || "new",
		candidateType: session.stats?.candidateType || "--",
		deltaBytes: 0,
		totalBytes: 0,
		relayAddress: null,
		selectedPair: null,
		deltaPairBytes: 0,
		totalPairBytes: 0,
		availableOutgoingBitrateKbps: 0,
	};

	let inbound = null;
	let videoTrack = null;
	const candidatePairs = new Map();
	const remoteCandidates = new Map();
	const localCandidates = new Map();
	let transport = null;
	const prevSample = session.lastStatsSample || null;

	report.forEach((entry) => {
		if (!entry) {
			return;
		}
		switch (entry.type) {
			case "inbound-rtp":
				if (!inbound && entry.kind === "video" && !entry.isRemote) {
					inbound = entry;
				}
				break;
			case "track":
				if (!videoTrack && entry.kind === "video") {
					videoTrack = entry;
				}
				break;
			case "candidate-pair":
				candidatePairs.set(entry.id, entry);
				break;
			case "local-candidate":
				localCandidates.set(entry.id, entry);
				break;
			case "remote-candidate":
				remoteCandidates.set(entry.id, entry);
				break;
			case "transport":
				transport = entry;
				break;
			default:
				break;
		}
	});

	if (transport && transport.selectedCandidatePairId) {
		const pair = candidatePairs.get(transport.selectedCandidatePairId);
		if (pair) {
			const remote = remoteCandidates.get(pair.remoteCandidateId);
			const local = localCandidates.get(pair.localCandidateId);
			if (remote?.candidateType) {
				result.candidateType = remote.candidateType;
			}
			if (typeof pair.currentRoundTripTime === "number") {
				result.rttMs = Math.round(pair.currentRoundTripTime * 1_000);
			}
			const remoteIp = remote?.ip || remote?.address || remote?.ipAddress || "";
			const remotePort = remote?.port || remote?.portNumber || "";
			if (remoteIp) {
				result.relayAddress = remotePort ? `${remoteIp}:${remotePort}` : remoteIp;
			}
			const bytesSent = typeof pair.bytesSent === "number" ? pair.bytesSent : 0;
			const bytesReceived = typeof pair.bytesReceived === "number" ? pair.bytesReceived : 0;
			result.totalPairBytes = bytesSent + bytesReceived;
			if (typeof pair.availableOutgoingBitrate === "number") {
				result.availableOutgoingBitrateKbps = Math.max(0, Math.round(pair.availableOutgoingBitrate / 1_000));
			} else if (typeof transport.availableOutgoingBitrate === "number") {
				result.availableOutgoingBitrateKbps = Math.max(0, Math.round(transport.availableOutgoingBitrate / 1_000));
			}
			result.selectedPair = {
				id: pair.id || null,
				state: pair.state || null,
				nominated: Boolean(pair.nominated),
				localCandidateType: local?.candidateType || null,
				localProtocol: local?.protocol || null,
				remoteCandidateType: remote?.candidateType || null,
				remoteProtocol: remote?.protocol || remote?.relayProtocol || null,
				remoteAddress: result.relayAddress,
			};
			if (pair?.id && pair.id !== pcManager.lastSelectedPairId) {
				pcManager.lastSelectedPairId = pair.id;
				const selectLog = {
					id: pair.id,
					localFoundation: local?.foundation || null,
					remoteFoundation: remote?.foundation || null,
					protocol: local?.protocol || remote?.protocol || null,
					localType: local?.candidateType || null,
					remoteType: remote?.candidateType || null,
					transport: local?.protocol || remote?.protocol || null,
					nominated: Boolean(pair.nominated),
				};
				console.log("[select] candidate-pair", selectLog);
				log("select", "pair", selectLog);
			}
		}
	}
	const prevPairBytes = prevSample?.pairBytes ?? null;
	if (prevPairBytes !== null && result.totalPairBytes >= prevPairBytes) {
		result.deltaPairBytes = result.totalPairBytes - prevPairBytes;
	} else if (prevPairBytes === null) {
		result.deltaPairBytes = result.totalPairBytes;
	}

	if (inbound) {
		const timestamp = inbound.timestamp || 0;
		const bytes = inbound.bytesReceived || 0;
		const packets = inbound.packetsReceived || 0;
		const lost = inbound.packetsLost || 0;
		result.totalBytes = bytes;
		const prev = prevSample;
		let deltaBytes = 0;
		if (prev && timestamp > prev.timestamp && bytes >= prev.bytes) {
			deltaBytes = bytes - prev.bytes;
			const deltaTime = timestamp - prev.timestamp;
			if (deltaTime > 0) {
				result.bitrateKbps = Math.max(0, Math.round((deltaBytes * 8) / deltaTime));
			}
			const packetDelta = packets + lost - prev.packetsTotal;
			const lostDelta = lost - prev.packetsLost;
			if (packetDelta > 0 && lostDelta >= 0) {
				result.packetLoss = Math.min(100, Math.round((lostDelta / packetDelta) * 100));
			}
		} else if (!prev) {
			deltaBytes = bytes;
		}
		result.deltaBytes = Math.max(0, deltaBytes);
		session.lastStatsSample = {
			timestamp,
			bytes,
			packetsTotal: packets + lost,
			packetsLost: lost,
			pairBytes: result.totalPairBytes,
		};
	} else {
		session.lastStatsSample = {
			...(prevSample || {}),
			pairBytes: result.totalPairBytes,
		};
	}

	if (videoTrack && typeof videoTrack.framesPerSecond === "number") {
		result.fps = Math.round(videoTrack.framesPerSecond);
	}

	return result;
}

function updateSummary() {
	const session = state.currentSession;
	const relayActive = session && session.stats?.candidateType === "relay";
	if (dom.summaryCards.active) {
		dom.summaryCards.active.textContent = relayActive ? "1" : "0";
	}
	if (dom.summaryCards.bitrate) {
		dom.summaryCards.bitrate.textContent = session?.stats ? `${session.stats.bitrateKbps} kbps` : "0 kbps";
	}
	if (dom.summaryCards.rtt) {
		dom.summaryCards.rtt.textContent = session?.stats ? `${session.stats.rttMs} ms` : "0 ms";
	}
	if (dom.summaryCards.refreshed) {
		dom.summaryCards.refreshed.textContent = state.lastConfigRefresh
			? new Date(state.lastConfigRefresh).toLocaleTimeString()
			: "--";
	}
}

function updateTokenIndicator(message, severity) {
	if (!dom.tokenIndicator) {
		return;
	}
	dom.tokenIndicator.classList.remove("warn", "danger");
	if (message) {
		dom.tokenIndicator.textContent = message;
		if (severity) {
			dom.tokenIndicator.classList.add(severity);
		}
		return;
	}
	if (!state.lastConfigRefresh) {
		dom.tokenIndicator.textContent = "Waiting for TURN config…";
		return;
	}
	const ageMs = Date.now() - state.lastConfigRefresh;
	const ageMinutes = Math.floor(ageMs / 60_000);
	const ttlMs = (state.configTtlSec || 0) * 1_000;
	let status = `Token age ${ageMinutes}m`;
	if (ttlMs) {
		const remaining = Math.max(0, ttlMs - ageMs);
		const remainingMin = Math.floor(remaining / 60_000);
		status += ` • ${remainingMin}m left`;
		const ratio = ttlMs ? ageMs / ttlMs : 0;
		if (ratio > 0.85) {
			dom.tokenIndicator.classList.add("danger");
		} else if (ratio > 0.7) {
			dom.tokenIndicator.classList.add("warn");
		}
	}
	dom.tokenIndicator.textContent = status;
}

async function fetchIceConfig({ turnOnly, tcpOnly }) {
	const url = `/api/ice?turnOnly=${turnOnly ? 1 : 0}&tcpOnly=${tcpOnly ? 1 : 0}`;
	const response = await fetch(url, { cache: "no-store" });
	if (!response.ok) {
		throw new Error(`ICE config HTTP ${response.status}`);
	}
	const json = await response.json();
	let iceServers = Array.isArray(json?.iceServers) ? json.iceServers : [];
	if (tcpOnly) {
		iceServers = iceServers
			.map((entry) => {
				if (!entry) {
					return null;
				}
				const urls = Array.isArray(entry.urls) ? entry.urls : entry.urls ? [entry.urls] : [];
				const filtered = urls.filter((url) => typeof url === "string" && /turns:/i.test(url) && /transport=tcp/i.test(url));
				if (!filtered.length) {
					return null;
				}
				return { ...entry, urls: filtered.length === 1 ? filtered[0] : filtered };
			})
			.filter(Boolean);
	}
	const serverUrls = iceServers.map((entry) => {
		const urls = Array.isArray(entry?.urls) ? entry.urls : entry?.urls ? [entry.urls] : [];
		return urls;
	});
	console.log("[ice] config_fetched", {
		ttlSec: json?.ttlSec || null,
		tcpOnly: Boolean(tcpOnly),
		turnOnly: Boolean(turnOnly),
		count: iceServers.length,
		servers: serverUrls,
	});
	log("ice", "config_fetched", {
		ttlSec: json?.ttlSec || null,
		tcpOnly: Boolean(tcpOnly),
		turnOnly: Boolean(turnOnly),
		count: iceServers.length,
	});
	state.lastConfigRefresh = Date.now();
	state.configTtlSec = json?.ttlSec || null;
	updateTokenIndicator();
	return { iceServers, ttlSec: json?.ttlSec || null };
}

async function fetchJson(url, options = {}) {
	const controller = new AbortController();
	const timeout = options.timeoutMs || 0;
	const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null;
	const targetUrl = typeof url === "string" && !/^https?:/i.test(url) ? `${API_BASE}${url}` : url;
	try {
		const response = await fetch(targetUrl, {
			...options,
			headers: {
				"Content-Type": "application/json",
				...(options.headers || {}),
			},
			credentials: "include",
			cache: "no-store",
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		return response.json();
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

function normalizeNickname(value) {
	if (typeof value !== "string") {
		return "";
	}
	return value.trim();
}

function normalizeKey(value) {
	if (!value) {
		return "";
	}
	return value.replace(/\s+/g, "").toLowerCase();
}

function createConnectionId() {
	return `admin-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

function updateEmptyState() {
	if (!dom.emptyState) {
		return;
	}
	dom.emptyState.style.display = state.sessions.size ? "none" : "block";
}

function logDebug(message, details) {
	const entry = {
		time: new Date().toISOString(),
		message,
		details: details || null,
	};
	state.debugEntries.push(entry);
	if (state.debugEntries.length > MAX_DEBUG_ENTRIES) {
		state.debugEntries.shift();
	}
	if (state.debugEnabled) {
		updateDebugPanel();
	}
}

function toggleDebugPanel() {
	state.debugEnabled = !state.debugEnabled;
	if (dom.debugPanel) {
		dom.debugPanel.style.display = state.debugEnabled ? "grid" : "none";
	}
	if (state.debugEnabled) {
		updateDebugPanel();
	}
}

function updateDebugPanel() {
	if (!dom.debugOutput) {
		return;
	}
	const lines = state.debugEntries.slice(-40).map((entry) => {
		const detail = entry.details ? ` ${JSON.stringify(entry.details)}` : "";
		return `[${entry.time}] ${entry.message}${detail}`;
	});
	dom.debugOutput.textContent = lines.join("\n") || "Debug output will appear here.";
	dom.debugOutput.scrollTop = dom.debugOutput.scrollHeight;
}

function showFatal(message) {
	log("admin", "fatal", { message });
	if (!dom.fatalBanner) {
		const banner = document.createElement("div");
		banner.id = "ice-status";
		banner.className = "token-indicator danger";
		dom.summaryBar?.parentElement?.insertBefore(banner, dom.summaryBar?.nextSibling || null);
		dom.fatalBanner = banner;
	}
	dom.fatalBanner.textContent = message;
	dom.fatalBanner.classList.add("danger");
}

try {
	window.showFatal = showFatal;
} catch (error) {
	// ignore window assignment failures
}

function registerAutoCleanup(manager) {
	if (manager.autoCleanupRegistered) {
		return;
	}
	manager.autoCleanupRegistered = true;
	window.addEventListener("beforeunload", () => {
		manager.destroy("unload").catch(() => {});
	});
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) {
			manager.destroy("hidden").catch(() => {});
		}
	});
}
