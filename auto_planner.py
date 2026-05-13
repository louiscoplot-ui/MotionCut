"""
MotionCut auto-planner — turns a list of clip analyses into an EditPlan
(segments + transitions + aspect) for the FFmpeg pipeline.

Pure functions: no side effects, no Flask, no FFmpeg. Input is the dict
list returned by app._analyze_or_cached() / app._analyze_clip_file().
Output is the shape expected by app.run_export_job() in multi-clip mode.

This module is intentionally simple — every style picks a duration target,
a per-segment length, an ordering heuristic, and a transition kind. The
caller can always fall back to generate_sequential_fallback() if anything
in the smart path raises.
"""

# Per-style target duration (seconds) when the user picks "Auto".
_STYLE_DEFAULTS = {
    "real_estate": 45,
    "social":      30,
    "cinematic":   60,
    "fast":        30,
}
# Per-style nominal segment length. Real estate breathes, social cuts fast.
_SEG_DUR = {
    "real_estate": 4.0,
    "social":      2.5,
    "cinematic":   5.0,
    "fast":        2.0,
}
# Crossfade overlap between adjacent segments (seconds).
_XFADE = 0.3
_MIN_SEG = 1.2
_TRIM_PAD = 0.25   # head/tail trim to avoid leading-black + bad first frames


def generate_edit_plan(analyses, style, duration_target, format_str):
    """Build a smart edit plan from analysed clips.

    Args
    ----
    analyses : list of dicts returned by _analyze_or_cached(). Required
               keys vary per clip but `filename` and `duration` are needed.
    style    : "real_estate" | "social" | "cinematic" | "fast"
    duration_target : int seconds, or None for the style default.
    format_str : "16:9" | "9:16" | "1:1"

    Returns
    -------
    { "segments": [...], "aspect": str, "total_duration": float }
    Each segment: { clipFilename, sourceIn, sourceOut, transition: {type, duration} }
    """
    total = duration_target or _STYLE_DEFAULTS.get(style, 30)
    aspect = format_str if format_str in ("16:9", "9:16", "1:1") else "16:9"
    seg_dur = _SEG_DUR.get(style, 3.0)

    # Keep only clips long enough to trim into.
    valid = [a for a in analyses if not a.get("error") and float(a.get("duration", 0)) > 1.0]
    if not valid:
        raise ValueError("No valid clips to assemble")

    # Style-specific ordering. The keys we read (shot_type, motion,
    # shot_score, duration) are all optional in the analysis dict — we
    # default safely when they're absent.
    if style == "real_estate":
        # Classic real-estate sequence: drone → exterior → interior → details.
        order = {"drone": 0, "exterior": 1, "interior": 2, "detail": 3, "unknown": 4}
        valid.sort(key=lambda c: (
            order.get(c.get("shot_type", "unknown"), 4),
            -float(c.get("shot_score", 0)),
        ))
    elif style == "cinematic":
        # Long, high-scoring clips first → builds the slow opening.
        valid.sort(key=lambda c: (
            -float(c.get("duration", 0)),
            -float(c.get("shot_score", 0)),
        ))
    elif style == "fast":
        # High motion → snappier energy.
        valid.sort(key=lambda c: -float(c.get("motion", 0)))
    # "social" keeps chronological input order.

    segments = []
    accumulated = 0.0
    idx = 0
    # Cycle through clips if we still need more time at the end of a pass.
    # Guard against infinite loops with a 3×len cap.
    cap = max(1, len(valid)) * 3
    while accumulated < total - 0.1 and idx < cap:
        clip = valid[idx % len(valid)]
        idx += 1
        clip_dur = float(clip.get("duration", 0))
        if clip_dur < 1.5:
            continue
        avail = clip_dur - 2 * _TRIM_PAD            # head + tail pad
        seg_len = min(seg_dur, avail, total - accumulated)
        if seg_len < _MIN_SEG:
            # Either avail shrunk or we're nearly at total — stop instead
            # of appending a sliver that looks like a glitch.
            break
        # Center the cut inside the available range so we pick the strongest
        # part of the clip (the bookends are often shaky / black frames).
        center_offset = max(0.0, (avail - seg_len) / 2.0)
        s_in  = round(_TRIM_PAD + center_offset, 3)
        s_out = round(s_in + seg_len, 3)
        # Transition between THIS segment and the NEXT one. Last clip gets
        # rewritten to fade_to_black after the loop.
        if style == "fast":
            trans = {"type": "cut", "duration": 0.0}
        elif style == "cinematic":
            trans = {"type": "crossfade", "duration": 0.5}
        else:
            trans = {"type": "crossfade", "duration": _XFADE}
        segments.append({
            "clipFilename": clip["filename"],
            "sourceIn":     s_in,
            "sourceOut":    s_out,
            "transition":   trans,
        })
        # Time accounting: crossfade overlaps eat back some of the duration.
        overlap = trans["duration"] if trans["type"] in ("crossfade", "fade_to_black") else 0.0
        accumulated += seg_len - overlap

    if not segments:
        raise ValueError("Could not build any segments")

    # Final segment gets a gentle fade-to-black so the export ends cleanly.
    segments[-1]["transition"] = {"type": "fade_to_black", "duration": 0.8}

    return {
        "segments":       segments,
        "aspect":         aspect,
        "total_duration": round(accumulated, 3),
    }


def generate_sequential_fallback(analyses, duration_target, format_str):
    """Last-resort plan when generate_edit_plan() raises.

    Walks every valid clip in input order, gives each an equal share of the
    target duration, hard cuts between them. No scoring, no reordering.
    Guarantees a working plan as long as at least one clip is decodable.
    """
    valid = [a for a in analyses if float(a.get("duration", 0)) > 1.0]
    total = duration_target or 30
    if not valid:
        return {
            "segments":       [],
            "aspect":         format_str if format_str in ("16:9", "9:16", "1:1") else "16:9",
            "total_duration": float(total),
        }
    share = total / len(valid)
    segments = []
    for clip in valid:
        d = min(share, float(clip["duration"]) - 2 * _TRIM_PAD)
        if d < 1.0:
            continue
        segments.append({
            "clipFilename": clip["filename"],
            "sourceIn":     _TRIM_PAD,
            "sourceOut":    round(_TRIM_PAD + d, 3),
            "transition":   {"type": "cut", "duration": 0.0},
        })
    if segments:
        segments[-1]["transition"] = {"type": "fade_to_black", "duration": 0.8}
    return {
        "segments":       segments,
        "aspect":         format_str if format_str in ("16:9", "9:16", "1:1") else "16:9",
        "total_duration": float(total),
    }
