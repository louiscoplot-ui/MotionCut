"""
MotionCut auto-planner — turns a list of clip analyses into an EditPlan
(segments + transitions + aspect) for the FFmpeg pipeline.

Pure-Python, no external API. Every signal comes from `_analyze_clip_file()`
in app.py: duration, shot_score, motion, sharpness, brightness, has_face,
shot_type (when set by the client or vision step).

The real_estate path follows a three-act structure:

    Act 1 — Hook (~20% of total)   strongest opening clip
    Act 2 — Tour (~60% of total)   exterior → interior → details, ordered
                                   by shot_score within each bucket
    Act 3 — Close (~20% of total)  memorable closer + fade-to-black

Other styles share the per-clip heuristics (drone-bookend trim, motion-aware
segment length, brightness/sharpness penalties) but pick their own ordering
and transitions.

Each clip is used at most once; the closer is allowed to revisit the opener
on a different time window when there aren't enough distinct clips to fill
the three acts.
"""

# Per-style target duration (seconds) when the user picks "Auto".
_STYLE_DEFAULTS = {
    "real_estate": 45,
    "social":      30,
    "cinematic":   60,
    "fast":        30,
}

# Edge trim — drones take off / land at the bookends.
_EDGE_TRIM_PCT = 0.12
_TRIM_PAD = 0.5

# Segment length hard limits.
_MIN_SEG = 3.5
_MAX_SEG = 8.0

# Final fade-to-black duration.
_END_FADE = 1.2

# Shot-type buckets used for narrative ordering. Anything not in the map
# lands in `_OTHER_BUCKET` and is placed mid-tour. The richer vocabulary
# (drone_wide, interior_living, …) collapses to the same buckets so the
# planner doesn't need to relearn it.
_SHOT_BUCKETS = {
    # Openers
    "drone":         "drone",
    "drone_wide":    "drone",
    "drone_reveal":  "drone",
    # Exteriors
    "exterior":      "exterior",
    "street":        "exterior",
    "garden":        "exterior",
    "pool":          "exterior",
    # Interiors (one bucket — narrative ordering is then by shot_score)
    "interior":             "interior",
    "interior_living":      "interior",
    "interior_kitchen":     "interior",
    "interior_bedroom":     "interior",
    "interior_bathroom":    "interior",
    # Details / people
    "detail":  "detail",
    "agent":   "detail",
}
_OTHER_BUCKET = "interior"  # safest default for unlabelled clips


def _clip_window(clip_dur):
    """Return (s_in_floor, s_out_ceiling) skipping bookend 12% (drone trim)."""
    head = max(clip_dur * _EDGE_TRIM_PCT, _TRIM_PAD)
    tail = clip_dur * (1.0 - _EDGE_TRIM_PCT)
    return head, tail


def _segment_length(motion, base=None):
    """Motion-aware segment length. High motion → snappier cuts.

    motion ∈ [0,1]; 1.0 → ~4s, 0.0 → ~7s. Clamped to [_MIN_SEG, _MAX_SEG].
    `base` is an optional override (e.g. cinematic uses longer segments)."""
    if base is not None:
        return max(_MIN_SEG, min(_MAX_SEG, float(base)))
    seg = 7.0 - (float(motion or 0.0) * 3.0)
    return max(_MIN_SEG, min(_MAX_SEG, seg))


def _adjusted_score(clip):
    """Apply brightness / sharpness penalties so bad clips fall down the rank."""
    score = float(clip.get("shot_score") or 0.0)
    if float(clip.get("brightness") or 0.5) < 0.3:
        score *= 0.5
    if float(clip.get("sharpness") or 0.5) < 0.3:
        score *= 0.4
    return score


def _bucket(clip):
    return _SHOT_BUCKETS.get((clip.get("shot_type") or "").lower(), _OTHER_BUCKET)


