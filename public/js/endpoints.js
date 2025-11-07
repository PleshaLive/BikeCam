export const API_BASE = window.location.origin.replace(/\/$/, "");
export const WS_BASE = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
export const LOGO_DB_PROXY = API_BASE + "/assets/team-logos.json";
