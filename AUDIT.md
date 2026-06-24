# MotionCut — Sprint Audit (CORE-1 → LOOP-2)

Autonomous run of the 9 sprints in `motioncut_prompts.md`. Branch:
`claude/festive-mccarthy-8sjk79`. One commit per sprint.

**Overriding finding:** the prompts were written as if for a greenfield
project (`timeline[]`/`overlays[]`/`export{}` doc model, FastMCP, Flask
routes like `/api/clip/trim`). The actual repo is **mature**: a `segments[]`
timeline model, an in-process MCP server, a 4600-line editor with rich
layers, and three already-real ML workers. So each sprint was executed as
*fill the genuine gap, additively, without rewriting working systems* —
never touching `run_export_job` / `build_filter_complex` /
`build_segments_chain` (forbidden by CLAUDE.md). Verification here is
`py_compile` + `node --check` + app import; **FFmpeg/ffprobe are not
installed in this container and there is no browser**, so render/ML runtime
paths are coded but not executed here (noted per sprint).

---

## ✅ Done

| Sprint | Deliverable | Notes |
|---|---|---|
| **CORE-1** | J/K/L shuttle transport + segment-aware Delete (`editor.js`) | Timeline drag-reorder, trim handles, razor split, zoom, playhead, I/O marks, library drag-drop already existed via `segments[]`. Filled the two missing keyboard affordances. |
| **CORE-2** | `export/ffmpeg_export.py` + `POST /api/export/start`, `GET /api/export/status/<id>`, `GET /api/export/download/<id>` | Decoupled builder: `-ss/-to` trim per input, scale+pad 1080p/720p/original, synthesised silent audio for muted clips, concat, live stderr progress, single-concurrency (429), 503 when FFmpeg absent. Command builder unit-checked. |
| **CORE-3** | Beat detection moved into `analysis.worker.js` + `POST /api/project/audio` | `detectBeats` now offloads the energy/flux scan to the worker (in-thread kept as fallback); decode stays on main thread (native Web Audio). Beats persisted to `audio.beat_anchors` so the render pipeline's beat-snap reuses them. |
| **LOOP-1** | MCP server + agentic loop | **Already implemented** in a prior session (`mcp_server.py`, `agent_loop.py`, `/api/mcp/instruct`, `/api/mcp/status`). Verified intact + compiles. No new work. |
| **ML-1** | `captions.js` — Whisper integration | Opt-in modal (model never downloads without consent), 16kHz mono PCM via `OfflineAudioContext`, transcription through the real worker, caption insertion via new `editor.addCaptionLayers()`, Export SRT. |
| **ML-2** | `face-detect.js` — MediaPipe integration + shared AI-badge layer | Per-clip frame extraction → worker → persist to `ai_cache` via new `POST /api/clip/ai-cache` → 👤 badge in library (kept in sync by MutationObserver). Hosts shared `aiBadges`/`frameUtil` for ML-3. |
| **ML-3** | `classifier.worker.js` (new) + `shot-classify.js` | ResNet ONNX preprocess→softmax→majority-vote pipeline coded; 🚁/🏠/🛋️/🔍 badges; persists `shot_type`. |
| **RE-1** | `re-workflow.js` + `editor.addOverlay()` | 🏠 RE Reel modal → auto-order by `shot_type` → price tiering (trim+aspect) → typed overlays → **mandatory preview** → export via existing path. |
| **LOOP-2** | `export/quality_checker.py`, `recovery_encoder.py`, `export_loop.py` | ffprobe probe vs tier target → corrective re-encode → up to 3 attempts → `quality_warning` fallback. Wired into `/api/export/start`; shares the CORE-2 job store + concurrency lock; cleans intermediates. Target derivation + skip-path unit-checked. |

---

## ⚠️ Stubbed / partial (with reason)

- **FFmpeg/ffprobe absent in this container.** CORE-2 export and LOOP-2
  quality loop are fully coded but cannot be *run* here. Both degrade
  cleanly: `/api/export/start` → **503** when FFmpeg missing; quality check
  → **`status:'SKIP'`** when ffprobe missing (first render accepted). Verify
  on a box with FFmpeg installed.
