---
description: Clean restart of the local Flask dev server
argument-hint: [port]
---

Restart Flask cleanly. Port defaults to 5050; the user may pass a
different one.

```bash
PORT="${1:-5050}"
pkill -f "flask --app app run" 2>/dev/null
sleep 1
find . -name "*.pyc" -delete 2>/dev/null
find . -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
touch app.py
nohup python3 -m flask --app app run --port "$PORT" --host 127.0.0.1 \
  > /tmp/mc.log 2>&1 < /dev/null & disown
sleep 3
curl -s -o /dev/null -w "ping http://127.0.0.1:$PORT → %{http_code}\n" \
  http://127.0.0.1:$PORT/api/music/catalogue
tail -5 /tmp/mc.log
```

Report the ping result + last log lines. Stop after that.

$ARGUMENTS
