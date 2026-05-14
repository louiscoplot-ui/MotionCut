"""
MotionCut - Local Video Editor
Flask backend with FFmpeg export pipeline.
Run: python app.py  ->  http://localhost:5000
"""
import os
import re
import json
import time
import uuid
import shlex
import shutil
import tempfile
import threading
import subprocess
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# Pillow is used for the sharpness measurement (edge variance on sampled
# thumbnails). See _measure_sharpness().
try:
    from PIL import Image, ImageFilter, ImageStat
    _PIL_AVAILABLE = True
except Exception:
    _PIL_AVAILABLE = False

# pillow-heif registers HEIC/HEIF as Pillow-decodable formats. Optional —
# if it's missing, the upload endpoint returns 415 with a clear message
# instead of silently failing.
try:
    import pillow_heif  # noqa: F401
    pillow_heif.register_heif_opener()
    _HEIF_AVAILABLE = True
except Exception:
    _HEIF_AVAILABLE = False
from flask import (
    Flask, request, jsonify, send_from_directory,
    render_template, Response, abort, url_for
)
from flask_cors import CORS

# ----------------------------------------------------------------------------
# Paths & config
# ----------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
# Storage roots are env-overridable so a hosted deploy (Render, Fly, etc.)
# can mount a persistent disk at e.g. /var/data and point both at it. Local
# dev keeps the legacy ./uploads, ./exports paths.
UPLOAD_DIR = Path(os.environ.get("MOTIONCUT_UPLOAD_DIR") or (BASE_DIR / "uploads"))
EXPORT_DIR = Path(os.environ.get("MOTIONCUT_EXPORT_DIR") or (BASE_DIR / "exports"))
TMP_DIR    = UPLOAD_DIR / ".chunks"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
EXPORT_DIR.mkdir(parents=True, exist_ok=True)
TMP_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_VIDEO = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
ALLOWED_IMAGE = {".png", ".jpg", ".jpeg", ".webp"}
ALLOWED_AUDIO = {".mp3", ".wav", ".m4a", ".aac"}

MAX_CONTENT_LENGTH = 2 * 1024 * 1024 * 1024  # 2GB

app = Flask(
    __name__,
    static_folder=str(BASE_DIR / "static"),
    template_folder=str(BASE_DIR / "templates"),
)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH
CORS(app)


# ----------------------------------------------------------------------------
# In-memory job tracker for export progress
# ----------------------------------------------------------------------------
JOBS = {}
JOBS_LOCK = threading.Lock()
# Persist JOBS to disk so /api/generate/<id>/status survives multi-process
# hops (gunicorn workers don't share memory) and cold restarts. The dict
# stays in-memory for the hot path; the JSON file is the cross-process
# fallback. Path resolved lazily — EXPORT_DIR is defined just below.
_JOBS_FILE = None


def _jobs_file():
    global _JOBS_FILE
    if _JOBS_FILE is None:
        _JOBS_FILE = EXPORT_DIR / "jobs.json"
    return _JOBS_FILE


def _persist_jobs_unlocked():
    """Atomic write of JOBS to disk. Caller holds JOBS_LOCK. Failures are
    silenced — telemetry I/O must never break a request."""
    try:
        path = _jobs_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(JOBS, f)
        tmp.replace(path)
    except Exception:
        pass


def _hydrate_jobs_unlocked():
    """Merge disk into JOBS for keys we don't already hold. Caller holds
    JOBS_LOCK. In-memory wins on conflict (it may be ahead of the last flush
    from a sibling process). Corrupt JSON is ignored — losing the tracker
    history is fine; crashing every poll is not."""
    path = _jobs_file()
    if not path.exists():
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return
    if not isinstance(data, dict):
        return
    for k, v in data.items():
        if k not in JOBS and isinstance(v, dict):
            JOBS[k] = v


def _load_jobs_from_disk():
    """Bootstrap-time hydration. Logs how many jobs were recovered."""
    with JOBS_LOCK:
        _hydrate_jobs_unlocked()
    print(f"[jobs] hydrated {len(JOBS)} job(s) from {_jobs_file()}", flush=True)


def set_job(job_id, **fields):
    with JOBS_LOCK:
        job = JOBS.setdefault(job_id, {})
        job.update(fields)
        _persist_jobs_unlocked()


def get_job(job_id):
    with JOBS_LOCK:
        if job_id not in JOBS:
            _hydrate_jobs_unlocked()
        return dict(JOBS.get(job_id, {}))


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def safe_name(name):
    name = os.path.basename(name)
    name = re.sub(r"[^A-Za-z0-9_.\-]", "_", name)
    return name or f"file_{uuid.uuid4().hex}"


def safe_project_id(s):
    s = re.sub(r"[^A-Za-z0-9_\-]", "_", str(s or ""))
    return s[:80] or "default"


def project_dir(pid):
    """Return path to a project's upload folder, creating it if missing."""
    pid = safe_project_id(pid)
    d = UPLOAD_DIR / pid
    d.mkdir(parents=True, exist_ok=True)
    return d


def project_display_name(pid):
    """Strip leading timestamp prefix and tidy underscores → spaces."""
    name = re.sub(r"^\d{14}_", "", pid)
    return name.replace("_", " ") or pid


def list_projects():
    out = []
    for p in sorted(UPLOAD_DIR.iterdir(), key=lambda x: x.name, reverse=True):
        if not p.is_dir() or p.name.startswith("."):
            continue
        files = [f for f in p.iterdir() if f.is_file()]
        out.append({
            "id":         p.name,
            "name":       project_display_name(p.name),
            "created":    p.stat().st_mtime,
            "file_count": len(files),
        })
    return out


def migrate_legacy_uploads():
    """
    Move any loose files in uploads/ (from before projects existed) into
    uploads/default/ so they remain accessible via the new structure.
    """
    default = project_dir("default")
    moved = 0
    for f in list(UPLOAD_DIR.iterdir()):
        if f.is_file():
            try:
                shutil.move(str(f), str(default / f.name))
                moved += 1
            except Exception:
                pass
    if moved:
        print(f"[projects] migrated {moved} legacy file(s) into uploads/default/")


def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    # Common Windows fallbacks
    for c in [
        r"C:\\ffmpeg\\bin\\ffmpeg.exe",
        r"C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
        r"C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe",
    ]:
        if os.path.isfile(c):
            return c
    return "ffmpeg"


FFMPEG = find_ffmpeg()


# ----------------------------------------------------------------------------
# Auto-pull from origin every 15s so refreshing the browser always shows the
# latest commit. Local edits are stashed automatically. Disabled if the env var
# MOTIONCUT_NO_AUTOPULL is set or if .git is missing.
# ----------------------------------------------------------------------------
def auto_pull_loop():
    last_sha = None
    while True:
        try:
            subprocess.run(
                ["git", "fetch", "--quiet", "origin"],
                cwd=str(BASE_DIR), capture_output=True, timeout=15
            )
            r = subprocess.run(
                ["git", "pull", "--rebase", "--autostash", "--quiet"],
                cwd=str(BASE_DIR), capture_output=True, text=True, timeout=20
            )
            sha = subprocess.run(
                ["git", "rev-parse", "--short", "HEAD"],
                cwd=str(BASE_DIR), capture_output=True, text=True, timeout=5
            ).stdout.strip()
            if sha and sha != last_sha:
                if last_sha is not None:
                    print(f"[auto-pull] updated → {sha}")
                last_sha = sha
        except Exception as e:
            pass
        time.sleep(15)


def start_auto_pull():
    if os.environ.get("MOTIONCUT_NO_AUTOPULL"):
        print("[auto-pull] disabled via MOTIONCUT_NO_AUTOPULL")
        return
    if not (BASE_DIR / ".git").exists():
        return
    t = threading.Thread(target=auto_pull_loop, daemon=True)
    t.start()
    print("[auto-pull] watching origin every 15s")


def ffmpeg_available():
    try:
        subprocess.run(
            [FFMPEG, "-version"],
            capture_output=True, check=True, timeout=5
        )
        return True
    except Exception:
        return False


def probe_duration(path):
    """Get duration in seconds from a video file using ffmpeg."""
    try:
        out = subprocess.run(
            [FFMPEG, "-i", str(path)],
            capture_output=True, text=True, timeout=15
        ).stderr
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.?\d*)", out)
        if m:
            h, mm, s = m.groups()
            return int(h) * 3600 + int(mm) * 60 + float(s)
    except Exception:
        pass
    return 0.0


def ff_escape(text):
    """Escape text for FFmpeg drawtext."""
    if text is None:
        text = ""
    return (
        str(text)
        .replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\\\\\'")
        .replace("%", "\\%")
        .replace(",", "\\,")
        .replace("[", "\\[")
        .replace("]", "\\]")
    )


def color_grade_filter(grade):
    """Return an ffmpeg filter chain string for a color grade preset."""
    grade = (grade or "natural").lower()
    presets = {
        "natural":   "eq=contrast=1.02:saturation=1.05",
        "cinematic": "curves=preset=increase_contrast,eq=saturation=0.9:contrast=1.1",
        "teal_orange": "colorbalance=rs=-.1:gs=-.05:bs=.15:rm=.05:gm=0:bm=-.05:rh=.1:gh=.05:bh=-.1,eq=saturation=1.2:contrast=1.05",
        "moody_dark": "eq=brightness=-0.05:contrast=1.15:saturation=0.85,curves=preset=darker",
        "bright_airy": "eq=brightness=0.06:contrast=0.95:saturation=1.1,curves=preset=lighter",
        "bw":        "hue=s=0,eq=contrast=1.1",
    }
    return presets.get(grade, presets["natural"])


# ----------------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------------
@app.after_request
def add_no_cache_headers(resp):
    # For HTML / static assets we want the browser to always re-fetch, so a
    # simple refresh after `git pull` (manual or auto) shows the latest UI.
    # Uploads/exports keep their default headers (range requests etc).
    p = request.path
    if p == "/" or p.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp


def _git_short_sha():
    """Best-effort short git SHA. Used as a cache-bust suffix on static assets
    so the browser can't serve stale JS/CSS after a redeploy."""
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(BASE_DIR), capture_output=True, text=True, timeout=5
        ).stdout.strip() or "dev"
    except Exception:
        return "dev"


@app.route("/")
def index():
    return render_template("index.html", build_version=_git_short_sha())


@app.route("/api/version")
def api_version():
    """Returns the current git SHA so the front-end can check for updates."""
    try:
        sha = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(BASE_DIR), capture_output=True, text=True, timeout=5
        ).stdout.strip()
        return jsonify({"sha": sha})
    except Exception:
        return jsonify({"sha": None})


@app.route("/api/build-pulse")
def api_build_pulse():
    """Server-Sent Events stream that emits the current build SHA every few
    seconds. The frontend opens an EventSource on this endpoint at boot and
    auto-reloads itself when the SHA changes — eliminating the "I push,
    you Cmd+Shift+R" loop the user has been stuck in.

    Each event is a JSON line: {"sha": "abc1234"}. Heartbeats happen even
    when nothing changed (keeps idle proxies from killing the connection).
    """
    def gen():
        last = None
        # Send the first SHA immediately so the client can compare against
        # the SHA baked into its HTML at load time.
        while True:
            try:
                sha = _git_short_sha()
            except Exception:
                sha = "dev"
            payload = json.dumps({"sha": sha})
            yield f"data: {payload}\n\n"
            last = sha
            # Heartbeat / poll cadence. 4s is fast enough to feel instant
            # after a push but light enough to not flood the gunicorn
            # worker with subprocess spawns.
            time.sleep(4)
    resp = Response(gen(), mimetype="text/event-stream")
    # Disable proxy buffering so each event reaches the client without
    # waiting for a chunk to fill (Codespaces edge can buffer otherwise).
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["X-Accel-Buffering"] = "no"
    return resp


@app.route("/api/health")
def health():
    # upload_chunk_mb lets the frontend right-size its chunk POSTs to fit
    # under whatever the deployment proxy allows. Set MOTIONCUT_CHUNK_MB on
    # the server to match nginx client_max_body_size (4 MB stays below the
    # 8 MB nginx default; raise it to reduce request count on big files).
    try:
        chunk_mb = max(1, int(os.environ.get("MOTIONCUT_CHUNK_MB", "4")))
    except (TypeError, ValueError):
        chunk_mb = 4
    return jsonify({
        "ok":              True,
        "ffmpeg":          ffmpeg_available(),
        "upload_chunk_mb": chunk_mb,
    })


