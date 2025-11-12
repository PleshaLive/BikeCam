import { ENV } from '/shared/env.js';

let current = null; // { iceServers, expAt, ageStart, ttlSec }
let key = '';

export function setAdminKey(k){ key = k || ''; }
export function getAdminKey(){ return key; }
export function getTurnState(){ return current; }
export function clearTurnState(){ current = null; }

export async function fetchTurnCreds() {
  if(!key) throw new Error('No admin key');
  const u = `${ENV.API_BASE}/api/webrtc/turn-creds?key=${encodeURIComponent(key)}`;
  const r = await fetch(u);
  if(!r.ok) throw new Error(`TURN creds HTTP ${r.status}`);
  const j = await r.json();
  const now = Date.now();
  current = {
    iceServers: Array.isArray(j.iceServers) && j.iceServers.length
      ? j.iceServers
      : [{ urls: j.urls, username: j.username, credential: j.credential }],
    expAt: now + (j.ttlSec * 1000),
    ageStart: now,
    ttlSec: j.ttlSec,
  };
  return current;
}
