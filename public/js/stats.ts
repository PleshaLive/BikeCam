export interface VideoMetrics {
  timestamp: number;
  bitrateKbps: number;
  fps: number;
  framesDropped: number;
  framesDecoded: number;
  framesPerSecond: number;
  packetsLost: number;
  packetsReceived: number;
}

export function computeInboundVideoMetrics(report: RTCStatsReport): VideoMetrics {
  let inbound: RTCInboundRtpStreamStats | undefined;
  let track: any = null;

  report.forEach((entry) => {
    if (entry.type === "inbound-rtp" && entry.kind === "video" && !entry.isRemote) {
      inbound = entry as RTCInboundRtpStreamStats;
    }
    if (entry.type === "track" && (entry as any).kind === "video") {
      track = entry;
    }
  });

  if (!inbound) {
    return {
      timestamp: Date.now(),
      bitrateKbps: 0,
      fps: 0,
      framesDropped: 0,
      framesDecoded: 0,
      framesPerSecond: 0,
      packetsLost: 0,
      packetsReceived: 0,
    };
  }

  const timeSeconds = inbound.timestamp ? inbound.timestamp / 1000 : Date.now() / 1000;
  const bytesReceived = inbound.bytesReceived || 0;
  const packetsReceived = inbound.packetsReceived || 0;
  const packetsLost = inbound.packetsLost || 0;
  const framesDecoded = inbound.framesDecoded || 0;
  const framesDropped = inbound.framesDropped || 0;

  const bitrateKbps = bytesReceived > 0 && inbound.timestamp
    ? ((bytesReceived * 8) / 1000)
    : 0;
  const fps = track && typeof track.framesPerSecond === "number" ? track.framesPerSecond : 0;

  return {
    timestamp: timeSeconds,
    bitrateKbps,
    fps,
    framesDropped,
    framesDecoded,
    framesPerSecond: fps,
    packetsLost,
    packetsReceived,
  };
}
