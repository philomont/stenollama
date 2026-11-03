#!/usr/bin/env bash
#
# fix-glycin-deadlock.sh — install Debian's glycin 2.2.3 on Ubuntu 26.04
# ("resolute") to fix the gray-window bug that affects Stenollama (and some
# Flatpak apps).
#
# WHY: Ubuntu 26.04 routes all gdk-pixbuf image loading through glycin 2.1.5,
# which deadlocks when gdk-pixbuf calls it synchronously (GTask thread-pool
# exhaustion; fixed upstream in glycin 2.2.0 — see docs/troubleshooting.md).
# A stuck image load hangs GTK's startup icon render, so WebKitGTK windows
# never first-paint and stay gray.
#
# WHAT THIS DOES:
#   1. Downloads glycin 2.2.3+ds-1 (Debian, amd64) — checksum-pinned.
#   2. Verifies every runtime dependency is satisfied before touching anything.
#   3. Snapshots current Ubuntu versions for rollback.
#   4. Installs with apt (dependency-aware) using sudo.
#   5. Runs a functional smoke test: loads a PNG through gdk-pixbuf/glycin
#      with a timeout — it must complete, not hang.
#
# USAGE:
#   bash scripts/fix-glycin-deadlock.sh             # download + install
#   bash scripts/fix-glycin-deadlock.sh --rollback   # restore Ubuntu 2.1.5
#
# Requires: curl, sudo, an amd64 machine on Ubuntu 26.04.

set -euo pipefail

GLYCIN_VERSION="2.2.3+ds-1"
MIRROR="http://deb.debian.org/debian"
POOL="$MIRROR/pool/main/g/glycin"
ARCH="$(dpkg --print-architecture)"
WORKDIR="$HOME/Downloads/glycin-$GLYCIN_VERSION"
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

# Packages to install (runtime + thumbnailers; skip -dev unless installed).
PKGS=(libglycin-2-0 glycin-loaders glycin-thumbnailers libglycin-gtk4-2-0)
if dpkg -s libglycin-2-dev >/dev/null 2>&1 || dpkg -s libglycin-gtk4-2-dev >/dev/null 2>&1; then
  echo "NOTE: -dev packages are installed; they will remain at the Ubuntu version"
  echo "      (harmless for runtime; rebuild against them only if you build glycin yourself)."
fi

# sha256 pins for ${GLYCIN_VERSION} amd64 (from deb.debian.org, 2026-11-03).
# If these fail, Debian rebuilt the packages — verify and update the pins.
declare -A SHA256=(
  ["libglycin-2-0_2.2.3+ds-1_amd64.deb"]="72186b98a176399c4dd08a5e2af55f312f7fb3eaaacd983982abac110b301570"
  ["glycin-loaders_2.2.3+ds-1_amd64.deb"]="c96e0c3ce379539e515b9c79b9b753ebad34531efcba5794a0480f784b9f1116"
  ["glycin-thumbnailers_2.2.3+ds-1_amd64.deb"]="a27a7ce1c5ab6374cada9a84b37fb861a6213f2d93cfb93998afb1c3d33f7417"
  ["libglycin-gtk4-2-0_2.2.3+ds-1_amd64.deb"]="a0e34abb70882c0cb683c9295801f8fe76c60a6465f94e658866555266a686fe"
)

rollback() {
  echo "== Rolling back to Ubuntu's glycin 2.1.5 =="
  $SUDO apt-get install -y --allow-downgrades \
    libglycin-2-0=2.1.5+ds-0ubuntu0.2 \
    glycin-loaders=2.1.5+ds-0ubuntu0.2 \
    glycin-thumbnailers=2.1.5+ds-0ubuntu0.2 \
    libglycin-gtk4-2-0=2.1.5+ds-0ubuntu0.2
  echo "Rolled back. To keep these pinned until an official fix, run:"
  echo "  sudo apt-mark hold libglycin-2-0 glycin-loaders"
}

[ "${1:-}" = "--rollback" ] && { rollback; exit 0; }

echo "== glycin deadlock fix: installing Debian $GLYCIN_VERSION ($ARCH) =="

