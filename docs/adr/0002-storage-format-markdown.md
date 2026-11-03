# ADR-0002: Notebook storage format — Markdown + YAML front-matter + JSONL sidecars

- **Status:** Accepted
- **Date:** 2026-11-03
- **Decides:** #62
- **Options considered:** Markdown (chosen), reStructuredText, SQLite-only, proprietary JSON

## Context

Notebooks must be:

1. **Easily queryable** — search, time-anchored retrieval, RAG for distillation.
2. **Back-upable to GitHub** — rendered, diffable text, auto-commit/push per notebook.
3. **LLM-friendly** — Ollama models (gemma4, glm-5.3) consume and produce the format.
4. **Ecosystem-familiar** — readable in Obsidian/LogSeq-like tools; no lock-in.

## Decision

**Markdown is the prose format**, but structure never lives in the prose:

- **Notes** = markdown files with **YAML front-matter** carrying all structure: time anchors, tags, session refs, highlight links.
- **Transcripts** = **JSONL sidecars** (one timestamped segment per line: `{start, end, text, confidence}`) — streamable, diffable, line-addressable.
- **Distillations** = markdown with front-matter (model, prompt template, timestamps).
- **Derived SQLite FTS5 index** for fast query (see #63) — rebuildable, never the source of truth, excluded from git.
- **Audio** = opus/FLAC per session folder.

## reST evaluation and rejection

| Criterion | Markdown | reST |
|---|---|---|
| GitHub rendering | native | native |
| LLM instruction-following | massive training exposure; models emit clean md | far less exposure; LLMs frequently emit malformed reST |
| Obsidian/LogSeq compat | direct | none |
| Strict structure | via front-matter + sidecars | via directives/roles |
| JS/Rust library support in desktop app | rich | docutils is Python-centric |

reST's one real advantage — strict structure — does not apply to us, because our structured data (timestamps, anchors, links) lives in front-matter and JSONL sidecars regardless of prose format. The prose layer only carries human-readable text, where markdown's LLM-training dominance and ecosystem compatibility are decisive.

## Notebook folder schema (v0, refined in #45)

```
notebooks/
  <notebook-name>/
    notebook.yaml
    sessions/
      2026-11-03-1430/          # ISO date + start time
        session.yaml             # start/end, audio file info, clock metadata
        audio.opus               # captured system audio
        transcript.jsonl         # timestamped segments
        notes.md                 # user notes, front-matter anchors
        highlights.jsonl        # transcript region highlights
        distillations/
          2026-11-03-summary.md
```

## Consequences

- Everything committed to git is text (plus optionally opus audio under a size threshold) → clean diffs, GitHub rendering, `git` as the backup mechanism (#64).
- Queryability comes from the derived index + front-matter, not the prose format.
- Auto-export to reST/PDF remains possible later since content is plain text.
- Sidecar formats are versioned (`schemaVersion` field) with forward migrations (#48).