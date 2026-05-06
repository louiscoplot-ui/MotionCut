# MotionCut

A local, single-machine video editor with a premium dark UI.
Built with **Flask + FFmpeg + HTML5 Canvas**. Upload a clip, drop on text and
logo layers, pick a template, and export a finished MP4 — everything stays on
your machine.

![stack](https://img.shields.io/badge/stack-flask%20%2B%20ffmpeg%20%2B%20canvas-f0c040)

## Features

- Upload MP4 / MOV / WebM video (up to 2GB) and PNG / JPG images.
- Real-time canvas overlay perfectly synced with HTML5 video playback.
- Drag & resize text and logo layers directly on the preview.
- 6 text animations: tracking, reveal, typewriter, fade/zoom/glow, bounce, cinematic.
- 8 fonts (Syne, Orbitron, Teko, Playfair Display, JetBrains Mono, Bebas Neue, Arial, Georgia).
- 5 built-in templates: Cinematic, Real Estate, Travel, Social 9:16, Corporate.
- Effects: vignette, film grain, color grade presets (Natural, Cinematic, Teal & Orange, Moody Dark, Bright Airy, B&W).
- Optional music: upload MP3/WAV, mix or replace original audio, fade in/out, volume control.
- Export to **16:9 (1920×1080)** and **9:16 (1080×1920)** MP4 via FFmpeg.
- Undo/redo, project save/load (JSON), keyboard shortcuts.

## Install (Windows)

1. **Install FFmpeg** (one-time):
   ```powershell
   winget install FFmpeg
   ```
   Confirm it works:
   ```powershell
   ffmpeg -version
   ```

2. **Install Python deps**:
   ```powershell
   pip install -r requirements.txt
   ```

3. **Run**:
   ```powershell
   python app.py
   ```

4. **Open** http://localhost:5000 in any modern browser.

## Project layout

```
motioncut/
├── app.py                 # Flask backend, FFmpeg export pipeline
├── templates/index.html   # 3-panel editor UI
├── static/js/editor.js    # canvas, layers, animations, export
├── static/css/style.css   # dark gold UI
├── uploads/               # auto-created
├── exports/               # auto-created
├── requirements.txt
└── README.md
```

## Keyboard shortcuts

| Key            | Action                |
|---------------:|-----------------------|
| `Space`        | Play / pause          |
| `←` / `→`      | Step 1 frame          |
| `-` / `+`      | Step 1 frame          |
| `Del`          | Remove selected layer |
| `Ctrl+Z`       | Undo                  |
| `Ctrl+Y`       | Redo                  |

## Notes

- All processing is local; no telemetry, no uploads to remote services.
- Exports land in `exports/` with name `motioncut_<template>_<aspect>_<timestamp>.mp4`.
- For best results, supply music you own the rights to.
- Tested on Python 3.10+ and FFmpeg 6.x on Windows 10/11.

## Troubleshooting

- **`FFmpeg: NOT FOUND` in the topbar** — install FFmpeg with `winget install FFmpeg` and restart the terminal so `ffmpeg` is on your PATH.
- **Export fails immediately** — check the `Status` panel under Export; the FFmpeg stderr tail is shown when something goes wrong (usually a missing font or a 0-byte upload).
- **Fonts look generic in the export** — FFmpeg uses `C:\Windows\Fonts\arial.ttf` as a safe fallback because Google Fonts only ship to the browser. To embed Syne/Orbitron etc. into the burned video, drop their `.ttf` files into a folder and edit the `fontfile=` path inside `app.py`.
