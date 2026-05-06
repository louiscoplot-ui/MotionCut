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
import threading
import subprocess
from pathlib import Path
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
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "ffmpeg": ffmpeg_available()})


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

    fid = uuid.uuid4().hex[:12]
    fname = f"{fid}_{safe_name(f.filename)}"
    out_path = UPLOAD_DIR / fname
    f.save(str(out_path))

    duration = probe_duration(out_path) if kind in ("video", "audio") else 0.0

    return jsonify({
        "ok": True,
        "id": fid,
        "filename": fname,
        "kind": kind,
        "url": url_for("serve_upload", filename=fname),
        "duration": duration,
        "size": out_path.stat().st_size,
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

    fid = uuid.uuid4().hex[:12]
    fname = f"{fid}_{safe_name(filename)}"
    out_path = UPLOAD_DIR / fname
    shutil.move(str(part_path), str(out_path))

    duration = probe_duration(out_path) if kind in ("video", "audio") else 0.0

    return jsonify({
        "ok": True,
        "id": fid,
        "filename": fname,
        "kind": kind,
        "url": url_for("serve_upload", filename=fname),
        "duration": duration,
        "size": out_path.stat().st_size,
    })


@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(str(UPLOAD_DIR), filename, conditional=True)


@app.route("/exports/<path:filename>")
def serve_export(filename):
    return send_from_directory(str(EXPORT_DIR), filename, conditional=True, as_attachment=True)


# ----------------------------------------------------------------------------
# Export pipeline
# ----------------------------------------------------------------------------
def build_filter_complex(payload, target_w, target_h, duration):
    """
    Build an FFmpeg -filter_complex graph from JSON payload.
    Inputs:
        [0:v] = source video
        [1:v]..[N:v] = uploaded PNG/JPG overlays (optional)
    Returns (filter_str, audio_filter_str_or_None, label_video_out, label_audio_out)
    """
    layers = payload.get("layers", [])
    grade = payload.get("colorGrade", "natural")
    vignette = bool(payload.get("vignette"))
    grain = bool(payload.get("filmGrain"))

    parts = []

    # 1) Scale + pad source to target canvas, then color grade.
    parts.append(
        f"[0:v]scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
        f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:color=black,"
        f"setsar=1,{color_grade_filter(grade)}[base]"
    )

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

    # 4) Image / logo overlays. Image inputs occupy [1:v], [2:v], ...
    img_layers = [l for l in layers if l.get("type") in ("logo", "image")]
    for idx, layer in enumerate(img_layers, start=1):
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
            f"x={x_expr}:y={y_expr}:"
            f"alpha='{alpha_expr}':"
            f"borderw=2:bordercolor=black@0.6:"
            f"enable='between(t,{start},{end})'"
        )
        # Only add :font= if user passed something simple (no path) - drawtext font requires fontconfig.
        # Use Windows font file if available.
        win_font = r"C\\:/Windows/Fonts/arial.ttf"
        draw += f":fontfile='{win_font}'"

        parts.append(f"{cur}{draw}{nxt}")
        cur = nxt

    # Final label
    parts.append(f"{cur}null[outv]")

    return ";".join(parts), "[outv]"


def run_export_job(job_id, payload, src_video, image_paths, audio_path, out_path,
                   target_w, target_h, duration):
    # In/Out marks for trimming the source video
    in_mark  = payload.get("inMark")
    out_mark = payload.get("outMark")
    cmd = [FFMPEG, "-y"]
    if isinstance(in_mark, (int, float)) and in_mark > 0:
        cmd += ["-ss", f"{float(in_mark):.3f}"]
    if isinstance(out_mark, (int, float)) and out_mark > (in_mark or 0):
        cmd += ["-to", f"{float(out_mark):.3f}"]
    cmd += ["-i", str(src_video)]
    for p in image_paths:
        cmd += ["-i", str(p)]
    if audio_path:
        cmd += ["-i", str(audio_path)]

    fc, vlabel = build_filter_complex(payload, target_w, target_h, duration)

    audio_idx = 1 + len(image_paths)
    has_extra_audio = audio_path is not None

    if has_extra_audio:
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
        full_filter = fc + ";" + audio_filter
    else:
        full_filter = fc
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
        set_job(
            job_id,
            status="done",
            progress=100,
            output=out_path.name,
            url=url_for("serve_export", filename=out_path.name),
        )
    except FileNotFoundError:
        set_job(job_id, status="error",
                error="FFmpeg not found. Install with: winget install FFmpeg")
    except Exception as e:
        set_job(job_id, status="error", error=str(e))


@app.route("/api/export", methods=["POST"])
def api_export():
    data = request.get_json(force=True, silent=True) or {}
    src = data.get("video")
    if not src:
        return jsonify({"error": "missing video"}), 400
    src_path = UPLOAD_DIR / safe_name(src)
    if not src_path.exists():
        return jsonify({"error": f"source video not found: {src}"}), 404

    aspect = data.get("aspect", "16:9")
    if aspect == "16:9":
        target_w, target_h = 1920, 1080
    elif aspect == "9:16":
        target_w, target_h = 1080, 1920
    else:
        target_w, target_h = 1920, 1080

    image_paths = []
    for layer in data.get("layers", []):
        if layer.get("type") in ("logo", "image"):
            fname = layer.get("src")
            if fname:
                p = UPLOAD_DIR / safe_name(fname)
                if p.exists():
                    image_paths.append(p)

    audio_path = None
    if data.get("audio"):
        ap = UPLOAD_DIR / safe_name(data["audio"])
        if ap.exists():
            audio_path = ap

    full_duration = probe_duration(src_path)
    in_mark  = data.get("inMark")  or 0
    out_mark = data.get("outMark") or full_duration
    duration = max(0.1, float(out_mark) - float(in_mark))
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
        daemon=True,
    )
    t.start()

    return jsonify({"ok": True, "jobId": job_id, "output": out_name})


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
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
