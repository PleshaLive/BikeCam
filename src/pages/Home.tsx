import { Link } from "react-router-dom";

export default function Home() {
  return (
    <main className="webrtc-diag">
      <section className="card">
        <h1>BikeCam Tools</h1>
        <p>
          Use the diagnostics to verify TURN connectivity and inspect ICE candidates for relay
          readiness. This lightweight shell is intended for operators only.
        </p>
        <div className="actions">
          <Link to="/webrtc/diag" className="button-link">
            Open WebRTC Diagnostics
          </Link>
        </div>
      </section>
    </main>
  );
}
