import { useEffect, useMemo, useRef, useState } from "react";
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

// A block: a recording section of the timeline. Short gaps continue the
// current block; a new block starts on user choice, after 1.5h idle, or
// after summarization closes the block.
interface Block {
  id: string;
  index: number;
  at: string;
  closed: boolean;
  summary: string | null;
  summarizing?: boolean;
}

// A margin annotation. Kinds drive the right pips' colors:
//   comment — live AI comment during capture (purple)
//   chat    — AI chat about a selected passage (blue)
//   flag    — custom flag on a selected passage (red)
interface MarginEntry {
  id: string;
  kind: "comment" | "chat" | "flag";
  at: string;
  refId?: string | null;
  noteContext?: string | null;
  text: string;
  selection?: string;
  question?: string;
}

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

const AI_TRIGGER_IDLE_MS = 6000;
const AI_TRIGGER_MIN_CHARS = 40;
// A new block starts after this much idle time since the last recording.
const NEW_BLOCK_AFTER_MS = 1.5 * 60 * 60 * 1000;

type RecordSource = "system" | "mic";

export default function App() {
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(-90);
  const [lastSession, setLastSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [asrError, setAsrError] = useState<string | null>(null);

  // The timeline.
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [noteBlocks, setNoteBlocks] = useState<NoteBlock[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [margin, setMargin] = useState<MarginEntry[]>([]);

  // Composer.
  const [composeDraft, setComposeDraft] = useState("");
  const [editingNote, setEditingNote] = useState<{ id: string; draft: string } | null>(null);

  // Selection → 2-step annotate.
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const [chatAnchorTop, setChatAnchorTop] = useState(40);
  const [action, setAction] = useState<null | "chat" | "flag" | "annotate">(null);
  const [actionDraft, setActionDraft] = useState("");
  const [flagDraft, setFlagDraft] = useState("");
  const [knownFlags, setKnownFlags] = useState<string[]>([]);
  const [aiThinking, setAiThinking] = useState(false);

  // Recording controls.
  const [source, setSource] = useState<RecordSource>("system");
  const [forceNewBlock, setForceNewBlock] = useState(false);

  // Layout: annotations positioned at their anchors inside the one scroller.
  const [railTops, setRailTops] = useState<Record<string, number>>({});

  // Refs.
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const noteBlocksRef = useRef<NoteBlock[]>([]);
  const blocksRef = useRef<Block[]>([]);
  const recordingRef = useRef(false);
  const sessionDirRef = useRef<string | null>(null);
  const lastStopAtRef = useRef<string | null>(null);
  const lastAiAt = useRef(0);
  const lastNoteEdit = useRef(0);
  const charsSinceAi = useRef(0);
  const aiPending = useRef(false);
  const composeDraftRef = useRef("");

  useEffect(() => { segmentsRef.current = segments; }, [segments]);
  useEffect(() => { noteBlocksRef.current = noteBlocks; }, [noteBlocks]);
  useEffect(() => { blocksRef.current = blocks; }, [blocks]);
  useEffect(() => { recordingRef.current = recording; }, [recording]);
  useEffect(() => { composeDraftRef.current = composeDraft; }, [composeDraft]);

  useEffect(() => {
    backend()
      .then((b) => b.invoke<OllamaStatus>("ollama_status"))
      .then(setOllama)
      .catch(() => setOllama({ local_online: false, local_version: null, cloud_online: false }));
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

  // Keyboard shortcuts: Space = toggle system recording, M = toggle mic recording.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (e.code === "Space" && !recording) {
        e.preventDefault();
        setSource("system");
        toggleRecord();
      } else if ((e.key === "m" || e.key === "M") && !recording) {
        e.preventDefault();
        setSource("mic");
        toggleRecord();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [recording]);

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
      backend()
        .then((b) =>
          b.invoke<MarginEntry | null>("ai_margin_comment", {
            at: nowIso(),
            noteBlock: composeDraftRef.current.trim(),
            transcriptWindow: segmentsRef.current.slice(-8).map((s) => s.text).join(" ").slice(-1500),
            sessionDir: sessionDirRef.current,
          }),
        )
        .then((entry) => {
          if (entry) setMargin((m) => [...m, entry]);
        })
        .catch(() => {})
        .finally(() => {
          aiPending.current = false;
        });
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  // Selection → the annotation picker pops up on the right, inline with the
  // selection. Both columns are the same page, so the anchor is measured
  // against the shared scroller's content.
  useEffect(() => {
    function onMouseUp() {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";
      if (text.length < 12 || !sel || sel.rangeCount === 0) {
        setPendingSelection(null);
        setAction(null);
        return;
      }
      const node = sel.anchorNode?.parentElement;
      if (!node) return;
      const inLeft = !!(
        node.closest?.(".stream") ||
        node.closest?.(".segment") ||
        node.closest?.(".note-block") ||
        node.closest?.(".composer")
      );
      if (!inLeft) {
        setPendingSelection(null);
        setAction(null);
        return;
      }
      const scroller = scrollRef.current;
      if (!scroller) return;
      const anchorEl = node.closest?.("[data-at]") as HTMLElement | null;
      const anchorRect = (anchorEl ?? node).getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const top = anchorRect.top - scrollerRect.top + scroller.scrollTop;
      setPendingSelection(text);
      setAction(null);
      setActionDraft("");
      setChatAnchorTop(Math.max(12, top));
    }
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, []);

  // ---- recording -----------------------------------------------------------

  function newBlockNeeded(): boolean {
    const bs = blocksRef.current;
    const last = bs[bs.length - 1];
    if (forceNewBlock) return true;
    if (last?.closed) return true;
    const since = lastStopAtRef.current;
    if (since && Date.now() - new Date(since).getTime() > NEW_BLOCK_AFTER_MS) return true;
    return false;
  }

  async function startRecording(src: RecordSource) {
    const b = await backend();
    const info = await b.invoke<{ sessionDir: string; burstIndex: number; resumed: boolean; at: string }>(
      "capture_start",
      { notebook: "Inbox", source: src },
    );
    sessionDirRef.current = info.sessionDir;
    setLastSession(info.sessionDir);
    setRecording(true);
    charsSinceAi.current = 0;
    setForceNewBlock(false);
    if (newBlockNeeded() || blocksRef.current.length === 0) {
      const idx = blocksRef.current.length + 1;
      setBlocks((bs) => [...bs, { id: `block-${nextId.current++}`, index: idx, at: info.at, closed: false, summary: null }]);
    }
  }

  async function toggleRecord() {
    setError(null);
    setAsrError(null);
    try {
      if (!recording) {
        await startRecording(source);
      } else {
        await backend().then((b) => b.invoke("capture_stop"));
      }
    } catch (e) {
      setError(String(e));
      setRecording(false);
    }
  }

  // Switch the audio feed: stop the current recording and resume as a new
  // burst from the other source — the block continues.
  // ---- block summaries ------------------------------------------------------

  function blockEntries(block: Block): string[] {
    const bs = blocksRef.current;
    const idx = bs.findIndex((x) => x.id === block.id);
    const nextBar = bs[idx + 1]?.at;
    const inRange = (at: string) => at >= block.at && (!nextBar || at < nextBar);
    return [
      ...segmentsRef.current.filter((s) => inRange(s.at)).map((s) => s.text),
      ...noteBlocksRef.current.filter((n) => inRange(n.at)).map((n) => n.text),
    ].filter((t) => t.trim());
  }

  async function summarizeBlock(block: Block) {
    setBlocks((bs) => bs.map((x) => (x.id === block.id ? { ...x, summarizing: true } : x)));
    try {
      const b = await backend();
      const previous = blocksRef.current
        .filter((x) => x.index < block.index && x.summary)
        .map((x) => x.summary as string);
      const content = blockEntries(block).join("\n");
      const summary = await b.invoke<string | null>("ai_block_summary", {
        content,
        previousSummaries: previous,
      });
      if (summary) {
        setBlocks((bs) =>
          bs.map((x) => (x.id === block.id ? { ...x, summarizing: false, closed: true, summary } : x)),
        );
        b.invoke("block_summary_add", {
          sessionDir: sessionDirRef.current || lastSession || "",
          blockIndex: block.index,
          at: nowIso(),
          text: summary,
        }).catch(() => {});
      }
    } finally {
      setBlocks((bs) => bs.map((x) => (x.id === block.id ? { ...x, summarizing: false } : x)));
    }
  }

  // ---- composer -------------------------------------------------------------

  async function commitCompose() {
    const text = composeDraft.trim();
    if (!text) return;
    const at = nowIso();
    const tags = (text.match(/#[\w-]+/g) || []).map((t) => t.slice(1));
    const id = `note-${nextId.current++}`;
    setComposeDraft("");
    setNoteBlocks((nb) => [...nb, { id, at, text, tags }]);
    try {
      const b = await backend();
      await b.invoke("note_add", { sessionDir: sessionDirRef.current || lastSession || "", at, text, tags });
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
      const rel = await b.invoke<string>("attachment_add", { sessionDir: sessionDirRef.current, dataUrl });
      const at = nowIso();
      setNoteBlocks((nb) => [...nb, { id: `note-${nextId.current++}`, at, text: "", tags: [], image: dataUrl }]);
      await b.invoke("note_add", { sessionDir: sessionDirRef.current, at, text: "", tags: [], image: rel });
    } catch {}
  }

  async function saveNoteEdit(id: string) {
    const draft = editingNote?.draft ?? "";
    const clean = draft.trim();
    setEditingNote(null);
    setNoteBlocks((nb) => nb.map((n) => (n.id === id ? { ...n, text: clean } : n)));
    try {
      const b = await backend();
      await b.invoke("note_edit", { sessionDir: sessionDirRef.current || lastSession || "", id, at: nowIso(), text: clean });
    } catch {}
  }

  // ---- annotation actions ---------------------------------------------------

  function refOfSelection(selection: string): string | null {
    const seg = segmentsRef.current.find(
      (s) => s.text.includes(selection.slice(0, 40)) || selection.slice(0, 40).includes(s.text.slice(0, 40)),
    );
    return seg?.id ?? null;
  }

  function selectionContext(selection: string): string {
    const segs = segmentsRef.current;
    const probe = selection.slice(0, 40);
    const idx = segs.findIndex((s) => s.text.includes(probe) || probe.includes(s.text.slice(0, 40)));
    if (idx >= 0) {
      return segs
        .slice(Math.max(0, idx - 3), idx + 4)
        .map((s) => `[${fmtDT(s.at)}] ${s.text}`)
        .join("\n");
    }
    return segs.slice(-8).map((s) => `[${fmtDT(s.at)}] ${s.text}`).join("\n");
  }

  async function doChat() {
    if (!pendingSelection || !actionDraft.trim()) return;
    const question = actionDraft.trim();
    const selection = pendingSelection;
    const refId = refOfSelection(selection);
    const at = nowIso();
    setActionDraft("");
    setPendingSelection(null);
    setAction(null);
    setAiThinking(true);
    try {
      const b = await backend();
      const entry = await b.invoke<MarginEntry>("ai_selection_chat", {
        selection,
        question,
        at,
        atSec: null,
        context: selectionContext(selection),
        sessionDir: sessionDirRef.current || lastSession || "notebooks/Inbox/sessions/unsaved",
        refId,
      });
      if (entry) setMargin((m) => [...m, entry]);
    } finally {
      setAiThinking(false);
    }
  }

  async function doFlag() {
    if (!pendingSelection || !flagDraft.trim()) return;
    const flag = flagDraft.trim().replace(/^#/, "");
    const selection = pendingSelection;
    const refId = refOfSelection(selection);
    const at = nowIso();
    setFlagDraft("");
    setPendingSelection(null);
    setAction(null);
    const id = `flag-${nextId.current++}`;
    setMargin((m) => [...m, { id, kind: "flag", at, refId, text: flag, selection }]);
    setKnownFlags((k) => (k.includes(flag) ? k : [...k, flag]));
    try {
      const b = await backend();
      await b.invoke("flag_add", { sessionDir: sessionDirRef.current || lastSession || "", flag, selection, at, refId });
    } catch {}
  }

  async function doAnnotate() {
    if (!pendingSelection || !actionDraft.trim()) return;
    const text = actionDraft.trim();
    const selection = pendingSelection;
    const at = nowIso();
    setActionDraft("");
    setPendingSelection(null);
    setAction(null);
    const tags = (text.match(/#[\w-]+/g) || []).map((t) => t.slice(1));
    const id = `note-${nextId.current++}`;
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

  // ---- layout: annotations + pips aligned to their anchors ------------------

  // The left timeline: segments + notes ordered by datetime.
  const tl = useMemo(
    () =>
      [
        ...segments.map((s) => ({ type: "seg" as const, id: s.id, at: s.at, text: s.text, tags: [] as string[] })),
        ...noteBlocks.map((n) => ({
          type: "note" as const,
          id: n.id,
          at: n.at,
          text: n.text,
          tags: n.tags,
          selectionRef: n.selectionRef ?? null,
          image: n.image ?? null,
        })),
      ].sort((a, b) => a.at.localeCompare(b.at)),
    [segments, noteBlocks],
  );

  // Everything that renders in the scroller carries data-at; entries with
  // ids are anchorable (segments, notes, blocks).
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const scrollerTop = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const topOf = (el: HTMLElement | null) =>
      el ? el.getBoundingClientRect().top - scrollerTop : null;
    const railT: Record<string, number> = {};
    tl.forEach((item) => {
      const el = document.getElementById(`entry-${item.id}`);
      const top = topOf(el);
      if (top !== null) railT[item.id] = top;
    });
    blocks.forEach((block) => {
      const el = document.getElementById(`entry-${block.id}`);
      const top = topOf(el);
      if (top !== null) railT[block.id] = top;
    });
    setRailTops(railT);
  }, [tl, blocks]);

  const statusOk = (ollama?.local_online || ollama?.cloud_online) ?? false;
  const levelPct = Math.max(0, Math.min(100, ((level + 60) / 60) * 100));

  // Rail markers (left): blocks + notes + segments-with-annotations.
  const railMarkers = useMemo(
    () =>
      [
        ...blocks.map((b) => ({
          id: b.id,
          at: b.at,
          label: b.summary ? `≡ ${clip(b.summary, 70)}` : `— block ${b.index}`,
        })),
        ...tl
          .filter((x) => x.type === "note" && (x.text || x.image))
          .map((x) => ({ id: x.id, at: x.at, label: `✎ ${clip(x.text, 70) || "image"}` })),
      ].sort((a, b) => a.at.localeCompare(b.at)),
    [blocks, tl],
  );

  return (
    <div className="desk">
      <aside className={`drawer ${drawerOpen ? "open" : ""}`} onMouseLeave={() => setDrawerOpen(false)}>
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

      <div
        className={`drawer-scrim ${drawerOpen ? "show" : ""}`}
        onClick={() => setDrawerOpen(false)}
      />
      <div
        className="drawer-hover-zone"
        onMouseEnter={() => setDrawerOpen(true)}
      />

      <main className="desk-main">

        <section className="pad">
          <div className="red-line" />
          {/* One page: both columns scroll together in a single scroller. */}
          <div className="pad-scroll" ref={scrollRef}>
            <div className="pad-columns">
              <div className="pad-col notes-col">
                <div className="stream">
                  {blocks.length === 0 && tl.length === 0 && (
                    <p className="placeholder">
                      The timeline unfolds here — press Record, or just type a note and hit Enter.
                    </p>
                  )}
                  {tl
                    .filter((x) => blocks.length === 0 || x.at < blocks[0].at)
                    .map((item) => (
                      <NoteView key={item.id} item={item} editing={editingNote} setEditing={setEditingNote} onSave={saveNoteEdit} />
                    ))}
                  {blocks.map((block, bi) => {
                    const nextBar = blocks[bi + 1]?.at;
                    const inBlock = (at: string) => at >= block.at && (!nextBar || at < nextBar);
                    return (
                      <div key={block.id}>
                        <div className="burst-bar" id={`entry-${block.id}`} data-at={block.at}>
                          <span>— {bi === 0 ? "recording started" : `block ${block.index}`} · {fmtDTLong(block.at)} —</span>
                        </div>
                        {tl.filter((x) => inBlock(x.at)).map((item) => (
                          <NoteView key={item.id} item={item} editing={editingNote} setEditing={setEditingNote} onSave={saveNoteEdit} />
                        ))}
                        {block.summary ? (
                          <div className="block-summary-card">
                            <span className="bs-head">≡ block {block.index} · closed</span>
                            <p className="bs-text"><RichText text={block.summary} /></p>
                          </div>
                        ) : (
                          <div className="block-footer">
                            <button
                              className="ghost-btn"
                              onClick={() => summarizeBlock(block)}
                              disabled={block.summarizing}
                              title="AI summary of this block — closes it; the next recording opens a new block"
                            >
                              {block.summarizing ? "summarizing…" : "≡ summarize block"}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* Left pips: auto-scrolling markers at their entries. */}
                <div className="rail" aria-label="timeline markers">
                  {railMarkers.map((m) => (
                    <div
                      key={m.id}
                      className="rail-marker"
                      style={{ position: "absolute", top: railTops[m.id] ?? 9999 }}
                      title={`${fmtDTLong(m.at)}  ${m.label}`}
                      onClick={() =>
                        document.getElementById(`entry-${m.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
                      }
                    >
                      {m.label.startsWith("—") ? "▬" : "✎"}
                    </div>
                  ))}
                </div>
              </div>

              <div className="pad-col margin-col">
                {margin.length === 0 && !aiThinking && !pendingSelection && (
                  <p className="margin-empty">
                    The margin edits the timeline: select any passage on the
                    left, then pick an action here — AI chat, a flag, or your
                    own annotation.
                  </p>
                )}
                {margin.map((m) => (
                  <div
                    key={m.id}
                    data-margin-id={m.id}
                    data-at={m.at}
                    className={`margin-entry kind-${m.kind}`}
                  >
                    {m.kind === "chat" ? (
                      <>
                        <span className="margin-meta">
                          <span className="author ai">chat</span>
                          <span className="margin-time">{fmtDT(m.at)}</span>
                        </span>
                        <p className="chat-selection">“{clip(m.selection, 140)}”</p>
                        <p className="chat-question">{m.question}</p>
                        <p className="margin-text"><RichText text={m.text} /></p>
                      </>
                    ) : m.kind === "flag" ? (
                      <>
                        <span className="margin-meta">
                          <span className="author flag">⚑ {m.text}</span>
                          <span className="margin-time">{fmtDT(m.at)}</span>
                        </span>
                        <p className="chat-selection">“{clip(m.selection, 140)}”</p>
                      </>
                    ) : (
                      <>
                        <span className="margin-meta">
                          <span className="author ai">{m.text.slice(0, 80)}</span>
                          <span className="margin-time">{fmtDT(m.at)}</span>
                        </span>
                        {m.noteContext && <p className="note-quote">re: “{clip(m.noteContext, 90)}”</p>}
                      </>
                    )}
                  </div>
                ))}
                {aiThinking && <p className="ai-thinking">AI is writing…</p>}



                {/* Selection → 2-step annotation picker. */}
                {pendingSelection && (
                  <div className="chat-box" style={{ top: chatAnchorTop }}>
                    <p className="chat-box-quote">“{clip(pendingSelection, 160)}”</p>
                    {action === null && (
                      <div className="action-select">
                        <button onClick={() => setAction("chat")}>💬 AI chat</button>
                        <button onClick={() => setAction("flag")}>⚑ Flag</button>
                        <button onClick={() => setAction("annotate")}>✎ Annotate</button>
                        <button className="ghost" onClick={() => setPendingSelection(null)}>✕</button>
                      </div>
                    )}
                    {action === "chat" && (
                      <>
                        <input
                          autoFocus
                          value={actionDraft}
                          onChange={(e) => setActionDraft(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && doChat()}
                          placeholder="ask the AI about this passage…"
                        />
                        <div className="chat-box-actions">
                          <button onClick={doChat}>Ask</button>
                          <button className="ghost" onClick={() => setAction(null)}>back</button>
                        </div>
                      </>
                    )}
                    {action === "flag" && (
                      <>
                        <input
                          autoFocus
                          list="known-flags"
                          value={flagDraft}
                          onChange={(e) => setFlagDraft(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && doFlag()}
                          placeholder="flag name, e.g. important / verify / todo…"
                        />
                        <datalist id="known-flags">
                          {knownFlags.map((f) => <option key={f} value={f} />)}
                        </datalist>
                        <div className="chat-box-actions">
                          <button className="flag" onClick={doFlag}>⚑ Set flag</button>
                          <button className="ghost" onClick={() => setAction(null)}>back</button>
                        </div>
                      </>
                    )}
                    {action === "annotate" && (
                      <>
                        <input
                          autoFocus
                          value={actionDraft}
                          onChange={(e) => setActionDraft(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && doAnnotate()}
                          placeholder="your note about this passage… #tags ok"
                        />
                        <div className="chat-box-actions">
                          <button className="note" onClick={doAnnotate}>Add note</button>
                          <button className="ghost" onClick={() => setAction(null)}>back</button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Recording controls + composer, ON the paper. */}
          <div className="pad-fixed">
            <div className="paper-controls">
              <button
                className={`paper-btn ${recording && source === "system" ? "recording" : ""}`}
                disabled={recording && source === "mic"}
                onClick={() => {
                  if (recording && source === "system") {
                    toggleRecord();
                  } else if (!recording) {
                    setSource("system");
                    toggleRecord();
                  }
                }}
                title={
                  recording && source === "system"
                    ? "Stop system audio recording (Space)"
                    : "Record system audio (Space)"
                }
              >
                <span className="material-symbols-outlined">
                  {recording && source === "system" ? "stop_circle" : "radio_button_checked"}
                </span>
              </button>
              <button
                className={`paper-btn ${recording && source === "mic" ? "recording" : ""}`}
                disabled={recording && source === "system"}
                onClick={() => {
                  if (recording && source === "mic") {
                    toggleRecord();
                  } else if (!recording) {
                    setSource("mic");
                    toggleRecord();
                  }
                }}
                title={
                  recording && source === "mic"
                    ? "Stop microphone recording (M)"
                    : "Record microphone (M)"
                }
              >
                <span className="material-symbols-outlined">
                  {recording && source === "mic" ? "stop_circle" : "mic"}
                </span>
              </button>
              <button
                className={`paper-btn ${forceNewBlock ? "active" : ""}`}
                disabled={recording}
                onClick={() => setForceNewBlock(!forceNewBlock)}
                title="Start a new block on the next recording (instead of continuing the last)"
              >
                <span className="material-symbols-outlined">
                  {forceNewBlock ? "check_circle" : "playlist_add"}
                </span>
              </button>
              <span className="block-container" title="~20 second transcription blocks">
                {Array.from({ length: 5 }).map((_, i) => {
                  const done = Math.min(segments.length, 2);
                  const active = recording ? 1 : 0;
                  const state = i < done ? "done" : i < done + active ? "active" : "empty";
                  return <span key={i} className={`block-slot ${state}`} />;
                })}
              </span>
              <span className="level-meter-inline" aria-hidden>
                <span className="level-bar-inline" style={{ width: `${levelPct}%` }} />
              </span>
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
        </section>

        {(error || asrError) && <div className="error-banner">{error ?? asrError}</div>}
      </main>
    </div>
  );
}

// ---- components -------------------------------------------------------------

type TLItem = {
  type: "seg" | "note";
  id: string;
  at: string;
  text: string;
  tags: string[];
  selectionRef?: string | null;
  image?: string | null;
};

function NoteView({
  item,
  editing,
  setEditing,
  onSave,
}: {
  item: TLItem;
  editing: { id: string; draft: string } | null;
  setEditing: (e: { id: string; draft: string } | null) => void;
  onSave: (id: string) => void;
}) {
  if (item.type === "seg") {
    return (
      <div className="entry" id={`entry-${item.id}`} data-at={item.at}>
        <p className="segment">
          <span className="segment-stamp">{fmtDT(item.at)}</span>
          {item.text}
        </p>
      </div>
    );
  }
  return (
    <div className="note-block" id={`entry-${item.id}`} data-at={item.at}>
      <span className="note-block-stamp">✎ {fmtDT(item.at)}</span>
      {item.selectionRef && <p className="note-ref">re: “{clip(item.selectionRef, 110)}”</p>}
      {editing?.id === item.id ? (
        <textarea
          className="note-edit"
          autoFocus
          value={editing.draft}
          onChange={(e) => setEditing({ id: item.id, draft: e.target.value })}
          onBlur={() => onSave(item.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSave(item.id);
            }
          }}
        />
      ) : (
        <>
          {item.image && <img className="note-image" src={item.image} alt="note attachment" />}
          {item.text && (
            <p className="note-block-text" onClick={() => setEditing({ id: item.id, draft: item.text })} title="click to edit">
              <RichText text={item.text.replace(/#[\w-]+/g, "").trim()} />
            </p>
          )}
          {item.tags.length > 0 && (
            <p className="note-tags">
              {item.tags.map((t) => (
                <span key={t} className="tag">#{t}</span>
              ))}
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ---- helpers -----------------------------------------------------------------

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