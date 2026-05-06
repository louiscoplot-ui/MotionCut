#!/bin/bash
# MotionCut - sync to latest from remote
# Usage: ./sync.sh   (or just: bash sync.sh)
set -e
echo "→ Pulling latest…"
git pull --rebase --autostash
echo "✓ Up to date. Refresh your browser (Ctrl+Shift+R)."
