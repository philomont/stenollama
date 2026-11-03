// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Note: do NOT unconditionally force WEBKIT_DISABLE_DMABUF_RENDERER here.
    // On modern WebKitGTK (>= 2.5x) + Mesa 26 this breaks the fallback EGL
    // path and aborts the WebProcess (see cc-switch#6514, and Tauri's
    // Linux Graphics Issues page). Users on older NVIDIA stacks can set it
    // themselves; the gray-window issue on Ubuntu 26.04 is the glycin/gdk-pixbuf
    // deadlock, which we document in docs/troubleshooting.md instead.

    stenollama_lib::run()
}
