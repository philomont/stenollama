// Electron main process for Stenollama (Linux shell).
//
// Why this exists: WebKitGTK (Tauri's engine on Linux) is broken on some
// Ubuntu 26.04 systems — a plain WebKitGTK window can't load any page
// (see docs/troubleshooting.md). Chromium works. The React frontend is
// shared via the src/api.ts shell adapter; this shell ports the Rust
// backend contract:
//   commands: ollama_status, capture_start, capture_stop, capture_elapsed
//   events:   capture:level, capture:stopped
// The Rust/Tauri backend remains for Windows/macOS builds.

const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const CHUNK_MS = 100;
const LEVEL_EVENT_INTERVAL_MS = 300;
const VITE_DEV_URL = process.env.VITE_DEV_URL || "http://localhost:1420";

let mainWindow = null;
let active = null; // active capture session

// ------------------------------------------------------------------ utils

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function pad(n, w) {
  return String(n).padStart(w, "0");
}

// Howard Hinnant's civil-from-days (UTC in v0, same as the Rust backend).
function civilFromDays(z) {
  z += 719468;
  const era = Math.trunc(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.trunc((doe - Math.trunc(doe / 1460) + Math.trunc(doe / 36524) - Math.trunc(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.trunc(yoe / 4) - Math.trunc(yoe / 100));
  const mp = Math.trunc((5 * doy + 2) / 153);
  const d = doy - Math.trunc((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

function utcStamp() {
  const secs = Math.floor(Date.now() / 1000);
  const [y, m, d] = civilFromDays(Math.floor(secs / 86400));
  const rem = secs % 86400;
  return {
    name: `${y}-${pad(m, 2)}-${pad(d, 2)}-${pad(Math.floor(rem / 3600), 2)}${pad(Math.floor((rem % 3600) / 60), 2)}`,
    iso: `${y}-${pad(m, 2)}-${pad(d, 2)}T${pad(Math.floor(rem / 3600), 2)}:${pad(Math.floor((rem % 3600) / 60), 2)}:${pad(rem % 60, 2)}Z`,
  };
}

function wavHeader(dataLen) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(CHANNELS, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28); // byte rate
  h.writeUInt16LE(CHANNELS * 2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write("data", 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
}

function dbfs(rms) {
  return rms <= 0 ? -90 : Math.max(-90, 20 * Math.log10(rms / 32768));
}

function notebooksRoot() {
  return path.join(os.homedir(), "Stenollama", "notebooks");
}

// ------------------------------------------------------------------ ollama

async function probeOllama() {
  const status = { local_online: false, local_version: null, cloud_online: false };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const resp = await fetch("http://127.0.0.1:11434/api/version", {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (resp.ok) {
      status.local_online = true;
      status.local_version = (await resp.json()).version ?? null;
    }
  } catch {
    /* local daemon offline */
  }

  const key = process.env.OLLAMA_API_KEY;
  if (key) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const resp = await fetch("https://ollama.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      status.cloud_online = resp.ok;
    } catch {
      /* cloud unreachable */
    }
  }
  return status;
}

// ----------------------------------------------------------------- capture

// Default sink's monitor source (PipeWire/PulseAudio) — spike #15 chain.
async function defaultSinkMonitor() {
  const status = await run("wpctl", ["status"]);
  let inSinks = false;
  let sinkId = null;
  for (const line of status.split("\n")) {
    const t = line.trim();
    if (t.endsWith("Sinks:")) {
      inSinks = true;
      continue;
    }
    if (inSinks && t.endsWith("Sources:")) break;
    if (inSinks && sinkId === null && line.includes("*")) {
      const digits = line.split("*")[1].trim().match(/^\d+/);
      if (digits) sinkId = digits[0];
    }
  }
  if (!sinkId) throw new Error("no default sink found in wpctl status");

  const info = await run("pw-cli", ["info", sinkId]);
  for (const raw of info.split("\n")) {
    const line = raw.trim().replace(/^\*/, "").trim();
    const m = line.match(/^node\.name = "([^"]+)"/);
    if (m) return `${m[1]}.monitor`;
  }
  throw new Error("node.name not found via pw-cli");
}

// Finalize the active session: patch RIFF header, write session.yaml,
// emit capture:stopped, clear state.
function finalizeSession(reason) {
  if (!active) return;
  const s = active;
  active = null;

  try {
    s.ffmpeg.kill("SIGKILL");
  } catch {}

  const duration = s.sampleCount / (SAMPLE_RATE * CHANNELS);
  try {
    const header = wavHeader(s.dataLen);
    fs.writeSync(s.fd, header.subarray(4, 8), 0, 4, 4); // riff size
    fs.writeSync(s.fd, header.subarray(40, 44), 0, 4, 40); // data size
    fs.closeSync(s.fd);
  } catch {}

  try {
    fs.writeFileSync(
      path.join(s.sessionDir, "session.yaml"),
      `schemaVersion: 0\nstartedAt: ${s.startedIso}\nendedAt: ${utcStamp().iso}\naudio:\n  file: audio.wav\n  sampleRate: ${SAMPLE_RATE}\n  channels: ${CHANNELS}\n  durationSec: ${duration.toFixed(3)}\n  clock: sample-count\ncapture:\n  source: system-output-monitor\n  device: ${s.monitor}\ntranscription:\n  engine: ollama-gemma4\n  model: gemma4:e4b\n`,
    );
  } catch {}

  mainWindow?.webContents.send("capture:stopped", {
    session_dir: s.sessionDir,
    duration_sec: duration,
    reason,
  });
}

async function captureStart(notebook) {
  if (active) throw new Error("a capture session is already active");

  const monitor = await defaultSinkMonitor();
  const { name, iso } = utcStamp();
  const sessionDir = path.join(notebooksRoot(), notebook, "sessions", name);
  fs.mkdirSync(sessionDir, { recursive: true });

  // Session files per SPEC-storage v0.1.
  fs.writeFileSync(path.join(sessionDir, "transcript.jsonl"), "");
  fs.writeFileSync(path.join(sessionDir, "highlights.jsonl"), "");
  fs.writeFileSync(
    path.join(sessionDir, "notes.md"),
    `---\nschemaVersion: 0\nanchors: []\nhighlights: []\ntags: []\n---\n\n## Session ${name}\n`,
  );

  const fd = fs.openSync(path.join(sessionDir, "audio.wav"), "w");
  fs.writeSync(fd, wavHeader(0));

  let finished = false;
  const s = {
    sessionDir,
    startedIso: iso,
    monitor,
    fd,
    ffmpeg: null,
    sampleCount: 0,
    dataLen: 0,
  };

  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "pulse", "-i", monitor,
      "-ac", "1", "-ar", String(SAMPLE_RATE),
      "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  s.ffmpeg = ffmpeg;
  active = s;

  let lastLevelAt = 0;
  const chunkLen = (SAMPLE_RATE * CHANNELS * 2 * CHUNK_MS) / 1000;

  ffmpeg.on("error", () => {
    if (!finished) {
      finished = true;
      finalizeSession("device-lost");
    }
  });

  ffmpeg.stdout.on("data", (buf) => {
    let off = 0;
    while (off < buf.length) {
      const chunk = buf.subarray(off, Math.min(off + chunkLen, buf.length));
      off += chunk.length;
      try {
        fs.writeSync(fd, chunk);
      } catch {}
      s.dataLen += chunk.length;
      s.sampleCount += Math.floor(chunk.length / 2);

      const now = Date.now();
      if (now - lastLevelAt >= LEVEL_EVENT_INTERVAL_MS) {
        lastLevelAt = now;
        let sumSq = 0;
        let n = 0;
        for (let i = 0; i + 1 < chunk.length; i += 2) {
          const v = chunk.readInt16LE(i);
          sumSq += v * v;
          n++;
        }
        const rms = Math.sqrt(sumSq / Math.max(1, n));
        mainWindow?.webContents.send("capture:level", {
          elapsed_sec: s.sampleCount / (SAMPLE_RATE * CHANNELS),
          rms_dbfs: dbfs(rms),
        });
      }
    }
  });

  ffmpeg.stdout.on("end", () => {
    if (!finished) {
      finished = true;
      finalizeSession("end-of-stream");
    }
  });

  ffmpeg.on("close", () => {
    if (!finished) {
      finished = true;
      finalizeSession("stopped");
    }
  });

  return sessionDir;
}

// ------------------------------------------------------------------- ipc

ipcMain.handle("ollama_status", () => probeOllama());

ipcMain.handle("capture_start", (_e, notebook) => captureStart(notebook || "Inbox"));

ipcMain.handle("capture_stop", () => {
  if (!active) throw new Error("no active capture session");
  const dir = active.sessionDir;
  finalizeSession("stopped");
  return dir;
});

ipcMain.handle("capture_elapsed", () => {
  if (!active) throw new Error("no active capture session");
  return active.sampleCount / (SAMPLE_RATE * CHANNELS);
});

// ---------------------------------------------------------------- window

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Stenollama",
    darkTheme: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (!app.isPackaged) {
    mainWindow.loadURL(VITE_DEV_URL);
    if (process.env.STENO_DEVTOOLS) mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("[stenollama] electron: page FINISHED load");
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  finalizeSession("stopped");
  app.quit();
});