import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface OllamaStatus {
  local_online: boolean;
  local_version: string | null;
  cloud_online: boolean;
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

interface MarginComment {
  id: number;
  author: "human" | "ai";
  atSec: number | null; // loose anchor into the session timeline
  text: string;
}

function fmtClock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

/** In the Tauri webview, invoke() reaches the Rust backend. In a plain
 *  browser (dev preview) there is no backend, so we fall back to a direct
 *  fetch against the local daemon — which also covers CORS-friendly setups. */
async function probeOllama(): Promise<OllamaStatus> {
  try {
    return await invoke<OllamaStatus>("ollama_status");
  } catch {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const resp = await fetch("http://127.0.0.1:11434/api/version", {
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const body = await resp.json();
      return {
        local_online: true,
        local_version: body.version ?? null,
        cloud_online: false,
      };
    } catch {
      return { local_online: false, local_version: null, cloud_online: false };
    }
  }
}

export default function App() {
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [noteText, setNoteText] = useState("");
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(-90);
  const [lastSession, setLastSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Margin column: human + AI comments, loosely anchored to the timeline.
  const [margin, setMargin] = useState<MarginComment[]>([]);
  const [marginDraft, setMarginDraft] = useState("");
  const nextId = useRef(1);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    probeOllama().then(setOllama);

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

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [margin]);

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

  function addMarginComment() {
    const text = marginDraft.trim();
    if (!text) return;
    setMargin((m) => [
      ...m,
      {
        id: nextId.current++,
        author: "human",
        atSec: recording ? elapsed : null,
        text,
      },
    ]);
    setMarginDraft("");
  }

  const statusText = (() => {
    if (ollama === null) return "checking…";
    if (ollama.local_online && ollama.cloud_online) return "Ollama local + cloud";
    if (ollama.local_online)
      return `Ollama ${ollama.local_version ?? "local"}`.trim();
    if (ollama.cloud_online) return "Ollama Cloud";
    return "Ollama offline";
  })();
  const statusOk = (ollama?.local_online || ollama?.cloud_online) ?? false;

  // Level bar maps -60..0 dBFS to 0..100% width.
  const levelPct = Math.max(0, Math.min(100, ((level + 60) / 60) * 100));

  return (
    <div className="app">
      <aside className="sidebar">
        <h1 className="logo">Stenollama</h1>
        <div
          className={`status-chip ${statusOk ? "ok" : "down"}`}
          title={
            ollama === null
              ? "probing Ollama…"
              : `local daemon: ${ollama.local_online ? "up" : "down"} · cloud: ${
                  ollama.cloud_online ? "up (OLLAMA_API_KEY set)" : "unavailable"
                }`
          }
        >
          <span className="dot" />
          {statusText}
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

      <aside className="margin-col">
        <p className="section-label">Margin — human &amp; AI comments</p>
        <div className="margin-feed" ref={feedRef}>
          {margin.length === 0 ? (
            <div className="placeholder">
              Comments land here as you take notes: your own remarks, and AI
              summaries with quotes you select. Anchors are loose — they mark
              roughly where in the session the comment belongs. The full
              transcript is always saved separately.
            </div>
          ) : (
            margin.map((c) => (
              <div key={c.id} className={`margin-entry ${c.author}`}>
                <span className="margin-meta">
                  <span className={`author ${c.author}`}>
                    {c.author === "human" ? "You" : "AI"}
                  </span>
                  {c.atSec !== null && (
                    <span className="margin-time">≈ {fmtClock(c.atSec)}</span>
                  )}
                </span>
                <p className="margin-text">{c.text}</p>
              </div>
            ))
          )}
        </div>
        <div className="margin-input">
          <input
            value={marginDraft}
            onChange={(e) => setMarginDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addMarginComment()}
            placeholder={
              recording
                ? `Comment @ ${fmtClock(elapsed)} — Enter to add`
                : "Add a comment…"
            }
          />
        </div>
      </aside>
    </div>
  );
}