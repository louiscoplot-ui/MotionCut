# MotionCut production image — used by Render (and any other Docker host).
# Slim Python base + apt-installed ffmpeg. Gunicorn serves Flask in prod.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MOTIONCUT_PROD=1 \
    MOTIONCUT_NO_AUTOPULL=1

# ffmpeg is the heavy native dep. Everything else (pillow, flask) is wheels.
# git is kept around so /api/version's `git rev-parse` keeps working when the
# .git folder is shipped (Render does ship it for git-based deploys).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so layer cache survives source-only edits.
COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY . .

# Render injects $PORT. Default to 5000 for local `docker run`.
ENV PORT=5000
EXPOSE 5000

# Single gunicorn worker is intentional — exports use threading + module-level
# job state. Multiple workers would each see their own job dict, breaking the
# SSE progress endpoint. Threads scale concurrency within the worker.
# `--timeout 0` because long FFmpeg encodes can run > 30s and we don't want
# gunicorn killing them mid-render. Render's edge has its own timeout.
# Shell form so $PORT (set by Render) is expanded at runtime.
CMD gunicorn app:app \
     --bind 0.0.0.0:${PORT:-5000} \
     --workers 1 \
     --threads 8 \
     --timeout 0 \
     --access-logfile - \
     --error-logfile -
