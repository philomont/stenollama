# Spike: Linux system-audio (loopback) capture — #15

**Status: PASS** (2026-11-03, PipeWire 1.6.2 + pipewire-pulse, ThinkPad HD Audio)

## What was proven

1. **Monitor capture works.** The default sink's monitor source
   (`<sink-node-name>.monitor`, e.g.
   `alsa_output...HiFi__Speaker__sink.monitor`) captures exactly what the user
   hears — verified by recording a 440 Hz tone played to the default output.
2. **One ffmpeg command produces gemma4-ready audio**: `-f pulse -i <monitor>
   -ac 1 -ar 16000 -c:a pcm_s16le` — the exact format Ollama's gemma4 requires
   for audio transcription (see #11 findings).
3. **Sample clock is stable.** Over a 30 s capture, sample count matched
   expected within a *constant ~13–17 ms offset* (capture-start latency), not
   cumulative drift. Long-run drift < 500 ppm.

## Measured results

| Run | Samples | Expected | Excess | Drift (naive ppm) |
|-----|---------|----------|--------|-------------------|
| 6 s | 96,271 | 96,000 | +271 (~17 ms) | 2823 |
| 30 s | 480,201 | 480,000 | +201 (~13 ms) | 419 |

Excess does not scale with duration → constant start offset, stable clock.

## Design implications (for #16, #19)

- **Timeline clock = sample count from stream start**, never wall clock. The
  ~15 ms start offset is negligible vs. note granularity (seconds).
- The production capture engine can spawn `ffmpeg -f pulse` (already proven
  cross-platform: Windows `dshow`, macOS `avfoundation`), or use the PulseAudio
  API directly for finer-grained control (level meters without file I/O).
- Device discovery: `wpctl status` (default sink `*`) → `pw-cli info <id>`
  (`node.name`) → `+ ".monitor"`.

## Run it

```bash
cd spikes/audio-capture
cargo run -- 6        # captures 6 s and prints the analysis
```

Requires: pipewire, pipewire-pulse, wireplumber (`wpctl`, `pw-cli`), ffmpeg.