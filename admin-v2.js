import { ENV } from '/shared/env.js';
import { setAdminKey, fetchTurnCreds, getTurnState } from '/webrtc/turn.js';
import { createReceiverPC } from '/webrtc/pc-factory.js';
import { loadVisibility, getVisible, setVisible } from '/state/visibility-store.js';
import { attachStatsPanel } from '/diag/stats-panel.js';

const dom = {
  tiles: document.getElementById('tiles'),
  empty: document.getElementById('emptyHint'),
  kRelays: document.getElementById('kpiRelays'),
  kBitrate: document.getElementById('kpiBitrate'),
  kRtt: document.getElementById('kpiRtt'),
  kRef: document.getElementById('kpiRefresh'),
  tokenAge: document.getElementById('tokenAge'),
  applyKey: document.getElementById('applyTurnKeyBtn'),
  keyInput: document.getElementById('turnKeyInput'),
  refreshTurn: document.getElementById('refreshTurnBtn'),
  forceTurn: document.getElementById('forceTurnOnly'),
  maxBr: document.getElementById('globalMaxBr'),
  reconnectAll: document.getElementById('reconnectAll'),
  freezeAll: document.getElementById('freezeAll'),
  resumeAll: document.getElementById('resumeAll'),
  debugBtn: document.getElementById('toggleDebug'),
  refreshRoster: document.getElementById('refreshRoster'),
};

let DEBUG = false;
let roster = []; // [{id, name, slot}]
const tiles = new Map(); // id -> { pc, video, el, statsDetach }
let relayCount = 0;

dom.applyKey.onclick = async ()=>{
  setAdminKey(dom.keyInput.value.trim());
  await ensureTurn();
  await boot();
};
dom.refreshTurn.onclick = async ()=>{
  await ensureTurn(true);
  // мягкий ре-ICE со свежими серверами
  tiles.forEach(({pc})=>{
    pc.setConfiguration({ iceServers: getTurnState().iceServers, ...(dom.forceTurn.checked?{iceTransportPolicy:'relay'}:{}) });
    pc.restartIce();
  });
};
dom.forceTurn.onchange = ()=>{
  tiles.forEach(({pc})=> pc.__applyTurnOnly(dom.forceTurn.checked));
};
dom.maxBr.onchange = ()=>{
  tiles.forEach(({pc})=> pc.__setMaxKbps(dom.maxBr.value));
};
dom.reconnectAll.onclick = ()=>{
  tiles.forEach(({pc})=> pc.restartIce());
};
dom.freezeAll.onclick = ()=>{
  tiles.forEach(({pc})=> pc.getTransceivers().forEach(t=>t.direction='inactive'));
};
dom.resumeAll.onclick = ()=>{
  tiles.forEach(({pc})=> pc.getTransceivers().forEach(t=>t.direction='recvonly'));
};
dom.debugBtn.onclick = ()=>{ DEBUG = !DEBUG; document.querySelectorAll('.debug').forEach(d=>d.style.display=DEBUG?'block':'none'); };
dom.refreshRoster.onclick = boot;

function tokenTicker(){
  const st = getTurnState(); if(!st) return;
  const ageM = Math.floor((Date.now()-st.ageStart)/60000);
  const leftM = Math.max(0, Math.floor((st.expAt-Date.now())/60000));
  dom.tokenAge.textContent = `age: ${ageM}m • left: ${leftM}m`;
  requestAnimationFrame(tokenTicker);
}

async function ensureTurn(force=false){
  if(force || !getTurnState()) {
    await fetchTurnCreds();
    tokenTicker();
  }
}

async function fetchRoster(){
  // Ожидаемый ответ: [{id:'FENOMEN', name:'FENOMEN', slot:3}, ...]
  const r = await fetch(`${ENV.API_BASE}/api/admin/cameras`);
  if(!r.ok) throw new Error('roster http '+r.status);
  roster = await r.json();
}