def _build_segment(clip, seg_dur, position=None, min_seg=_MIN_SEG):
    """Cut a single segment from `clip` of length ~`seg_dur`.

    `position` ∈ {None, 'opening', 'closer'}: opening uses the early third,
    closer uses the late third, anything else centres in the available
    window. `min_seg` lets social/fast styles drop below the default 3.5s
    floor for snappier cuts. Returns a segment dict, or None if the clip
    is too short."""
    clip_dur = float(clip.get("duration") or 0.0)
    if clip_dur < min_seg + 0.5:
        return None
    head, tail = _clip_window(clip_dur)
    avail = tail - head
    seg_len = max(min_seg, min(seg_dur, avail))
    if seg_len < min_seg:
        return None
    if position == "opening":
        s_in = head + max(0.0, (avail - seg_len) * 0.20)
    elif position == "closer":
        s_in = head + max(0.0, (avail - seg_len) * 0.75)
    else:
        s_in = head + max(0.0, (avail - seg_len) * 0.5)
    s_out = min(s_in + seg_len, tail)
    if s_out - s_in < min_seg:
        return None
    return {
        "clipFilename": clip["filename"],
        "sourceIn":     round(s_in, 3),
        "sourceOut":    round(s_out, 3),
        "transition":   {"type": "crossfade", "duration": 0.4},
    }


def _avoid_consecutive(segments, clips_by_filename):
    """Reorder pairwise to avoid back-to-back identical shot_type when
    swapping with the next slot doesn't break the narrative arc."""
    for i in range(len(segments) - 1):
        a = clips_by_filename.get(segments[i]["clipFilename"], {})
        b = clips_by_filename.get(segments[i + 1]["clipFilename"], {})
        if _bucket(a) != _bucket(b):
            continue
        # Look ahead for a different bucket to swap in.
        for j in range(i + 2, len(segments)):
            c = clips_by_filename.get(segments[j]["clipFilename"], {})
            if _bucket(c) != _bucket(a):
                segments[i + 1], segments[j] = segments[j], segments[i + 1]
                break
    return segments


def _build_real_estate(valid, total, brief_hints):
    """3-act narrative: hook → tour → close.

    Each clip is used at most once. If we run out of distinct clips for the
    closer, the opener is revisited on a different time window."""
    by_filename = {c["filename"]: c for c in valid}
    if not valid:
        return []

    # Bucket every clip; rank within bucket by adjusted score.
    buckets = {"drone": [], "exterior": [], "interior": [], "detail": []}
    for c in valid:
        buckets[_bucket(c)].append(c)
    for k in buckets:
        buckets[k].sort(key=_adjusted_score, reverse=True)

    # Hook — first non-empty bucket in (drone, exterior, interior, detail).
    hook_clip = None
    for k in ("drone", "exterior", "interior", "detail"):
        if buckets[k]:
            hook_clip = buckets[k][0]
            buckets[k] = buckets[k][1:]
            break
    if hook_clip is None:
        hook_clip = max(valid, key=_adjusted_score)

    used = {hook_clip["filename"]}
    seg_dur_hook = _segment_length(hook_clip.get("motion"), base=5.5)
    if brief_hints.get("calm"):
        seg_dur_hook = min(_MAX_SEG, seg_dur_hook + 1.5)
    hook_seg = _build_segment(hook_clip, seg_dur_hook, position="opening")
    if not hook_seg:
        return []

    # Tour — interleave remaining clips in narrative order, alternating
    # buckets when possible so adjacent shots feel varied.
    tour_clips = []
    if brief_hints.get("family"):
        # Push face-positive clips up — viewers parse "family" as people-in-home.
        for k in ("interior", "exterior", "detail"):
            buckets[k].sort(key=lambda c: (not bool(c.get("has_face")),
                                           -_adjusted_score(c)))
    order = ["exterior", "interior", "interior", "detail", "interior", "exterior"]
    bucket_idx = {k: 0 for k in buckets}
    for k in order:
        if bucket_idx[k] < len(buckets[k]):
            c = buckets[k][bucket_idx[k]]
            bucket_idx[k] += 1
            if c["filename"] not in used:
                tour_clips.append(c)
                used.add(c["filename"])
    # Append any remaining clips not yet placed (preserves coverage).
    for k in ("drone", "exterior", "interior", "detail"):
        for c in buckets[k][bucket_idx[k]:]:
            if c["filename"] not in used:
                tour_clips.append(c)
                used.add(c["filename"])

    # Closer — strongest unused clip, otherwise revisit the opener on a
    # different time window.
    closer_clip = None
    unused = [c for c in valid if c["filename"] not in used]
    if unused:
        closer_clip = max(unused, key=_adjusted_score)
        used.add(closer_clip["filename"])

    # Build segments. Tour gets ~60% of the budget; segment length adapts
    # to motion, but we still cap total_tour ≤ total*0.65 so the closer
    # gets its 20%.
    hook_seg["transition"] = {"type": "crossfade", "duration": 0.5}
    segments = [hook_seg]
    running = (hook_seg["sourceOut"] - hook_seg["sourceIn"]) - 0.5

    tour_budget = max(0.0, total * 0.65)
    for c in tour_clips:
        if running >= total * 0.80:
            break
        seg_dur = _segment_length(c.get("motion"))
        if brief_hints.get("calm"):
            seg_dur = min(_MAX_SEG, seg_dur + 1.5)
        if running - hook_seg["sourceOut"] + hook_seg["sourceIn"] > tour_budget:
            seg_dur = max(_MIN_SEG, seg_dur - 1.0)
        seg = _build_segment(c, seg_dur)
        if not seg:
            continue
        seg["transition"] = {"type": "crossfade", "duration": 0.4}
        segments.append(seg)
        running += (seg["sourceOut"] - seg["sourceIn"]) - 0.4

    # Closer — either a new clip or a second window into the hook clip.
    if closer_clip is None:
        # Re-cut the opener on its closing third.
        closer_clip = hook_clip
        closer_seg = _build_segment(closer_clip, 4.5, position="closer")
        if closer_seg and closer_seg["sourceIn"] <= hook_seg["sourceOut"]:
            # Push past the opener's window so we don't repeat the same frames.
            closer_seg = None
    else:
        closer_seg = _build_segment(closer_clip, 4.5, position="closer")

    if closer_seg:
        closer_seg["transition"] = {"type": "fade_to_black", "duration": _END_FADE}
        segments.append(closer_seg)
    else:
        segments[-1]["transition"] = {"type": "fade_to_black", "duration": _END_FADE}

    return _avoid_consecutive(segments, by_filename)


