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

// ---- live transcription (gemma4 / qwen3-asr via local Ollama) ----
// Fixed windows with an energy gate: only speech-containing windows are sent
// to Ollama. Overlap gives the model continuity context. gemma4 requires
// WAV/RIFF, 16kHz mono, <= ~60s per request (see issue #11 findings).
const ASR_MODEL_ENV = process.env.STENO_ASR_MODEL || "";
const ASR_MODEL_PREFS = ["gemma4:e4b", "frozenlab/qwen3-asr"];
const ASR_WINDOW_SEC = 20;
const ASR_MIN_SEC = 4; // don't send windows shorter than this (except at stop)
const ASR_OVERLAP_SEC = 0.5;
const ASR_SILENCE_DBFS = -55; // windows below this peak energy are skipped
const ASR_TIMEOUT_MS = 120_000;
const OLLAMA_LOCAL = process.env.STENO_OLLAMA_HOST || "http://127.0.0.1:11434";

async function resolveAsrModel() {
  if (ASR_MODEL_ENV) return ASR_MODEL_ENV; // explicit override wins
  try {
    const resp = await fetch(`${OLLAMA_LOCAL}/api/tags`);
    if (resp.ok) {
      const { models = [] } = await resp.json();
      const names = new Set();
      for (const m of models) {
        names.add(m.name); // full: "frozenlab/qwen3-asr:latest"
        names.add(m.name.split(":")[0]); // base: "frozenlab/qwen3-asr"
      }
      for (const candidate of ASR_MODEL_PREFS) {
        if (names.has(candidate)) return candidate;
      }
    }
  } catch {
    /* daemon down; fall through to the default and let the request fail */
  }
  return ASR_MODEL_PREFS[0];
}

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
  try {
    s.asrFlush?.();
  } catch {}
  try {
    fs.closeSync(s.readFd);
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
  const asrModel = await resolveAsrModel();
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

  const wavPath = path.join(sessionDir, "audio.wav");
  const fd = fs.openSync(wavPath, "w");
  const readFd = fs.openSync(wavPath, "r");
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
    // transcription engine state
    asrModel,
    readFd,
    asrNextSample: 0, // first sample of the next window
    asrSegmentNo: 0,
    asrModelWarned: false,
    chunkEnergy: [], // [{ startSample, endSample, rms }] for the energy gate
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
        s.chunkEnergy.push({
          startSample: s.sampleCount - Math.floor(chunk.length / 2),
          endSample: s.sampleCount,
          rms,
        });
        // keep only the current + previous window worth of energy records
        if (s.chunkEnergy.length > (SAMPLE_RATE * ASR_WINDOW_SEC * 10) / CHUNK_MS + 50) {
          s.chunkEnergy.splice(0, s.chunkEnergy.length - 200);
        }
        mainWindow?.webContents.send("capture:level", {
          elapsed_sec: s.sampleCount / (SAMPLE_RATE * CHANNELS),
          rms_dbfs: dbfs(rms),
        });
      }
    }
  });

  // Kick the transcription timer.
  startAsrLoop(s);

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

// ----------------------------------------------------------------- asr

// Extract [startSample, endSample) PCM from the growing WAV and wrap it in a
// standalone WAV container (gemma4 needs RIFF).
function extractWavSlice(s, startSample, endSample) {
  const byteStart = 44 + startSample * 2;
  const byteLen = (endSample - startSample) * 2;
  const buf = Buffer.alloc(byteLen);
  let total = 0;
  while (total < byteLen) {
    const n = fs.readSync(s.readFd, buf, total, byteLen - total, byteStart + total);
    if (n === 0) break;
    total += n;
  }
  return Buffer.concat([wavHeader(total), buf.subarray(0, total)]);
}

// Peak RMS over the window's energy records — the gate that avoids sending
// silence to Ollama.
function windowEnergyDbfs(s, startSample, endSample) {
  let peak = 0;
  for (const c of s.chunkEnergy) {
    if (c.endSample <= startSample) continue;
    if (c.startSample >= endSample) break;
    if (c.rms > peak) peak = c.rms;
  }
  return dbfs(peak);
}

async function transcribeSlice(s, startSample, endSample) {
  const model = s.asrModel;
  const wav = extractWavSlice(s, startSample, endSample);
  const body = {
    model,
    stream: false,
    options: { temperature: 0 },
    messages: [
      {
        role: "user",
        content:
          "Transcribe this audio verbatim. Output only the spoken words, " +
            "no commentary, no timestamps.",
        images: [wav.toString("base64")],
      },
    ],
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ASR_TIMEOUT_MS);
  try {
    const resp = await fetch(`${OLLAMA_LOCAL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text();
      if (!s.asrModelWarned) {
        s.asrModelWarned = true;
        let guidance;
        if (resp.status === 404) {
          guidance =
            `Model ${model} not found on the local Ollama daemon. ` +
            `Run: ollama pull ${model} — or set STENO_ASR_MODEL.`;
        } else {
          guidance =
            `Transcription failed (${resp.status}): ${detail.slice(0, 160)} ` +
            `If the runner cannot load the model, update Ollama: ` +
            `curl -fsSL https://ollama.com/install.sh | sh`;
        }
        mainWindow?.webContents.send("transcript:error", { message: guidance });
      }
      console.error(`[stenollama] asr http ${resp.status}: ${detail.slice(0, 200)}`);
      return;
    }
    const out = await resp.json();
    const text = (out?.message?.content || "").trim();
    if (!text) return;

    const seg = {
      schemaVersion: 0,
      id: `seg-${String(++s.asrSegmentNo).padStart(6, "0")}`,
      start: startSample / SAMPLE_RATE,
      end: endSample / SAMPLE_RATE,
      text,
      confidence: null,
    };
    try {
      fs.appendFileSync(path.join(s.sessionDir, "transcript.jsonl"), JSON.stringify(seg) + "\n");
    } catch {}
    mainWindow?.webContents.send("transcript:segment", seg);
  } catch (e) {
    if (e.name !== "AbortError") console.error("[stenollama] asr failed:", e.message);
  } finally {
    clearTimeout(t);
  }
}

// Window loop: every 2s tick, send a slice once a full ASR window has
// accumulated and it contains speech. Windows serialize (one at a time).
function startAsrLoop(s) {
  const overlap = Math.floor(ASR_OVERLAP_SEC * SAMPLE_RATE);
  const minSamples = ASR_MIN_SEC * SAMPLE_RATE;

  const timer = setInterval(async () => {
    if (!active || active.sessionDir !== s.sessionDir) {
      clearInterval(timer);
      return;
    }
    const end = s.sampleCount;
    if (end - s.asrNextSample < ASR_WINDOW_SEC * SAMPLE_RATE) return;

    const start = s.asrNextSample;
    s.asrNextSample = Math.max(start + minSamples, end - overlap);

    if (windowEnergyDbfs(s, start, end) < ASR_SILENCE_DBFS) return;
    if (s.asrBusy) return;
    s.asrBusy = true;
    try {
      await transcribeSlice(s, start, end);
    } finally {
      s.asrBusy = false;
    }
  }, 2000);

  // On stop, flush any remaining partial window >= ASR_MIN_SEC.
  s.asrFlush = () => {
    clearInterval(timer);
    const start = s.asrNextSample;
    const end = s.sampleCount;
    if (end - start >= minSamples && windowEnergyDbfs(s, start, end) >= ASR_SILENCE_DBFS) {
      transcribeSlice(s, start, end).catch(() => {});
    }
  };
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