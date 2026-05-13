# MotionCut — Claude Code context

One-shot AI video editor. Upload clips → choose style → click Generate →
watch 4-step progress → download mp4.

## Stack (NO build step, NO TypeScript)

- **Backend:** Flask (Python 3.11) + gunicorn in prod, FFmpeg subprocess
  for rendering. `app.py` is the single backend file.
- **Frontend:** Vanilla JS ES module `static/js/generate.js` loaded as
  `<script type="module">`. GSAP from CDN for transitions.
- **Workers:** Web Worker pattern in `static/js/workers/`. Reusable
  `WorkerBridge` in `static/js/worker-bridge.js` — Promise-style
  `send(type, payload, transferables)` + `wait(predicate)`.

Current Workers:
- `analysis.worker.js` — beat detection + waveform (Sprint 4)
- `whisper.worker.js` — captions via @xenova/transformers (Sprint 5)
- `mediapipe.worker.js` — face detection (Sprint 6)

## Branch policy

**Always work on `claude/motioncut-video-editor-nZFMP`.** Never push
elsewhere. Repo lives at `louiscoplot-ui/motioncut` on GitHub.

## Pipeline overview (`run_pipeline` in app.py)

```
upload → _analyze_or_cached → auto_planner.generate_edit_plan
       → _snap_segments_to_beats (if beats present)
       → _remap_captions_to_layers (caption_segments → drawtext)
       → run_export_job (FFmpeg multi-clip xfade pipeline)
```

`build_filter_complex()` supports text layers via drawtext (Sprint 6
adds multi-line via `_wrap_text`). Never modify `run_export_job()` or
`build_segments_chain()` unless explicitly asked.

## POST /api/generate body shape

```
{
  project, filenames, style, duration, format,
  music_filename | music_catalogue_url, music_volume,
  color_grade, vignette, film_grain, letterbox,
  caption_segments: [{clipFilename, sourceStart, sourceEnd, text}],
  caption_style, clip_metadata: [{filename, has_face}],
  layers: []   # optional raw text layers
}
```

## Conventions

- **No comments** unless WHY is non-obvious. Never explain WHAT the code does.
- **No emojis** in code, commits, or docs.
- **No new markdown files** unless asked. CLAUDE.md is the exception.
- **Errors are non-fatal** for ML features: Whisper / MediaPipe / beats
  all fall back to empty results so the render never blocks.
- **Style** = `real_estate | social | cinematic | fast`. Defaults to
  `real_estate`.
- **Format** = `16:9 | 9:16 | 1:1`. Letterbox bars only on 16:9.

## Common pitfalls (learned the hard way)

1. **Stale Flask processes** — always `pkill -f "flask --app app run"`
   before starting a new server. The SessionStart hook does this.
2. **Conflict markers in generate.js** — if the user reports
   `Unexpected token '<<'`, FIRST check if their server checkout is
   stuck on an unresolved stash pop (not this repo's HEAD).
3. **`UID` is readonly in bash** — never name shell vars `UID`.
4. **`testsrc` + `-b:v` ignores bitrate** — use `-maxrate` + `-bufsize`
   to force a target file size when generating test videos.
5. **`init.py` cache pollution** — `find . -name '*.pyc' -delete` after
   modifying app.py if Flask serves stale code.
6. **Schema validator** — `_validate_project_document` requires
   `schema, version, id, name, created_at, modified_at`. Use
   `_minimal_doc(pid)` shape when constructing.

## Smoke test

```bash
# 1) Start server
pkill -f "flask --app app run" 2>/dev/null
nohup python3 -m flask --app app run --port 5050 --host 127.0.0.1 \
  > /tmp/mc.log 2>&1 < /dev/null & disown
sleep 3

# 2) Build a test video (avoid testsrc duration weirdness)
ffmpeg -y -f lavfi -i "testsrc=duration=8:size=640x480:rate=30" \
       -f lavfi -i "sine=frequency=440:duration=8" \
       -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest /tmp/v.mp4 2>&1 | tail -1

# 3) Upload + generate
NAME=$(curl -s -X POST -F "file=@/tmp/v.mp4" -F "project=smoke" \
       http://127.0.0.1:5050/api/upload | jq -r .filename)
curl -s -X POST -H 'Content-Type: application/json' \
     -d "{\"project\":\"smoke\",\"filenames\":[\"$NAME\"],\"style\":\"social\",\"duration\":6,\"format\":\"16:9\"}" \
     http://127.0.0.1:5050/api/generate
```

The `/smoke` slash command runs this end-to-end and reports.

## When you finish a sprint

1. `python3 -c "import ast; ast.parse(open('app.py').read())"` to lint.
2. `node --input-type=module --check < static/js/generate.js` for JS.
3. Run `/smoke` to verify the pipeline still works.
4. Commit with the body explaining the WHY (not WHAT).
5. Push to `claude/motioncut-video-editor-nZFMP`.
6. Sub-agents: spawn `code-reviewer` for risky diffs.

## Available sub-agents (project-scoped)

- `bug-hunter` — scans for conflict markers, syntax errors, dead Flask
  procs, .pyc rot. Use proactively at session start.
- `smoke-tester` — runs the end-to-end test above and reports.
- `code-reviewer` — diff review focused on regressions in the
  pipeline / Worker contracts.

## Slash commands

- `/smoke` — end-to-end test
- `/fix-conflicts` — detect + auto-resolve merge conflict markers
- `/restart` — clean Flask restart
- `/ship` — lint + smoke + commit + push
