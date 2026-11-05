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

// ---- live transcription (whisper.cpp local | gemma4/qwen3-asr via Ollama) ----
// Fixed windows with an energy gate: only speech-containing windows are sent.
// Engine resolution order:
//   1. whisper.cpp sidecar at ~/.stenollama/tools/whisper-cli with a ggml
//      model in ~/.stenollama/models (preferred: fully local, no Ollama
//      version dependency; STENO_WHISPER_MODEL overrides the model choice)
//   2. Ollama audio model (STENO_ASR_MODEL override, else first of
//      gemma4:e4b / frozenlab/qwen3-asr present locally)
const ASR_MODEL_ENV = process.env.STENO_ASR_MODEL || "";
const ASR_MODEL_PREFS = ["gemma4:e4b", "frozenlab/qwen3-asr"];
const STENO_HOME = path.join(os.homedir(), ".stenollama");
const WHISPER_BIN = process.env.STENO_WHISPER_BIN || path.join(STENO_HOME, "tools", "whisper-cli");
const WHISPER_MODEL_PREFS = [
  process.env.STENO_WHISPER_MODEL,
  "ggml-small.en.bin",
  "ggml-base.en.bin",
].filter(Boolean);
const ASR_WINDOW_SEC = 20;
const ASR_MIN_SEC = 4; // don't send windows shorter than this (except at stop)
const ASR_OVERLAP_SEC = 0.5;
const ASR_SILENCE_DBFS = -55; // windows below this peak energy are skipped
const ASR_TIMEOUT_MS = 120_000;
const OLLAMA_LOCAL = process.env.STENO_OLLAMA_HOST || "http://127.0.0.1:11434";

function whisperModelPath() {
  for (const m of WHISPER_MODEL_PREFS) {
    const p = path.isAbsolute(m) ? m : path.join(STENO_HOME, "models", m);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function resolveAsrEngine() {
  // Explicit Ollama model selection skips the whisper path.
  if (ASR_MODEL_ENV) return { engine: "ollama", model: ASR_MODEL_ENV };
  if (fs.existsSync(WHISPER_BIN)) {
    const model = whisperModelPath();
    if (model) {
      return { engine: "whisper", model, label: `whisper ${path.basename(model)}` };
    }
  }
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
        if (names.has(candidate)) return { engine: "ollama", model: candidate };
      }
    }
  } catch {
    /* daemon down */
  }
  return { engine: "ollama", model: ASR_MODEL_PREFS[0] };
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
      `schemaVersion: 1\nstartedAt: ${s.startedIso}\nendedAt: ${utcStamp().iso}\naudio:\n  sampleRate: ${SAMPLE_RATE}\n  channels: ${CHANNELS}\n  clock: wall-clock-datetime\n  burstsFile: bursts.jsonl\ncapture:\n  source: ${s.source === "mic" ? "microphone" : "system-output-monitor"}\n  device: ${s.monitor}\ntranscription:\n  engine: ${s.asrEngine === "whisper" ? "whisper.cpp" : "ollama"}\n  model: ${s.asrModel}\nlastBurst:\n  index: ${s.burstIndex}\n  file: ${s.audioFile}\n  durationSec: ${duration.toFixed(3)}\n`,
    );
  } catch {}

  mainWindow?.webContents.send("capture:stopped", {
    session_dir: s.sessionDir,
    duration_sec: duration,
    reason,
  });
}

