import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface OllamaStatus {
  online: boolean;
  version: string | null;
}

interface LevelEvent {
  elapsed_sec: number;
  rms_dbfs: number;
}

interface StoppedEvent {
  session_dir: string;
  duration_sec: number;
  reason: string;
}

function fmtClock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

export default function App() {
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [noteText, setNoteText] = useState("");
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(-90);
  const [lastSession, setLastSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<OllamaStatus>("ollama_status")
      .then(setOllama)
      .catch(() => setOllama({ online: false, version: null }));

    const unsubs: Promise<UnlistenFn>[] = [
      listen<LevelEvent>("capture:level", (e) => {
        setElapsed(e.payload.elapsed_sec);
        setLevel(e.payload.rms_dbfs);
      }),
      listen<StoppedEvent>("capture:stopped", (e) => {
        setRecording(false);
        setElapsed(e.payload.duration_sec);
        setLastSession(e.payload.session_dir);
      }),
    ];
    return () => {
      unsubs.forEach((u) => u.then((unlisten) => unlisten()));
    };
  }, []);

  async function toggleRecord() {
    setError(null);
    try {
      if (!recording) {
        await invoke("capture_start", { notebook: "Inbox" });
        setRecording(true);
        setElapsed(0);
        setLastSession(null);
      } else {
        await invoke("capture_stop");
      }
    } catch (e) {
      setError(String(e));
      setRecording(false);
    }
  }

  // Level bar maps -60..0 dBFS to 0..100% width.
  const levelPct = Math.max(0, Math.min(100, ((level + 60) / 60) * 100));

  return (
    <div className="app">
      <aside className="sidebar">
        <h1 className="logo">Stenollama</h1>
        <div
          className={`status-chip ${ollama?.online ? "ok" : "down"}`}
          title={ollama?.online ? `Ollama ${ollama.version}` : "Ollama not reachable"}
        >
          <span className="dot" />
          {ollama === null
            ? "checking…"
            : ollama.online
              ? `Ollama ${ollama.version ?? ""}`.trim()
              : "Ollama offline"}
        </div>
        <nav className="notebooks">
          <p className="section-label">Notebooks</p>
          <ul>
            <li className="active">Inbox</li>
          </ul>
        </nav>
        {lastSession && (
          <p className="last-session" title={lastSession}>
            Last session: {lastSession.split("/").pop()}
          </p>
        )}
      </aside>

      <main className="center">
        <header className="session-header">
          <button
            className={`record-btn ${recording ? "recording" : ""}`}
            onClick={toggleRecord}
          >
            {recording ? "■ Stop" : "● Record"}
          </button>
          <span className="session-title">
            {recording ? "Capturing system audio…" : "New session"}
          </span>
          <span className="session-clock">{fmtClock(elapsed)}</span>
        </header>

        <section className="waveform" aria-label="audio timeline">
          <div className="level-meter">
            <div className="level-bar" style={{ width: `${levelPct}%` }} />
          </div>
        </section>

        <section className="transcript" aria-label="live transcript">
          <p className="section-label">Transcript</p>
          <div className="transcript-stream placeholder">
            Live transcript (gemma4 via Ollama) streams here during capture.
          </div>
        </section>

        <section className="notes" aria-label="notes editor">
          <p className="section-label">Notes — anchored to the timeline as you type</p>
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Type while listening. Each note is stamped with the audio time."
          />
        </section>

        {error && <div className="error-banner">{error}</div>}
      </main>

      <aside className="distill">
        <p className="section-label">Distillation</p>
        <div className="distill-actions">
          <button disabled>Summarize</button>
          <button disabled>Key points</button>
          <button disabled>Ask about this session</button>
        </div>
        <div className="distill-stream placeholder">
          After the session ends, glm-5.3-flash summaries, references, and
          catch-up briefs appear here.
        </div>
      </aside>
    </div>
  );
}