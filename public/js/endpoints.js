const LIVE_ORIGIN = "https://bikecam.onrender.com";

function resolveApiBase() {
	if (typeof window !== "undefined") {
		const overrides = window.__API_BASE__;
		if (typeof overrides === "string" && overrides.trim()) {
			return overrides.trim().replace(/\/$/, "");
		}

		const runtimeOrigin = window.location?.origin?.replace(/\/$/, "") || "";
		if (!runtimeOrigin || /localhost|127\.0\.0\.1/i.test(runtimeOrigin)) {
			return LIVE_ORIGIN;
		}
		return runtimeOrigin;
	}
	return LIVE_ORIGIN;
}

export const API_BASE = resolveApiBase();
export const WS_BASE = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
export const LOGO_DB_PROXY = API_BASE + "/assets/team-logos.json";
export const DEBUG_WEBRTC = false;
