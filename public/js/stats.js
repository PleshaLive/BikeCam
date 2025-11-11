const DEFAULT_SAMPLE = {
  timestamp: Date.now(),
  bitrateKbps: 0,
  fps: 0,
  framesDropped: 0,
  framesDecoded: 0,
  framesPerSecond: 0,
  packetsLost: 0,
  packetsReceived: 0,
};

export function computeInboundVideoMetrics(report) {
  if (!report || typeof report.forEach !== "function") {
    return { ...DEFAULT_SAMPLE, timestamp: Date.now() };
  }

  let inbound;
  let track;

  report.forEach((entry) => {
    if (!inbound && entry && entry.type === "inbound-rtp" && entry.kind === "video" && !entry.isRemote) {
      inbound = entry;
    }
    if (!track && entry && entry.type === "track" && entry.kind === "video") {
      track = entry;
    }
  });

  if (!inbound) {
    return { ...DEFAULT_SAMPLE, timestamp: Date.now() };
  }

  const timestamp = typeof inbound.timestamp === "number" ? inbound.timestamp / 1000 : Date.now();
  const bytesReceived = inbound.bytesReceived || 0;
  const packetsReceived = inbound.packetsReceived || 0;
  const packetsLost = inbound.packetsLost || 0;
  const framesDecoded = inbound.framesDecoded || 0;
  const framesDropped = inbound.framesDropped || 0;
  const fps = track && typeof track.framesPerSecond === "number" ? track.framesPerSecond : 0;

  const bitrateKbps = bytesReceived > 0 && inbound.timestamp
    ? (bytesReceived * 8) / 1000
    : 0;

  return {
    timestamp,
    bitrateKbps,
    fps,
    framesDropped,
    framesDecoded,
    framesPerSecond: fps,
    packetsLost,
    packetsReceived,
  };
}
