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
          <div class="tl-header" data-kind="video">
            <i data-lucide="film"></i><span>Video</span>
            <button class="tl-header-act" id="tl-clear-video" title="Clear all clips from the timeline" type="button">
              <i data-lucide="x"></i>
            </button>
          </div>
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
      <!-- Discoverability CTA: lives OUTSIDE .tl-body so the grid (headers
           column + area column) doesn't constrain its width to one column.
           Only shown when segments exist; clicking it triggers the
           existing Magic Edit flow (same as topbar btn-magic). -->
      <div class="tl-magic-cta hidden" id="tl-magic-cta">
        <button class="cta-magic" id="tl-cta-magic" type="button">
          <i data-lucide="sparkles"></i>
          <span class="cta-label">Generate AI Edit</span>
          <span class="cta-meta mono"></span>
        </button>
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
  renderMagicCta();
  renderClearTimelineBtn();
  // Reflect snap-beat toggle state
  const sb = $('tl-snap-beat');
  if (sb) sb.classList.toggle('on', !!api.state.snapToBeat);
  updatePlayhead();
}

function renderMagicCta() {
  const cta = $('tl-magic-cta');
  if (!cta) return;
  const segs = (api?.state?.segments || []).filter(s => s.kind === 'video');
  if (!segs.length) { cta.classList.add('hidden'); return; }
  cta.classList.remove('hidden');
  const meta = cta.querySelector('.cta-meta');
  if (meta) meta.textContent = `from ${segs.length} clip${segs.length > 1 ? 's' : ''}`;
  refreshIcons();
}

