import { API_BASE, LOGO_DB_PROXY } from "./js/endpoints.js";
import { getConfig, hasWebRTCSupport, createMjpegUrl } from "./js/webrtc-support.js";

const TEAMS_ENDPOINT = `${API_BASE}/teams`;
const LOGO_JSON = LOGO_DB_PROXY;

async function loadJson(url) {
	const response = await fetch(url, { cache: "no-store" });
	if (!response.ok) {
		throw new Error(`Fetch failed: ${url} -> ${response.status}`);
	}
	return response.json();
}

const normalizeKeyValue = (value) => {
	if (value === undefined || value === null) {
		return "";
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed.toLowerCase() : "";
	}
	return normalizeKeyValue(value.toString());
};

const collectTeamKeys = (team) => {
	const keys = [];
	if (typeof team === "string") {
		const key = normalizeKeyValue(team);
		if (key) {
			keys.push(key);
		}
		return keys;
	}
	if (!team || typeof team !== "object") {
		return keys;
	}

	[
		team.id,
		team.team,
		team.code,
		team.slug,
		team.tag,
		team.name,
		team.teamName,
	].forEach((candidate) => {
		const key = normalizeKeyValue(candidate);
		if (key) {
			keys.push(key);
		}
	});

	return keys;
};

const normKey = (team) => {
	const keys = collectTeamKeys(team);
	return keys.length ? keys[0] : "";
};

export async function loadTeamsWithLogos() {
	const [live, logos] = await Promise.all([
		loadJson(TEAMS_ENDPOINT),
		loadJson(LOGO_JSON),
	]);

	const logoMap = new Map();
	(logos?.teams ?? []).forEach((entry) => {
		collectTeamKeys(entry).forEach((key) => {
			if (!logoMap.has(key)) {
				logoMap.set(key, entry);
			}
		});
	});

	const mergedTeams = (live?.teams ?? []).map((team) => {
		let match = null;
		for (const key of collectTeamKeys(team)) {
			if (logoMap.has(key)) {
				match = logoMap.get(key);
				break;
			}
		}

		const matchName = typeof match?.teamName === "string" ? match.teamName.trim() : "";
		const matchLogo = typeof match?.logo === "string" ? match.logo.trim() : "";
		const altLogo = typeof match?.altLogo === "string" ? match.altLogo.trim() : "";
		const mapLogo = typeof match?.mapLogo === "string" ? match.mapLogo.trim() : "";
		const colors = match?.colors ?? team.colors ?? null;

		return {
			...team,
			name: matchName || team.name,
			logo: matchLogo || match?.badge || match?.image || team.logo || null,
			altLogo: altLogo || team.altLogo || null,
			mapLogo: mapLogo || team.mapLogo || null,
			colors,
		};
	});

	return { teams: mergedTeams };
}