@app.route("/api/thumbnail")
def api_thumbnail():
    """Extract a single frame from a project video as a JPEG. Cached on disk
    next to the source so repeat hits are zero-cost. Browser caches on the
    URL since project + filename + t are stable."""
    project = request.args.get("project") or "default"
    filename = request.args.get("filename")
    t = float(request.args.get("t") or 0.5)
    if not filename:
        return jsonify({"error": "missing filename"}), 400
    pdir = project_dir(project)
    src = pdir / safe_name(filename)
    if not src.exists():
        legacy = UPLOAD_DIR / safe_name(filename)
        if legacy.exists(): src = legacy
        else: return jsonify({"error": "not found"}), 404
    # Photos are their own thumbnail — just serve them through to spare ffmpeg.
    if src.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        return send_from_directory(str(src.parent), src.name)
    # Cache key includes the timestamp, in case we ever expose t > 0 in the UI.
    cache = pdir / f".thumb_{src.stem}_{int(t*1000)}.jpg"
    if not cache.exists():
        cmd = [FFMPEG, "-y", "-ss", f"{t:.3f}", "-i", str(src),
               "-frames:v", "1", "-vf", "scale=320:-2",
               "-q:v", "5", str(cache)]
        try:
            subprocess.run(cmd, capture_output=True, timeout=15)
        except Exception as e:
            return jsonify({"error": f"thumbnail failed: {e}"}), 500
    if not cache.exists():
        return jsonify({"error": "thumbnail produced no output"}), 500
    return send_from_directory(str(cache.parent), cache.name)


@app.route("/api/probe", methods=["POST"])
def api_probe():
    """Return the duration (in seconds) of an uploaded media file. Used by
    the editor to refine segment sourceOut after an upload returns a
    duration of 0 (e.g. when the chunked upload skipped the probe step)."""
    data = request.get_json(force=True, silent=True) or {}
    project = data.get("project") or data.get("project_id") or "default"
    filename = data.get("filename")
    if not filename:
        return jsonify({"error": "missing filename"}), 400
    pdir = project_dir(project)
    cand = pdir / safe_name(filename)
    if not cand.exists():
        legacy = UPLOAD_DIR / safe_name(filename)
        if legacy.exists(): cand = legacy
        else: return jsonify({"error": "not found"}), 404
    return jsonify({"duration": probe_duration(cand) or 0.0, "filename": filename})


@app.route("/api/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "no file"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "empty filename"}), 400

    ext = Path(f.filename).suffix.lower()
    # HEIC/HEIF: try to transparently convert to JPG via Pillow (needs
    # pillow-heif registered as a plugin). If Pillow + pillow-heif are
    # absent, or the file is not decodable, fall back to a clear 415 so
    # the user knows to convert client-side.
    heic_convert = ext in (".heic", ".heif")
    if heic_convert and not _PIL_AVAILABLE:
        return jsonify({
            "error": "HEIC/HEIF not supported on this server — install Pillow + "
                     "pillow-heif, or convert to JPG before uploading."
        }), 415

    kind = request.form.get("kind", "auto")
    if kind == "auto":
        if ext in ALLOWED_VIDEO:
            kind = "video"
        elif ext in ALLOWED_IMAGE or heic_convert:
            kind = "image"
        elif ext in ALLOWED_AUDIO:
            kind = "audio"
        else:
            return jsonify({"error": f"unsupported extension {ext}"}), 415

    allowed = {
        "video": ALLOWED_VIDEO,
        "image": ALLOWED_IMAGE,
        "audio": ALLOWED_AUDIO,
    }[kind]
    # HEIC arrives with kind=image; its extension isn't in ALLOWED_IMAGE
    # (we strip it after conversion) — let it through.
    if ext not in allowed and not (heic_convert and kind == "image"):
        return jsonify({"error": f"{ext} not allowed for {kind}"}), 415

    project = request.form.get("project") or "default"
    out_dir = project_dir(project)

    fid = uuid.uuid4().hex[:12]
    fname = f"{fid}_{safe_name(f.filename)}"
    out_path = out_dir / fname
    f.save(str(out_path))

    # HEIC → JPG conversion. Pillow needs pillow-heif registered to decode
    # HEIC; if that's missing, Image.open raises UnidentifiedImageError and
    # we surface a clean 415. On success we rewrite out_path / fname to the
    # .jpg so the rest of the pipeline never sees the original.
    if heic_convert:
        try:
            from PIL import Image, UnidentifiedImageError
            try:
                with Image.open(out_path) as img:
                    img = img.convert("RGB")
                    new_name = Path(fname).with_suffix(".jpg").name
                    new_path = out_dir / new_name
                    img.save(str(new_path), "JPEG", quality=92)
            except (UnidentifiedImageError, OSError) as decode_err:
                out_path.unlink(missing_ok=True)
                msg = ("HEIC decode failed — file is corrupt or not a real HEIC."
                       if _HEIF_AVAILABLE
                       else "HEIC decode failed — pillow-heif is not installed on "
                            "the server, so this file can't be read. Convert to "
                            "JPG locally and try again.")
                return jsonify({"error": msg}), 415
            out_path.unlink(missing_ok=True)
            out_path = new_path
            fname    = new_name
        except Exception as e:
            print(f"[upload] HEIC conversion failed for {f.filename!r}: {e!r}", flush=True)
            out_path.unlink(missing_ok=True)
            return jsonify({"error": f"HEIC conversion failed: {e}"}), 415

    # Skip the synchronous probe — it's the slowest step on large files and
    # blocks the parallel upload pipeline. The frontend calls /api/probe
    # lazily after the upload returns, then patches segment durations in place.
    return jsonify({
        "ok":       True,
        "id":       fid,
        "project":  safe_project_id(project),
        "filename": fname,
        "kind":     kind,
        "url":      url_for("serve_project_file", project=safe_project_id(project), filename=fname),
        "duration": None,
        "size":     out_path.stat().st_size,
    })


CHUNK_ASSEMBLY_TIMEOUT_SECONDS = 30.0


@app.route("/api/upload/chunk", methods=["POST"])
def upload_chunk():
    """
    Chunked upload to bypass reverse-proxy body-size limits (Codespaces, etc.).
    Form fields: uploadId, chunkIndex, totalChunks, filename, kind, chunk(file)

    Sprint 7: chunks may arrive out of order (client uploads 4 in parallel per
    batch). Each chunk is saved to its own file `<upload_id>.chunk.NNNNNN`.
    The request handling the final chunk (idx == total-1) waits until every
    chunk is on disk, concatenates them in order, then deletes the parts.
    """
    upload_id = request.form.get("uploadId", "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", upload_id):
        return jsonify({"error": "bad uploadId"}), 400
    try:
        idx = int(request.form.get("chunkIndex", "-1"))
        total = int(request.form.get("totalChunks", "0"))
    except ValueError:
        return jsonify({"error": "bad chunk index"}), 400
    if idx < 0 or total <= 0 or idx >= total:
        return jsonify({"error": "bad chunk range"}), 400

    chunk = request.files.get("chunk")
    if not chunk:
        return jsonify({"error": "no chunk"}), 400

    part_path = TMP_DIR / f"{upload_id}.chunk.{idx:06d}"
    chunk.save(str(part_path))

    if idx < total - 1:
        return jsonify({"ok": True, "received": idx + 1, "of": total})

    # Final chunk: wait for every part, then assemble in order.
    deadline = time.monotonic() + CHUNK_ASSEMBLY_TIMEOUT_SECONDS
    missing = None
    while time.monotonic() < deadline:
        missing = [i for i in range(total)
                   if not (TMP_DIR / f"{upload_id}.chunk.{i:06d}").exists()]
        if not missing:
            break
        time.sleep(0.05)
    if missing:
        return jsonify({"error": f"chunk assembly timed out, missing: {missing[:5]}"}), 504

    filename = request.form.get("filename", "upload.bin")
    ext = Path(filename).suffix.lower()
    kind = request.form.get("kind", "auto")
    if kind == "auto":
        if ext in ALLOWED_VIDEO: kind = "video"
        elif ext in ALLOWED_IMAGE: kind = "image"
        elif ext in ALLOWED_AUDIO: kind = "audio"
        else:
            for i in range(total):
                (TMP_DIR / f"{upload_id}.chunk.{i:06d}").unlink(missing_ok=True)
            return jsonify({"error": f"unsupported extension {ext}"}), 400
    allowed = {"video": ALLOWED_VIDEO, "image": ALLOWED_IMAGE, "audio": ALLOWED_AUDIO}[kind]
    if ext not in allowed:
        for i in range(total):
            (TMP_DIR / f"{upload_id}.chunk.{i:06d}").unlink(missing_ok=True)
        return jsonify({"error": f"{ext} not allowed for {kind}"}), 400

    project = request.form.get("project") or "default"
    out_dir = project_dir(project)

    fid = uuid.uuid4().hex[:12]
    fname = f"{fid}_{safe_name(filename)}"
    out_path = out_dir / fname

    with open(out_path, "wb") as out_f:
        for i in range(total):
            piece = TMP_DIR / f"{upload_id}.chunk.{i:06d}"
            with open(piece, "rb") as in_f:
                shutil.copyfileobj(in_f, out_f, length=1024 * 1024)
            piece.unlink(missing_ok=True)

    # Skip the synchronous probe — it's the slowest step on large files and
    # blocks the parallel upload pipeline. The frontend calls /api/probe
    # lazily after the upload returns, then patches segment durations in place.
    return jsonify({
        "ok":       True,
        "id":       fid,
        "project":  safe_project_id(project),
        "filename": fname,
        "kind":     kind,
        "url":      url_for("serve_project_file", project=safe_project_id(project), filename=fname),
        "duration": None,
        "size":     out_path.stat().st_size,
    })


@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    """Legacy serve route. Falls back to the default project if the file
    isn't at the root anymore (post-migration)."""
    p = UPLOAD_DIR / filename
    if p.exists():
        return send_from_directory(str(UPLOAD_DIR), filename, conditional=True)
    # Try the default project
    return send_from_directory(str(project_dir("default")), filename, conditional=True)


@app.route("/projects/<project>/files/<path:filename>")
def serve_project_file(project, filename):
    return send_from_directory(str(project_dir(project)), filename, conditional=True)


@app.route("/api/projects", methods=["GET"])
def api_projects_list():
    if not list_projects():
        project_dir("default")  # auto-create
    return jsonify({"projects": list_projects()})


@app.route("/api/projects", methods=["POST"])
def api_projects_create():
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "Untitled").strip()
    safe = re.sub(r"[^A-Za-z0-9_\-]", "_", name).lower()[:30] or "project"
    pid = time.strftime("%Y%m%d%H%M%S") + "_" + safe
    project_dir(pid)
    return jsonify({"id": pid, "name": name})


@app.route("/api/projects/<pid>/files", methods=["GET"])
def api_project_files(pid):
    d = project_dir(pid)
    out = []
    for f in sorted(d.iterdir(), key=lambda x: -x.stat().st_mtime):
        if not f.is_file():
            continue
        # Hide internal cache files (thumbnails, etc) from the user-visible
        # library — they're an implementation detail of /api/thumbnail.
        if f.name.startswith(".thumb_") or f.name.startswith("."):
            continue
        ext = f.suffix.lower()
        if ext in ALLOWED_VIDEO:   kind = "video"
        elif ext in ALLOWED_IMAGE: kind = "image"
        elif ext in ALLOWED_AUDIO: kind = "audio"
        else: continue
        # Probe duration lazily here too — it's the only place we expose it,
        # and it's a fast probe on cached files. Yes this re-probes on every
        # listing call; in practice the listing isn't a hot path.
        duration = 0.0
        if kind in ("video", "audio"):
            try:
                duration = probe_duration(f) or 0.0
            except Exception:
                duration = 0.0
        out.append({
            "name":     f.name,
            "kind":     kind,
            "size":     f.stat().st_size,
            "modified": f.stat().st_mtime,
            "duration": duration,
            "url":      url_for("serve_project_file", project=safe_project_id(pid), filename=f.name),
        })
    return jsonify({"files": out})


@app.route("/api/projects/<pid>/files/<path:filename>", methods=["DELETE"])
def api_project_file_delete(pid, filename):
    d = project_dir(pid)
    safe = safe_name(filename)
    target = d / safe
    if not target.exists() or not target.is_file():
        return jsonify({"error": "file not found"}), 404
    try:
        target.unlink()
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True})


@app.route("/api/projects/<pid>", methods=["DELETE"])
def api_projects_delete(pid):
    d = project_dir(pid)
    if pid == "default":
        return jsonify({"error": "cannot delete default project"}), 400
    try:
        shutil.rmtree(str(d))
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True})


@app.route("/api/projects/<pid>/rename", methods=["POST"])
def api_projects_rename(pid):
    """
    Rename / save a project. If pid is 'default', this CLONES the default
    folder into a new named folder (so 'Default' stays as a fresh workspace
    and the user's work is preserved under the chosen name). Otherwise this
    moves the existing folder to a new name.
    """
    data = request.get_json(force=True, silent=True) or {}
    raw_name = (data.get("name") or "").strip()
    if not raw_name:
        return jsonify({"error": "name required"}), 400
    slug = re.sub(r"[^A-Za-z0-9_\-]", "_", raw_name).lower()[:40] or "project"
    new_pid = time.strftime("%Y%m%d%H%M%S") + "_" + slug
    src_dir = project_dir(pid)
    dst_dir = UPLOAD_DIR / new_pid
    if dst_dir.exists():
        return jsonify({"error": "destination exists"}), 409

    try:
        if pid == "default":
            # Copy then leave the default empty for next session
            shutil.copytree(str(src_dir), str(dst_dir))
            # Move (don't delete) — empty default by removing files
            for f in list(src_dir.iterdir()):
                if f.is_file():
                    try: f.unlink()
                    except Exception: pass
        else:
            shutil.move(str(src_dir), str(dst_dir))
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({"ok": True, "id": new_pid, "name": raw_name})


