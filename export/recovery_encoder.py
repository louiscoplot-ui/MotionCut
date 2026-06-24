"""
LOOP-2 — corrective re-encode for failed quality checks.

re_encode() builds an FFmpeg command targeting the specific issues found by
quality_checker (resolution / bitrate / codec) and writes a new
_v{attempt}.mp4 next to the input.
"""
import os
import subprocess

from .ffmpeg_export import find_ffmpeg


def re_encode(input_path, issues, target, attempt):
    ff = find_ffmpeg()
    out = input_path[:-4] + f"_v{attempt}.mp4" if input_path.endswith(".mp4") \
        else input_path + f"_v{attempt}.mp4"

    cmd = [ff, "-y", "-i", str(input_path)]

    if "resolution_mismatch" in issues:
        w, h = target["width"], target["height"]
        cmd += ["-vf",
                f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"]

    if "bitrate_low" in issues:
        kb = int(target["bitrate_kbps"])
        cmd += ["-b:v", f"{kb}k",
                "-maxrate", f"{int(kb * 1.5)}k",
                "-bufsize", f"{kb * 2}k"]

    # Always re-encode video to h264 (covers codec_mismatch and is required
    # whenever we change scale/bitrate). Audio copied to AAC.
    cmd += ["-c:v", "libx264", "-preset", "fast",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart", str(out)]

    try:
        subprocess.run(cmd, capture_output=True, timeout=900)
    except Exception:
        return input_path
    return out if os.path.isfile(out) else input_path