def _build_social(valid, total, brief_hints):
    """Hook immediately; fast cuts; mostly hard cuts. 2-3s per segment."""
    if not valid:
        return []
    ranked = sorted(valid, key=lambda c: -float(c.get("motion") or 0.0))
    segments = []
    running = 0.0
    for c in ranked:
        if running >= total - 0.5:
            break
        seg = _build_segment(c, 2.5, min_seg=2.0)
        if not seg:
            continue
        seg["transition"] = {"type": "cut", "duration": 0.0}
        segments.append(seg)
        running += (seg["sourceOut"] - seg["sourceIn"])
    if segments:
        segments[-1]["transition"] = {"type": "fade_to_black", "duration": 0.8}
    return segments


def _build_cinematic(valid, total, brief_hints):
    """Long, slow segments. Open with the strongest, fade between."""
    if not valid:
        return []
    ranked = sorted(valid, key=lambda c: (
        -float(c.get("duration") or 0.0),
        -_adjusted_score(c),
    ))
    segments = []
    running = 0.0
    for idx, c in enumerate(ranked):
        if running >= total - 1.0:
            break
        seg_dur = _segment_length(c.get("motion"), base=8.0)
        seg = _build_segment(c, seg_dur,
                             position="opening" if idx == 0 else None)
        if not seg:
            continue
        seg["transition"] = {"type": "crossfade", "duration": 0.8}
        segments.append(seg)
        running += (seg["sourceOut"] - seg["sourceIn"]) - 0.8
    if segments:
        segments[-1]["transition"] = {"type": "fade_to_black", "duration": 1.5}
    return segments


def _build_fast(valid, total, brief_hints):
    """Every clip, short windows, hard cuts. Motion first. 1.5-2.5s."""
    if not valid:
        return []
    ranked = sorted(valid, key=lambda c: -float(c.get("motion") or 0.0))
    segments = []
    running = 0.0
    for c in ranked:
        if running >= total - 0.5:
            break
        seg = _build_segment(c, 2.0, min_seg=1.5)
        if not seg:
            continue
        seg["transition"] = {"type": "cut", "duration": 0.0}
        segments.append(seg)
        running += (seg["sourceOut"] - seg["sourceIn"])
    if segments:
        segments[-1]["transition"] = {"type": "fade_to_black", "duration": 0.6}
    return segments


