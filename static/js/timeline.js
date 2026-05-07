/* ================================================================
   MotionCut — Multi-track Timeline
   Premiere/CapCut hybrid · drag · trim · split · zoom · waveform
   Reads/mutates window.MC.editor (state, video, draw, etc.)
   ================================================================ */
(() => {
'use strict';

let api = null;       // { state, video, draw, renderInspector, renderLayersPanel, snapshot }
let pps = 40;         // pixels per second (zoom)
let activeTool = 'select';
let waveformDrawn = null;       // filename whose waveform is currently drawn
let rulerStep = 1;

const $ = (id) => document.getElementById(id);
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const escapeHTML = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtT = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
};
const refreshIcons = () => { try { window.lucide && window.lucide.createIcons(); } catch {} };

function getDuration() {
  // Multi-clip: timeline length = sum of segment durations minus crossfades.
  const segs = api?.state?.segments;
  if (segs && segs.length) return segs[segs.length - 1].timelineOut || 30;
  // Legacy single-clip fallback for projects loaded before segments existed.
  if (api?.state?.video && api.video?.duration) return api.video.duration;
  return 30;
}

// ============================================================
//  Build DOM
// ============================================================
function buildDOM() {
  const host = $('timeline-host');
  if (!host) return;
  host.innerHTML = `
    <div class="tl">
      <div class="tl-toolbar">
        <button class="tl-tbtn on" data-tool="select" title="Select (V)"><i data-lucide="mouse-pointer-2"></i></button>
        <button class="tl-tbtn"    data-tool="razor"  title="Split (S)"><i data-lucide="scissors"></i></button>
        <span class="tl-divider"></span>
        <button class="tl-tbtn" data-act="mark-in"     title="Set in (I)"><i data-lucide="log-in"></i></button>
        <button class="tl-tbtn" data-act="mark-out"    title="Set out (O)"><i data-lucide="log-out"></i></button>
        <button class="tl-tbtn" data-act="mark-clear"  title="Clear marks"><i data-lucide="rotate-ccw"></i></button>
        <span class="tl-divider"></span>
        <button class="tl-tbtn" data-act="snap-beat"   title="Snap to beats" id="tl-snap-beat"><i data-lucide="audio-waveform"></i></button>
        <button class="tl-tbtn" data-act="detect-beats" title="Detect beats"><i data-lucide="activity"></i></button>
        <span class="tl-divider"></span>
        <button class="tl-tbtn" data-act="zoom-out" title="Zoom out"><i data-lucide="zoom-out"></i></button>
        <button class="tl-tbtn" data-act="zoom-in"  title="Zoom in"><i data-lucide="zoom-in"></i></button>
        <button class="tl-tbtn" data-act="zoom-fit" title="Fit"><i data-lucide="maximize-2"></i></button>
        <span class="tl-divider"></span>
        <span class="tl-time mono" id="tl-time">00:00 / 00:00</span>
        <span class="tl-grow"></span>
        <span class="tl-hint muted small">Cmd+scroll zoom · S split · I/O marks</span>
      </div>
      <div class="tl-body">
        <div class="tl-headers">
          <div class="tl-ruler-spacer"></div>
          <div class="tl-header" data-kind="video"><i data-lucide="film"></i><span>Video</span></div>
          <div class="tl-header" data-kind="overlay"><i data-lucide="layers"></i><span>Overlays</span></div>
          <div class="tl-header" data-kind="audio"><i data-lucide="music-2"></i><span>Audio</span></div>
        </div>
        <div class="tl-area" id="tl-area">
          <div class="tl-canvas" id="tl-canvas">
            <div class="tl-ruler" id="tl-ruler"></div>
            <div class="tl-track" id="tl-track-video"   data-kind="video"></div>
            <div class="tl-track" id="tl-track-overlay" data-kind="overlay"></div>
            <div class="tl-track" id="tl-track-audio"   data-kind="audio">
              <canvas id="tl-waveform" class="tl-waveform"></canvas>
              <div class="tl-beats" id="tl-beats"></div>
            </div>
            <div class="tl-marks" id="tl-marks"></div>
            <div class="tl-playhead" id="tl-playhead"></div>
          </div>
        </div>
      </div>
    </div>`;
  refreshIcons();
}

// ============================================================
//  Render
// ============================================================
function render() {
  if (!api) return;
  const dur = getDuration();
  const w = Math.max(800, Math.ceil(dur * pps) + 40);
  const canvas = $('tl-canvas');
  if (!canvas) return;
  canvas.style.width = w + 'px';
  renderRuler(dur, w);
  renderVideoTrack(dur);
  renderOverlayTrack(dur);
  renderAudioTrack(dur);
  renderBeats(dur);
  renderMarks(dur);
  // Reflect snap-beat toggle state
  const sb = $('tl-snap-beat');
  if (sb) sb.classList.toggle('on', !!api.state.snapToBeat);
  updatePlayhead();
}

function renderBeats(dur) {
  const el = $('tl-beats');
  if (!el) return;
  const beats = api.state.beats || [];
  if (!beats.length) { el.innerHTML = ''; return; }
  el.innerHTML = beats.map(t =>
    `<div class="tl-beat" style="left:${t * pps}px"></div>`
  ).join('');
}

function renderMarks(dur) {
  const el = $('tl-marks');
  if (!el) return;
  const inM = api.state.inMark, outM = api.state.outMark;
  let html = '';
  if (inM != null && inM > 0) {
    html += `<div class="tl-mark tl-mark-in"  style="left:${inM * pps}px" title="In: ${inM.toFixed(2)}s">I</div>`;
    html += `<div class="tl-mark-shade left"  style="width:${inM * pps}px"></div>`;
  }
  if (outM != null && outM < dur) {
    html += `<div class="tl-mark tl-mark-out" style="left:${outM * pps}px" title="Out: ${outM.toFixed(2)}s">O</div>`;
    const right = (dur - outM) * pps;
    html += `<div class="tl-mark-shade right" style="left:${outM * pps}px;width:${right}px"></div>`;
  }
  el.innerHTML = html;
}

function renderRuler(dur, w) {
  const ruler = $('tl-ruler');
  if (!ruler) return;
  // Choose tick step based on zoom
  rulerStep = pps < 12 ? 10 : pps < 25 ? 5 : pps < 60 ? 2 : 1;
  let html = '';
  for (let s = 0; s <= dur; s += rulerStep) {
    const left = s * pps;
    const major = (s % (rulerStep * 5) === 0);
    html += `<div class="tl-tick ${major?'major':''}" style="left:${left}px">
      ${major ? `<span class="tl-tick-lbl mono">${fmtT(s)}</span>` : ''}
    </div>`;
  }
  ruler.innerHTML = html;
  ruler.style.width = w + 'px';
}

function renderVideoTrack(dur) {
  const tr = $('tl-track-video');
  if (!tr) return;
  const segs = api.state.segments || [];
  // Drop-target hint sits as a sibling so it can light up while drag-over.
  if (!segs.length) {
    if (!api.state.video) {
      tr.innerHTML = `<div class="tl-empty-track">Drop a video here, or drag from the library</div>`;
      return;
    }
    // Legacy projects: synthesize a virtual single segment from state.video so
    // the visual is consistent. Don't mutate state — just render.
    const w = dur * pps;
    tr.innerHTML = `
      <div class="tl-clip clip-video" data-kind="video" style="left:0px;width:${w}px">
        <i data-lucide="film"></i>
        <span class="tl-clip-name">${escapeHTML(displayVideoName())}</span>
        <span class="tl-clip-dur mono">${fmtT(dur)}</span>
      </div>`;
    refreshIcons();
    return;
  }
  // Multi-clip render. Each segment gets its own block; we add explicit
  // trim handles on the left/right edges. The thin divider between blocks
  // (the cut) is just two adjacent borders — no extra DOM needed.
  tr.innerHTML = segs.map((s, i) => {
    const left = s.timelineIn * pps;
    const w    = Math.max(8, (s.timelineOut - s.timelineIn) * pps);
    const sel  = (s.id === api.state.selectedSegmentId) ? 'is-selected' : '';
    const act  = (s.id === api.state.activeSegmentId)   ? 'is-active'   : '';
    const display = (s.filename || 'clip').replace(/^[a-f0-9]{6,16}_/, '').slice(0, 32);
    const trans = s.transition && s.transition.type !== 'cut' && i < segs.length - 1
      ? `<span class="tl-clip-trans" title="${escapeHTML(s.transition.type)} ${(+s.transition.duration||0).toFixed(2)}s"></span>` : '';
    return `
      <div class="tl-clip clip-segment ${sel} ${act}"
           data-seg-id="${escapeHTML(s.id)}"
           data-kind="${escapeHTML(s.kind || 'video')}"
           style="left:${left}px;width:${w}px">
        <span class="tl-trim tl-trim-left"  data-trim="left"></span>
        <i data-lucide="${s.kind === 'image' ? 'image' : 'film'}"></i>
        <span class="tl-clip-name">${escapeHTML(display)}</span>
        <span class="tl-clip-dur mono">${fmtT(s.timelineOut - s.timelineIn)}</span>
        <span class="tl-trim tl-trim-right" data-trim="right"></span>
        ${trans}
      </div>`;
  }).join('');
  refreshIcons();
}
function displayVideoName() {
  const f = api.state.video?.filename || 'video';
  return f.replace(/^[a-f0-9]{6,16}_/, '').slice(0, 36);
}

function renderOverlayTrack(dur) {
  const tr = $('tl-track-overlay');
  if (!tr) return;
  const layers = api.state.layers || [];
  if (!layers.length) {
    tr.innerHTML = `<div class="tl-empty-track">Add a text, logo, or overlay layer</div>`;
    return;
  }
  // Lay out overlays — use vertical sub-tracks if they overlap (greedy packing)
  const rows = [];
  const placed = layers.map(l => {
    const s = clamp(l.start, 0, dur);
    const e = clamp(l.end > 9000 ? dur : l.end, s + 0.1, dur);
    let row = 0;
    while (rows[row] && rows[row].some(([rs, re]) => !(e <= rs || s >= re))) row++;
    rows[row] = rows[row] || []; rows[row].push([s, e]);
    return { l, s, e, row };
  });
  const rowH = 28;
  const totalH = Math.max(36, rows.length * rowH + 4);
  tr.style.height = totalH + 'px';

  // Detect overlaps in same sub-row → render a crossfade hatch overlay between them
  const xfades = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      if (a.row !== b.row) continue;
      const ovStart = Math.max(a.s, b.s);
      const ovEnd   = Math.min(a.e, b.e);
      if (ovEnd > ovStart + 0.05) {
        xfades.push({ s: ovStart, e: ovEnd, row: a.row });
      }
    }
  }

  let html = placed.map(({ l, s, e, row }) => {
    const left = s * pps;
    const width = Math.max(6, (e - s) * pps);
    const isSel = api.state.selectedIds?.has(l.id) || api.state.selectedId === l.id;
    const sel = isSel ? 'selected' : '';
    const hidden = !l.visible ? 'is-hidden' : '';
    const locked = l.locked ? 'is-locked' : '';
    const icon = l.type === 'text' ? 'type' : l.type === 'logo' ? 'image' : 'square';
    const top = 4 + row * rowH;
    return `
      <div class="tl-clip clip-${l.type} ${sel} ${hidden} ${locked}" data-id="${l.id}"
           style="left:${left}px; width:${width}px; top:${top}px;"
           title="${escapeHTML(l.name||l.type)} · ${s.toFixed(2)}s → ${e.toFixed(2)}s">
        <div class="tl-trim left"  data-trim="left"></div>
        <i data-lucide="${icon}"></i>
        <span class="tl-clip-name">${escapeHTML(l.name||l.type)}</span>
        <div class="tl-trim right" data-trim="right"></div>
      </div>`;
  }).join('');

  // Crossfade hatched zones (drawn above clips for the visual cue)
  html += xfades.map(x => {
    const left = x.s * pps;
    const width = Math.max(2, (x.e - x.s) * pps);
    const top = 4 + x.row * rowH;
    return `<div class="tl-xfade" style="left:${left}px;width:${width}px;top:${top}px"
                title="Crossfade · ${(x.e - x.s).toFixed(2)}s">
              <i data-lucide="git-merge"></i>
            </div>`;
  }).join('');

  tr.innerHTML = html;
  refreshIcons();
  // Keyframe diamond markers on each clip
  tr.querySelectorAll('.tl-clip[data-id]').forEach(clipEl => {
    const id = clipEl.dataset.id;
    const layer = api.state.layers.find(L => L.id === id);
    if (!layer || !layer.kf) return;
    const s = clamp(layer.start, 0, dur);
    const e = clamp(layer.end > 9000 ? dur : layer.end, s + 0.1, dur);
    const allTimes = new Set();
    for (const prop of Object.keys(layer.kf)) {
      for (const k of layer.kf[prop]) {
        if (k.t >= s - 0.001 && k.t <= e + 0.001) allTimes.add(Math.round(k.t * 100) / 100);
      }
    }
    const left0 = s * pps;
    for (const kt of allTimes) {
      const dot = document.createElement('div');
      dot.className = 'tl-kf-dot';
      dot.style.left = ((kt * pps) - left0) + 'px';
      dot.title = `Keyframe @ ${kt.toFixed(2)}s`;
      clipEl.appendChild(dot);
    }
  });
}