function renderClearTimelineBtn() {
  const btn = $('tl-clear-video');
  if (!btn) return;
  const has = (api?.state?.segments?.length || 0) > 0;
  btn.classList.toggle('hidden', !has);
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
  // Multi-track render: group segments by their `track` field and render
  // each track as its own row inside .tl-track-video. Each row gets a
  // colour-cycled block at its timelineIn/timelineOut. User drags the
  // body horizontally to reposition (handler in bindSegmentEvents).
  const COLOR_COUNT = 5;
  const trackIds = [...new Set(segs.map(s => +s.track || 0))].sort((a, b) => a - b);
  // Match the .tl-header height (36 px) so the left-rail labels line up
  // perfectly with each row — was 32 before, which caused the visual
  // misalignment the user reported (rows appeared to bleed into the
  // OVERLAYS / AUDIO header rows).
  const ROW_H = 36;
  tr.style.height = `${Math.max(ROW_H, trackIds.length * ROW_H)}px`;
  // CapCut/DaVinci-style multi-track labels: keep the existing "Video"
  // header at row 0 (it owns the Clear button + click listener) and
  // inject V2 / V3 / … siblings ONLY when we actually have more than
  // one row. This way we don't have to re-bind the Clear handler on
  // every render. The injected siblings carry the .video-sub class so
  // we can remove + recreate them cleanly.
  const headerCol = document.querySelector('.tl-headers');
  if (headerCol) {
    headerCol.querySelectorAll('.tl-header.video-sub').forEach(el => el.remove());
    const headV1 = headerCol.querySelector('.tl-header[data-kind="video"]');
    if (headV1) {
      if (trackIds.length > 1) {
        headV1.classList.add('video-multi');
        headV1.style.height = ROW_H + 'px';
        // Renumber V1 in place (icon kept).
        const v1Label = headV1.querySelector('span');
        if (v1Label) v1Label.textContent = 'V1';
        let prev = headV1;
        for (let i = 1; i < trackIds.length; i++) {
          const sub = document.createElement('div');
          sub.className = 'tl-header video-sub';
          sub.style.height = ROW_H + 'px';
          sub.innerHTML = `<i data-lucide="film"></i><span>V${i + 1}</span>`;
          prev.parentNode.insertBefore(sub, prev.nextSibling);
          prev = sub;
        }
      } else {
        headV1.classList.remove('video-multi');
        headV1.style.height = '';
        const v1Label = headV1.querySelector('span');
        // Restore the single-track label from i18n if available.
        if (v1Label) v1Label.textContent = window.MC?.i18n?.t?.('tl.video') || 'Video';
      }
    }
  }
  tr.innerHTML = trackIds.map((trackId, rowIdx) => {
    const rowSegs = segs.filter(s => (+s.track || 0) === trackId);
    const blocks = rowSegs.map(s => {
      const left = s.timelineIn * pps;
      const w    = Math.max(8, (s.timelineOut - s.timelineIn) * pps);
      const sel  = (s.id === api.state.selectedSegmentId) ? 'is-selected' : '';
      const act  = (s.id === api.state.activeSegmentId)   ? 'is-active'   : '';
      const colorClass = `clip-c${trackId % COLOR_COUNT}`;
      const display = (s.filename || 'clip').replace(/^[a-f0-9]{6,16}_/, '').slice(0, 32);
      return `
        <div class="tl-clip clip-segment ${colorClass} ${sel} ${act}"
             data-seg-id="${escapeHTML(s.id)}"
             data-kind="${escapeHTML(s.kind || 'video')}"
             data-track="${trackId}"
             style="left:${left}px;width:${w}px">
          <span class="tl-trim tl-trim-left"  data-trim="left"></span>
          <i data-lucide="${s.kind === 'image' ? 'image' : 'film'}"></i>
          <span class="tl-clip-name">${escapeHTML(display)}</span>
          <span class="tl-clip-dur mono">${fmtT(s.timelineOut - s.timelineIn)}</span>
          <span class="tl-trim tl-trim-right" data-trim="right"></span>
        </div>`;
    }).join('');
    return `
      <div class="tl-row" data-track="${trackId}" style="top:${rowIdx * ROW_H}px;height:${ROW_H}px">
        ${blocks}
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

  // Wheel handler at the *panel* level (the whole .tl, not just the
  // tracks-area). User reported Cmd+scroll didn't work — the cause was
  // hovering over the track header column or the toolbar where the
  // listener wasn't bound. Now anywhere on the timeline panel works.
  // We still need passive:false to be allowed to preventDefault().
  const tlPanel = document.querySelector('.tl') || area;
  tlPanel.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      // Cmd/Ctrl + wheel = zoom timeline (anchor to cursor X).
      e.preventDefault();
      e.stopPropagation();   // don't let the browser also zoom the page
      setZoom(pps * (e.deltaY < 0 ? 1.10 : 1/1.10), e.clientX);
      return;
    }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    // Plain vertical wheel inside the tracks area = horizontal scroll.
    if (area.contains(e.target)) {
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
let segDrag = null;       // trim drag: { id, side: 'left'|'right', startX, startSourceIn, startSourceOut }
let segMove = null;       // body drag: { id, startX, startTimelineIn, moved }

function bindSegmentEvents() {
  const tr = $('tl-track-video');
  if (!tr) return;

  // Mousedown on a segment: trim handle vs body. Trim handles start a
  // resize drag immediately. Body starts a *potential* move drag — we
  // only flip into "moving" mode when the cursor travels >3 px so a
  // simple click still selects + jumps the playhead.
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
    // Body: prepare a potential move drag.
    e.stopPropagation();
    segMove = {
      id, startX: e.clientX,
      startTimelineIn: seg.timelineIn,
      moved: false,
    };
    window.addEventListener('mousemove', onSegMoveMove);
    window.addEventListener('mouseup',   onSegMoveUp);
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
  // Diagnostics: console.log lines below let you verify the path in DevTools
  // when something stops working — they're cheap and useful in the field.
  tr.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !hasLibraryPayload(e.dataTransfer)) return;
    e.preventDefault();
    tr.classList.add('drag-over');
  });
  tr.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !hasLibraryPayload(e.dataTransfer)) return;
    e.preventDefault();   // critical: without this, drop never fires
    e.dataTransfer.dropEffect = 'copy';
    tr.classList.add('drag-over');
  });
  // dragleave fires when crossing into a child too — only clear the highlight
  // if the pointer actually exits the track box.
  tr.addEventListener('dragleave', (e) => {
    const r = tr.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      tr.classList.remove('drag-over');
    }
  });
  tr.addEventListener('drop', async (e) => {
    tr.classList.remove('drag-over');
    if (!e.dataTransfer) return;
    const payload = readLibraryPayload(e.dataTransfer);
    console.log('[MC] drop received', payload);
    if (!payload) return;
    e.preventDefault();
    await appendFromLibraryPayload(payload);
  });
}

/**
 * Shared "given this library payload, append a segment" path. Used by both
 * the drag-drop handler above and the click-to-add fallback in the library
 * panel. Centralised so they can never drift out of sync.
 */
async function appendFromLibraryPayload(payload) {
  if (!payload || !payload.filename) return;
  let dur = +payload.duration || 0;
  if (payload.kind === 'video' && dur <= 0) {
    // Library row didn't carry a duration — ask the backend to probe so
    // the new segment doesn't render with a sentinel 9999 width.
    try {
      const r = await fetch('/api/probe', {
        method: 'POST', headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ project: api.state.project, filename: payload.filename }),
      });
      if (r.ok) dur = +(await r.json()).duration || 0;
    } catch {}
  }
  if (payload.kind === 'video') {
    api.appendSegment?.({
      filename: payload.filename, url: payload.url, kind: 'video',
      sourceIn: 0, sourceOut: dur > 0 ? dur : 5,
      _duration: dur || 5,
    });
  } else if (payload.kind === 'image') {
    // Stills get a default 3s on the timeline; user can trim from the right edge.
    api.appendSegment?.({
      filename: payload.filename, url: payload.url, kind: 'image',
      sourceIn: 0, sourceOut: 3, _duration: 3,
    });
  }
  render();
  api.draw();
  try { await window.MC?.project?.save?.(api.state); } catch {}
}

function hasLibraryPayload(dt) {
  // Some browsers normalize the MIME, some don't. Accept either the custom
  // MIME or the text/plain fallback we set alongside.
  const types = Array.from(dt.types || []).map(s => (s || '').toLowerCase());
  return types.includes('application/x-motioncut-lib') || types.includes('text/plain');
}
function readLibraryPayload(dt) {
  for (const mime of ['application/x-motioncut-lib', 'text/plain']) {
    const raw = dt.getData(mime);
    if (!raw) continue;
    try {
      const p = JSON.parse(raw);
      if (p && p.filename && p.kind) return p;
    } catch {}
  }
  return null;
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

// Body drag — repositions the segment in time (timelineIn).
// Click without movement still selects + jumps the playhead.
function onSegMoveMove(e) {
  if (!segMove) return;
  const seg = api.state.segments.find(s => s.id === segMove.id);
  if (!seg) return;
  const dxPx = e.clientX - segMove.startX;
  if (Math.abs(dxPx) < 3 && !segMove.moved) return;        // dead-zone before promoting to drag
  segMove.moved = true;
  const dxSec = dxPx / pps;
  const dur = seg.sourceOut - seg.sourceIn;
  seg.timelineIn  = Math.max(0, segMove.startTimelineIn + dxSec);
  seg.timelineOut = seg.timelineIn + dur;
  // Keep cursor as a grab affordance during drag.
  document.body.style.cursor = 'grabbing';
  render();
}

function onSegMoveUp() {
  window.removeEventListener('mousemove', onSegMoveMove);
  window.removeEventListener('mouseup',   onSegMoveUp);
  document.body.style.cursor = '';
  if (!segMove) return;
  if (segMove.moved) {
    // Real drag finished: snapshot so undo works.
    reflowSegmentsInState();
    api.snapshot();
    render();
  } else {
    // No movement: treat as a click → select + seek.
    api.state.selectedSegmentId = segMove.id;
    const seg = api.state.segments.find(s => s.id === segMove.id);
    if (seg && api.video) {
      try { api.video.currentTime = seg.timelineIn + 0.001; } catch {}
    }
    render();
    api.draw?.();
  }
  segMove = null;
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
    <button data-act="remove"><i data-lucide="trash-2"></i> Remove from timeline</button>
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
      // Auto-advance across segment boundaries while playing.
      checkSegmentBoundary();
      if (Math.abs(t - lastT) > 0.01) {
        updatePlayhead();
        lastT = t;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let _lastBoundaryCheck = 0;
let _advancing = false;
/**
 * While the user is playing back, watch for the active segment reaching
 * its sourceOut and jump to the next segment in timeline order.
 *
 * The previous implementation (maybeSwapSegment) called segmentAt(t) with
 * t = video.currentTime — but currentTime is local to the active source
 * file (clamped 0..duration). That worked when every segment shared a
 * single track and chained end-to-end (timeline-time == currentTime then),
 * but broke as soon as the user put clips on separate tracks: video 1
 * ended at currentTime=12, never reached video 2's timelineIn=15, and
 * playback froze.
 *
 * New approach: drive advancement off the SEGMENT'S sourceOut, not the
 * timeline. When playing the active segment hits its trim-out, we look
 * up the next segment by its timelineIn and call activateSegment().
 */
function checkSegmentBoundary() {
  // Throttle — every frame is overkill, ~10 Hz catches every realistic cut.
  const now = performance.now();
  if (now - _lastBoundaryCheck < 100) return;
  _lastBoundaryCheck = now;

  const segs = api?.state?.segments;
  if (!segs || !segs.length) return;
  if (!api.video || api.video.paused || api.video.ended || _advancing) return;

  const cur = segs.find(s => s.id === api.state.activeSegmentId);
  if (!cur) return;
  // Hit the trim-out (sourceOut) of the active segment? Time to advance.
  // 0.05s slack so we don't overshoot the last frame of the clip.
  if (api.video.currentTime + 0.05 < cur.sourceOut) return;

  // Advance to the next segment in timeline order. Multi-track: pick the
  // segment with the smallest timelineIn ≥ cur.timelineOut. If none,
  // playback is over — pause cleanly.
  const sorted = [...segs].sort((a, b) =>
    (a.timelineIn - b.timelineIn) || ((+a.track || 0) - (+b.track || 0))
  );
  const idx = sorted.findIndex(s => s.id === cur.id);
  const next = sorted[idx + 1];
  if (!next) {
    api.video.pause();
    return;
  }
  _advancing = true;
  api.activateSegment?.(next, next.sourceIn);
  // activateSegment loads a new src async; wait for it to be ready before
  // resuming play. ~120 ms is plenty for a cached file.
  setTimeout(() => {
    _advancing = false;
    try { api.video.play()?.catch(() => {}); } catch {}
  }, 120);
  render();
}

// ============================================================
//  Public API
// ============================================================
function init(consumerApi) {
  api = consumerApi;
  buildDOM();
  bindEvents();
  bindSegmentEvents();
  // The CTA delegates to the existing topbar Magic Edit button so the modal,
  // pre-fill logic, and validation stay in one place.
  $('tl-cta-magic')?.addEventListener('click', () => {
    document.getElementById('btn-magic')?.click();
  });
  // Escape hatch when ghost segments persist or a user wants to start fresh.
  $('tl-clear-video')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!api.state.segments?.length) return;
    if (!confirm('Remove all clips from the timeline?')) return;
    api.state.segments = [];
    api.state.activeSegmentId = null;
    api.state.selectedSegmentId = null;
    api.state.video = null;
    if (api.video) { api.video.removeAttribute('src'); try { api.video.load(); } catch {} }
    api.snapshot();
    try { window.MC?.project?.save?.(api.state); } catch {}
    render(); api.draw(); api.renderLayersPanel?.();
  });
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
