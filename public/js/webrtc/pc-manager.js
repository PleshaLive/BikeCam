import { createTurnOnlyPeerConnection } from "./turn-only.js";
import { logEv } from "./diag.js";
import { parseCandidate } from "./utils.js";

const DEFAULT_OPTIONS = { turnOnly: true, tcpOnly: false };

class PeerConnectionManager {
  constructor() {
    this.pc = null;
    this.dc = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 4;
    this.reconnectTimer = null;
    this.creating = false;
    this.createdCount = 0;
    this.maxPcCount = 8;
    this.lastOptions = { ...DEFAULT_OPTIONS };
    this.offerHandler = null;
    this.negotiationLock = false;
    this.negotiationQueue = false;
    this.fatalSelector = "#ice-status";
    this.autoCleanupRegistered = false;
    registerAutoCleanup(this);
  }

  setOfferHandler(handler) {
    this.offerHandler = typeof handler === "function" ? handler : null;
  }

  setFatalTarget(selector) {
    if (selector) {
      this.fatalSelector = selector;
    }
  }

  async create(options = {}) {
    if (this.creating) {
      return this.pc;
    }
    this.creating = true;

    const turnOnly = options.turnOnly !== undefined ? Boolean(options.turnOnly) : DEFAULT_OPTIONS.turnOnly;
    const tcpOnly = options.tcpOnly !== undefined ? Boolean(options.tcpOnly) : DEFAULT_OPTIONS.tcpOnly;
    this.lastOptions = { turnOnly, tcpOnly };

    await this.destroy();

    if (this.createdCount >= this.maxPcCount) {
      this.creating = false;
      throw new Error("PC limit reached");
    }

    try {
      const pc = await createTurnOnlyPeerConnection({ forceTurnOnly: turnOnly, tcpOnly });
      this.pc = pc;
      this.createdCount += 1;
      this.reconnectAttempts = 0;
      this.attachDiagnostics(pc);
      this.ensureRecvOnlyTransceivers(pc);
      this.createDiagChannel(pc);
      this.bindNegotiation(pc);
      logEv("admin", "pc-created", { turnOnly, tcpOnly });
      return pc;
    } finally {
      this.creating = false;
    }
  }

  async negotiate({ reason = "manual", iceRestart = false } = {}) {
    if (!this.pc) {
      throw new Error("no pc");
    }
    if (!this.offerHandler) {
      throw new Error("offer handler not configured");
    }
    if (this.negotiationLock) {
      this.negotiationQueue = { reason, iceRestart };
      return;
    }
    this.negotiationLock = true;
    logEv("admin", "negotiate-start", { reason, iceRestart });
    try {
      const offerOptions = iceRestart ? { iceRestart: true } : undefined;
      const offer = await this.pc.createOffer(offerOptions);
      await this.pc.setLocalDescription(offer);
      const answer = await this.offerHandler(offer, { reason, iceRestart });
      await this.pc.setRemoteDescription(answer);
      const hasRelay = / typ relay /i.test(this.pc.localDescription?.sdp || "");
      logEv("admin", hasRelay ? "relay-detected" : "non-relay-detected", { reason });
      if (!hasRelay) {
        throw new Error("non-relay-detected");
      }
      return true;
    } finally {
      this.negotiationLock = false;
      const queued = this.negotiationQueue;
      this.negotiationQueue = false;
      if (queued) {
        this.negotiate(queued).catch((error) => {
          logEv("admin", "negotiate-error", { message: error?.message || String(error) });
        });
      }
    }
  }

  async destroy() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const pc = this.pc;
    this.pc = null;
    if (!pc) {
      return;
    }

    try {
      const senders = typeof pc.getSenders === "function" ? pc.getSenders() : [];
      senders.forEach((sender) => {
        try {
          if (sender.track) {
            sender.track.stop();
          }
        } catch (error) {
          // ignore
        }
      });
    } catch (error) {
      // ignore
    }

    try {
      const receivers = typeof pc.getReceivers === "function" ? pc.getReceivers() : [];
      receivers.forEach((receiver) => {
        try {
          if (receiver.track) {
            receiver.track.stop();
          }
        } catch (error) {
          // ignore
        }
      });
    } catch (error) {
      // ignore
    }

    try {
      const transceivers = typeof pc.getTransceivers === "function" ? pc.getTransceivers() : [];
      transceivers.forEach((transceiver) => {
        try {
          transceiver.stop?.();
        } catch (error) {
          // ignore
        }
      });
    } catch (error) {
      // ignore
    }

    try {
      pc.close();
    } catch (error) {
      // ignore
    }

    pc.onicecandidate = null;
    pc.onicecandidateerror = null;
    pc.onicegatheringstatechange = null;
    pc.oniceconnectionstatechange = null;
    pc.onconnectionstatechange = null;
    pc.onnegotiationneeded = null;
    pc.ontrack = null;

