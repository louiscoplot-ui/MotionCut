"""
MotionCut MCP server — JSON-RPC 2.0 over HTTP on 127.0.0.1:19790.

Pattern lifted from Palmier Pro (palmier-io/palmier-pro): expose a local
HTTP endpoint so Claude Desktop / Cursor / Codex can drive the timeline
through MCP tools. Palmier ships a Node proxy that forwards to their Swift
app on :19789; we serve MCP directly in-process from Python on :19790.

The MCP protocol layer is implemented by hand (no `mcp` PyPI dep) so it
runs in a daemon thread inside the same Flask process and shares state
(JOBS, doc locks) with the main app without IPC.

Tools all read/write project.motioncut.json through app._read_doc /
app._write_doc_atomic so the file remains the single source of truth. Each
mutating tool bumps PROJECT_VERSION so the frontend can poll
/api/project/version and reload when an MCP-driven change lands.
"""
import base64
import json
import os
import subprocess
import threading
import time
import uuid

from flask import Flask, request, jsonify
from werkzeug.serving import make_server

import app as motioncut_app

MCP_PORT = int(os.environ.get("MOTIONCUT_MCP_PORT", "19790"))
MCP_HOST = os.environ.get("MOTIONCUT_MCP_HOST", "127.0.0.1")
SERVER_NAME = "motioncut"
SERVER_VERSION = "0.1.0"
PROTOCOL_VERSION = "2024-11-05"

_VERSION = 0
_VERSION_LOCK = threading.Lock()


def bump_version():
    global _VERSION
    with _VERSION_LOCK:
        _VERSION += 1
        return _VERSION


def get_version():
    with _VERSION_LOCK:
        return _VERSION


class MCPResponse:
    """Sentinel returned by tools that need to ship MCP content items
    directly (e.g. images) rather than have the dispatcher wrap their
    result as text."""
    __slots__ = ("content",)
    def __init__(self, content):
        self.content = content


_ACTIVE_PROJECT = "default"
_ACTIVE_LOCK = threading.Lock()


def get_active_project():
    with _ACTIVE_LOCK:
        return _ACTIVE_PROJECT


def set_active_project(pid):
    global _ACTIVE_PROJECT
    with _ACTIVE_LOCK:
        _ACTIVE_PROJECT = motioncut_app.safe_project_id(pid) or "default"


def _doc(pid):
    return motioncut_app._read_doc(pid) or motioncut_app._minimal_doc(pid)