function renderAudioTrack(dur) {
  const tr = $('tl-track-audio');
  if (!tr) return;
  const cv = $('tl-waveform');
  if (!api.state.audio) {
    tr.style.background = '';
    if (cv) {
      const ctx = cv.getContext('2d');
      cv.width = 1; cv.height = 1; ctx.clearRect(0,0,1,1);
    }
    waveformDrawn = null;
    // Empty
    if (!tr.querySelector('.tl-empty-track')) {
      tr.insertAdjacentHTML('beforeend', `<div class="tl-empty-track">Drop music in the rail to add audio</div>`);
    }
    return;
  }
  // Remove empty hint
  tr.querySelector('.tl-empty-track')?.remove();
  const audDur = api.state.audio.duration || dur;
  const w = audDur * pps;
  if (cv) {
    const dpr = window.devicePixelRatio || 1;
    cv.style.width = w + 'px';
    cv.style.height = '36px';
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(36 * dpr));
  }
  // Decode + draw if new audio
  if (waveformDrawn !== api.state.audio.url) {
    drawWaveform(api.state.audio.url, cv);
    waveformDrawn = api.state.audio.url;
  } else if (cv) {
    // Re-blit cached?
    drawWaveform(api.state.audio.url, cv);  // re-fetch on resize
  }
}

