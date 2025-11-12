import { getTurnConfig, TurnConfig } from "../services/turnClient";

export interface CandidateDetails {
  foundation: string;
  component: string;
  protocol: string;
  address: string;
  port: string;
  type: string;
  relayProtocol?: string;
  raw: string;
}

export interface CreatePeerOptions {
  relayOnly?: boolean;
  turnConfig?: TurnConfig;
  onLocalCandidate?: (candidate: CandidateDetails) => void;
  onRemoteCandidate?: (candidate: CandidateDetails) => void;
}

export interface PeerHandle {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  waitConnected(): Promise<void>;
  close(): void;
  turn: TurnConfig;
}

const CONNECT_TIMEOUT_MS = 15_000;

function parseCandidate(raw: string | RTCIceCandidate | null): CandidateDetails | null {
  if (!raw) {
    return null;
  }
  const candidate = typeof raw === "string" ? raw : raw.candidate;
  if (!candidate) {
    return null;
  }

  const fields = candidate.trim().split(/\s+/);
  if (fields.length < 8) {
    return null;
  }

  const details: CandidateDetails = {
    foundation: fields[0]?.split(":")[1] || "",
    component: fields[1] || "",
    protocol: fields[2]?.toLowerCase() || "",
    address: fields[4] || "",
    port: fields[5] || "",
    type: "",
    raw: candidate,
  };

  for (let i = 6; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (!key) {
      continue;
    }
    switch (key) {
      case "typ":
        details.type = value || details.type;
        break;
      case "tcptype":
        details.relayProtocol = value || details.relayProtocol;
        break;
      case "raddr":
        // ignore; only showing primary address
        break;
      default:
        break;
    }
  }

  return details;
}

function wireCandidateEvents(
  pc: RTCPeerConnection,
  remote: RTCPeerConnection,
  options: CreatePeerOptions
) {
  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      remote.addIceCandidate(event.candidate).catch(() => {});
      const parsed = parseCandidate(event.candidate);
      if (parsed && options.onLocalCandidate) {
        options.onLocalCandidate(parsed);
      }
    } else {
      remote.addIceCandidate(null).catch(() => {});
    }
  });

  remote.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      pc.addIceCandidate(event.candidate).catch(() => {});
      const parsed = parseCandidate(event.candidate);
      if (parsed && options.onRemoteCandidate) {
        options.onRemoteCandidate(parsed);
      }
    } else {
      pc.addIceCandidate(null).catch(() => {});
    }
  });
}

export async function createPeer(options: CreatePeerOptions = {}): Promise<PeerHandle> {
  const turn = options.turnConfig ?? (await getTurnConfig());
  const configuration: RTCConfiguration = {
    iceServers: turn.iceServers,
    iceTransportPolicy: options.relayOnly ? "relay" : "all",
    bundlePolicy: "balanced",
  };

  const pc = new RTCPeerConnection(configuration);
  const remote = new RTCPeerConnection(configuration);
  const dc = pc.createDataChannel("diag", { ordered: true });

  dc.addEventListener("open", () => {
    try {
      dc.send("ping");
    } catch (error) {
      console.info("[createPeer] dc send", error);
    }
  });

  wireCandidateEvents(pc, remote, options);

  remote.ondatachannel = (event) => {
    const channel = event.channel;
    channel.addEventListener("open", () => {
      // keep channel alive
      channel.send("pong");
    });
    channel.addEventListener("message", () => {
      // no-op, loopback messages
    });
  };

  const waitConnected = () =>
    new Promise<void>((resolve, reject) => {
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        resolve();
        return;
      }

      let settled = false;
      const timeout = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("Timed out waiting for ICE connection"));
        }
      }, CONNECT_TIMEOUT_MS);

      const handleChange = () => {
        const state = pc.iceConnectionState;
        if ((state === "connected" || state === "completed") && !settled) {
          settled = true;
          cleanup();
          resolve();
        }
        if (state === "failed" && !settled) {
          settled = true;
          cleanup();
          reject(new Error("ICE connection failed"));
        }
      };

      const handleConnectionState = () => {
        if (pc.connectionState === "failed" && !settled) {
          settled = true;
          cleanup();
          reject(new Error("Peer connection failed"));
        }
      };

      const cleanup = () => {
        window.clearTimeout(timeout);
        pc.removeEventListener("iceconnectionstatechange", handleChange);
        pc.removeEventListener("connectionstatechange", handleConnectionState);
      };

      pc.addEventListener("iceconnectionstatechange", handleChange);
      pc.addEventListener("connectionstatechange", handleConnectionState);
    });

  const close = () => {
    try {
      pc.getSenders().forEach((sender) => {
        try {
          pc.removeTrack(sender);
        } catch (error) {
          console.info("[createPeer] removeTrack", error);
        }
      });
    } catch (error) {
      // ignore
    }
    try {
      dc.close();
    } catch (error) {
      // ignore
    }
    try {
      pc.close();
    } catch (error) {
      // ignore
    }
    try {
      remote.close();
    } catch (error) {
      // ignore
    }
  };

  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
    await pc.setLocalDescription(offer);
    await remote.setRemoteDescription(offer);

    const answer = await remote.createAnswer();
    await remote.setLocalDescription(answer);
    await pc.setRemoteDescription(answer);
  } catch (error) {
    close();
    throw error;
  }

  return {
    pc,
    dc,
    waitConnected,
    close,
    turn,
  };
}

export { parseCandidate };
