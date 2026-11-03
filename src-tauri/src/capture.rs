//! System-audio loopback capture (Linux: PipeWire/PulseAudio monitor).
//!
//! `capture_start` spawns ffmpeg tapping the default sink's monitor source,
//! writing 16 kHz mono PCM. The reader thread:
//!   - appends PCM to `<session>/audio.wav` (the gemma4-required format),
//!   - counts samples — the session's monotonic timeline clock (#19),
//!   - emits `capture:level` events (~3 Hz) for the UI level meter (#20),
//!   - patches the RIFF header and emits `capture:stopped` when done.
//!
//! Findings that shaped this design (spike #15 / PR #67): the sample clock is
//! stable with only a constant ~15 ms start offset, so elapsed time is derived
//! strictly from sample count, never wall clock.

use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, State};

pub const SAMPLE_RATE: u32 = 16_000;
pub const CHANNELS: u16 = 1;
const CHUNK_MS: u64 = 100; // reader chunk granularity
const LEVEL_EVENT_INTERVAL_MS: u64 = 300;

pub struct CaptureState {
    pub session: Option<ActiveSession>,
}

pub struct ActiveSession {
    pub session_dir: String,
    pub monitor: String,
    pub child: Child,
    pub stop: Arc<AtomicBool>,
    pub sample_count: Arc<AtomicU64>,
    pub reader: JoinHandle<()>,
}

impl CaptureState {
    pub fn new() -> Self {
        Self { session: None }
    }
}

#[derive(Serialize, Clone)]
pub struct LevelEvent {
    pub elapsed_sec: f64,
    pub rms_dbfs: f64,
}

#[derive(Serialize, Clone)]
pub struct StoppedEvent {
    pub session_dir: String,
    pub duration_sec: f64,
    pub reason: String, // "stopped" | "end-of-stream" | "device-lost"
}

/// Where notebooks live. v0: `~/Stenollama/notebooks/` (configurable in #49).
fn notebooks_root() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default()
        .join("Stenollama")
        .join("notebooks")
}

