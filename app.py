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
from flask import (
    Flask, request, jsonify, send_from_directory,
    render_template, Response, abort, url_for
)
from flask_cors import CORS

# ----------------------------------------------------------------------------
# Paths & config
# ----------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
EXPORT_DIR = BASE_DIR / "exports"
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


def set_job(job_id, **fields):
    with JOBS_LOCK:
        job = JOBS.setdefault(job_id, {})
        job.update(fields)


def get_job(job_id):
    with JOBS_LOCK:
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


@app.route("/")
def index():
    return render_template("index.html")


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


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "ffmpeg": ffmpeg_available()})


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
    kind = request.form.get("kind", "auto")
    if kind == "auto":
        if ext in ALLOWED_VIDEO:
            kind = "video"
        elif ext in ALLOWED_IMAGE:
            kind = "image"
        elif ext in ALLOWED_AUDIO:
            kind = "audio"
        else:
            return jsonify({"error": f"unsupported extension {ext}"}), 400

    allowed = {
        "video": ALLOWED_VIDEO,
        "image": ALLOWED_IMAGE,
        "audio": ALLOWED_AUDIO,
    }[kind]
    if ext not in allowed:
        return jsonify({"error": f"{ext} not allowed for {kind}"}), 400

    project = request.form.get("project") or "default"
    out_dir = project_dir(project)

    fid = uuid.uuid4().hex[:12]
    fname = f"{fid}_{safe_name(f.filename)}"
    out_path = out_dir / fname
    f.save(str(out_path))

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


@app.route("/api/upload/chunk", methods=["POST"])
def upload_chunk():
    """
    Chunked upload to bypass reverse-proxy body-size limits (Codespaces, etc.).
    Form fields: uploadId, chunkIndex, totalChunks, filename, kind, chunk(file)
    On the final chunk we assemble, probe duration, and return the same shape
    as /api/upload.
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

    part_path = TMP_DIR / f"{upload_id}.part"
    # Append chunks in order. We require client to send sequentially.
    with open(part_path, "ab") as f:
        chunk.save(f)

    if idx < total - 1:
        return jsonify({"ok": True, "received": idx + 1, "of": total})

    # Final chunk: finalize
    filename = request.form.get("filename", "upload.bin")
    ext = Path(filename).suffix.lower()
    kind = request.form.get("kind", "auto")
    if kind == "auto":
        if ext in ALLOWED_VIDEO: kind = "video"
        elif ext in ALLOWED_IMAGE: kind = "image"
        elif ext in ALLOWED_AUDIO: kind = "audio"
        else:
            part_path.unlink(missing_ok=True)
            return jsonify({"error": f"unsupported extension {ext}"}), 400
    allowed = {"video": ALLOWED_VIDEO, "image": ALLOWED_IMAGE, "audio": ALLOWED_AUDIO}[kind]
    if ext not in allowed:
        part_path.unlink(missing_ok=True)
        return jsonify({"error": f"{ext} not allowed for {kind}"}), 400

    project = request.form.get("project") or "default"
    out_dir = project_dir(project)

    fid = uuid.uuid4().hex[:12]
    fname = f"{fid}_{safe_name(filename)}"
    out_path = out_dir / fname
    shutil.move(str(part_path), str(out_path))

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
        ext = f.suffix.lower()
        if ext in ALLOWED_VIDEO:   kind = "video"
        elif ext in ALLOWED_IMAGE: kind = "image"
        elif ext in ALLOWED_AUDIO: kind = "audio"
        else: continue
        out.append({
            "name":     f.name,
            "kind":     kind,
            "size":     f.stat().st_size,
            "modified": f.stat().st_mtime,
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


def _analyze_or_cached(pid, filename):
    """Used by /api/auto-edit. Returns the cached analysis if present;
    otherwise runs a full analysis and caches it. Always returns a dict
    (with an `error` key if the file can't be analysed)."""
    cached = _get_cached_analysis(pid, filename)
    if cached:
        return {**cached, "filename": filename}
    src = project_dir(pid) / safe_name(filename)
    if not src.exists():
        return {"filename": filename, "error": "file not found"}
    try:
        result = _analyze_clip_file(src)
        result["filename"] = filename
        _set_cached_analysis(pid, filename, result)
        return result
    except Exception as e:
        return {"filename": filename, "error": str(e)}


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
    """
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
    for i, seg in enumerate(segments):
        parts.append(
            f"[{i}:v]scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
            f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:color=black,"
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

    # 6) Text layers via drawtext
    text_layers = [l for l in layers if l.get("type") == "text"]
    for i, layer in enumerate(text_layers):
        cw = max(1, layer.get("canvasW", target_w))
        ch = max(1, layer.get("canvasH", target_h))
        x = int(layer.get("x", 0) * target_w / cw)
        y = int(layer.get("y", 0) * target_h / ch)
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


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
if __name__ == "__main__":
    print("=" * 60)
    print(" MotionCut - local video editor")
    print(f" FFmpeg: {FFMPEG}  available={ffmpeg_available()}")
    print(f" Uploads: {UPLOAD_DIR}")
    print(f" Exports: {EXPORT_DIR}")
    print(" Open http://localhost:5000")
    print("=" * 60)
    # Migrate any legacy loose files to uploads/default/
    if os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        migrate_legacy_uploads()
        project_dir("default")  # ensure exists
    # Auto-pull from origin every 15s so the browser refresh always shows the
    # latest commit. Only run in the main process (not in the Werkzeug reloader child).
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or not os.environ.get("WERKZEUG_RUN_MAIN"):
        start_auto_pull()
    # debug=True enables auto-reload on app.py changes (hot reload).
    # For Codespaces, bind to 0.0.0.0 so the forwarded port works.
    app.run(host="0.0.0.0", port=5000, debug=True, threaded=True, use_reloader=True)
