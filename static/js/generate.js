// MotionCut — simplified one-shot UI.
// Upload → choose style → click Generate → watch progress → download.
// State is intentionally local-only: uploadedFiles[] in memory + the
// server's job tracker via /api/generate/<id>/status.
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
    const host = $('toast-host'); if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast' + (opts.kind ? ' toast-' + opts.kind : '');
    el.textContent = msg;
    host.appendChild(el);
    if (G) G.fromTo(el, {y:12, opacity:0}, {y:0, opacity:1, duration:0.25, ease:'power2.out'});
    setTimeout(() => {
      if (G) G.to(el, {y:-8, opacity:0, duration:0.25, ease:'power2.in', onComplete:() => el.remove()});
      else el.remove();
    }, opts.duration || 3200);
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

  async function uploadOne(file) {
    const kind = classifyKind(file.name);
    if (!kind) {
      toast(`Skipped ${file.name}: unsupported format`, {kind:'error'});
      return null;
    }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('kind', kind);
    fd.append('project', 'default');
    // We render an optimistic thumbnail right away from the local File
    // object — the upload happens in parallel and the meta swap is
    // invisible to the user.
    const localUrl = URL.createObjectURL(file);
    const placeholder = {
      filename: file.name, kind, url: null,
      localUrl, name: file.name, _uploading: true, duration: null,
    };
    uploadedFiles.push(placeholder);
    renderFileGrid();
    try {
      const r = await fetch('/api/upload', { method:'POST', body: fd });
      const txt = await r.text();
      let data; try { data = JSON.parse(txt); } catch { throw new Error('non-JSON upload response: ' + txt.slice(0,200)); }
      if (!r.ok) throw new Error(data.error || `upload failed (${r.status})`);
      placeholder.filename = data.filename;
      placeholder.url      = data.url;
      placeholder._uploading = false;
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
      toast(`Upload failed: ${file.name} — ${e.message}`, {kind:'error'});
      // Drop the placeholder so the grid doesn't lie.
      const i = uploadedFiles.indexOf(placeholder);
      if (i >= 0) uploadedFiles.splice(i, 1);
      renderFileGrid();
      return null;
    }
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
      const overlay = f._uploading ? '<div class="thumb-uploading">Uploading…</div>' : '';
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
    };
    if (body.duration === '' || body.duration === 'auto') body.duration = null;
    else if (body.duration) body.duration = parseInt(body.duration, 10);

    hideSection('section-upload');
    hideSection('section-options');
    hideSection('section-action');
    showSection('section-progress');
    setStep('analyzing');
    setProgress(0, 60);

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
    const order = ['analyzing','planning','rendering','done'];
    const reached = order.indexOf(name);
    document.querySelectorAll('.step').forEach((el) => {
      const i = order.indexOf(el.dataset.step);
      el.classList.toggle('is-done', i < reached || (reached === order.length - 1 && i === reached - 1));
      el.classList.toggle('is-active', i === reached);
    });
    const titles = {
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
    // Same uploadedFiles, fresh job.
    hideSection('section-result');
    generateVideo();
  }
  function changeStyle() {
    if (currentJobId) return;
    // Keep uploadedFiles; return to the picker.
    hideSection('section-result');
    showSection('section-upload');
    showSection('section-options');
    showSection('section-action');
  }

  // ---------- Init ----------
  function init() {
    console.log('%c[MC] generate build', 'color:#f0c040;font-weight:bold', '— upload → AI → download');
    startBuildPulse();

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
                       name: file.name, source: 'upload' };
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

    // Initial paint
    renderFileGrid();
    refreshGenerateEnabled();
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
