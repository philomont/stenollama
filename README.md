# Stenollama

A local-first stenopad: capture the audio you're hearing, transcribe it live via
Ollama (Gemma 4), take notes anchored to the audio timeline as you listen, and
distill everything afterwards into summaries, references, and catch-up briefs
via Ollama Cloud models (GLM 5.3 / GLM 5.3 Flash).

## Layout

- `docs/adr/` — architecture decision records
- `src/` — React + TypeScript frontend (stenopad UI)
- `src-tauri/` — Rust backend (audio capture, storage, Ollama client)
- `spikes/` — throwaway feasibility experiments
- `.github/workflows/` — CI

## Development (Linux)

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
                 libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
npm install
npm run tauri dev
```

Ollama must be running locally (`ollama serve`) for live features.

## Status

Pre-alpha. See the [issue backlog](https://github.com/philomont/stenollama/issues)
for the roadmap: 9 epics from scaffolding to packaging.