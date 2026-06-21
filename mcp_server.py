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
import json
import os
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


def tool_trigger_export(format="mp4", resolution="1080p", project=None):
    return {
        "ok":      False,
        "stub":    True,
        "message": (
            "Server-side export trigger from MCP is not yet wired. "
            "POST /api/generate from the MCP host with the project filenames, "
            "or use the Export button in the UI at /edit."
        ),
        "hint": {
            "endpoint": "POST /api/generate",
            "body": {"project": project or get_active_project(),
                     "filenames": ["<from list_clips>"], "format": format},
        },
    }


def tool_get_export_status(job_id):
    job = motioncut_app.get_job(job_id)
    if not job:
        return {"job_id": job_id, "status": "unknown", "error": "no job with that id"}
    return {"job_id": job_id, **job}


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
        "description": "STUB: would trigger the FFmpeg export pipeline server-side. Currently returns instructions to use /api/generate or the UI Export button.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "format":     {"type": "string"},
                "resolution": {"type": "string"},
                "project":    {"type": "string"},
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
                text = json.dumps(result, default=str, ensure_ascii=False, indent=2)
                return {"content": [{"type": "text", "text": text}]}
            except TypeError as e:
                return {"content": [{"type": "text", "text": f"invalid arguments: {e}"}], "isError": True}
            except ValueError as e:
                return {"content": [{"type": "text", "text": f"invalid input: {e}"}], "isError": True}
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