async function captureStart(notebook, opts = {}) {
  if (active) throw new Error("a capture session is already active");

  const monitor = await defaultSinkMonitor();
  const engine = await resolveAsrEngine();
  const { name, iso } = utcStamp();

  // One timeline per notebook: a new recording resumes the latest session as
  // a new burst (horizontal bar). Fresh sessions only via opts.fresh.
  const nbSessions = path.join(notebooksRoot(), notebook, "sessions");
  let sessionDir = null;
  let resumed = false;
  if (!opts.fresh) {
    try {
      const dirs = fs.readdirSync(nbSessions).filter((d) => /^\d{4}-/.test(d)).sort();
      const last = dirs[dirs.length - 1];
      if (last) {
        const candidate = path.join(nbSessions, last);
        if (fs.existsSync(path.join(candidate, "session.yaml"))) {
          sessionDir = candidate;
          resumed = true;
        }
      }
    } catch {}
  }
  if (!sessionDir) {
    sessionDir = path.join(nbSessions, name);
    fs.mkdirSync(sessionDir, { recursive: true });
    // Session files per SPEC-storage.
    fs.writeFileSync(path.join(sessionDir, "transcript.jsonl"), "");
    fs.writeFileSync(path.join(sessionDir, "highlights.jsonl"), "");
    fs.writeFileSync(
      path.join(sessionDir, "notes.md"),
      `---\nschemaVersion: 0\nanchors: []\nhighlights: []\ntags: []\n---\n\n## Session ${name}\n`,
    );
  }

  // Burst audio: audio-001.wav, audio-002.wav, ...
  let burstIndex = 1;
  while (fs.existsSync(path.join(sessionDir, `audio-${String(burstIndex).padStart(3, "0")}.wav`))) {
    burstIndex += 1;
  }
  const audioFile = `audio-${String(burstIndex).padStart(3, "0")}.wav`;
  const wavPath = path.join(sessionDir, audioFile);
  const fd = fs.openSync(wavPath, "w");
  const readFd = fs.openSync(wavPath, "r");
  fs.writeSync(fd, wavHeader(0));

  // Wall-clock start of this burst — every segment gets a datetime stamp.
  const burstStartMs = Date.now();

  try {
    fs.appendFileSync(
      path.join(sessionDir, "bursts.jsonl"),
      JSON.stringify({ schemaVersion: 0, index: burstIndex, file: audioFile, startedAt: iso }) + "\n",
    );
  } catch {}

  let finished = false;
  const s = {
    sessionDir,
    startedIso: iso,
    burstIndex,
    audioFile,
    burstStartMs,
    monitor,
    fd,
    ffmpeg: null,
    sampleCount: 0,
    dataLen: 0,
    // transcription engine state
    asrEngine: engine.engine,
    asrModel: engine.model,
    readFd,
    asrNextSample: 0, // first sample of the next window
    asrSegmentNo: 0,
    asrModelWarned: false,
    chunkEnergy: [], // [{ startSample, endSample, rms }] for the energy gate
  };
  mainWindow?.webContents.send("transcript:engine", {
    engine: engine.engine,
    label: engine.label || engine.model,
  });

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

  active = s;

  return { sessionDir, burstIndex, resumed, at: iso };
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

// Transcribe via the whisper.cpp sidecar. Returns the text or throws.
function whisperTranscribe(s, wav) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(s.sessionDir, `.asr-${Date.now()}.wav`);
    fs.writeFileSync(tmp, wav);
    const args = [
      "-m", s.asrModel,
      "-f", tmp,
      "-nt", "-np", // no timestamps, no progress prints
      "-l", process.env.STENO_ASR_LANG || "auto",
    ];
    const child = spawn(WHISPER_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("whisper timeout"));
    }, ASR_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        fs.unlinkSync(tmp);
      } catch {}
      if (code === 0) {
        const t = out.trim();
        // whisper hallucinates bracketed placeholders on near-silent audio
        if (!t || /^(\[[\w ]*\]|[.,!?\s]*)$/.test(t)) resolve("");
        else resolve(t);
      }
      else reject(new Error(`whisper exited ${code}: ${err.slice(0, 160)}`));
    });
  });
}

