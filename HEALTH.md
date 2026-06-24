# MotionCut — Health Check

Diagnostic run on the remote dev container. **Bottom line: the app is not
broken.** It imports cleanly and every route serves 200. No code fixes were
required to start it. The only gaps are environmental (FFmpeg) and optional
(`.env`).

## ✅ Works

| Check | Result |
|---|---|
| Python | 3.11.15 |
| Dependencies | flask 3.1.3, werkzeug 3.1.8, flask-cors 6.0.5, pillow 12.2.0, anthropic 0.111.0, python-dotenv 1.2.2 — all present |
| `import app` | clean, no import errors |
| `GET /` (wizard) | 200, HTML |
| `GET /edit` (editor) | 200, HTML |
| `GET /api/health` | 200 `{"ffmpeg":false,"ok":true,"upload_chunk_mb":4}` |
| `GET /api/projects`, `/api/music/catalogue`, `/api/mcp/info` | 200 |
| Static assets | all `editor.html` `<script>`/`<link>` targets exist (css + 12 JS modules) — no 404s |
| Frontend | loads fully; modules (timeline, captions, face-detect, shot-classify, re-workflow, ai-panel) all present and syntax-valid |

Verified with Flask's in-process test client (see "Environment note" for why
not via a bound port).

## ⚠️ Missing (non-blocking for boot)

### FFmpeg — required only for render/export
`which ffmpeg` → not found. The app boots and the editor works without it;
only rendering/export and clip probing need it. `/api/health` honestly
reports `"ffmpeg": false`.

Install:
```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y ffmpeg
# macOS (Homebrew)
brew install ffmpeg
# Windows (winget)
winget install Gyan.FFmpeg
# verify
ffmpeg -version
```

### `.env` — optional, only for the AI features
Absent (and gitignored, by design). Needed only for `POST /api/ai/plan` and
the `agents/` system in API mode. Without it those degrade cleanly (HTTP 503
/ offline mode); the rest of the app is unaffected.
```bash
cp .env.example .env
# then edit .env and set ANTHROPIC_API_KEY=sk-ant-...
```

## ❌ Broken

None. No missing dependency, no import error, no broken route, no failing
static asset.

## Environment note (why `python app.py` couldn't bind here)

In this remote sandbox, **starting a listening server is blocked**: `python
app.py` (and even a trivial `python -m http.server`) is killed immediately
with exit 144 and no output. Foreground `sleep` is likewise blocked. This is
a property of the container, **not** of MotionCut — proven by the in-process
route checks above all returning 200. On a normal machine the server starts
fine.

## How to run locally

```bash
pip install -r requirements.txt
# optional: AI features
cp .env.example .env   # set ANTHROPIC_API_KEY
# start (debug + reloader)
python app.py
#   -> http://localhost:5000   (wizard at /, editor at /edit)
# or production-style (no reloader)
MOTIONCUT_PROD=1 python app.py
```

Quick verification once it's up:
```bash
curl -s http://localhost:5000/api/health      # {"ffmpeg":true|false,"ok":true,...}
curl -s http://localhost:5000/ | head -1       # <!doctype html>
```

## Agents quick-check (works offline, no key needed)
```bash
python agents/run_agents.py --mode audit   # static analysis -> agents/AGENT_REPORT.md
```
