import { getTurnState } from '/webrtc/turn.js';

export function createReceiverPC({ forceTurnOnly=false, maxKbps='Auto', onTrack }) {
  const iceServers = getTurnState()?.iceServers || [];
  const cfg = {
    iceServers,
    bundlePolicy: 'balanced',
    sdpSemantics: 'unified-plan',
    ...(forceTurnOnly ? { iceTransportPolicy: 'relay' } : {})
  };
  const pc = new RTCPeerConnection(cfg);

  pc.addTransceiver('video', { direction: 'recvonly' });
  // если нужен звук, раскомментируй:
  // pc.addTransceiver('audio', { direction: 'recvonly' });

  pc.ontrack = (e)=> onTrack?.(e.streams[0]);

  pc.addEventListener('iceconnectionstatechange', ()=>{
    if(pc.iceConnectionState === 'failed') pc.restartIce();
  });

  // ограничение битрейта (влияет на RTCRtpReceiver не напрямую — но помогает по RTCP)
  pc.__setMaxKbps = async (kbps)=>{
    pc.getTransceivers().forEach(tr=>{
      if(tr.receiver && tr.receiver.transport?.sender) {
        // no-op для receiver; оставим как маркер
      }
    });
    pc.__maxKbps = kbps;
  };
  pc.__setMaxKbps(maxKbps);

  pc.__applyTurnOnly = async (enabled)=>{
    // recreate конфиг без пересборки треков
    const iceServers2 = getTurnState()?.iceServers || [];
    pc.setConfiguration({ iceServers: iceServers2, ...(enabled?{iceTransportPolicy:'relay'}:{}) });
    pc.restartIce();
  };

  return pc;
}