def _single_clip_split(clip, style):
    """If only one clip is available, slice it into 3 windows so the result
    still feels edited rather than a flat take."""
    dur = float(clip.get("duration") or 0.0)
    if dur < _MIN_SEG * 3:
        return []
    windows = [(0.10, 0.40), (0.35, 0.65), (0.60, 0.90)]
    trans = ({"type": "cut", "duration": 0.0}
             if style == "fast"
             else {"type": "crossfade", "duration": 0.5})
    segments = []
    for a, b in windows:
        s_in = round(dur * a, 3)
        s_out = round(dur * b, 3)
        if s_out - s_in < _MIN_SEG:
            continue
        segments.append({
            "clipFilename": clip["filename"],
            "sourceIn":     s_in,
            "sourceOut":    s_out,
            "transition":   dict(trans),
        })
    return segments


def _total_duration(segments):
    acc = 0.0
    for i, s in enumerate(segments):
        acc += float(s["sourceOut"]) - float(s["sourceIn"])
        if i > 0:
            t = segments[i - 1].get("transition") or {}
            if t.get("type") in ("crossfade", "fade_to_black"):
                acc -= float(t.get("duration") or 0.0)
    return round(max(0.0, acc), 3)


def generate_edit_plan(analyses, style, duration_target, format_str,
                        brief_hints=None):
    """Build a smart edit plan from analysed clips.

    brief_hints is a dict from app._parse_brief() — currently honoured:
      - calm / family / luxury  (real_estate)
    Other styles ignore hints today but accept the kwarg for forward compat.
    """
    aspect = format_str if format_str in ("16:9", "9:16", "1:1") else "16:9"
    total = duration_target or _STYLE_DEFAULTS.get(style, 30)
    brief_hints = brief_hints or {}

    valid = [a for a in analyses
             if not a.get("error") and float(a.get("duration", 0)) > 1.2]
    if not valid:
        raise ValueError("No valid clips to assemble")

    # Single-clip mode: regardless of style, slice into 3 windows.
    if len(valid) == 1:
        segments = _single_clip_split(valid[0], style)
        if not segments:
            raise ValueError("Single clip too short to slice")
        segments[-1]["transition"] = {"type": "fade_to_black", "duration": _END_FADE}
        return {
            "segments":       segments,
            "aspect":         aspect,
            "total_duration": _total_duration(segments),
        }

    if style == "social":
        segments = _build_social(valid, total, brief_hints)
    elif style == "cinematic":
        segments = _build_cinematic(valid, total, brief_hints)
    elif style == "fast":
        segments = _build_fast(valid, total, brief_hints)
    else:
        segments = _build_real_estate(valid, total, brief_hints)

    if not segments:
        raise ValueError("Could not build any segments")

    return {
        "segments":       segments,
        "aspect":         aspect,
        "total_duration": _total_duration(segments),
    }


def generate_sequential_fallback(analyses, duration_target, format_str):
    """Last-resort plan when generate_edit_plan() raises.

    Walks every valid clip in input order, gives each an equal share of the
    target duration, hard cuts between them. No scoring, no reordering.
    Guarantees a working plan as long as at least one clip is decodable.
    """
    aspect = format_str if format_str in ("16:9", "9:16", "1:1") else "16:9"
    valid = [a for a in analyses if float(a.get("duration", 0)) > 1.0]
    total = duration_target or 30
    if not valid:
        return {"segments": [], "aspect": aspect, "total_duration": float(total)}
    share = total / len(valid)
    segments = []
    for clip in valid:
        seg = _build_segment(clip, share)
        if not seg:
            continue
        seg["transition"] = {"type": "cut", "duration": 0.0}
        segments.append(seg)
    if segments:
        segments[-1]["transition"] = {"type": "fade_to_black", "duration": 0.8}
    return {
        "segments":       segments,
        "aspect":         aspect,
        "total_duration": _total_duration(segments),
    }