    this.dc = null;
    logEv("admin", "pc-destroyed", {});
  }

  scheduleReconnect(reason, overrides = {}) {
    logEv("admin", "reconnect", { reason, attempts: this.reconnectAttempts });
    const options = {
      turnOnly: overrides.turnOnly !== undefined ? overrides.turnOnly : this.lastOptions.turnOnly,
      tcpOnly: overrides.tcpOnly !== undefined ? overrides.tcpOnly : this.lastOptions.tcpOnly,
    };
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      showFatal("Relay not available. Check TURN.");
      return;
    }
    const delay = Math.min(8_000, 500 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.create(options);
        await this.negotiate({ reason: "reconnect", iceRestart: true });
      } catch (error) {
        logEv("admin", "reconnect-failed", { message: error?.message || String(error) });
        this.scheduleReconnect("auto", options);
      }
    }, delay);
  }

  attachDiagnostics(pc) {
    const safeCandidate = (candidate) => {
      if (!candidate) {
        return null;
      }
      const parsed = parseCandidate(candidate.candidate || "");
      if (!parsed) {
        return candidate.candidate || "";
      }
      return { type: parsed.type, protocol: parsed.protocol, relayProtocol: parsed.relayProtocol };
    };

    pc.addEventListener("icecandidate", (event) => {
      logEv("ice", "candidate", safeCandidate(event.candidate));
    });

    pc.addEventListener("icecandidateerror", (event) => {
      logEv("ice", "candidate_error", {
        code: event.errorCode,
        text: event.errorText,
        url: event.url,
        address: event.address,
        port: event.port,
      });
    });

    pc.addEventListener("icegatheringstatechange", () => {
      logEv("pc", "gather", pc.iceGatheringState);
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      logEv("pc", "ice", pc.iceConnectionState);
      if (pc.iceConnectionState === "failed") {
        this.scheduleReconnect("ice-failed");
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      logEv("pc", "conn", pc.connectionState);
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.scheduleReconnect("conn-state", {});
      }
    });
  }

  ensureRecvOnlyTransceivers(pc) {
    if (!pc || typeof pc.addTransceiver !== "function") {
      return;
    }
    try {
      const kinds = new Set();
      const existing = typeof pc.getTransceivers === "function" ? pc.getTransceivers() : [];
      existing.forEach((transceiver) => {
        if (transceiver?.receiver?.track?.kind) {
          kinds.add(transceiver.receiver.track.kind);
        }
      });
      if (!kinds.has("video")) {
        pc.addTransceiver("video", { direction: "recvonly" });
      }
      if (!kinds.has("audio")) {
        pc.addTransceiver("audio", { direction: "recvonly" });
      }
    } catch (error) {
      logEv("admin", "transceiver-error", { message: error?.message || String(error) });
    }
  }

  createDiagChannel(pc) {
    try {
      this.dc = pc.createDataChannel("diag", { negotiated: false });
      this.dc.addEventListener("open", () => {
        logEv("dc", "open", {});
      });
      this.dc.addEventListener("close", () => {
        logEv("dc", "close", {});
      });
      this.dc.addEventListener("error", (event) => {
        logEv("dc", "error", { message: event?.message || "error" });
      });
    } catch (error) {
      logEv("dc", "create-error", { message: error?.message || String(error) });
    }
  }

  bindNegotiation(pc) {
    const debounced = debounce(async () => {
      try {
        await this.negotiate({ reason: "auto" });
      } catch (error) {
        logEv("admin", "offer-failed", { message: error?.message || String(error) });
        if (String(error).includes("non-relay")) {
          if (!this.lastOptions.tcpOnly) {
            this.scheduleReconnect("non-relay", { turnOnly: this.lastOptions.turnOnly, tcpOnly: true });
          } else {
            showFatal("Relay not available. Check TURN.");
          }
        } else {
          this.scheduleReconnect("offer-failed", {});
        }
      }
    }, 300);
    pc.addEventListener("negotiationneeded", () => {
      debounced();
    });
  }
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
    }, ms);
  };
}

function showFatal(message) {
  const target = document.querySelector(pcManager.fatalSelector);
  if (target) {
    target.textContent = message;
    target.classList.add("error");
  }
  logEv("admin", "fatal", { message });
}

function registerAutoCleanup(manager) {
  if (manager.autoCleanupRegistered) {
    return;
  }
  manager.autoCleanupRegistered = true;
  window.addEventListener("beforeunload", () => {
    manager.destroy().catch(() => {});
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      manager.destroy().catch(() => {});
    }
  });
}

export const pcManager = new PeerConnectionManager();
export { showFatal };

try {
  window.pcManager = pcManager;
  window.showFatal = showFatal;
} catch (error) {
  // ignore window assignment errors
}
