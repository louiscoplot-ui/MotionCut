"""
Standalone multi-clip export path (CORE-2 + LOOP-2).

This package is intentionally decoupled from app.py's main render pipeline
(run_export_job / build_filter_complex / build_segments_chain), which
CLAUDE.md forbids modifying. It provides a clean, self-contained FFmpeg
builder + job runner used by the additive /api/export/start route and the
LOOP-2 quality-verification loop.

The mature in-app pipeline (POST /api/export with a segments[] payload)
remains the primary path used by the editor UI; this module exists so the
spec's /api/export/start contract and the quality loop have a render path
they fully own.
"""