// ============================================================
//  Audio waveform via Web Audio API
// ============================================================
const _wfCache = new Map();   // url → Float32Array peaks
async function drawWaveform(url, canvas) {
  if (!canvas) return;
  let peaks = _wfCache.get(url);
  if (!peaks) {
    try {
      const buf = await fetch(url).then(r => r.arrayBuffer());
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const decoded = await ac.decodeAudioData(buf);
      const ch = decoded.getChannelData(0);
      const pCount = 2000;
      const block = Math.max(1, Math.floor(ch.length / pCount));
      peaks = new Float32Array(pCount);
      for (let i = 0; i < pCount; i++) {
        let max = 0;
        const start = i * block;
        const end = Math.min(ch.length, start + block);
        for (let j = start; j < end; j++) {
          const v = Math.abs(ch[j]);
          if (v > max) max = v;
        }
        peaks[i] = max;
      }
      _wfCache.set(url, peaks);
      try { ac.close(); } catch {}
    } catch (e) {
      console.warn('[timeline] waveform decode failed', e);
      return;
    }
  }
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(240,192,64,0.85)');
  grad.addColorStop(1, 'rgba(240,192,64,0.35)');
  ctx.fillStyle = grad;
  const mid = H / 2;
  const pCount = peaks.length;
  for (let x = 0; x < W; x++) {
    const i = Math.floor((x / W) * pCount);
    const amp = peaks[i] * (H * 0.45);
    ctx.fillRect(x, mid - amp, 1, amp * 2);
  }
}

