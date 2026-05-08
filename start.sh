#!/usr/bin/env bash
# MotionCut launcher.
# - Kills whatever is on port 5000 (the previous Flask, if any).
# - Starts the app under GUNICORN, not Werkzeug, so it works on Codespaces.
#   Werkzeug 3 added a DNS-rebinding host-allowlist check that rejects the
#   *.app.github.dev hostname; gunicorn bypasses that entirely.
# - --reload makes gunicorn pick up Python file edits automatically (so the
#   auto-pull thread + edit cycle still feels like dev).
# - Logs go to /tmp/mc.log — tail -f to watch them, Ctrl+C closes the tail
#   but leaves the server running.
# Usage:
#   ./start.sh         # restart and verify
#   tail -f /tmp/mc.log
# To stop:
#   fuser -k 5000/tcp

set -e

PORT=5000
LOG=/tmp/mc.log

cd "$(dirname "$0")"

# Make sure deps are installed in the current env. Idempotent — pip skips
# packages already present, and a missing apt ffmpeg fails loudly in the
# /api/health response rather than at boot.
if ! command -v gunicorn >/dev/null 2>&1; then
  echo "Installing Python deps…"
  pip install -q -r requirements.txt
fi

# 1) Free the port. fuser -k sends SIGKILL; tolerate the case where nothing
#    is listening (subshell, stderr suppressed). Sleep gives the kernel a
#    moment to release the socket before bind() retries.
fuser -k "${PORT}/tcp" 2>/dev/null || true
sleep 1

# 2) Detach and start. < /dev/null is the key bit — without it, any child
#    that tries to read the terminal would get SIGTTIN and the whole
#    process group would suspend without freeing the port.
nohup gunicorn app:app \
  --bind "0.0.0.0:${PORT}" \
  --workers 1 \
  --threads 8 \
  --timeout 0 \
  --reload \
  --access-logfile - \
  --error-logfile - \
  > "$LOG" 2>&1 < /dev/null &
PID=$!
disown || true

# 3) Wait for the HTTP server to be live, then sanity-check.
echo "MotionCut starting — pid $PID, log $LOG"
for i in $(seq 1 20); do
  if curl -fs "http://localhost:${PORT}/api/health" > /dev/null 2>&1; then
    break
  fi
  sleep 0.3
done

echo
echo "=== /api/version ==="
curl -s "http://localhost:${PORT}/api/version" || echo "(no response — check ${LOG})"
echo
echo "=== /api/health ==="
curl -s "http://localhost:${PORT}/api/health" || true
echo
echo
echo "Logs:  tail -f ${LOG}"
echo "Stop:  fuser -k ${PORT}/tcp"
