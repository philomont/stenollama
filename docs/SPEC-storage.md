# Storage Specification (v0.1)

Implements ADR-0002. Decides #45; migrations: #48; derived index: #63; git backup: #64.

## Principles

1. **Plain text is the source of truth.** Markdown, YAML, JSONL. No databases in git.
2. **Structure lives in front-matter and sidecars**, never in prose.
3. **Everything is versioned** via `schemaVersion` fields and forward migrations.
4. **Derived data is disposable.** The SQLite index and waveform caches can be deleted and rebuilt at any time.

## Notebook layout

```
notebooks/
  <notebook-name>/                 # kebab-case, human-chosen
    notebook.yaml
    sessions/
      <YYYY-MM-DD-HHMM>/           # session start time, local time
        session.yaml
        audio.opus                 # captured system audio (gitignored over ~25MB, see #64)
        transcript.jsonl
        notes.md
        highlights.jsonl
        distillations/
          <YYYY-MM-DD-HHMM>-<slug>.md
```

## File formats

### `notebook.yaml`

```yaml
schemaVersion: 0
name: Research
description: Talks, lectures, meetings
tags: [research]
createdAt: 2026-11-03T14:30:00+01:00
```

### `session.yaml`

```yaml
schemaVersion: 0
startedAt: 2026-11-03T14:30:00+01:00
endedAt: 2026-11-03T15:12:44+01:00
audio:
  file: audio.opus
  sampleRate: 48000
  channels: 1
  durationSec: 2564.0
  clock: monotonic   # see #19: recording clock source
capture:
  source: system-output-monitor
  device: alsa_output.pci-0000_00_1f.3.analog-stereo
transcription:
  engine: ollama-gemma4   # see #60/#61
  model: gemma4:e4b
```

### `transcript.jsonl`

One JSON object per line, strictly ordered by `start`:

```json
{"schemaVersion":0,"id":"seg-000123","start":123.45,"end":131.02,"text":"...","confidence":0.91}
```

- `start`/`end`: seconds since session start (float, 2 decimals).
- `id`: stable, monotonic — used by notes and highlights for references.
- Empty/inaudible segments are omitted, never blank lines.

### `notes.md`

```markdown
---
schemaVersion: 0
anchors:
  - noteId: note-000001
    start: 142.10
    end: 149.83
highlights: [seg-000123]
tags: [talk, ml]
---
## My heading

Some prose. Timestamps never appear inline; anchoring is in front-matter.
```

- `noteId` is stable and referenced by the index and distillations.
- Anchors are editable (#37).

### `highlights.jsonl`

```json
{"schemaVersion":0,"id":"hl-000001","noteId":"note-000001","segments":["seg-000123","seg-000124"],"color":"accent","createdAt":"..."}
```

### `notes.jsonl`

One user note block per line — notes committed with Enter, injected into the
stream at the point the user started typing relative to the recording.

```json
{"schemaVersion":0,"createdAt":"...","kind":"note","startSec":142.1,"endSec":149.8,"text":"...","selectionRef":null}
```

- `startSec` is the tape position where typing began (`null` when written
  outside a capture — those render at the end of the stream).
- `selectionRef` is present when the note was made *about* a selected passage
  (from the selection box's "Add note" action).
- The `notes.md` stub remains as the human-readable/export target; the
  sidecar carries the anchors and feeds the stream UI.

### `margin.jsonl`

One entry per line — the margin column: human/AI comments loosely linked to
the tape **and** the note block being typed, plus selection-anchored chats.

```json
{"schemaVersion":0,"createdAt":"...","kind":"comment","author":"human|ai","atSec":142.1,"noteContext":"..." ,"model":"glm-5.2:cloud","text":"..."}
{"schemaVersion":0,"createdAt":"...","kind":"chat","author":"human->ai","atSec":180.4,"selection":"...","question":"...","model":"glm-5.2:cloud","text":"..."}
```

- `atSec` is a loose anchor (typing position in the tape, or selection time).
- `noteContext` snapshots the note block the user was writing when the entry
  landed — the time+context link.
- `model` is present on AI entries for provenance.

### `distillations/<...>.md`

```markdown
---
schemaVersion: 0
kind: summary        # summary | key-points | action-items | qa | catch-up
model: glm-5.3-flash
provider: ollama-cloud
template: default-summary
generatedAt: 2026-11-03T15:20:00+01:00
sourceSegments: [seg-000001, seg-000130]
---
Markdown body produced by the model, edited freely by the user afterwards.
```

## Versioning & migration rules (#48)

- Every sidecar/front-matter block carries `schemaVersion`.
- Readers must accept any version ≤ current and run migrations in-place at load.
- Migrations are append-only in a registry keyed by `(from, to)`.
- Unknown fields are preserved (round-trip safe), never dropped.

## Index & backup

- Derived SQLite FTS5 index (`index.sqlite`, gitignored) built by #63.
- Git auto-commit/push per notebook defined by #64; audio committed only under the configured size threshold.