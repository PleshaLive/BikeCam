import { ENV } from '/shared/env.js';

const listeners = new Set();
let map = {};  // { [id]: true|false }
let ws;

export async function loadVisibility(){
  try{
    const r = await fetch(`${ENV.API_BASE}/api/visibility`);
    if(r.ok){ map = (await r.json()).map || {}; notify(); }
  }catch(_){ }
  try{
    ws = new WebSocket(`${ENV.WS_BASE}/ws`);
    ws.onmessage = (ev)=>{
      const m = JSON.parse(ev.data);
      if(m.type==='visibility.update'){ map[m.id] = m.visible; notify(); }
    };
  }catch(_){ }
}

export function getVisible(id){ return map[id] !== false; }

export async function setVisible(id, visible){
  map[id] = !!visible; notify();
  try{
    await fetch(`${ENV.API_BASE}/api/visibility`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ id, visible })
    });
    ws?.readyState===1 && ws.send(JSON.stringify({ type:'visibility.set', id, visible }));
  }catch(_){ }
}

export function subscribe(fn){ listeners.add(fn); return ()=>listeners.delete(fn); }
function notify(){ listeners.forEach(fn=>fn(map)); }
