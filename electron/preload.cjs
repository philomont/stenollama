// Preload: expose the backend contract to the renderer under window.steno,
// mirroring the Tauri command/event API so src/api.ts can adapt to either
// shell. contextIsolation is on; nothing else leaks.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("steno", {
  shell: "electron",

  invoke: (channel, payload) => {
    switch (channel) {
      case "ollama_status":
        return ipcRenderer.invoke("ollama_status");
      case "capture_start":
        return ipcRenderer.invoke("capture_start", payload?.notebook);
      case "capture_stop":
        return ipcRenderer.invoke("capture_stop");
      case "capture_elapsed":
        return ipcRenderer.invoke("capture_elapsed");
      case "ai_margin_comment":
      case "ai_selection_chat":
      case "ai_entry_summary":
      case "entry_summary_add":
      case "flag_add":
      case "review_notes_save":
      case "reaction_add":
      case "attachment_add":
      case "margin_add":
      case "note_add":
      case "note_edit":
        return ipcRenderer.invoke(channel, payload);
      default:
        return Promise.reject(new Error(`unknown steno channel: ${channel}`));
    }
  },

  on: (channel, listener) => {
    if (!channel.startsWith("capture:") && !channel.startsWith("transcript:")) {
      throw new Error(`unallowed steno event: ${channel}`);
    }
    const wrapped = (_e, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});