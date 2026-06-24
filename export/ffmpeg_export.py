"""
CORE-2 — standalone FFmpeg multi-clip export.

build_export_command() turns an ordered list of trimmed segments into a
single FFmpeg invocation: each clip is fast-seeked (-ss/-to before -i),
scaled+padded to the target canvas, given a real or synthesised audio
stream, then concatenated. The runner spawns FFmpeg in a daemon thread and
parses stderr for live progress.

Decoupled from app.py on purpose (see export/__init__.py). The only shared
contract is the job dict shape, which mirrors app.py's JOBS so the frontend
poller can read either.
"""
import os
import re
import shutil
import subprocess
import threading
import time
import uuid

RESOLUTIONS = {
    "1080p":    (1920, 1080),
    "720p":     (1280, 720),
    # 'original' has no single target; concat still needs a uniform canvas,
    # so we fall back to 1080p as the canonical size. Documented simplification.
    "original": (1920, 1080),
}

FPS = 30


def find_ffmpeg():
    return shutil.which("ffmpeg") or os.environ.get("FFMPEG_BIN") or "ffmpeg"


def find_ffprobe():
    return shutil.which("ffprobe") or os.environ.get("FFPROBE_BIN") or "ffprobe"


def _seg_duration(seg):
    try:
        d = float(seg.get("sourceOut", 0)) - float(seg.get("sourceIn", 0))
    except (TypeError, ValueError):
        d = 0.0
    return max(0.05, d)


def build_export_command(segments, resolution, output_path,
                         fps=FPS, crf=23, preset="fast"):
    """Return the full FFmpeg argv for an ordered, trimmed, concatenated render.

    segments: [{path, sourceIn, sourceOut, has_audio}], in timeline order.
    resolution: '1080p' | '720p' | 'original'.

    Muted clips get a synthesised silent track (aevalsrc) so the audio
    concat stays balanced — concat=a=1 requires every segment to carry one
    audio stream.
    """
    if not segments:
        raise ValueError("no segments to export")
    w, h = RESOLUTIONS.get(resolution, RESOLUTIONS["1080p"])
    ff = find_ffmpeg()

    cmd = [ff, "-y"]
    for seg in segments:
        si = max(0.0, float(seg.get("sourceIn", 0)))
        so = float(seg.get("sourceOut", si + 1))
        cmd += ["-ss", f"{si:.3f}", "-to", f"{so:.3f}", "-i", str(seg["path"])]

    parts = []
    concat_inputs = []
    for i, seg in enumerate(segments):
        parts.append(
            f"[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps},format=yuv420p[v{i}]"
        )
        if seg.get("has_audio", True):
            parts.append(f"[{i}:a]aresample=async=1:first_pts=0[a{i}]")
        else:
            dur = _seg_duration(seg)
            parts.append(f"aevalsrc=0:s=44100:d={dur:.3f}[a{i}]")
        concat_inputs.append(f"[v{i}][a{i}]")

    n = len(segments)
    parts.append("".join(concat_inputs) + f"concat=n={n}:v=1:a=1[v][a]")
    filter_complex = ";".join(parts)

    cmd += [
        "-filter_complex", filter_complex,
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(output_path),
    ]
    return cmd


def total_duration(segments):
    return sum(_seg_duration(s) for s in segments)


# ---- job runner -------------------------------------------------------------

_JOBS = {}
_JOBS_LOCK = threading.Lock()
_ACTIVE = threading.Lock()        # enforces max 1 concurrent export

_TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+\.?\d*)")


def get_job(job_id):
    with _JOBS_LOCK:
        j = _JOBS.get(job_id)
        return dict(j) if j else None


def _set_job(job_id, **fields):
    with _JOBS_LOCK:
        _JOBS.setdefault(job_id, {})["job_id"] = job_id
        _JOBS[job_id].update(fields)


def is_busy():
    locked = _ACTIVE.acquire(blocking=False)
    if locked:
        _ACTIVE.release()
        return False
    return True


def start_export(segments, resolution, output_path):
    """Spawn an export in a daemon thread. Returns (job_id, estimated_s).
    Raises RuntimeError('busy') if an export is already running, or
    RuntimeError('ffmpeg-missing') if FFmpeg is not installed."""
    if not shutil.which(find_ffmpeg()) and not os.path.isfile(find_ffmpeg()):
        raise RuntimeError("ffmpeg-missing")
    if is_busy():
        raise RuntimeError("busy")

    job_id = uuid.uuid4().hex[:12]
    dur = total_duration(segments)
    _set_job(job_id, status="processing", progress_pct=0,
             output_path=None, error=None, attempts=1)
    t = threading.Thread(
        target=_run, args=(job_id, segments, resolution, str(output_path), dur),
        daemon=True,
    )
    t.start()
    # Rough estimate: ~0.4x realtime encode on a modest box, floor 5s.
    return job_id, max(5, int(dur * 0.4))


def _run(job_id, segments, resolution, output_path, dur):
    if not _ACTIVE.acquire(blocking=False):
        _set_job(job_id, status="error", error="another export is running")
        return
    try:
        cmd = build_export_command(segments, resolution, output_path)
        _set_job(job_id, cmd=" ".join(cmd))
        proc = subprocess.Popen(cmd, stderr=subprocess.PIPE,
                                stdout=subprocess.DEVNULL, text=True)
        for line in proc.stderr:
            m = _TIME_RE.search(line)
            if m and dur > 0:
                hh, mm, ss = m.groups()
                t = int(hh) * 3600 + int(mm) * 60 + float(ss)
                pct = max(0, min(99, int(t / dur * 100)))
                _set_job(job_id, progress_pct=pct)
        rc = proc.wait()
        if rc == 0 and os.path.isfile(output_path):
            _set_job(job_id, status="done", progress_pct=100,
                     output_path=output_path)
        else:
            _set_job(job_id, status="error",
                     error=f"ffmpeg exited {rc}")
    except FileNotFoundError:
        _set_job(job_id, status="error", error="FFmpeg not installed")
    except Exception as e:
        _set_job(job_id, status="error", error=str(e))
    finally:
        _ACTIVE.release()
