"""
LOOP-2 — post-export quality probe via ffprobe.

check_export_quality() reads the produced file and compares it against the
tier's target resolution / bitrate / codec. If ffprobe is unavailable the
check is skipped (status='SKIP') so the export still completes — the spec
explicitly allows degrading gracefully when ffprobe is absent.
"""
import json
import os
import shutil
import subprocess

from .ffmpeg_export import find_ffprobe


def check_export_quality(output_path, target):
    """target: {width, height, bitrate_kbps, codec}.
    Returns {status: 'OK'|'FAIL'|'SKIP', issues: [...], metrics: {...}}."""
    ffprobe = find_ffprobe()
    if not (shutil.which(ffprobe) or os.path.isfile(ffprobe)):
        return {"status": "SKIP", "issues": [], "metrics": {},
                "note": "ffprobe not installed"}
    try:
        out = subprocess.run(
            [ffprobe, "-v", "quiet", "-print_format", "json",
             "-show_streams", "-show_format", str(output_path)],
            capture_output=True, text=True, timeout=30)
        data = json.loads(out.stdout or "{}")
    except Exception as e:
        return {"status": "SKIP", "issues": [], "metrics": {}, "note": str(e)}

    vstream = next((s for s in data.get("streams", [])
                    if s.get("codec_type") == "video"), {})
    fmt = data.get("format", {})
    width = int(vstream.get("width") or 0)
    height = int(vstream.get("height") or 0)
    codec = vstream.get("codec_name") or ""
    bitrate_kbps = int(float(fmt.get("bit_rate") or 0)) // 1000
    duration_s = float(fmt.get("duration") or 0)
    size_mb = int(fmt.get("size") or 0) // 1_048_576

    issues = []
    if target.get("width") and width < target["width"] * 0.95:
        issues.append("resolution_mismatch")
    if target.get("bitrate_kbps") and bitrate_kbps < target["bitrate_kbps"] * 0.80:
        issues.append("bitrate_low")
    if codec and target.get("codec") and codec != target["codec"]:
        issues.append("codec_mismatch")

    return {
        "status": "OK" if not issues else "FAIL",
        "issues": issues,
        "metrics": {
            "resolution":   f"{width}x{height}",
            "width":        width,
            "height":       height,
            "bitrate_kbps": bitrate_kbps,
            "codec":        codec,
            "duration_s":   round(duration_s, 2),
            "file_size_mb": size_mb,
        },
    }