# ----------------------------------------------------------------------------
# Project documents (project.motioncut.json) — single source of truth.
# These endpoints are the I/O contract used by the frontend project-state.js
# module and by every current/future AI feature.
# ----------------------------------------------------------------------------
SCHEMA_URL = "https://motioncut.dev/schemas/project/v1.json"
SCHEMA_VERSION = 1
DOC_FILENAME = "project.motioncut.json"

# Valid style_id values — mirrors schemas/project.schema.json. Update all
# three locations (schema, JS validator, here) when adding a template.
KNOWN_STYLE_IDS = {
    "custom",
    "cinematic", "real_estate", "travel", "social", "corporate",
    "re_drone_reveal", "re_property_tour", "re_listing_card", "re_agent_intro",
    "social_hook_reveal", "social_listicle",
    "cinematic_three_act", "kinetic_word_pop",
    "magic_cinematic", "magic_luxury_re", "magic_social_reel", "magic_editorial",
    "magic_modern_luxury", "magic_moody", "magic_energetic", "magic_corporate",
}


def _validate_project_document(doc):
    """Minimal hand-rolled validator. Returns a list of errors (empty if valid).
    Mirrors schemas/project.schema.json. Frontend has a richer validator;
    here we only enforce enough to refuse obviously broken documents."""
    errors = []
    if not isinstance(doc, dict):
        return ["document must be an object"]
    if doc.get("schema") != SCHEMA_URL:
        errors.append(f"schema: must equal {SCHEMA_URL}")
    if doc.get("version") != SCHEMA_VERSION:
        errors.append(f"version: must equal {SCHEMA_VERSION}")
    for key in ("id", "name", "created_at", "modified_at"):
        if not isinstance(doc.get(key), str) or not doc.get(key):
            errors.append(f"{key}: required string")
    for key in ("clips", "segments", "layers"):
        if key in doc and not isinstance(doc[key], list):
            errors.append(f"{key}: must be array")
    ep = doc.get("edit_params") or {}
    if ep.get("aspect_ratio") not in (None, "16:9", "9:16", "1:1"):
        errors.append("edit_params.aspect_ratio: must be 16:9 / 9:16 / 1:1")
    if ep.get("pacing") not in (None, "slow", "balanced", "fast"):
        errors.append("edit_params.pacing: must be slow / balanced / fast")
    if ep.get("style_id") is not None and ep["style_id"] not in KNOWN_STYLE_IDS:
        errors.append(f"edit_params.style_id: unknown style '{ep['style_id']}'")
    return errors


def _project_doc_path(pid):
    return project_dir(pid) / DOC_FILENAME


@app.route("/schemas/project.schema.json")
def serve_project_schema():
    """Serve the JSON schema as static so tools can $ref it."""
    return send_from_directory(str(BASE_DIR / "schemas"), "project.schema.json",
                               mimetype="application/json")


