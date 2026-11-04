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

interface EngineInfo {
  engine: string;
  label: string;
}

// A user note block: committed with Enter, injected into the stream at the
// point the user started typing relative to the recording.
interface NoteBlock {
  id?: string;
  startSec: number | null;
  endSec?: number | null;
  text: string;
  selectionRef?: string | null;
}

interface MarginEntry {
  id?: string;
  createdAt?: string;
  kind: "comment" | "chat";
  author: "human" | "ai" | "human->ai";
  atSec: number | null;
  noteContext?: string | null;
  text: string;
  selection?: string;
  question?: string;
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

// AI typing-trigger debounce: fire once the user pauses after typing enough.
const AI_TRIGGER_IDLE_MS = 6000;
const AI_TRIGGER_MIN_CHARS = 40;
// Human margin-comment idle (seconds of transcript to include in AI context).
const AI_CONTEXT_WINDOW_SEC = 60;

export default function App() {
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(-90);
  const [lastSession, setLastSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The pad: one time-ordered stream of transcript segments + note blocks.
  const [noteBlocks, setNoteBlocks] = useState<NoteBlock[]>([]);
  const [composeDraft, setComposeDraft] = useState("");
  const composeStartRef = useRef<number | null>(null);
  const noteBlocksRef = useRef<NoteBlock[]>([]);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [asrError, setAsrError] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineInfo | null>(null);

  // Margin.
  const [margin, setMargin] = useState<MarginEntry[]>([]);
  const [marginDraft, setMarginDraft] = useState("");
  const [aiThinking, setAiThinking] = useState(false);

  // Selection chat state.
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const [selectionOrigin, setSelectionOrigin] = useState<null | "transcript" | "notes">(null);
  const [chatDraft, setChatDraft] = useState("");

  // AI typing-trigger bookkeeping.
  const lastNoteEdit = useRef(0);
  const charsSinceAi = useRef(0);
  const aiPending = useRef(false);
  const lastAiAt = useRef(0);
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const streamRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const recordingRef = useRef(false);
  const sessionDirRef = useRef<string | null>(null);
  const elapsedRef = useRef(0);
  const notesRef = useRef("");

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);
  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);
  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);
  useEffect(() => {
    notesRef.current = composeDraft;
  }, [composeDraft]);

  useEffect(() => {
    noteBlocksRef.current = noteBlocks;
  }, [noteBlocks]);

  useEffect(() => {
    backend()
      .then((b) => b.invoke<OllamaStatus>("ollama_status"))
      .then(setOllama)
      .catch(() =>
        setOllama({ local_online: false, local_version: null, cloud_online: false }),
      );
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubs: Array<() => void> = [];

    backend().then((b) => {
      if (cancelled) return;
      const subs = [
        b.listen<LevelEvent>("capture:level", (e) => {
          setElapsed(e.elapsed_sec);
          setLevel(e.rms_dbfs);
        }),
        b.listen<StoppedEvent>("capture:stopped", (e) => {
          setRecording(false);
          setElapsed(e.duration_sec);
          setLastSession(e.session_dir);
          sessionDirRef.current = null;
        }),
        b.listen<TranscriptSegment>("transcript:segment", (seg) => {
          setSegments((prev) => [...prev, seg]);
        }),
        b.listen<{ message: string }>("transcript:error", (e) => {
          setAsrError(e.message);
        }),
        b.listen<EngineInfo>("transcript:engine", (info) => {
          setEngine(info);
        }),
      ];
      Promise.all(subs).then((fns) => {
        if (cancelled) fns.forEach((un) => un());
        else unsubs = fns;
      });
    });

    return () => {
      cancelled = true;
      unsubs.forEach((un) => un());
    };
  }, []);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [segments]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [margin, aiThinking]);

  // ---- AI margin trigger: typing pauses during capture ----
  useEffect(() => {
    const iv = setInterval(() => {
      if (
        !recordingRef.current ||
        aiPending.current ||
        sessionDirRef.current === null ||
        Date.now() - lastNoteEdit.current < AI_TRIGGER_IDLE_MS ||
        charsSinceAi.current < AI_TRIGGER_MIN_CHARS ||
        Date.now() - lastAiAt.current < 15000
      ) {
        return;
      }
      const atSec = elapsedRef.current;
      const noteBlock = composeDraft.trim() || lastNoteBlock(notesRef.current);
      const transcriptWindow = transcriptWindowText(segmentsRef.current, atSec);
      const sessionDir = sessionDirRef.current;
      const typed = charsSinceAi.current;
      charsSinceAi.current = 0;
      aiPending.current = true;
      lastAiAt.current = Date.now();
      setAiThinking(true);
      backend()
        .then((b) =>
          b.invoke<MarginEntry | null>("ai_margin_comment", {
            atSec,
            noteBlock,
            transcriptWindow,
            sessionDir,
          }),
        )
        .then((entry) => {
          if (entry) setMargin((m) => [...m, entry]);
        })
        .catch(() => {})
        .finally(() => {
          aiPending.current = false;
          setAiThinking(false);
        });
      // typed is consumed above via charsSinceAi reset
      void typed;
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  // ---- selection: context around the selection + its tape anchor ----
  function selectionContext(origin: "transcript" | "notes", selection: string): { context: string; atSec: number | null } {
    const segs = segmentsRef.current;
    const probe = selection.slice(0, 40);
    const idx = segs.findIndex((s) => s.text.includes(probe) || probe.includes(s.text.slice(0, 40)));
    if (origin === "transcript") {
      if (idx >= 0) {
        const around = segs
          .slice(Math.max(0, idx - 3), idx + 4)
          .map((s) => `[${fmtStamp(s.start)}] ${s.text}`)
          .join("\n");
        return { context: around, atSec: segs[idx].start };
      }
    }
    const blocks = noteBlocksRef.current.map(
      (b) => `[${b.startSec !== null ? fmtStamp(b.startSec) : "—"}] ${b.text}`,
    );
    const notesCtx = blocks.slice(-6).join("\n");
    const transCtx = segs
      .slice(Math.max(0, (idx >= 0 ? idx : segs.length) - 4), (idx >= 0 ? idx : segs.length - 1) + 3)
      .map((s) => `[${fmtStamp(s.start)}] ${s.text}`)
      .join("\n");
    return { context: `${notesCtx}\n${transCtx}`, atSec: idx >= 0 ? segs[idx].start : null };
  }

  useEffect(() => {
    function onMouseUp() {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";
      if (text.length < 12 || !sel || sel.rangeCount === 0) {
        setPendingSelection(null);
        return;
      }
      const anchor = sel.anchorNode;
      if (!anchor) return;
      const inTranscript = !!(anchor.parentElement?.closest?.(".stream"));
      const inNotes = !!(anchor.parentElement?.closest?.(".composer"));
      if (!inTranscript && !inNotes) {
        setPendingSelection(null);
        return;
      }
      setPendingSelection(text);
      setSelectionOrigin(inTranscript ? "transcript" : "notes");
    }
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, []);

  async function sendSelectionChat() {
    if (!pendingSelection || !chatDraft.trim()) return;
    const b = await backend();
    const sessionDir =
      sessionDirRef.current || (lastSession ?? "") || sessionDirPlaceholder();
    const question = chatDraft.trim();
    const selection = pendingSelection;
    const { context, atSec: selectionAt } = selectionContext(
      selectionOrigin ?? "transcript",
      selection,
    );
    const atSec = recording ? elapsed : selectionAt;
    setChatDraft("");
    setPendingSelection(null);
    setAiThinking(true);
    try {
      const entry = await b.invoke<MarginEntry>("ai_selection_chat", {
        selection,
        question,
        atSec,
        context,
        sessionDir,
      });
      if (entry) setMargin((m) => [...m, entry]);
    } finally {
      setAiThinking(false);
    }
  }

  // Add the user's OWN note about the selection: a note block carrying the
  // selection as its reference, anchored to the selection's tape position.
  async function addSelectionNote() {
    if (!pendingSelection || !chatDraft.trim()) return;
    const text = chatDraft.trim();
    const selection = pendingSelection;
    const { atSec: selectionAt } = selectionContext(
      selectionOrigin ?? "transcript",
      selection,
    );
    const startSec = recording ? elapsed : selectionAt;
    setChatDraft("");
    setPendingSelection(null);
    setNoteBlocks((nb) => [...nb, { startSec, text, selectionRef: selection }]);
    try {
      const b = await backend();
      await b.invoke("note_add", {
        sessionDir: sessionDirRef.current || lastSession || "",
        startSec,
        endSec: startSec,
        text,
        selectionRef: selection,
      });
    } catch {}
  }

  async function toggleRecord() {
    setError(null);
    setAsrError(null);
    try {
      const b = await backend();
      if (!recording) {
        const dir = await b.invoke<string>("capture_start", { notebook: "Inbox" });
        sessionDirRef.current = dir;
        setRecording(true);
        setElapsed(0);
        setSegments([]);
        setLastSession(null);
        charsSinceAi.current = 0;
      } else {
        await b.invoke("capture_stop");
      }
    } catch (e) {
      setError(String(e));
      setRecording(false);
    }
  }

  // Composer: Enter commits the note as a block injected into the stream at
  // the point typing began; Shift+Enter inserts a line break.
  function onComposeChange(text: string) {
    if (recording && composeStartRef.current === null && composeDraft === "" && text) {
      composeStartRef.current = elapsedRef.current;
    }
    setComposeDraft(text);
    if (recording) {
      lastNoteEdit.current = Date.now();
      charsSinceAi.current += Math.max(1, text.length - notesRef.current.length);
    }
  }

  async function commitCompose() {
    const text = composeDraft.trim();
    if (!text) return;
    const startSec = recording ? (composeStartRef.current ?? elapsedRef.current) : null;
    setComposeDraft("");
    composeStartRef.current = null;
    setNoteBlocks((nb) => [...nb, { startSec, text }]);
    try {
      const b = await backend();
      await b.invoke("note_add", {
        sessionDir: sessionDirRef.current || lastSession || "",
        startSec,
        endSec: startSec !== null ? elapsedRef.current : null,
        text,
      });
    } catch {}
  }

  function onComposeKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commitCompose();
    }
  }

  async function addMarginComment() {
    const text = marginDraft.trim();
    if (!text) return;
    const atSec = recording ? elapsed : null;
    const noteContext = recording ? lastNoteBlock(notesRef.current) : null;
    setMarginDraft("");
    setMargin((m) => [
      ...m,
      {
        kind: "comment",
        author: "human",
        atSec,
        noteContext,
        text,
      },
    ]);
    const b = await backend();
    b.invoke("margin_add", {
      sessionDir: sessionDirRef.current || lastSession || "",
      atSec,
      noteContext,
      text,
    }).catch(() => {});
  }

  // The stream: transcript segments + note blocks, ordered by tape position.
  // Notes without an anchor (written outside a capture) go last.
  function mergedStream() {
    const items = [
      ...segments.map((s) => ({ type: "seg" as const, ...s })),
      ...noteBlocks.map((n) => ({
        type: "note" as const,
        start: n.startSec ?? Infinity,
        startSec: n.startSec,
        text: n.text,
        selectionRef: n.selectionRef,
      })),
    ];
    items.sort((a, b) => a.start - b.start);
    return items;
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
          {engine && <p className="engine-line">asr: {engine.label}</p>}
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
          <div className="pad-columns">
            <div className="pad-col notes-col">
              <div className="transcript stream" ref={streamRef}>
                {mergedStream().map((item, i) =>
                  item.type === "note" ? (
                    <div key={`n${i}`} className="note-block">
                      <span className="note-block-stamp">
                        ✎ {item.startSec !== null ? fmtStamp(item.startSec) : "now"}
                      </span>
                      {item.selectionRef && (
                        <p className="note-ref">re: “{clip(item.selectionRef, 110)}”</p>
                      )}
                      <p className="note-block-text">{item.text}</p>
                    </div>
                  ) : (
                    <p key={item.id} className="segment">
                      <span className="segment-stamp">{fmtStamp(item.start)}</span>
                      {item.text}
                    </p>
                  ),
                )}
                {segments.length === 0 && noteBlocks.length === 0 && (
                  <p className="placeholder">
                    {recording
                      ? "listening… speech is transcribed here; type below and hit Enter to pin your note to this point on the tape."
                      : "press Record — the pad fills with a live transcript as you listen."}
                  </p>
                )}
              </div>
              <textarea
                className="notes-input composer"
                value={composeDraft}
                onChange={(e) => onComposeChange(e.target.value)}
                onKeyDown={onComposeKeyDown}
                placeholder={
                  recording
                    ? `write a note — Enter pins it at ${fmtStamp(elapsed)} on the tape (Shift+Enter for a new line)`
                    : "write a note and hit Enter (Shift+Enter for a new line)"
                }
              />
            </div>

            <div className="pad-col margin-col">
              <div className="margin-feed" ref={feedRef}>
                {margin.length === 0 && !aiThinking && (
                  <p className="placeholder">
                    The margin is quiet unless you are: type notes while
                    recording for AI comments pegged to your note and the
                    tape, or select any passage to chat with the AI about it.
                  </p>
                )}
                {margin.map((m, i) =>
                  m.kind === "chat" ? (
                    <div key={m.id ?? i} className="margin-entry chat">
                      <span className="margin-meta">
                        <span className="author ai">selection chat</span>
                        {m.atSec !== null && <span className="margin-time">≈ {fmtStamp(m.atSec)}</span>}
                      </span>
                      <p className="chat-selection">“{clip(m.selection, 140)}”</p>
                      <p className="chat-question">{m.question}</p>
                      <p className="margin-text">{m.text}</p>
                    </div>
                  ) : (
                    <div key={m.id ?? i} className={`margin-entry ${m.author === "ai" ? "ai" : "human"}`}>
                      <span className="margin-meta">
                        <span className={`author ${m.author}`}>
                          {m.author === "ai" ? "AI" : "you"}
                        </span>
                        {m.atSec !== null && (
                          <span className="margin-time">≈ {fmtStamp(m.atSec)}</span>
                        )}
                      </span>
                      {m.noteContext && (
                        <p className="note-quote">re: “{clip(m.noteContext, 90)}”</p>
                      )}
                      <p className="margin-text">{m.text}</p>
                    </div>
                  ),
                )}
                {aiThinking && <p className="ai-thinking">AI is writing…</p>}
              </div>

              {pendingSelection && (
                <div className="chat-box">
                  <p className="chat-box-src">{selectionOrigin} selection:</p>
                  <p className="chat-box-quote">“{clip(pendingSelection, 160)}”</p>
                  <input
                    autoFocus
                    value={chatDraft}
                    onChange={(e) => setChatDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && sendSelectionChat()}
                    placeholder="ask the AI about this passage…"
                  />
                  <div className="chat-box-actions">
                    <button onClick={sendSelectionChat}>Ask AI</button>
                    <button className="note" onClick={addSelectionNote}>
                      Add note
                    </button>
                    <button className="ghost" onClick={() => setPendingSelection(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="margin-input">
                <input
                  value={marginDraft}
                  onChange={(e) => setMarginDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addMarginComment()}
                  placeholder={
                    recording
                      ? `margin note @ ${fmtStamp(elapsed)} — enter`
                      : "add a margin note…"
                  }
                />
              </div>
            </div>
          </div>
        </section>

        {(error || asrError) && <div className="error-banner">{error ?? asrError}</div>}
      </main>
    </div>
  );
}

// ---- helpers ----

function lastNoteBlock(notes: string): string {
  const blocks = notes.split(/\n\s*\n/).filter(Boolean);
  return (blocks[blocks.length - 1] || notes).trim();
}

function transcriptWindowText(segments: TranscriptSegment[], atSec: number): string {
  const from = Math.max(0, atSec - AI_CONTEXT_WINDOW_SEC);
  return segments
    .filter((s) => s.end >= from)
    .map((s) => s.text)
    .join(" ")
    .slice(-1500);
}

function sessionDirPlaceholder(): string {
  return "notebooks/Inbox/sessions/unsaved";
}

function clip(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}