/// Discover the default sink's monitor source (spike #15 approach).
fn default_sink_monitor() -> Result<String, String> {
    let out = Command::new("wpctl")
        .arg("status")
        .output()
        .map_err(|e| format!("wpctl not available: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);

    let mut in_sinks = false;
    let mut sink_id: Option<String> = None;
    for line in text.lines() {
        let t = line.trim();
        if t.ends_with("Sinks:") {
            in_sinks = true;
            continue;
        }
        if in_sinks && t.ends_with("Sources:") {
            break;
        }
        if in_sinks && sink_id.is_none() && line.contains('*') {
            let digits: String = line
                .split('*')
                .nth(1)
                .unwrap_or("")
                .trim()
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if !digits.is_empty() {
                sink_id = Some(digits);
            }
        }
    }
    let id = sink_id.ok_or("no default sink found")?;

    let out = Command::new("pw-cli")
        .args(["info", &id])
        .output()
        .map_err(|e| format!("pw-cli failed: {e}"))?;
    let info = String::from_utf8_lossy(&out.stdout);
    let name = info
        .lines()
        .find_map(|l| {
            let l = l.trim().trim_start_matches('*').trim();
            l.strip_prefix("node.name = ")
                .map(|v| v.trim_matches('"').to_string())
        })
        .ok_or("node.name not found")?;

    Ok(format!("{name}.monitor"))
}

/// `YYYY-MM-DD-HHMM` (UTC in v0) — SPEC-storage session folder name.
fn session_stamp() -> (String, String) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    (session_name(secs), iso8601(secs))
}

fn now_iso8601() -> String {
    iso8601(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    )
}

fn session_name(secs: u64) -> String {
    let (y, m, d, rem) = civil(secs);
    format!(
        "{y:04}-{m:02}-{d:02}-{:02}{:02}",
        rem / 3600,
        (rem % 3600) / 60
    )
}

fn iso8601(secs: u64) -> String {
    let (y, m, d, rem) = civil(secs);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn civil(secs: u64) -> (i64, u32, u32, u64) {
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    (y, m, d, secs % 86_400)
}

/// Howard Hinnant's civil-from-days algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn wav_header(data_len: u32) -> Vec<u8> {
    let mut h = Vec::with_capacity(44);
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&(36 + data_len).to_le_bytes());
    h.extend_from_slice(b"WAVE");
    h.extend_from_slice(b"fmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes()); // PCM
    h.extend_from_slice(&CHANNELS.to_le_bytes());
    h.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    h.extend_from_slice(&(SAMPLE_RATE * CHANNELS as u32 * 2).to_le_bytes()); // byte rate
    h.extend_from_slice(&(CHANNELS * 2).to_le_bytes()); // block align
    h.extend_from_slice(&16u16.to_le_bytes()); // bits
    h.extend_from_slice(b"data");
    h.extend_from_slice(&data_len.to_le_bytes());
    h
}

fn dbfs(rms: f64) -> f64 {
    if rms <= 0.0 {
        -90.0
    } else {
        ((20.0 * (rms / 32_768.0).log10()) as f64).max(-90.0)
    }
}

/// Start capturing the system audio output into a new session folder.
#[tauri::command]
pub fn capture_start(
    app: AppHandle,
    state: State<'_, Mutex<CaptureState>>,
    notebook: String,
) -> Result<String, String> {
    let mut state = state.lock().unwrap();
    if state.session.is_some() {
        return Err("a capture session is already active".into());
    }

    let monitor = default_sink_monitor()?;

    let (stamp, started_at) = session_stamp();
    let session_dir = notebooks_root()
        .join(notebook)
        .join("sessions")
        .join(&stamp);
    fs::create_dir_all(&session_dir).map_err(|e| format!("cannot create session dir: {e}"))?;

    let mut child = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "pulse",
            "-i",
            &monitor,
            "-ac",
            "1",
            "-ar",
            &SAMPLE_RATE.to_string(),
            "-c:a",
            "pcm_s16le",
            "-f",
            "s16le",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start ffmpeg: {e} (is it installed?)"))?;

    let mut pcm = child.stdout.take().ok_or("failed to pipe ffmpeg output")?;

    let wav_path = session_dir.join("audio.wav");
    let mut wav =
        fs::File::create(&wav_path).map_err(|e| format!("cannot create audio file: {e}"))?;
    wav.write_all(&wav_header(0))
        .map_err(|e| format!("cannot write wav header: {e}"))?;

    // Session files per SPEC-storage v0.1.
    let _ = fs::write(session_dir.join("transcript.jsonl"), "");
    let _ = fs::write(session_dir.join("highlights.jsonl"), "");
    let _ = fs::write(
        session_dir.join("notes.md"),
        format!("---\nschemaVersion: 0\nanchors: []\nhighlights: []\ntags: []\n---\n\n## Session {stamp}\n"),
    );

    let stop = Arc::new(AtomicBool::new(false));
    let sample_count = Arc::new(AtomicU64::new(0));
    let sc_reader = Arc::clone(&sample_count);
    let stop_thread = Arc::clone(&stop);

    let session_dir_s = session_dir.to_string_lossy().to_string();
    let monitor_clone = monitor.clone();
    let started_clone = started_at.clone();
    let session_dir_thread = session_dir.clone();

    let reader = std::thread::spawn(move || {
        let chunk_len = (SAMPLE_RATE as u64 * CHANNELS as u64 * 2 * CHUNK_MS / 1000) as usize;
        let mut buf = vec![0u8; chunk_len];
        let mut last_level = Instant::now();
        let mut data_len: u64 = 0;
        let mut reason = "end-of-stream";

        loop {
            // Fill the chunk as completely as possible.
            let mut filled = 0;
            while filled < chunk_len {
                match pcm.read(&mut buf[filled..]) {
                    Ok(0) => break,
                    Ok(n) => filled += n,
                    Err(_) => {
                        reason = "device-lost";
                        break;
                    }
                }
            }
            if filled == 0 {
                break;
            }
            let _ = wav.write_all(&buf[..filled]);
            data_len += filled as u64;
            sc_reader.fetch_add((filled / 2) as u64, Ordering::Relaxed);

            if last_level.elapsed() >= Duration::from_millis(LEVEL_EVENT_INTERVAL_MS) {
                let sum_sq: f64 = buf[..filled]
                    .chunks_exact(2)
                    .map(|c| {
                        let s = i16::from_le_bytes([c[0], c[1]]) as f64;
                        s * s
                    })
                    .sum();
                let n = (filled / 2) as f64;
                let rms = (sum_sq / n).sqrt();
                let elapsed = sc_reader.load(Ordering::Relaxed) as f64
                    / (SAMPLE_RATE * CHANNELS as u32) as f64;
                let _ = app.emit(
                    "capture:level",
                    LevelEvent {
                        elapsed_sec: elapsed,
                        rms_dbfs: dbfs(rms),
                    },
                );
                last_level = Instant::now();
            }

            if stop_thread.load(Ordering::Relaxed) {
                reason = "stopped";
                break;
            }
        }

        // Patch RIFF sizes, then finalize session.yaml.
        let _ = wav
            .seek(SeekFrom::Start(4))
            .and_then(|_| wav.write_all(&(36 + data_len as u32).to_le_bytes()));
        let _ = wav
            .seek(SeekFrom::Start(40))
            .and_then(|_| wav.write_all(&(data_len as u32).to_le_bytes()));
        let _ = wav.flush();

        let samples = sc_reader.load(Ordering::Relaxed);
        let duration = samples as f64 / (SAMPLE_RATE * CHANNELS as u32) as f64;
        let session_yaml = format!(
            "schemaVersion: 0\nstartedAt: {started_clone}\nendedAt: {}\naudio:\n  file: audio.wav\n  sampleRate: {SAMPLE_RATE}\n  channels: {CHANNELS}\n  durationSec: {duration:.3}\n  clock: sample-count\ncapture:\n  source: system-output-monitor\n  device: {monitor_clone}\ntranscription:\n  engine: ollama-gemma4\n  model: gemma4:e4b\n",
            now_iso8601()
        );
        let _ = fs::write(session_dir_thread.join("session.yaml"), session_yaml);

        let _ = app.emit(
            "capture:stopped",
            StoppedEvent {
                session_dir: session_dir_s.clone(),
                duration_sec: duration,
                reason: reason.to_string(),
            },
        );
    });

    state.session = Some(ActiveSession {
        session_dir: session_dir.to_string_lossy().to_string(),
        monitor,
        child,
        stop,
        sample_count,
        reader,
    });

    Ok(session_dir.to_string_lossy().to_string())
}

/// Stop the active capture session and finalize its files.
#[tauri::command]
pub fn capture_stop(state: State<'_, Mutex<CaptureState>>) -> Result<String, String> {
    let mut state = state.lock().unwrap();
    let mut active = state.session.take().ok_or("no active capture session")?;
    active.stop.store(true, Ordering::Relaxed);
    let _ = active.child.kill();
    let dir = active.session_dir.clone();
    active
        .reader
        .join()
        .map_err(|_| "capture reader thread panicked".to_string())?;
    Ok(dir)
}

/// Current elapsed seconds of the active session (sample-count derived).
#[tauri::command]
pub fn capture_elapsed(state: State<'_, Mutex<CaptureState>>) -> Result<f64, String> {
    let state = state.lock().unwrap();
    let s = state.session.as_ref().ok_or("no active capture session")?;
    Ok(s.sample_count.load(Ordering::Relaxed) as f64 / (SAMPLE_RATE * CHANNELS as u32) as f64)
}