def _save(pid, doc):
    doc["modified_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with motioncut_app._doc_lock(pid):
        motioncut_app._write_doc_atomic(pid, doc)
    bump_version()


def tool_get_project_context(project=None):
    pid = motioncut_app.safe_project_id(project) if project else get_active_project()
    doc = _doc(pid)
    clips = doc.get("clips") or []
    segments = doc.get("segments") or []
    total_duration = 0.0
    for s in segments:
        try:
            total_duration += max(0.0, float(s.get("sourceOut", 0)) - float(s.get("sourceIn", 0)))
        except (TypeError, ValueError):
            continue
    return {
        "project_id":             pid,
        "document":               doc,
        "clip_count":             len(clips),
        "segment_count":          len(segments),
        "total_duration_seconds": round(total_duration, 3),
        "export_settings":        doc.get("edit_params") or {},
        "version":                get_version(),
    }


def tool_list_clips(project=None):
    pid = motioncut_app.safe_project_id(project) if project else get_active_project()
    doc = _doc(pid)
    out = []
    for c in (doc.get("clips") or []):
        out.append({
            "id":                    c.get("id"),
            "filename":              c.get("filename"),
            "duration":              c.get("duration"),
            "in_point":              c.get("in_point",  c.get("sourceIn")),
            "out_point":             c.get("out_point", c.get("sourceOut")),
            "position_in_timeline":  c.get("position_in_timeline", c.get("timelineIn")),
            "shot_type":             c.get("shot_type"),
            "has_face":              c.get("has_face"),
        })
    return out


def tool_add_clip(filename, position=None, duration=5.0, project=None):
    if not filename or not isinstance(filename, str):
        raise ValueError("filename is required")
    pid = motioncut_app.safe_project_id(project) if project else get_active_project()
    doc = _doc(pid)
    clips = doc.setdefault("clips", [])
    clip = {
        "id":         uuid.uuid4().hex[:12],
        "filename":   motioncut_app.safe_name(filename),
        "duration":   float(duration),
        "in_point":   0.0,
        "out_point":  float(duration),
    }
    if position is None or int(position) >= len(clips):
        clips.append(clip)
    else:
        clips.insert(max(0, int(position)), clip)
    _save(pid, doc)
    return clip


def tool_trim_clip(clip_id, in_point, out_point, project=None):
    pid = motioncut_app.safe_project_id(project) if project else get_active_project()
    doc = _doc(pid)
    for c in (doc.get("clips") or []):
        if c.get("id") == clip_id:
            c["in_point"]  = float(in_point)
            c["out_point"] = float(out_point)
            _save(pid, doc)
            return c
    raise ValueError(f"clip_id {clip_id!r} not found")


def tool_reorder_clips(clip_ids, project=None):
    if not isinstance(clip_ids, list):
        raise ValueError("clip_ids must be an array")
    pid = motioncut_app.safe_project_id(project) if project else get_active_project()
    doc = _doc(pid)
    clips = doc.get("clips") or []
    by_id = {c.get("id"): c for c in clips}
    missing = [cid for cid in clip_ids if cid not in by_id]
    if missing:
        raise ValueError(f"unknown clip ids: {missing}")
    reordered = [by_id[cid] for cid in clip_ids]
    for c in clips:
        if c.get("id") not in clip_ids:
            reordered.append(c)
    doc["clips"] = reordered
    _save(pid, doc)
    return reordered


def tool_set_clip_property(clip_id, property, value, project=None):
    if property in ("id",):
        raise ValueError(f"property {property!r} is immutable")
    pid = motioncut_app.safe_project_id(project) if project else get_active_project()
    doc = _doc(pid)
    for c in (doc.get("clips") or []):
        if c.get("id") == clip_id:
            c[property] = value
            _save(pid, doc)
            return c
    raise ValueError(f"clip_id {clip_id!r} not found")


def _project_filenames(pid, explicit=None):
    """Return the list of filenames to render. If explicit is given, use it
    verbatim. Otherwise read clips[] from the project doc; if empty, fall
    back to every uploaded file in the project dir (sorted)."""
    if explicit:
        return [str(f) for f in explicit if f]
    doc = _doc(pid)
    clips = doc.get("clips") or []
    if clips:
        return [c.get("filename") for c in clips if c.get("filename")]
    pdir = motioncut_app.project_dir(pid)
    if not pdir.exists():
        return []
    out = []
    for p in sorted(pdir.iterdir()):
        if p.name.startswith(".") or p.name == motioncut_app.DOC_FILENAME:
            continue
        if p.suffix.lower() in (motioncut_app.ALLOWED_VIDEO
                                | motioncut_app.ALLOWED_IMAGE):
            out.append(p.name)
    return out


def _spawn_render(pid, filenames, *, brief="", style="real_estate",
                  duration=None, fmt="16:9", color_grade="natural",
                  vignette=False, film_grain=False, letterbox=False,
                  music_volume=0.85, music_filename=None):
    """Mirror of /api/generate's thread-spawn logic, callable in-process."""
    if not filenames:
        raise ValueError("no filenames to render (project clips[] is empty "
                         "and no files in project dir)")
    job_id = uuid.uuid4().hex[:12]
    motioncut_app.set_job(job_id, status="queued", progress=0, eta_seconds=60)
    t = threading.Thread(
        target=motioncut_app.run_pipeline,
        args=(job_id, pid, filenames, style, duration, fmt, music_filename,
              color_grade, vignette, film_grain, letterbox,
              music_volume, None, [], [], "subtitles", [], brief),
        daemon=True,
    )
    t.start()
    return job_id


def tool_trigger_export(project=None, filenames=None, style="real_estate",
                        duration=None, format="16:9", brief="",
                        color_grade="natural"):
    """Real implementation — spawns run_pipeline in a daemon thread."""
    pid = motioncut_app.safe_project_id(project) if project else get_active_project()
    fnames = _project_filenames(pid, filenames)
    job_id = _spawn_render(pid, fnames, brief=brief, style=style,
                           duration=duration, fmt=format,
                           color_grade=color_grade)
    return {
        "ok":           True,
        "job_id":       job_id,
        "project":      pid,
        "filenames":    fnames,
        "format":       format,
        "style":        style,
        "duration":     duration,
        "status_hint":  f"poll get_export_status({job_id!r}) or call wait_for_export",
    }


def tool_get_export_status(job_id):
    job = motioncut_app.get_job(job_id)
    if not job:
        return {"job_id": job_id, "status": "unknown", "error": "no job with that id"}
    return {"job_id": job_id, **job}


def tool_wait_for_export(job_id, timeout_seconds=180, poll_interval=1.5):
    """Block until the job reaches a terminal status (done/error) or until
    timeout_seconds elapses. Returns the final job state."""
    deadline = time.monotonic() + max(1.0, float(timeout_seconds))
    interval = max(0.25, float(poll_interval))
    last = None
    while time.monotonic() < deadline:
        job = motioncut_app.get_job(job_id)
        if not job:
            return {"job_id": job_id, "status": "unknown",
                    "error": "no job with that id"}
        last = job
        status = job.get("status")
        if status in ("done", "error"):
            return {"job_id": job_id, **job}
        time.sleep(interval)
    return {"job_id": job_id, "status": "timeout",
            "error": f"timed out after {timeout_seconds}s",
            "last_state": last}


def tool_get_export_url(job_id):
    """Return the URL of the rendered mp4 once the job is done."""
    job = motioncut_app.get_job(job_id)
    if not job:
        return {"job_id": job_id, "status": "unknown",
                "error": "no job with that id"}
    if job.get("status") != "done":
        return {"job_id": job_id, "status": job.get("status"),
                "error": "job not finished yet"}
    return {
        "job_id":   job_id,
        "status":   "done",
        "url":      job.get("url"),
        "output":   job.get("output"),
        "duration": job.get("duration"),
    }


def _resolve_clip_path(pid, filename):
    pdir = motioncut_app.project_dir(pid)
    p = pdir / motioncut_app.safe_name(filename)
    if p.exists():
        return p
    legacy = motioncut_app.UPLOAD_DIR / motioncut_app.safe_name(filename)
    if legacy.exists():
        return legacy
    raise FileNotFoundError(f"clip {filename!r} not found in project {pid!r}")


def _extract_thumbnail(src_path, t_seconds, dest_path, width=480):
    """Run FFmpeg to extract a single JPEG frame at t_seconds."""
    if dest_path.exists():
        return dest_path
    cmd = [
        motioncut_app.FFMPEG, "-y",
        "-ss", f"{t_seconds:.3f}", "-i", str(src_path),
        "-frames:v", "1",
        "-vf", f"scale={int(width)}:-2",
        "-q:v", "5", str(dest_path),
    ]
    subprocess.run(cmd, capture_output=True, timeout=20)
    return dest_path if dest_path.exists() else None


def tool_get_clip_thumbnails(filename, count=4, project=None, width=480):
    """Returns base64-encoded JPEG thumbnails sampled across the clip's
    duration so the LLM (multimodal) can see what's in the clip. Returned
    as MCP image content items, displayable directly by Claude Desktop.

    For images (jpg/png/heic/webp), returns the source as a single thumb."""
    pid = motioncut_app.safe_project_id(project) if project else get_active_project()
    src = _resolve_clip_path(pid, filename)
    count = max(1, min(8, int(count)))
    pdir = src.parent

    if src.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        with open(src, "rb") as f:
            data = base64.b64encode(f.read()).decode("ascii")
        mime = "image/png" if src.suffix.lower() == ".png" else "image/jpeg"
        return MCPResponse([
            {"type": "text",  "text": f"Source image {filename}"},
            {"type": "image", "data": data, "mimeType": mime},
        ])

    duration = motioncut_app.probe_duration(src) or 0.0
    if duration <= 0:
        raise ValueError(f"could not probe duration of {filename}")

    timestamps = [duration * (i + 0.5) / count for i in range(count)]
    content = [{"type": "text",
                "text": f"{filename} — {duration:.2f}s — {count} sampled frames"}]
    for i, t in enumerate(timestamps):
        cache = pdir / f".mcp_thumb_{src.stem}_{int(t * 1000)}_{int(width)}.jpg"
        path = _extract_thumbnail(src, t, cache, width=width)
        if not path:
            continue
        with open(path, "rb") as f:
            data = base64.b64encode(f.read()).decode("ascii")
        content.append({"type": "text", "text": f"frame {i+1}/{count} at t={t:.2f}s"})
        content.append({"type": "image", "data": data, "mimeType": "image/jpeg"})
    return MCPResponse(content)


def tool_analyze_clip(filename, project=None, force=False):
    """Runs the full FFmpeg analysis: motion, sharpness, brightness, audio
    energy, scene cuts, composite shot_score. Cached in project doc unless
    force=True. Lets the LLM reason about which clips are best opener vs
    closer, which are blurry, which have movement, etc."""
    pid = motioncut_app.safe_project_id(project) if project else get_active_project()
    src = _resolve_clip_path(pid, filename)
    if not force:
        cached = motioncut_app._get_cached_analysis(pid, src.name)
        if cached:
            return {"cached": True, **cached}
    result = motioncut_app._analyze_clip_file(str(src), debug=False)
    motioncut_app._set_cached_analysis(pid, src.name, result)
    bump_version()
    return {"cached": False, **result}


def tool_generate_edit_from_brief(brief, project=None, format="16:9",
                                  duration=None, style="real_estate",
                                  filenames=None, wait=False,
                                  timeout_seconds=240):
    """One-shot: takes a natural-language brief + project, kicks off the
    full pipeline (analyse -> 3-act plan -> render). If wait=True, blocks
    until done and returns the mp4 url. If wait=False, returns the job_id
    immediately and the caller polls wait_for_export.

    This is the zero-touch tool: 'make me a 30s vertical reel from this
    project, luxury vibe' -> mp4 url, no other tools required."""
    if not brief or not isinstance(brief, str):
        raise ValueError("brief is required (a sentence describing the edit)")
    pid = motioncut_app.safe_project_id(project) if project else get_active_project()
    fnames = _project_filenames(pid, filenames)
    job_id = _spawn_render(pid, fnames, brief=brief, style=style,
                           duration=duration, fmt=format)
    if not wait:
        return {
            "ok":      True,
            "job_id":  job_id,
            "project": pid,
            "brief":   brief,
            "status":  "queued",
            "hint":    "call wait_for_export to block until done",
        }
    final = tool_wait_for_export(job_id, timeout_seconds=timeout_seconds)
    return {
        "ok":      final.get("status") == "done",
        "job_id":  job_id,
        "project": pid,
        "brief":   brief,
        **final,
    }


def tool_set_active_project(project):
    set_active_project(project)
    return {"active_project": get_active_project()}


TOOLS = [
    {
        "name":        "get_project_context",
        "description": "Returns the full project.motioncut.json document for the active project plus computed clip_count, segment_count, total_duration_seconds, export_settings, and the monotonic version number.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Optional project id; defaults to the active project."},
            },
        },
        "handler": tool_get_project_context,
    },
    {
        "name":        "list_clips",
        "description": "Returns clips[] with id, filename, duration, in_point, out_point, position_in_timeline, shot_type, has_face.",
        "inputSchema": {
            "type": "object",
            "properties": {"project": {"type": "string"}},
        },
        "handler": tool_list_clips,
    },
    {
        "name":        "add_clip",
        "description": "Append a clip to clips[]. position is the index to insert at (appends if omitted or out of bounds). Returns the new clip with its id.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string"},
                "position": {"type": "integer"},
                "duration": {"type": "number"},
                "project":  {"type": "string"},
            },
            "required": ["filename"],
        },
        "handler": tool_add_clip,
    },
    {
        "name":        "trim_clip",
        "description": "Sets in_point and out_point of a clip by clip_id and saves the project document.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "clip_id":   {"type": "string"},
                "in_point":  {"type": "number"},
                "out_point": {"type": "number"},
                "project":   {"type": "string"},
            },
            "required": ["clip_id", "in_point", "out_point"],
        },
        "handler": tool_trim_clip,
    },
    {
        "name":        "reorder_clips",
        "description": "Reorders clips[] to match the provided clip_ids sequence. Clips not listed are appended in their previous relative order.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "clip_ids": {"type": "array", "items": {"type": "string"}},
                "project":  {"type": "string"},
            },
            "required": ["clip_ids"],
        },
        "handler": tool_reorder_clips,
    },
    {
        "name":        "set_clip_property",
        "description": "Sets any top-level property on a clip (speed, overlay_type, label, etc). The 'id' field is immutable.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "clip_id":  {"type": "string"},
                "property": {"type": "string"},
                "value":    {},
                "project":  {"type": "string"},
            },
            "required": ["clip_id", "property", "value"],
        },
        "handler": tool_set_clip_property,
    },
    {
        "name":        "trigger_export",
        "description": "Spawns the full FFmpeg render pipeline (analyse -> 3-act plan -> multi-clip xfade -> mp4) in a daemon thread. Returns {job_id} immediately. Use wait_for_export to block or get_export_status to poll. Filenames default to the project's clips[] (or every uploaded file if clips[] is empty).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project":     {"type": "string"},
                "filenames":   {"type": "array", "items": {"type": "string"},
                                "description": "Explicit file list; if omitted, uses clips[] from the project doc."},
                "style":       {"type": "string", "enum": ["real_estate", "social", "cinematic", "fast"]},
                "duration":    {"type": "integer", "description": "Target seconds; null/omitted = auto."},
                "format":      {"type": "string", "enum": ["16:9", "9:16", "1:1"]},
                "brief":       {"type": "string", "description": "Optional natural-language brief; parsed for style/format/duration hints."},
                "color_grade": {"type": "string", "enum": ["natural", "cinematic", "teal_orange", "moody_dark", "bright_airy", "bw"]},
            },
        },
        "handler": tool_trigger_export,
    },
    {
        "name":        "get_export_status",
        "description": "Returns the current status of an FFmpeg export job by job_id (reads the same JOBS tracker the UI uses).",
        "inputSchema": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}},
            "required": ["job_id"],
        },
        "handler": tool_get_export_status,
    },
    {
        "name":        "wait_for_export",
        "description": "Blocks until the export job reaches done/error or until timeout_seconds elapses (default 180s, max ~ HTTP transport timeout). Returns the final job state with url + output path.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "job_id":          {"type": "string"},
                "timeout_seconds": {"type": "integer", "description": "Max seconds to wait (default 180)."},
                "poll_interval":   {"type": "number", "description": "Seconds between checks (default 1.5)."},
            },
            "required": ["job_id"],
        },
        "handler": tool_wait_for_export,
    },
    {
        "name":        "get_export_url",
        "description": "Returns the URL of the rendered mp4 once the job is done. 200 if done, error if still running or unknown.",
        "inputSchema": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}},
            "required": ["job_id"],
        },
        "handler": tool_get_export_url,
    },
    {
        "name":        "get_clip_thumbnails",
        "description": "Returns N evenly-spaced JPEG thumbnails of a clip as MCP image content. Lets multimodal models actually SEE what's in the clip (lighting, composition, subject, motion). For still images, returns the source itself.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string"},
                "count":    {"type": "integer", "description": "1-8 thumbs (default 4)."},
                "project":  {"type": "string"},
                "width":    {"type": "integer", "description": "Thumb width in px (default 480)."},
            },
            "required": ["filename"],
        },
        "handler": tool_get_clip_thumbnails,
    },
    {
        "name":        "analyze_clip",
        "description": "Runs the full FFmpeg analysis on a clip: motion, sharpness, brightness, audio_energy, scene_cuts, composite shot_score, duration. Cached in project doc so repeat calls are instant; pass force=true to recompute.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string"},
                "project":  {"type": "string"},
                "force":    {"type": "boolean", "description": "Recompute instead of returning cached result."},
            },
            "required": ["filename"],
        },
        "handler": tool_analyze_clip,
    },
    {
        "name":        "generate_edit_from_brief",
        "description": "ZERO-TOUCH: one-shot tool that takes a natural-language brief, kicks off the full pipeline (analyse -> 3-act plan -> render) on the project, and returns either the job_id (wait=false) or the final mp4 url (wait=true). The brief is parsed for format/duration/mood hints. Use this as the default tool when the user says 'make me a reel'.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "brief":           {"type": "string", "description": "Natural-language description of the desired edit. E.g. 'luxury 30s vertical reel for Instagram, focus on architecture and ocean views'."},
                "project":         {"type": "string"},
                "format":          {"type": "string", "enum": ["16:9", "9:16", "1:1"]},
                "duration":        {"type": "integer", "description": "Target seconds; null = auto."},
                "style":           {"type": "string", "enum": ["real_estate", "social", "cinematic", "fast"]},
                "filenames":       {"type": "array", "items": {"type": "string"}, "description": "Explicit clip list; if omitted, uses the project's clips[] or all uploaded files."},
                "wait":            {"type": "boolean", "description": "If true, block until render is done and return the url. If false (default), return immediately with job_id."},
                "timeout_seconds": {"type": "integer", "description": "Max wait when wait=true (default 240s)."},
            },
            "required": ["brief"],
        },
        "handler": tool_generate_edit_from_brief,
    },
    {
        "name":        "set_active_project",
        "description": "Switches the active project that tools default to when no project param is passed.",
        "inputSchema": {
            "type": "object",
            "properties": {"project": {"type": "string"}},
            "required": ["project"],
        },
        "handler": tool_set_active_project,
    },
]


