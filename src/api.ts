// Shell-agnostic backend access for the renderer.
//
// Three environments:
//   1. Electron (Linux shell)      — window.steno bridge from preload.js
//   2. Tauri (Windows/macOS shell) — @tauri-apps/api invoke/listen
//   3. Plain browser (dev preview) — direct fetch fallback for status;
//      capture commands are unavailable
//
// Contract every shell exposes:
//   invoke<T>(command, payload?) => Promise<T>
//   listen<T>(event, cb) => Promise<unlisten>

export interface Backend {
  shell: "electron" | "tauri" | "browser";
  invoke: <T>(command: string, payload?: Record<string, unknown>) => Promise<T>;
  listen: <T>(event: string, cb: (payload: T) => void) => Promise<() => void>;
}

// ---- Electron preload bridge --------------------------------------------

interface StenoBridge {
  shell: "electron";
  invoke: (channel: string, payload?: Record<string, unknown>) => Promise<unknown>;
  on: (channel: string, listener: (payload: unknown) => void) => () => void;
}

declare global {
  interface Window {
    steno?: StenoBridge;
  }
}

// ---- Browser fallback ----------------------------------------------------

async function fetchOllamaStatus(): Promise<{
  local_online: boolean;
  local_version: string | null;
  cloud_online: boolean;
}> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const resp = await fetch("http://127.0.0.1:11434/api/version", {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const body = await resp.json();
    return { local_online: true, local_version: body.version ?? null, cloud_online: false };
  } catch {
    return { local_online: false, local_version: null, cloud_online: false };
  }
}

// ---- Resolution ----------------------------------------------------------

let cached: Promise<Backend> | null = null;

export function backend(): Promise<Backend> {
  if (cached) return cached;

  cached = (async () => {
    // 1. Electron: preload bridge is present.
    if (window.steno) {
      const bridge = window.steno;
      return {
        shell: "electron" as const,
        invoke: <T,>(cmd: string, payload?: Record<string, unknown>) =>
          bridge.invoke(cmd, payload).then((v) => v as T),
        listen: <T,>(event: string, cb: (payload: T) => void) => {
          const un = bridge.on(event, (p) => cb(p as T));
          return Promise.resolve(un);
        },
      };
    }

    // 2. Tauri: probe a command that always resolves inside a Tauri
    //    webview (ollama_status never errors) but rejects in a browser.
    try {
      const core = await import("@tauri-apps/api/core");
      await core.invoke("ollama_status"); // throws outside a Tauri webview
      const ev = await import("@tauri-apps/api/event");
      return {
        shell: "tauri" as const,
        invoke: <T,>(cmd: string, payload?: Record<string, unknown>) =>
          core.invoke<T>(cmd, payload),
        listen: <T,>(event: string, cb: (payload: T) => void) =>
          ev.listen<T>(event, (e) => cb(e.payload)),
      };
    } catch {
      // 3. Plain browser dev preview.
      return {
        shell: "browser" as const,
        invoke: async <T,>(cmd: string): Promise<T> => {
          if (cmd === "ollama_status") return fetchOllamaStatus() as Promise<T>;
          throw new Error("no backend: run in Electron or Tauri");
        },
        listen: () => Promise.resolve(() => {}),
      };
    }
  })();

  return cached;
}