export function attachStatsPanel({ pc, video, hostEl, onRelayCount, onStats }) {
  let last = { bytes:0, t:performance.now() };
  const box = document.createElement('div');
  box.className = 'debug';
  hostEl.appendChild(box);

  async function tick(){
    if(pc.connectionState==='closed') return;
    try{
      const stats = await pc.getStats();
      let bytes = 0, frames = 0, rtt = 0, relay = false;
      stats.forEach(s=>{
        if(s.type==='inbound-rtp' && s.kind==='video'){ bytes += s.bytesReceived||0; frames += s.framesDecoded||0; rtt = s.roundTripTime||rtt; }
        if(s.type==='candidate-pair' && s.selected && stats.get(s.remoteCandidateId)?.candidateType==='relay') relay = true;
      });
      const now = performance.now();
  const br = last.bytes ? Math.round((bytes-last.bytes)*8/((now-last.t)/1000)/1000) : 0;
      last = { bytes, t: now };
  const rttMs = Math.round((rtt || 0) * 1000) || 0;
  if(onRelayCount) onRelayCount(relay ? 1 : 0);
  if(onStats) onStats({ bitrate: br, rtt: rttMs, relay });
  box.textContent = `ICE:${pc.iceConnectionState} • DTLS:${pc.connectionState} • ${br} kbps • rtt:${rttMs} ms`;
      requestAnimationFrame(tick);
    }catch(e){ /* ignore */ }
  }
  tick();
  return ()=> box.remove();
}
