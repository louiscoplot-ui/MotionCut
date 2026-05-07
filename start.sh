#!/usr/bin/env bash
# MotionCut launcher.
# - Kills whatever is on port 5000 (the previous Flask, if any).
# - Starts app.py fully detached: nohup ignores SIGHUP, stdin is closed so
#   the bash terminal can't auto-suspend the Flask reloader child, and
#   `disown` removes the job from this shell's list (no more "[1]+ Stopped").
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

# 1) Free the port. fuser -k sends SIGKILL; tolerate the case where nothing
#    is listening (subshell, stderr suppressed). Sleep gives the kernel a
#    moment to release the socket before bind() retries.
fuser -k "${PORT}/tcp" 2>/dev/null || true
sleep 1

# 2) Detach and start. < /dev/null is the key bit — without it, Flask's
#    debug-mode reloader child tries to read the terminal and bash sends
#    SIGTTIN which suspends the process (and frees nothing).
nohup python3 app.py > "$LOG" 2>&1 < /dev/null &
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