# 1. Preflight: architecture + OS sanity.
if [ "$ARCH" != "amd64" ]; then
  echo "This script pins amd64 checksums. For $ARCH you'll need to fetch"
  echo "from $POOL and verify manually." >&2
  exit 1
fi
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ] || [ "${VERSION_ID:-}" != "26.04" ]; then
  echo "WARNING: tested on Ubuntu 26.04; you're on ${PRETTY_NAME:-unknown}."
  read -rp "Continue anyway? [y/N] " ok
  [ "$ok" = "y" ] || [ "$ok" = "Y" ] || exit 1
fi

# 2. Download + verify checksums.
mkdir -p "$WORKDIR"
FILES=()
for pkg in "${PKGS[@]}"; do
  file="${pkg}_${GLYCIN_VERSION}_${ARCH}.deb"
  url="$POOL/$file"
  dest="$WORKDIR/$file"
  if [ -f "$dest" ] && sha256sum -c <<<"${SHA256[$file]}  $dest" >/dev/null 2>&1; then
    echo "  cached ok: $file"
  else
    echo "  downloading: $file"
    curl -fSL --retry 3 -o "$dest" "$url"
  fi
  echo "${SHA256[$file]}  $dest" | sha256sum -c --quiet
  FILES+=("$dest")
done

# 3. Dependency preflight — everything glycin 2.2.3 needs is already on 26.04,
#    but verify so the install can't leave the system in a broken state.
for dep in bubblewrap libc6 libcairo2 libgcc-s1 libglib2.0-0t64 libheif1 \
           libjxl0.11 librsvg2-2 libfontconfig1 libseccomp2 libgtk-4-1; do
  dpkg -s "$dep" >/dev/null 2>&1 || { echo "missing dependency: $dep (run sudo apt install $dep)"; exit 1; }
done

# 4. Snapshot current versions for the record.
dpkg-query -W -f='${Package} ${Version}\n' \
  libglycin-2-0 glycin-loaders glycin-thumbnailers libglycin-gtk4-2-0 \
  | tee "$WORKDIR/installed-before.txt"

# 5. Install (apt resolves ordering + triggers; --reinstall keeps it idempotent).
echo "== Installing =="
$SUDO apt-get install -y --reinstall "${FILES[@]}"

# 6. Verify installed version.
echo "== Installed versions =="
dpkg-query -W -f='${Package} ${Version}\n' \
  libglycin-2-0 glycin-loaders glycin-thumbnailers libglycin-gtk4-2-0

# 7. Basic smoke test: a gdk-pixbuf load through glycin must complete.
#    NOTE: the original deadlock is pool-exhaustion-dependent, so an isolated
#    load passing is only a sanity check — the definitive verification is
#    launching Stenollama (see the message at the end).
echo "== Smoke test: gdk-pixbuf PNG load through glycin (15s timeout) =="
cat > "$WORKDIR/smoke.py" <<'PY'
import sys
from gi.repository import GdkPixbuf
png = GdkPixbuf.Pixbuf.new_from_file("/usr/share/icons/Yaru/256x256/apps/terminal.png")
if png.get_width() > 0:
    print("SMOKE OK: image loaded, %dx%d" % (png.get_width(), png.get_height()))
PY
if timeout 15 python3 "$WORKDIR/smoke.py" 2>/dev/null || \
   timeout 15 python3 "$WORKDIR/smoke.py"; then
  :
else
  echo "SMOKE FAILED: even an isolated image load hangs — the install is broken."
  echo "Rollback with: bash $0 --rollback"
  exit 1
fi
# clean up orphans from the old broken runs, if any remain
pkill -9 -f "glycin-loaders/2+/glycin" 2>/dev/null || true

echo
echo "Done. Basic sanity passed."
echo "DEFINITIVE VERIFICATION: launch Stenollama —"
echo "  cd ~/Documents/code/stenollama && npm run tauri dev"
echo "The window should now render, and the terminal log should show:"
echo "  [stenollama] page load event: Started(Started) url=http://localhost:1420/"
echo "Affected Flatpaks should render too."
echo ""
echo "When Ubuntu ships glycin >= 2.2.0 officially, remove any hold with:"
echo "  sudo apt-mark unhold libglycin-2-0 glycin-loaders"
echo "Rollback anytime with: bash $0 --rollback"