- **No browser in this environment.** All frontend modules pass
  `node --check` but were not executed. The ML CDN libraries
  (`@xenova/transformers`, `@mediapipe/face_detection`, `onnxruntime-web`)
  load **client-side at runtime** — the agent proxy does not affect them, but
  they were not exercised here.
- **ML-3 ONNX model not shipped.** `static/models/re-classifier.onnx` does
  not exist, so the worker uses a **clearly-marked, non-ML heuristic**
  (clip geometry/length → drone/exterior/interior/detail). The full ONNX
  path (ImageNet normalize → softmax → vote) is coded and activates
  automatically when a trained model is dropped into `static/models/`.
- **Whisper model caching** uses `@xenova/transformers`' built-in **browser
  Cache Storage**, not IndexedDB as the spec literally requested. Same
  "download once" UX; the library owns the storage. `MODEL_READY.cached`
  reports hits.
- **LOOP-2 frontend quality badge.** The data (`attempts`, `quality_check`,
  `quality_warning`) is surfaced by `GET /api/export/status/<id>`, but no
  dedicated export-modal badge was added because the **editor's primary
  export still uses the existing `/api/export` + SSE path**, not the new
  `/api/export/start`. Any consumer of the new path gets the metadata.

---

## ❌ Failed

None. Every sprint produced compiling, syntactically-valid, integrated code.
The only unexercised paths are those gated on FFmpeg/browser availability
(above), not failures.

---

## 🏗 Architecture decisions made autonomously

1. **Adapt, don't rewrite.** Treated the prompts' greenfield assumptions as
   intent, not literal spec, because the repo already implements most of it
   differently (and better). Filled real gaps additively; left mature
   systems and the three protected pipeline functions untouched.
2. **CORE-2 as a decoupled package.** Rather than bend the protected
   `run_export_job`, added a standalone `export/` package + additive routes.
   Two export paths now coexist: the editor's `/api/export` (SSE) and the
   spec's `/api/export/start`. Documented in `export/__init__.py`.
3. **New merge route for browser ML.** `POST /api/clip/ai-cache` merges
   worker-computed fields into `ai_cache`; the existing `/api/clip/analyze`
   is FFmpeg-only and would overwrite, not merge.
4. **Frames extracted on the main thread** (ImageBitmaps) and passed to the
   MediaPipe/ONNX workers, instead of passing `videoUrl` for worker-side
   decode (not reliably supported). One decode path, shared via `frameUtil`.
5. **New editor APIs over surgery.** Added `addCaptionLayers`, `addOverlay`,
   and `canvasW/H` getters to the editor's public surface and built four
   self-contained modules (`captions/face-detect/shot-classify/re-workflow`)
   that hook `window.MC.editor` — instead of editing the 4600-line
   `editor.js` invasively. Matches the existing `timeline.js` modular style.
6. **WorkerBridge shim.** Exposed the ES-module `WorkerBridge` to the classic
   editor scripts via a `<script type="module">` shim in `editor.html`
   (`window.MC.WorkerBridge`).
7. **`L` key rebinding.** `J/K/L` shuttle (CORE-1) took `L` from the
   logo-picker shortcut; logo stays reachable via the toolbar button + Cmd+K.
8. **RE-1 `>$2M` tier.** "Letterbox 2.35:1" mapped to `16:9` + the existing
   `letterbox` flag, since the editor's aspects are `16:9/9:16/1:1`.
9. **CORE-3 decode placement.** Native `decodeAudioData` stays on the main
   thread (it's async/native); only the blocking scan moved to the worker.

---

## Files touched

**New:** `export/__init__.py`, `export/ffmpeg_export.py`,
`export/quality_checker.py`, `export/recovery_encoder.py`,
`export/export_loop.py`, `static/js/captions.js`, `static/js/face-detect.js`,
`static/js/shot-classify.js`, `static/js/re-workflow.js`,
`static/js/workers/classifier.worker.js`, `AUDIT.md`.

**Modified:** `app.py` (additive routes only), `static/js/editor.js`
(new APIs + shortcuts + worker-routed beats), `templates/editor.html`
(WorkerBridge shim + module script tags).