async function transcribeSlice(s, startSample, endSample) {
  // Tell the UI this block is being transcribed (amber state)
  mainWindow?.webContents.send("transcript:processing", {
    blockIndex: Math.floor(startSample / (SAMPLE_RATE * 20)),
  });
  const wav = extractWavSlice(s, startSample, endSample);
  try {
    let text;
    if (s.asrEngine === "whisper") {
      text = (await whisperTranscribe(s, wav)).trim();
    } else {
      const body = {
        model: s.asrModel,
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
                `Model ${s.asrModel} not found on the local Ollama daemon. ` +
                `Run: ollama pull ${s.asrModel} — or set STENO_ASR_MODEL.`;
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
        text = (out?.message?.content || "").trim();
      } finally {
        clearTimeout(t);
      }
    }
    if (!text) return;

    // Wall-clock stamp for the timeline (datetime, not recording-relative).
    const at = new Date(s.burstStartMs + (startSample / SAMPLE_RATE) * 1000).toISOString();
    const seg = {
      schemaVersion: 0,
      id: `seg-${String(++s.asrSegmentNo).padStart(6, "0")}`,
      at,
      start: startSample / SAMPLE_RATE,
      end: endSample / SAMPLE_RATE,
      burst: s.burstIndex,
      text,
      confidence: null,
    };
    try {
      fs.appendFileSync(path.join(s.sessionDir, "transcript.jsonl"), JSON.stringify(seg) + "\n");
    } catch {}
    mainWindow?.webContents.send("transcript:segment", seg);
  } catch (e) {
    if (!s.asrModelWarned) {
      s.asrModelWarned = true;
      mainWindow?.webContents.send("transcript:error", {
        message: `Transcription engine failed: ${e.message}`,
      });
    }
    console.error("[stenollama] asr failed:", e.message);
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

// ---------------------------------------------------- margin llm
// Cloud text models via the local Ollama daemon (user direction: cloud for
// text, local for audio). Margin comments + selection chat run on this model.
const LLM_MODEL_ENV = process.env.STENO_LLM_MODEL || "";
const LLM_MODEL_PREFS = [
  "glm-5.3-flash:cloud",
  "glm-5.2:cloud",
  "qwen3.5:cloud",
  "gemma4:cloud",
  "minimax-m3.1-flash:cloud",
];

async function resolveLlmModel() {
  if (LLM_MODEL_ENV) return LLM_MODEL_ENV;
  try {
    const resp = await fetch(`${OLLAMA_LOCAL}/api/tags`);
    if (resp.ok) {
      const { models = [] } = await resp.json();
      const names = new Set();
      for (const m of models) {
        names.add(m.name);
        names.add(m.name.split(":")[0]);
      }
      for (const candidate of LLM_MODEL_PREFS) {
        if (names.has(candidate)) return candidate;
      }
    }
  } catch {}
  return LLM_MODEL_PREFS[1];
}

async function llmChat(model, system, user, timeoutMs = 90_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${OLLAMA_LOCAL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0.2 },
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: user },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`llm http ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
    const out = await resp.json();
    return (out?.message?.content || "").trim();
  } finally {
    clearTimeout(t);
  }
}

// Naive resource search across all notebooks (v1; the derived FTS index is
// the eventual replacement — issue #63). Scores transcript segments and note
// lines by keyword hits and returns the top excerpts with provenance.
const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "what", "who", "when",
  "where", "why", "how", "was", "were", "are", "you", "about", "from",
  "into", "have", "has", "had", "not", "but", "our", "their", "there",
  "then", "than", "them", "will", "would", "could", "should", "does",
  "did", "being", "been", "which", "while", "your", "can", "tell", "explain",
]);

function keywords(text) {
  return [...new Set(
    (text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [])
      .filter((w) => !STOPWORDS.has(w)),
  )].slice(0, 12);
}

function scoreText(text, words) {
  const low = text.toLowerCase();
  let score = 0;
  for (const w of words) {
    const hits = low.split(w).length - 1;
    if (hits > 0) score += 1 + Math.log2(hits);
  }
  return score;
}

function searchResources(query, words, limit = 6) {
  const results = [];
  const notebooksDir = notebooksRoot();
  let notebooks;
  try {
    notebooks = fs.readdirSync(notebooksDir);
  } catch {
    return results;
  }
  for (const nb of notebooks) {
    const sessionsDir = path.join(notebooksDir, nb, "sessions");
    let sessions;
    try {
      sessions = fs.readdirSync(sessionsDir);
    } catch {
      continue;
    }
    for (const sess of sessions) {
      const dir = path.join(sessionsDir, sess);
      // transcript segments
      const transcriptPath = path.join(dir, "transcript.jsonl");
      try {
        const lines = fs.readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const seg = JSON.parse(line);
            const s = scoreText(seg.text || "", words);
            if (s > 0) {
              results.push({
                source: `${nb}/${sess} @ ${Math.floor(seg.start || 0)}s`,
                text: seg.text,
                score: s,
              });
            }
          } catch {}
        }
      } catch {}
      // notes
      const notesPath = path.join(dir, "notes.md");
      try {
        const notes = fs.readFileSync(notesPath, "utf8");
        for (const para of notes.split(/\n\s*\n/)) {
          const body = para.replace(/^---[\s\S]*?---/, "").trim();
          if (!body) continue;
          const s = scoreText(body, words);
          if (s > 0) {
            results.push({ source: `${nb}/${sess} notes`, text: body.slice(0, 400), score: s });
          }
        }
      } catch {}
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

function fmtT(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function appendMargin(sessionDir, entry, file = "margin.jsonl") {
  const record = { schemaVersion: 0, createdAt: new Date().toISOString(), ...entry };
  try {
    if (sessionDir) fs.appendFileSync(path.join(sessionDir, file), JSON.stringify(record) + "\n");
  } catch {}
  return record;
}

// ------------------------------------------------------------------- ipc

ipcMain.handle("ollama_status", () => probeOllama());

ipcMain.handle("capture_start", (_e, p) => captureStart(p?.notebook || "Inbox", { fresh: !!p?.fresh }));

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

// ---- margin column ----

// AI margin comment during capture: linked to the tape time AND the note
// block the user was typing. Only fired by user typing activity (renderer
// debounces); the model may decline ((none)).
ipcMain.handle("ai_margin_comment", async (_e, p) => {
  const model = await resolveLlmModel();
  const system =
    "You are the margin of a steno pad. The user is listening to a live event " +
    "and jotting notes. Write ONE brief margin comment that helps the user: " +
    "fix a spelling or grammar error in the note, add a concrete fact or " +
    "correction drawn from the transcript, connect the note to what was just " +
    "said, or flag an action or followup. Keep it under 25 words, no preamble. " +
    "Reply with exactly (none) only if the note is complete and accurate and " +
    "you truly have nothing useful to add.";
  const user =
    `Tape time: ${fmtT(p.atSec || 0)}\n` +
    `Recent transcript: ${JSON.stringify((p.transcriptWindow || "").slice(0, 1500))}\n` +
    `User's note block: ${JSON.stringify((p.noteBlock || "").slice(0, 600))}`;
  let answer;
  try {
    answer = (await llmChat(model, system, user)).trim();
  } catch (err) {
    mainWindow?.webContents.send("transcript:error", {
      message: `Margin AI failed: ${err.message}`,
    });
    return null;
  }
  if (!answer || answer === "(none)") return null;
  return appendMargin(p.sessionDir, {
    kind: "comment",
    author: "ai",
    at: p.at || new Date().toISOString(),
    atSec: p.atSec ?? null,
    noteContext: (p.noteBlock || "").slice(0, 300) || null,
    model,
    text: answer,
  });
});

