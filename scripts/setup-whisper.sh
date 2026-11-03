#!/usr/bin/env bash
# setup-whisper.sh — build the whisper.cpp sidecar and download models for
# fully-local transcription (no Ollama version dependency).
#
# Installs to:
#   ~/.stenollama/tools/whisper-cli
#   ~/.stenollama/models/ggml-small.en.bin  (~488 MB, default: better accuracy)
#   ~/.stenollama/models/ggml-base.en.bin    (~148 MB, faster fallback)
#
# Override model choice with STENO_WHISPER_MODEL=/path/to/ggml-*.bin
# Requires: git, cmake, g++, make, curl.

set -euo pipefail

STENO_HOME="$HOME/.stenollama"
mkdir -p "$STENO_HOME/tools" "$STENO_HOME/models"
BUILD_DIR="$(mktemp -d)"

echo "== building whisper.cpp (release, OpenMP) =="
if [ ! -x "$STENO_HOME/tools/whisper-cli" ]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$BUILD_DIR/whisper.cpp"
  cmake -B "$BUILD_DIR/whisper.cpp/build" -S "$BUILD_DIR/whisper.cpp" \
    -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
  cmake --build "$BUILD_DIR/whisper.cpp/build" --target whisper-cli -j"$(nproc)"
  cp "$BUILD_DIR/whisper.cpp/build/bin/whisper-cli" "$STENO_HOME/tools/whisper-cli"
else
  echo "  whisper-cli already present, skipping build"
fi

echo "== downloading models =="
for m in ggml-small.en.bin ggml-base.en.bin; do
  if [ ! -f "$STENO_HOME/models/$m" ]; then
    echo "  $m"
    curl -sL --retry 3 -o "$STENO_HOME/models/$m" \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$m"
  else
    echo "  $m already present"
  fi
done

rm -rf "$BUILD_DIR"
echo "== done =="
"$STENO_HOME/tools/whisper-cli" --help 2>&1 | head -1
echo "Models: $(ls "$STENO_HOME/models")"
echo "The app auto-detects this on the next session start."