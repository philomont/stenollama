# Stenollama

A local-first stenopad: capture the audio you're hearing, transcribe it live via
Ollama (Gemma 4), take notes anchored to the audio timeline as you listen, and
distill everything afterwards into summaries, references, and catch-up briefs
via Ollama Cloud models (GLM 5.3 / GLM 5.3 Flash).

## Layout

- `docs/adr/` — architecture decision records
- `src/` — React + TypeScript frontend (stenopad UI, shell-agnostic)
- `electron/` — Electron shell (Linux) with the capture/Ollama backend
- `src-tauri/` — Tauri shell + Rust backend (Windows/macOS; broken on some
  Ubuntu 26.04 systems — see `docs/troubleshooting.md`)
- `spikes/` — throwaway feasibility experiments
- `.github/workflows/` — CI

## Development

**Linux** (uses the Electron/Chromium shell):

```bash
npm install
npm run dev:linux        # vite + electron
```

`--no-sandbox` is a dev convenience; for a hardened setup run once:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

then drop `--no-sandbox` from the scripts.

**Windows / macOS** (Tauri shell — WebView2 / WKWebView, unaffected by the
WebKitGTK issue):

```bash
npm install
npm run tauri dev
```

Ollama should be running locally for live features; set `OLLAMA_API_KEY` in
your environment to also enable Ollama Cloud (GLM models).

## Status

Pre-alpha. See the [issue backlog](https://github.com/philomont/stenollama/issues)
for the roadmap: 9 epics from scaffolding to packaging.