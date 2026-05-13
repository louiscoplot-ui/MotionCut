// MotionCut — simplified one-shot UI.
// Upload → choose style → click Generate → watch progress → download.
// State is intentionally local-only: uploadedFiles[] in memory + the
// server's job tracker via /api/generate/<id>/status.
import { WorkerBridge } from './worker-bridge.js';

(() => {
  'use strict';

  // ---------- DOM helpers ----------
  const $  = (id) => document.getElementById(id);
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);
  const G  = window.gsap;          // GSAP CDN — guaranteed loaded by index.html

  // ---------- State ----------
  /** @type {{filename:string,url:string,kind:string,localUrl?:string,name?:string,duration?:number}[]} */
  const uploadedFiles = [];
  /** Music track — either uploaded via the Options panel OR auto-picked
   *  from /api/music/catalogue. Lives outside uploadedFiles because it
   *  never appears in the file grid, just in the music chip. */
  let audioTrack = null;     // {filename?, catalogueUrl?, name, source:'upload'|'catalogue'}
  /** Cached catalogue from /api/music/catalogue — fetched lazily once. */
  let musicCatalogue = null;
  let currentJobId = null;
  let pollTimer = null;
  let renderStartedAt = 0;
  /** Latest waveform (200 peak values, 0..1) and beats (s) from the audio worker.
   *  null until the worker has produced something for the current audioTrack. */
  let waveformData = null;
  let detectedBeats = [];
  let waveformRAF = 0;
  /** Whisper bridge — kept across generates so the loaded pipeline (and its
   *  cached weights) survives "Generate again" without re-importing the
   *  library. terminate() is only called when the page unloads. */
  let whisperBridge = null;
  let whisperWarm = false;
  const CAPTIONS_CACHE_FLAG = 'mc:whisper-warm';
  /** MediaPipe face-detection bridge. Shared across the whole session for
   *  the same reason as whisperBridge — the WASM + .tflite assets are
   *  ~3-4 MB but the cost adds up across regenerates. */
  let mediapipeBridge = null;

  // ---------- Build-pulse auto-reload ----------
  // Mirrors the SSE auto-reload from the old editor: if the server's SHA
  // changes (i.e. I push a new commit and gunicorn picks it up), reload
  // the tab so the user is never on stale JS.
  function startBuildPulse() {
    const tag = $('build-sha');
    const initialSha = tag ? tag.textContent.trim() : null;
    if (!initialSha) return;
    let reloading = false;
    const reload = (sha) => {
      if (reloading) return;
      reloading = true;
      console.log(`%c[MC] new build ${sha} — reloading…`, 'color:#f0c040;font-weight:bold');
      setTimeout(() => location.reload(), 400);
    };
    const open = () => {
      const es = new EventSource('/api/build-pulse');
      es.onmessage = (ev) => {
        try {
          const { sha } = JSON.parse(ev.data);
          if (sha && sha !== initialSha && sha !== 'dev') reload(sha);
        } catch {}
      };
      es.onerror = () => { es.close(); setTimeout(open, 5000); };
    };
    open();
  }

  // ---------- Toast ----------
  function toast(msg, opts = {}) {
    const host = $('toast-host'); if (!host) return null;
    const el = document.createElement('div');
    el.className = 'toast' + (opts.kind ? ' toast-' + opts.kind : '');
    el.textContent = msg;
    host.appendChild(el);
    if (G) G.fromTo(el, {y:12, opacity:0}, {y:0, opacity:1, duration:0.25, ease:'power2.out'});
    // Sticky toasts auto-dismiss only when the caller removes them — used
    // for long-lived progress messages (e.g. model download).
    if (!opts.sticky) {
      setTimeout(() => {
        if (!el.isConnected) return;
        if (G) G.to(el, {y:-8, opacity:0, duration:0.25, ease:'power2.in', onComplete:() => el.remove()});
        else el.remove();
      }, opts.duration || 3200);
    }
    return el;
  }

  // ---------- Section transitions ----------
  function showSection(id) {
    const el = $(id); if (!el) return;
    el.hidden = false;
    if (G) G.fromTo(el, {y:12, opacity:0}, {y:0, opacity:1, duration:0.32, ease:'power2.out', clearProps:'opacity,transform'});
  }
  function hideSection(id) {
    const el = $(id); if (!el || el.hidden) return;
    if (G) {
      G.to(el, {y:-8, opacity:0, duration:0.22, ease:'power2.in', onComplete:() => { el.hidden = true; el.style.opacity=''; el.style.transform=''; }});
    } else {
      el.hidden = true;
    }
  }

  // ---------- Upload flow ----------
  const VIDEO_EXT = ['mp4','mov','m4v','webm','mkv'];
  const IMAGE_EXT = ['jpg','jpeg','png','webp','gif','heic'];
  function classifyKind(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (VIDEO_EXT.includes(ext)) return 'video';
    if (IMAGE_EXT.includes(ext)) return 'image';
    return null;
  }

  // Files larger than this go through /api/upload/chunk to bypass nginx /
  // Cloudflare body-size limits (commonly 100 MB). Smaller files keep the
  // single-shot POST /api/upload path for minimal overhead.
  // CHUNK_SIZE is fetched from /api/health at boot so the server can tune
  // it per deployment (MOTIONCUT_CHUNK_MB env var). Defaults to 4 MB,
  // which sits under nginx's 8 MB client_max_body_size default.
  let CHUNK_SIZE = 4 * 1024 * 1024;
  const SMALL_FILE_THRESHOLD = 50 * 1024 * 1024;  // 50 MB

  async function uploadOne(file) {
    const kind = classifyKind(file.name);
    if (!kind) {
      toast(`Skipped ${file.name}: unsupported format`, {kind:'error'});
      return null;
    }
    const localUrl = URL.createObjectURL(file);
    const placeholder = {
      filename: file.name, kind, url: null,
      localUrl, name: file.name, _uploading: true, duration: null,
      file,                            // kept for Sprint 4 audio worker
      _progress: 0,                    // 0..100, painted as an overlay bar
      _size: file.size,
    };
    uploadedFiles.push(placeholder);
    renderFileGrid();
    try {
      const data = file.size < SMALL_FILE_THRESHOLD
        ? await uploadDirect(file, kind, placeholder)
        : await uploadChunked(file, kind, placeholder);
      placeholder.filename   = data.filename;
      placeholder.url        = data.url;
      placeholder._uploading = false;
      placeholder._progress  = 100;
      // Lazy probe duration for videos so the thumbnail can show "0:12".
      if (kind === 'video') {
        fetch('/api/probe', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ project: 'default', filename: data.filename }),
        }).then(r => r.ok ? r.json() : null).then(d => {
          if (d && d.duration) { placeholder.duration = d.duration; renderFileGrid(); }
        }).catch(()=>{});
      }
      renderFileGrid();
      return placeholder;
    } catch (e) {
      console.warn('[upload]', e);
      toast(`Upload failed: ${file.name} — ${e.message}`, {kind:'error', duration:5000});
      const i = uploadedFiles.indexOf(placeholder);
      if (i >= 0) uploadedFiles.splice(i, 1);
      renderFileGrid();
      return null;
    }
  }

  async function uploadDirect(file, kind, placeholder) {
    const fd = new FormData();
    fd.append('file',    file);
    fd.append('kind',    kind);
    fd.append('project', 'default');
    const r = await fetch('/api/upload', { method:'POST', body: fd });
    const txt = await r.text();
    let data;
    try { data = JSON.parse(txt); }
    catch {
      // nginx 413 is HTML, not JSON — special-case it so the user sees a
      // useful message instead of "non-JSON upload response".
      if (r.status === 413) {
        throw new Error('File too large for the proxy. '
          + 'Server admin: set client_max_body_size 2048m in nginx.conf.');
      }
      throw new Error('non-JSON upload response: ' + txt.slice(0,200));
    }
    if (!r.ok) throw new Error(data.error || `upload failed (${r.status})`);
    return data;
  }

  async function uploadChunked(file, kind, placeholder) {
    // upload_id pattern enforced by /api/upload/chunk: 8-64 chars [A-Za-z0-9_-].
    const uploadId = (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random()))
      .replace(/-/g, '').slice(0, 24);
    const total = Math.ceil(file.size / CHUNK_SIZE);
    let last = null;
    for (let i = 0; i < total; i++) {
      const start = i * CHUNK_SIZE;
      const end   = Math.min(file.size, start + CHUNK_SIZE);
      const chunk = file.slice(start, end);
      const fd = new FormData();
      fd.append('uploadId',     uploadId);
      fd.append('chunkIndex',   String(i));
      fd.append('totalChunks',  String(total));
      fd.append('filename',     file.name);
      fd.append('kind',         kind);
      fd.append('project',      'default');
      fd.append('chunk',        chunk);
      const r = await fetch('/api/upload/chunk', { method:'POST', body: fd });
      const txt = await r.text();
      let data;
      try { data = JSON.parse(txt); }
      catch {
        if (r.status === 413) {
          const mb = (CHUNK_SIZE / 1024 / 1024).toFixed(1);
          throw new Error(`Chunk too large — current chunk size: ${mb} MB. `
            + 'Set MOTIONCUT_CHUNK_MB env var on the server to reduce it.');
        }
        throw new Error(`chunk ${i+1}/${total}: non-JSON HTTP ${r.status}`);
      }
      if (!r.ok) throw new Error(data.error || `chunk ${i+1}/${total} failed (${r.status})`);
      last = data;
      const pct = Math.round(((i + 1) / total) * 100);
      updateUploadProgress(placeholder, pct);
    }
    if (!last || !last.filename) {
      throw new Error('chunked upload finalised with no file metadata');
    }
    return last;
  }

  function updateUploadProgress(placeholder, pct) {
    placeholder._progress = Math.max(0, Math.min(100, pct | 0));
    // Re-render just the matching card's overlay rather than the whole grid
    // for smoother feedback on large uploads.
    const i = uploadedFiles.indexOf(placeholder);
    if (i < 0) return;
    const overlay = document.querySelector(`.file-card[data-i="${i}"] .thumb-uploading`);
    if (overlay) overlay.textContent = `Uploading… ${placeholder._progress}%`;
    const bar = document.querySelector(`.file-card[data-i="${i}"] .upload-bar > div`);
    if (bar) bar.style.width = placeholder._progress + '%';
  }

  async function uploadMany(files) {
    if (!files || !files.length) return;
    updateStatus(`Uploading ${files.length} file${files.length>1?'s':''}…`);
    // Parallel — the server handles concurrent uploads + lazy probe.
    await Promise.all([...files].map(uploadOne));
    updateStatus('');
    // First batch revealed → expose options + generate button.
    if (uploadedFiles.length && $('section-options').hidden) {
      showSection('section-options');
      showSection('section-action');
    }
    refreshGenerateEnabled();
  }

  function updateStatus(msg) {
    const el = $('upload-status'); if (!el) return;
    el.textContent = msg || '';
  }

  function refreshGenerateEnabled() {
    const btn = $('btn-generate'); const hint = $('action-hint');
    const ready = uploadedFiles.some(f => !f._uploading && f.url);
    btn.disabled = !ready;
    hint.textContent = ready
      ? `Ready to generate from ${uploadedFiles.filter(f=>!f._uploading).length} file${uploadedFiles.length>1?'s':''}.`
      : (uploadedFiles.length ? 'Uploading…' : 'Add some files to enable.');
  }

  // ---------- File grid render ----------
  function fmtDur(s) {
    if (!s || s < 0.1) return '';
    const m = Math.floor(s / 60); const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2,'0')}`;
  }

  function renderFileGrid() {
    const grid = $('file-grid');
    if (!grid) return;
    if (!uploadedFiles.length) { grid.hidden = true; grid.innerHTML = ''; refreshGenerateEnabled(); return; }
    grid.hidden = false;
    grid.innerHTML = uploadedFiles.map((f, i) => {
      const thumbSrc = f.localUrl || f.url || '';
      const isVid = f.kind === 'video';
      const dur = f.duration ? fmtDur(f.duration) : '';
      const pct = Math.max(0, Math.min(100, f._progress | 0));
      const overlay = f._uploading
        ? `<div class="thumb-uploading">Uploading… ${pct}%</div>
           <div class="upload-bar"><div style="width:${pct}%"></div></div>`
        : '';
      const thumb = isVid
        ? `<video class="thumb" muted playsinline preload="metadata" src="${thumbSrc}"></video>`
        : `<img class="thumb" src="${thumbSrc}" alt="">`;
      const displayName = (f.name || f.filename || '').replace(/^[a-f0-9]{6,16}_/, '');
      return `
        <div class="file-card" data-i="${i}">
          ${thumb}
          ${overlay}
          <button class="file-x" data-i="${i}" type="button" title="Remove">×</button>
          <div class="file-meta">
            <span class="file-name">${escapeHTML(displayName)}</span>
            ${dur ? `<span class="file-dur mono">${dur}</span>` : ''}
          </div>
          <span class="file-badge file-badge-${f.kind}">${(f.kind||'').toUpperCase()}</span>
        </div>`;
    }).join('');
    grid.querySelectorAll('.file-x').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = parseInt(btn.dataset.i, 10);
        if (!Number.isFinite(i)) return;
        uploadedFiles.splice(i, 1);
        renderFileGrid();
      });
    });
    refreshGenerateEnabled();
    syncCaptionsGroupVisibility();
  }

  function escapeHTML(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
      {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
    ));
  }

  // ---------- Generate flow ----------
  function selectedRadio(group) {
    const el = document.querySelector(`.opt-pills[data-group="${group}"] input:checked`);
    return el ? el.value : null;
  }

  async function generateVideo() {
    if (currentJobId) return;     // already running
    const filenames = uploadedFiles.filter(f => !f._uploading && f.filename).map(f => f.filename);
    if (!filenames.length) { toast('Add some files first.', {kind:'error'}); return; }
    const body = {
      project:   'default',
      filenames,
      style:     selectedRadio('style')    || 'real_estate',
      duration:  (selectedRadio('duration') || null),
      format:    selectedRadio('format')   || '16:9',
      music:     selectedRadio('music')    || 'none',
      // Sprint 2 — visual options. Defaults match the previous behaviour
      // (natural grade, no vignette / grain / letterbox) so users who
      // never open the Options panel get exactly what they got before.
      music_filename:        (audioTrack && audioTrack.source === 'upload')    ? audioTrack.filename    : null,
      music_catalogue_url:   (audioTrack && audioTrack.source === 'catalogue') ? audioTrack.catalogueUrl : null,
      music_volume:          getMusicVolume(),
      color_grade:    ($('color-grade')?.value || 'natural'),
      vignette:       !!$('opt-vignette')?.checked,
      film_grain:     !!$('opt-grain')?.checked,
      letterbox:      !!$('opt-letterbox')?.checked,
      // Sprint 6: captions are sent as source-time tagged segments and
      // remapped to the edit timeline server-side once the planner has run.
      // clip_metadata carries the MediaPipe has_face flag used by the
      // real-estate ordering heuristic.
      caption_segments: [],
      caption_style:    'subtitles',
      clip_metadata:    [],
    };
    if (body.duration === '' || body.duration === 'auto') body.duration = null;
    else if (body.duration) body.duration = parseInt(body.duration, 10);

    hideSection('section-upload');
    hideSection('section-options');
    hideSection('section-action');
    showSection('section-progress');
    // Show the audio step in the progress list only when we have a track to
    // analyse — keeps the UI honest for "music: none" runs.
    const audioStep = document.querySelector('.step[data-step="audio"]');
    if (audioStep) audioStep.hidden = !audioTrack;
    if (audioTrack) {
      setStep('audio');
      setProgress(0, 65);
      try {
        await runAudioAnalysis();
      } catch (e) {
        console.warn('[audio analysis] failed, continuing without beats:', e);
      }
    }

    // Sprint 5+6: caption transcription, if enabled. Step is hidden when
    // the toggle is off; non-fatal — returns empty segments on any error.
    let captionResult = { segments: [], style: 'subtitles' };
    const captionsOn = !!$('opt-captions')?.checked
                      && uploadedFiles.some(f => f.kind === 'video');
    const captionStep = document.querySelector('.step[data-step="captions"]');
    if (captionStep) captionStep.hidden = !captionsOn;
    if (captionsOn) {
      setStep('captions');
      setProgress(0, 90);
      try {
        captionResult = await runCaptions();
      } catch (e) {
        console.warn('[captions] failed:', e);
      }
    }

    // Sprint 6: MediaPipe face detection on each video — silent, runs
    // alongside the "Analyzing clips" step. Never blocks the render.
    setStep('analyzing');
    setProgress(0, captionsOn ? 50 : 60);
    try {
      await runFaceDetection();
    } catch (e) {
      console.warn('[face detection] failed:', e);
    }

    body.caption_segments = captionResult.segments;
    body.caption_style    = captionResult.style;
    body.clip_metadata = uploadedFiles
      .filter(f => !f._uploading && f.filename)
      .map(f => ({ filename: f.filename, has_face: !!f.has_face }));

    let data;
    try {
      const r = await fetch('/api/generate', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body),
      });
      const txt = await r.text();
      try { data = JSON.parse(txt); } catch {
        throw new Error(`Server returned HTTP ${r.status} with non-JSON: ${txt.slice(0,200) || '(empty)'}`);
      }
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    } catch (e) {
      console.warn('[generate]', e);
      toast('Generation failed: ' + e.message, {kind:'error', duration:6000});
      cancelPolling();
      hideSection('section-progress');
      showSection('section-upload');
      showSection('section-options');
      showSection('section-action');
      return;
    }
    currentJobId = data.job_id;
    renderStartedAt = Date.now();
    pollStatus(currentJobId);
  }

  function pollStatus(jobId) {
    cancelPolling();
    const tick = async () => {
      try {
        const r = await fetch(`/api/generate/${encodeURIComponent(jobId)}/status`);
        const txt = await r.text();
        let s; try { s = JSON.parse(txt); } catch {
          throw new Error(`status HTTP ${r.status}: ${txt.slice(0,160) || '(empty)'}`);
        }
        if (!r.ok) throw new Error(s.error || `status HTTP ${r.status}`);
        handleStatus(s);
      } catch (e) {
        console.warn('[poll]', e);
        toast('Polling failed: ' + e.message, {kind:'error'});
      }
    };
    tick();   // immediate first hit
    pollTimer = setInterval(tick, 2000);
  }
  function cancelPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function handleStatus(s) {
    const status = s.status;
    setStep(status === 'queued' ? 'analyzing' : status);
    setProgress(s.progress || 0, s.eta_seconds);
    if (status === 'done') {
      cancelPolling();
      $('result-video').src = s.output_url;
      $('btn-download').href = s.output_url;
      showSection('section-result');
      hideSection('section-progress');
      const took = ((Date.now() - renderStartedAt) / 1000).toFixed(1);
      toast(`Done in ${took}s.`, {kind:'success'});
      currentJobId = null;
      if (waveformData && waveformData.length) {
        drawWaveform();
        startWaveformLoop();
      }
    } else if (status === 'error') {
      cancelPolling();
      const msg = s.error_message || 'unknown error';
      toast('Render failed: ' + msg, {kind:'error', duration:8000});
      console.warn('[render] error', s);
      hideSection('section-progress');
      showSection('section-upload');
      showSection('section-options');
      showSection('section-action');
      currentJobId = null;
    }
  }

  function setStep(name) {
    // Sprint 4: "audio" step prepended when an audioTrack is staged. The
    // <li> is `hidden` in the markup when no track is present so we never
    // expose a misleading 5-step run for music=None generates.
    const order = ['audio','captions','analyzing','planning','rendering','done'];
    const reached = order.indexOf(name);
    document.querySelectorAll('.step').forEach((el) => {
      const i = order.indexOf(el.dataset.step);
      el.classList.toggle('is-done', i < reached || (reached === order.length - 1 && i === reached - 1));
      el.classList.toggle('is-active', i === reached);
    });
    const titles = {
      audio:      'Analysing audio…',
      captions:   'Transcribing audio…',
      analyzing:  'Analysing your clips…',
      planning:   'Building the edit plan…',
      rendering:  'Rendering the final video…',
      done:       'Ready!',
    };
    if ($('progress-title')) $('progress-title').textContent = titles[name] || 'Working…';
  }

  function setProgress(pct, eta) {
    pct = Math.max(0, Math.min(100, Number(pct) || 0));
    if ($('bar-fill')) $('bar-fill').style.width = pct + '%';
    if ($('bar-pct'))  $('bar-pct').textContent = pct + '%';
    if (eta != null && $('bar-eta')) {
      $('bar-eta').textContent = eta > 0 ? `~${eta} s remaining` : '';
    }
  }

  // ---------- Result actions ----------
  function regenerate() {
    if (currentJobId) return;
    cancelWaveformLoop();
    // Same uploadedFiles, fresh job.
    hideSection('section-result');
    generateVideo();
  }
  function changeStyle() {
    if (currentJobId) return;
    cancelWaveformLoop();
    // Keep uploadedFiles; return to the picker.
    hideSection('section-result');
    showSection('section-upload');
    showSection('section-options');
    showSection('section-action');
  }

  // ---------- Captions / Whisper (Sprint 5+6 — Web Worker) ----------
  // Returns { segments:[{clipFilename, sourceStart, sourceEnd, text}], style }
  // — source-time tagged so the server can remap them to the edit timeline
  // after the planner reorders clips. Empty segments on failure / disabled.
  async function runCaptions() {
    const enabled = !!$('opt-captions')?.checked;
    const styleId = $('captions-style')?.value || 'subtitles';
    if (!enabled) return { segments: [], style: styleId };
    const videos = uploadedFiles.filter(f => !f._uploading && f.kind === 'video' && f.url);
    if (!videos.length) return { segments: [], style: styleId };

    const language = $('captions-lang')?.value || 'auto';
    let modelToast = null;

    if (!whisperBridge) {
      whisperBridge = new WorkerBridge(
        new URL('./workers/whisper.worker.js', import.meta.url).toString()
      );
    }
    const offProgress = whisperBridge.on((m) => {
      if (!m) return;
      if (m.type === 'MODEL_PROGRESS' && modelToast) {
        modelToast.textContent = `Downloading caption model… ${m.pct || 0}%`;
      } else if (m.type === 'TRANSCRIPTION_PROGRESS') {
        setProgress(Math.min(99, 30 + (m.pct || 0) * 0.5));
      }
    });

    try {
      if (!whisperWarm) {
        modelToast = toast('Downloading caption model (~75 MB)…',
                           { kind: 'gold', sticky: true });
        whisperBridge.send('LOAD_MODEL', {});
        await whisperBridge.wait((m) => m.type === 'MODEL_READY',
                                 { timeout: 300000 });
        whisperWarm = true;
        try { localStorage.setItem(CAPTIONS_CACHE_FLAG, '1'); } catch (_) {}
        if (modelToast && modelToast.remove) modelToast.remove();
        updateCaptionsCacheLabel();
      }

      const allSegments = [];
      for (const v of videos) {
        let segs = [];
        try {
          const pcm = await extractMono16k(v.url);
          if (!pcm || !pcm.length) continue;
          whisperBridge.send('TRANSCRIBE',
            { pcm, sampleRate: 16000, language },
            [pcm.buffer]);
          const res = await whisperBridge.wait(
            (m) => m.type === 'TRANSCRIPTION_READY',
            { timeout: 120000 });
          segs = (res && res.segments) || [];
        } catch (e) {
          console.warn('[captions] video failed:', v.filename, e);
        }
        for (const s of segs) {
          const text = (s.text || '').trim();
          if (!text) continue;
          allSegments.push({
            clipFilename: v.filename,
            sourceStart:  +Number(s.start || 0).toFixed(3),
            sourceEnd:    +Number(s.end   || (s.start || 0) + 2).toFixed(3),
            text,
          });
        }
      }
      return { segments: allSegments, style: styleId };
    } catch (err) {
      console.warn('[captions] failed, continuing without:', err);
      toast('Caption transcription failed — generating without captions.',
            { kind: 'error', duration: 5000 });
      return { segments: [], style: styleId };
    } finally {
      offProgress();
      if (modelToast && modelToast.remove) modelToast.remove();
    }
  }

  /** Fetch a remote video, decode it via AudioContext, resample to 16 kHz
   *  mono — Whisper's required input shape. Returns Float32Array or null. */
  async function extractMono16k(url) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const r = await fetch(url);
    if (!r.ok) throw new Error('fetch video: HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    const ctx = new AC();
    let decoded;
    try {
      decoded = await ctx.decodeAudioData(buf.slice(0));
    } catch (e) {
      // The mp4 may have no audio track, or a codec the browser can't decode.
      try { await ctx.close(); } catch (_) {}
      console.warn('[captions] decodeAudioData failed for', url, e);
      return null;
    }
    try { await ctx.close(); } catch (_) {}
    // Resample to 16 kHz mono via an offline graph.
    const targetSr = 16000;
    const offline = new OfflineAudioContext(
      1, Math.ceil(decoded.duration * targetSr), targetSr);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const out = await offline.startRendering();
    return out.getChannelData(0);
  }

  async function probeDuration(filename) {
    try {
      const r = await fetch('/api/probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'default', filename }),
      });
      if (!r.ok) return 0;
      const d = await r.json();
      return d.duration || 0;
    } catch (_) { return 0; }
  }

  // ---------- Face detection (Sprint 6 — MediaPipe Worker) ----------
  // Extracts 3 frames per video (at 25 / 50 / 75 % of duration), runs them
  // through MediaPipe FaceDetection in the Worker, and stores has_face on
  // the matching uploadedFiles entry. Failures fall back to has_face:false
  // so the planner just behaves like before.
  async function runFaceDetection() {
    const videos = uploadedFiles.filter(
      f => !f._uploading && f.kind === 'video' && f.url && f.file);
    if (!videos.length) return;
    if (!mediapipeBridge) {
      mediapipeBridge = new WorkerBridge(
        new URL('./workers/mediapipe.worker.js', import.meta.url).toString()
      );
    }
    for (const v of videos) {
      if (v.has_face !== undefined) continue;  // already analysed
      try {
        const frames = await extractFrames(v.file, 3);
        if (!frames.length) { v.has_face = false; continue; }
        mediapipeBridge.send('DETECT_FACES',
          { frames, width: frames[0].width, height: frames[0].height },
          frames);  // transfer ImageBitmaps zero-copy
        const res = await mediapipeBridge.wait(
          (m) => m.type === 'FACE_RESULT', { timeout: 30000 });
        v.has_face = !!(res && res.has_face);
        if (res && res.fallback) {
          console.info('[mediapipe] fallback for', v.filename);
        }
      } catch (e) {
        console.warn('[mediapipe] failed for', v.filename, e);
        v.has_face = false;
      }
    }
  }

  /** Decode `count` frames from a File via a hidden <video>, draw each to
   *  an OffscreenCanvas, and return an array of ImageBitmaps. The bitmaps
   *  are Transferable — the caller can hand them to a Worker zero-copy. */
  async function extractFrames(file, count) {
    const url = URL.createObjectURL(file);
    try {
      const vid = document.createElement('video');
      vid.preload = 'auto';
      vid.muted = true;
      vid.playsInline = true;
      vid.src = url;
      await new Promise((resolve, reject) => {
        vid.addEventListener('loadedmetadata', resolve, { once: true });
        vid.addEventListener('error', () => reject(new Error('video load failed')), { once: true });
      });
      const dur = vid.duration;
      if (!isFinite(dur) || dur <= 0.1) return [];
      const w = Math.min(640, vid.videoWidth || 640);
      const h = Math.round(w * (vid.videoHeight || 360) / (vid.videoWidth || 640));
      const canvas = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
      const ctx = canvas.getContext('2d');
      const frames = [];
      for (let i = 0; i < count; i++) {
        const t = dur * ((i + 1) / (count + 1));   // 25 / 50 / 75 % for count=3
        await new Promise((resolve, reject) => {
          const onSeeked = () => { vid.removeEventListener('seeked', onSeeked); resolve(); };
          vid.addEventListener('seeked', onSeeked, { once: true });
          vid.addEventListener('error', () => reject(new Error('seek failed')), { once: true });
          vid.currentTime = t;
        });
        ctx.drawImage(vid, 0, 0, w, h);
        try {
          const bm = (canvas.transferToImageBitmap)
            ? canvas.transferToImageBitmap()
            : await createImageBitmap(canvas);
          frames.push(bm);
        } catch (e) {
          // OffscreenCanvas + transferToImageBitmap detaches the canvas
          // contents; on fallback path we re-create the canvas next loop.
          console.warn('[extractFrames] frame bitmap failed:', e);
        }
      }
      return frames;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function updateCaptionsCacheLabel() {
    const el = $('captions-cache-state');
    if (!el) return;
    let cached = false;
    try { cached = localStorage.getItem(CAPTIONS_CACHE_FLAG) === '1'; } catch (_) {}
    if (cached) {
      el.textContent = '✓ Model cached locally';
      el.classList.add('is-cached');
    } else {
      el.textContent = '~75 MB first use · cached after';
      el.classList.remove('is-cached');
    }
  }

  function syncCaptionsGroupVisibility() {
    const grp = $('captions-group');
    if (!grp) return;
    const hasVideo = uploadedFiles.some(f => f.kind === 'video' && !f._uploading);
    grp.hidden = !hasVideo;
  }

  // ---------- Audio analysis (Sprint 4 — Web Worker) ----------
  // Decodes the staged music track in a Worker, returns { beats, waveform }.
  // Beats are persisted via /api/project/save so the FFmpeg pipeline can
  // snap segment cuts to them (see _snap_segments_to_beats in app.py).
  // Failure here is non-fatal — the caller catches and the render continues
  // without beats.
  async function runAudioAnalysis() {
    if (!audioTrack) return;
    // 1. Get the raw bytes for the staged track.
    let bytes;
    if (audioTrack.source === 'upload' && audioTrack.file) {
      bytes = await audioTrack.file.arrayBuffer();
    } else if (audioTrack.source === 'catalogue' && audioTrack.catalogueUrl) {
      const r = await fetch(audioTrack.catalogueUrl);
      if (!r.ok) throw new Error('catalogue fetch: HTTP ' + r.status);
      bytes = await r.arrayBuffer();
    } else {
      return;
    }
    // 2. Spawn the Worker via the bridge.
    const bridge = new WorkerBridge(
      new URL('./workers/analysis.worker.js', import.meta.url).toString()
    );
    let beats = [];
    try {
      const onMsg = (m) => {
        if (!m) return;
        if (m.type === 'PROGRESS') setProgress(Math.min(99, m.pct || 0));
        else if (m.type === 'WAVEFORM_READY') waveformData = m.waveform || null;
      };
      const off = bridge.on(onMsg);
      // Try Worker-side decode first. Transferable hand-off: the ArrayBuffer
      // is detached on the main thread so we can't reuse it after this point.
      bridge.send('ANALYSE_AUDIO', { audioBuffer: bytes, sampleRate: 48000 }, [bytes]);
      const first = await bridge.wait((m) => m.type === 'BEATS_READY');
      if (first.fallback) {
        // Worker couldn't decode (no AudioContext in its scope). Decode on
        // main thread using the WebAudio API, then re-post raw PCM. The
        // beat-detection loop still runs in the Worker, which is what
        // matters for keeping the main thread responsive on long tracks.
        console.info('[audio] worker decode unavailable, falling back to main-thread decode');
        const refetched = audioTrack.source === 'upload' && audioTrack.file
          ? await audioTrack.file.arrayBuffer()
          : await (await fetch(audioTrack.catalogueUrl)).arrayBuffer();
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) {
          console.warn('[audio] no AudioContext on main thread either; skipping beats');
          off();
          bridge.terminate();
          return;
        }
        const ctx = new AC();
        try {
          const buf = await ctx.decodeAudioData(refetched.slice(0));
          const pcm = buf.getChannelData(0);
          // Transfer PCM buffer to Worker for the loop-heavy beat detection.
          bridge.send('ANALYSE_PCM', { pcm, sampleRate: buf.sampleRate }, [pcm.buffer]);
          const second = await bridge.wait((m) => m.type === 'BEATS_READY');
          beats = second.beats || [];
        } finally {
          try { await ctx.close(); } catch (_) {}
        }
      } else {
        beats = first.beats || [];
      }
      // Wait briefly for WAVEFORM_READY (may arrive after BEATS_READY).
      if (!waveformData) {
        try {
          await bridge.wait((m) => m.type === 'WAVEFORM_READY', { timeout: 1500 });
        } catch (_) { /* not fatal — the waveform canvas just stays hidden */ }
      }
      off();
    } finally {
      bridge.terminate();
    }
    detectedBeats = beats;
    console.log(`[MC] Worker posted BEATS_READY, ${beats.length} beats found`);
    if (beats.length) {
      try { await saveBeatsToProject('default', beats); }
      catch (e) { console.warn('[audio] saving beats failed:', e); }
    }
  }

  /** Persist beat_anchors to project.motioncut.json. The server-side
   *  /api/project/save validator requires a v1 minimal doc shape; build
   *  the smallest one that passes. */
  async function saveBeatsToProject(pid, beats) {
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const document = {
      schema:      'https://motioncut.dev/schemas/project/v1.json',
      version:     1,
      id:          pid,
      name:        pid,
      created_at:  now,
      modified_at: now,
      audio:       { beat_anchors: beats },
    };
    const r = await fetch('/api/project/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: pid, document }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error('save HTTP ' + r.status + ': ' + t.slice(0, 200));
    }
  }

  // ---------- Waveform canvas (Section E) ----------
  function drawWaveform() {
    const c = $('waveform-canvas');
    if (!c || !waveformData || !waveformData.length) return;
    c.hidden = false;
    // Match canvas pixel buffer to displayed size for crisp rendering.
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth || 800;
    const cssH = c.clientHeight || 64;
    if (c.width !== cssW * dpr || c.height !== cssH * dpr) {
      c.width = cssW * dpr; c.height = cssH * dpr;
    }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    const n = waveformData.length;
    const barW = c.width / n;
    ctx.fillStyle = '#d4af37';
    for (let i = 0; i < n; i++) {
      const peak = Math.max(0, Math.min(1, waveformData[i]));
      const h = Math.max(1, peak * c.height * 0.9);
      const y = (c.height - h) / 2;
      ctx.fillRect(i * barW, y, Math.max(1, barW - 1), h);
    }
    // Playhead line.
    const vid = $('result-video');
    if (vid && vid.duration && isFinite(vid.duration)) {
      const x = (vid.currentTime / vid.duration) * c.width;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(x - 1, 0, 2, c.height);
    }
  }
  function startWaveformLoop() {
    if (!waveformData) return;
    cancelWaveformLoop();
    const tick = () => { drawWaveform(); waveformRAF = requestAnimationFrame(tick); };
    waveformRAF = requestAnimationFrame(tick);
  }
  function cancelWaveformLoop() {
    if (waveformRAF) { cancelAnimationFrame(waveformRAF); waveformRAF = 0; }
  }

  // ---------- Init ----------
  /** Pull deployment-tuned settings from the server. Currently just the
   *  chunk size used by the chunked-upload path. Failure is non-fatal —
   *  CHUNK_SIZE keeps its safe 4 MB default. */
  async function loadServerConfig() {
    try {
      const r = await fetch('/api/health');
      if (!r.ok) return;
      const d = await r.json();
      const mb = Math.max(1, Math.min(64, parseInt(d.upload_chunk_mb, 10) || 4));
      CHUNK_SIZE = mb * 1024 * 1024;
      console.log(`[MC] chunk size: ${mb} MB (from /api/health)`);
    } catch (_) {
      // Network blip at boot — keep the 4 MB fallback.
    }
  }

  function init() {
    console.log('%c[MC] generate build', 'color:#f0c040;font-weight:bold', '— upload → AI → download');
    startBuildPulse();
    // Install a window-level drag suppressor *before* anything async so the
    // browser can't navigate to a dropped file during the /api/health
    // round-trip. The real per-element handlers below take over once
    // loadServerConfig() resolves.
    const suppressNav = (e) => { e.preventDefault(); };
    window.addEventListener('dragover', suppressNav);
    window.addEventListener('drop',     suppressNav);

    // Kick off the rest asynchronously so we can await loadServerConfig()
    // before the chunk-size-sensitive code paths exist. CHUNK_SIZE already
    // has a safe 4 MB default, so even if the await never resolves the
    // upload path stays functional.
    initAsync().catch((err) => {
      console.warn('[MC] init failed:', err);
    });
  }

  async function initAsync() {
    await loadServerConfig();

    // Drag-drop on the dropzone (also handle window drops as a safety net).
    const dz = $('dropzone');
    const fi = $('file-input');
    on($('btn-browse'), 'click', () => fi.click());
    on(dz,             'click', (e) => { if (e.target === dz || e.target.closest('.dz-inner')) fi.click(); });
    on(fi, 'change', () => { uploadMany(fi.files); fi.value = ''; });
    ;['dragenter','dragover'].forEach(ev => on(dz, ev, (e) => {
      e.preventDefault(); dz.classList.add('over');
    }));
    ;['dragleave','drop'].forEach(ev => on(dz, ev, (e) => {
      // Only un-highlight when the pointer actually exits the box.
      if (ev === 'dragleave') {
        const r = dz.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
      }
      dz.classList.remove('over');
    }));
    on(dz, 'drop', (e) => {
      e.preventDefault();
      uploadMany(e.dataTransfer?.files);
    });

    // Pill groups behave like radios on the surface (the real <input> radios
    // do the value tracking; this just paints the .on class).
    document.querySelectorAll('.opt-pills').forEach(group => {
      group.addEventListener('click', (e) => {
        const pill = e.target.closest('.pill'); if (!pill) return;
        group.querySelectorAll('.pill').forEach(p => p.classList.toggle('on', p === pill));
      });
    });

    // Options toggle
    on($('options-toggle'), 'click', () => {
      const body = $('options-body');
      const chev = $('options-chev');
      const opening = body.hidden;
      if (opening) {
        body.hidden = false;
        body.style.overflow = 'hidden';
        if (G) G.fromTo(body, {height:0, opacity:0}, {height:'auto', opacity:1, duration:0.25, ease:'power2.out',
          onComplete: () => { body.style.height = ''; body.style.overflow = ''; }
        });
        if (chev) chev.textContent = '▴';
      } else {
        if (G) G.to(body, {height:0, opacity:0, duration:0.2, ease:'power2.in',
          onComplete: () => { body.hidden = true; body.style.height = ''; body.style.opacity = ''; }
        });
        else body.hidden = true;
        if (chev) chev.textContent = '▾';
      }
    });

    on($('btn-generate'),     'click', generateVideo);
    on($('btn-regen'),        'click', regenerate);
    on($('btn-change-style'), 'click', changeStyle);

    // -------- Music wiring (Sprint 3: none / auto / upload) --------
    // - "None"   : audioTrack = null, slider + picker hidden
    // - "Auto"   : auto-pick catalogue track matching the current style
    // - "Upload" : reveal the file picker; user uploads their own track
    const musicUploadWrap = $('music-upload');
    function showMusicUpload(show) {
      if (!musicUploadWrap) return;
      if (show && musicUploadWrap.hidden) {
        musicUploadWrap.hidden = false;
        if (G) G.fromTo(musicUploadWrap, {height:0, opacity:0},
          {height:'auto', opacity:1, duration:0.25, ease:'power2.out',
            onComplete: () => { musicUploadWrap.style.height = ''; }});
      } else if (!show && !musicUploadWrap.hidden) {
        if (G) G.to(musicUploadWrap, {height:0, opacity:0, duration:0.2, ease:'power2.in',
          onComplete: () => { musicUploadWrap.hidden = true; musicUploadWrap.style.height=''; musicUploadWrap.style.opacity=''; }});
        else musicUploadWrap.hidden = true;
      }
    }
    document.querySelectorAll('.opt-pills[data-group="music"] input').forEach(rad => {
      rad.addEventListener('change', async () => {
        const mode = rad.value;
        if (mode === 'upload') {
          showMusicUpload(true);
          // If we previously had an auto-selected catalogue track, clear it
          // so the chip shows the right state for "Upload".
          if (audioTrack && audioTrack.source === 'catalogue') {
            audioTrack = null;
            renderMusicChip();
          }
        } else {
          showMusicUpload(false);
        }
        if (mode === 'none') {
          audioTrack = null;
          renderMusicChip();
        } else if (mode === 'auto') {
          await autoPickCatalogueTrack();
        }
        syncVolumeVisibility();
      });
    });
    on($('music-pick'), 'click', () => $('music-input')?.click());
    on($('music-input'), 'change', async () => {
      const inp = $('music-input');
      const file = inp?.files?.[0];
      inp.value = '';   // allow re-picking same file later
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kind', 'audio');
      fd.append('project', 'default');
      try {
        const r = await fetch('/api/upload', {method:'POST', body: fd});
        const txt = await r.text();
        let d; try { d = JSON.parse(txt); } catch { throw new Error('non-JSON: '+txt.slice(0,200)); }
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        audioTrack = { filename: d.filename, url: d.url, kind: 'audio',
                       name: file.name, source: 'upload', file };
        renderMusicChip();
        syncVolumeVisibility();
        toast(`Music track ready: ${file.name}`, {kind:'success'});
      } catch (e) {
        console.warn('[music]', e);
        toast(`Music upload failed: ${e.message}`, {kind:'error', duration:5000});
      }
    });
    on($('music-clear'), 'click', () => {
      audioTrack = null;
      renderMusicChip();
      syncVolumeVisibility();
    });

    // -------- Volume slider wiring --------
    const volSlider = $('music-volume');
    const volLabel  = $('music-volume-val');
    function paintVolGradient() {
      if (!volSlider) return;
      volSlider.style.setProperty('--vol', (volSlider.value || 0) + '%');
    }
    on(volSlider, 'input', () => {
      if (volLabel) volLabel.textContent = volSlider.value;
      paintVolGradient();
    });
    paintVolGradient();

    // -------- Auto music: re-pick on style change --------
    // When user has chosen music = "Auto", changing the reel style should
    // also swap the catalogue track to match the new style.
    document.querySelectorAll('.opt-pills[data-group="style"] input').forEach(rad => {
      rad.addEventListener('change', async () => {
        if (selectedRadio('music') === 'auto') {
          await autoPickCatalogueTrack();
          syncVolumeVisibility();
        }
      });
    });

    // -------- Letterbox visibility tied to format --------
    // Letterbox bars only make sense on 16:9 — hide the toggle otherwise
    // (also matches the backend, which silently drops the flag on non-16:9).
    const syncLetterboxVisibility = () => {
      const wrap = $('opt-letterbox-wrap');
      const f = selectedRadio('format');
      if (!wrap) return;
      const show = (f === '16:9');
      wrap.style.display = show ? '' : 'none';
      if (!show && $('opt-letterbox')) $('opt-letterbox').checked = false;
    };
    document.querySelectorAll('.opt-pills[data-group="format"] input').forEach(rad => {
      rad.addEventListener('change', syncLetterboxVisibility);
    });
    syncLetterboxVisibility();

    // -------- Captions toggle (Sprint 5) --------
    // Show/hide the language+style selects under the toggle, and update
    // the cache-state label based on localStorage (set after a successful
    // model load in runCaptions()).
    try {
      whisperWarm = localStorage.getItem(CAPTIONS_CACHE_FLAG) === '1';
    } catch (_) {}
    updateCaptionsCacheLabel();
    on($('opt-captions'), 'change', () => {
      const cfg = $('captions-config');
      const on  = $('opt-captions').checked;
      if (cfg) cfg.hidden = !on;
    });

    // Initial paint
    renderFileGrid();
    refreshGenerateEnabled();
    syncCaptionsGroupVisibility();
  }

  // ---------- Music chip render ----------
  function renderMusicChip() {
    const chip = $('music-chosen');
    if (!chip) return;
    if (!audioTrack) { chip.hidden = true; return; }
    chip.hidden = false;
    if ($('music-name')) {
      const suffix = audioTrack.source === 'catalogue' ? ' (auto)' : '';
      $('music-name').textContent = '🎵 ' + (audioTrack.name || audioTrack.filename) + suffix;
    }
  }

  // ---------- Catalogue auto-pick ----------
  async function fetchCatalogue() {
    if (musicCatalogue) return musicCatalogue;
    try {
      const r = await fetch('/api/music/catalogue');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      musicCatalogue = Array.isArray(d.tracks) ? d.tracks : [];
    } catch (e) {
      console.warn('[catalogue]', e);
      musicCatalogue = [];
    }
    return musicCatalogue;
  }
  async function autoPickCatalogueTrack() {
    const tracks = await fetchCatalogue();
    if (!tracks.length) {
      toast('Music catalogue unavailable.', {kind:'error'});
      audioTrack = null;
      renderMusicChip();
      return;
    }
    const style = selectedRadio('style') || 'real_estate';
    const t = tracks.find(x => x.style === style) || tracks[0];
    audioTrack = {
      filename: null, catalogueUrl: t.url, kind: 'audio',
      name: t.name, source: 'catalogue',
    };
    renderMusicChip();
  }

  // ---------- Volume helpers ----------
  function getMusicVolume() {
    const v = parseInt($('music-volume')?.value || '85', 10);
    return Math.max(0, Math.min(100, isFinite(v) ? v : 85)) / 100;
  }
  function syncVolumeVisibility() {
    const wrap = $('music-volume-wrap');
    if (!wrap) return;
    const show = !!audioTrack;
    if (show && wrap.hidden) {
      wrap.hidden = false;
      if (G) G.fromTo(wrap, {height:0, opacity:0},
        {height:'auto', opacity:1, duration:0.22, ease:'power2.out',
          onComplete: () => { wrap.style.height = ''; }});
    } else if (!show && !wrap.hidden) {
      if (G) G.to(wrap, {height:0, opacity:0, duration:0.18, ease:'power2.in',
        onComplete: () => { wrap.hidden = true; wrap.style.height=''; wrap.style.opacity=''; }});
      else wrap.hidden = true;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