// ============================================================
//  Playhead
// ============================================================
function updatePlayhead() {
  const head = $('tl-playhead');
  const time = $('tl-time');
  if (!head || !api?.video) return;
  const t = api.video.currentTime || 0;
  head.style.left = (t * pps) + 'px';
  if (time) time.textContent = `${fmtT(t)} / ${fmtT(getDuration())}`;
}

// ============================================================
//  Interactions
// ============================================================
function setTool(tool) {
  activeTool = tool;
  document.querySelectorAll('.tl-tbtn[data-tool]').forEach(b =>
    b.classList.toggle('on', b.dataset.tool === tool));
  const area = $('tl-area');
  if (area) area.style.cursor = tool === 'razor' ? 'crosshair' : '';
}

function setZoom(newPps, anchorClientX) {
  const area = $('tl-area');
  if (!area) return;
  const oldPps = pps;
  pps = clamp(newPps, 4, 400);
  // Keep the time under the cursor stable
  if (anchorClientX != null) {
    const rect = area.getBoundingClientRect();
    const scrollLeft = area.scrollLeft;
    const xInArea = anchorClientX - rect.left + scrollLeft;
    const tAtCursor = xInArea / oldPps;
    render();
    area.scrollLeft = (tAtCursor * pps) - (anchorClientX - rect.left);
  } else {
    render();
  }
}

