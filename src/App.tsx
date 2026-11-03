import { useEffect, useRef, useState } from "react";
import { backend } from "./api";

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

interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
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

function fmtStamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function App() {
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(-90);
  const [lastSession, setLastSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The pad.
  const [noteText, setNoteText] = useState("");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [asrError, setAsrError] = useState<string | null>(null);

  // Margin.
  const [margin, setMargin] = useState<MarginComment[]>([]);
  const [marginDraft, setMarginDraft] = useState("");
  const nextId = useRef(1);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    backend()
      .then((b) => b.invoke<OllamaStatus>("ollama_status"))
      .then(setOllama)
      .catch(() => setOllama({ local_online: false, local_version: null, cloud_online: false }));

    backend().then((b) => {
      const un1 = b.listen<LevelEvent>("capture:level", (e) => {
        setElapsed(e.elapsed_sec);
        setLevel(e.rms_dbfs);
      });
      const un2 = b.listen<StoppedEvent>("capture:stopped", (e) => {
        setRecording(false);
        setElapsed(e.duration_sec);
        setLastSession(e.session_dir);
      });
      const un3 = b.listen<TranscriptSegment>("transcript:segment", (seg) => {
        setSegments((prev) => [...prev, seg]);
      });
      const un4 = b.listen<{ message: string }>("transcript:error", (e) => {
        setAsrError(e.message);
      });
      return () => {
        un1.then((un) => un());
        un2.then((un) => un());
        un3.then((un) => un());
        un4.then((un) => un());
      };
    });
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [segments]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [margin]);

  async function toggleRecord() {
    setError(null);
    setAsrError(null);
    try {
      const b = await backend();
      if (!recording) {
        await b.invoke("capture_start", { notebook: "Inbox" });
        setRecording(true);
        setElapsed(0);
        setSegments([]);
        setLastSession(null);
      } else {
        await b.invoke("capture_stop");
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

  const statusOk = (ollama?.local_online || ollama?.cloud_online) ?? false;
  const levelPct = Math.max(0, Math.min(100, ((level + 60) / 60) * 100));

  return (
    <div className="desk">
      <aside className={`drawer ${drawerOpen ? "open" : ""}`}>
        <h1 className="drawer-brand">Stenollama</h1>
        <p className="drawer-label">Notebooks</p>
        <ul className="drawer-list">
          <li className="active">Inbox</li>
          <li className="disabled" title="coming in #28">Research</li>
          <li className="disabled" title="coming in #28">Meetings</li>
        </ul>
        <button className="drawer-new" disabled title="coming in #28">
          + New notebook
        </button>
        <div className="drawer-foot">
          <div
            className={`status-chip ${statusOk ? "ok" : "down"}`}
            title={`local: ${ollama?.local_online ? "up" : "down"} · cloud: ${
              ollama?.cloud_online ? "up" : "unavailable"
            }`}
          >
            <span className="dot" />
            {ollama === null
              ? "checking…"
              : ollama.local_online && ollama.cloud_online
                ? "local + cloud"
                : ollama.local_online
                  ? `local ${ollama.local_version ?? ""}`.trim()
                  : ollama.cloud_online
                    ? "cloud"
                    : "Ollama offline"}
          </div>
          {lastSession && (
            <p className="last-session" title={lastSession}>
              last: {lastSession.split("/").pop()}
            </p>
          )}
        </div>
      </aside>

      <div
        className={`drawer-scrim ${drawerOpen ? "show" : ""}`}
        onClick={() => setDrawerOpen(false)}
      />

      <main className="desk-main">
        <header className="pad-header">
          <button
            className="icon-btn"
            aria-label="toggle notebooks"
            onClick={() => setDrawerOpen(!drawerOpen)}
          >
            ☰
          </button>
          <button className={`record-btn ${recording ? "recording" : ""}`} onClick={toggleRecord}>
            {recording ? "■ Stop" : "● Record"}
          </button>
          <span className="session-clock">{fmtClock(elapsed)}</span>
          <span className="header-title">{recording ? "on the record" : "new session"}</span>
          <div className="level-meter" aria-hidden>
            <div className="level-bar" style={{ width: `${levelPct}%` }} />
          </div>
        </header>

        <section className="pad">
          <div className="binding" aria-hidden />
          <div className="pad-columns">
            <div className="pad-col notes-col">
              <div className="transcript" ref={transcriptRef}>
                {segments.length === 0 ? (
                  <p className="placeholder">
                    {recording
                      ? "listening… speech is transcribed here every few seconds (gemma4, local)."
                      : "press Record — the pad fills with a live transcript as you listen."}
                  </p>
                ) : (
                  segments.map((seg) => (
                    <p key={seg.id} className="segment">
                      <span className="segment-stamp">{fmtStamp(seg.start)}</span>
                      {seg.text}
                    </p>
                  ))
                )}
              </div>
              <textarea
                className="notes-input"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="Take notes while listening — each line is anchored to the tape."
              />
            </div>

            <div className="pad-col margin-col">
              <div className="margin-feed" ref={feedRef}>
                {margin.length === 0 ? (
                  <p className="placeholder">
                    Margin notes — yours and AI's, loosely pegged to the tape.
                  </p>
                ) : (
                  margin.map((c) => (
                    <div key={c.id} className={`margin-entry ${c.author}`}>
                      <span className="margin-meta">
                        <span className={`author ${c.author}`}>
                          {c.author === "human" ? "you" : "AI"}
                        </span>
                        {c.atSec !== null && (
                          <span className="margin-time">≈ {fmtStamp(c.atSec)}</span>
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
                      ? `pegged @ ${fmtStamp(elapsed)} — enter`
                      : "add a margin note…"
                  }
                />
              </div>
            </div>
          </div>
        </section>

        {(error || asrError) && (
          <div className="error-banner">{error ?? asrError}</div>
        )}
      </main>
    </div>
  );
}