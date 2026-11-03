import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface OllamaStatus {
  online: boolean;
  version: string | null;
}

export default function App() {
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [noteText, setNoteText] = useState("");
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    invoke<OllamaStatus>("ollama_status")
      .then(setOllama)
      .catch(() => setOllama({ online: false, version: null }));
  }, []);

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
      </aside>

      <main className="center">
        <header className="session-header">
          <button
            className={`record-btn ${recording ? "recording" : ""}`}
            onClick={() => setRecording(!recording)}
          >
            {recording ? "■ Stop" : "● Record"}
          </button>
          <span className="session-title">New session</span>
          <span className="session-clock">00:00:00</span>
        </header>

        <section className="waveform" aria-label="audio timeline">
          <div className="waveform-placeholder">
            Timeline: waveform, note anchors, highlights land here
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