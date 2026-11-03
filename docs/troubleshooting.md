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

**Workarounds:**
1. **The app ships an Electron (Chromium) shell for Linux** — see `electron/`
   and `src/api.ts`. Chromium is unaffected by the WebKitGTK breakage, and
   the frontend is shell-agnostic; the Rust/Tauri backend remains the
   Windows/macOS path (WebView2 / WKWebView don't use WebKitGTK).
2. `scripts/fix-glycin-deadlock.sh` installs Debian's glycin 2.2.3
   (checksum-pinned, with rollback). Worth keeping even with Electron —
   it fixes the underlying gdk-pixbuf deadlock for every affected app,
   though on at least one resolute machine the WebKitGTK stall persisted
   even with glycin 2.2.3 (a plain Python WebKitGTK window still never
   loads), which is why the app moved to Chromium on Linux.
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