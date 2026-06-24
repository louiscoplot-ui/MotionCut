"""
LOOP-2 — export-with-verification loop.

Renders via the CORE-2 builder, probes the result, and re-encodes up to 3
times if it misses the tier's quality target. Shares ffmpeg_export's job
store (so /api/export/status is unchanged) and its single-concurrency lock.
After success, intermediate _v*.mp4 files are removed. After 3 failed
attempts the last file is returned with a quality_warning (download is never
blocked). When ffprobe is absent the check is skipped and the first render
is accepted.
"""
import glob
import os
import subprocess
import threading
import uuid

from . import ffmpeg_export as fx
from . import quality_checker
from . import recovery_encoder


def _target_for(resolution, cfg):
    w, h = fx.RESOLUTIONS.get(resolution, fx.RESOLUTIONS["1080p"])
    default_br = {"1080p": 8000, "720p": 5000, "original": 6000}.get(resolution, 6000)
    cfg = cfg or {}
    return {
        "width":        w,
        "height":       h,
        "bitrate_kbps": int(cfg.get("bitrate_kbps", default_br)),
        "codec":        cfg.get("codec", "h264"),
    }


def start_export_with_verification(segments, resolution, out_path, export_cfg=None):
    """Spawn the verified export. Returns (job_id, estimated_s).
    Raises RuntimeError('busy') / RuntimeError('ffmpeg-missing')."""
    ff = fx.find_ffmpeg()
    if not (os.path.isfile(ff) or _on_path(ff)):
        raise RuntimeError("ffmpeg-missing")
    if fx.is_busy():
        raise RuntimeError("busy")

    job_id = uuid.uuid4().hex[:12]
    dur = fx.total_duration(segments)
    fx._set_job(job_id, status="processing", progress_pct=0,
                output_path=None, attempts=0, error=None)
    target = _target_for(resolution, export_cfg)
    t = threading.Thread(
        target=_loop,
        args=(job_id, segments, resolution, str(out_path), dur, target),
        daemon=True)
    t.start()
    return job_id, max(5, int(dur * 0.4) * 3)


def _on_path(name):
    import shutil
    return bool(shutil.which(name))


def _run_ffmpeg(job_id, cmd, dur):
    proc = subprocess.Popen(cmd, stderr=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, text=True)
    for line in proc.stderr:
        m = fx._TIME_RE.search(line)
        if m and dur > 0:
            hh, mm, ss = m.groups()
            t = int(hh) * 3600 + int(mm) * 60 + float(ss)
            fx._set_job(job_id, progress_pct=max(0, min(99, int(t / dur * 100))))
    return proc.wait()


def _cleanup(base_out, keep):
    stem = base_out[:-4] if base_out.endswith(".mp4") else base_out
    for p in glob.glob(stem + "_v*.mp4"):
        if os.path.abspath(p) != os.path.abspath(keep):
            try: os.remove(p)
            except OSError: pass
    if os.path.abspath(base_out) != os.path.abspath(keep) and os.path.isfile(base_out):
        try: os.remove(base_out)
        except OSError: pass


def _loop(job_id, segments, resolution, out_path, dur, target):
    if not fx._ACTIVE.acquire(blocking=False):
        fx._set_job(job_id, status="error", error="another export is running")
        return
    current = out_path
    result = None
    try:
        for attempt in range(1, 4):
            fx._set_job(job_id, attempts=attempt, progress_pct=0, status="processing")
            cmd = fx.build_export_command(segments, resolution, current)
            rc = _run_ffmpeg(job_id, cmd, dur)
            if rc != 0 or not os.path.isfile(current):
                fx._set_job(job_id, status="error", error=f"ffmpeg exited {rc}")
                return

            result = quality_checker.check_export_quality(current, target)
            fx._set_job(job_id, quality_check=result)

            if result["status"] in ("OK", "SKIP"):
                _cleanup(out_path, current)
                fx._set_job(job_id, status="done", progress_pct=100,
                            output_path=current,
                            quality_metrics=result.get("metrics"))
                return

            if attempt < 3:
                current = recovery_encoder.re_encode(
                    current, result["issues"], target, attempt)

        # 3 attempts exhausted — ship the last file with a warning.
        _cleanup(out_path, current)
        fx._set_job(job_id, status="done", progress_pct=100,
                    output_path=current,
                    quality_warning="Quality targets not met after 3 attempts",
                    quality_metrics=(result.get("metrics") if result else None))
    except Exception as e:
        fx._set_job(job_id, status="error", error=str(e))
    finally:
        fx._ACTIVE.release()
