//! Spike #15: prove we can tap the system audio output (what the user hears)
//! on Linux via the PipeWire/PulseAudio monitor source of the default sink.
//!
//! Steps:
//!   1. Find the default output sink (wpctl) and its monitor source name.
//!   2. Play a 440 Hz test tone to the default output while capturing from
//!      the monitor via ffmpeg's pulse input, writing 16 kHz mono WAV —
//!      the exact format gemma4 requires for Ollama transcription.
//!   3. Analyze the WAV: duration, sample count vs wall clock (clock drift),
//!      RMS/peak (did we actually capture the tone, not silence?).
//!
//! Run from spikes/audio-capture: `cargo run -- 6` (captures for 6 seconds).

use std::fs;
use std::process::Command;
use std::time::Instant;

fn main() {
    let secs: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(6);

    println!("== Stenollama audio capture spike (Linux) ==\n");

    // ---- 1. discover default sink monitor -------------------------------
    let monitor = match default_sink_monitor() {
        Ok(m) => m,
        Err(e) => die(&format!("could not find default sink monitor: {e}")),
    };
    println!("default sink monitor source : {monitor}");

    // ---- 2. capture while playing a tone ---------------------------------
    let out_wav = "spike-out.wav";

    let tone = Command::new("ffmpeg")
        .args([
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", &format!("sine=frequency=440:duration={}", secs + 2),
            "-f", "pulse", "default",
        ])
        .spawn();
    match &tone {
        Ok(_) => println!("playing 440 Hz test tone for {} s ...", secs + 2),
        Err(e) => die(&format!("failed to start tone player: {e}")),
    }

    let started = Instant::now();
    let cap = Command::new("ffmpeg")
        .args([
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "pulse", "-i", &monitor,
            "-t", &secs.to_string(),
            "-ac", "1", "-ar", "16000",
            "-c:a", "pcm_s16le",
            out_wav,
        ])
        .output();
    let wall = started.elapsed();

    match cap {
        Ok(o) if o.status.success() => {}
        Ok(o) => die(&format!(
            "ffmpeg capture failed: {}",
            String::from_utf8_lossy(&o.stderr)
        )),
        Err(e) => die(&format!("failed to run ffmpeg: {e}")),
    }

    let _ = tone.and_then(|mut t| t.kill());

    println!("capture finished (wall time     : {:.2} s)", wall.as_secs_f64());

    // ---- 3. analyze the WAV ----------------------------------------------
    let bytes = fs::read(out_wav).unwrap_or_else(|e| die(&format!("cannot read {out_wav}: {e}")));
    let wav = parse_wav(&bytes).unwrap_or_else(|e| die(&e));

    let expected = secs as f64 * 16000.0;
    let actual = wav.samples as f64;
    let drift_ppm = ((actual / expected) - 1.0) * 1e6;
    let duration = actual / wav.sample_rate as f64;

    println!("\n== analysis of {out_wav} ==");
    println!("sample rate / channels / bits : {} Hz / {} / 16", wav.sample_rate, wav.channels);
    println!("samples captured              : {actual} (expected {expected:.0})");
    println!("audio duration                : {duration:.3} s (requested {secs} s)");
    println!("clock drift                   : {drift_ppm:+.1} ppm");
    println!("RMS level                     : {:.1} dBFS", wav.rms_dbfs);
    println!("peak level                    : {:.1} dBFS", wav.peak_dbfs);

    // ---- verdict ----------------------------------------------------------
    let captured_tone = wav.rms_dbfs > -50.0;
    let stable_clock = drift_ppm.abs() < 2000.0; // < 0.2%
    let right_format = wav.sample_rate == 16000 && wav.channels == 1;

    println!("\n== verdict ==");
    check("monitor captured audible output (not silence)", captured_tone);
    check("sample clock stable (|drift| < 2000 ppm)", stable_clock);
    check("16 kHz mono PCM (gemma4-ready)", right_format);
    let ok = captured_tone && stable_clock && right_format;
    println!(
        "\n{}: spike {}",
        if ok { "PASS" } else { "FAIL" },
        if ok { "succeeded — monitor capture is viable for the capture engine (#16)" } else { "did not pass — investigate before building #16" }
    );
    std::process::exit(if ok { 0 } else { 1 });
}

/// Find the default sink via `wpctl status`, resolve its node name via
/// `pw-cli info <id>`, and return the PulseAudio monitor source name.
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
            // e.g. "  *   55. Speaker [vol: 0.40]"
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
    let id = sink_id.ok_or("no default sink marked in wpctl status")?;

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
        .ok_or("node.name not found in pw-cli info")?;

    Ok(format!("{name}.monitor"))
}

struct Wav {
    sample_rate: u32,
    channels: u16,
    samples: usize,
    rms_dbfs: f64,
    peak_dbfs: f64,
}

/// Minimal RIFF parser for 16-bit PCM WAV.
fn parse_wav(bytes: &[u8]) -> Result<Wav, String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }
    let mut pos = 12;
    let mut sample_rate = 0u32;
    let mut channels = 0u16;
    let mut bits = 0u16;
    let mut data: &[u8] = &[];
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let len = u32::from_le_bytes(
            bytes[pos + 4..pos + 8].try_into().unwrap(),
        ) as usize;
        let body = pos + 8;
        let end = (body + len).min(bytes.len());
        match id {
            b"fmt " => {
                channels = u16::from_le_bytes(bytes[body + 2..body + 4].try_into().unwrap());
                sample_rate = u32::from_le_bytes(bytes[body + 4..body + 8].try_into().unwrap());
                bits = u16::from_le_bytes(bytes[body + 14..body + 16].try_into().unwrap());
            }
            b"data" => data = &bytes[body..end],
            _ => {}
        }
        pos = end + (len & 1); // chunks are word-aligned
    }
    if sample_rate == 0 || data.is_empty() {
        return Err("missing fmt or data chunk".into());
    }
    if bits != 16 {
        return Err(format!("expected 16-bit PCM, got {bits}-bit"));
    }

    let samples: Vec<i16> = data
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();
    let n = samples.len() as f64;
    let sum_sq: f64 = samples.iter().map(|&s| (s as f64).powi(2)).sum();
    let peak = samples.iter().map(|&s| s.unsigned_abs()).max().unwrap_or(0) as f64;
    let rms = (sum_sq / n).sqrt();
    let db = |v: f64| if v <= 0.0 { f64::NEG_INFINITY } else { 20.0 * (v / 32768.0).log10() };

    Ok(Wav {
        sample_rate,
        channels,
        samples: samples.len() / channels as usize,
        rms_dbfs: db(rms),
        peak_dbfs: db(peak),
    })
}

fn check(label: &str, ok: bool) {
    println!("  [{}] {label}", if ok { "x" } else { " " });
}

fn die(msg: &str) -> ! {
    eprintln!("SPIKE FAILED: {msg}");
    std::process::exit(1);
}