// Selection chat: user selected a passage (transcript or notes) and asks a
// question; the answer may draw on material from other notebook sessions.
ipcMain.handle("ai_selection_chat", async (_e, p) => {
  const model = await resolveLlmModel();
  const selection = (p.selection || "").slice(0, 1200);
  const question = (p.question || "").slice(0, 800);
  const context = (p.context || "").slice(0, 1200);
  const words = [...new Set([...keywords(selection), ...keywords(question)])];
  const resources = searchResources(question, words);
  const system =
    "You are the AI margin of a steno notebook. The user selected a passage " +
    "and asks a question. Use the selected text, the surrounding context, and " +
    "the resource excerpts. When you use a resource, name it like " +
    "[Inbox/2026-11-03-1900]. 2-5 sentences. No preamble.";
  const user =
    `Selected passage: ${JSON.stringify(selection)}\n` +
    `Surrounding context: ${JSON.stringify(context)}\n` +
    (resources.length
      ? `Resources from the user's other sessions:\n${resources
          .map((r) => `- [${r.source}] ${JSON.stringify(r.text.slice(0, 400))}`)
          .join("\n")}\n`
      : "") +
    `Question: ${JSON.stringify(question)}`;
  let answer;
  try {
    answer = await llmChat(model, system, user);
  } catch (err) {
    mainWindow?.webContents.send("transcript:error", {
      message: `Selection chat failed: ${err.message}`,
    });
    return null;
  }
  return appendMargin(p.sessionDir, {
    kind: "chat",
    author: "human->ai",
    atSec: p.atSec ?? null,
    selection,
    question,
    model,
    text: answer || "(no answer)",
  });
});

