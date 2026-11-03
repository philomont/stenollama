# Troubleshooting

## Gray/blank window on Linux (Ubuntu 26.04 "resolute")

**Symptom:** the app window opens but stays gray; no content renders. The
same happens intermittently with some Flatpak apps (they use WebKitGTK /
gdk-pixbuf too). WebKit's network process fetches the page fine — the
renderer never commits it.

**Root cause (verified on this machine, 2026-11):** Ubuntu 26.04 routes all
gdk-pixbuf image loading through **glycin**, which decodes images inside a
bwrap sandbox. The shipped glycin 2.1.5 deadlocks when gdk-pixbuf calls it
synchronously (GTask thread pool exhaustion — fixed upstream in glycin
2.2.0, see the 2.2.0 NEWS "Fixed" entry). GTK's startup icon-theme load
hangs forever; the window surface setup stalls behind it and the webview
never first-paints.

Evidence gathered:
- Orphaned `bwrap ... glycin-svg / glycin-image-rs` processes accumulate
  across app runs (stuck forever — `pstree` shows them as direct children).
- Under gdb, glycin's handler thread is blocked in `wait4()` while its
  loader child sits idle inside the sandbox.
- Running the same loader under the same bwrap sandbox **without** glycin's
  seccomp filter completes its D-Bus handshake normally.
- With `GLYCIN_DATA_DIR` pointed at an empty dir (no loaders), GTK hard-errors:
  `Failed to load /usr/share/icons/Yaru/16x16@2x/status/image-missing.png:
  No image loaders are configured` — proving startup depends on glycin.
- Upstream fixed the deadlock in glycin 2.2.0; Ubuntu resolute ships 2.1.5
  (LP #2122289 switched gdk-pixbuf to wrap glycin; related: LP #2171362).

**Workarounds (require sudo or newer packages):**
1. Best: run `scripts/fix-glycin-deadlock.sh` from this repo — it installs
   Debian's glycin 2.2.3 (soname-compatible, checksum-pinned, with rollback)
   and contains the deadlock fix plus `GLYCIN_DISABLE_SANDBOX` support.
2. Or wait for the Ubuntu SRU (track LP #2171362).
3. NOT recommended: `WEBKIT_DISABLE_DMABUF_RENDERER=1` — on WebKitGTK 2.52 +
   Mesa 26 this aborts the WebProcess instead (cc-switch#6514).

**Browser preview fallback:** for UI work without fixing glycin you can run
`npm run dev` and open http://localhost:127.0.0.1:1420 — the status chip
falls back to a direct fetch probe and the capture commands are unavailable
(no Tauri backend), but the stenopad layout is fully inspectable.

## Ollama shows offline

The chip probes `http://127.0.0.1:11434/api/version` (local daemon) and, if
`OLLAMA_API_KEY` is set in the environment, `https://ollama.com/v1/models`
(Ollama Cloud). In a plain browser (no Tauri backend) it retries the local
daemon directly via fetch; if that fails too it reports offline.