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

// A transcript segment — datetime-stamped on the wall clock.
interface TranscriptSegment {
  id: string;
  at: string;
  text: string;
}

interface EngineInfo {
  engine: string;
  label: string;
}

// A user note block: always editable, optionally about a selection.
interface NoteBlock {
  id: string;
  at: string;
  text: string;
  tags: string[];
  selectionRef?: string | null;
  image?: string | null;
}

// A burst bar: a new recording resumes the timeline here.
interface BurstBar {
  id: string;
  at: string;
  index: number;
}

interface MarginEntry {
  id?: string;
  createdAt?: string;
  kind: "comment" | "chat";
  author: "human" | "ai" | "human->ai";
  at?: string;
  atSec: number | null;
  noteContext?: string | null;
  text: string;
  selection?: string;
  question?: string;
}

// ---- formatting -----------------------------------------------------------

function fmtDT(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function fmtDTLong(iso: string): string {
  const d = new Date(iso);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()} ${fmtDT(iso)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// AI typing-trigger debounce: fire once the user pauses after typing enough.
const AI_TRIGGER_IDLE_MS = 6000;
const AI_TRIGGER_MIN_CHARS = 40;

export default function App() {
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [wallClock, setWallClock] = useState(fmtDT(nowIso()));
  const [level, setLevel] = useState(-90);
  const [lastSession, setLastSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [asrError, setAsrError] = useState<string | null>(null);

  // The timeline: segments + note blocks + burst bars, ordered by datetime.
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [noteBlocks, setNoteBlocks] = useState<NoteBlock[]>([]);
  const [bursts, setBursts] = useState<BurstBar[]>([]);
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [summarizing, setSummarizing] = useState<string | null>(null);

  // Composer.
  const [composeDraft, setComposeDraft] = useState("");
  const [editingNote, setEditingNote] = useState<{ id: string; draft: string } | null>(null);

  // Margin.
  const [margin, setMargin] = useState<MarginEntry[]>([]);
  const [aiThinking, setAiThinking] = useState(false);

  // Custom flags on selections (right-side review desk).
  const [flagDraft, setFlagDraft] = useState("");
  const [flagging, setFlagging] = useState(false);
  const [knownFlags, setKnownFlags] = useState<string[]>([]);
  const [flags, setFlags] = useState<{ id: string; flag: string; selection: string; at: string }[]>([]);

  // Selection chat.
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const [selectionOrigin, setSelectionOrigin] = useState<null | "transcript" | "notes">(null);
  const [chatDraft, setChatDraft] = useState("");
  const [chatAnchorY, setChatAnchorY] = useState(0);

  // Refs.
  const nextId = useRef(1);
  const streamRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const noteBlocksRef = useRef<NoteBlock[]>([]);
  const burstsRef = useRef<BurstBar[]>([]);
  const recordingRef = useRef(false);
  const sessionDirRef = useRef<string | null>(null);
  const lastAiAt = useRef(0);
  const lastNoteEdit = useRef(0);
  const charsSinceAi = useRef(0);
  const aiPending = useRef(false);
  const composeDraftRef = useRef("");
  const lastStopAtRef = useRef<string | null>(null);

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);
  useEffect(() => {
    noteBlocksRef.current = noteBlocks;
  }, [noteBlocks]);
  useEffect(() => {
    burstsRef.current = bursts;
  }, [bursts]);
  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);
  useEffect(() => {
    composeDraftRef.current = composeDraft;
  }, [composeDraft]);

  // Wall clock tick.
  useEffect(() => {
    const iv = setInterval(() => setWallClock(fmtDT(nowIso())), 1000);
    return () => clearInterval(iv);
  }, []);

  // Backend wiring.
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
        b.listen<LevelEvent>("capture:level", (e) => setLevel(e.rms_dbfs)),
        b.listen<StoppedEvent>("capture:stopped", (e) => {
          setRecording(false);
          setLastSession(e.session_dir);
          lastStopAtRef.current = nowIso();
        }),
        b.listen<TranscriptSegment>("transcript:segment", (seg) => {
          setSegments((prev) => [...prev, seg]);
        }),
        b.listen<{ message: string }>("transcript:error", (e) => setAsrError(e.message)),
        b.listen<EngineInfo>("transcript:engine", (info) => setEngine(info)),
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

  // AI margin trigger: typing pause during capture.
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
      charsSinceAi.current = 0;
      aiPending.current = true;
      lastAiAt.current = Date.now();
      setAiThinking(true);
      backend()
        .then((b) =>
          b.invoke<MarginEntry | null>("ai_margin_comment", {
            at: nowIso(),
            noteBlock: composeDraftRef.current.trim(),
            transcriptWindow: segmentsRef.current
              .slice(-8)
              .map((s) => s.text)
              .join(" ")
              .slice(-1500),
            sessionDir: sessionDirRef.current,
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
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [margin, aiThinking]);

  // Selection → chat box (or own note), aligned inline with the selected area.
  useEffect(() => {
    function onMouseUp(ev: MouseEvent) {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";
      if (text.length < 12 || !sel || sel.rangeCount === 0) {
        setPendingSelection(null);
        return;
      }
      const anchor = sel.anchorNode;
      const node = anchor?.parentElement;
      if (!node) return;
      const inStream = !!(node.closest?.(".stream") || node.closest?.(".segment") || node.closest?.(".note-block"));
      const inComposer = !!(node.closest?.(".composer"));
      if (!inStream && !inComposer) {
        setPendingSelection(null);
        return;
      }
      setPendingSelection(text);
      setSelectionOrigin(inComposer ? "notes" : "transcript");
      // keep the chat box inline with the selection's vertical position
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const col = document.querySelector(".margin-col")?.getBoundingClientRect();
      const y = col ? Math.max(col.top + 10, Math.min(rect.top - 10, col.bottom - 210)) : ev.clientY;
      setChatAnchorY(col ? y - col.top : 100);
    }
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, []);

  // ---- timeline actions ----------------------------------------------------

  async function toggleRecord() {
    setError(null);
    setAsrError(null);
    try {
      const b = await backend();
      if (!recording) {
        const info = await b.invoke<{ sessionDir: string; burstIndex: number; resumed: boolean; at: string }>(
          "capture_start",
          { notebook: "Inbox" },
        );
        sessionDirRef.current = info.sessionDir;
        setLastSession(info.sessionDir);
        setRecording(true);
        charsSinceAi.current = 0;
        // Notes typed prior to this recording start a new entry: the burst
        // bar goes above them so they open the new section.
        const since = lastStopAtRef.current;
        const pending = since
          ? noteBlocksRef.current.filter((nb) => nb.at > (since as string))
          : [];
        const barAt = pending.length ? pending[0].at : info.at;
        setBursts((bu) => [...bu, { id: `burst-${nextId.current++}`, at: barAt, index: info.burstIndex }]);
      } else {
        await b.invoke("capture_stop");
      }
    } catch (e) {
      setError(String(e));
      setRecording(false);
    }
  }

  async function commitCompose() {
    const text = composeDraft.trim();
    if (!text) return;
    const at = nowIso();
    const tags = (text.match(/#[\w-]+/g) || []).map((t) => t.slice(1));
    const id = `note-${nextId.current++}`;
    setComposeDraft("");
    const block: NoteBlock = { id, at, text, tags };
    setNoteBlocks((nb) => [...nb, block]);
    try {
      const b = await backend();
      await b.invoke("note_add", {
        sessionDir: sessionDirRef.current || lastSession || "",
        at,
        text,
        tags,
      });
    } catch {}
  }

  function onComposeKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commitCompose();
    }
  }

  function onComposeChange(text: string) {
    setComposeDraft(text);
    if (recording) {
      lastNoteEdit.current = Date.now();
      charsSinceAi.current += Math.max(1, text.length - composeDraftRef.current.length);
    }
  }

  // Paste images into the composer → attachment note block.
  async function onComposePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    const file = item.getAsFile();
    if (!file || !sessionDirRef.current) return;
    const dataUrl = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.readAsDataURL(file);
    });
    try {
      const b = await backend();
      const rel = await b.invoke<string>("attachment_add", {
        sessionDir: sessionDirRef.current,
        dataUrl,
      });
      const at = nowIso();
      const block: NoteBlock = {
        id: `note-${nextId.current++}`,
        at,
        text: "",
        tags: [],
        image: dataUrl,
      };
      setNoteBlocks((nb) => [...nb, block]);
      await b.invoke("note_add", {
        sessionDir: sessionDirRef.current,
        at,
        text: "",
        tags: [],
        image: rel,
      });
    } catch {}
  }

  async function saveNoteEdit(id: string) {
    const draft = editingNote?.draft ?? "";
    const clean = draft.trim();
    setEditingNote(null);
    setNoteBlocks((nb) => nb.map((n) => (n.id === id ? { ...n, text: clean } : n)));
    try {
      const b = await backend();
      await b.invoke("note_edit", {
        sessionDir: sessionDirRef.current || lastSession || "",
        id,
        at: nowIso(),
        text: clean,
      });
    } catch {}
  }

  async function summarizeEntry(refId: string, text: string) {
    if (summarizing) return;
    setSummarizing(refId);
    try {
      const b = await backend();
      const summary = await b.invoke<string | null>("ai_entry_summary", {
        text,
        neighbors: neighborsOf(refId),
      });
      if (summary) {
        setSummaries((s) => ({ ...s, [refId]: summary }));
        b.invoke("entry_summary_add", {
          sessionDir: sessionDirRef.current || lastSession || "",
          refId,
          at: nowIso(),
          text: summary,
        }).catch(() => {});
      }
    } finally {
      setSummarizing(null);
    }
  }

  function neighborsOf(refId: string): string[] {
    const all = timeline();
    const idx = all.findIndex((x) => x.id === refId);
    return all
      .slice(Math.max(0, idx - 2), idx + 3)
      .map((x) => ("text" in x ? x.text : ""))
      .filter(Boolean);
  }

  // ---- selection actions ---------------------------------------------------

  function selectionContext(origin: "transcript" | "notes", selection: string): { context: string; at: string | null; refId: string | null } {
    const segs = segmentsRef.current;
    const probe = selection.slice(0, 40);
    const idx = segs.findIndex((s) => s.text.includes(probe) || probe.includes(s.text.slice(0, 40)));
    if (origin === "transcript" && idx >= 0) {
      const around = segs
        .slice(Math.max(0, idx - 3), idx + 4)
        .map((s) => `[${fmtDT(s.at)}] ${s.text}`)
        .join("\n");
      return { context: around, at: segs[idx].at, refId: segs[idx].id };
    }
    const blocks = noteBlocksRef.current.map((b) => `[${fmtDT(b.at)}] ${b.text}`);
    const transCtx = segs
      .slice(Math.max(0, (idx >= 0 ? idx : segs.length) - 4), (idx >= 0 ? idx : segs.length - 1) + 3)
      .map((s) => `[${fmtDT(s.at)}] ${s.text}`)
      .join("\n");
    return { context: `${blocks.slice(-6).join("\n")}\n${transCtx}`, at: idx >= 0 ? segs[idx].at : null, refId: idx >= 0 ? segs[idx].id : null };
  }

  async function sendSelectionChat() {
    if (!pendingSelection || !chatDraft.trim()) return;
    const b = await backend();
    const sessionDir = sessionDirRef.current || lastSession || "notebooks/Inbox/sessions/unsaved";
    const question = chatDraft.trim();
    const selection = pendingSelection;
    const { context } = selectionContext(selectionOrigin ?? "transcript", selection);
    const at = nowIso();
    setChatDraft("");
    setPendingSelection(null);
    setAiThinking(true);
    try {
      const entry = await b.invoke<MarginEntry>("ai_selection_chat", {
        selection,
        question,
        at,
        atSec: null,
        context,
        sessionDir,
      });
      if (entry) setMargin((m) => [...m, entry]);
    } finally {
      setAiThinking(false);
    }
  }

  // Custom flag on the selection: name it, it lands in the margin + rail.
  async function addSelectionFlag() {
    if (!pendingSelection || !flagDraft.trim()) return;
    const flag = flagDraft.trim().replace(/^#/, "");
    const selection = pendingSelection;
    const at = nowIso();
    setFlagDraft("");
    setFlagging(false);
    setPendingSelection(null);
    const id = `flag-${nextId.current++}`;
    setFlags((f) => [...f, { id, flag, selection, at }]);
    setKnownFlags((k) => (k.includes(flag) ? k : [...k, flag]));
    try {
      const b = await backend();
      await b.invoke("flag_add", {
        sessionDir: sessionDirRef.current || lastSession || "",
        flag,
        selection,
        at,
      });
    } catch {}
  }

  // AI summary of the selected entry, appended to that entry as a block.
  async function summarizeSelection() {
    if (!pendingSelection) return;
    const { refId } = selectionContext(selectionOrigin ?? "transcript", pendingSelection);
    if (!refId) return;
    setPendingSelection(null);
    await summarizeEntry(refId, pendingSelection);
  }

  async function addSelectionNote() {
    if (!pendingSelection || !chatDraft.trim()) return;
    const text = chatDraft.trim();
    const selection = pendingSelection;
    const at = nowIso();
    setChatDraft("");
    setPendingSelection(null);
    const id = `note-${nextId.current++}`;
    const tags = (text.match(/#[\w-]+/g) || []).map((t) => t.slice(1));
    setNoteBlocks((nb) => [...nb, { id, at, text, tags, selectionRef: selection }]);
    try {
      const b = await backend();
      await b.invoke("note_add", {
        sessionDir: sessionDirRef.current || lastSession || "",
        at,
        text,
        tags,
        selectionRef: selection,
      });
    } catch {}
  }

  // ---- the timeline --------------------------------------------------------

  type Entry =
    | { type: "seg"; id: string; at: string; text: string }
    | { type: "note"; id: string; at: string; text: string; tags: string[]; selectionRef?: string | null; image?: string | null }
    | { type: "burst"; id: string; at: string; index: number };

  function timeline(): Entry[] {
    const items: Entry[] = [
      ...segments.map((s) => ({ type: "seg" as const, id: s.id, at: s.at, text: s.text })),
      ...noteBlocks.map((n) => ({
        type: "note" as const,
        id: n.id,
        at: n.at,
        text: n.text,
        tags: n.tags,
        selectionRef: n.selectionRef,
        image: n.image,
      })),
      ...bursts.map((bu) => ({ type: "burst" as const, id: bu.id, at: bu.at, index: bu.index })),
    ];
    const prio: Record<string, number> = { burst: 0, seg: 1, note: 2 };
    items.sort((a, b) => a.at.localeCompare(b.at) || prio[a.type] - prio[b.type]);
    return items;
  }

  const statusOk = (ollama?.local_online || ollama?.cloud_online) ?? false;
  const levelPct = Math.max(0, Math.min(100, ((level + 60) / 60) * 100));
  const tl = timeline();

  // Fast-scroll markers: bursts, notes, reactions, summaries.
  const markers = tl
    .filter((x) => x.type === "burst" || (x.type === "note" && (x.text || x.image)) || (x.type === "seg" && summaries[x.id]))
    .map((x) => ({
      id: x.id,
      type: x.type,
      at: x.at,
      label:
        x.type === "burst"
          ? "— recording resumed"
          : x.type === "note"
            ? (x as Extract<Entry, { type: "note" }>).selectionRef
              ? `✎ re: ${clip((x as Extract<Entry, { type: "note" }>).selectionRef, 60)}`
              : `✎ ${clip(x.text, 60) || "image"}`
            : `≡ ${clip(summaries[x.id], 60)}`,
    }));

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
        <button className="drawer-new" disabled title="coming in #28">+ New notebook</button>
        <div className="drawer-foot">
          <div className={`status-chip ${statusOk ? "ok" : "down"}`}>
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
            <p className="last-session" title={lastSession}>last: {lastSession.split("/").pop()}</p>
          )}
        </div>
      </aside>

      <div className={`drawer-scrim ${drawerOpen ? "show" : ""}`} onClick={() => setDrawerOpen(false)} />

      <main className="desk-main">
        <header className="pad-header">
          <button className="icon-btn" onClick={() => setDrawerOpen(!drawerOpen)}>☰</button>
          <button className={`record-btn ${recording ? "recording" : ""}`} onClick={toggleRecord}>
            {recording ? "■ Stop" : "● Record"}
          </button>
          <span className="session-clock">{wallClock}</span>
          <span className="header-title">{recording ? "on the record" : "timeline open — recording paused is ignored"}</span>
          <div className="level-meter" aria-hidden>
            <div className="level-bar" style={{ width: `${levelPct}%` }} />
          </div>
        </header>

        <section className="pad">
          <div className="pad-columns">
            <div className="pad-col notes-col">
              <div className="stream-wrap">
                <div className="stream" ref={streamRef}>
                  {tl.map((item) =>
                    item.type === "burst" ? (
                      <div key={item.id} className="burst-bar" id={`entry-${item.id}`}>
                        <span>— {item.index === 1 ? "recording started" : `recording #${item.index} resumed`} · {fmtDTLong(item.at)} —</span>
                      </div>
                    ) : item.type === "seg" ? (
                      <div key={item.id} className="entry" id={`entry-${item.id}`}>
                        <p className="segment">
                          <span className="segment-stamp">{fmtDT(item.at)}</span>
                          {item.text}
                        </p>
                        {summaries[item.id] && (
                          <p className="entry-summary">≡ {summaries[item.id]}</p>
                        )}
                      </div>
                    ) : (
                      <div key={item.id} className="note-block" id={`entry-${item.id}`}>
                        <span className="note-block-stamp">✎ {fmtDT(item.at)}</span>
                        {item.selectionRef && (
                          <p className="note-ref">re: “{clip(item.selectionRef, 110)}”</p>
                        )}
                        {editingNote?.id === item.id ? (
                          <textarea
                            className="note-edit"
                            autoFocus
                            value={editingNote.draft}
                            onChange={(e) => setEditingNote({ id: item.id, draft: e.target.value })}
                            onBlur={() => saveNoteEdit(item.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                saveNoteEdit(item.id);
                              }
                            }}
                          />
                        ) : (
                          <>
                            {item.image && (
                              <img className="note-image" src={item.image} alt="note attachment" />
                            )}
                            {item.text && (
                              <p
                                className="note-block-text"
                                onClick={() => setEditingNote({ id: item.id, draft: item.text })}
                                title="click to edit"
                              >
                                <RichText text={item.text.replace(/#[\w-]+/g, "").trim()} />
                              </p>
                            )}
                            {item.tags.length > 0 && (
                              <p className="note-tags">
                                {item.tags.map((t) => <span key={t} className="tag">#{t}</span>)}
                              </p>
                            )}
                          </>
                        )}
                        {summaries[item.id] && <p className="entry-summary">≡ {summaries[item.id]}</p>}
                      </div>
                    ),
                  )}
                  {tl.length === 0 && (
                    <p className="placeholder">
                      The timeline unfolds here — press Record, or just type a note and hit Enter.
                    </p>
                  )}
                </div>
                <div className="rail" aria-label="fast scroll markers">
                  {markers.map((m) => (
                    <div
                      key={m.id}
                      className={`rail-marker ${m.type}`}
                      title={`${fmtDTLong(m.at)}  ${m.label}`}
                      onClick={() =>
                        document.getElementById(`entry-${m.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
                      }
                    >
                      {m.type === "burst" ? "▬" : m.type === "note" ? "✎" : m.label.slice(0, 2)}
                    </div>
                  ))}
                </div>
              </div>
              <textarea
                className="notes-input composer"
                value={composeDraft}
                onChange={(e) => onComposeChange(e.target.value)}
                onKeyDown={onComposeKeyDown}
                onPaste={onComposePaste}
                placeholder="write a note — Enter adds it to the timeline · paste images · #tags · links"
              />
            </div>

            <div className="pad-col margin-col">
              <div className="margin-feed" ref={feedRef}>
                {flags.length > 0 && (
                  <div className="flag-strip">
                    {flags.map((f) => (
                      <span key={f.id} className="flag-chip" title={`${fmtDT(f.at)} — “${clip(f.selection, 80)}”`}>
                        ⚑ {f.flag}
                      </span>
                    ))}
                  </div>
                )}
                {margin.length === 0 && flags.length === 0 && !aiThinking && (
                  <p className="placeholder">
                    The margin edits the timeline: select any passage to flag it,
                    chat with the AI, or add your own note about it. Type in the
                    pad while recording for live AI margin comments.
                  </p>
                )}
                {margin.map((m, i) =>
                  m.kind === "chat" ? (
                    <div key={m.id ?? i} className="margin-entry chat">
                      <span className="margin-meta">
                        <span className="author ai">chat</span>
                        <span className="margin-time">{m.at ? fmtDT(m.at) : ""}</span>
                      </span>
                      <p className="chat-selection">“{clip(m.selection, 140)}”</p>
                      <p className="chat-question">{m.question}</p>
                      <p className="margin-text">{m.text}</p>
                    </div>
                  ) : (
                    <div key={m.id ?? i} className={`margin-entry ${m.author === "ai" ? "ai" : "human"}`}>
                      <span className="margin-meta">
                        <span className={`author ${m.author}`}>{m.author === "ai" ? "AI" : "you"}</span>
                        <span className="margin-time">{m.at ? fmtDT(m.at) : ""}</span>
                      </span>
                      {m.noteContext && <p className="note-quote">re: “{clip(m.noteContext, 90)}”</p>}
                      <p className="margin-text"><RichText text={m.text} /></p>
                    </div>
                  ),
                )}
                {aiThinking && <p className="ai-thinking">AI is writing…</p>}
              </div>

              {pendingSelection && (
                <div className="chat-box" style={{ top: chatAnchorY }}>
                  <p className="chat-box-src">{selectionOrigin === "notes" ? "notes" : "transcript"} selection:</p>
                  <p className="chat-box-quote">“{clip(pendingSelection, 160)}”</p>
                  <input
                    autoFocus
                    value={chatDraft}
                    onChange={(e) => setChatDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && sendSelectionChat()}
                    placeholder="ask the AI, or write your own note about this…"
                  />
                  {flagging && (
                    <div className="flag-row">
                      <input
                        autoFocus
                        list="known-flags"
                        value={flagDraft}
                        onChange={(e) => setFlagDraft(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && addSelectionFlag()}
                        placeholder="flag name, e.g. important / verify / todo…"
                      />
                      <datalist id="known-flags">
                        {knownFlags.map((f) => <option key={f} value={f} />)}
                      </datalist>
                    </div>
                  )}
                  <div className="chat-box-actions">
                    <button onClick={sendSelectionChat}>Ask AI</button>
                    <button className="note" onClick={addSelectionNote}>Add note</button>
                    {!flagging ? (
                      <button className="flag" onClick={() => setFlagging(true)}>⚑ Flag</button>
                    ) : (
                      <button className="flag" onClick={addSelectionFlag}>⚑ Set flag</button>
                    )}
                    <button onClick={summarizeSelection} title="AI summary appended to this entry">≡ Summary</button>
                    <button className="ghost" onClick={() => { setPendingSelection(null); setFlagging(false); }}>✕</button>
                  </div>
                </div>
              )}

              <ReviewNotes
                sessionDir={() => sessionDirRef.current || lastSession || ""}
                onSaved={setKnownFlags}
              />
            </div>
          </div>
        </section>

        {(error || asrError) && <div className="error-banner">{error ?? asrError}</div>}
      </main>
    </div>
  );
}

// ---- helpers ---------------------------------------------------------------

const URL_RE = /(https?:\/\/[^\s]+)/g;

/** Renders text with clickable links; everything else stays plain. */
function RichText({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        URL_RE.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" className="link">
            {p.length > 60 ? p.slice(0, 57) + "…" : p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function clip(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}
// ---- review notes: WYSIWYG margin editor with #tag highlighting -----------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Highlight #tags (Obsidian-style) and [[wiki-links]] for the mirror layer. */
function highlightMarkup(text: string): string {
  return escapeHtml(text)
    .replace(/(#[\w-]+)/g, '<mark class="hl-tag">$1</mark>')
    .replace(/(\[\[[^\]]+\]\])/g, '<mark class="hl-wiki">$1</mark>')
    .replace(/(https?:\/\/[^\s]+)/g, '<mark class="hl-link">$1</mark>');
}

function ReviewNotes({ sessionDir, onSaved }: { sessionDir: () => string; onSaved: (tags: string[]) => void }) {
  const edRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tagList, setTagList] = useState<string[]>([]);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");

  function sync() {
    const ed = edRef.current;
    const mirror = mirrorRef.current;
    if (!ed || !mirror) return;
    const text = ed.innerText ?? "";
    const tags = [...new Set((text.match(/#[\w-]+/g) || []).map((t) => t.slice(1)))];
    setTagList(tags);
    mirror.innerHTML = highlightMarkup(text);
    return { text, tags };
  }

  function save() {
    const dir = sessionDir();
    const data = sync();
    if (!data || !dir) return;
    setSaved("saving");
    backend()
      .then((b) =>
        b.invoke("review_notes_save", {
          sessionDir: dir,
          text: data.text,
          tags: data.tags,
          html: edRef.current?.innerHTML ?? "",
        }),
      )
      .then(() => {
        setSaved("saved");
        onSaved(data.tags);
      })
      .catch(() => setSaved("idle"));
  }

  function onInput() {
    sync();
    setSaved("idle");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, 1200);
  }

  function format(cmd: string) {
    edRef.current?.focus();
    document.execCommand(cmd);
    onInput();
  }

  return (
    <div className="review-notes">
      <div className="rn-toolbar">
        <button onMouseDown={(e) => { e.preventDefault(); format("bold"); }} title="bold"><b>B</b></button>
        <button onMouseDown={(e) => { e.preventDefault(); format("italic"); }} title="italic"><i>I</i></button>
        <span className="rn-status">{saved === "saving" ? "saving…" : saved === "saved" ? "saved" : ""}</span>
        {tagList.length > 0 && (
          <span className="rn-tags">
            {tagList.map((t) => <span key={t} className="tag">#{t}</span>)}
          </span>
        )}
      </div>
      <div className="rn-editor-wrap">
        <div ref={mirrorRef} className="rn-mirror" aria-hidden />
        <div
          ref={edRef}
          className="rn-editor"
          contentEditable
          suppressContentEditableWarning
          onInput={onInput}
          onBlur={save}
          data-placeholder="Review notes — bold/italic, #tags, [[wiki links]], URLs. Select timeline text to flag or chat."
        />
      </div>
    </div>
  );
}
