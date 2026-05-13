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
    "real_estate": 5.0,
    "social":      2.5,
    "cinematic":   5.0,
    "fast":        2.0,
}
# Crossfade overlap between adjacent segments (seconds).
_XFADE = 0.5
_MIN_SEG = 1.2
# Drone footage takes off / lands at the bookends — skip the first and
# last 10% of every clip (with a 0.25s floor for tiny clips).
_EDGE_TRIM_PCT = 0.10
_TRIM_PAD = 0.25
# Final segment fade-to-black duration.
_END_FADE = 1.2


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
        # Sprint 6: when shot_type is "unknown" (the analyzer's default), use
        # has_face as a secondary cue — faces almost never appear in
        # drone/exterior frames, so a face-positive clip is much more likely
        # to belong to the interior/detail half of the reel.
        order = {"drone": 0, "exterior": 1, "interior": 2, "detail": 3, "unknown": 4}
        def _re_key(c):
            shot = c.get("shot_type", "unknown")
            primary = order.get(shot, 4)
            # Faces push unknown clips down towards the interior bucket.
            if shot == "unknown" and c.get("has_face"):
                primary = 2.5
            return (primary, -float(c.get("shot_score", 0)))
        valid.sort(key=_re_key)
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

    def _trans_for(s):
        if s == "fast":
            return {"type": "cut", "duration": 0.0}
        return {"type": "crossfade", "duration": _XFADE}

    def _clip_window(clip_dur):
        """Return (s_in_base, s_out_max) skipping bookend 10% (drone trim)."""
        head = max(clip_dur * _EDGE_TRIM_PCT, _TRIM_PAD)
        tail_cap = clip_dur * (1.0 - _EDGE_TRIM_PCT)
        return head, tail_cap

    segments = []

    # Single-clip mode: split the clip into 3 overlapping windows so we
    # still get the multi-cut feel instead of a single long shot.
    if len(valid) == 1:
        clip = valid[0]
        clip_dur = float(clip.get("duration", 0))
        windows = [(0.10, 0.40), (0.35, 0.65), (0.60, 0.90)]
        for (a, b) in windows:
            s_in = round(clip_dur * a, 3)
            s_out = round(clip_dur * b, 3)
            if s_out - s_in < _MIN_SEG:
                continue
            segments.append({
                "clipFilename": clip["filename"],
                "sourceIn":     s_in,
                "sourceOut":    s_out,
                "transition":   _trans_for(style),
            })
    else:
        # Multi-clip mode: each clip used at most once. Stop once we've
        # filled the requested duration; if we run out of clips first, the
        # plan reports the actual accumulated length (no looping).
        running = 0.0
        for clip in valid:
            if running >= total - 0.1:
                break
            clip_dur = float(clip.get("duration", 0))
            if clip_dur < 1.5:
                continue
            head, tail_cap = _clip_window(clip_dur)
            avail = tail_cap - head
            if avail < _MIN_SEG:
                continue
            seg_len = min(seg_dur, avail)
            s_in = round(head, 3)
            s_out = round(min(s_in + seg_len, tail_cap), 3)
            segments.append({
                "clipFilename": clip["filename"],
                "sourceIn":     s_in,
                "sourceOut":    s_out,
                "transition":   _trans_for(style),
            })
            running += (s_out - s_in) - _XFADE

    if not segments:
        raise ValueError("Could not build any segments")

    # Recompute total duration accounting for crossfade overlaps.
    accumulated = 0.0
    for i, s in enumerate(segments):
        accumulated += float(s["sourceOut"]) - float(s["sourceIn"])
        if i > 0:
            prev = segments[i - 1]
            t = prev.get("transition") or {}
            if t.get("type") in ("crossfade", "fade_to_black"):
                accumulated -= float(t.get("duration") or 0.0)

    # Final segment gets a longer fade-to-black so the export ends cleanly.
    segments[-1]["transition"] = {"type": "fade_to_black", "duration": _END_FADE}

    return {
        "segments":       segments,
        "aspect":         aspect,
        "total_duration": round(max(0.0, accumulated), 3),
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