(async () => {
	const TEAM_TITLES = {
		CT: "CT Squad",
		T: "T Squad",
	};

	const rawTeamKey = (
		window.TEAM_KEY ||
		document.body.dataset.team ||
		new URLSearchParams(window.location.search).get("team") ||
		""
	).toUpperCase();

	const teamKey = rawTeamKey;
		const friendlyTitle = window.TEAM_TITLE || TEAM_TITLES[teamKey] || (teamKey ? `Team ${teamKey}` : "Squad");
		let activeTeamTitle = friendlyTitle;
		let activeTeamLogo = "";

	const titleElement = document.getElementById("teamLabel");
	const logoElement = document.getElementById("teamLogo");
	const gridElement = document.getElementById("cameraGrid");
	const statusElement = document.getElementById("teamStatus");

	if (titleElement) {
			titleElement.textContent = friendlyTitle;
	}
	if (logoElement && !logoElement.getAttribute("src")) {
		logoElement.style.display = "none";
	}
	function applyTeamTitle(nextTitle) {
		if (!titleElement) {
			return;
		}

		const normalized = normalizeNickname(nextTitle);
		const finalTitle = normalized || friendlyTitle;
		if (finalTitle === activeTeamTitle) {
			return;
		}

		activeTeamTitle = finalTitle;
		titleElement.textContent = activeTeamTitle;
		if (logoElement && activeTeamLogo) {
			logoElement.alt = activeTeamTitle;
		}
	}

	function applyTeamLogo(nextLogo) {
		if (!logoElement) {
			return;
		}

		const normalized = typeof nextLogo === "string" ? nextLogo.trim() : "";
		if (!normalized) {
			activeTeamLogo = "";
			logoElement.removeAttribute("src");
			logoElement.style.display = "none";
			logoElement.alt = "";
			return;
		}

		activeTeamLogo = normalized;
		logoElement.src = normalized;
		logoElement.alt = activeTeamTitle;
		logoElement.style.display = "block";
	}


	if (!teamKey) {
		if (statusElement) {
			statusElement.textContent = "Team is not set. Provide ?team=CT or define TEAM_KEY.";
		}
		return;
	}

	if (!gridElement) {
		if (statusElement) {
			statusElement.textContent = "Camera grid element not found.";
		}
		return;
	}

	const wsUrl = window.WS_BASE;
		let resolvedConfig = await getConfig();
		if (!resolvedConfig || typeof resolvedConfig !== "object") {
			resolvedConfig = { iceServers: [], fallback: {} };
		}
		console.log("[ICE] using TURN", resolvedConfig.iceServers);

		const fallbackSettings = resolvedConfig.fallback && typeof resolvedConfig.fallback === "object" ? resolvedConfig.fallback : {};
		const params = new URLSearchParams(window.location.search || "");
		const FORCE_RELAY = params.get("relay") === "1";
		const preferFallback = params.get("fallback") === "mjpeg";
		const userAgent = (navigator.userAgent || "").toLowerCase();
		const forceFallback = preferFallback || userAgent.includes("obs") || userAgent.includes("vmix");
		const hasWebRTC = forceFallback ? false : hasWebRTCSupport();
		const retryCounts = new Map();
		const fallbackNicknames = new Set();
		const fallbackTimers = new Map();
		const forcedFallbackOverrides = new Set();
	const MAX_PLAYERS = 5;

	let ws = null;
	let wsReady = false;
	let viewerRegistered = false;
	let reconnectTimer = null;
	let connectionCounter = 0;

	const knownPublishers = new Set();
	const sessions = new Map();
		const slots = new Map();

		let currentPlayers = [];

	function normalizeNickname(value) {
		if (typeof value !== "string") {
			return null;
		}
		const trimmed = value.trim();
		return trimmed.length ? trimmed : null;
	}

	function ensureStatus(message = "") {
		if (statusElement) {
			statusElement.textContent = message;
		}
	}

	function createConnectionId() {
		connectionCounter += 1;
		return `team-viewer-${Date.now()}-${connectionCounter}`;
	}

	function showSlotFallback(nickname) {
		if (!fallbackSettings.mjpeg) {
			return;
		}

		const slot = slots.get(nickname);
		if (!slot?.fallbackImg) {
			return;
		}

		const url = createMjpegUrl(nickname);
		slot.fallbackImg.dataset.nickname = nickname;
		slot.fallbackImg.src = url;
		slot.fallbackImg.style.display = "block";
		slot.video.style.display = "none";
		slot.placeholder.style.display = "none";
		slot.card.classList.remove("no-feed");
	}

	function hideSlotFallback(nickname) {
		const slot = slots.get(nickname);
		if (!slot?.fallbackImg) {
			return;
		}

		slot.fallbackImg.style.display = "none";
		slot.fallbackImg.dataset.nickname = "";
		if (slot.fallbackImg.src) {
			slot.fallbackImg.removeAttribute("src");
		}
	}

	function activateFallback(nickname) {
		if (!fallbackSettings.mjpeg || !nickname) {
			return;
		}
		fallbackNicknames.add(nickname);
		scheduleFallback(nickname);
	}

	function scheduleFallback(nickname) {
		if (!fallbackSettings.mjpeg || !nickname) {
			return;
		}

		const slot = slots.get(nickname);
		if (!slot?.fallbackImg) {
			return;
		}

		if (
			slot.fallbackImg.style.display === "block" &&
			slot.fallbackImg.dataset.nickname === nickname
		) {
			return;
		}

		const existingTimer = fallbackTimers.get(nickname);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		const timerId = setTimeout(() => {
			fallbackTimers.delete(nickname);
			if (!fallbackNicknames.has(nickname)) {
				return;
			}
			showSlotFallback(nickname);
		}, 2500);

		fallbackTimers.set(nickname, timerId);
	}

	function cancelFallback(nickname) {
		if (!nickname) {
			return;
		}

		const timerId = fallbackTimers.get(nickname);
		if (timerId) {
			clearTimeout(timerId);
			fallbackTimers.delete(nickname);
		}

		deactivateFallback(nickname);
	}

	function deactivateFallback(nickname) {
		if (!nickname) {
			return;
		}
		fallbackNicknames.delete(nickname);
		const timerId = fallbackTimers.get(nickname);
		if (timerId) {
			clearTimeout(timerId);
			fallbackTimers.delete(nickname);
		}
		hideSlotFallback(nickname);
	}

	function applyForcedFallbackList(list) {
		const updated = new Set();
		if (Array.isArray(list)) {
			for (const value of list) {
				const normalized = normalizeNickname(value);
				if (normalized) {
					updated.add(normalized.toLowerCase());
				}
			}
		}

	let changed = false;
	if (updated.size !== forcedFallbackOverrides.size) {
		changed = true;
	} else {
		for (const name of forcedFallbackOverrides) {
			if (!updated.has(name)) {
				changed = true;
				break;
			}
		}
	}

	if (!changed) {
		return;
	}

	const affected = new Set();
	for (const name of forcedFallbackOverrides) {
		affected.add(name);
	}
	for (const name of updated) {
		affected.add(name);
	}

	forcedFallbackOverrides.clear();
	for (const name of updated) {
		forcedFallbackOverrides.add(name);
	}

	for (const nickname of Array.from(sessions.keys())) {
		const normalized = normalizeNickname(nickname);
		if (!normalized) {
			continue;
		}
		if (affected.has(normalized.toLowerCase())) {
			restartSession(nickname, { failed: true });
		}
	}

	syncSessions();
	}

	function hasForcedFallback(nickname) {
		const normalized = normalizeNickname(nickname);
		if (!normalized) {
			return false;
		}
		return forcedFallbackOverrides.has(normalized.toLowerCase());
	}

	function createPlayerSlot(nickname) {
		const card = document.createElement("div");
		card.className = "slot no-feed";
		card.dataset.nickname = nickname;

		const frameWrapper = document.createElement("div");
		frameWrapper.className = "frame";

		const video = document.createElement("video");
		video.autoplay = true;
		video.playsInline = true;
		video.muted = true;
		video.style.display = "none";

		const fallbackImg = document.createElement("img");
		fallbackImg.className = "fallback";
		fallbackImg.style.display = "none";
		fallbackImg.alt = "Fallback feed";
		fallbackImg.loading = "lazy";
		fallbackImg.decoding = "async";
		fallbackImg.addEventListener("error", () => {
			const targetNickname = fallbackImg.dataset.nickname;
			if (!targetNickname) {
				return;
			}
			setTimeout(() => {
				fallbackImg.src = createMjpegUrl(targetNickname);
			}, 1000);
		});

		const placeholder = document.createElement("div");
		placeholder.className = "placeholder";
		placeholder.textContent = "No live feed";

		const label = document.createElement("div");
		label.className = "nick";
		label.textContent = nickname;

		frameWrapper.appendChild(video);
		frameWrapper.appendChild(fallbackImg);
		frameWrapper.appendChild(placeholder);
		card.appendChild(frameWrapper);
		card.appendChild(label);

		return { card, video, fallbackImg, placeholder, label };
	}

	function createEmptySlot() {
		const card = document.createElement("div");
		card.className = "slot placeholder-only";

		const frameWrapper = document.createElement("div");
		frameWrapper.className = "frame";

		const placeholder = document.createElement("div");
		placeholder.className = "placeholder";
		placeholder.textContent = "Awaiting player";

		const label = document.createElement("div");
		label.className = "nick";
		label.textContent = "—";

		frameWrapper.appendChild(placeholder);
		card.appendChild(frameWrapper);
		card.appendChild(label);

		return card;
	}

	function detachSlot(nickname) {
		const slot = slots.get(nickname);
		if (!slot) {
			return;
		}

		cleanupSession(nickname, { notify: true });

		slots.delete(nickname);
		if (slot.video?.srcObject) {
			try {
				slot.video.srcObject.getTracks().forEach((track) => track.stop());
			} catch (error) {
				// ignore cleanup errors
			}
		}
		slot.card.remove();
	}

		function renderPlayers(players) {
			const roster = Array.isArray(players) ? [...players] : [];
			const prepared = [];
			const seen = new Set();

			roster.sort((a, b) => {
				const slotA = Number.isFinite(Number(a?.observer_slot)) ? Number(a.observer_slot) : 999;
				const slotB = Number.isFinite(Number(b?.observer_slot)) ? Number(b.observer_slot) : 999;
				if (slotA !== slotB) {
					return slotA - slotB;
				}
				const nameA = normalizeNickname(typeof a?.name === "string" ? a.name : a?.id);
				const nameB = normalizeNickname(typeof b?.name === "string" ? b.name : b?.id);
				if (!nameA && !nameB) {
					return 0;
				}
				if (!nameA) {
					return 1;
				}
				if (!nameB) {
					return -1;
				}
				return nameA.localeCompare(nameB);
			});

			for (const entry of roster) {
				const nameValue = typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : (typeof entry?.id === "string" ? entry.id : "");
				const normalized = normalizeNickname(nameValue);
				if (!normalized) {
					continue;
				}
				const dedupeKey = normalized.toLowerCase();
				if (seen.has(dedupeKey)) {
					continue;
				}
				seen.add(dedupeKey);
				prepared.push({ normalized, display: nameValue || normalized });
				if (prepared.length === MAX_PLAYERS) {
					break;
				}
			}

			const newOrderKeys = prepared.map((entry) => entry.normalized);
			currentPlayers = newOrderKeys;

			const fragment = document.createDocumentFragment();
			const newOrder = new Map();

			for (const entry of prepared) {
				let slot = slots.get(entry.normalized);
				if (!slot) {
					slot = createPlayerSlot(entry.display);
					slots.set(entry.normalized, slot);
				}
				slot.label.textContent = entry.display;
				slot.card.dataset.nickname = entry.normalized;
				fragment.appendChild(slot.card);
				newOrder.set(entry.normalized, slot);
			}

			for (let i = prepared.length; i < MAX_PLAYERS; i += 1) {
				fragment.appendChild(createEmptySlot());
			}

			gridElement.innerHTML = "";
			gridElement.appendChild(fragment);

			for (const nickname of Array.from(slots.keys())) {
				if (!newOrder.has(nickname)) {
					detachSlot(nickname);
				}
			}

			syncSessions();
		}

	function setSlotStream(nickname, stream) {
			const slot = slots.get(nickname);
		if (!slot) {
			return;
		}

		if (slot.video.srcObject !== stream) {
			slot.video.srcObject = stream || null;
		}

		if (stream) {
			cancelFallback(nickname);
			slot.card.classList.remove("no-feed");
			slot.placeholder.style.display = "none";
			slot.video.style.display = "block";
			const attemptPlay = slot.video.play?.();
			if (attemptPlay && typeof attemptPlay.catch === "function") {
				attemptPlay.catch(() => {});
			}
		} else {
			slot.video.style.display = "none";
			slot.video.srcObject = null;
			if (fallbackNicknames.has(nickname)) {
				scheduleFallback(nickname);
			} else {
				hideSlotFallback(nickname);
				slot.card.classList.add("no-feed");
				slot.placeholder.style.display = "";
			}
		}
	}

	function cleanupSession(nickname, { notify = true, retainFallback = false } = {}) {
		const session = sessions.get(nickname);
		if (!session) {
			return;
		}

		if (session.connectTimer) {
			clearTimeout(session.connectTimer);
			session.connectTimer = null;
		}

		sessions.delete(nickname);

		if (notify && wsReady) {
			sendSignal({
				type: "VIEWER_STOP",
				nickname,
				connectionId: session.connectionId,
			});
		}

		try {
			session.pc.ontrack = null;
			session.pc.onicecandidate = null;
			session.pc.onconnectionstatechange = null;
			session.pc.close();
		} catch (error) {
			console.warn("Failed to close peer cleanly", error);
		}

		if (session.stream) {
			session.stream.getTracks().forEach((track) => track.stop());
		}

		if (!retainFallback) {
			retryCounts.delete(nickname);
			cancelFallback(nickname);
		} else {
			fallbackNicknames.add(nickname);
		}

		setSlotStream(nickname, null);
	}

	function cleanupAllSessions({ notify = false } = {}) {
		for (const nickname of Array.from(sessions.keys())) {
			cleanupSession(nickname, { notify, retainFallback: false });
		}
	}

	function sendSignal(payload) {
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(payload));
		}
	}

	function restartSession(nickname, { failed = false } = {}) {
		if (!nickname) {
			return;
		}

		if (!knownPublishers.has(nickname) || !currentPlayers.includes(nickname)) {
			cleanupSession(nickname, { notify: true, retainFallback: false });
			retryCounts.delete(nickname);
			cancelFallback(nickname);
			return;
		}

		const retainFallback = failed && fallbackSettings.mjpeg;
		cleanupSession(nickname, { notify: true, retainFallback });

		let attempts = retryCounts.get(nickname) || 0;

		if (failed) {
			attempts += 1;
			retryCounts.set(nickname, attempts);
			if (fallbackSettings.mjpeg) {
				activateFallback(nickname);
			}
		} else {
			attempts = 0;
			retryCounts.set(nickname, 0);
			cancelFallback(nickname);
		}

		if (!viewerRegistered || !wsReady) {
			return;
		}

		if (!hasWebRTC || hasForcedFallback(nickname)) {
			activateFallback(nickname);
			return;
		}

		const retryDelay = failed ? Math.min(2000, 400 + attempts * 400) : 200;

		setTimeout(() => {
			startSession(nickname);
		}, retryDelay);
	}

	async function startSession(nickname) {
		if (!viewerRegistered || !wsReady || !knownPublishers.has(nickname)) {
			return;
		}

		if (!currentPlayers.includes(nickname)) {
			return;
		}

		if (sessions.has(nickname)) {
			return;
		}

			const slot = slots.get(nickname);
		if (!slot) {
			return;
		}

		if (!hasWebRTC || hasForcedFallback(nickname)) {
			activateFallback(nickname);
			return;
		}

		const connectionId = createConnectionId();
		const pc = await (await import("./js/webrtc-support.js")).createPeerConnection(FORCE_RELAY);
		const session = { nickname, connectionId, pc, stream: null, connectTimer: null };
		sessions.set(nickname, session);

		if (fallbackSettings.mjpeg) {
			activateFallback(nickname);
		}

		const attempts = retryCounts.get(nickname) || 0;
		const connectTimeout = Math.min(8000, 4000 + attempts * 500);
		session.connectTimer = setTimeout(() => {
			const current = sessions.get(nickname);
			if (!current || current.connectionId !== connectionId) {
				return;
			}
			restartSession(nickname, { failed: true });
		}, connectTimeout);

		slot.card.classList.add("no-feed");
		slot.placeholder.style.display = "";
		slot.video.style.display = "none";

		pc.ontrack = (event) => {
			const [stream] = event.streams || [];
			if (!stream) {
				return;
			}

			const current = sessions.get(nickname);
			if (!current || current.connectionId !== connectionId) {
				stream.getTracks().forEach((track) => track.stop());
				return;
			}

			if (current.connectTimer) {
				clearTimeout(current.connectTimer);
				current.connectTimer = null;
			}

			retryCounts.set(nickname, 0);
			cancelFallback(nickname);

			current.stream = stream;
			setSlotStream(nickname, stream);
		};

		pc.onicecandidate = (event) => {
			if (!event.candidate) {
				return;
			}
			sendSignal({
				type: "VIEWER_ICE",
				nickname,
				connectionId,
				candidate: event.candidate,
			});
		};

		pc.onconnectionstatechange = () => {
			const current = sessions.get(nickname);
			if (!current || current.connectionId !== connectionId) {
				return;
			}

			if (pc.connectionState === "connected") {
				if (current.connectTimer) {
					clearTimeout(current.connectTimer);
					current.connectTimer = null;
				}
				retryCounts.set(nickname, 0);
				cancelFallback(nickname);
				return;
			}

			if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
				if (current.connectTimer) {
					clearTimeout(current.connectTimer);
					current.connectTimer = null;
				}
				restartSession(nickname, { failed: true });
			} else if (pc.connectionState === "closed") {
				cleanupSession(nickname, { notify: false });
			}
		};

		try {
			const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
			await pc.setLocalDescription(offer);

			sendSignal({
				type: "VIEWER_OFFER",
				nickname,
				connectionId,
				sdp: pc.localDescription,
			});
		} catch (error) {
			if (session.connectTimer) {
				clearTimeout(session.connectTimer);
				session.connectTimer = null;
			}
			console.error("Failed to create offer for", nickname, error);
			restartSession(nickname, { failed: true });
		}
	}

	function syncSessions() {
		if (!viewerRegistered || !wsReady) {
			return;
		}

		for (const nickname of currentPlayers) {
			if (knownPublishers.has(nickname)) {
				startSession(nickname);
			} else {
				cleanupSession(nickname, { notify: true });
			}
		}

		for (const nickname of Array.from(sessions.keys())) {
			if (!currentPlayers.includes(nickname)) {
				cleanupSession(nickname, { notify: true });
			}
		}
	}

	function handlePublisherAnswer(payload) {
		const nickname = normalizeNickname(payload.nickname);
		if (!nickname) {
			return;
		}

		const session = sessions.get(nickname);
		if (!session || session.connectionId !== payload.connectionId) {
			return;
		}

		session.pc.setRemoteDescription(payload.sdp).catch((error) => {
			console.error("Failed to apply answer", nickname, error);
			restartSession(nickname, { failed: true });
		});
	}

	async function handlePublisherCandidate(payload) {
		const nickname = normalizeNickname(payload.nickname);
		if (!nickname) {
			return;
		}

		const session = sessions.get(nickname);
		if (!session || session.connectionId !== payload.connectionId) {
			return;
		}

		try {
			await session.pc.addIceCandidate(payload.candidate || null);
		} catch (error) {
			console.error("ICE candidate error", nickname, error);
		}
	}

	function handleStreamUnavailable(payload) {
		const nickname = normalizeNickname(payload.nickname);
		if (!nickname) {
			return;
		}

		const session = sessions.get(nickname);
		if (!session || session.connectionId !== payload.connectionId) {
			return;
		}

		restartSession(nickname, { failed: true });
	}

	function handleActivePublishers(list) {
		knownPublishers.clear();
		if (Array.isArray(list)) {
			for (const name of list) {
				const normalized = normalizeNickname(name);
				if (normalized) {
					knownPublishers.add(normalized);
				}
			}
		}

		syncSessions();
	}

	function handleMessage(event) {
		let payload;

		try {
			payload = JSON.parse(event.data);
		} catch (error) {
			return;
		}

		switch (payload.type) {
			case "WELCOME":
				handleActivePublishers(payload.publishers);
				applyForcedFallbackList(payload.forcedFallback);
				viewerRegistered = false;
				sendSignal({ type: "HELLO", role: "viewer" });
				break;
			case "VIEWER_REGISTERED":
				viewerRegistered = true;
				syncSessions();
				break;
			case "ACTIVE_PUBLISHERS":
				handleActivePublishers(payload.publishers);
				break;
			case "FORCED_FALLBACK":
				applyForcedFallbackList(payload.nicknames);
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

	function connectWebSocket() {
		if (ws) {
			try {
				ws.close();
			} catch (error) {
				// ignore
			}
		}

		ws = new WebSocket(wsUrl);

		ws.addEventListener("open", () => {
			wsReady = true;
			viewerRegistered = false;
			console.log("[WS] connected to", window.WS_BASE);
			console.log("[API] target", window.API_BASE);
			ensureStatus("");
			sendSignal({ type: "HELLO", role: "viewer" });
		});

		ws.addEventListener("message", handleMessage);

		ws.addEventListener("close", () => {
			wsReady = false;
			viewerRegistered = false;
			knownPublishers.clear();
			cleanupAllSessions({ notify: false });
			ensureStatus("WebSocket disconnected. Reconnecting...");

			if (reconnectTimer) {
				return;
			}
			reconnectTimer = setTimeout(() => {
				reconnectTimer = null;
				connectWebSocket();
			}, 2000);
		});

		ws.addEventListener("error", () => {
			ws.close();
		});
	}

	async function fetchTeams() {
		try {
			const { teams } = await loadTeamsWithLogos();
			const rosterList = Array.isArray(teams) ? teams : [];
			const target = rosterList.find((entry) => {
				const key = (entry?.id ?? entry?.name ?? "").toString().trim().toUpperCase();
				return key === teamKey;
			});

			const players = Array.isArray(target?.players) ? target.players : [];
			if (typeof target?.name === "string" && target.name.trim()) {
				applyTeamTitle(target.name.trim());
			}

			const logoUrl = typeof target?.logo === "string" && target.logo.trim() ? target.logo.trim() :
				typeof target?.altLogo === "string" && target.altLogo.trim() ? target.altLogo.trim() : "";
			applyTeamLogo(logoUrl);

			renderPlayers(players);
			ensureStatus(players.length ? "" : "Team roster is not available yet.");
		} catch (error) {
			console.error("Failed to load teams with logos", error);
			ensureStatus("Failed to fetch team roster.");
			applyTeamLogo("");
		}
	}

	connectWebSocket();
	fetchTeams();
	setInterval(fetchTeams, 5000);

	window.addEventListener("beforeunload", () => {
		cleanupAllSessions({ notify: true });
	});
})();
