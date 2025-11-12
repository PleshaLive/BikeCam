import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPeer, CandidateDetails, PeerHandle } from "../../webrtc/createPeer";
import { getTurnConfig, invalidateTurnCache, TurnConfig } from "../../services/turnClient";

interface CandidateRow extends CandidateDetails {
  id: string;
  direction: "local" | "remote";
  addedAt: number;
}

interface LogEntry {
  id: number;
  timestamp: number;
  message: string;
  detail?: unknown;
}

const MAX_LOGS = 200;

function formatTimestamp(value: number) {
  return new Date(value).toLocaleTimeString();
}

export default function DiagPage() {
  const [turnConfig, setTurnConfig] = useState<TurnConfig | null>(null);
  const [rawConfig, setRawConfig] = useState<unknown>(null);
  const [status, setStatus] = useState<"idle" | "pending" | "connected" | "failed">("idle");
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [corsOrigin, setCorsOrigin] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const peerRef = useRef<PeerHandle | null>(null);
  const nextLogId = useRef(1);
  const nextCandidateId = useRef(1);

  const pushLog = useCallback((message: string, detail?: unknown) => {
    const entry: LogEntry = {
      id: nextLogId.current++,
      timestamp: Date.now(),
      message,
      detail,
    };
    console.info(`[webrtc/diag] ${message}`, detail);
    setLogs((prev: LogEntry[]) => {
      const next = [...prev, entry];
      return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
    });
  }, []);

  const resetCandidates = useCallback(() => {
    nextCandidateId.current = 1;
    setCandidates([]);
  }, []);

  const addCandidate = useCallback((direction: "local" | "remote", details: CandidateDetails) => {
    const createdAt = Date.now();
    setCandidates((prev: CandidateRow[]) => [
      ...prev,
      {
        ...details,
        id: `${direction}-${nextCandidateId.current++}`,
        direction,
        addedAt: createdAt,
      },
    ]);
  }, []);

  const stopOngoingWork = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    if (peerRef.current) {
      peerRef.current.close();
      peerRef.current = null;
    }
  }, []);

  const handleFetchTurn = useCallback(async () => {
    stopOngoingWork();
    invalidateTurnCache();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsFetching(true);
    setError(null);

    try {
      const config = await getTurnConfig({ forceRefresh: true, signal: controller.signal });
      setTurnConfig(config);
      setRawConfig(config.raw);
      setCorsOrigin(config.allowOrigin ?? null);
      setWarning(config.degraded ? "TURN unavailable — using STUN fallback" : null);
      pushLog("TURN credentials fetched", {
        source: config.source,
        ttl: config.ttl,
        degraded: config.degraded,
      });
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") {
        pushLog("TURN fetch aborted");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        pushLog("TURN fetch failed", { message });
      }
    } finally {
      setIsFetching(false);
      abortRef.current = null;
    }
  }, [pushLog, stopOngoingWork]);

  const handleTestRelay = useCallback(async () => {
    stopOngoingWork();
    resetCandidates();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsTesting(true);
    setStatus("pending");
    setError(null);

    try {
      const config = await getTurnConfig({ signal: controller.signal });
      setTurnConfig(config);
      setRawConfig(config.raw);
      setCorsOrigin(config.allowOrigin ?? null);
      setWarning(config.degraded ? "TURN unavailable — using STUN fallback" : null);
      pushLog("TURN config ready", {
        source: config.source,
        ttl: config.ttl,
        degraded: config.degraded,
      });

      const handle = await createPeer({
        relayOnly: true,
        turnConfig: config,
        onLocalCandidate: (candidate) => addCandidate("local", candidate),
        onRemoteCandidate: (candidate) => addCandidate("remote", candidate),
      });

      peerRef.current = handle;
      pushLog("Peer created", {
        relayOnly: true,
        degraded: config.degraded,
      });

      await handle.waitConnected();
      setStatus("connected");
      pushLog("Peer connected", {
        iceConnectionState: handle.pc.iceConnectionState,
      });
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") {
        pushLog("Peer test aborted");
        setStatus("idle");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus("failed");
        pushLog("Peer test failed", { message });
      }
      if (peerRef.current) {
        peerRef.current.close();
        peerRef.current = null;
      }
    } finally {
      setIsTesting(false);
      abortRef.current = null;
    }
  }, [addCandidate, pushLog, resetCandidates, stopOngoingWork]);

  useEffect(() => {
    return () => {
      stopOngoingWork();
    };
  }, [stopOngoingWork]);

  const ttlInfo = useMemo(() => {
    if (!turnConfig) {
      return null;
    }
    const nextRefreshInMs = Math.max(0, turnConfig.freshUntil - Date.now());
    const expiresInMs = Math.max(0, turnConfig.staleAt - Date.now());
    return {
      ttl: turnConfig.ttl,
      nextRefreshInMs,
      expiresInMs,
    };
  }, [turnConfig]);

  return (
    <main className="webrtc-diag">
      <section className="card">
        <h1>WebRTC Diagnostics</h1>
        <p>
          Validate TURN credentials, inspect ICE candidates, and confirm relay connectivity. Logs are
          mirrored to <code>console.info</code>.
        </p>
        <div className="actions">
          <button type="button" onClick={handleFetchTurn} disabled={isFetching || isTesting}>
            Fetch TURN creds
          </button>
          <button type="button" onClick={handleTestRelay} disabled={isTesting}>
            Test relay only
          </button>
        </div>
      </section>

      {(warning || error) && (
        <section className={`card ${warning ? "warning" : ""}`}>
          {warning && <strong>{warning}</strong>}
          {error && <p>{error}</p>}
        </section>
      )}

      <section className="card">
        <h2>Status</h2>
        <div className="status-grid">
          <div className="status-tile">
            <strong>ICE Source</strong>
            <span>{turnConfig?.source ?? "—"}</span>
          </div>
          <div className="status-tile">
            <strong>Relay Status</strong>
            <span>{turnConfig?.degraded ? "Degraded" : "Healthy"}</span>
          </div>
          <div className="status-tile">
            <strong>Connection</strong>
            <span>{status}</span>
          </div>
          <div className="status-tile">
            <strong>CORS Allow-Origin</strong>
            <span>{corsOrigin ?? "n/a"}</span>
          </div>
          {ttlInfo && (
            <>
              <div className="status-tile">
                <strong>TTL (seconds)</strong>
                <span>{ttlInfo.ttl}</span>
              </div>
              <div className="status-tile">
                <strong>Refresh in</strong>
                <span>{Math.round(ttlInfo.nextRefreshInMs / 1_000)}s</span>
              </div>
              <div className="status-tile">
                <strong>Expires in</strong>
                <span>{Math.round(ttlInfo.expiresInMs / 1_000)}s</span>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="card">
        <h2>TURN Payload</h2>
        <pre>{rawConfig ? JSON.stringify(rawConfig, null, 2) : "No payload fetched yet."}</pre>
      </section>

      <section className="card">
        <h2>ICE Candidates</h2>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Direction</th>
              <th>Foundation</th>
              <th>Component</th>
              <th>Protocol</th>
              <th>Address</th>
              <th>Port</th>
              <th>Type</th>
              <th>Relay Transport</th>
            </tr>
          </thead>
          <tbody>
            {candidates.length === 0 && (
              <tr>
                <td colSpan={9}>No candidates gathered yet.</td>
              </tr>
            )}
            {candidates.map((candidate) => (
              <tr key={candidate.id} className={candidate.type === "relay" ? "relay" : undefined}>
                <td>{formatTimestamp(candidate.addedAt)}</td>
                <td>{candidate.direction}</td>
                <td>{candidate.foundation || "—"}</td>
                <td>{candidate.component || "—"}</td>
                <td>{candidate.protocol || "—"}</td>
                <td>{candidate.address || "—"}</td>
                <td>{candidate.port || "—"}</td>
                <td>{candidate.type || "—"}</td>
                <td>{candidate.relayProtocol || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Log</h2>
        <div className="log-box">
          {logs.length === 0 && <div className="log-entry">Logs will appear here.</div>}
          {logs.map((entry) => (
            <div key={entry.id} className="log-entry">
              <strong>{formatTimestamp(entry.timestamp)}</strong> — {entry.message}
              {entry.detail ? (
                <pre>{JSON.stringify(entry.detail, null, 2)}</pre>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