function bindEvents() {
  // Toolbar
  document.querySelectorAll('.tl-tbtn[data-tool]').forEach(b => {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });
  document.querySelectorAll('.tl-tbtn[data-act]').forEach(b => {
    b.addEventListener('click', () => {
      const a = b.dataset.act;
      const area = $('tl-area');
      if (a === 'zoom-in')  setZoom(pps * 1.4);
      if (a === 'zoom-out') setZoom(pps / 1.4);
      if (a === 'zoom-fit') {
        const w = area.clientWidth - 40;
        setZoom(w / Math.max(1, getDuration()));
      }
      if (a === 'mark-in')    api?.setInMark?.();
      if (a === 'mark-out')   api?.setOutMark?.();
      if (a === 'mark-clear') api?.clearMarks?.();
      if (a === 'detect-beats') {
        if (api.state.audio) api.detectBeats(api.state.audio.url);
      }
      if (a === 'snap-beat') {
        api.state.snapToBeat = !api.state.snapToBeat;
        b.classList.toggle('on', api.state.snapToBeat);
      }
    });
  });

  const area = $('tl-area');
  if (!area) return;

  // Mouse interactions on the canvas
  area.addEventListener('mousedown', onAreaMouseDown);

  // Wheel = scroll horizontally; Cmd/Ctrl+wheel = zoom
  area.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(pps * (e.deltaY < 0 ? 1.10 : 1/1.10), e.clientX);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // Horizontal scroll already handled by browser if deltaX
    } else {
      // Convert vertical wheel to horizontal scroll for convenience
      area.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  // Keyboard tool shortcuts
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName==='INPUT' || t.tagName==='TEXTAREA' || t.tagName==='SELECT')) return;
    if (e.key === 'v' || e.key === 'V') setTool('select');
    if (e.key === 's' || e.key === 'S') setTool(activeTool === 'razor' ? 'select' : 'razor');
  });
}

