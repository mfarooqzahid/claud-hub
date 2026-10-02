#!/usr/bin/env bash
# One-step setup for Claude Hub (Linux / macOS).
#
#   ./setup.sh
#
# Installs the small local helper Chrome needs to read your Chrome profiles, and
# opens the Extensions page so you can load the extension.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

echo "Claude Hub — setup"
echo

# 1. Install the local helper (registers it with Chrome/Chromium/Brave).
python3 "$HERE/native-host/install.py"

echo
echo "Next, in a DEDICATED Chrome profile (create one: profile menu → Add →"
echo "'Continue without an account'), on the Extensions page:"
echo "  · turn on Developer mode (top-right), then"
echo "  · Load unpacked → choose:  $HERE/extension"
echo "Load it only in that hub profile; the other profiles stay read-only."
echo

# 2. Open Chrome straight to the Extensions page.
for browser in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$browser" >/dev/null 2>&1; then
    "$browser" chrome://extensions >/dev/null 2>&1 &
    exit 0
  fi
done
echo "(Open chrome://extensions yourself to load the extension.)"