@app.route("/api/project/save", methods=["POST"])
def api_project_save():
    """
    Save the v1 project document for a given project id.

    Body: { project: <pid>, document: <ProjectDocument> }
    Writes atomically: tmp file + rename.
    """
    data = request.get_json(force=True, silent=True) or {}
    pid = data.get("project") or "default"
    doc = data.get("document")
    errors = _validate_project_document(doc)
    if errors:
        return jsonify({"error": "invalid document", "details": errors}), 400

    # Always re-stamp modified_at server-side
    doc["modified_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    out = _project_doc_path(pid)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".json.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
        tmp.replace(out)            # atomic — won't leave half-written files
    except Exception as e:
        try: tmp.unlink(missing_ok=True)
        except Exception: pass
        return jsonify({"error": str(e)}), 500

    return jsonify({
        "ok":          True,
        "id":          doc["id"],
        "modified_at": doc["modified_at"],
        "path":        str(out.relative_to(BASE_DIR)),
    })


@app.route("/api/project/load/<pid>", methods=["GET"])
def api_project_load(pid):
    """
    Load the v1 project document for a given project id.
    Returns 404 if the project has no saved document yet.
    """
    p = _project_doc_path(pid)
    if not p.exists():
        return jsonify({"error": f"no project document for {pid}"}), 404
    try:
        with open(p, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except Exception as e:
        return jsonify({"error": "could not parse document: " + str(e)}), 500
    errors = _validate_project_document(doc)
    return jsonify({
        "ok":       True,
        "document": doc,
        "warnings": errors if errors else None,
    })


# ----------------------------------------------------------------------------
# AI / Auto-Edit pipeline
#
# Two endpoints sit on top of FFmpeg subprocess + Pillow:
#   POST /api/clip/analyze   — single-clip analysis, cached in ai_cache
#   POST /api/auto-edit      — multi-clip planner, returns an EditPlan
#
# Analysis is FFmpeg-bound (CPU + IO), not GIL-bound, so we parallelize via
# ThreadPoolExecutor when a request asks for many clips.
# Per-project locks guard the project document from concurrent r/m/w when
# the analyzer writes to ai_cache.
# ----------------------------------------------------------------------------
_doc_locks = defaultdict(threading.Lock)


def _doc_lock(pid):
    return _doc_locks[safe_project_id(pid)]


def _read_doc(pid):
    p = _project_doc_path(pid)
    if not p.exists():
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[ai] failed to read project doc {pid}: {e}")
        return None


def _write_doc_atomic(pid, doc):
    p = _project_doc_path(pid)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    tmp.replace(p)


def _minimal_doc(pid):
    """Minimal v1 document — used when analysis runs against a project that
    has no saved doc yet. The user's first explicit save will overwrite it."""
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return {
        "schema":      SCHEMA_URL,
        "version":     SCHEMA_VERSION,
        "id":          safe_project_id(pid),
        "name":        project_display_name(pid),
        "created_at":  now,
        "modified_at": now,
    }


def _get_cached_analysis(pid, filename):
    with _doc_lock(pid):
        doc = _read_doc(pid)
        if not doc:
            return None
        return (doc.get("ai_cache") or {}).get(filename)


def _set_cached_analysis(pid, filename, value):
    with _doc_lock(pid):
        doc = _read_doc(pid) or _minimal_doc(pid)
        cache = doc.setdefault("ai_cache", {})
        cache[filename] = value
        doc["modified_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _write_doc_atomic(pid, doc)


# ---- FFmpeg-based analysis primitives ---------------------------------------

# All regexes are anchored to the lavfi metadata format the filters emit.
# Never use eval() on FFmpeg output.
_RE_YAVG       = re.compile(r"lavfi\.signalstats\.YAVG=(-?\d+\.?\d*)")
_RE_VDIFF      = re.compile(r"lavfi\.signalstats\.YDIF=(-?\d+\.?\d*)")  # YDIF is per-frame motion
_RE_RMS        = re.compile(r"lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*|-?inf)")
_RE_SCENE_TIME = re.compile(r"pts_time:(\d+\.?\d*)")


def _ffprobe_duration(path):
    """Returns duration in seconds, or 0.0 on failure."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_streams", str(path)],
            capture_output=True, text=True, timeout=15
        )
        data = json.loads(out.stdout or "{}")
        for s in data.get("streams", []):
            if s.get("codec_type") == "video" and s.get("duration"):
                return float(s["duration"])
        # Fallback: format duration via probe_duration() which parses ffmpeg stderr
        return probe_duration(path)
    except Exception:
        return probe_duration(path)


def _ffmpeg_signalstats(path, debug=False, sample_every=3):
    """
    Run signalstats on every Nth frame, return (brightness, motion).

    brightness ∈ [0,1]  — mean luma normalized from 0..255
    motion     ∈ [0,1]  — mean YDIF (frame-to-frame luma change), normalized
                          empirically by /30 (sharp action ≈ 30, static ≈ 0.5)
    """
    cmd = [
        FFMPEG, "-i", str(path),
        "-vf", f"select='not(mod(n\\,{sample_every}))',signalstats,metadata=mode=print:file=-",
        "-an", "-f", "null", "-"
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return 0.5, 0.0, "" if not debug else "[timeout]"
    raw = (proc.stdout or "") + "\n" + (proc.stderr or "")
    yavgs  = [float(m) for m in _RE_YAVG.findall(raw)]
    vdiffs = [float(m) for m in _RE_VDIFF.findall(raw)]
    brightness = (sum(yavgs)  / len(yavgs))  / 255.0 if yavgs  else 0.5
    motion     = min(1.0, (sum(vdiffs) / len(vdiffs)) / 30.0) if vdiffs else 0.0
    return brightness, motion, raw if debug else ""


def _ffmpeg_scene_cuts(path, threshold=0.4, debug=False):
    """Returns list of cut timestamps (seconds) where scene change > threshold."""
    cmd = [
        FFMPEG, "-i", str(path),
        "-vf", f"select='gt(scene\\,{threshold})',showinfo",
        "-an", "-f", "null", "-"
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return [], "" if not debug else "[timeout]"
    stderr = proc.stderr or ""
    cuts = sorted(set(round(float(m), 3) for m in _RE_SCENE_TIME.findall(stderr)))
    return cuts, stderr if debug else ""


def _ffmpeg_audio_energy(path, debug=False):
    """
    Returns audio energy ∈ [0,1].

    RMS_level is dB. We clamp to [-60..0] dB and rescale linearly to [0..1]:
    -60dB → 0 (near silence)  0dB → 1 (peak). Average over per-frame frames.
    """
    cmd = [
        FFMPEG, "-i", str(path),
        "-af", "astats=metadata=1:reset=1,ametadata=mode=print:file=-",
        "-vn", "-f", "null", "-"
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return 0.0, "" if not debug else "[timeout]"
    raw = (proc.stdout or "") + "\n" + (proc.stderr or "")
    vals = []
    for m in _RE_RMS.findall(raw):
        try:
            v = float(m)
            if v == float("-inf") or v != v:   # filter NaN / -inf
                continue
            vals.append(v)
        except Exception:
            pass
    if not vals:
        return 0.0, raw if debug else ""
    avg_db = sum(vals) / len(vals)
    energy = max(0.0, min(1.0, (avg_db + 60.0) / 60.0))
    return energy, raw if debug else ""


def _measure_sharpness(path, duration):
    """
    Sample 3 thumbnails (25/50/75% of duration), compute edge-image variance
    via PIL FIND_EDGES + ImageStat, average them, normalize by /1500
    (empirically sharp footage ≈ 800–2000, blurry < 200).
    """
    if not _PIL_AVAILABLE or duration < 0.5:
        return 0.5
    sample_times = [duration * 0.25, duration * 0.5, duration * 0.75]
    variances = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, t in enumerate(sample_times):
            out = os.path.join(tmp, f"thumb_{i}.jpg")
            cmd = [FFMPEG, "-y", "-ss", f"{t:.3f}", "-i", str(path),
                   "-frames:v", "1", "-vf", "scale=320:-1", out]
            try:
                subprocess.run(cmd, capture_output=True, timeout=15)
                if os.path.exists(out):
                    img = Image.open(out).convert("RGB")
                    edges = img.filter(ImageFilter.FIND_EDGES).convert("L")
                    stat = ImageStat.Stat(edges)
                    if stat.var:
                        variances.append(stat.var[0])
            except Exception:
                pass
    if not variances:
        return 0.5
    avg = sum(variances) / len(variances)
    return max(0.0, min(1.0, avg / 1500.0))


def _analyze_clip_file(path, debug=False):
    """Run all analyses on one file and compose the result dict."""
    duration = _ffprobe_duration(path)
    if duration <= 0:
        return {"error": "could not probe duration", "duration": 0.0}

    brightness, motion, sig_raw = _ffmpeg_signalstats(path, debug=debug)
    cuts,                cut_raw = _ffmpeg_scene_cuts(path, debug=debug)
    audio_energy,        aud_raw = _ffmpeg_audio_energy(path, debug=debug)
    sharpness                    = _measure_sharpness(path, duration)

    # Composite score:
    #   motion       → engaging clips score higher
    #   sharpness    → blurry clips penalised
    #   brightness_ok → distance from 0.5 = penalty (too dark/blown out is bad)
    #   audio_energy → silent clips slightly down-ranked
    brightness_ok = max(0.0, 1.0 - abs(brightness - 0.5) * 2.0)
    score = (motion       * 0.35 +
             sharpness    * 0.30 +
             brightness_ok * 0.20 +
             audio_energy * 0.15)

    result = {
        "duration":     round(duration, 3),
        "shot_score":   round(score, 4),
        "motion":       round(motion, 4),
        "sharpness":    round(sharpness, 4),
        "brightness":   round(brightness, 4),
        "audio_energy": round(audio_energy, 4),
        "scene_cuts":   cuts,
        "has_face":     False,        # placeholder — MediaPipe in a future push
        "shot_type":    "unknown",    # placeholder — classifier in a future push
        "analyzed_at":  time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if debug:
        result["debug"] = {
            "signalstats_raw_tail": (sig_raw or "")[-2000:],
            "scene_raw_tail":       (cut_raw or "")[-2000:],
            "audio_raw_tail":       (aud_raw or "")[-2000:],
        }
    return result


@app.route("/api/clip/analyze", methods=["POST"])
def api_clip_analyze():
    """
    POST { projectId, filename, force?: bool }
    Returns clip analysis (cached when available unless force=true).
    """
    data = request.get_json(force=True, silent=True) or {}
    pid = data.get("projectId") or "default"
    filename = data.get("filename")
    force = bool(data.get("force"))
    debug = request.args.get("debug") == "1"

    if not filename:
        return jsonify({"error": "missing filename"}), 400

    if not force:
        cached = _get_cached_analysis(pid, filename)
        if cached:
            return jsonify({**cached, "filename": filename, "cached": True})

    src = project_dir(pid) / safe_name(filename)
    if not src.exists():
        return jsonify({"error": f"file not found: {filename}"}), 404

    try:
        result = _analyze_clip_file(src, debug=debug)
    except Exception as e:
        return jsonify({"error": str(e), "filename": filename}), 500

    # Cache only the non-debug payload
    cache_payload = {k: v for k, v in result.items() if k != "debug"}
    cache_payload["filename"] = filename
    try:
        _set_cached_analysis(pid, filename, cache_payload)
    except Exception as e:
        print(f"[ai] cache write failed for {filename}: {e}")

    return jsonify({**result, "filename": filename, "cached": False})


# ---- /api/auto-edit ----------------------------------------------------------

_PACING_SEG_DUR = {"slow": 4.5, "balanced": 3.0, "fast": 1.8}
_MIN_SEG_DUR    = 1.2
_HEAD_TAIL_TRIM = 0.5
_BEAT_TOLERANCE = 0.4


IMAGE_HOLD_DUR = 8.0   # synthetic "duration" we give still images so the
                       # planner treats them like a short clip. Per-style
                       # SEG_DUR will clamp the actual on-screen time.

def _analyze_or_cached(pid, filename):
    """Used by /api/auto-edit and /api/generate. Returns the cached analysis
    if present; otherwise runs a full analysis and caches it. Always returns
    a dict (with an `error` key if the file can't be analysed).

    Image files (JPG / PNG / WEBP) get a synthetic analysis with
    duration=IMAGE_HOLD_DUR so they slot into the planner alongside videos;
    they're later pre-rendered to looped MP4s inside run_pipeline()."""
    cached = _get_cached_analysis(pid, filename)
    if cached:
        return {**cached, "filename": filename}
    src = project_dir(pid) / safe_name(filename)
    if not src.exists():
        return {"filename": filename, "error": "file not found"}
    # Images bypass FFmpeg analysis — they have no temporal content.
    if src.suffix.lower() in ALLOWED_IMAGE:
        result = {
            "duration":    IMAGE_HOLD_DUR,
            "shot_score":  0.55,
            "motion":      0.0,
            "sharpness":   0.5,
            "brightness":  0.5,
            "audio_energy": 0.0,
            "scene_cuts": [],
            "has_face":   False,
            "shot_type":  "unknown",
            "kind":       "image",
        }
        result["filename"] = filename
        _set_cached_analysis(pid, filename, result)
        return result
    try:
        result = _analyze_clip_file(src)
        result["filename"] = filename
        _set_cached_analysis(pid, filename, result)
        return result
    except Exception as e:
        return {"filename": filename, "error": str(e)}


def _image_to_video_cached(image_path, duration, target_w, target_h):
    """Render a JPG/PNG into a short looped MP4 so the multi-clip pipeline
    (which assumes video inputs) can treat it like any other segment.

    Output is cached next to the source as .img_<stem>_<ms>_<wxh>.mp4 so
    repeat generates with the same image + duration + resolution are free.
    The file naming convention starts with a dot so the project file
    listing endpoint hides it from the user (same pattern as .thumb_*)."""
    pdir = image_path.parent
    safe_dur_ms = int(round(float(duration) * 1000))
    cache = pdir / f".img_{image_path.stem}_{safe_dur_ms}_{target_w}x{target_h}.mp4"
    if cache.exists() and cache.stat().st_size > 0:
        return cache
    # Scale the still to cover the target canvas, pad to the exact size.
    # yuv420p + libx264 so the output mixes cleanly with the real clips.
    cmd = [
        FFMPEG, "-y",
        "-loop", "1",
        "-t", f"{float(duration):.3f}",
        "-i", str(image_path),
        "-vf", f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
               f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-t", f"{float(duration):.3f}",
        "-r", "30",
        str(cache),
    ]
    try:
        subprocess.run(cmd, capture_output=True, timeout=60, check=True)
    except Exception as e:
        print(f"[image2video] failed for {image_path.name}: {e}", flush=True)
        if cache.exists():
            try: cache.unlink()
            except Exception: pass
        raise
    return cache


def _select_best_segment(clip):
    """
    For a single analysed clip, pick the highest-quality contiguous segment.
    Honors scene cuts when available — picks the longest sub-segment between
    consecutive cuts. Otherwise trims 0.5s head + tail.
    """
    dur = float(clip.get("duration") or 0.0)
    cuts = list(clip.get("scene_cuts") or [])
    if dur <= 0:
        return None

    if cuts:
        # Build sub-segment boundaries: 0 → cut1 → cut2 → … → dur
        bounds = [0.0] + [c for c in cuts if 0 < c < dur] + [dur]
        # Pick the longest sub-segment ≥ MIN_SEG_DUR
        best = None
        for i in range(len(bounds) - 1):
            a, b = bounds[i], bounds[i + 1]
            length = b - a
            if length < _MIN_SEG_DUR:
                continue
            if best is None or length > (best[1] - best[0]):
                best = (a, b)
        if best:
            return {"start": round(best[0], 3), "end": round(best[1], 3)}
    # No usable cuts — trim head/tail
    if dur < _MIN_SEG_DUR + 2 * _HEAD_TAIL_TRIM:
        return None
    return {"start": round(_HEAD_TAIL_TRIM, 3),
            "end":   round(dur - _HEAD_TAIL_TRIM, 3)}


def _select_segments(analyses, total_duration, pacing):
    """
    Rank clips by shot_score, take their best sub-segment, fit them into the
    target duration. Trims the last segment if it would overshoot.

    Each output segment is annotated with the underlying motion score so the
    transition assigner can read it (stripped before returning).
    """
    target_seg = _PACING_SEG_DUR.get(pacing, 3.0)
    ranked = sorted(
        [c for c in analyses if not c.get("error") and c.get("duration", 0) > 0],
        key=lambda c: -float(c.get("shot_score") or 0),
    )

    segments = []
    accumulated = 0.0
    for clip in ranked:
        if accumulated >= total_duration - 0.05:
            break
        sub = _select_best_segment(clip)
        if not sub:
            continue
        avail = sub["end"] - sub["start"]
        seg_len = min(target_seg, avail)
        # Trim last segment to land exactly on total_duration
        remaining = total_duration - accumulated
        if seg_len > remaining:
            seg_len = remaining
        if seg_len < _MIN_SEG_DUR:
            continue
        # Centre seg_len within the available range so we use the strongest part
        offset = (avail - seg_len) / 2.0
        s_in = round(sub["start"] + offset, 3)
        s_out = round(s_in + seg_len, 3)
        segments.append({
            "clipFilename": clip["filename"],
            "sourceIn":     s_in,
            "sourceOut":    s_out,
            "_motion":      float(clip.get("motion") or 0),
        })
        accumulated += seg_len

    # If still short on time, allow repeats of the highest-scoring clip
    if accumulated < total_duration - 0.5 and ranked:
        top = ranked[0]
        sub = _select_best_segment(top)
        while sub and accumulated < total_duration - 0.5:
            avail = sub["end"] - sub["start"]
            seg_len = min(target_seg, avail, total_duration - accumulated)
            if seg_len < _MIN_SEG_DUR:
                break
            offset = max(0.0, (avail - seg_len) / 2.0)
            s_in = round(sub["start"] + offset, 3)
            s_out = round(s_in + seg_len, 3)
            segments.append({
                "clipFilename": top["filename"],
                "sourceIn":     s_in,
                "sourceOut":    s_out,
                "_motion":      float(top.get("motion") or 0),
                "_repeat":      True,
            })
            accumulated += seg_len

    return segments


def _snap_segments_to_beats(segments, beats, tolerance=_BEAT_TOLERANCE):
    """Walk cumulative time across segments, snap each segment END to the
    nearest beat within ±tolerance. Adjusts only sourceOut (and the next
    segment's sourceIn implicitly via repositioning)."""
    if not beats:
        return segments
    cum = 0.0
    for seg in segments:
        seg_dur = seg["sourceOut"] - seg["sourceIn"]
        target_end = cum + seg_dur
        nearest = min(beats, key=lambda b: abs(b - target_end))
        if abs(nearest - target_end) <= tolerance:
            new_dur = nearest - cum
            if new_dur >= _MIN_SEG_DUR:
                seg["sourceOut"] = round(seg["sourceIn"] + new_dur, 3)
                seg_dur = new_dur
        cum += seg_dur
    return segments


def _assign_transitions(segments, pacing):
    """
    Default transition between segments = crossfade 0.3s.
    High-motion → low-motion = hard cut (preserves the impact).
    Last segment = fade-to-black 0.8s if pacing=slow, else crossfade 0.3s.
    """
    n = len(segments)
    for i, seg in enumerate(segments):
        is_last = (i == n - 1)
        if is_last:
            if pacing == "slow":
                seg["transition"] = {"type": "fade_to_black", "duration": 0.8}
            else:
                seg["transition"] = {"type": "crossfade", "duration": 0.3}
        else:
            cur = float(seg.get("_motion") or 0.0)
            nxt = float(segments[i + 1].get("_motion") or 0.0)
            if cur > 0.5 and nxt < 0.2:
                seg["transition"] = {"type": "cut", "duration": 0.0}
            else:
                seg["transition"] = {"type": "crossfade", "duration": 0.3}
    # Strip private fields
    for seg in segments:
        seg.pop("_motion", None)
        seg.pop("_repeat", None)
    return segments


def _gen_overlay_slots(total_duration, pacing, segments):
    """Three title slots: opening, mid (snapped to nearest cut), closing."""
    opening_dur = 3.0 if pacing == "slow" else 1.8
    closing_dur = 3.5 if pacing == "slow" else 2.0
    mid_target  = total_duration * 0.42

    # Cumulative cut points across the assembled segments
    cuts = [0.0]
    t = 0.0
    for seg in segments:
        t += seg["sourceOut"] - seg["sourceIn"]
        cuts.append(t)

    if cuts:
        nearest = min(cuts, key=lambda c: abs(c - mid_target))
        if abs(nearest - mid_target) < 1.5:
            mid_target = nearest

    return {
        "opening_title": {"in": 0.0,
                          "out": round(min(opening_dur, total_duration), 3)},
        "mid_title":     {"in": round(mid_target, 3),
                          "out": round(min(mid_target + 2.0, total_duration), 3)},
        "closing_title": {"in": round(max(0.0, total_duration - closing_dur), 3),
                          "out": round(total_duration, 3)},
    }


def _build_audio_plan(music_filename, pacing):
    if not music_filename:
        return {"musicFilename": None, "volume": 0.0, "fadeIn": 0.0, "fadeOut": 0.0}
    return {
        "musicFilename": music_filename,
        "volume":        0.85,
        "fadeIn":        1.0,
        "fadeOut":       2.5 if pacing == "slow" else 1.5,
    }


@app.route("/api/auto-edit", methods=["POST"])
def api_auto_edit():
    """
    POST EditRequest → return EditPlan.
    All clip analyses are cached per project — repeat calls for the same
    clipset are fast (only the planning step re-runs).

    Wrapped in a top-level try/except so any unhandled exception still
    returns a JSON error body. The user reported "Unexpected end of JSON
    input" client-side, which means the response body was empty — i.e.
    the worker crashed mid-request without producing any output. With
    this guard the failure mode becomes a clear JSON {error, type, trace}.
    """
    try:
        return _api_auto_edit_impl()
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        # Print the full trace to gunicorn's stderr so the operator can
        # tail /tmp/mc.log and see what actually broke.
        print("[auto-edit] UNHANDLED:", e, "\n", tb, flush=True)
        return jsonify({
            "error": f"auto-edit crashed: {e!r}",
            "type":  type(e).__name__,
            "trace": tb.splitlines()[-6:],   # last few frames, enough to triage
        }), 500


def _api_auto_edit_impl():
    data = request.get_json(force=True, silent=True) or {}
    pid       = data.get("projectId") or "default"
    duration  = float(data.get("duration") or 30)
    aspect    = data.get("aspectRatio") or "16:9"
    pacing    = data.get("pacing") or "balanced"
    style_id  = data.get("styleId") or "cinematic"
    music_fn  = data.get("musicFilename")
    clip_fns  = data.get("clipFilenames") or []

    if duration <= 0:
        return jsonify({"error": "duration must be > 0"}), 400
    if not clip_fns:
        return jsonify({"error": "no clipFilenames provided"}), 400

    # Parallel analysis (FFmpeg is IO/CPU-bound, GIL not an issue)
    workers = min(4, max(1, len(clip_fns)))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        analyses = list(ex.map(lambda fn: _analyze_or_cached(pid, fn), clip_fns))

    failed = [a for a in analyses if a.get("error")]
    ok     = [a for a in analyses if not a.get("error") and a.get("duration", 0) > 0]
    if not ok:
        return jsonify({
            "error":  "no analysable clips",
            "failed": failed,
        }), 422

    segments = _select_segments(ok, duration, pacing)
    if not segments:
        return jsonify({
            "error":  "could not select any segment from the provided clips",
            "failed": failed,
            "ok":     [a["filename"] for a in ok],
        }), 422

    # Snap to beats if music provided and the project has cached beat anchors
    beats = []
    if music_fn:
        with _doc_lock(pid):
            doc = _read_doc(pid) or {}
        # Beats live in audio.beat_anchors when the user has detected them in
        # the editor — otherwise distribute cuts evenly (no snapping).
        beats = list((doc.get("audio") or {}).get("beat_anchors") or [])

    if beats:
        segments = _snap_segments_to_beats(segments, beats)

    segments = _assign_transitions(segments, pacing)
    overlay_slots = _gen_overlay_slots(duration, pacing, segments)
    audio_plan = _build_audio_plan(music_fn, pacing)

    plan = {
        "segments":     segments,
        "overlaySlots": overlay_slots,
        "audio":        audio_plan,
        "meta": {
            "totalDuration": duration,
            "clipCount":     len(segments),
            "pacing":        pacing,
            "styleId":       style_id,
            "aspectRatio":   aspect,
            "generatedAt":   time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "analyzedClips": len(ok),
            "failedClips":   [a["filename"] for a in failed],
        },
    }
    return jsonify(plan)


@app.route("/exports/<path:filename>")
def serve_export(filename):
    return send_from_directory(str(EXPORT_DIR), filename, conditional=True, as_attachment=True)


# ----------------------------------------------------------------------------
# Export pipeline
# ----------------------------------------------------------------------------

# xfade requires duration > 0, so a "cut" transition is rendered as a 1-frame
# crossfade. At 30 fps this is 33 ms — visually indistinguishable from a hard
# cut but lets the same xfade chain handle every transition type.
MIN_XFADE_DURATION = 1.0 / 30.0
SEGMENT_FPS = 30


_DRAWTEXT_FONT_CACHE = None
def _remap_captions_to_layers(caption_segments, edit_segments, style_id):
    """Translate source-time caption segments into edit-timeline text layers.

    Args
    ----
    caption_segments : [{clipFilename, sourceStart, sourceEnd, text}]
        Whisper output tagged with the clip the audio came from.
    edit_segments : [{clipFilename, sourceIn, sourceOut, transition}]
        The planner's final ordering (after generate_edit_plan).
    style_id : "subtitles" | "overlay" | "bold_center"
        Mirrors the client-side selector.

    The walk is single-pass: each edit segment can host multiple captions
    that overlap its [sourceIn, sourceOut] window. The caption's edit-time
    start is `edit_offset + (sourceStart - sourceIn)`, clamped so a caption
    can't run past the segment boundary (it'd then drift over the next clip).
    """
    if not caption_segments or not edit_segments:
        return []
    canvas_w, canvas_h = 1920, 1080
    if style_id == "overlay":
        font_size, y, anim = 42, int(canvas_h * 0.08), "reveal"
    elif style_id == "bold_center":
        font_size, y, anim = 72, int(canvas_h * 0.46), "cinematic"
    else:    # "subtitles"
        font_size, y, anim = 42, int(canvas_h * 0.84), "fade"

    layers = []
    edit_offset = 0.0
    for seg in edit_segments:
        seg_file = seg.get("clipFilename")
        seg_in   = float(seg.get("sourceIn", 0))
        seg_out  = float(seg.get("sourceOut", seg_in))
        seg_dur  = max(0.0, seg_out - seg_in)
        if seg_dur <= 0:
            continue
        for cap in caption_segments:
            if cap.get("clipFilename") != seg_file:
                continue
            cs = float(cap.get("sourceStart", 0))
            ce = float(cap.get("sourceEnd", cs))
            # Trim caption to the segment's source window.
            overlap_in  = max(cs, seg_in)
            overlap_out = min(ce, seg_out)
            if overlap_out - overlap_in < 0.15:
                continue
            edit_start = edit_offset + (overlap_in  - seg_in)
            edit_end   = edit_offset + (overlap_out - seg_in)
            text = (cap.get("text") or "").strip()
            if not text:
                continue
            # x is approximated centred per line; the actual centering is
            # done by drawtext at render time (x clamp via the wrap loop in
            # build_filter_complex). Pick a left margin that keeps two-line
            # captions visually balanced on a 16:9 frame.
            layers.append({
                "type":      "text",
                "text":      text,
                "fontSize":  font_size,
                "color":     "#ffffff",
                "x":         int(canvas_w * 0.10),
                "y":         y,
                "start":     round(edit_start, 3),
                "end":       round(edit_end, 3),
                "animation": anim,
                "canvasW":   canvas_w,
                "canvasH":   canvas_h,
            })
        edit_offset += seg_dur
    return layers


def _wrap_text(text, max_chars=42):
    """Word-wrap a caption to ~max_chars per line. drawtext has no native
    wrap so the caller stacks N drawtexts vertically. Never breaks mid-word
    — overflows the line if a single word is longer than max_chars."""
    words = (text or "").split()
    lines, current = [], ""
    for word in words:
        if not current:
            current = word
        elif len(current) + 1 + len(word) <= max_chars:
            current = current + " " + word
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines or [""]


def _resolve_drawtext_font():
    """Return a usable fontfile path for drawtext, escaped for filter syntax,
    or None if no font is available (drawtext will then use its built-in default)."""
    global _DRAWTEXT_FONT_CACHE
    if _DRAWTEXT_FONT_CACHE is not None:
        return _DRAWTEXT_FONT_CACHE or None
    candidates = [
        r"C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/Library/Fonts/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    chosen = ""
    for p in candidates:
        if Path(p).exists():
            # ffmpeg filter syntax requires escaping ":" inside fontfile=
            chosen = p.replace(":", r"\:")
            break
    _DRAWTEXT_FONT_CACHE = chosen
    return chosen or None


def build_segments_chain(segments, target_w, target_h, fps=SEGMENT_FPS):
    """
    Build the multi-clip filter graph that concatenates N segment inputs
    via xfade transitions and produces a single video label.

    Inputs assumed to be at indices [0:v]..[N-1:v] in the FFmpeg command.
    Each segment dict carries { sourceIn, sourceOut, transition: { type, duration } }.
    Trimming itself is done at the input-side via -ss/-to BEFORE -i so each
    [k:v] is already the trimmed clip starting at PTS 0.

    Returns (filter_parts, output_label, total_duration).

    Transition mapping:
        cut           -> xfade type=fade with MIN_XFADE_DURATION  (≈ hard cut)
        crossfade     -> xfade type=fade with the requested duration
        fade_to_black -> xfade type=fadeblack with the requested duration
    """
    n = len(segments)
    parts = []

    # 1) Normalize each segment input: rescale to the target canvas, lock fps,
    #    and reset PTS so xfade offsets are measured from each clip's own zero.
    #    Locking fps avoids xfade timing drift when sources have varying frame rates.
    # Fill the canvas: scale UP to cover, then crop the excess. Better for
    # drone footage (no letterbox bars) at the cost of clipping edges.
    for i, seg in enumerate(segments):
        parts.append(
            f"[{i}:v]scale={target_w}:{target_h}:force_original_aspect_ratio=increase,"
            f"crop={target_w}:{target_h},"
            f"setsar=1,fps={fps},format=yuv420p,setpts=PTS-STARTPTS[s{i}v]"
        )

    # 2) Single-segment shortcut: nothing to concat.
    if n == 1:
        seg_dur = max(0.01, float(segments[0]["sourceOut"]) - float(segments[0]["sourceIn"]))
        parts.append("[s0v]null[concat]")
        return parts, "[concat]", seg_dur

    # 3) Walk the segment list, chaining xfade transitions. After processing
    #    segment i, `running_label` represents the compound stream and
    #    `running_length` is its duration in seconds.
    running_label = "[s0v]"
    running_length = max(0.01, float(segments[0]["sourceOut"]) - float(segments[0]["sourceIn"]))

    for i in range(1, n):
        seg = segments[i]
        seg_dur = max(0.01, float(seg["sourceOut"]) - float(seg["sourceIn"]))
        prev_seg = segments[i - 1]
        # The transition between seg i-1 and seg i lives on the OUTGOING clip.
        # Schema stores it on the segment that owns the outgoing edge — i.e.,
        # prev_seg.transition is what bridges into this segment.
        trans = (prev_seg.get("transition") or {}) if isinstance(prev_seg.get("transition"), dict) else {}
        ttype = (trans.get("type") or "cut").lower()
        treq  = float(trans.get("duration") or 0.0)

        if ttype in ("crossfade", "xfade", "fade"):
            xfade_kind = "fade"
            tdur = max(MIN_XFADE_DURATION, treq if treq > 0 else 0.5)
        elif ttype in ("fade_to_black", "fadeblack", "fade-to-black"):
            xfade_kind = "fadeblack"
            tdur = max(MIN_XFADE_DURATION, treq if treq > 0 else 0.5)
        else:
            # "cut" or anything unknown -> hard cut via 1-frame xfade.
            xfade_kind = "fade"
            tdur = MIN_XFADE_DURATION

        # Clamp the transition so it doesn't exceed either clip's length.
        tdur = min(tdur, max(MIN_XFADE_DURATION, running_length - 0.01),
                          max(MIN_XFADE_DURATION, seg_dur - 0.01))

        # xfade offset = where in the *compound* stream the transition begins.
        offset = max(0.0, running_length - tdur)
        nxt_label = f"[x{i}]"
        parts.append(
            f"{running_label}[s{i}v]xfade=transition={xfade_kind}:"
            f"duration={tdur:.3f}:offset={offset:.3f}{nxt_label}"
        )
        running_label = nxt_label
        running_length = running_length + seg_dur - tdur

    # Rename final compound to a stable label for downstream filters.
    parts.append(f"{running_label}null[concat]")
    return parts, "[concat]", running_length


def build_filter_complex(payload, target_w, target_h, duration,
                         image_input_offset=1, prebuilt_base=None):
    """
    Build an FFmpeg -filter_complex graph from JSON payload.

    Single-clip mode (legacy, default):
        Inputs: [0:v] = source video, [image_input_offset:v]... = overlays
        Step 1 scales+pads+grades [0:v] into [base].

    Multi-clip mode (Sprint 1):
        The segment chain has already produced a stream that is at the
        target canvas size. Pass its label as `prebuilt_base` (e.g.
        "[concat]") and override `image_input_offset` to point past the
        N segment inputs. We still apply the color grade here so it sits
        on top of the concatenated stream uniformly.

    Returns (filter_str, label_video_out).
    """
    layers = payload.get("layers", [])
    grade = payload.get("colorGrade", "natural")
    vignette = bool(payload.get("vignette"))
    grain = bool(payload.get("filmGrain"))

    parts = []

    # 1) Scale+pad+grade for single-clip mode, or grade-only for multi-clip
    #    (segments already arrive scaled+padded from the segment chain).
    if prebuilt_base is None:
        parts.append(
            f"[0:v]scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
            f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:color=black,"
            f"setsar=1,{color_grade_filter(grade)}[base]"
        )
    else:
        parts.append(f"{prebuilt_base}{color_grade_filter(grade)}[base]")

    cur = "[base]"

    # 2) Optional film grain
    if grain:
        parts.append(
            f"{cur}noise=alls=10:allf=t+u[grain]"
        )
        cur = "[grain]"

    # 3) Optional vignette
    if vignette:
        parts.append(f"{cur}vignette=PI/4[vig]")
        cur = "[vig]"

    # 4) Image / logo overlays. Image inputs occupy
    #    [image_input_offset:v], [image_input_offset+1:v], ...
    img_layers = [l for l in layers if l.get("type") in ("logo", "image")]
    for offset_i, layer in enumerate(img_layers):
        idx = image_input_offset + offset_i
        w = max(8, int(layer.get("width", 200) * target_w / max(1, layer.get("canvasW", target_w))))
        x = int(layer.get("x", 0) * target_w / max(1, layer.get("canvasW", target_w)))
        y = int(layer.get("y", 0) * target_h / max(1, layer.get("canvasH", target_h)))
        opacity = float(layer.get("opacity", 1.0))
        start = float(layer.get("start", 0))
        end = float(layer.get("end", duration if duration else 9999))
        parts.append(
            f"[{idx}:v]scale={w}:-1,format=rgba,"
            f"colorchannelmixer=aa={opacity}[ov{idx}]"
        )
        nxt = f"[v{idx}]"
        parts.append(
            f"{cur}[ov{idx}]overlay={x}:{y}:enable='between(t,{start},{end})'{nxt}"
        )
        cur = nxt

    # 5) Letterbox bars (cinematic template)
    if payload.get("letterbox"):
        bar_h = int(target_h * 0.12)
        parts.append(
            f"{cur}drawbox=x=0:y=0:w={target_w}:h={bar_h}:color=black@1:t=fill,"
            f"drawbox=x=0:y={target_h - bar_h}:w={target_w}:h={bar_h}:color=black@1:t=fill[lb]"
        )
        cur = "[lb]"

    # 6) Text layers via drawtext.
    # Captions can exceed the safe horizontal extent. drawtext lacks a native
    # word-wrap, so we split the layer into N drawtexts stacked vertically.
    # The split happens here, then the per-line block below renders each.
    text_layers = [l for l in layers if l.get("type") == "text"]
    expanded_layers = []
    for layer in text_layers:
        raw_text = layer.get("text", "") or ""
        font_size = max(12, int(layer.get("fontSize", 48)))
        # max chars scales inversely with fontSize — calibrated to ~42 chars
        # at fontSize=42 on a 1920-px canvas. Tighter for bold_center (72px).
        max_chars = max(10, int(42 * 42 / font_size))
        lines = _wrap_text(raw_text, max_chars=max_chars)
        line_height = int(font_size * 1.3)
        for line_idx, line_text in enumerate(lines):
            expanded_layers.append({
                **layer,
                "text":     line_text,
                "_y_off":   line_idx * line_height,
                "_line_n":  len(lines),
            })
    text_layers = expanded_layers

    for i, layer in enumerate(text_layers):
        cw = max(1, layer.get("canvasW", target_w))
        ch = max(1, layer.get("canvasH", target_h))
        x = int(layer.get("x", 0) * target_w / cw)
        y = int(layer.get("y", 0) * target_h / ch) + int(layer.get("_y_off", 0) * target_w / cw)
        size = max(12, int(layer.get("fontSize", 48) * target_w / cw))
        color = layer.get("color", "#ffffff").lstrip("#")
        try:
            r, g, b = int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16)
            color_hex = f"0x{color[:6]}"
        except Exception:
            color_hex = "0xffffff"
        text = ff_escape(layer.get("text", ""))
        start = float(layer.get("start", 0))
        end = float(layer.get("end", duration if duration else 9999))
        anim = layer.get("animation", "none")

        # Animation-driven alpha and position expressions.
        alpha_expr = "1"
        x_expr = str(x)
        y_expr = str(y)
        text_expr = text

        fade_in = 0.5
        fade_out = 0.5
        if anim == "fade":
            alpha_expr = (
                f"if(lt(t,{start}),0,"
                f"if(lt(t,{start + fade_in}),(t-{start})/{fade_in},"
                f"if(lt(t,{end - fade_out}),1,"
                f"if(lt(t,{end}),({end}-t)/{fade_out},0))))"
            )
        elif anim == "reveal":
            # horizontal sweep using crop-via-box trick approximated with fade
            alpha_expr = (
                f"if(lt(t,{start}),0,"
                f"if(lt(t,{start + 0.8}),(t-{start})/0.8,"
                f"if(lt(t,{end}),1,0)))"
            )
            x_expr = f"{x}+50*(1-min(1,(t-{start})/0.8))"
        elif anim == "tracking":
            # simulate letter-spacing via gradual fade only (drawtext lacks spacing)
            alpha_expr = (
                f"if(lt(t,{start}),0,"
                f"if(lt(t,{start + 1.2}),(t-{start})/1.2,"
                f"if(lt(t,{end}),1,0)))"
            )
        elif anim == "typewriter":
            # show progressively more chars
            full = layer.get("text", "")
            n = max(1, len(full))
            # FFmpeg can't slice directly; approximate with fade.
            alpha_expr = (
                f"if(lt(t,{start}),0,"
                f"if(lt(t,{end}),1,0))"
            )
        elif anim == "bounce":
            y_expr = f"{y}+10*sin(2*PI*(t-{start})*2)*if(lt(t,{end}),1,0)"
            alpha_expr = (
                f"if(lt(t,{start}),0,if(lt(t,{end}),1,0))"
            )
        elif anim == "cinematic":
            alpha_expr = (
                f"if(lt(t,{start}),0,"
                f"if(lt(t,{start + 0.6}),(t-{start})/0.6,"
                f"if(lt(t,{end - 0.6}),1,"
                f"if(lt(t,{end}),({end}-t)/0.6,0))))"
            )
            y_expr = f"{y}-15*max(0,1-(t-{start})/0.6)"

        # Pick a font file that exists on Windows / fallback
        font = layer.get("fontFamily", "Arial")
        nxt = f"[t{i}]"
        draw = (
            f"drawtext=text='{text_expr}':"
            f"fontcolor={color_hex}:"
            f"fontsize={size}:"
            # x/y must be single-quoted: animation expressions like
            # max(0,1-...) contain commas that the filter parser would
            # otherwise interpret as a filter separator. Same trick as alpha
            # and enable below.
            f"x='{x_expr}':y='{y_expr}':"
            f"alpha='{alpha_expr}':"
            f"borderw=2:bordercolor=black@0.6:"
            f"enable='between(t,{start},{end})'"
        )
        # drawtext needs a real font file (fontconfig is unreliable across
        # Windows / Codespaces / macOS). Resolve once at module level: prefer
        # Windows Arial, then common Linux fallbacks.
        font_path = _resolve_drawtext_font()
        if font_path:
            draw += f":fontfile='{font_path}'"

        parts.append(f"{cur}{draw}{nxt}")
        cur = nxt

    # Final label
    parts.append(f"{cur}null[outv]")

    return ";".join(parts), "[outv]"


def run_export_job(job_id, payload, src_video, image_paths, audio_path, out_path,
                   target_w, target_h, duration,
                   segment_paths=None, segments=None):
    """
    Render an MP4 from the editor payload.

    Two modes:
      Legacy single-clip mode (segments is None / empty):
          Inputs = [video] [..images..] [optional music]
          Source video honours inMark / outMark for trimming.

      Multi-clip mode (Sprint 1):
          Inputs = [seg0] [seg1] .. [segN-1] [..images..] [optional music]
          Each segment is input-trimmed via -ss/-to and concatenated via
          xfade transitions. Clip audio is dropped and replaced by the
          music track (or silence) — see notes inside.
    """
    multi_clip = bool(segments and segment_paths and len(segments) == len(segment_paths) and len(segments) > 0)

    cmd = [FFMPEG, "-y"]

    if multi_clip:
        # Each segment is its own input. -ss/-to BEFORE -i is input-side
        # trimming: cheap, seeks to the nearest keyframe. Accuracy is fine
        # for typical Magic Edit segment boundaries (≥0.5 s).
        for seg, path in zip(segments, segment_paths):
            si = max(0.0, float(seg.get("sourceIn") or 0.0))
            so = float(seg.get("sourceOut") or 0.0)
            if so > si:
                cmd += ["-ss", f"{si:.3f}", "-to", f"{so:.3f}"]
            cmd += ["-i", str(path)]
    else:
        in_mark  = payload.get("inMark")
        out_mark = payload.get("outMark")
        if isinstance(in_mark, (int, float)) and in_mark > 0:
            cmd += ["-ss", f"{float(in_mark):.3f}"]
        if isinstance(out_mark, (int, float)) and out_mark > (in_mark or 0):
            cmd += ["-to", f"{float(out_mark):.3f}"]
        cmd += ["-i", str(src_video)]

    for p in image_paths:
        cmd += ["-i", str(p)]
    if audio_path:
        cmd += ["-i", str(audio_path)]

    if multi_clip:
        seg_input_count = len(segments)
        seg_parts, seg_label, total_dur = build_segments_chain(
            segments, target_w, target_h
        )
        # Override the export's effective duration with the actual concatenated
        # length so the progress bar and audio fade-out align with reality.
        duration = total_dur

        fc, vlabel = build_filter_complex(
            payload, target_w, target_h, duration,
            image_input_offset=seg_input_count,
            prebuilt_base=seg_label,
        )
        video_filter = ";".join(seg_parts) + ";" + fc
        audio_idx = seg_input_count + len(image_paths)
    else:
        fc, vlabel = build_filter_complex(payload, target_w, target_h, duration)
        video_filter = fc
        audio_idx = 1 + len(image_paths)

    has_extra_audio = audio_path is not None

    if multi_clip:
        # In multi-clip mode we don't trust the original clip audios — they may
        # have unequal sample rates / be missing on some clips, and concat with
        # xfade gaps is messy. Two clean paths:
        #   - music present: use it (replace mode), faded as the user asked
        #   - music absent: synthesize silence matching the video duration
        if has_extra_audio:
            vol = float(payload.get("musicVolume", 0.6))
            vol = max(0.0, min(1.0, vol))
            afade_in = ",afade=t=in:st=0:d=1" if payload.get("musicFadeIn") else ""
            afade_out = ""
            if payload.get("musicFadeOut") and duration > 1:
                afade_out = f",afade=t=out:st={max(0, duration-1.5)}:d=1.5"
            audio_filter = (
                f"[{audio_idx}:a]volume={vol}{afade_in}{afade_out},"
                f"atrim=duration={duration:.3f},asetpts=PTS-STARTPTS[aout]"
            )
            audio_map = ["-map", "[aout]"]
            full_filter = video_filter + ";" + audio_filter
        else:
            # No music chosen — emit silence so the output container still has
            # an audio track (some players misbehave on video-only MP4s).
            audio_filter = (
                f"anullsrc=channel_layout=stereo:sample_rate=48000,"
                f"atrim=duration={duration:.3f},asetpts=PTS-STARTPTS[aout]"
            )
            full_filter = video_filter + ";" + audio_filter
            audio_map = ["-map", "[aout]"]
    elif has_extra_audio:
        vol = float(payload.get("musicVolume", 0.6))
        vol = max(0.0, min(1.0, vol))
        mix_mode = payload.get("musicMode", "mix")  # mix or replace
        afade_in = ",afade=t=in:st=0:d=1" if payload.get("musicFadeIn") else ""
        afade_out = ""
        if payload.get("musicFadeOut") and duration > 1:
            afade_out = f",afade=t=out:st={max(0, duration-1.5)}:d=1.5"
        if mix_mode == "replace":
            audio_filter = f"[{audio_idx}:a]volume={vol}{afade_in}{afade_out}[aout]"
            audio_map = ["-map", "[aout]"]
        else:
            audio_filter = (
                f"[{audio_idx}:a]volume={vol}{afade_in}{afade_out}[mus];"
                f"[0:a][mus]amix=inputs=2:duration=first:dropout_transition=2[aout]"
            )
            audio_map = ["-map", "[aout]"]
        full_filter = video_filter + ";" + audio_filter
    else:
        full_filter = video_filter
        audio_map = ["-map", "0:a?"]

    cmd += [
        "-filter_complex", full_filter,
        "-map", vlabel,
        *audio_map,
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        "-progress", "pipe:1",
        "-nostats",
        str(out_path),
    ]

    set_job(job_id, status="running", progress=0, cmd=" ".join(shlex.quote(c) for c in cmd))

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        last_log = []
        for line in proc.stdout:
            line = line.strip()
            if line.startswith("out_time_ms="):
                try:
                    us = int(line.split("=", 1)[1])
                    cur = us / 1_000_000.0
                    if duration > 0:
                        pct = max(0, min(99, int(cur / duration * 100)))
                        set_job(job_id, progress=pct)
                except Exception:
                    pass
            elif line.startswith("progress=") and "end" in line:
                set_job(job_id, progress=99)
        # Drain stderr to capture errors
        err = proc.stderr.read() if proc.stderr else ""
        proc.wait()
        if proc.returncode != 0:
            set_job(job_id, status="error", error=err[-1500:] if err else "ffmpeg failed")
            return
        # url_for() requires a request context, but we're on a background
        # thread. The /exports/<filename> route is static, so build the URL
        # by hand rather than dragging in app.test_request_context().
        set_job(
            job_id,
            status="done",
            progress=100,
            output=out_path.name,
            url=f"/exports/{out_path.name}",
        )
    except FileNotFoundError:
        set_job(job_id, status="error",
                error="FFmpeg not found. Install with: winget install FFmpeg")
    except Exception as e:
        set_job(job_id, status="error", error=str(e))


# ----------------------------------------------------------------------------
# /api/generate — one-shot pipeline (upload → analyse → plan → render).
# Replaces the manual editing flow. Reuses run_export_job + analysis helpers.
# ----------------------------------------------------------------------------
_BRIEF_KEYWORDS_GRADE = (
    (r"\b(luxury|premium|high[- ]end|elegant|sotheby|christie)\b", "moody_dark"),
    (r"\b(family|home|kids|welcoming|warm|cosy|cozy)\b",          "bright_airy"),
    (r"\b(investment|rental|clean|professional|portal|listing)\b", "natural"),
    (r"\b(cinematic|drama|moody|sunset|night)\b",                  "moody_dark"),
    (r"\b(bright|airy|sunny|light|fresh)\b",                       "bright_airy"),
)
_BRIEF_STYLE_HINTS = (
    (r"\b(fast|dynamic|energetic|punchy|reel|tiktok)\b", "fast"),
    (r"\b(cinematic|slow|contemplative|hero|teaser)\b",  "cinematic"),
    (r"\b(social|instagram|reel)\b",                     "social"),
    (r"\b(real[- ]estate|property|listing|home tour)\b", "real_estate"),
)


def _parse_brief(brief, style, duration, format_str, color_grade):
    """Map a free-text brief to overrides for the planner inputs.

    Pure regex/keyword heuristics — no model call. Returns a tuple
    (style, duration, format_str, color_grade, hints) where `hints` is a
    dict of extra signals the planner can read (calm, family). The
    caller's existing values win when the brief doesn't carry a signal."""
    hints = {"calm": False, "family": False, "luxury": False}
    if not brief:
        return style, duration, format_str, color_grade, hints
    text = brief.lower()

    # Color grade — first match wins.
    for pattern, grade in _BRIEF_KEYWORDS_GRADE:
        if re.search(pattern, text):
            color_grade = grade
            break

    # Style — only override if the caller picked the default real_estate.
    # That way "real_estate + brief mentions fast" → fast, but a deliberate
    # choice of "cinematic" sticks even if "instagram" appears in the brief.
    if style in (None, "", "real_estate"):
        for pattern, hinted in _BRIEF_STYLE_HINTS:
            if re.search(pattern, text):
                style = hinted
                break

    # Format hints.
    if re.search(r"\b(instagram|reel|9[: ]?16|vertical|story|stories|tiktok)\b", text):
        format_str = "9:16"
    elif re.search(r"\b(square|1[: ]?1)\b", text):
        format_str = "1:1"
    elif re.search(r"\b(landscape|16[: ]?9|horizontal|youtube)\b", text):
        format_str = "16:9"

    # Duration — first integer followed by 's' or 'sec' / 'seconds'.
    m = re.search(r"\b(\d{1,3})\s*(?:s|sec|secs|seconds?)\b", text)
    if m:
        dur = int(m.group(1))
        if 5 <= dur <= 180:
            duration = dur

    # Mood hints the planner reads directly.
    if re.search(r"\b(calm|elegant|relaxed|breathe|breathing|serene)\b", text):
        hints["calm"] = True
    if re.search(r"\b(family|home|kids|welcoming|lived[- ]in)\b", text):
        hints["family"] = True
    if re.search(r"\b(luxury|premium|high[- ]end)\b", text):
        hints["luxury"] = True

    return style, duration, format_str, color_grade, hints


def run_pipeline(job_id, pid, filenames, style, duration, format_str,
                 music_filename=None, color_grade="natural",
                 vignette=False, film_grain=False, letterbox=False,
                 music_volume=0.85, music_catalogue_url=None,
                 layers=None, caption_segments=None,
                 caption_style="subtitles", clip_metadata=None,
                 brief=None):
    """Single-thread pipeline driving the four UI steps the user sees:
       analyzing → planning → rendering → done. All state goes through
       set_job() so the existing job tracker / status endpoint stays the
       single source of truth (no parallel dict).

       music_filename / color_grade / vignette / film_grain / letterbox
       are threaded into the payload dict passed to run_export_job, which
       already supports every one of these (we're just exposing them
       through the simplified UI)."""
    try:
        set_job(job_id, status="analyzing", progress=10, eta_seconds=60)
        # 1. Analyse every clip in parallel — _analyze_or_cached() handles
        #    its own caching in project.motioncut.json, so repeat clicks
        #    on the same file set are basically instant.
        workers = min(4, max(1, len(filenames)))
        with ThreadPoolExecutor(max_workers=workers) as ex:
            analyses = list(ex.map(lambda fn: _analyze_or_cached(pid, fn), filenames))

        # Sprint 6: overlay client-supplied per-clip metadata (has_face from
        # MediaPipe Worker) onto the analyses dicts. The auto-planner uses
        # the merged value when ordering for the "real_estate" style.
        clip_meta = { (m.get("filename") or ""): m
                      for m in (clip_metadata or []) if isinstance(m, dict) }
        for a in analyses:
            fn = a.get("filename")
            if fn and fn in clip_meta:
                cm = clip_meta[fn]
                if "has_face" in cm:
                    a["has_face"] = bool(cm["has_face"])

        # Sprint 7 — parse the optional brief and apply its hints to the
        # planner inputs. Pure regex; the parser only overrides fields the
        # caller didn't pin explicitly (style stays put unless it was the
        # default real_estate, which is the "I didn't choose" signal).
        brief_text = (brief or "").strip()
        brief_hints = {}
        if brief_text:
            new_style, new_duration, new_format, new_grade, brief_hints = \
                _parse_brief(brief_text, style, duration, format_str, color_grade)
            if (new_style, new_duration, new_format, new_grade) != \
               (style, duration, format_str, color_grade):
                print(f"[brief] applied overrides: style={style}->{new_style} "
                      f"duration={duration}->{new_duration} format={format_str}->{new_format} "
                      f"grade={color_grade}->{new_grade} hints={brief_hints}",
                      flush=True)
            style, duration, format_str, color_grade = \
                new_style, new_duration, new_format, new_grade
            set_job(job_id, brief_hints=brief_hints)

        set_job(job_id, status="planning", progress=40, eta_seconds=40)
        # 2. Build the edit plan via the local 3-act narrative planner.
        #    Falls back to a sequential cut if the smart path raises.
        import auto_planner
        try:
            edit_plan = auto_planner.generate_edit_plan(
                analyses, style, duration, format_str, brief_hints=brief_hints
            )
        except Exception as plan_err:
            print(f"[generate] smart planner failed ({plan_err!r}); "
                  f"falling back to sequential", flush=True)
            edit_plan = auto_planner.generate_sequential_fallback(
                analyses, duration or 30, format_str
            )

        if not edit_plan.get("segments"):
            raise ValueError("Edit plan has no segments — every clip failed analysis")

        # Sprint 6: expose the final segment order in the job tracker so the
        # client can introspect / debug. Stored as a lightweight list of
        # dicts; the heavy clip paths stay server-side.
        set_job(job_id, edit_plan=[dict(s) for s in edit_plan["segments"]])

        # Sprint 6: remap source-time caption segments to edit-timeline text
        # layers, walking the final segment order. A caption is included iff
        # its [sourceStart, sourceEnd] overlaps the segment's
        # [sourceIn, sourceOut] for the same clipFilename — anything trimmed
        # out of the edit silently drops. Layers are appended to whatever
        # the client already passed in via `layers`.
        try:
            caption_layers = _remap_captions_to_layers(
                caption_segments or [], edit_plan["segments"],
                caption_style or "subtitles",
            )
            if caption_layers:
                print(f"[generate] remapped {len(caption_layers)} caption "
                      f"line(s) to edit timeline", flush=True)
                layers = list(layers or []) + caption_layers
        except Exception as cap_err:
            print(f"[generate] caption remap skipped: {cap_err!r}", flush=True)

        # Sprint 4: if the client ran audio analysis and saved beat_anchors
        # to project.motioncut.json, snap each segment's tail to the nearest
        # beat. Skip silently if no doc / no beats — render continues
        # un-snapped exactly like before.
        try:
            with _doc_lock(pid):
                doc_for_beats = _read_doc(pid) or {}
            beats = list((doc_for_beats.get("audio") or {}).get("beat_anchors") or [])
            if beats and edit_plan["segments"]:
                snapped = _snap_segments_to_beats(edit_plan["segments"], beats)
                print(f"[generate] snapping {len(snapped)} segments to "
                      f"{len(beats)} beats", flush=True)
                edit_plan["segments"] = snapped
        except Exception as snap_err:
            print(f"[generate] beat snap skipped: {snap_err!r}", flush=True)

        set_job(job_id, status="rendering", progress=60, eta_seconds=20)
        # 3. Resolve file paths and target resolution.
        pdir = project_dir(pid)
        segment_paths = [pdir / safe_name(s["clipFilename"]) for s in edit_plan["segments"]]
        # Skip segments whose underlying file disappeared (defensive — we
        # already filtered analyses, but the file may have been deleted
        # between analyse and render).
        kept = [(p, s) for p, s in zip(segment_paths, edit_plan["segments"]) if p.exists()]
        if not kept:
            raise ValueError("All segment files vanished between plan and render")
        segment_paths = [p for p, _ in kept]
        segments     = [s for _, s in kept]
        aspect = edit_plan.get("aspect", "16:9")
        if aspect == "9:16":
            target_w, target_h = 1080, 1920
        elif aspect == "1:1":
            target_w, target_h = 1080, 1080
        else:
            target_w, target_h = 1920, 1080
        # 3b. Pre-render any image segments into short looped MP4s so the
        # multi-clip FFmpeg pipeline (which assumes video inputs) can treat
        # them like any other clip. Cached on disk, free on repeat runs.
        for i, (p, seg) in enumerate(zip(segment_paths, segments)):
            if p.suffix.lower() not in ALLOWED_IMAGE:
                continue
            dur = max(0.5, float(seg["sourceOut"]) - float(seg["sourceIn"]))
            try:
                looped = _image_to_video_cached(p, dur, target_w, target_h)
            except Exception as e:
                print(f"[generate] skipping image {p.name}: {e}", flush=True)
                continue
            segment_paths[i] = looped
            # Rewrite the segment to reference the looped file at full range.
            segments[i] = {**seg, "clipFilename": looped.name,
                           "sourceIn": 0.0, "sourceOut": round(dur, 3)}
        # Drop segments whose image conversion failed.
        kept2 = [(p, s) for p, s in zip(segment_paths, segments)
                 if p.exists() and p.stat().st_size > 0]
        if not kept2:
            raise ValueError("Every clip failed to render — nothing to assemble")
        segment_paths = [p for p, _ in kept2]
        segments     = [s for _, s in kept2]
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        out_path  = EXPORT_DIR / f"motioncut_generate_{timestamp}.mp4"

        # 4. Resolve music track (optional). Priority: uploaded file >
        # catalogue URL > silence. audio_path stays None when nothing is
        # chosen — run_export_job emits silent anullsrc in that case.
        audio_path = None
        if music_filename:
            cand = pdir / safe_name(music_filename)
            if cand.exists():
                audio_path = cand
            else:
                print(f"[generate] music file {music_filename!r} not found in {pdir} — "
                      f"falling back to catalogue/silence", flush=True)
        if audio_path is None and music_catalogue_url:
            # Catalogue tracks live under /static/audio/, served as plain
            # static assets. Resolve to a local Path inside BASE_DIR; refuse
            # anything outside that tree so a crafted URL can't escape.
            rel = music_catalogue_url.lstrip("/")
            cand = (BASE_DIR / rel).resolve()
            try:
                cand.relative_to((BASE_DIR / "static" / "audio").resolve())
            except ValueError:
                print(f"[generate] catalogue url {music_catalogue_url!r} outside static/audio — ignoring", flush=True)
                cand = None
            if cand and cand.exists():
                audio_path = cand
            else:
                print(f"[generate] catalogue track {music_catalogue_url!r} not found — silent fallback", flush=True)

        # 5. Hand off to the existing multi-clip FFmpeg pipeline. Same
        #    signature as /api/export uses; the function updates set_job()
        #    progress 0→99→100 and writes status="done" / "error" itself.
        # Letterbox bars only make sense on a 16:9 canvas (cinematic look);
        # silently drop the toggle on portrait/square so the UI can't accidentally
        # produce a vertically-letterboxed reel.
        effective_letterbox = bool(letterbox) and aspect == "16:9"
        payload = {
            # Sprint 5: client-supplied text layers (Whisper captions). The
            # FFmpeg multi-clip pipeline maps these via drawtext in
            # build_filter_complex() with no further processing here.
            "layers":       list(layers or []),
            "colorGrade":   color_grade or "natural",
            "vignette":     bool(vignette),
            "filmGrain":    bool(film_grain),
            "letterbox":    effective_letterbox,
            # User-controlled in Sprint 3 via the volume slider. Clamp to
            # [0..1] defensively — the client should already do this.
            "musicVolume":  max(0.0, min(1.0, float(music_volume))) if audio_path else 0.0,
            "musicFadeIn":  bool(audio_path),
            "musicFadeOut": bool(audio_path),
            # Multi-clip mode in run_export_job replaces clip audio with the
            # music track entirely (see comment in run_export_job). So mode
            # is effectively "replace" regardless of this flag.
            "musicMode":    "replace",
        }
        run_export_job(
            job_id, payload,
            src_video=segment_paths[0],     # ignored in multi-clip mode, but positional
            image_paths=[],
            audio_path=audio_path,
            out_path=out_path,
            target_w=target_w,
            target_h=target_h,
            duration=edit_plan["total_duration"],
            segment_paths=segment_paths,
            segments=segments,
        )
        # run_export_job sets status="done" + output + url on success. No
        # need to repeat it here.
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"[generate] pipeline failed for job {job_id}: {e!r}\n{tb}", flush=True)
        set_job(
            job_id,
            status="error",
            error_message=str(e),
            trace=tb.splitlines()[-6:],
        )


@app.route("/api/generate", methods=["POST"])
def api_generate():
    """Kick off run_pipeline() in a daemon thread. Returns {job_id} immediately
    so the client can poll /api/generate/<id>/status for progress."""
    data = request.get_json(force=True, silent=True) or {}
    pid       = (data.get("project") or "default").strip() or "default"
    filenames = [str(f) for f in (data.get("filenames") or []) if f]
    style     = (data.get("style") or "real_estate").lower()
    duration  = data.get("duration")    # may be None for "Auto"
    fmt       = data.get("format") or "16:9"
    # Visual / music options (Sprint 2). All optional — defaults keep the
    # existing minimal-payload behaviour for legacy callers.
    music_filename = data.get("music_filename") or None
    color_grade    = (data.get("color_grade") or "natural").lower()
    vignette       = bool(data.get("vignette") or False)
    film_grain     = bool(data.get("film_grain") or False)
    letterbox      = bool(data.get("letterbox") or False)
    # Sprint 3: user-set music volume (0..1) + optional catalogue track URL
    # (relative path under /static/audio/). Both optional.
    try:
        music_volume = float(data.get("music_volume", 0.85))
    except (TypeError, ValueError):
        music_volume = 0.85
    music_volume = max(0.0, min(1.0, music_volume))
    music_catalogue_url = data.get("music_catalogue_url") or None
    # Sprint 5: caption text layers from the Whisper worker. Validated only
    # lightly here — build_filter_complex() defends against missing fields.
    layers = data.get("layers") or []
    if not isinstance(layers, list):
        layers = []
    # Sprint 6 — captions arrive as source-time segments tagged with their
    # source clipFilename. Remapping to the edit timeline happens inside
    # run_pipeline once the plan is built.
    caption_segments = data.get("caption_segments") or []
    if not isinstance(caption_segments, list):
        caption_segments = []
    caption_style = (data.get("caption_style") or "subtitles").lower()
    clip_metadata = data.get("clip_metadata") or []
    if not isinstance(clip_metadata, list):
        clip_metadata = []
    # Sprint 7 — optional free-text brief. Parsed server-side with regex
    # heuristics in run_pipeline; missing/empty falls back to the default
    # auto_planner path with the caller's explicit style/duration/format.
    brief = (data.get("brief") or "").strip()
    if len(brief) > 4000:
        brief = brief[:4000]

    if not filenames:
        return jsonify({"error": "no filenames provided"}), 400
    # Validate that at least one file actually exists on disk — saves a
    # confusing 60s wait that ends in "all clips missing".
    pdir = project_dir(pid)
    missing = [fn for fn in filenames if not (pdir / safe_name(fn)).exists()]
    if missing and len(missing) == len(filenames):
        return jsonify({"error": f"none of the files exist on the server: {missing}"}), 404

    try:
        duration = int(duration) if duration not in (None, "", "auto", "Auto") else None
    except Exception:
        duration = None

    job_id = uuid.uuid4().hex[:12]
    set_job(job_id, status="queued", progress=0, eta_seconds=60)
    t = threading.Thread(
        target=run_pipeline,
        args=(job_id, pid, filenames, style, duration, fmt, music_filename,
              color_grade, vignette, film_grain, letterbox,
              music_volume, music_catalogue_url, layers,
              caption_segments, caption_style, clip_metadata, brief),
        daemon=True,
    )
    t.start()
    return jsonify({"job_id": job_id})


@app.route("/api/generate/<job_id>/status")
def api_generate_status(job_id):
    """Mirror of get_job() reshaped for the new UI's 4-step display.
    Maps internal run_export_job statuses ("queued","running","done","error")
    onto user-facing ones ("rendering","done","error") so the frontend
    doesn't need to know about both worlds."""
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "unknown job"}), 404
    raw_status = job.get("status") or "queued"
    # run_export_job uses "running" once FFmpeg is invoked. From the
    # user's perspective that's still the "rendering" step.
    if raw_status in ("running", "queued"):
        ui_status = "rendering" if job.get("progress", 0) >= 60 else raw_status
    else:
        ui_status = raw_status
    out = {
        "status":        ui_status,
        "progress":      int(job.get("progress") or 0),
        "eta_seconds":   int(job.get("eta_seconds") or 0),
        "error_message": job.get("error_message") or job.get("error"),
        # Sprint 6: edit_plan is stored once the planner has run. Exposed so
        # the client can debug or build caption alignment tools later.
        "segments":      job.get("edit_plan") or [],
    }
    if ui_status == "done" and job.get("output"):
        out["output_url"] = f"/exports/{job['output']}"
    return jsonify(out)


# Catalogue of CC0 music tracks shipped under /static/audio/. One entry per
# style — the Options panel's "Auto" mode picks the track whose `style`
# matches the currently-selected reel style. Placeholders are synthesised
# sine waves; swap the files in /static/audio/ for real CC0 tracks (Pixabay,
# Free Music Archive, etc.) without touching this catalogue list.
_MUSIC_CATALOGUE = [
    {"id": "real_estate_calm",   "name": "Calm & Professional",
     "style": "real_estate",     "url": "/static/audio/real_estate_calm.mp3"},
    {"id": "social_upbeat",      "name": "Upbeat Social",
     "style": "social",          "url": "/static/audio/social_upbeat.mp3"},
    {"id": "cinematic_dramatic", "name": "Cinematic Dramatic",
     "style": "cinematic",       "url": "/static/audio/cinematic_dramatic.mp3"},
    {"id": "fast_electronic",    "name": "Fast Electronic",
     "style": "fast",            "url": "/static/audio/fast_electronic.mp3"},
]


@app.route("/api/music/catalogue")
def api_music_catalogue():
    """Return the list of bundled CC0 tracks the client can auto-pick from.
    The frontend matches `style` to the currently-selected reel style to
    pre-fill the music chip when the user chooses "Auto"."""
    return jsonify({"tracks": _MUSIC_CATALOGUE})


@app.route("/api/export", methods=["POST"])
def api_export():
    data = request.get_json(force=True, silent=True) or {}
    project = data.get("project") or "default"
    pdir = project_dir(project)

    def find_in_project(name):
        if not name: return None
        n = safe_name(name)
        cand = pdir / n
        if cand.exists(): return cand
        legacy = UPLOAD_DIR / n
        if legacy.exists(): return legacy
        return None

    aspect = data.get("aspect", "16:9")
    if aspect == "16:9":
        target_w, target_h = 1920, 1080
    elif aspect == "9:16":
        target_w, target_h = 1080, 1920
    else:
        target_w, target_h = 1920, 1080

    # Multi-clip mode triggers when the payload carries a non-empty segments list.
    raw_segments = data.get("segments") or []
    multi_clip = isinstance(raw_segments, list) and len(raw_segments) > 0

    src_path = None
    segments = []
    segment_paths = []
    duration = 0.0

    if multi_clip:
        # Resolve each segment's clip path. Missing files are skipped with a
        # warning rather than aborting the whole export — partial output beats
        # no output for a 30-clip auto-edit where one file went missing.
        skipped = []
        for seg in raw_segments:
            if not isinstance(seg, dict):
                continue
            fname = seg.get("clipFilename")
            p = find_in_project(fname)
            if not p:
                skipped.append(fname)
                continue
            segments.append({
                "clipFilename": fname,
                "sourceIn": float(seg.get("sourceIn") or 0.0),
                "sourceOut": float(seg.get("sourceOut") or 0.0),
                "transition": seg.get("transition") or {"type": "cut", "duration": 0.0},
            })
            segment_paths.append(p)
        if skipped:
            print(f"[export] multi-clip: skipped missing clips: {skipped}")
        if not segments:
            return jsonify({"error": "no resolvable segments — all clip files missing"}), 404
        # Effective duration = sum of per-segment durations minus crossfade overlaps.
        duration = 0.0
        prev_seg = None
        for seg in segments:
            d = max(0.01, seg["sourceOut"] - seg["sourceIn"])
            duration += d
            if prev_seg is not None:
                t = (prev_seg.get("transition") or {})
                ttype = (t.get("type") or "cut").lower()
                tdur = float(t.get("duration") or 0.0)
                if ttype in ("crossfade", "xfade", "fade", "fade_to_black", "fadeblack"):
                    duration -= max(0.0, min(tdur, d - 0.01))
            prev_seg = seg
        duration = max(0.1, duration)
        # Pick the first segment's path for any helper that still wants `src_video`
        # (the multi-clip branch in run_export_job ignores this argument, but we
        # keep the positional contract intact).
        src_path = segment_paths[0]
    else:
        src = data.get("video")
        if not src:
            return jsonify({"error": "missing video"}), 400
        src_path = pdir / safe_name(src)
        if not src_path.exists():
            legacy = UPLOAD_DIR / safe_name(src)
            if legacy.exists():
                src_path = legacy
            else:
                return jsonify({"error": f"source video not found: {src}"}), 404
        full_duration = probe_duration(src_path)
        in_mark  = data.get("inMark")  or 0
        out_mark = data.get("outMark") or full_duration
        duration = max(0.1, float(out_mark) - float(in_mark))

    image_paths = []
    for layer in data.get("layers", []):
        if layer.get("type") in ("logo", "image"):
            p = find_in_project(layer.get("src"))
            if p: image_paths.append(p)

    audio_path = find_in_project(data.get("audio"))

    timestamp = time.strftime("%Y%m%d_%H%M%S")
    template_name = re.sub(r"[^a-zA-Z0-9_-]", "_", data.get("template", "custom"))
    out_name = f"motioncut_{template_name}_{aspect.replace(':','x')}_{timestamp}.mp4"
    out_path = EXPORT_DIR / out_name

    job_id = uuid.uuid4().hex[:12]
    set_job(job_id, status="queued", progress=0)

    t = threading.Thread(
        target=run_export_job,
        args=(job_id, data, src_path, image_paths, audio_path,
              out_path, target_w, target_h, duration),
        kwargs={
            "segment_paths": segment_paths if multi_clip else None,
            "segments": segments if multi_clip else None,
        },
        daemon=True,
    )
    t.start()

    return jsonify({
        "ok": True, "jobId": job_id, "output": out_name,
        "mode": "multi" if multi_clip else "single",
        "segmentCount": len(segments),
    })


@app.route("/api/export/progress/<job_id>")
def api_progress(job_id):
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "unknown job"}), 404
    return jsonify(job)