function clientToTime(clientX) {
  const area = $('tl-area');
  const rect = area.getBoundingClientRect();
  const x = clientX - rect.left + area.scrollLeft;
  return Math.max(0, x / pps);
}

function onAreaMouseDown(e) {
  if (e.button === 2) return;
  const t = clientToTime(e.clientX);

  // Razor mode
  if (activeTool === 'razor') {
    const clipEl = e.target.closest('.tl-clip[data-id]');
    if (clipEl) splitLayerAt(clipEl.dataset.id, t);
    return;
  }

  // Trim handle?
  const trim = e.target.closest('.tl-trim');
  if (trim) {
    const clipEl = trim.closest('.tl-clip[data-id]');
    if (clipEl) {
      api.state.selectedId = clipEl.dataset.id;
      api.renderInspector(); api.renderLayersPanel(); api.draw();
      startTrimDrag(clipEl.dataset.id, trim.dataset.trim, e);
    }
    e.stopPropagation();
    return;
  }

  // Clip body → select + drag
  const clipEl = e.target.closest('.tl-clip[data-id]');
  if (clipEl) {
    api.state.selectedId = clipEl.dataset.id;
    api.renderInspector(); api.renderLayersPanel(); api.draw();
    render();
    startMoveDrag(clipEl.dataset.id, e);
    return;
  }

  // Empty space → scrub
  api.video.currentTime = clamp(t, 0, getDuration());
  startScrubDrag();
}

