import { ENV } from '/shared/env.js';

let current = null; // { iceServers, expAt, ageStart }
let key = '';

export function setAdminKey(k){ key = k; }
export function getTurnState(){ return current; }

export async function fetchTurnCreds() {
  if(!key) throw new Error('No admin key');
  const u = `${ENV.API_BASE}/api/webrtc/turn-creds?key=${encodeURIComponent(key)}`;
  const r = await fetch(u);
  if(!r.ok) throw new Error(`TURN creds HTTP ${r.status}`);
  const j = await r.json();
  current = {
    iceServers: [{ urls: j.urls, username: j.username, credential: j.credential }],
    expAt: Date.now() + (j.ttlSec*1000),
    ageStart: Date.now(),
  };
  scheduleRefresh(j.ttlSec);
  return current;
}

let refreshT = null;
function scheduleRefresh(ttlSec){
  if(refreshT) clearTimeout(refreshT);
  const refreshInMs = Math.max(30_000, (ttlSec-300)*1000); // за 5 минут до истечения
  refreshT = setTimeout(fetchTurnCreds, refreshInMs);
}