@app.route("/api/export/stream/<job_id>")
def api_stream(job_id):
    def gen():
        last_pct = -1
        while True:
            job = get_job(job_id)
            if not job:
                yield f"data: {json.dumps({'error':'unknown job'})}\n\n"
                return
            pct = job.get("progress", 0)
            status = job.get("status")
            if pct != last_pct or status in ("done", "error"):
                yield f"data: {json.dumps(job)}\n\n"
                last_pct = pct
            if status in ("done", "error"):
                return
            time.sleep(0.5)
    return Response(gen(), mimetype="text/event-stream")


@app.errorhandler(413)
def too_large(_e):
    return jsonify({"error": "file too large (limit 2GB)"}), 413


@app.errorhandler(500)
@app.errorhandler(Exception)
def _all_unhandled(e):
    """Last-resort handler — any unhandled exception in any route comes here.
    Without this, Flask's default 500 page is HTML and the frontend's
    `await response.json()` blows up with 'Unexpected end of JSON input'
    (Werkzeug truncates the body in some error paths). Always return JSON
    + log the trace so the operator can read it in /tmp/mc.log.

    HTTP exceptions (404, 405, etc.) pass through with their original status.
    """
    import traceback
    from werkzeug.exceptions import HTTPException
    if isinstance(e, HTTPException):
        return jsonify({"error": e.description, "code": e.code}), e.code
    tb = traceback.format_exc()
    print("[flask] UNHANDLED:", e, "\n", tb, flush=True)
    return jsonify({
        "error": f"server error: {e!r}",
        "type":  type(e).__name__,
        "trace": tb.splitlines()[-8:],
    }), 500


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
# One-shot startup work shared by both `python app.py` and any WSGI server
# (gunicorn). Runs at import time so Render / Fly / etc. don't need a custom
# entrypoint shim — they just point at app:app.
def _bootstrap():
    print("=" * 60)
    print(" MotionCut - video editor")
    print(f" FFmpeg: {FFMPEG}  available={ffmpeg_available()}")
    print(f" Uploads: {UPLOAD_DIR}")
    print(f" Exports: {EXPORT_DIR}")
    print("=" * 60)
    # Rehydrate the job tracker from disk so a fresh process / sibling
    # gunicorn worker doesn't 404 on the first status poll for a job that
    # was registered by another process.
    try:
        _load_jobs_from_disk()
    except Exception as e:
        print(f"[jobs] hydration failed: {e}", flush=True)
    # Migrate any legacy loose files to uploads/default/
    if os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        try: migrate_legacy_uploads()
        except Exception as e: print(f"[migrate] {e}")
        project_dir("default")
    # Auto-pull is a Codespaces-only convenience — useless on a hosted
    # deploy (Render redeploys on each push, no .git to pull anyway).
    # Auto-disable when MOTIONCUT_NO_AUTOPULL is set OR there's no .git.
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or not os.environ.get("WERKZEUG_RUN_MAIN"):
        start_auto_pull()


_bootstrap()


if __name__ == "__main__":
    # Local dev: Werkzeug reloader, debug on, configurable port.
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("MOTIONCUT_PROD", "").lower() not in ("1", "true", "yes")
    print(f" Open http://localhost:{port}  (debug={debug})")
    app.run(host="0.0.0.0", port=port, debug=debug, threaded=True, use_reloader=debug)