function startMoveDrag(id, e) {
  const layer = api.state.layers.find(L => L.id === id);
  if (!layer || layer.locked) return;
  const startX = e.clientX;
  const startStart = layer.start;
  const dur = (layer.end > 9000 ? getDuration() : layer.end) - layer.start;
  document.body.style.cursor = 'grabbing';

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const dt = dx / pps;
    let newStart = Math.max(0, startStart + dt);
    // Snap to integer seconds when close
    const snapT = Math.round(newStart);
    if (Math.abs(snapT - newStart) * pps < 6) newStart = snapT;
    // Snap to playhead
    const ph = api.video.currentTime || 0;
    if (Math.abs(ph - newStart) * pps < 8) newStart = ph;
    // Snap to beats if enabled
    if (api.state.snapToBeat && api.state.beats?.length) {
      let best = null, bd = Infinity;
      for (const b of api.state.beats) {
        const d = Math.abs(b - newStart);
        if (d < bd) { bd = d; best = b; }
      }
      if (best != null && bd * pps < 12) newStart = best;
    }
    layer.start = newStart;
    layer.end = layer.start + dur;
    render(); api.draw();
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    api.snapshot();
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function startTrimDrag(id, side, e) {
  const layer = api.state.layers.find(L => L.id === id);
  if (!layer || layer.locked) return;
  const startX = e.clientX;
  const startStart = layer.start;
  const startEnd = (layer.end > 9000) ? getDuration() : layer.end;
  document.body.style.cursor = 'col-resize';

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const dt = dx / pps;
    if (side === 'left') {
      layer.start = clamp(startStart + dt, 0, (startEnd - 0.2));
    } else {
      const newEnd = clamp(startEnd + dt, layer.start + 0.2, getDuration());
      layer.end = newEnd;
    }
    render(); api.draw();
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    api.snapshot();
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function startScrubDrag() {
  const onMove = (ev) => {
    const t = clientToTime(ev.clientX);
    api.video.currentTime = clamp(t, 0, getDuration());
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function splitLayerAt(id, t) {
  const layer = api.state.layers.find(L => L.id === id);
  if (!layer) return;
  const end = layer.end > 9000 ? getDuration() : layer.end;
  if (t <= layer.start + 0.05 || t >= end - 0.05) return;
  // Clone layer
  const clone = JSON.parse(JSON.stringify({ ...layer, img: undefined }));
  clone.id = Math.random().toString(36).slice(2, 10);
  clone.name = (layer.name || 'Layer') + ' ʙ';
  clone.start = t;
  clone.end = end;
  layer.end = t;
  if (layer.img) clone.img = layer.img;
  api.state.layers.push(clone);
  api.snapshot();
  render(); api.renderLayersPanel(); api.draw();
}

// ============================================================
//  Segment interactions (multi-clip video track)
// ============================================================
let segDrag = null;       // { id, side: 'left'|'right', startX, startSourceIn, startSourceOut }

function bindSegmentEvents() {
  const tr = $('tl-track-video');
  if (!tr) return;

  // Click on a segment body = select. Click on a trim handle starts a drag.
  tr.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('.tl-trim');
    const clip   = e.target.closest('.clip-segment');
    if (!clip) return;
    const id = clip.dataset.segId;
    const seg = api.state.segments.find(s => s.id === id);
    if (!seg) return;

    if (handle) {
      e.preventDefault(); e.stopPropagation();
      segDrag = {
        id, side: handle.dataset.trim,
        startX: e.clientX,
        startSourceIn:  seg.sourceIn,
        startSourceOut: seg.sourceOut,
      };
      window.addEventListener('mousemove', onSegDragMove);
      window.addEventListener('mouseup',   onSegDragUp);
      return;
    }
    // Plain body click: select + jump playhead to segment start
    e.stopPropagation();
    api.state.selectedSegmentId = id;
    api.video.currentTime = seg.timelineIn + 0.001;
    render();
    api.draw();
  });

  // Right-click context menu: remove segment.
  tr.addEventListener('contextmenu', (e) => {
    const clip = e.target.closest('.clip-segment');
    if (!clip) return;
    e.preventDefault();
    const id = clip.dataset.segId;
    showSegmentMenu(e.clientX, e.clientY, id);
  });

  // Library drag-to-track. Highlight on dragover, append on drop.
  tr.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !hasLibraryPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    tr.classList.add('drag-over');
  });
  tr.addEventListener('dragleave', () => tr.classList.remove('drag-over'));
  tr.addEventListener('drop', (e) => {
    tr.classList.remove('drag-over');
    if (!e.dataTransfer) return;
    let payload = null;
    try { payload = JSON.parse(e.dataTransfer.getData('application/x-motioncut-lib') || 'null'); } catch {}
    if (!payload) return;
    e.preventDefault();
    const meta = {
      filename: payload.filename, url: payload.url,
      kind: payload.kind, duration: payload.duration || 0,
    };
    if (meta.kind === 'video') {
      api.appendSegment?.({
        filename: meta.filename, url: meta.url, kind: 'video',
        sourceIn: 0,
        sourceOut: meta.duration > 0 ? meta.duration : 9999,
        _duration: meta.duration || 0,
      });
    } else if (meta.kind === 'image') {
      // Stills get a default 3s on the timeline; user can trim from the right edge.
      api.appendSegment?.({
        filename: meta.filename, url: meta.url, kind: 'image',
        sourceIn: 0, sourceOut: 3, _duration: 3,
      });
    }
    render();
    api.draw();
  });
}

function hasLibraryPayload(dt) {
  return Array.from(dt.types || []).includes('application/x-motioncut-lib');
}

function onSegDragMove(e) {
  if (!segDrag) return;
  const seg = api.state.segments.find(s => s.id === segDrag.id);
  if (!seg) return;
  const dx = (e.clientX - segDrag.startX) / pps;     // px → seconds
  if (segDrag.side === 'left') {
    // Adjust source-in (head trim). Block from inverting the segment.
    seg.sourceIn = Math.max(0, Math.min(segDrag.startSourceIn + dx, seg.sourceOut - 0.1));
  } else {
    // Adjust source-out (tail trim). Don't go below 0.1s clip length.
    const maxOut = (seg._duration && seg._duration > 0) ? seg._duration : 99999;
    seg.sourceOut = Math.min(maxOut, Math.max(segDrag.startSourceOut + dx, seg.sourceIn + 0.1));
  }
  reflowSegmentsInState();
  render();
}