def _tools_list_response():
    return [{k: v for k, v in t.items() if k != "handler"} for t in TOOLS]


def _dispatch_tool(name, arguments):
    for t in TOOLS:
        if t["name"] == name:
            try:
                result = t["handler"](**(arguments or {}))
                if isinstance(result, MCPResponse):
                    return {"content": result.content}
                text = json.dumps(result, default=str, ensure_ascii=False, indent=2)
                return {"content": [{"type": "text", "text": text}]}
            except TypeError as e:
                return {"content": [{"type": "text", "text": f"invalid arguments: {e}"}], "isError": True}
            except ValueError as e:
                return {"content": [{"type": "text", "text": f"invalid input: {e}"}], "isError": True}
            except FileNotFoundError as e:
                return {"content": [{"type": "text", "text": f"not found: {e}"}], "isError": True}
            except Exception as e:
                return {"content": [{"type": "text", "text": f"tool error: {e!r}"}], "isError": True}
    return {"content": [{"type": "text", "text": f"unknown tool: {name}"}], "isError": True}


mcp_app = Flask("motioncut_mcp")


@mcp_app.after_request
def _cors(resp):
    resp.headers["Access-Control-Allow-Origin"]  = "*"
    resp.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, mcp-session-id"
    return resp


@mcp_app.route("/mcp", methods=["GET"])
def mcp_get():
    return jsonify({
        "name":             SERVER_NAME,
        "version":          SERVER_VERSION,
        "protocolVersion":  PROTOCOL_VERSION,
        "transport":        "streamable-http",
        "endpoint":         "POST /mcp with JSON-RPC 2.0 body",
        "tools_count":      len(TOOLS),
    })