function renderTiles(){
  dom.tiles.innerHTML = '';
  if(!roster.length){ dom.empty.style.display='block'; return; }
  dom.empty.style.display='none';
  roster.forEach(row=>{
    const el = document.createElement('div'); el.className='tile'; el.dataset.id=row.id;
    const v = document.createElement('video'); v.muted=true; v.autoplay=true; v.playsInline=true;
    const badge = document.createElement('div'); badge.className='badge'; badge.textContent = `${row.name||row.id}`;
    const tb = document.createElement('div'); tb.className='toolbar';
    tb.innerHTML = `
      <button data-act="focus">FOCUS</button>
      <button data-act="reconnect">Reconnect</button>
      <select data-act="quality">
        <option>Auto</option><option>Low</option><option selected>Mid</option><option>High</option>
      </select>
      <button data-act="hide">${getVisible(row.id)?'Hide in MAIN':'Show in MAIN'}</button>
    `;
    el.appendChild(v); el.appendChild(badge); el.appendChild(tb);
    dom.tiles.appendChild(el);

    bindTile(row, el, v);
  });
}

function bindTile(row, el, video){
  const pc = createReceiverPC({
    forceTurnOnly: dom.forceTurn.checked,
    maxKbps: dom.maxBr.value,
    onTrack: (stream)=>{
      video.srcObject = stream;
      video.play().catch(()=>{ /* Autoplay could be blocked */ });
    }
  });

  tiles.set(row.id, { pc, video, el, statsDetach: attachStatsPanel({
    pc, video, hostEl: el,
    onRelayCount: (isRelay)=>{ relayCount += isRelay; updateKpis(); }
  })});

  // ——— Сигналинг (зависит от твоего бэка). Ниже — шаблон через REST:
  negotiate(row.id, pc).catch(console.error);

  el.querySelector('.toolbar').addEventListener('click', async (e)=>{
    const act = e.target?.dataset?.act;
    if(!act) return;
    if(act==='reconnect') pc.restartIce();
    if(act==='focus') el.scrollIntoView({behavior:'smooth',block:'center'});
    if(act==='hide'){
      const newV = !getVisible(row.id);
      await setVisible(row.id, newV);
      e.target.textContent = newV ? 'Hide in MAIN' : 'Show in MAIN';
    }
  });
  el.querySelector('select[data-act="quality"]').onchange = (ev)=>{
    // приёмник без simulcast: оставим как hint
    const val = ev.target.value;
    video.contentHint = (val==='High'?'detail': val==='Low'?'motion':'');
  };
}

async function negotiate(id, pc){
  // 1) OFFER
  const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false });
  await pc.setLocalDescription(offer);

  // 2) Отправляем на бэк, получаем ANSWER (эндпоинт укажи свой)
  const r = await fetch(`${ENV.API_BASE}/api/webrtc/viewer/answer?id=${encodeURIComponent(id)}`,{
    method:'POST', headers:{'Content-Type':'application/sdp'},
    body: offer.sdp
  });
  if(!r.ok) throw new Error('answer http '+r.status);
  const answerSdp = await r.text();
  await pc.setRemoteDescription({ type:'answer', sdp: answerSdp });
}

function updateKpis(){
  // Простая сумма: bitrate выводит diag панель; здесь считаем только кол-во релеев
  dom.kRelays.textContent = [...tiles.values()].filter(x=>x.el.querySelector('.debug')?.textContent.includes('relay')).length;
  dom.kBitrate.textContent = '— kbps';
  dom.kRef.textContent = new Date().toLocaleTimeString();
}

async function boot(){
  await loadVisibility();
  await fetchRoster();
  renderTiles();
}

window.addEventListener('DOMContentLoaded', async ()=>{
  // если хочешь — автоподстановка ключа из query (?key=...)
  const params = new URLSearchParams(location.search);
  const key = params.get('key'); if(key){ dom.keyInput.value = key; }
  if(dom.keyInput.value){ setAdminKey(dom.keyInput.value.trim()); await ensureTurn(); }
  await boot();
});
