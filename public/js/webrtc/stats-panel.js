const DEFAULT_INTERVAL = 1_000;

function tryGetPlaybackQuality(video) {
  if (!video) {
    return null;
  }
  try {
    if (typeof video.getVideoPlaybackQuality === "function") {
      return video.getVideoPlaybackQuality();
    }
  } catch (error) {
    // ignore playback quality errors
  }
  return null;
}

function summarizeCandidatePair(report) {
  let transport = null;
  report.forEach((entry) => {
    if (entry.type === "transport" && entry.selectedCandidatePairId) {
      transport = entry;
    }
  });

  if (!transport?.selectedCandidatePairId) {
    return null;
  }

  const candidatePair = report.get(transport.selectedCandidatePairId);
  if (!candidatePair) {
    return null;
  }
  const local = report.get(candidatePair.localCandidateId);
  const remote = report.get(candidatePair.remoteCandidateId);
  return {
    id: candidatePair.id || null,
    state: candidatePair.state || null,
    nominated: Boolean(candidatePair.nominated),
    currentRoundTripTime: typeof candidatePair.currentRoundTripTime === "number" ? candidatePair.currentRoundTripTime : null,
    totalRoundTripTime: typeof candidatePair.totalRoundTripTime === "number" ? candidatePair.totalRoundTripTime : null,
    requestsReceived: candidatePair.requestsReceived || 0,
    responsesReceived: candidatePair.responsesReceived || 0,
    bytesSent: candidatePair.bytesSent || 0,
    bytesReceived: candidatePair.bytesReceived || 0,
    availableOutgoingBitrate: candidatePair.availableOutgoingBitrate || transport.availableOutgoingBitrate || null,
    availableIncomingBitrate: candidatePair.availableIncomingBitrate || null,
    local,
    remote,
  };
}

function extractInbound(report) {
  let inboundVideo = null;
  let inboundAudio = null;
  report.forEach((entry) => {
    if (entry.type === "inbound-rtp" && !entry.isRemote) {
      if (entry.kind === "video" && !inboundVideo) {
        inboundVideo = entry;
      }
      if (entry.kind === "audio" && !inboundAudio) {
        inboundAudio = entry;
      }
    }
  });
  return { inboundVideo, inboundAudio };
}

function computeBitrate(currentBytes, previousBytes, currentTimestamp, previousTimestamp) {
  if (!Number.isFinite(currentBytes) || !Number.isFinite(previousBytes)) {
    return 0;
  }
  if (!Number.isFinite(currentTimestamp) || !Number.isFinite(previousTimestamp)) {
    return 0;
  }
  const deltaBytes = currentBytes - previousBytes;
  const deltaTime = currentTimestamp - previousTimestamp;
  if (deltaBytes <= 0 || deltaTime <= 0) {
    return 0;
  }
  return Math.round(((deltaBytes * 8) / deltaTime) || 0);
}

function summarize(pc, video, report, previousSample) {
  const iceState = pc.iceConnectionState || "new";
  const connectionState = pc.connectionState || "new";
  const { inboundVideo, inboundAudio } = extractInbound(report);
  const candidatePair = summarizeCandidatePair(report);
  const now = performance.now();

  const summary = {
    timestamp: now,
    iceState,
    connectionState,
    candidatePair,
    candidateType: candidatePair?.remote?.candidateType || null,
    relayProtocol: candidatePair?.remote?.protocol || candidatePair?.remote?.relayProtocol || null,
    relayAddress: candidatePair?.remote?.ip || candidatePair?.remote?.address || null,
    bytesReceived: inboundVideo?.bytesReceived || 0,
    framesDecoded: inboundVideo?.framesDecoded || 0,
    framesDropped: inboundVideo?.framesDropped || 0,
    keyFramesDecoded: inboundVideo?.keyFramesDecoded || 0,
    jitter: inboundVideo?.jitter || 0,
    packetsLost: inboundVideo?.packetsLost || 0,
    pliCount: inboundVideo?.pliCount || 0,
    firCount: inboundVideo?.firCount || 0,
    nackCount: inboundVideo?.nackCount || 0,
    ssrc: inboundVideo?.ssrc || null,
    bitrateKbps: 0,
    audioLevel: inboundAudio?.audioLevel || 0,
    totalAudioBytes: inboundAudio?.bytesReceived || 0,
    totalPackets: inboundVideo ? inboundVideo.packetsReceived || 0 : 0,
    playback: null,
  };

  if (candidatePair && typeof candidatePair.currentRoundTripTime === "number") {
    summary.rttMs = Math.round(candidatePair.currentRoundTripTime * 1_000);
  } else {
    summary.rttMs = null;
  }

  if (previousSample && inboundVideo) {
    summary.bitrateKbps = computeBitrate(
      inboundVideo.bytesReceived,
      previousSample.bytesReceived,
      inboundVideo.timestamp,
      previousSample.inboundTimestamp
    );
  }

  if (video) {
    const quality = tryGetPlaybackQuality(video);
    if (quality) {
      summary.playback = {
        totalFrames: quality.totalVideoFrames || 0,
        droppedFrames: quality.droppedVideoFrames || 0,
        corruptedFrames: quality.corruptedVideoFrames || 0,
      };
    }
  }

  summary.inboundTimestamp = inboundVideo?.timestamp || now;

  return summary;
}

export function startTileStats(pc, video, onUpdate, options = {}) {
  if (!pc || typeof pc.getStats !== "function") {
    throw new Error("RTCPeerConnection with getStats() is required");
  }
  const interval = Math.max(250, options.interval || DEFAULT_INTERVAL);
  let timer = null;
  let stopped = false;
  let previousSample = null;

  const loop = async () => {
    if (stopped) {
      return;
    }
    try {
      const report = await pc.getStats(null);
      const summary = summarize(pc, video, report, previousSample);
      previousSample = {
        bytesReceived: summary.bytesReceived,
        inboundTimestamp: summary.inboundTimestamp,
      };
      if (typeof onUpdate === "function") {
        onUpdate(summary, report);
      }
    } catch (error) {
      if (options.onError) {
        try {
          options.onError(error);
        } catch (inner) {
          // ignore nested onError failures
        }
      }
    }

    timer = setTimeout(loop, interval);
  };

  loop();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export default startTileStats;