@mcp_app.route("/mcp", methods=["POST", "OPTIONS"])
def mcp_rpc():
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(force=True, silent=True) or {}
    method = body.get("method") or ""
    rid    = body.get("id")
    params = body.get("params") or {}

    if method == "initialize":
        return jsonify({
            "jsonrpc": "2.0", "id": rid,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities":    {"tools": {"listChanged": False}},
                "serverInfo":      {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        })

    if method == "tools/list":
        return jsonify({
            "jsonrpc": "2.0", "id": rid,
            "result": {"tools": _tools_list_response()},
        })

    if method == "tools/call":
        tname = params.get("name")
        targs = params.get("arguments") or {}
        return jsonify({
            "jsonrpc": "2.0", "id": rid,
            "result": _dispatch_tool(tname, targs),
        })

    if method.startswith("notifications/"):
        return ("", 204)

    if method == "ping":
        return jsonify({"jsonrpc": "2.0", "id": rid, "result": {}})

    return jsonify({
        "jsonrpc": "2.0", "id": rid,
        "error":   {"code": -32601, "message": f"method not found: {method}"},
    })


_thread = None
_server = None


def start_mcp_server(port=None, host=None):
    """Start the MCP server in a daemon thread. Returns True on success.
    Silently returns False if the port is already in use (e.g. second
    Werkzeug reloader process, or a gunicorn sibling worker)."""
    global _thread, _server
    if _thread and _thread.is_alive():
        return True
    try:
        _server = make_server(host or MCP_HOST, port or MCP_PORT, mcp_app, threaded=True)
    except OSError as e:
        print(f"[mcp] could not bind {host or MCP_HOST}:{port or MCP_PORT}: {e}", flush=True)
        return False
    _thread = threading.Thread(target=_server.serve_forever, daemon=True, name="mcp-server")
    _thread.start()
    return True


def claude_desktop_config_block():
    return {
        "mcpServers": {
            "motioncut": {
                "type": "http",
                "url":  f"http://{MCP_HOST}:{MCP_PORT}/mcp",
            }
        }
    }
