# ADR-0001: Desktop framework — Tauri 2 with Rust backend

- **Status:** Accepted
- **Date:** 2026-11-03
- **Decides:** #10
- **Options considered:** Tauri 2, Electron, pure-native (GTK/Qt), Flutter desktop

## Context

Stenollama must, on Linux/macOS/Windows:

1. Capture the **system audio output** (loopback: what the user hears in headphones/speakers) continuously for the duration of a session.
2. Talk to a **local Ollama daemon** (`localhost:11434`) and **Ollama Cloud** (`ollama.com/v1`) — including base64 WAV payloads for Gemma 4 audio transcription.
3. Run local file I/O for a local-first, git-friendly notebook store.
4. Ship small, installable apps on all three platforms.

System loopback capture is the hard requirement and the deciding factor.

## Decision

**Tauri 2** with a Rust backend and a React + TypeScript + Vite frontend.

- **Audio backend in Rust.** Linux: PipeWire/PulseAudio monitor sources (pipewire-pulse exposes each sink's `.monitor` source); Windows: WASAPI loopback via `wasapi`/`cpal`-adjacent crates; macOS: ScreenCaptureKit (10.13+) or a documented BlackHole virtual-device path. Rust gives us one language for all three platform layers with no Node native-addon (N-API) pain.
- **Ollama client in Rust** (`reqwest`), exposed to the frontend as Tauri commands. One place for the API key, no browser CORS edge cases, easy streaming (channel-based) into the UI.
- **UI in web tech.** React ecosystem (markdown rendering, waveform canvas, rich editors) matches the Obsidian/LogSeq-familiar stenopad UI requirement.
- **Packaging:** Tauri's bundler produces deb/AppImage/dmg/msi/nsis from one config; CI can build all three via a GitHub Actions matrix.

## Consequences

- Rust is required for backend work (audio, storage, Ollama client). Frontend stays TypeScript.
- Tauri system deps differ per OS (Linux needs webkit2gtk; documented in README).
- IPC between capture backend and UI must be designed carefully (streams of PCM levels → throttled events; transcripts → segment events).
- Rejected Electron because loopback capture still needs native modules there, giving us N-API packaging across three OSes *plus* Chromium's weight, with no compensating benefit.
- Rejected pure-native (GTK/Qt) because the stenopad UI is text/editor-heavy and the web ecosystem (markdown, editors, theming) gets us there far faster.

## Follow-ups

- #13 scaffold, #14 CI, #15 Linux audio feasibility spike
- Audio backend crate interfaces defined in ADR-0003 when implemented (capture engine design)