// Persist a user note block to the session's notes.jsonl (SPEC v0.3).
ipcMain.handle("note_add", (_e, p) => {
  return appendMargin(p.sessionDir, {
    kind: "note",
    id: `note-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
    at: p.at || new Date().toISOString(),
    startSec: typeof p.startSec === "number" ? p.startSec : null,
    endSec: typeof p.endSec === "number" ? p.endSec : null,
    text: String(p.text || "").slice(0, 4000),
    tags: Array.isArray(p.tags) ? p.tags.slice(0, 12).map(String) : [],
    selectionRef: p.selectionRef ? String(p.selectionRef).slice(0, 1500) : null,
    image: p.image ? String(p.image).slice(0, 500) : null,
  }, "notes.jsonl");
});

// Edit an existing note (append-only edit history; last write wins per id).
ipcMain.handle("note_edit", (_e, p) => {
  return appendMargin(p.sessionDir, {
    kind: "note-edit",
    id: String(p.id || ""),
    at: p.at || new Date().toISOString(),
    text: String(p.text || "").slice(0, 4000),
  }, "notes.jsonl");
});

// Per-entry AI summary, appended to the end of the entry in the stream.
ipcMain.handle("ai_entry_summary", async (_e, p) => {
  const model = await resolveLlmModel();
  const system =
    "You summarize one entry of a steno-pad timeline (a transcript segment " +
    "or a user note). Reply with a single terse line, max 12 words, no " +
    "preamble, that captures the essence so it can be found later in a " +
    "scroll marker.";
  const user =
    `Entry: ${JSON.stringify(String(p.text || "").slice(0, 1000))}\n` +
    `Neighbors for context: ${JSON.stringify((p.neighbors || []).slice(0, 3).join(" | ").slice(0, 800))}`;
  try {
    const summary = (await llmChat(model, system, user)).split("\n")[0].slice(0, 200);
    return summary || null;
  } catch (err) {
    mainWindow?.webContents.send("transcript:error", {
      message: `Summary failed: ${err.message}`,
    });
    return null;
  }
});

ipcMain.handle("entry_summary_add", (_e, p) => {
  return appendMargin(p.sessionDir, {
    kind: "summary",
    refId: String(p.refId || ""),
    at: p.at || new Date().toISOString(),
    model: p.model || null,
    text: String(p.text || "").slice(0, 400),
  }, "summaries.jsonl");
});

// Block summaries: summarize one recording block, using the previous few
// blocks' summaries as context. Closes the block (frontend tracks closure).
ipcMain.handle("ai_block_summary", async (_e, p) => {
  const model = await resolveLlmModel();
  const system =
    "You write the summary card that closes a recording block of a " +
    "steno-pad timeline. Summarize ONLY the given block in 2-4 terse " +
    "sentences: what was said, decisions, actions, open questions. You may " +
    "use the previous block summaries for continuity, but never summarize " +
    "their content again. No preamble.";
  const user =
    (p.previousSummaries?.length
      ? `Previous block summaries (context only):\n${p.previousSummaries
          .slice(-3)
          .map((s, i) => `${i + 1}. ${JSON.stringify(String(s).slice(0, 400))}`)
          .join("\n")}\n\n`
      : "") +
    `Block content (transcript + notes, chronological):\n${JSON.stringify(String(p.content || "").slice(0, 6000))}`;
  try {
    return (await llmChat(model, system, user, 120_000)).slice(0, 1200);
  } catch (err) {
    mainWindow?.webContents.send("transcript:error", {
      message: `Block summary failed: ${err.message}`,
    });
    return null;
  }
});

ipcMain.handle("block_summary_add", (_e, p) => {
  return appendMargin(p.sessionDir, {
    kind: "block-summary",
    refId: `block-${p.blockIndex}`,
    at: p.at || new Date().toISOString(),
    model: p.model || null,
    text: String(p.text || "").slice(0, 2000),
  }, "summaries.jsonl");
});

// List previous recording sessions from the notebooks directory.
ipcMain.handle("list_sessions", async () => {
  const notebooksRoot = path.join(os.homedir(), "Stenollama", "notebooks");
  const sessions = [];
  try {
    const notebooks = fs.readdirSync(notebooksRoot);
    for (const nb of notebooks) {
      const nbSessions = path.join(notebooksRoot, nb, "sessions");
      let dirs;
      try {
        dirs = fs.readdirSync(nbSessions).filter((d) => /^\d{4}-/.test(d)).sort().reverse();
      } catch { continue; }
      for (const sess of dirs.slice(0, 10)) {
        const sessDir = path.join(nbSessions, sess);
        // Read session.yaml for endedAt
        let endedAt = null;
        try {
          const y = fs.readFileSync(path.join(sessDir, "session.yaml"), "utf8");
          const m = y.match(/endedAt: (.+)/);
          if (m) endedAt = m[1].trim();
        } catch {}
        // Count transcript segments
        let segCount = 0;
        try {
          const t = fs.readFileSync(path.join(sessDir, "transcript.jsonl"), "utf8");
          segCount = t.split("\n").filter(Boolean).length;
        } catch {}
        sessions.push({ notebook: nb, session: sess, endedAt, segCount });
      }
    }
  } catch {}
  return sessions;
});

// Get the currently resolved LLM model (for settings display).
let cachedLlmModel = null;
ipcMain.handle("get_llm_model", async () => {
  cachedLlmModel = await resolveLlmModel();
  return { model: cachedLlmModel };
});

// Detect git remote origin for backup settings display.
ipcMain.handle("get_git_origin", async () => {
  const notebooksRoot = path.join(os.homedir(), "Stenollama");
  try {
    const out = await new Promise((resolve, reject) => {
      execFile("git", ["remote", "get-url", "origin"], { cwd: notebooksRoot }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout.trim());
      });
    });
    return { origin: out || null };
  } catch {
    return { origin: null };
  }
});

// Custom flags on selected passages — margin review annotations.
ipcMain.handle("flag_add", (_e, p) => {
  return appendMargin(p.sessionDir, {
    kind: "flag",
    flag: String(p.flag || "").slice(0, 60),
    selection: String(p.selection || "").slice(0, 1500),
    at: p.at || new Date().toISOString(),
  }, "flags.jsonl");
});

// WYSIWYG review notes (margin editor) — markdown-ish persistence per session.
ipcMain.handle("review_notes_save", (_e, p) => {
  if (!p.sessionDir) throw new Error("no session");
  const tags = Array.isArray(p.tags) ? p.tags.slice(0, 30).map((t) => `#${String(t).slice(0, 40)}`) : [];
  const body = `---\ntags: [${tags.join(", ")}]\n---\n\n${String(p.text || "").slice(0, 20000)}\n`;
  fs.writeFileSync(path.join(p.sessionDir, "review-notes.md"), body);
  return { ok: true, tags };
});

// Reactions (⭐ ❓ ✅ 🚩 …) on entries — fast-scroll markers of their own.
ipcMain.handle("reaction_add", (_e, p) => {
  return appendMargin(p.sessionDir, {
    kind: "reaction",
    refId: String(p.refId || ""),
    emoji: String(p.emoji || "").slice(0, 8),
    at: p.at || new Date().toISOString(),
  }, "reactions.jsonl");
});

// Image attachments (pasted into the composer) — stored per session.
ipcMain.handle("attachment_add", (_e, p) => {
  const sessionDir = p.sessionDir || "";
  if (!sessionDir) throw new Error("no session");
  const dir = path.join(sessionDir, "attachments");
  fs.mkdirSync(dir, { recursive: true });
  const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/.exec(p.dataUrl || "");
  if (!m) throw new Error("unsupported image");
  const file = `img-${Date.now().toString(36)}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
  fs.writeFileSync(path.join(dir, file), Buffer.from((p.dataUrl || "").split(",")[1], "base64"));
  return path.join("attachments", file);
});

// Persist a human margin comment.
ipcMain.handle("margin_add", (_e, p) => {
  return appendMargin(p.sessionDir, {
    kind: "comment",
    author: "human",
    atSec: p.atSec ?? null,
    noteContext: (p.noteContext || "").slice(0, 300) || null,
    text: String(p.text || "").slice(0, 2000),
  });
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