function onSegDragUp() {
  window.removeEventListener('mousemove', onSegDragMove);
  window.removeEventListener('mouseup',   onSegDragUp);
  if (segDrag) {
    api.snapshot();
    // If the active segment got trimmed past the playhead, snap the playhead inside it.
    const seg = api.state.segments.find(s => s.id === segDrag.id);
    if (seg && api.video) {
      const t = api.video.currentTime || 0;
      if (t < seg.timelineIn) api.video.currentTime = seg.timelineIn + 0.001;
      else if (t > seg.timelineOut) api.video.currentTime = seg.timelineOut - 0.001;
    }
  }
  segDrag = null;
}

function reflowSegmentsInState() {
  // Segments live in editor.js; reflow is an editor helper exposed via api.
  if (typeof api.reflowSegments === 'function') {
    api.reflowSegments(api.state.segments);
  }
}

function showSegmentMenu(x, y, segId) {
  // Lightweight inline context menu — no extra DOM globals needed.
  const old = document.getElementById('tl-seg-menu');
  if (old) old.remove();
  const menu = document.createElement('div');
  menu.id = 'tl-seg-menu';
  menu.className = 'tl-seg-menu';
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  menu.innerHTML = `
    <button data-act="remove"><i data-lucide="trash-2"></i> Remove clip</button>
    <button data-act="set-in"><i data-lucide="log-in"></i> Set in here</button>
    <button data-act="set-out"><i data-lucide="log-out"></i> Set out here</button>
  `;
  document.body.appendChild(menu);
  refreshIcons();
  const close = () => { menu.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
  menu.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    const seg = api.state.segments.find(s => s.id === segId);
    if (!seg) return;
    if (act === 'remove') api.removeSegment?.(segId);
    if (act === 'set-in') {
      // Set in-point at the current playhead, mapped to source time.
      const t = api.video?.currentTime || 0;
      const offset = clamp(t - seg.timelineIn, 0, seg.sourceOut - seg.sourceIn - 0.1);
      seg.sourceIn = seg.sourceIn + offset;
      reflowSegmentsInState(); api.snapshot(); render(); api.draw();
    }
    if (act === 'set-out') {
      const t = api.video?.currentTime || 0;
      const offset = clamp(t - seg.timelineIn, 0.1, seg.sourceOut - seg.sourceIn);
      seg.sourceOut = seg.sourceIn + offset;
      reflowSegmentsInState(); api.snapshot(); render(); api.draw();
    }
  });
}

// ============================================================
//  Live playhead loop (independent — light)
// ============================================================
function startPlayheadLoop() {
  let lastT = -1;
  const tick = () => {
    if (api?.video) {
      const t = api.video.currentTime || 0;
      // Multi-clip: if the playhead crossed a cut, swap the source video.
      maybeSwapSegment(t);
      if (Math.abs(t - lastT) > 0.01) {
        updatePlayhead();
        lastT = t;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let _lastActiveSegId = null;
function maybeSwapSegment(t) {
  const segs = api?.state?.segments;
  if (!segs || !segs.length || !api.segmentAt) return;
  const { seg, st } = api.segmentAt(t);
  if (!seg) return;
  if (seg.id !== _lastActiveSegId) {
    _lastActiveSegId = seg.id;
    api.activateSegment?.(seg, st);
    render();
  }
}

// ============================================================
//  Public API
// ============================================================
function init(consumerApi) {
  api = consumerApi;
  buildDOM();
  bindEvents();
  bindSegmentEvents();
  // Auto-fit when a video loads
  api.video?.addEventListener('loadedmetadata', () => {
    setTimeout(() => {
      const area = $('tl-area');
      if (area) setZoom((area.clientWidth - 40) / Math.max(1, getDuration()));
    }, 50);
  });
  render();
  startPlayheadLoop();
}

window.MC = window.MC || {};
window.MC.timeline = { init, render, setZoom, setTool };

})();
