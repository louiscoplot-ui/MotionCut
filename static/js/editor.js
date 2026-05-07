/* ================================================================
   MotionCut — editor runtime
   Vanilla JS · Canvas overlay · Snap guides · Cmd+K · Layers panel
   ================================================================ */
(() => {
'use strict';

// ============================================================
//  Lucide refresh (re-render dynamic icons)
// ============================================================
function refreshIcons() { try { window.lucide && window.lucide.createIcons(); } catch {} }

// ============================================================
//  State
// ============================================================
const CANVAS_W_169 = 1920, CANVAS_H_169 = 1080;
const CANVAS_W_916 = 1080, CANVAS_H_916 = 1920;
const CANVAS_W_11  = 1080, CANVAS_H_11  = 1080;
let canvasW = CANVAS_W_169, canvasH = CANVAS_H_169;

const FONTS = [
  'Inter','Syne','Manrope','Space Grotesk','Orbitron','Teko',
  'Playfair Display','JetBrains Mono','Bebas Neue'
];

const state = {
  project: 'default',
  projects: [],
  video: null,                  // mirrors the segment currently under the playhead
  audio: null,
  aspect: '16:9',
  layers: [],
  // Multi-clip timeline. Each segment is one cut on the video track.
  // state.video stays in sync with whichever segment is "active" at the
  // current playhead so the existing canvas/draw code keeps working.
  segments: [],                 // see makeSegment() below for shape
  activeSegmentId: null,
  selectedSegmentId: null,
  selectedId: null,
  selectedIds: new Set(),       // multi-select set; selectedId remains the "primary"
  template: 'custom',
  fx:    { vignette: false, grain: false, grade: 'natural' },
  music: { volume: 60, fadeIn: false, fadeOut: false, mode: 'mix' },
  letterbox: false,
  inMark:  null,                // null = use video start
  outMark: null,                // null = use video end
  beats:   [],                  // detected beat positions (seconds)
  snapToBeat: false,
  brand: {                      // BRAND KIT (per-project)
    agencyName: '',
    tagline:    '',
    primary:    '#f0c040',
    secondary:  '#1a1a1a',
    font:       'Syne',
    logoUrl:    null,
    logoFile:   null,
  },
};

const history = { stack: [], idx: -1, max: 60 };

// ============================================================
//  Helpers
// ============================================================
const $ = (id) => document.getElementById(id);
function uid() { return Math.random().toString(36).slice(2, 10); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ============================================================
//  DOM refs
// ============================================================
let video, canvas, ctx, stageWrap, stageInner, stageEmpty, scrubber, layersPanelEl, inspectorBodyEl, snapSvg, dragTooltip, canvasFloatingEl, toastEl;

// ============================================================
//  Toasts
// ============================================================
function toast(msg, opts={}) {
  if (!toastEl) toastEl = $('toast');
  toastEl.textContent = msg;
  toastEl.classList.toggle('gold', !!opts.gold);
  toastEl.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add('hidden'), opts.ms || 2400);
}

// ============================================================
//  Canvas sizing
// ============================================================
const ASPECT_DESC_KEY = { '16:9': 'aspect.16_9.desc', '1:1': 'aspect.1_1.desc', '9:16': 'aspect.9_16.desc' };

function setAspect(aspect) {
  state.aspect = aspect;
  stageWrap.classList.remove('aspect-16-9','aspect-9-16','aspect-1-1');
  if (aspect === '9:16')      { stageWrap.classList.add('aspect-9-16'); canvasW = CANVAS_W_916; canvasH = CANVAS_H_916; }
  else if (aspect === '1:1')  { stageWrap.classList.add('aspect-1-1');  canvasW = CANVAS_W_11;  canvasH = CANVAS_H_11; }
  else                        { stageWrap.classList.add('aspect-16-9'); canvasW = CANVAS_W_169; canvasH = CANVAS_H_169; }

  document.querySelectorAll('.aspect-segmented .aspect').forEach(b => {
    b.classList.toggle('on', b.dataset.aspect === aspect);
  });
  // Update the descriptive subtitle
  const desc = $('aspect-desc');
  const key = ASPECT_DESC_KEY[aspect];
  if (desc && key) {
    desc.setAttribute('data-i18n', key);
    desc.textContent = window.MC?.i18n?.t?.(key) || desc.textContent;
  }
  if (snapSvg) snapSvg.setAttribute('viewBox', `0 0 ${canvasW} ${canvasH}`);
  resizeCanvas();
  draw();
}

function resizeCanvas() {
  const r = stageInner.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.max(2, Math.round(r.width  * dpr));
  canvas.height = Math.max(2, Math.round(r.height * dpr));
  ctx.setTransform(canvas.width / canvasW, 0, 0, canvas.height / canvasH, 0, 0);
}
window.addEventListener('resize', () => { resizeCanvas(); draw(); });

// ============================================================
//  Layer factories
// ============================================================
let _layerCounter = { text: 0, logo: 0, color: 0, image: 0 };
function nextName(type) {
  _layerCounter[type] = (_layerCounter[type] || 0) + 1;
  const labels = { text: 'Text', logo: 'Logo', color: 'Overlay', image: 'Image' };
  return `${labels[type]} ${_layerCounter[type]}`;
}

function makeTextLayer(opts={}) {
  return Object.assign({
    id: uid(), type: 'text',
    name: nextName('text'),
    visible: true, locked: false,
    opacity: 1, blendMode: 'source-over',
    text: 'Your Headline',
    x: canvasW * 0.5, y: canvasH * 0.5,
    width: 800, height: 120,
    rotation: 0,
    fontFamily: 'Syne', fontSize: 96, fontWeight: 700,
    color: '#ffffff', align: 'center',
    start: 0, end: 8,
    animation: 'fade',
    exit: 'auto',         // 'auto' = use animation default; or 'blur' | 'dissolve' | 'motion-blur' | 'mask-wipe' | 'defocus'
  }, opts);
}
function makeLogoLayer(opts={}) {
  return Object.assign({
    id: uid(), type: 'logo',
    name: nextName('logo'),
    visible: true, locked: false,
    opacity: 1, blendMode: 'source-over',
    src: null, url: null, img: null,
    x: 60, y: 60, width: 240, height: 240,
    rotation: 0,
    start: 0, end: 9999,
  }, opts);
}
// Photos & illustrations dropped onto the canvas (or added from the project
// library) become 'image' layers — full-canvas by default when there's no
// video, or a large centered overlay when a video is already loaded. This is
// distinct from 'logo' layers (small, corner-positioned, set via the
// dedicated Logo button in the right rail).
function makeImageLayer(opts={}) {
  const w = opts.width  || canvasW;
  const h = opts.height || canvasH;
  return Object.assign({
    id: uid(), type: 'image',
    name: opts.name || nextName('image'),
    visible: true, locked: false,
    opacity: 1, blendMode: 'source-over',
    src: null, url: null, img: null,
    x: (canvasW - w) / 2,
    y: (canvasH - h) / 2,
    width: w, height: h,
    rotation: 0,
    start: 0, end: 9999,
  }, opts);
}
function makeColorLayer(opts={}) {
  return Object.assign({
    id: uid(), type: 'color',
    name: nextName('color'),
    visible: true, locked: false,
    opacity: 0.35, blendMode: 'source-over',
    color: '#000000',
    x: 0, y: 0, width: canvasW, height: canvasH,
    start: 0, end: 9999,
  }, opts);
}

// ============================================================
//  History
// ============================================================
function snapshot() {
  const pruned = JSON.stringify({
    aspect: state.aspect,
    selectedId: state.selectedId,
    fx: state.fx,
    music: state.music,
    template: state.template,
    letterbox: state.letterbox,
    layers: state.layers.map(l => { const c = {...l}; delete c.img; return c; }),
  });
  history.stack = history.stack.slice(0, history.idx + 1);
  history.stack.push(pruned);
  if (history.stack.length > history.max) history.stack.shift();
  history.idx = history.stack.length - 1;

  // Debounced auto-save to server (v1 project document).
  // Silent — no toast. Explicit Save button still confirms with a toast.
  // Skipped if project-state module hasn't loaded yet (e.g. early init).
  if (window.MC?.project?.save) {
    clearTimeout(state._autoSaveTimer);
    state._autoSaveTimer = setTimeout(() => {
      window.MC.project.save(state)
        .catch(err => console.warn('[editor] auto-save failed:', err));
    }, 3000);
  }
}
function restore(json) {
  try {
    const data = JSON.parse(json);
    state.aspect = data.aspect || '16:9';
    state.fx = data.fx || state.fx;
    state.music = data.music || state.music;
    state.template = data.template || 'custom';
    state.letterbox = !!data.letterbox;
    state.layers = (data.layers || []).map(l => {
      if (l.type === 'logo' && l.url) {
        const img = new Image(); img.crossOrigin = 'anonymous'; img.src = l.url;
        l.img = img;
      }
      return l;
    });
    state.selectedId = data.selectedId || null;
    setAspect(state.aspect);
    syncStyleControls();
    renderLayersPanel();
    renderInspector();
    draw();
  } catch (e) { console.error(e); }
}
function undo() { if (history.idx > 0) { history.idx--; restore(history.stack[history.idx]); } }
function redo() { if (history.idx < history.stack.length - 1) { history.idx++; restore(history.stack[history.idx]); } }

// ============================================================
//  Segments (multi-clip video track)
// ============================================================
// A segment = one ordered cut on the video track. Source clips are referenced
// by filename (matching files in the project upload folder). The runtime
// shape carries timeline positions (timelineIn/timelineOut) which are
// derived from sourceIn/sourceOut + accumulated transitions; we keep them
// on the object so the timeline render and playback can read in O(1).
function makeSegment(opts={}) {
  const sIn  = +opts.sourceIn  || 0;
  const sOut = +opts.sourceOut || (opts.duration ? sIn + +opts.duration : sIn + 5);
  return {
    id:          opts.id          || ('seg_' + uid()),
    filename:    opts.filename    || null,
    url:         opts.url         || null,
    kind:        opts.kind        || 'video',  // 'video' | 'image'
    sourceIn:    sIn,
    sourceOut:   Math.max(sIn + 0.05, sOut),
    timelineIn:  +opts.timelineIn  || 0,
    timelineOut: +opts.timelineOut || (sOut - sIn),
    transition:  opts.transition  || { type: 'cut', duration: 0 },
    _duration:   opts._duration   || null,     // probed source duration when known
  };
}

/** Recompute timelineIn/timelineOut for every segment based on sourceIn/sourceOut + transitions.
 *  Mutates segments in place. transition lives on a segment and applies BETWEEN it and the next. */
function reflowSegments(segments) {
  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const dur = Math.max(0.05, s.sourceOut - s.sourceIn);
    s.timelineIn  = cursor;
    s.timelineOut = cursor + dur;
    cursor = s.timelineOut;
    // Crossfade/fadeblack overlap into the next segment by `transition.duration`.
    const t = s.transition || { type: 'cut', duration: 0 };
    const overlap = (t.type === 'crossfade' || t.type === 'xfade' || t.type === 'fade'
                     || t.type === 'fade_to_black' || t.type === 'fadeblack' || t.type === 'dip-to-black')
                     ? Math.max(0, +t.duration || 0) : 0;
    cursor -= overlap;
  }
  return segments;
}

/** Total length of the timeline in seconds (after reflow). */
function totalSegmentsDuration() {
  if (!state.segments.length) return 0;
  return state.segments[state.segments.length - 1].timelineOut;
}

/** Find the segment that should be playing at timeline-time `t`. Returns the
 *  segment + the source-time inside it (clamped to its range). */
function segmentAt(t) {
  if (!state.segments.length) return { seg: null, st: 0 };
  for (let i = 0; i < state.segments.length; i++) {
    const s = state.segments[i];
    if (t < s.timelineOut - 1e-3 || i === state.segments.length - 1) {
      const st = clamp(s.sourceIn + (t - s.timelineIn), s.sourceIn, s.sourceOut);
      return { seg: s, st };
    }
  }
  const last = state.segments[state.segments.length - 1];
  return { seg: last, st: last.sourceOut };
}

/** Build a project-folder URL for a source filename. Falls back to legacy /uploads/. */
function segmentUrl(filename) {
  if (!filename) return null;
  return '/projects/' + encodeURIComponent(state.project || 'default')
       + '/files/'   + encodeURIComponent(filename);
}

/** Make `state.video` reflect the segment under the playhead so the existing
 *  draw / inspector / library / project-state code keeps working unchanged. */
function activateSegment(seg, sourceTime) {
  if (!seg) {
    state.activeSegmentId = null;
    return;
  }
  state.activeSegmentId = seg.id;
  const wantUrl = seg.url || segmentUrl(seg.filename);
  const filenameChanged = !state.video || state.video.filename !== seg.filename;
  if (filenameChanged) {
    state.video = {
      filename: seg.filename,
      url:      wantUrl,
      kind:     seg.kind || 'video',
      duration: seg._duration || 0,
    };
    if (video) {
      video.src = wantUrl;
      try { video.load(); } catch {}
      video.onloadedmetadata = () => {
        seg._duration = video.duration || seg._duration || (seg.sourceOut - seg.sourceIn);
        if (sourceTime != null) { try { video.currentTime = sourceTime; } catch {} }
        try { window.MC?.timeline?.render?.(); } catch {}
        draw();
      };
    }
    $('dropzone-video')?.classList.add('has-file');
    if ($('dropzone-video')) $('dropzone-video').querySelector('.dz-title').textContent = (seg.filename || 'video').slice(0,18);
  } else if (sourceTime != null && video) {
    try { video.currentTime = sourceTime; } catch {}
  }
}

/** Append a segment to the end of the timeline and activate it if it's the first. */
function appendSegment(opts) {
  const seg = makeSegment(opts);
  state.segments.push(seg);
  reflowSegments(state.segments);
  if (state.segments.length === 1) activateSegment(seg, seg.sourceIn);
  state.selectedSegmentId = seg.id;
  try { window.MC?.timeline?.render?.(); } catch {}
  snapshot();
  return seg;
}

/** Remove a segment by id; reflow timeline; pick a sensible new active seg. */
function removeSegment(id) {
  const i = state.segments.findIndex(s => s.id === id);
  if (i < 0) return;
  state.segments.splice(i, 1);
  reflowSegments(state.segments);
  if (state.activeSegmentId === id) {
    const next = state.segments[Math.min(i, state.segments.length - 1)];
    if (next) activateSegment(next, next.sourceIn);
    else { state.video = null; state.activeSegmentId = null; if (video) { video.removeAttribute('src'); video.load(); } }
  }
  if (state.selectedSegmentId === id) state.selectedSegmentId = state.segments[0]?.id || null;
  try { window.MC?.timeline?.render?.(); } catch {}
  snapshot();
  draw();
}

// ============================================================
//  Upload (with chunked fallback)
// ============================================================
const CHUNK_THRESHOLD = 3 * 1024 * 1024;
const CHUNK_SIZE      = 3 * 1024 * 1024;

async function uploadFile(file, kind, onProgress) {
  if (file.size <= CHUNK_THRESHOLD) {
    const fd = new FormData();
    fd.append('file', file); fd.append('kind', kind);
    fd.append('project', state.project || 'default');
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    if (!r.ok) {
      const err = await r.json().catch(()=>({}));
      throw new Error(err.error || `upload failed (${r.status})`);
    }
    return r.json();
  }
  return uploadChunked(file, kind, onProgress);
}
async function uploadChunked(file, kind, onProgress) {
  const uploadId = 'u_' + Math.random().toString(36).slice(2,12) + Math.random().toString(36).slice(2,8);
  const total = Math.ceil(file.size / CHUNK_SIZE);
  let last = null;
  for (let i = 0; i < total; i++) {
    const start = i * CHUNK_SIZE, end = Math.min(file.size, start + CHUNK_SIZE);
    const fd = new FormData();
    fd.append('uploadId', uploadId);
    fd.append('chunkIndex', i);
    fd.append('totalChunks', total);
    fd.append('filename', file.name);
    fd.append('kind', kind);
    fd.append('project', state.project || 'default');
    fd.append('chunk', file.slice(start, end), 'chunk');
    const r = await fetch('/api/upload/chunk', { method: 'POST', body: fd });
    if (!r.ok) {
      const err = await r.json().catch(()=>({}));
      throw new Error(err.error || `chunk ${i+1}/${total} failed (${r.status})`);
    }
    last = await r.json();
    if (onProgress) onProgress(((i+1)/total)*100);
  }
  return last;
}

function inferKind(file) {
  const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
  if (['.mp4','.mov','.m4v','.webm','.mkv'].includes(ext)) return 'video';
  if (['.png','.jpg','.jpeg','.webp'].includes(ext)) return 'image';
  if (['.mp3','.wav','.m4a','.aac'].includes(ext)) return 'audio';
  return null;
}

async function handleFile(file, kindHint) {
  // Routing rules:
  //   - kindHint 'logo'  -> small corner logo overlay (right-rail dropzone, btn-add-logo)
  //   - kindHint 'image' or no hint + image extension -> full-canvas image layer
  //     (window drops, library clicks, generic API callers)
  //   - kindHint 'video' / 'audio' -> respective tracks
  const kind = kindHint || inferKind(file);
  if (!kind) { toast(`Unsupported file: ${file.name}`); return; }
  const wasVideo = !!state.video;
  // 'logo' is a UI intent, not a file kind — the server only knows 'image'.
  const uploadKind = kind === 'logo' ? 'image' : kind;

  // ----- OPTIMISTIC: instant local preview before upload finishes -----
  // Uses object URLs so the user sees their content within ~16ms instead of
  // waiting for the chunked upload. Once the server confirms, we swap the
  // filename reference to the server-side name (so exports work) but keep
  // the local URL playing in the <video> element — no re-buffer.
  let localUrl = null;
  let localLayer = null;
  let localSegment = null;
  if (kind === 'video') {
    localUrl = URL.createObjectURL(file);
    // Append a segment for this clip; first one auto-activates and shows in
    // the player. Subsequent uploads stack on the timeline.
    localSegment = appendSegment({
      filename: file.name, url: localUrl, kind: 'video',
      sourceIn: 0, sourceOut: 9999,   // refined when the upload returns probed duration
    });
    localSegment._local = true;
  } else if (kind === 'logo') {
    // Explicit logo intent: small corner overlay, original sizing rules.
    localUrl = URL.createObjectURL(file);
    const img = new Image(); img.src = localUrl;
    localLayer = makeLogoLayer({ src: file.name, url: localUrl, img, _local: true });
    img.onload = () => {
      const r = img.naturalWidth / img.naturalHeight;
      localLayer.height = localLayer.width / r;
      draw();
    };
    state.layers.push(localLayer);
    state.selectedId = localLayer.id;
    $('dropzone-image')?.classList.add('has-file');
    renderLayersPanel(); renderInspector(); positionFloatingToolbar(); snapshot(); draw();
  } else if (kind === 'image') {
    // Full-canvas (or large centered) image — like a still frame in a NLE.
    localUrl = URL.createObjectURL(file);
    const img = new Image(); img.src = localUrl;
    const empty = !state.video;
    // Empty stage: cover the full canvas. Stage already has a video: 80% wide
    // centered overlay so the user can see it sits on top, not replacing.
    const w = empty ? canvasW : Math.round(canvasW * 0.8);
    const h = empty ? canvasH : Math.round(canvasH * 0.8);
    localLayer = makeImageLayer({
      src: file.name, url: localUrl, img, _local: true,
      name: file.name,
      width: w, height: h,
    });
    img.onload = () => {
      // Preserve the source aspect ratio inside the chosen bounding box.
      const ar = img.naturalWidth / img.naturalHeight;
      const boxAr = w / h;
      if (ar > boxAr) {
        // image is wider than box -> fit width
        localLayer.height = Math.round(localLayer.width / ar);
      } else {
        localLayer.width = Math.round(localLayer.height * ar);
      }
      localLayer.x = Math.round((canvasW - localLayer.width) / 2);
      localLayer.y = Math.round((canvasH - localLayer.height) / 2);
      draw();
    };
    state.layers.push(localLayer);
    state.selectedId = localLayer.id;
    renderLayersPanel(); renderInspector(); positionFloatingToolbar(); snapshot(); draw();
  }

  // ----- Background upload via the queue widget -----
  const queueId = uploadQueueAdd(file.name, uploadKind);
  try {
    const meta = await uploadFile(file, uploadKind, pct => uploadQueueProgress(queueId, pct));
    uploadQueueDone(queueId);

    // Swap optimistic refs to server-backed names so exports resolve correctly.
    if (kind === 'video') {
      // Promote the optimistic segment to its server-backed filename and
      // refine its sourceOut once we know the real duration. The chunked
      // upload occasionally returns duration=0; in that case we ask the
      // backend to probe the saved file via /api/probe so segment blocks
      // never end up with a sentinel 9999 width.
      if (localSegment) {
        localSegment.filename = meta.filename;
        localSegment.url      = meta.url || segmentUrl(meta.filename);
        localSegment._local   = false;
        let probedDur = +meta.duration || 0;
        if (probedDur <= 0) {
          try {
            const r = await fetch('/api/probe', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ project: state.project, filename: meta.filename }),
            });
            if (r.ok) probedDur = +(await r.json()).duration || 0;
          } catch {}
        }
        if (probedDur <= 0) probedDur = video.duration || 5; // last-ditch sane default
        localSegment._duration = probedDur;
        if (localSegment.sourceOut === 9999 || localSegment.sourceOut <= localSegment.sourceIn) {
          localSegment.sourceOut = localSegment.sourceIn + probedDur;
        }
        reflowSegments(state.segments);
      }
      if (state.video && state.video.filename === file.name) {
        state.video.filename = meta.filename;
        state.video.url      = meta.url || segmentUrl(meta.filename);
        state.video.duration = meta.duration || video.duration;
        state.video._local   = false;
      }
      toast(wasVideo ? `Added ${file.name}` : `Loaded ${file.name}`, { gold: true });
      try { window.MC?.timeline?.render?.(); } catch {}
      snapshot();
    } else if (kind === 'logo' || kind === 'image') {
      // Match by the layer reference we created above so we don't accidentally
      // rename a same-named pre-existing layer.
      if (localLayer) { localLayer.src = meta.filename; localLayer._local = false; }
      toast(kind === 'logo' ? `Logo added: ${file.name}` : `Image added: ${file.name}`);
      snapshot();
    } else if (kind === 'audio') {
      applyMusic(meta);
      toast(`Music: ${file.name}`);
    }
    refreshLibrary();
  } catch (e) {
    uploadQueueFail(queueId, e.message);
    toast(`Error: ${e.message}`);
  }
}

function applyVideo(meta) {
  // Library re-add path (existing UX): clicking a video file in the library
  // appends a new segment to the timeline rather than replacing what's there.
  // Keeps multi-clip workflows additive and matches NLE expectations.
  appendSegment({
    filename: meta.filename, url: meta.url, kind: 'video',
    sourceIn: 0, sourceOut: meta.duration && meta.duration > 0 ? meta.duration : 9999,
    _duration: meta.duration || 0,
  });
  if (stageEmpty) stageEmpty.classList.add('hidden');
}
function applyImageFromLibrary(meta) {
  // Library re-add path: file already lives on the server, so no upload — just
  // build the full-canvas / 80%-overlay layer immediately.
  const img = new Image(); img.crossOrigin = 'anonymous'; img.src = meta.url;
  const empty = !state.video;
  const w = empty ? canvasW : Math.round(canvasW * 0.8);
  const h = empty ? canvasH : Math.round(canvasH * 0.8);
  const display = (meta.filename || '').replace(/^[a-f0-9]{6,16}_/, '');
  const layer = makeImageLayer({
    src: meta.filename, url: meta.url, img,
    name: display || nextName('image'),
    width: w, height: h,
  });
  img.onload = () => {
    const ar = img.naturalWidth / img.naturalHeight;
    const boxAr = w / h;
    if (ar > boxAr) layer.height = Math.round(layer.width / ar);
    else            layer.width  = Math.round(layer.height * ar);
    layer.x = Math.round((canvasW - layer.width)  / 2);
    layer.y = Math.round((canvasH - layer.height) / 2);
    draw();
  };
  state.layers.push(layer);
  state.selectedId = layer.id;
  renderLayersPanel(); renderInspector(); positionFloatingToolbar(); snapshot(); draw();
}
function applyLogo(meta) {
  const img = new Image(); img.crossOrigin = 'anonymous'; img.src = meta.url;
  const layer = makeLogoLayer({ src: meta.filename, url: meta.url, img });
  img.onload = () => {
    const r = img.naturalWidth / img.naturalHeight;
    layer.height = layer.width / r;
    draw();
  };
  state.layers.push(layer);
  state.selectedId = layer.id;
  $('dropzone-image').classList.add('has-file');
  $('dropzone-image').querySelector('.dz-title').textContent = 'Logo set';
  renderLayersPanel(); renderInspector(); snapshot(); draw();
}
function applyMusic(meta) {
  state.audio = meta;
  state.beats = [];
  $('dropzone-audio').classList.add('has-file');
  $('dropzone-audio').querySelector('.dz-title').textContent = 'Music set';
  const mi = $('music-info');
  mi.classList.add('has-file');
  mi.querySelector('span').textContent = meta.filename + ' · ' + fmtTime(meta.duration||0);
  mi.querySelector('span').classList.remove('muted');
  try { window.MC?.timeline?.render?.(); } catch {}
  // Auto-detect beats in the background (non-blocking)
  detectBeats(meta.url);
}

async function detectBeats(url) {
  try {
    toast('Detecting beats…', { ms: 60000 });
    const buf = await fetch(url).then(r => r.arrayBuffer());
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await ac.decodeAudioData(buf);
    const ch = decoded.getChannelData(0);
    const sr = decoded.sampleRate;
    // Energy onset: frame the signal in 1024-sample windows, compute energy,
    // detect local maxima above adaptive threshold.
    const win = 1024;
    const hop = 512;
    const frames = Math.floor((ch.length - win) / hop);
    const energy = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let e = 0;
      const start = i * hop;
      for (let j = 0; j < win; j++) {
        const v = ch[start + j];
        e += v * v;
      }
      energy[i] = Math.sqrt(e / win);
    }
    // Smooth + flux
    const flux = new Float32Array(frames);
    for (let i = 1; i < frames; i++) {
      flux[i] = Math.max(0, energy[i] - energy[i-1] * 1.05);
    }
    // Adaptive threshold via local mean
    const beats = [];
    const localWin = 24;     // ~0.55 s
    const minGapFrames = Math.floor(0.30 * sr / hop);  // 300ms minimum between beats
    let lastBeat = -minGapFrames;
    for (let i = localWin; i < frames - localWin; i++) {
      let mean = 0;
      for (let k = i - localWin; k < i + localWin; k++) mean += flux[k];
      mean /= (localWin * 2);
      const thresh = mean * 1.6 + 0.005;
      if (flux[i] > thresh && flux[i] >= flux[i-1] && flux[i] >= flux[i+1] && (i - lastBeat) >= minGapFrames) {
        beats.push((i * hop) / sr);
        lastBeat = i;
      }
    }
    state.beats = beats;
    try { ac.close(); } catch {}
    toast(`Detected ${beats.length} beats`, { gold:true });
    try { window.MC?.timeline?.render?.(); } catch {}
  } catch (e) {
    console.warn('[beats]', e);
    toast('Beat detection failed');
  }
}

// ============================================================
//  Upload queue (top-right, stacked progress pills)
// ============================================================
const _uq = new Map();          // id -> { el, name, kind, pct, status }
let   _uqSeq = 0;

function uploadQueueRoot() {
  let root = $('upload-queue');
  if (!root) {
    root = document.createElement('div');
    root.id = 'upload-queue';
    root.className = 'upload-queue';
    document.body.appendChild(root);
  }
  return root;
}
function uploadQueueAdd(name, kind) {
  const id = 'uq_' + (++_uqSeq);
  const root = uploadQueueRoot();
  const el = document.createElement('div');
  el.className = 'uq-pill';
  el.innerHTML = `
    <i data-lucide="${kind === 'video' ? 'film' : kind === 'image' ? 'image' : 'music'}"></i>
    <div class="uq-info">
      <div class="uq-name">${escapeHTML(name)}</div>
      <div class="uq-bar"><div class="uq-bar-fill" style="width:0%"></div></div>
    </div>
    <span class="uq-pct mono">0%</span>`;
  root.appendChild(el);
  refreshIcons();
  if (window.gsap) gsap.from(el, { opacity: 0, x: 12, duration: 0.24, ease: 'power3.out' });
  _uq.set(id, { el, name, kind, pct: 0, status: 'uploading' });
  return id;
}
function uploadQueueProgress(id, pct) {
  const item = _uq.get(id); if (!item) return;
  item.pct = pct;
  item.el.querySelector('.uq-bar-fill').style.width = pct + '%';
  item.el.querySelector('.uq-pct').textContent = pct.toFixed(0) + '%';
}
function uploadQueueDone(id) {
  const item = _uq.get(id); if (!item) return;
  item.status = 'done';
  item.el.classList.add('done');
  item.el.querySelector('.uq-bar-fill').style.width = '100%';
  item.el.querySelector('.uq-pct').textContent = '✓';
  setTimeout(() => uploadQueueRemove(id), 1200);
}
function uploadQueueFail(id, msg) {
  const item = _uq.get(id); if (!item) return;
  item.status = 'error';
  item.el.classList.add('error');
  item.el.querySelector('.uq-pct').textContent = '!';
  item.el.title = msg || '';
  setTimeout(() => uploadQueueRemove(id), 4000);
}
function uploadQueueRemove(id) {
  const item = _uq.get(id); if (!item) return;
  if (window.gsap) {
    gsap.to(item.el, { opacity: 0, x: 12, duration: 0.20, ease: 'power3.out',
      onComplete: () => item.el.remove() });
  } else {
    item.el.remove();
  }
  _uq.delete(id);
}

// ============================================================
//  Drop-anywhere overlay
// ============================================================
function bindDropOverlay() {
  const overlay = $('drop-overlay');
  let active = false;        // truly inside a file-drag session
  let lastTick = 0;          // timestamp of last dragover
  let watchdog = null;       // interval that auto-closes if drag stalls

  const open = () => {
    if (active) return;
    active = true;
    overlay.classList.add('show');
    // Watchdog: if no dragover event for 180ms, the drag is over → hide.
    // Catches edge cases where the browser doesn't fire drop/dragend cleanly.
    if (!watchdog) {
      watchdog = setInterval(() => {
        if (active && Date.now() - lastTick > 180) close();
      }, 60);
    }
  };
  const close = () => {
    active = false;
    overlay.classList.remove('show');
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
  };

  // dragenter — first signal that a file-drag started over the page
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    lastTick = Date.now();
    open();
  });

  // dragover — preventDefault to enable drop + keep watchdog alive
  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    lastTick = Date.now();
  });

  // ALWAYS close on drop (capture phase fires before per-zone handlers)
  document.addEventListener('drop', () => close(), true);
  window.addEventListener('dragend',  () => close(), true);
  window.addEventListener('blur',     () => close());
  document.addEventListener('mouseup', () => close(), true);  // belt + braces

  // Auto-handle drops not absorbed by a per-zone dropzone
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    close();
    const files = [...(e.dataTransfer?.files || [])];
    for (const f of files) await handleFile(f);
  });
}

// Per-zone drop wiring (smaller, but still bind so click->browse and explicit drop work)
function bindDropzone(zoneId, inputId, kind) {
  const zone = $(zoneId), input = $(inputId);
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', async e => {
    e.preventDefault(); e.stopPropagation();
    zone.classList.remove('over');
    const files = [...(e.dataTransfer?.files || [])];
    for (const f of files) await handleFile(f, kind);   // ALL files, not just [0]
  });
  input.addEventListener('change', async () => {
    const files = [...(input.files || [])];
    for (const f of files) await handleFile(f, kind);
    input.value = '';   // allow re-selecting the same file later
  });
}

// ============================================================
//  Canvas hit-test, drag & resize, snap guides
// ============================================================
const HANDLE = 14;
let drag = null;

function getLayerBounds(l) {
  if (l.type === 'text') {
    ctx.save();
    ctx.font = `${l.fontWeight} ${l.fontSize}px ${l.fontFamily}`;
    const m = ctx.measureText(l.text || '');
    ctx.restore();
    const w = m.width + 20, h = l.fontSize * 1.4;
    return { x: l.x - w/2, y: l.y - h/2, w, h };
  }
  return { x: l.x, y: l.y, w: l.width, h: l.height };
}
function pointInLayer(px, py, l) {
  if (!l.visible || l.locked) return false;
  const b = getLayerBounds(l);
  return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
}
const ROT_OFFSET = 36;
function getRotationHandlePos(l) {
  const b = getLayerBounds(l);
  const cx = b.x + b.w / 2;
  const cy = b.y - ROT_OFFSET;
  return { x: cx, y: cy, anchorX: b.x + b.w / 2, anchorY: b.y + b.h / 2 };
}
function pointInRotationHandle(px, py, l) {
  const r = getRotationHandlePos(l);
  return Math.hypot(px - r.x, py - r.y) <= HANDLE * 0.9;
}
function pointInResizeHandle(px, py, l) {
  return getResizeCorner(px, py, l) != null;
}
function getResizeCorner(px, py, l) {
  const b = getLayerBounds(l);
  const corners = {
    tl: [b.x,         b.y],
    tr: [b.x + b.w,   b.y],
    bl: [b.x,         b.y + b.h],
    br: [b.x + b.w,   b.y + b.h],
  };
  for (const [name, [cx, cy]] of Object.entries(corners)) {
    if (px >= cx - HANDLE && px <= cx + HANDLE && py >= cy - HANDLE && py <= cy + HANDLE) {
      return name;
    }
  }
  return null;
}
function cursorForCorner(c) {
  return (c === 'tl' || c === 'br') ? 'nwse-resize'
       : (c === 'tr' || c === 'bl') ? 'nesw-resize'
       : 'default';
}
function canvasCoordsFromEvent(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / r.width  * canvasW,
    y: (e.clientY - r.top)  / r.height * canvasH,
  };
}

// Snap targets: canvas centers/edges + other layers
function getSnapTargets(forLayer) {
  const xs = [0, canvasW/2, canvasW];
  const ys = [0, canvasH/2, canvasH];
  for (const l of state.layers) {
    if (l.id === forLayer.id || !l.visible) continue;
    const b = getLayerBounds(l);
    xs.push(b.x, b.x + b.w/2, b.x + b.w);
    ys.push(b.y, b.y + b.h/2, b.y + b.h);
  }
  return { xs, ys };
}

function applySnap(layer, dx, dy) {
  const SNAP = 12;     // engage threshold (canvas units)
  const guides = [];
  const b = getLayerBounds(layer);
  const cx = b.x + b.w/2 + dx;
  const cy = b.y + b.h/2 + dy;
  const t = getSnapTargets(layer);

  let outDx = dx, outDy = dy;

  // X
  let bestX = null, bestXd = SNAP + 1;
  for (const xt of t.xs) {
    for (const c of [b.x + dx, cx, b.x + b.w + dx]) {
      const d = Math.abs(c - xt);
      if (d < bestXd) { bestXd = d; bestX = { xt, off: xt - c }; }
    }
  }
  if (bestX && bestXd < SNAP) {
    outDx = dx + bestX.off;
    guides.push({ type: 'v', x: bestX.xt });
  }
  // Y
  let bestY = null, bestYd = SNAP + 1;
  for (const yt of t.ys) {
    for (const c of [b.y + dy, cy, b.y + b.h + dy]) {
      const d = Math.abs(c - yt);
      if (d < bestYd) { bestYd = d; bestY = { yt, off: yt - c }; }
    }
  }
  if (bestY && bestYd < SNAP) {
    outDy = dy + bestY.off;
    guides.push({ type: 'h', y: bestY.yt });
  }
  return { dx: outDx, dy: outDy, guides };
}

function drawSnapGuides(guides) {
  if (!snapSvg) return;
  snapSvg.innerHTML = '';
  for (const g of guides) {
    const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    if (g.type === 'v') { ln.setAttribute('x1', g.x); ln.setAttribute('x2', g.x); ln.setAttribute('y1', 0); ln.setAttribute('y2', canvasH); }
    else                { ln.setAttribute('x1', 0); ln.setAttribute('x2', canvasW); ln.setAttribute('y1', g.y); ln.setAttribute('y2', g.y); }
    snapSvg.appendChild(ln);
  }
}
function clearSnapGuides() { if (snapSvg) snapSvg.innerHTML = ''; }

function showDragTooltip(e, l) {
  if (!dragTooltip) return;
  const r = stageInner.getBoundingClientRect();
  const x = e.clientX - r.left + 10;
  const y = e.clientY - r.top  + 10;
  dragTooltip.style.left = x + 'px';
  dragTooltip.style.top  = y + 'px';
  dragTooltip.textContent = `X ${Math.round(l.x)}  ·  Y ${Math.round(l.y)}`;
  dragTooltip.classList.remove('hidden');
}
function hideDragTooltip() { if (dragTooltip) dragTooltip.classList.add('hidden'); }

function selectOnly(id) {
  state.selectedId = id;
  state.selectedIds.clear();
  if (id) state.selectedIds.add(id);
}
function selectAdd(id) {
  if (!id) return;
  if (state.selectedIds.has(id) && state.selectedIds.size > 1) {
    state.selectedIds.delete(id);
    if (state.selectedId === id) state.selectedId = [...state.selectedIds][state.selectedIds.size - 1] || null;
  } else {
    state.selectedIds.add(id);
    state.selectedId = id;
  }
}

function onCanvasMouseDown(e) {
  if (e.button === 2) return;
  const { x, y } = canvasCoordsFromEvent(e);
  let hit = null, mode = 'move', corner = null;
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const l = state.layers[i];
    if (!l.visible || l.locked) continue;
    if (state.selectedId === l.id) {
      const c = getResizeCorner(x, y, l);
      if (c) { hit = l; mode = 'resize'; corner = c; break; }
      if (pointInRotationHandle(x, y, l)) { hit = l; mode = 'rotate'; break; }
    }
    if (pointInLayer(x, y, l)) { hit = l; mode = 'move'; break; }
  }
  if (hit) {
    if (e.shiftKey) selectAdd(hit.id);
    else if (!state.selectedIds.has(hit.id)) selectOnly(hit.id);
    else state.selectedId = hit.id;
    const b = getLayerBounds(hit);
    // Opposite corner of the grabbed handle = fixed anchor during resize
    const opposite = {
      tl: { x: b.x + b.w, y: b.y + b.h },
      tr: { x: b.x,       y: b.y + b.h },
      bl: { x: b.x + b.w, y: b.y       },
      br: { x: b.x,       y: b.y       },
    }[corner] || { x: b.x, y: b.y };
    const rotInfo = getRotationHandlePos(hit);
    const startAngle = (hit.rotation || 0);
    const cursorAngle = Math.atan2(y - rotInfo.anchorY, x - rotInfo.anchorX);
    drag = {
      id: hit.id, mode, corner,
      offX: x - hit.x, offY: y - hit.y,
      startX: hit.x, startY: hit.y,
      startW: hit.width || b.w, startH: hit.height || b.h,
      startFontSize: hit.fontSize || 64,
      origHalfDiag: Math.hypot(b.w, b.h) / 2,
      anchor: opposite,
      origMouse: { x, y },
      startAngle,
      startCursorAngle: cursorAngle,
      rotCenter: { x: rotInfo.anchorX, y: rotInfo.anchorY },
      groupStarts: [...state.selectedIds].map(sid => {
        const sl = state.layers.find(L => L.id === sid);
        return sl ? { id: sid, x: sl.x, y: sl.y } : null;
      }).filter(Boolean),
    };
  } else if (!e.shiftKey) {
    selectOnly(null);
  }
  renderLayersPanel(); renderInspector(); positionFloatingToolbar(); draw();
}

function onCanvasMouseMove(e) {
  const { x, y } = canvasCoordsFromEvent(e);
  if (!drag) {
    const sel = state.layers.find(l => l.id === state.selectedId);
    if (sel) {
      const c = getResizeCorner(x, y, sel);
      if (c) { canvas.style.cursor = cursorForCorner(c); return; }
      if (pointInRotationHandle(x, y, sel)) { canvas.style.cursor = 'grab'; return; }
    }
    if (state.layers.some(l => pointInLayer(x, y, l))) canvas.style.cursor = 'move';
    else canvas.style.cursor = 'default';
    return;
  }
  const l = state.layers.find(L => L.id === drag.id);
  if (!l) return;
  if (drag.mode === 'move') {
    let dx = (x - drag.origMouse.x);
    let dy = (y - drag.origMouse.y);
    const targetX = drag.startX + dx;
    const targetY = drag.startY + dy;
    const snap = applySnap(l, targetX - l.x, targetY - l.y);
    const realDx = snap.dx, realDy = snap.dy;
    // Apply to all selected layers (group move)
    if (drag.groupStarts && drag.groupStarts.length > 1) {
      const totalDx = (drag.startX + realDx) - drag.startX;
      const totalDy = (drag.startY + realDy) - drag.startY;
      const moved = (drag.startX + dx + (snap.dx - dx)) - drag.startX;
      const movedY = (drag.startY + dy + (snap.dy - dy)) - drag.startY;
      drag.groupStarts.forEach(g => {
        if (g.id === l.id) return;
        const sl = state.layers.find(L => L.id === g.id); if (!sl) return;
        sl.x = clamp(g.x + moved,  0, canvasW);
        sl.y = clamp(g.y + movedY, 0, canvasH);
      });
      l.x = clamp(drag.startX + moved,  0, canvasW);
      l.y = clamp(drag.startY + movedY, 0, canvasH);
    } else {
      l.x = clamp(l.x + realDx, 0, canvasW);
      l.y = clamp(l.y + realDy, 0, canvasH);
    }
    drawSnapGuides(snap.guides);
    showDragTooltip(e, l);
  } else if (drag.mode === 'rotate') {
    const cur = Math.atan2(y - drag.rotCenter.y, x - drag.rotCenter.x);
    let deltaDeg = (cur - drag.startCursorAngle) * 180 / Math.PI;
    let newAngle = drag.startAngle + deltaDeg;
    // Normalize to [-180, 180]
    while (newAngle > 180)  newAngle -= 360;
    while (newAngle < -180) newAngle += 360;
    // Shift snaps to 15°
    if (e.shiftKey) newAngle = Math.round(newAngle / 15) * 15;
    l.rotation = newAngle;
    showDragTooltip(e, l);
    if (dragTooltip) dragTooltip.textContent = `${newAngle.toFixed(0)}°`;
  } else if (drag.mode === 'resize') {
    if (l.type === 'text') {
      // Distance from cursor to the opposite (anchor) corner relative to
      // the original diagonal → uniformly scales fontSize. Works from any
      // corner, shrinks below original, never gets stuck on the handle.
      const dist = Math.hypot(x - drag.anchor.x, y - drag.anchor.y) / 2;
      const ratio = Math.max(0.05, dist / Math.max(1, drag.origHalfDiag));
      l.fontSize = clamp(Math.round(drag.startFontSize * ratio), 8, 600);
    } else {
      // Image / color: opposite corner stays fixed, cursor defines the other corner
      const ax = drag.anchor.x, ay = drag.anchor.y;
      l.width  = Math.max(8, Math.abs(x - ax));
      l.height = Math.max(8, Math.abs(y - ay));
      l.x = Math.min(x, ax);
      l.y = Math.min(y, ay);
    }
  }
  positionFloatingToolbar();
  draw();
}

function onCanvasMouseUp() {
  if (drag) { drag = null; clearSnapGuides(); hideDragTooltip(); snapshot(); renderInspector(); }
}

// ============================================================
//  Inline canvas text editing (double-click any text layer)
// ============================================================
let _inlineEdit = null;     // { layerId, el }

function startInlineTextEdit(layerId) {
  if (_inlineEdit) commitInlineTextEdit();
  const l = state.layers.find(L => L.id === layerId);
  if (!l || l.type !== 'text' || l.locked) return;
  state.selectedId = layerId;

  // Position the editable input over the canvas at the same screen rect
  const b = getLayerBounds(l);
  const innerRect = stageInner.getBoundingClientRect();
  const innerR = stageInner.getBoundingClientRect();
  const sx = innerR.width  / canvasW;
  const sy = innerR.height / canvasH;
  const editor = document.createElement('div');
  editor.className = 'canvas-inline-edit';
  editor.contentEditable = 'true';
  editor.spellcheck = false;
  editor.textContent = l.text || '';
  // Style to match the layer
  editor.style.position = 'absolute';
  editor.style.left   = ((b.x) * sx) + 'px';
  editor.style.top    = ((b.y) * sy) + 'px';
  editor.style.minWidth  = (b.w * sx) + 'px';
  editor.style.height = (b.h * sy) + 'px';
  editor.style.fontFamily = `"${l.fontFamily}", sans-serif`;
  editor.style.fontWeight = l.fontWeight || 700;
  editor.style.fontSize   = (l.fontSize * sy) + 'px';
  editor.style.color = l.color;
  editor.style.textAlign = l.align || 'center';
  editor.style.lineHeight = '1.2';
  if (l.rotation) editor.style.transform = `rotate(${l.rotation}deg)`;
  stageInner.appendChild(editor);

  // Hide the layer's canvas-rendered text while inline-editing so we don't see double
  l._editingInline = true;
  draw();

  editor.focus();
  // Place caret at end
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);

  _inlineEdit = { layerId, el: editor };

  editor.addEventListener('blur', commitInlineTextEdit);
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelInlineTextEdit(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitInlineTextEdit(); }
  });
}

function commitInlineTextEdit() {
  if (!_inlineEdit) return;
  const { layerId, el } = _inlineEdit;
  const newText = el.innerText.replace(/\n+$/,'').trim();
  const l = state.layers.find(L => L.id === layerId);
  if (l) {
    if (newText && newText !== l.text) { l.text = newText; snapshot(); }
    l._editingInline = false;
  }
  el.remove();
  _inlineEdit = null;
  renderInspector(); draw();
}
function cancelInlineTextEdit() {
  if (!_inlineEdit) return;
  const l = state.layers.find(L => L.id === _inlineEdit.layerId);
  if (l) l._editingInline = false;
  _inlineEdit.el.remove();
  _inlineEdit = null;
  draw();
}

// ============================================================
//  Drawing
// ============================================================
function applyCanvasFilter() {
  const f = []; const g = state.fx.grade;
  if (g === 'cinematic')   f.push('contrast(1.08) saturate(0.95)');
  if (g === 'teal_orange') f.push('contrast(1.05) saturate(1.25) hue-rotate(-8deg)');
  if (g === 'moody_dark')  f.push('brightness(0.9) contrast(1.15) saturate(0.9)');
  if (g === 'bright_airy') f.push('brightness(1.08) contrast(0.95) saturate(1.1)');
  if (g === 'bw')          f.push('grayscale(1) contrast(1.08)');
  video.style.filter = f.join(' ');
}

function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

function drawTextLayer(l, t) {
  if (!l.visible || l._editingInline) return;
  const selected = state.selectedIds.has(l.id) || state.selectedId === l.id;
  const peek = selected && video?.paused;
  if (!peek && (t < l.start || t > l.end)) return;
  if (peek) t = Math.max(l.start, Math.min(l.end, l.start + (l.end - l.start) * 0.5));
  // Effective values from keyframes (fall back to scalar)
  const ex      = effProp(l, 'x', t);
  const ey      = effProp(l, 'y', t);
  const eRot    = effProp(l, 'rotation', t) || 0;
  const eOp     = effProp(l, 'opacity', t);
  const eScale  = (l.kf?.scale?.length ? evalKf(l.kf.scale, t, 1) : 1);
  const eFsRaw  = (l.kf?.fontSize?.length ? evalKf(l.kf.fontSize, t, l.fontSize) : l.fontSize);
  const eFs     = eFsRaw * eScale;
  ctx.save();
  ctx.globalCompositeOperation = l.blendMode || 'source-over';
  let alpha = (eOp ?? 1), dx = 0, dy = 0;
  let drawText = l.text || '';
  const local = t - l.start, dur = l.end - l.start;
  const inP = clamp(local / 0.6, 0, 1);
  const outP = clamp((l.end - t) / 0.6, 0, 1);
  // Cinematic exits — applied during the last 0.7s if exit !== 'auto'
  const exitDur = 0.7;
  const inExit = (l.exit && l.exit !== 'auto') && t > (l.end - exitDur) && t <= l.end;
  let exitFilter = '';
  let exitAlpha = 1;
  if (inExit) {
    const eP = clamp((l.end - t) / exitDur, 0, 1);  // 1 → 0 across exit
    const tw = 1 - eP;                              // 0 → 1
    if (l.exit === 'blur') {
      exitFilter = `blur(${(tw * 18).toFixed(1)}px)`;
      exitAlpha = eP;
    } else if (l.exit === 'motion-blur') {
      exitFilter = `blur(${(tw * 8).toFixed(1)}px)`;
      dx += tw * 60;
      exitAlpha = eP;
    } else if (l.exit === 'defocus') {
      exitFilter = `blur(${(tw * 10).toFixed(1)}px) brightness(${(1 + tw * 0.3).toFixed(2)})`;
      exitAlpha = eP;
    } else if (l.exit === 'dissolve') {
      // grain-like alpha collapse handled below per-letter when drawing
      exitAlpha = eP;
    } else if (l.exit === 'mask-wipe') {
      // mask sweep handled in clip below
      exitAlpha = 1;
    }
  }

  switch (l.animation) {
    case 'fade':
      alpha *= Math.min(easeOut(inP), easeOut(outP)); break;
    case 'tracking': {
      alpha *= Math.min(easeOut(inP), easeOut(outP));
      const spread = (1 - easeOut(Math.min(local / 1.0, 1))) * 40;
      ctx.letterSpacing = spread + 'px';
      break;
    }
    case 'reveal': {
      alpha *= Math.min(easeOut(inP), easeOut(outP));
      const p = easeOut(clamp(local / 0.8, 0, 1));
      const b = getLayerBounds(l);
      ctx.beginPath(); ctx.rect(b.x, b.y, b.w * p, b.h); ctx.clip();
      break;
    }
    case 'typewriter': {
      const cps = Math.max(8, drawText.length / Math.max(0.5, dur * 0.4));
      const n = Math.min(drawText.length, Math.floor(local * cps));
      drawText = drawText.slice(0, n) + (Math.floor(local*2) % 2 ? '|' : ' ');
      alpha *= Math.min(easeOut(inP), easeOut(outP));
      break;
    }
    case 'zoom':
    case 'glow':
      alpha *= Math.min(easeOut(inP), easeOut(outP));
      ctx.shadowColor = l.color; ctx.shadowBlur = 20 + 10 * Math.sin(local * 4);
      break;
    case 'bounce':
      alpha *= Math.min(easeOut(inP), easeOut(outP));
      dy = -Math.abs(Math.sin(local * 3)) * 14 * outP; break;
    case 'cinematic':
      alpha *= Math.min(easeOut(inP), easeOut(outP));
      dy = (1 - easeOut(inP)) * -20; break;
    default:
      alpha *= Math.min(easeOut(inP), easeOut(outP));
  }

  ctx.globalAlpha = clamp(alpha * exitAlpha, 0, 1);
  if (exitFilter) ctx.filter = exitFilter;
  ctx.fillStyle = l.color;
  ctx.textAlign = l.align || 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${l.fontWeight || 700} ${eFs}px "${l.fontFamily}", sans-serif`;
  ctx.shadowColor = ctx.shadowColor || 'rgba(0,0,0,0.55)';
  ctx.shadowBlur  = ctx.shadowBlur  || 8;

  // Mask-wipe exit: clip to a shrinking box from one edge
  if (inExit && l.exit === 'mask-wipe') {
    const eP = clamp((l.end - t) / exitDur, 0, 1);
    const b = getLayerBounds(l);
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.w * eP, b.h);
    ctx.clip();
  }
  // Dissolve exit: per-letter random fade
  if (inExit && l.exit === 'dissolve') {
    const eP = clamp((l.end - t) / exitDur, 0, 1);
    const chars = drawText.split('');
    let xCursor = (ex + dx) - (ctx.measureText(drawText).width / 2);
    ctx.textAlign = 'left';
    for (let i = 0; i < chars.length; i++) {
      const seed = (chars.charCodeAt ? chars[i].charCodeAt(0) * 0.137 : i * 0.31) % 1;
      const charP = clamp((eP - seed * 0.5) / (1 - seed * 0.5 + 0.001), 0, 1);
      ctx.globalAlpha = charP;
      ctx.fillText(chars[i], xCursor, ey + dy);
      xCursor += ctx.measureText(chars[i]).width;
    }
    ctx.restore();
    return;
  }

  // Rotation: pivot around the layer's anchor (effective x/y)
  const rad = (eRot * Math.PI) / 180;
  if (rad) {
    ctx.translate(ex + dx, ey + dy);
    ctx.rotate(rad);
    if (l.animation === 'zoom') {
      const s = 1 + 0.04 * Math.sin(local * 3);
      ctx.scale(s, s);
    }
    ctx.fillText(drawText, 0, 0);
  } else if (l.animation === 'zoom') {
    const s = 1 + 0.04 * Math.sin(local * 3);
    ctx.translate(ex + dx, ey + dy); ctx.scale(s, s);
    ctx.fillText(drawText, 0, 0);
  } else {
    ctx.fillText(drawText, ex + dx, ey + dy);
  }
  ctx.restore();
}

function drawLogoLayer(l, t) {
  if (!l.visible) return;
  const selected = state.selectedIds.has(l.id) || state.selectedId === l.id;
  const peek = selected && video?.paused;
  if (!peek && (t < l.start || t > l.end)) return;
  if (!l.img || !l.img.complete) return;
  const ex   = effProp(l, 'x', t);
  const ey   = effProp(l, 'y', t);
  const eRot = effProp(l, 'rotation', t) || 0;
  const eOp  = effProp(l, 'opacity', t);
  const eSc  = (l.kf?.scale?.length ? evalKf(l.kf.scale, t, 1) : 1);
  const w = l.width  * eSc;
  const h = l.height * eSc;
  ctx.save();
  ctx.globalCompositeOperation = l.blendMode || 'source-over';
  ctx.globalAlpha = eOp ?? 1;
  const rad = (eRot * Math.PI) / 180;
  if (rad) {
    const cx = ex + w / 2;
    const cy = ey + h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(rad);
    ctx.drawImage(l.img, -w / 2, -h / 2, w, h);
  } else {
    ctx.drawImage(l.img, ex, ey, w, h);
  }
  ctx.restore();
}

function drawColorLayer(l, t) {
  if (!l.visible) return;
  const selected = state.selectedIds.has(l.id) || state.selectedId === l.id;
  const peek = selected && video?.paused;
  if (!peek && (t < l.start || t > l.end)) return;
  const ex  = effProp(l, 'x', t);
  const ey  = effProp(l, 'y', t);
  const eOp = effProp(l, 'opacity', t);
  ctx.save();
  ctx.globalCompositeOperation = l.blendMode || 'source-over';
  ctx.fillStyle = l.color; ctx.globalAlpha = eOp;
  ctx.fillRect(ex, ey, l.width, l.height);
  ctx.restore();
}

function drawLetterbox() {
  const bar = canvasH * 0.12;
  ctx.save(); ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvasW, bar);
  ctx.fillRect(0, canvasH - bar, canvasW, bar);
  ctx.restore();
}
function drawVignette() {
  const g = ctx.createRadialGradient(canvasW/2, canvasH/2, Math.min(canvasW,canvasH)*0.3,
                                     canvasW/2, canvasH/2, Math.max(canvasW,canvasH)*0.7);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.save(); ctx.fillStyle = g; ctx.fillRect(0,0,canvasW,canvasH); ctx.restore();
}
function drawSelection() {
  // Outline every selected layer (multi-select aware)
  const ids = state.selectedIds.size ? state.selectedIds : (state.selectedId ? new Set([state.selectedId]) : new Set());
  if (!ids.size) return;
  ctx.save();
  for (const id of ids) {
    const l = state.layers.find(x => x.id === id);
    if (!l || !l.visible) continue;
    const b = getLayerBounds(l);
    const isPrimary = (l.id === state.selectedId);
    ctx.strokeStyle = isPrimary ? '#f0c040' : 'rgba(240,192,64,0.55)';
    ctx.lineWidth   = isPrimary ? 1.5 : 1;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
    if (isPrimary) {
      ctx.fillStyle = '#f0c040';
      const corners = [[b.x,b.y],[b.x+b.w,b.y],[b.x,b.y+b.h],[b.x+b.w,b.y+b.h]];
      for (const [cx,cy] of corners) ctx.fillRect(cx - HANDLE/2, cy - HANDLE/2, HANDLE, HANDLE);
      // Rotation handle: line up + circle
      const r = getRotationHandlePos(l);
      ctx.beginPath();
      ctx.moveTo(b.x + b.w / 2, b.y);
      ctx.lineTo(r.x, r.y);
      ctx.strokeStyle = '#f0c040';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(r.x, r.y, HANDLE * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = '#f0c040';
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#f0c040';
      ctx.stroke();
    }
  }
  ctx.restore();
}

function draw() {
  const t = video.currentTime || 0;
  ctx.clearRect(0, 0, canvasW, canvasH);
  if (state.letterbox) drawLetterbox();
  for (const l of state.layers) {
    if (l.type === 'text')  drawTextLayer(l, t);
    else if (l.type === 'logo' || l.type === 'image') drawLogoLayer(l, t);
    else if (l.type === 'color') drawColorLayer(l, t);
  }
  if (state.fx.vignette) drawVignette();
  drawSelection();
}

function loop() {
  draw();
  if (video.duration > 0) {
    if (scrubber) {
      const p = (video.currentTime / video.duration) * 1000;
      scrubber.value = p;
      scrubber.style.setProperty('--p', (p/10).toFixed(1) + '%');
    }
    $('time-display').textContent =
      `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
  }
  requestAnimationFrame(loop);
}

// ============================================================
//  Floating canvas toolbar
// ============================================================
function positionFloatingToolbar() {
  const sel = state.layers.find(l => l.id === state.selectedId);
  if (!sel) { canvasFloatingEl.classList.add('hidden'); return; }
  const b = getLayerBounds(sel);
  const r = stageInner.getBoundingClientRect();
  const inner = stageInner;
  const x = (b.x + b.w/2) / canvasW * inner.clientWidth;
  const y = (b.y) / canvasH * inner.clientHeight - 44;
  canvasFloatingEl.style.left = `${clamp(x - 110, 6, inner.clientWidth - 220)}px`;
  canvasFloatingEl.style.top  = `${clamp(y, 6, inner.clientHeight - 40)}px`;
  canvasFloatingEl.classList.remove('hidden');
  refreshIcons();
}

// ============================================================
//  Layers panel
// ============================================================
function typeIcon(t) {
  if (t === 'text')  return 'type';
  if (t === 'image') return 'image';
  if (t === 'logo')  return 'bookmark';   // distinct from image so users can tell them apart in the panel
  return 'square';
}
function typeClass(t) { return 't-' + t; }

function tlRender() {
  try { window.MC?.timeline?.render?.(); } catch {}
}

function renderLayersPanel() {
  tlRender();
  const t = window.MC?.i18n?.t || ((k)=>k);
  const empty = state.layers.length === 0;
  if (empty) {
    layersPanelEl.innerHTML = `
      <div class="layers-empty">
        <i data-lucide="square-stack" class="empty-icon"></i>
        <div>${escapeHTML(t('layers.empty.title'))}</div>
        <div class="muted small">${escapeHTML(t('layers.empty.sub'))}</div>
      </div>`;
    refreshIcons();
    return;
  }
  // Render top→bottom = top of z-stack first (last in array)
  const rows = [...state.layers].reverse().map(l => {
    const active = (state.selectedIds.has(l.id) || l.id === state.selectedId) ? 'active' : '';
    const hidden = !l.visible ? 'is-hidden' : '';
    return `
      <div class="layer-row ${active} ${hidden}" data-id="${l.id}">
        <span class="layer-grip" title="Drag to reorder"><i data-lucide="grip-vertical"></i></span>
        <button class="layer-eye ${l.visible?'':'off'}" data-act="eye" title="Visibility">
          <i data-lucide="${l.visible?'eye':'eye-off'}"></i>
        </button>
        <button class="layer-lock ${l.locked?'on':''}" data-act="lock" title="Lock">
          <i data-lucide="${l.locked?'lock':'unlock'}"></i>
        </button>
        <span class="layer-type ${typeClass(l.type)}"><i data-lucide="${typeIcon(l.type)}"></i></span>
        <div class="layer-name" data-act="name" title="Double-click to rename">${escapeHTML(l.name || l.type)}</div>
        <button class="layer-del" data-act="del" title="Delete"><i data-lucide="x"></i></button>
      </div>`;
  }).join('');
  layersPanelEl.innerHTML = rows;
  refreshIcons();

  // Sortable for reordering
  if (window.Sortable) {
    if (layersPanelEl._sortable) layersPanelEl._sortable.destroy();
    layersPanelEl._sortable = new Sortable(layersPanelEl, {
      animation: 200,
      ghostClass: 'sortable-ghost',
      dragClass: 'sortable-drag',
      handle: '.layer-grip',         // explicit drag handle = the grip icon
      onEnd: () => {
        // Read DOM order (top→bottom = visual top-of-stack), reverse to get array order
        const ids = [...layersPanelEl.querySelectorAll('.layer-row')].map(r => r.dataset.id);
        const map = new Map(state.layers.map(l => [l.id, l]));
        state.layers = ids.map(id => map.get(id)).reverse().filter(Boolean);
        snapshot(); draw();
      },
    });
  }

  // Row events
  layersPanelEl.querySelectorAll('.layer-row').forEach(row => {
    const id = row.dataset.id;
    row.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'eye') { toggleVisibility(id); return; }
      if (act === 'lock') { toggleLock(id); return; }
      if (act === 'del')  { deleteLayer(id); return; }
      if (act === 'name') return; // dblclick handled below
      if (e.shiftKey) selectAdd(id);
      else selectOnly(id);
      renderLayersPanel(); renderInspector(); positionFloatingToolbar(); draw();
    });
    const nameEl = row.querySelector('.layer-name');
    nameEl.addEventListener('dblclick', () => beginRename(id, nameEl));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      state.selectedId = id;
      renderLayersPanel(); renderInspector(); draw();
      showContextMenu(e.clientX, e.clientY, contextItemsForLayer(id));
    });
  });
}

function beginRename(id, el) {
  const l = state.layers.find(L => L.id === id); if (!l) return;
  el.classList.add('editing');
  el.innerHTML = `<input type="text" value="${escapeHTML(l.name||'')}" />`;
  const inp = el.querySelector('input'); inp.focus(); inp.select();
  const commit = () => {
    l.name = inp.value.trim() || l.name;
    el.classList.remove('editing');
    renderLayersPanel(); snapshot();
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') { renderLayersPanel(); }
  });
}

function toggleVisibility(id) {
  const l = state.layers.find(L => L.id === id); if (!l) return;
  l.visible = !l.visible; renderLayersPanel(); draw(); snapshot();
}
function toggleLock(id) {
  const l = state.layers.find(L => L.id === id); if (!l) return;
  l.locked = !l.locked; renderLayersPanel(); draw(); snapshot();
}
function deleteLayer(id) {
  state.layers = state.layers.filter(L => L.id !== id);
  if (state.selectedId === id) state.selectedId = null;
  renderLayersPanel(); renderInspector(); positionFloatingToolbar(); draw(); snapshot();
}
function duplicateLayer(id) {
  const l = state.layers.find(L => L.id === id); if (!l) return;
  const c = JSON.parse(JSON.stringify({...l, img:undefined}));
  c.id = uid(); c.name = (l.name||'Layer') + ' copy'; c.x += 30; c.y += 30;
  if (l.type === 'logo' && l.url) {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.src = l.url; c.img = img;
  }
  state.layers.push(c);
  state.selectedId = c.id;
  renderLayersPanel(); renderInspector(); draw(); snapshot();
}
function bringToFront(id) {
  const i = state.layers.findIndex(L => L.id === id); if (i<0) return;
  const [l] = state.layers.splice(i, 1); state.layers.push(l);
  renderLayersPanel(); draw(); snapshot();
}
function sendToBack(id) {
  const i = state.layers.findIndex(L => L.id === id); if (i<0) return;
  const [l] = state.layers.splice(i, 1); state.layers.unshift(l);
  renderLayersPanel(); draw(); snapshot();
}

// ============================================================
//  Inspector (contextual)
// ============================================================
function renderInspector() {
  const l = state.layers.find(L => L.id === state.selectedId);
  $('inspector-title').textContent = l ? (l.name || 'Layer') : 'Inspector';

  if (!l) {
    const t = window.MC?.i18n?.t || ((k)=>k);
    inspectorBodyEl.innerHTML = `
      <div class="inspector-empty">
        <i data-lucide="mouse-pointer-2" class="empty-icon"></i>
        <div class="muted small">${escapeHTML(t('inspector.empty'))}</div>
      </div>`;
    refreshIcons();
    return;
  }

  const opacityPct = Math.round((l.opacity ?? 1) * 100);
  let html = '';
  const kfPill = (prop) => {
    const has = (l.kf?.[prop]?.length || 0) > 0;
    const cur = video && hasKeyframeAt(l, prop, video.currentTime || 0);
    return `<button class="kf-pill ${has?'has':''} ${cur?'on':''}" data-kf="${prop}" title="Toggle keyframe at playhead">◆</button>`;
  };
  html += `<div class="inspector-section">
    <div class="inspector-section-label">Position & size</div>
    <div class="row-grid-2">
      <label class="row col"><span class="row-lbl"><span data-scrub="x">X</span>${kfPill('x')}</span><input type="number" data-prop="x" value="${Math.round(l.x)}"/></label>
      <label class="row col"><span class="row-lbl"><span data-scrub="y">Y</span>${kfPill('y')}</span><input type="number" data-prop="y" value="${Math.round(l.y)}"/></label>
    </div>
    <label class="row col"><span class="row-lbl"><span data-scrub="rotation">Rotation (°)</span>${kfPill('rotation')}</span><input type="number" step="1" data-prop="rotation" value="${Math.round(l.rotation||0)}"/></label>`;

  if (l.type === 'text') {
    html += `
      <label class="row col"><span class="row-lbl"><span data-scrub="fontSize">Size</span>${kfPill('fontSize')}</span><input type="number" data-prop="fontSize" value="${l.fontSize}"/></label>
      <label class="row col no-scrub"><span class="no-scrub">Text</span><input type="text" data-prop="text" value="${escapeHTML(l.text)}"/></label>
      <label class="row col no-scrub"><span class="no-scrub">Font</span>
        <select data-prop="fontFamily">${FONTS.map(f=>`<option ${f===l.fontFamily?'selected':''}>${f}</option>`).join('')}</select></label>
      <div class="row-grid-2">
        <label class="row col no-scrub"><span class="no-scrub">Weight</span>
          <select data-prop="fontWeight">${[300,400,500,600,700,800,900].map(w=>`<option value="${w}" ${w==l.fontWeight?'selected':''}>${w}</option>`).join('')}</select></label>
        <label class="row col no-scrub"><span class="no-scrub">Align</span>
          <select data-prop="align">${['left','center','right'].map(a=>`<option ${a===l.align?'selected':''}>${a}</option>`).join('')}</select></label>
      </div>
      <label class="row no-scrub"><span class="no-scrub">Color</span><input type="color" data-prop="color" value="${l.color}"/></label>`;
  } else if (l.type === 'logo' || l.type === 'image') {
    html += `
      <div class="row-grid-2">
        <label class="row col"><span data-scrub="width">W</span><input type="number" data-prop="width" value="${Math.round(l.width)}"/></label>
        <label class="row col"><span data-scrub="height">H</span><input type="number" data-prop="height" value="${Math.round(l.height)}"/></label>
      </div>
      <label class="row col no-scrub"><span class="no-scrub">Position</span>
        <select data-prop="preset"><option value="">— preset —</option>
          <option value="tl">Top-left</option><option value="tr">Top-right</option>
          <option value="bl">Bottom-left</option><option value="br">Bottom-right</option>
          <option value="c">Center</option></select></label>`;
  } else if (l.type === 'color') {
    html += `<label class="row no-scrub"><span class="no-scrub">Color</span><input type="color" data-prop="color" value="${l.color}"/></label>`;
  }

  html += `</div>`;

  // Common: opacity, blend, animation, timing
  html += `<div class="inspector-section">
    <div class="inspector-section-label">Layer</div>
    <label class="row col"><span class="row-lbl"><span class="no-scrub">Opacity <em>${opacityPct}%</em></span>${kfPill('opacity')}</span>
      <input type="range" min="0" max="100" value="${opacityPct}" data-prop="opacity100"/></label>
    <label class="row col no-scrub"><span class="no-scrub">Blend</span>
      <select data-prop="blendMode">
        ${['source-over','multiply','screen','overlay','soft-light','hard-light','color-dodge','color-burn','difference','lighten','darken'].map(b=>`<option ${b===l.blendMode?'selected':''}>${b}</option>`).join('')}
      </select></label>`;

  if (l.type === 'text') {
    html += `<label class="row col no-scrub"><span class="no-scrub">Animation in</span>
      <select data-prop="animation">
        ${['none','fade','tracking','reveal','typewriter','zoom','glow','bounce','cinematic'].map(a=>`<option ${a===l.animation?'selected':''}>${a}</option>`).join('')}
      </select></label>
      <label class="row col no-scrub"><span class="no-scrub">Animation out</span>
      <select data-prop="exit">
        ${[
          ['auto','auto (matches in)'],
          ['blur','cinematic blur out'],
          ['motion-blur','motion blur drift'],
          ['defocus','defocus glow'],
          ['dissolve','grain dissolve'],
          ['mask-wipe','mask wipe']
        ].map(([v,lbl])=>`<option value="${v}" ${v===(l.exit||'auto')?'selected':''}>${lbl}</option>`).join('')}
      </select></label>`;
  }
  html += `</div>`;

  html += `<div class="inspector-section">
    <div class="inspector-section-label">Timing</div>
    <div class="row-grid-2">
      <label class="row col"><span data-scrub="start">Start</span><input type="number" step="0.1" min="0" value="${l.start}" data-prop="start"/></label>
      <label class="row col"><span data-scrub="end">End</span><input type="number" step="0.1" min="0" value="${l.end}" data-prop="end"/></label>
    </div>
  </div>`;

  inspectorBodyEl.innerHTML = html;
  refreshIcons();
  bindInspectorInputs();
}

function bindInspectorInputs() {
  inspectorBodyEl.querySelectorAll('[data-kf]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const sel = state.layers.find(L => L.id === state.selectedId); if (!sel) return;
      const prop = btn.dataset.kf;
      const t = video?.currentTime || 0;
      toggleKeyframe(sel, prop, t);
      snapshot(); renderInspector(); draw(); tlRender();
    });
  });
  inspectorBodyEl.querySelectorAll('[data-prop]').forEach(inp => {
    const prop = inp.dataset.prop;
    inp.addEventListener('input', () => {
      const sel = state.layers.find(L => L.id === state.selectedId);
      if (!sel) return;
      let val = inp.type === 'number' ? parseFloat(inp.value) : inp.value;
      const t = video?.currentTime || 0;
      if (prop === 'opacity100') {
        sel.opacity = (parseFloat(val)||0)/100;
        if (hasKeyframeAt(sel, 'opacity', t)) setKeyframe(sel, 'opacity', t, sel.opacity);
      } else if (prop === 'preset') {
        applyLogoPreset(sel, val);
      } else {
        sel[prop] = val;
        // If a keyframe already exists at the playhead for this prop, update it
        if (KF_PROPS.includes(prop) && hasKeyframeAt(sel, prop, t)) {
          setKeyframe(sel, prop, t, val);
        }
      }
      draw(); renderLayersPanel();
    });
    inp.addEventListener('change', () => snapshot());
  });
  // Drag-to-scrub on number labels
  inspectorBodyEl.querySelectorAll('span[data-scrub]').forEach(span => {
    const prop = span.dataset.scrub;
    let startX = 0, startVal = 0, dragging = false, raf = null;
    span.addEventListener('mousedown', (e) => {
      const sel = state.layers.find(L => L.id === state.selectedId); if (!sel) return;
      dragging = true; startX = e.clientX; startVal = parseFloat(sel[prop]||0);
      document.body.style.cursor = 'ew-resize';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const sel = state.layers.find(L => L.id === state.selectedId); if (!sel) return;
      let factor = 1;
      if (e.shiftKey) factor = 10;
      if (e.altKey)   factor = 0.1;
      const delta = (e.clientX - startX) * factor;
      const newVal = (prop === 'fontSize') ? clamp(Math.round(startVal + delta), 8, 400)
                   : (prop === 'start' || prop === 'end') ? Math.max(0, Math.round((startVal + delta * 0.05) * 10) / 10)
                   : Math.round(startVal + delta);
      sel[prop] = newVal;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { renderInspectorValuesOnly(); draw(); });
    });
    window.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; document.body.style.cursor=''; snapshot(); }
    });
  });
}

function renderInspectorValuesOnly() {
  // Update only numeric input values without rebuilding the whole DOM
  const l = state.layers.find(L => L.id === state.selectedId); if (!l) return;
  inspectorBodyEl.querySelectorAll('input[data-prop]').forEach(inp => {
    const p = inp.dataset.prop;
    if (inp.type === 'number' && p in l && document.activeElement !== inp) inp.value = Math.round(l[p]*100)/100;
  });
}

function applyLogoPreset(l, p) {
  const m = 60;
  if (p === 'tl') { l.x = m; l.y = m; }
  else if (p === 'tr') { l.x = canvasW - l.width - m; l.y = m; }
  else if (p === 'bl') { l.x = m; l.y = canvasH - l.height - m; }
  else if (p === 'br') { l.x = canvasW - l.width - m; l.y = canvasH - l.height - m; }
  else if (p === 'c')  { l.x = (canvasW - l.width)/2; l.y = (canvasH - l.height)/2; }
}

// ============================================================
//  Style controls
// ============================================================
function syncStyleControls() {
  $('fx-vignette').checked = state.fx.vignette;
  $('fx-grain').checked    = state.fx.grain;
  document.querySelectorAll('.grade-chip').forEach(c => c.classList.toggle('on', c.dataset.grade === state.fx.grade));
  applyCanvasFilter();
  $('music-volume').value = state.music.volume;
  $('music-vol-label').textContent = state.music.volume + '%';
  $('music-fadein').checked = state.music.fadeIn;
  $('music-fadeout').checked = state.music.fadeOut;
  $('music-mode').value = state.music.mode;
}

// ============================================================
//  Keyframe engine
//  layer.kf = { x:[{t,v,e}], y:[...], rotation:[...], opacity:[...], scale:[...], fontSize:[...] }
//  Backward compatible: layers without `kf` use scalar properties.
// ============================================================
const EASES = {
  linear:    t => t,
  easeIn:    t => t * t,
  easeOut:   t => 1 - Math.pow(1 - t, 3),
  easeInOut: t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2,
  spring:    t => 1 - Math.pow(1 - t, 5),
  back:      t => 1 + 1.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
};
const KF_PROPS = ['x', 'y', 'rotation', 'opacity', 'scale', 'fontSize'];

function evalKf(kf, t, fallback) {
  if (!kf || !kf.length) return fallback;
  if (t <= kf[0].t) return kf[0].v;
  if (t >= kf[kf.length - 1].t) return kf[kf.length - 1].v;
  for (let i = 1; i < kf.length; i++) {
    if (kf[i].t >= t) {
      const a = kf[i-1], b = kf[i];
      const span = b.t - a.t;
      const p = span > 0 ? (t - a.t) / span : 0;
      const ease = EASES[b.e || 'easeOut'] || EASES.easeOut;
      return a.v + (b.v - a.v) * ease(p);
    }
  }
  return fallback;
}

/** Compute the effective value of a property at time t. */
function effProp(layer, prop, t) {
  const kf = layer.kf?.[prop];
  if (kf && kf.length) return evalKf(kf, t, layer[prop] ?? 0);
  return layer[prop];
}

function setKeyframe(layer, prop, t, value, ease = 'easeOut') {
  if (!layer.kf) layer.kf = {};
  if (!layer.kf[prop]) layer.kf[prop] = [];
  const arr = layer.kf[prop];
  // Replace existing keyframe at this time (within 30ms) or insert sorted
  const EPS = 0.03;
  for (let i = 0; i < arr.length; i++) {
    if (Math.abs(arr[i].t - t) < EPS) { arr[i].v = value; arr[i].e = ease; return; }
  }
  arr.push({ t, v: value, e: ease });
  arr.sort((a, b) => a.t - b.t);
}

function removeKeyframe(layer, prop, t) {
  const arr = layer.kf?.[prop];
  if (!arr) return false;
  const EPS = 0.03;
  const idx = arr.findIndex(k => Math.abs(k.t - t) < EPS);
  if (idx < 0) return false;
  arr.splice(idx, 1);
  if (!arr.length) delete layer.kf[prop];
  if (layer.kf && Object.keys(layer.kf).length === 0) delete layer.kf;
  return true;
}

function hasKeyframeAt(layer, prop, t) {
  const arr = layer.kf?.[prop];
  if (!arr) return false;
  return arr.some(k => Math.abs(k.t - t) < 0.03);
}

function toggleKeyframe(layer, prop, t) {
  if (hasKeyframeAt(layer, prop, t)) {
    removeKeyframe(layer, prop, t);
  } else {
    setKeyframe(layer, prop, t, layer[prop]);
  }
}

// ============================================================
//  Brand Kit
// ============================================================
function brandKey() { return 'mc-brand-' + (state.project || 'default'); }

function loadBrandKit() {
  try {
    const raw = localStorage.getItem(brandKey());
    if (raw) state.brand = Object.assign(state.brand, JSON.parse(raw));
  } catch {}
  syncBrandUI();
}
function saveBrandKit() {
  try { localStorage.setItem(brandKey(), JSON.stringify(state.brand)); } catch {}
}

function syncBrandUI() {
  const b = state.brand;
  if ($('brand-agency'))    $('brand-agency').value    = b.agencyName || '';
  if ($('brand-tagline'))   $('brand-tagline').value   = b.tagline    || '';
  if ($('brand-primary'))   $('brand-primary').value   = b.primary    || '#f0c040';
  if ($('brand-secondary')) $('brand-secondary').value = b.secondary  || '#1a1a1a';
  if ($('brand-font'))      $('brand-font').value      = b.font       || 'Syne';
  const preview = $('brand-logo-preview');
  if (preview) {
    if (b.logoUrl) {
      preview.innerHTML = `<img src="${b.logoUrl}" alt="logo" />`;
      preview.classList.add('has-logo');
    } else {
      preview.innerHTML = `<i data-lucide="image"></i><span>No logo</span>`;
      preview.classList.remove('has-logo');
      refreshIcons();
    }
  }
}

/** Substitute ${brand.X} placeholders in template strings. */
function brandSub(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/\$\{brand\.(\w+)\}/g, (_, k) => {
    const v = state.brand?.[k];
    return v != null && v !== '' ? v : '';
  });
}

function bindBrandKit() {
  const fields = ['agency','tagline','primary','secondary','font'];
  fields.forEach(f => {
    const el = $('brand-' + f);
    if (!el) return;
    el.addEventListener('input', () => {
      const map = { agency:'agencyName', tagline:'tagline', primary:'primary', secondary:'secondary', font:'font' };
      state.brand[map[f]] = el.value;
      saveBrandKit();
    });
  });
  $('brand-logo-pick')?.addEventListener('click', () => $('brand-logo-input').click());
  $('brand-logo-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // Optimistic: use local URL immediately, upload to project for export
    state.brand.logoUrl = URL.createObjectURL(file);
    syncBrandUI(); saveBrandKit();
    try {
      const meta = await uploadFile(file, 'image', () => {});
      state.brand.logoUrl  = meta.url;
      state.brand.logoFile = meta.filename;
      syncBrandUI(); saveBrandKit();
      refreshLibrary();
      toast('Brand logo set', { gold: true });
    } catch (err) {
      toast('Logo upload failed: ' + err.message);
    }
    e.target.value = '';
  });
  $('brand-logo-clear')?.addEventListener('click', () => {
    state.brand.logoUrl = null;
    state.brand.logoFile = null;
    syncBrandUI(); saveBrandKit();
  });
  $('brand-apply-current')?.addEventListener('click', applyBrandToCurrentLayers);
}

function applyBrandToCurrentLayers() {
  const b = state.brand;
  let touched = 0;
  for (const l of state.layers) {
    if (l.type === 'text') {
      if (b.font)      { l.fontFamily = b.font; touched++; }
    }
    if (l.type === 'color') {
      if (b.primary)   { l.color = b.primary; touched++; }
    }
  }
  toast(`Applied brand to ${touched} layers`, { gold: true });
  draw(); snapshot();
}

// ============================================================
//  MAGIC EDIT — AI-assisted cinematic generation (v1)
//  Frontend-only MVP. Builds a polished overlay sequence over the
//  currently loaded video using brand kit + chosen style + pacing.
//  Beat-snaps title timings if music is present.
//
//  Future evolution (next sessions):
//   - Multi-clip auto-cut via FFmpeg concat + xfade
//   - Backend shot scoring (signalstats / scene detection)
//   - Local-first ML for highlight detection (mediapipe / ONNX)
//   - Drone vs interior auto-classifier
//   - Auto-caption from audio (Whisper.cpp WASM)
//   - Smart re-frame for vertical via face detection
// ============================================================
const MAGIC_STYLES = {
  cinematic: {
    grade: 'cinematic', vignette: true, letterbox: true, grain: true,
    titleFont: 'Playfair Display', titleSize: 110, titleAnim: 'cinematic', titleExit: 'defocus',
    subFont:   'Syne',             subSize:   34,  subAnim:   'fade',      subExit:   'blur',
    accent: '${brand.primary}',
    titleA: 'A FILM BY ${brand.agencyName}',
    titleB: 'Composed in MotionCut',
    titleC: '— end —',
  },
  luxury_re: {
    grade: 'bright_airy', vignette: false, letterbox: false, grain: false,
    titleFont: 'Orbitron',         titleSize: 84, titleAnim: 'tracking',  titleExit: 'mask-wipe',
    subFont:   'Syne',             subSize:   30, subAnim:   'fade',      subExit:   'blur',
    accent: '${brand.primary}',
    titleA: '${brand.agencyName}',
    titleB: 'New Listing',
    titleC: 'Inquire today',
  },
  social_reel: {
    grade: 'moody_dark', vignette: true, letterbox: false, grain: false,
    titleFont: 'Bebas Neue',       titleSize: 180, titleAnim: 'bounce',   titleExit: 'mask-wipe',
    subFont:   'Syne',             subSize:   42,  subAnim:  'fade',      subExit:  'blur',
    accent: '${brand.primary}',
    titleA: 'WAIT FOR IT',
    titleB: 'GAME · CHANGER',
    titleC: '#fyp #foryou',
  },
  editorial: {
    grade: 'natural', vignette: false, letterbox: true, grain: true,
    titleFont: 'Playfair Display', titleSize: 90, titleAnim: 'cinematic', titleExit: 'dissolve',
    subFont:   'Inter',            subSize:   28, subAnim:  'fade',       subExit:  'blur',
    accent: '${brand.primary}',
    titleA: 'CHAPTER · ONE',
    titleB: 'A short story',
    titleC: 'Continued.',
  },
  modern_luxury: {
    grade: 'cinematic', vignette: true, letterbox: false, grain: false,
    titleFont: 'Manrope',          titleSize: 84, titleAnim: 'tracking',  titleExit: 'blur',
    subFont:   'Manrope',          subSize:   28, subAnim:  'fade',       subExit:  'blur',
    accent: '${brand.primary}',
    titleA: '${brand.agencyName}',
    titleB: '${brand.tagline}',
    titleC: '— next chapter —',
  },
  moody: {
    grade: 'moody_dark', vignette: true, letterbox: true, grain: true,
    titleFont: 'Playfair Display', titleSize: 100, titleAnim: 'cinematic', titleExit: 'defocus',
    subFont:   'Syne',             subSize:   28,  subAnim:  'fade',       subExit:  'blur',
    accent: '${brand.primary}',
    titleA: 'IN  THE  QUIET',
    titleB: 'breathe',
    titleC: '— ad infinitum —',
  },
  energetic: {
    grade: 'teal_orange', vignette: false, letterbox: false, grain: false,
    titleFont: 'Bebas Neue',       titleSize: 200, titleAnim: 'bounce',   titleExit: 'mask-wipe',
    subFont:   'Space Grotesk',    subSize:   40,  subAnim:  'reveal',    subExit:  'blur',
    accent: '${brand.primary}',
    titleA: 'GO!',
    titleB: 'MOVE · FAST',
    titleC: 'SHIP IT',
  },
  corporate: {
    grade: 'natural', vignette: false, letterbox: false, grain: false,
    titleFont: 'Inter',            titleSize: 64, titleAnim: 'fade',      titleExit: 'blur',
    subFont:   'Inter',            subSize:   26, subAnim:  'fade',       subExit:  'blur',
    accent: '${brand.primary}',
    titleA: '${brand.agencyName}',
    titleB: '${brand.tagline}',
    titleC: 'Q4 · 2026',
  },
};

const PACING_PROFILES = {
  // segments per minute (approximately)
  slow:     { sps: 6,  ease: 'easeOut',   zoomAmt: 0.08, vignettePulse: false },
  balanced: { sps: 9,  ease: 'easeOut',   zoomAmt: 0.10, vignettePulse: false },
  fast:     { sps: 14, ease: 'easeOutQuart', zoomAmt: 0.14, vignettePulse: true },
};

/** Snap a target time to the nearest beat within tolerance, if possible. */
function snapTimeToBeat(t, tolerance = 0.25) {
  const beats = state.beats;
  if (!beats || !beats.length) return t;
  let best = t, bd = tolerance + 1;
  for (const b of beats) {
    const d = Math.abs(b - t);
    if (d < bd) { bd = d; best = b; }
  }
  return bd <= tolerance ? best : t;
}

// ============================================================
//  Magic Edit — backend-driven planner (push 5)
//
//  Flow:
//    1. user opens modal, picks options, clicks "Generate"
//    2. we list project clips, build EditRequest, POST /api/auto-edit
//    3. backend analyses clips (FFmpeg) and returns an EditPlan
//    4. we show a preview summary and Apply/Regenerate buttons
//    5. on Apply → mutate state from the plan, save, draw
// ============================================================

/** Entry point bound to the modal's "Generate" button. */
async function generateMagicEdit(opts) {
  if (!state.video) { toast('Drop a video first'); return; }

  // Cache the inputs so Regenerate can re-run with the same parameters
  state._pendingOpts = opts;

  // Move modal into the loading state
  showMagicLoading('Listing project clips…');

  // 1. Pull the project's video files from the existing project-files endpoint
  let videoClipFilenames = [];
  try {
    const r = await fetch('/api/projects/' + encodeURIComponent(state.project) + '/files');
    const data = await r.json();
    videoClipFilenames = (data.files || [])
      .filter(f => f.kind === 'video')
      .map(f => f.name);
  } catch (e) {
    hideMagicLoading();
    toast('Could not list project files: ' + e.message);
    return;
  }
  if (!videoClipFilenames.length) {
    hideMagicLoading();
    toast('No video clips in this project. Drop some first.');
    return;
  }

  // 2. If beats were detected this session but haven't been autosaved yet,
  //    flush them now so the backend planner can read them from the doc.
  //    Without this, fresh-music + immediate Magic Edit silently misses
  //    beat-snap (the doc's audio.beat_anchors is empty until autosave fires).
  if (state.beats?.length && !state.audio?.beat_anchors?.length) {
    showMagicLoading('Flushing beat anchors…');
    try { await window.MC.project.save(state); }
    catch (e) { console.warn('[magic] beat flush failed', e); }
  }

  // 3. Build the EditRequest (matches the backend's expected shape)
  const editRequest = {
    projectId:      state.project,
    duration:       parseFloat(opts.duration) || 30,
    aspectRatio:    opts.aspect,
    pacing:         opts.pacing,
    styleId:        opts.style,
    musicFilename:  state.audio?.filename || null,
    clipFilenames:  videoClipFilenames,
  };

  showMagicLoading(`Analyzing ${videoClipFilenames.length} clip${videoClipFilenames.length===1?'':'s'}…`);

  // 3. Call the backend planner
  let plan = null;
  try {
    const r = await fetch('/api/auto-edit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(editRequest),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `auto-edit failed (${r.status})`);
    plan = data;
  } catch (e) {
    hideMagicLoading();
    toast('Auto-edit failed: ' + e.message);
    return;
  }

  // 4. Move modal into the preview state
  state._pendingPlan = plan;
  showMagicPreview(plan, opts);
}

/** Render the EditPlan as a human-readable summary inside the modal. */
function showMagicPreview(plan, opts) {
  hideMagicLoading();
  const el = $('magic-preview');
  if (!el) return;

  const segHTML = plan.segments.map((s, i) => {
    const dur = (s.sourceOut - s.sourceIn).toFixed(2);
    const trans = s.transition?.type || 'cut';
    const display = (s.clipFilename || '').replace(/^[a-f0-9]+_/, '');
    return `
      <div class="magic-seg-row">
        <span class="magic-seg-num mono">${String(i+1).padStart(2,'0')}</span>
        <span class="magic-seg-name" title="${escapeHTML(display)}">${escapeHTML(display)}</span>
        <span class="magic-seg-source mono">${s.sourceIn.toFixed(1)} → ${s.sourceOut.toFixed(1)}</span>
        <span class="magic-seg-dur mono">${dur}s</span>
        <span class="magic-seg-trans">${trans}</span>
      </div>`;
  }).join('');

  const slots = plan.overlaySlots || {};
  const slotLine = (lbl, s) => s
    ? `<span class="magic-slot"><strong>${lbl}</strong> ${s.in.toFixed(1)}–${s.out.toFixed(1)}s</span>`
    : '';

  el.innerHTML = `
    <div class="magic-preview-head">
      <div class="magic-preview-title">Edit plan ready</div>
      <div class="magic-preview-meta">
        <strong>${plan.meta.totalDuration}s</strong> ·
        ${plan.meta.clipCount} segments ·
        ${plan.meta.pacing} pacing ·
        ${plan.meta.aspectRatio}
      </div>
    </div>
    <div class="magic-segs">${segHTML}</div>
    <div class="magic-slots">
      ${slotLine('Opening', slots.opening_title)}
      ${slotLine('Mid',     slots.mid_title)}
      ${slotLine('Closing', slots.closing_title)}
    </div>
    <div class="magic-audio">
      <i data-lucide="music"></i>
      ${plan.audio?.musicFilename
        ? `<span>${escapeHTML(plan.audio.musicFilename.replace(/^[a-f0-9]+_/, ''))} · ${Math.round((plan.audio.volume||0)*100)}% · fade ${plan.audio.fadeIn}s in / ${plan.audio.fadeOut}s out</span>`
        : '<span class="muted">no music</span>'}
    </div>
    ${plan.meta.failedClips?.length
      ? `<div class="magic-failed muted small"><i data-lucide="alert-triangle"></i> ${plan.meta.failedClips.length} clip(s) failed analysis: ${plan.meta.failedClips.map(escapeHTML).join(', ')}</div>`
      : ''}
  `;
  el.classList.remove('hidden');
  $('magic-summary').classList.add('hidden');
  $('magic-go').classList.add('hidden');
  $('magic-apply').classList.remove('hidden');
  $('magic-regen').classList.remove('hidden');
  refreshIcons();
}

function showMagicLoading(text) {
  const wrap = $('magic-loading');
  if (!wrap) return;
  $('magic-loading-text').textContent = text || 'Working…';
  wrap.classList.remove('hidden');
  $('magic-summary')?.classList.add('hidden');
  $('magic-preview')?.classList.add('hidden');
  $('magic-go').classList.add('hidden');
  $('magic-apply').classList.add('hidden');
  $('magic-regen').classList.add('hidden');
}

function hideMagicLoading() {
  $('magic-loading')?.classList.add('hidden');
}

function resetMagicModal() {
  hideMagicLoading();
  $('magic-preview')?.classList.add('hidden');
  $('magic-summary')?.classList.remove('hidden');
  $('magic-go').classList.remove('hidden');
  $('magic-apply').classList.add('hidden');
  $('magic-regen').classList.add('hidden');
}

/** Apply an EditPlan to the editor state. state.video stays singular for now;
 *  the full plan is preserved on state.editPlan for future multi-clip work. */
async function applyMagicPlan() {
  const plan = state._pendingPlan;
  const opts = state._pendingOpts;
  if (!plan || !opts) return;

  const styleId = opts.style || 'cinematic';
  const style   = MAGIC_STYLES[styleId] || MAGIC_STYLES.cinematic;

  // 1. Style the project (aspect + grade + vignette + grain + letterbox)
  setAspect(opts.aspect);
  state.fx.grade    = style.grade;
  state.fx.vignette = style.vignette;
  state.fx.grain    = style.grain;
  state.letterbox   = style.letterbox;
  syncStyleControls();

  // 2. Convert the EditPlan's segments into runtime state.segments so the
  //    timeline shows every clip as its own block. The first segment also
  //    gets activated as the "playing" source. inMark/outMark are cleared —
  //    multi-clip exports use the segments array, not the legacy marks.
  if (Array.isArray(plan.segments) && plan.segments.length) {
    state.segments = plan.segments.map(s => makeSegment({
      filename:  s.clipFilename,
      url:       segmentUrl(s.clipFilename),
      kind:      'video',
      sourceIn:  s.sourceIn,
      sourceOut: s.sourceOut,
      transition: s.transition || { type: 'cut', duration: 0 },
    }));
    reflowSegments(state.segments);
    activateSegment(state.segments[0], state.segments[0].sourceIn);
  }
  state.inMark = state.outMark = null;
  state.editPlan = plan;

  // 3. Replace overlay layers with title cards anchored to plan.overlaySlots
  state.layers = [];
  state.selectedIds.clear();
  state.selectedId = null;

  const slots = plan.overlaySlots || {};
  const titleSpecs = [
    { slot: slots.opening_title, text: brandSub(style.titleA),
      font: style.titleFont, size: style.titleSize,
      anim: style.titleAnim, exit: style.titleExit, color: '#ffffff' },
    { slot: slots.mid_title,     text: brandSub(style.titleB),
      font: style.subFont,   size: style.subSize,
      anim: style.subAnim,   exit: style.subExit,
      color: brandSub(style.accent) },
    { slot: slots.closing_title, text: brandSub(style.titleC),
      font: style.titleFont, size: Math.round(style.titleSize * 0.7),
      anim: style.titleAnim, exit: style.titleExit, color: '#ffffff' },
  ];
  for (const spec of titleSpecs) {
    if (!spec.text || !spec.slot) continue;
    state.layers.push(makeTextLayer({
      text: spec.text, fontFamily: spec.font, fontSize: spec.size,
      x: canvasW / 2, y: canvasH * 0.5, color: spec.color,
      animation: spec.anim, exit: spec.exit,
      start: spec.slot.in, end: spec.slot.out,
    }));
  }

  // 4. Inject brand logo if available (top-left, throughout)
  if (state.brand?.logoUrl) {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.src = state.brand.logoUrl;
    const w = Math.min(220, canvasW * 0.10);
    const logo = makeLogoLayer({
      src: state.brand.logoFile || 'brand_logo',
      url: state.brand.logoUrl, img,
      x: canvasW * 0.04, y: canvasH * 0.04,
      width: w, height: w,
      opacity: 0.92, _brandLogo: true,
      start: 0, end: state.outMark || 9999,
    });
    img.onload = () => { logo.height = w / (img.naturalWidth / img.naturalHeight); draw(); };
    state.layers.unshift(logo);
  }

  state.template = 'magic_' + styleId;
  state.selectedId = state.layers[0]?.id || null;
  renderLayersPanel(); renderInspector(); positionFloatingToolbar();
  try { window.MC?.timeline?.render?.(); } catch {}
  draw(); snapshot();

  // 5. Persist immediately so the user can reload and resume.
  //    Save failure must be visible — silent persistence loss would
  //    let the user think their edit is safe when it isn't.
  let saveOk = true;
  try {
    await window.MC.project.save(state);
  } catch (e) {
    saveOk = false;
    console.warn('[magic] save after apply failed', e);
  }

  // 6. Close modal
  $('magic-backdrop').classList.remove('show');
  resetMagicModal();
  state._pendingPlan = null;
  if (saveOk) {
    toast(`Auto-edit applied · ${plan.segments.length} segments`, { gold: true });
  } else {
    toast('Edit applied but save failed — try saving manually');
  }
}

async function regenerateMagicPlan() {
  const opts = state._pendingOpts;
  if (!opts) return;
  state._pendingPlan = null;
  resetMagicModal();
  await generateMagicEdit(opts);
}

// ----------------------------------------------------------------
// Legacy single-clip planner — kept as a fallback if the backend
// is unreachable. Same shape as the old generateMagicEdit so existing
// callers (e.g. unit tests) keep working.
// ----------------------------------------------------------------
function generateMagicEditLocal(opts) {
  if (!state.video) { toast('Drop a video first'); return; }
  const dur     = parseFloat(opts.duration) || 30;
  const aspect  = opts.aspect || '16:9';
  const styleId = opts.style || 'cinematic';
  const pacing  = PACING_PROFILES[opts.pacing] || PACING_PROFILES.balanced;
  const style   = MAGIC_STYLES[styleId] || MAGIC_STYLES.cinematic;

  // Apply scene-level styling
  setAspect(aspect);
  state.fx.grade     = style.grade;
  state.fx.vignette  = style.vignette;
  state.fx.grain     = style.grain;
  state.letterbox    = style.letterbox;
  syncStyleControls();

  // Trim source to the chosen duration
  state.inMark  = 0;
  state.outMark = Math.min(dur, video.duration || dur);

  // Clear existing layers (the magic edit replaces the overlay timeline)
  state.layers   = [];
  state.selectedIds.clear();
  state.selectedId = null;

  // ---- Build segment plan (3 title beats: opener, middle, end) ----
  const segCount = 3;
  const beats = [
    Math.max(0.4, dur * 0.05),
    Math.max(1.0, dur * 0.45),
    Math.max(1.5, dur * 0.85),
  ].map(t => snapTimeToBeat(t));
  const titleDur = Math.min(3.5, dur / segCount);

  const titleSpecs = [
    { text: brandSub(style.titleA), font: style.titleFont, size: style.titleSize,
      anim: style.titleAnim, exit: style.titleExit, color: '#ffffff', start: beats[0] },
    { text: brandSub(style.titleB), font: style.subFont,   size: style.subSize,
      anim: style.subAnim,   exit: style.subExit,   color: brandSub(style.accent), start: beats[1] },
    { text: brandSub(style.titleC), font: style.titleFont, size: Math.round(style.titleSize * 0.7),
      anim: style.titleAnim, exit: style.titleExit, color: '#ffffff', start: beats[2] },
  ];

  for (const spec of titleSpecs) {
    if (!spec.text) continue;
    const startT = spec.start;
    const endT   = Math.min(state.outMark, startT + titleDur);
    const layer = makeTextLayer({
      text: spec.text, fontFamily: spec.font, fontSize: spec.size,
      x: canvasW / 2, y: canvasH * 0.5,
      color: spec.color || '#ffffff',
      animation: spec.anim, exit: spec.exit,
      start: startT, end: endT,
    });
    // Add a subtle Y drift via keyframes (pacing-driven)
    setKeyframe(layer, 'y', startT,         canvasH * 0.5 + 6, 'easeOut');
    setKeyframe(layer, 'y', startT + 0.6,   canvasH * 0.5,     'easeOut');
    setKeyframe(layer, 'y', endT - 0.4,     canvasH * 0.5,     'easeOut');
    setKeyframe(layer, 'y', endT,           canvasH * 0.5 - 4, 'easeOut');
    // Subtle scale breathe for cinematic / luxury / moody
    if (['cinematic','luxury_re','modern_luxury','moody','editorial'].includes(styleId)) {
      setKeyframe(layer, 'scale', startT,             1.0, 'easeOut');
      setKeyframe(layer, 'scale', (startT + endT)/2,  1 + pacing.zoomAmt * 0.18, 'easeInOut');
      setKeyframe(layer, 'scale', endT,               1.0, 'easeOut');
    }
    state.layers.push(layer);
  }

  // Inject brand logo if available (corner placement)
  if (state.brand?.logoUrl) {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.src = state.brand.logoUrl;
    const pad = canvasW * 0.04;
    const w   = Math.min(220, canvasW * 0.10);
    const logo = makeLogoLayer({
      src: state.brand.logoFile || 'brand_logo',
      url: state.brand.logoUrl, img,
      x: pad, y: pad, width: w, height: w,
      opacity: 0.92, _brandLogo: true,
      start: 0, end: state.outMark,
    });
    img.onload = () => { logo.height = w / (img.naturalWidth / img.naturalHeight); draw(); };
    state.layers.unshift(logo);
  }

  // For real estate styles, add a permanent address/price ribbon
  if (styleId === 'luxury_re') {
    const ribbon = makeColorLayer({
      x: 0, y: canvasH * 0.86, width: canvasW, height: canvasH * 0.14,
      color: '#000000', opacity: 0.5, start: 0, end: state.outMark,
    });
    const address = makeTextLayer({
      text: state.brand?.tagline || 'Premium listing',
      fontFamily: style.subFont, fontSize: 32,
      x: canvasW * 0.05, y: canvasH * 0.93, align: 'left',
      color: '#ffffff', animation: 'fade',
      start: 0.4, end: state.outMark, exit: 'blur',
    });
    state.layers.push(ribbon, address);
  }

  state.template = 'magic_' + styleId;
  state.selectedId = state.layers[0]?.id || null;
  renderLayersPanel(); renderInspector(); positionFloatingToolbar();
  try { window.MC?.timeline?.render?.(); } catch {}
  draw(); snapshot();
  if (state.audio && (!state.beats || !state.beats.length)) {
    toast('Tip: detect beats on your music for tighter cuts', { gold: true, ms: 4000 });
  } else {
    toast(`Magic Edit · ${styleId.replace('_',' ')} · ${dur}s`, { gold: true });
  }
}

// ---------- Magic Edit modal wiring ----------
function bindMagicEdit() {
  const backdrop = $('magic-backdrop');
  const open = () => {
    if (!state.video) { toast('Drop a video first to use Magic Edit'); return; }
    backdrop.classList.add('show');
    updateMagicSummary();
    refreshIcons();
  };
  const close = () => backdrop.classList.remove('show');

  $('btn-magic')?.addEventListener('click', () => { resetMagicModal(); open(); });
  $('magic-cancel')?.addEventListener('click', () => { resetMagicModal(); close(); state._pendingPlan = null; });
  $('magic-apply')?.addEventListener('click', applyMagicPlan);
  $('magic-regen')?.addEventListener('click', regenerateMagicPlan);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) { resetMagicModal(); close(); state._pendingPlan = null; }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdrop.classList.contains('show')) {
      e.preventDefault(); resetMagicModal(); close(); state._pendingPlan = null;
    }
  });

  // Chip groups behave like radio buttons
  document.querySelectorAll('.magic-chips').forEach(group => {
    group.addEventListener('click', (e) => {
      const chip = e.target.closest('.magic-chip'); if (!chip) return;
      group.querySelectorAll('.magic-chip').forEach(c => c.classList.toggle('on', c === chip));
      updateMagicSummary();
    });
  });

  $('magic-go')?.addEventListener('click', () => {
    const opts = {
      duration: document.querySelector('.magic-chips[data-group="duration"] .magic-chip.on')?.dataset.value,
      aspect:   document.querySelector('.magic-chips[data-group="aspect"] .magic-chip.on')?.dataset.value,
      style:    document.querySelector('.magic-chips[data-group="style"] .magic-chip.on')?.dataset.value,
      pacing:   document.querySelector('.magic-chips[data-group="pacing"] .magic-chip.on')?.dataset.value,
    };
    // The modal MUST stay open during the loading + preview phases.
    // It only closes on explicit Apply or Cancel.
    generateMagicEdit(opts);
  });
}

function updateMagicSummary() {
  const sum = $('magic-summary'); if (!sum) return;
  const opts = {
    duration: document.querySelector('.magic-chips[data-group="duration"] .magic-chip.on')?.dataset.value,
    aspect:   document.querySelector('.magic-chips[data-group="aspect"] .magic-chip.on')?.dataset.value,
    style:    document.querySelector('.magic-chips[data-group="style"] .magic-chip.on')?.dataset.value,
    pacing:   document.querySelector('.magic-chips[data-group="pacing"] .magic-chip.on')?.dataset.value,
  };
  const beat = state.beats?.length ? `· ${state.beats.length} beats locked` : '';
  const brand = state.brand?.agencyName ? `· branded for ${state.brand.agencyName}` : '';
  sum.innerHTML = `
    <div class="magic-summary-line"><i data-lucide="film"></i> <strong>${opts.duration}s</strong> ${opts.aspect}</div>
    <div class="magic-summary-line"><i data-lucide="palette"></i> <strong>${opts.style.replace('_',' ')}</strong> · ${opts.pacing} pacing</div>
    <div class="magic-summary-line muted"><i data-lucide="check-circle-2"></i> Title cards · keyframe drift · brand-aware ${beat} ${brand}</div>`;
  refreshIcons();
}

// ============================================================
//  Templates
// ============================================================
const templates = {
  cinematic: () => {
    state.template = 'cinematic'; state.letterbox = true;
    state.fx.vignette = true; state.fx.grade = 'cinematic';
    state.layers = [
      makeTextLayer({ text:'A FILM BY YOU', fontFamily:'Playfair Display', fontSize:110, x:canvasW/2, y:canvasH/2-30,
        color:'#ffffff', animation:'cinematic', start:0.4, end:6 }),
      makeTextLayer({ text:'a short documentary', fontFamily:'Syne', fontSize:36, fontWeight:400, x:canvasW/2, y:canvasH/2+60,
        color:'#f0c040', animation:'fade', start:1.0, end:6 }),
    ];
  },
  real_estate: () => {
    state.template = 'real_estate'; state.letterbox = false; state.fx.grade = 'bright_airy';
    state.layers = [
      makeTextLayer({ text:'OAK GROVE RESIDENCE', fontFamily:'Orbitron', fontSize:78, fontWeight:800,
        x:canvasW*0.28, y:canvasH*0.78, align:'left', color:'#ffffff', animation:'tracking', start:0.5, end:12 }),
      makeTextLayer({ text:'Brisbane · QLD', fontFamily:'Syne', fontSize:30, fontWeight:500,
        x:canvasW*0.28, y:canvasH*0.85, align:'left', color:'#f0c040', animation:'fade', start:0.8, end:12 }),
      makeTextLayer({ text:'$1,495,000', fontFamily:'Bebas Neue', fontSize:80,
        x:canvasW*0.85, y:canvasH*0.12, align:'right', color:'#f0c040', animation:'fade', start:0.4, end:12 }),
    ];
  },
  travel: () => {
    state.template = 'travel'; state.letterbox = false; state.fx.grade = 'teal_orange';
    state.layers = [
      makeColorLayer({ x:0, y:canvasH*0.7, width:canvasW, height:canvasH*0.3, color:'#000000', opacity:0.4 }),
      makeTextLayer({ text:'WANDERLUST', fontFamily:'Teko', fontSize:200, fontWeight:700,
        x:canvasW/2, y:canvasH/2, color:'#ffffff', animation:'reveal', start:0.3, end:8 }),
      makeTextLayer({ text:'◷  Kyoto, Japan', fontFamily:'Syne', fontSize:42, fontWeight:500,
        x:canvasW/2, y:canvasH*0.86, color:'#f0c040', animation:'fade', start:1.2, end:10 }),
    ];
  },
  social: () => {
    state.template = 'social'; setAspect('9:16'); state.fx.vignette = true; state.fx.grade = 'moody_dark';
    state.layers = [
      makeTextLayer({ text:'WAIT FOR IT…', fontFamily:'Bebas Neue', fontSize:180,
        x:canvasW/2, y:canvasH*0.25, color:'#ffffff', animation:'bounce', start:0.2, end:5 }),
      makeTextLayer({ text:'#viral  #fyp  #foryou', fontFamily:'Syne', fontSize:48, fontWeight:600,
        x:canvasW/2, y:canvasH*0.9, color:'#f0c040', animation:'fade', start:1.0, end:999 }),
    ];
  },
  corporate: () => {
    state.template = 'corporate'; state.letterbox = false; state.fx.grade = 'natural';
    state.layers = [
      makeTextLayer({ text:'${brand.agencyName}', fontFamily:'Syne', fontSize:36, fontWeight:700,
        x:canvasW*0.92, y:canvasH*0.08, align:'right', color:'#ffffff', animation:'fade', start:0, end:999, exit:'blur' }),
      makeTextLayer({ text:'Building tomorrow,\nshipping today.', fontFamily:'Playfair Display', fontSize:72, fontWeight:700,
        x:canvasW*0.08, y:canvasH*0.5, align:'left', color:'#ffffff', animation:'cinematic', start:0.4, end:999, exit:'blur' }),
      makeColorLayer({ x:canvasW*0.08, y:canvasH*0.6, width:canvasW*0.2, height:3, color:'${brand.primary}', opacity:1 }),
      makeTextLayer({ text:'${brand.tagline}', fontFamily:'JetBrains Mono', fontSize:28, fontWeight:400,
        x:canvasW*0.08, y:canvasH*0.92, align:'left', color:'${brand.primary}', animation:'fade', start:0.8, end:999, exit:'blur' }),
    ];
  },

  // ========== NEW REAL ESTATE TEMPLATES ==========
  re_drone_reveal: () => {
    state.template = 're_drone_reveal'; state.letterbox = false; state.fx.grade = 'bright_airy';
    state.layers = [
      makeColorLayer({ x:0, y:canvasH*0.78, width:canvasW, height:canvasH*0.22,
        color:'#000000', opacity:0.5 }),
      makeTextLayer({ text:'${brand.agencyName}', fontFamily:'${brand.font}', fontSize:30, fontWeight:700,
        x:canvasW*0.06, y:canvasH*0.08, align:'left', color:'#ffffff', animation:'fade', start:0.2, end:999, exit:'blur' }),
      makeTextLayer({ text:'$1,495,000', fontFamily:'Bebas Neue', fontSize:90,
        x:canvasW*0.94, y:canvasH*0.10, align:'right', color:'${brand.primary}', animation:'cinematic', start:0.4, end:999, exit:'mask-wipe' }),
      makeTextLayer({ text:'4 OAK GROVE AVENUE', fontFamily:'Orbitron', fontSize:72, fontWeight:800,
        x:canvasW*0.06, y:canvasH*0.86, align:'left', color:'#ffffff', animation:'tracking', start:0.8, end:999, exit:'blur' }),
      makeTextLayer({ text:'Brisbane · QLD · 4 bd · 3 ba', fontFamily:'${brand.font}', fontSize:28, fontWeight:500,
        x:canvasW*0.06, y:canvasH*0.94, align:'left', color:'${brand.primary}', animation:'fade', start:1.2, end:999 }),
    ];
  },

  re_property_tour: () => {
    state.template = 're_property_tour'; state.letterbox = true; state.fx.grade = 'cinematic';
    state.layers = [
      makeTextLayer({ text:'A LIFE WELL LIVED', fontFamily:'Playfair Display', fontSize:120, fontWeight:700,
        x:canvasW/2, y:canvasH*0.42, color:'#ffffff', animation:'cinematic', start:0.5, end:5, exit:'defocus' }),
      makeTextLayer({ text:'A property by ${brand.agencyName}', fontFamily:'${brand.font}', fontSize:32, fontWeight:400,
        x:canvasW/2, y:canvasH*0.55, color:'${brand.primary}', animation:'fade', start:1.2, end:5, exit:'blur' }),
    ];
  },

  re_listing_card: () => {
    state.template = 're_listing_card'; setAspect('1:1'); state.fx.grade = 'bright_airy';
    state.layers = [
      makeColorLayer({ x:0, y:canvasH*0.7, width:canvasW, height:canvasH*0.3,
        color:'#000000', opacity:0.6 }),
      makeTextLayer({ text:'NEW LISTING', fontFamily:'Bebas Neue', fontSize:60,
        x:canvasW/2, y:canvasH*0.78, color:'${brand.primary}', animation:'tracking', start:0.3, end:999 }),
      makeTextLayer({ text:'$1,495,000', fontFamily:'Orbitron', fontSize:90, fontWeight:800,
        x:canvasW/2, y:canvasH*0.88, color:'#ffffff', animation:'cinematic', start:0.7, end:999, exit:'mask-wipe' }),
      makeTextLayer({ text:'4 OAK GROVE AVE · BRISBANE', fontFamily:'${brand.font}', fontSize:28, fontWeight:500,
        x:canvasW/2, y:canvasH*0.96, color:'${brand.primary}', animation:'fade', start:1.0, end:999 }),
    ];
  },

  re_agent_intro: () => {
    state.template = 're_agent_intro'; setAspect('9:16'); state.letterbox = false; state.fx.grade = 'bright_airy';
    state.layers = [
      makeColorLayer({ x:0, y:canvasH*0.82, width:canvasW, height:canvasH*0.18,
        color:'${brand.secondary}', opacity:0.85 }),
      makeColorLayer({ x:canvasW*0.06, y:canvasH*0.84, width:canvasW*0.15, height:4,
        color:'${brand.primary}', opacity:1 }),
      makeTextLayer({ text:'${brand.agencyName}', fontFamily:'${brand.font}', fontSize:42, fontWeight:700,
        x:canvasW*0.06, y:canvasH*0.88, align:'left', color:'#ffffff', animation:'fade', start:0.3, end:999, exit:'blur' }),
      makeTextLayer({ text:'${brand.tagline}', fontFamily:'${brand.font}', fontSize:30, fontWeight:400,
        x:canvasW*0.06, y:canvasH*0.94, align:'left', color:'${brand.primary}', animation:'fade', start:0.7, end:999 }),
    ];
  },

  // ========== NEW SOCIAL TEMPLATES ==========
  social_hook_reveal: () => {
    state.template = 'social_hook_reveal'; setAspect('9:16'); state.fx.vignette = true; state.fx.grade = 'moody_dark';
    state.layers = [
      makeTextLayer({ text:'WAIT  FOR  IT', fontFamily:'Bebas Neue', fontSize:200,
        x:canvasW/2, y:canvasH*0.30, color:'#ffffff', animation:'bounce', start:0.2, end:3, exit:'blur' }),
      makeTextLayer({ text:'…', fontFamily:'Bebas Neue', fontSize:200,
        x:canvasW/2, y:canvasH*0.45, color:'${brand.primary}', animation:'typewriter', start:1.5, end:3, exit:'dissolve' }),
      makeTextLayer({ text:'😱  GAME CHANGER', fontFamily:'Bebas Neue', fontSize:160,
        x:canvasW/2, y:canvasH*0.45, color:'${brand.primary}', animation:'reveal', start:3.2, end:7, exit:'mask-wipe' }),
      makeTextLayer({ text:'#fyp  #foryou  #viral', fontFamily:'${brand.font}', fontSize:46, fontWeight:600,
        x:canvasW/2, y:canvasH*0.92, color:'#ffffff', animation:'fade', start:1.0, end:999 }),
    ];
  },

  social_listicle: () => {
    state.template = 'social_listicle'; setAspect('9:16'); state.fx.grade = 'cinematic';
    state.layers = [
      makeTextLayer({ text:'5 THINGS', fontFamily:'Bebas Neue', fontSize:200,
        x:canvasW/2, y:canvasH*0.20, color:'${brand.primary}', animation:'cinematic', start:0.2, end:3, exit:'blur' }),
      makeTextLayer({ text:'YOU NEED', fontFamily:'Bebas Neue', fontSize:120,
        x:canvasW/2, y:canvasH*0.32, color:'#ffffff', animation:'tracking', start:0.6, end:3, exit:'blur' }),
      makeTextLayer({ text:'TO KNOW', fontFamily:'Bebas Neue', fontSize:120,
        x:canvasW/2, y:canvasH*0.42, color:'#ffffff', animation:'tracking', start:1.0, end:3, exit:'blur' }),
      makeTextLayer({ text:'★  ★  ★  ★  ★', fontFamily:'${brand.font}', fontSize:60, fontWeight:600,
        x:canvasW/2, y:canvasH*0.55, color:'${brand.primary}', animation:'reveal', start:1.5, end:3, exit:'fade' }),
    ];
  },

  // ========== NEW CINEMATIC / KINETIC TEMPLATES ==========
  cinematic_three_act: () => {
    state.template = 'cinematic_three_act'; state.letterbox = true; state.fx.grade = 'cinematic'; state.fx.vignette = true;
    state.layers = [
      makeTextLayer({ text:'I.  THE OPENING', fontFamily:'Playfair Display', fontSize:96, fontWeight:700,
        x:canvasW/2, y:canvasH/2, color:'#ffffff', animation:'cinematic', start:0.4, end:3.5, exit:'defocus' }),
      makeTextLayer({ text:'II.  THE TURN', fontFamily:'Playfair Display', fontSize:96, fontWeight:700,
        x:canvasW/2, y:canvasH/2, color:'#ffffff', animation:'cinematic', start:4.0, end:7.0, exit:'defocus' }),
      makeTextLayer({ text:'III.  THE PROMISE', fontFamily:'Playfair Display', fontSize:96, fontWeight:700,
        x:canvasW/2, y:canvasH/2, color:'${brand.primary}', animation:'cinematic', start:7.5, end:999, exit:'mask-wipe' }),
    ];
  },

  kinetic_word_pop: () => {
    state.template = 'kinetic_word_pop'; setAspect('9:16'); state.fx.grade = 'moody_dark';
    state.layers = [
      makeTextLayer({ text:'BOLD', fontFamily:'Bebas Neue', fontSize:280,
        x:canvasW/2, y:canvasH*0.30, color:'${brand.primary}', animation:'bounce', start:0.0, end:0.8, exit:'blur' }),
      makeTextLayer({ text:'BIGGER', fontFamily:'Bebas Neue', fontSize:240,
        x:canvasW/2, y:canvasH*0.45, color:'#ffffff', animation:'bounce', start:0.7, end:1.5, exit:'blur' }),
      makeTextLayer({ text:'BETTER', fontFamily:'Bebas Neue', fontSize:240,
        x:canvasW/2, y:canvasH*0.60, color:'${brand.primary}', animation:'bounce', start:1.4, end:2.5, exit:'mask-wipe' }),
      makeTextLayer({ text:'${brand.agencyName}', fontFamily:'${brand.font}', fontSize:46, fontWeight:600,
        x:canvasW/2, y:canvasH*0.92, color:'#ffffff', animation:'fade', start:2.5, end:999 }),
    ];
  },
};
function applyTemplate(name) {
  if (!templates[name]) return;
  templates[name]();
  // Resolve ${brand.X} placeholders across text + color + font fields
  for (const l of state.layers) {
    if (l.text)        l.text       = brandSub(l.text);
    if (l.color)       l.color      = brandSub(l.color);
    if (l.fontFamily)  l.fontFamily = brandSub(l.fontFamily) || l.fontFamily;
    // If brand left an empty result (e.g. unset agency name), fall back to type label
    if (l.type === 'text' && !l.text) l.text = '—';
  }
  // Auto-add a brand logo layer if available and template doesn't already have a logo
  if (state.brand?.logoUrl && !state.layers.some(l => l.type === 'logo' && l._brandLogo)) {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.src = state.brand.logoUrl;
    const logo = makeLogoLayer({
      src: state.brand.logoFile || 'brand_logo',
      url: state.brand.logoUrl,
      img,
      x: 60, y: 60,
      width: Math.min(220, canvasW * 0.12),
      height: Math.min(220, canvasW * 0.12),
      opacity: 0.95,
      _brandLogo: true,
    });
    img.onload = () => {
      const r = img.naturalWidth / img.naturalHeight;
      logo.height = logo.width / r;
      draw();
    };
    state.layers.unshift(logo);
  }
  state.selectedId = state.layers[0]?.id || null;
  renderLayersPanel(); renderInspector(); syncStyleControls(); positionFloatingToolbar();
  snapshot(); draw();
  toast(`Template: ${name.replace(/_/g,' ')}`, { gold:true });
}

// ============================================================
//  Mini template previews (animated canvas thumbnails)
// ============================================================
const TPL_PREVIEWS = {
  cinematic: {
    duration: 4, letterbox: true,
    items: [
      { text:'A FILM',  font:'Playfair Display', size:13, weight:700, x:50, y:46, color:'#fff', anim:'cinematic', start:0.3, end:3.6 },
      { text:'BY YOU',  font:'Syne',  size:6,  weight:500, x:50, y:62, color:'#f0c040', anim:'fade',     start:0.7, end:3.6 },
    ],
  },
  real_estate: {
    duration: 4,
    items: [
      { text:'$1.4M',   font:'Bebas Neue',  size:13, weight:400, x:75, y:25, color:'#f0c040', anim:'fade',     start:0.2, end:3.6 },
      { text:'OAK GROVE',font:'Orbitron',   size:7,  weight:800, x:30, y:78, color:'#fff',    anim:'tracking', start:0.4, end:3.6, align:'left' },
    ],
  },
  travel: {
    duration: 4,
    items: [
      { text:'WANDER', font:'Teko',  size:20, weight:700, x:50, y:50, color:'#fff',    anim:'reveal', start:0.3, end:3.6 },
      { text:'◷ Kyoto', font:'Syne', size:5,  weight:500, x:50, y:84, color:'#f0c040', anim:'fade',   start:1.0, end:3.6 },
    ],
  },
  social: {
    duration: 3,
    items: [
      { text:'WAIT', font:'Bebas Neue', size:18, weight:400, x:50, y:36, color:'#fff',    anim:'bounce', start:0.2, end:2.8 },
      { text:'#fyp', font:'Syne',       size:6,  weight:600, x:50, y:78, color:'#f0c040', anim:'fade',   start:0.7, end:2.8 },
    ],
  },
  corporate: {
    duration: 4,
    items: [
      { text:'ACME',   font:'Syne',           size:5,  weight:700, x:88, y:18, color:'#fff', align:'right', anim:'fade',     start:0.1, end:3.6 },
      { text:'BUILD.', font:'Playfair Display',size:11, weight:700, x:14, y:50, color:'#fff', align:'left',  anim:'cinematic', start:0.4, end:3.6 },
    ],
  },
};

function easeOut3(t) { return 1 - Math.pow(1 - t, 3); }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function drawTplPreview(canvas, spec, t) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Letterbox
  if (spec.letterbox) {
    const bar = H * 0.12;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, bar);
    ctx.fillRect(0, H - bar, W, bar);
  }

  for (const it of spec.items) {
    if (t < it.start || t > it.end) continue;
    let alpha = 1, dx = 0, dy = 0, txt = it.text;
    const local = t - it.start;
    const inP   = clamp01(local / 0.5);
    const outP  = clamp01((it.end - t) / 0.5);
    switch (it.anim) {
      case 'fade':      alpha = Math.min(easeOut3(inP), easeOut3(outP)); break;
      case 'cinematic': alpha = Math.min(easeOut3(inP), easeOut3(outP)); dy = (1 - easeOut3(inP)) * -4; break;
      case 'tracking':  alpha = Math.min(easeOut3(inP), easeOut3(outP)); ctx.letterSpacing = ((1 - easeOut3(Math.min(local/0.6,1))) * 4) + 'px'; break;
      case 'reveal':    alpha = Math.min(easeOut3(inP), easeOut3(outP));
                        const p = easeOut3(clamp01(local / 0.6));
                        ctx.save();
                        ctx.beginPath(); ctx.rect(0, 0, W * p, H); ctx.clip();
                        break;
      case 'bounce':    alpha = Math.min(easeOut3(inP), easeOut3(outP)); dy = -Math.abs(Math.sin(local * 6)) * 3 * outP; break;
      default:          alpha = Math.min(easeOut3(inP), easeOut3(outP));
    }
    const sizePx = it.size * (canvas._dpr || 1);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = it.color;
    ctx.textAlign = it.align || 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${it.weight || 700} ${sizePx}px "${it.font}", sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 4;
    ctx.fillText(txt, (it.x/100) * W + dx, (it.y/100) * H + dy);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    if (it.anim === 'reveal') ctx.restore();
    if (it.anim === 'tracking') ctx.letterSpacing = '0px';
  }
}

function setupTplPreview(thumbEl, name) {
  const spec = TPL_PREVIEWS[name];
  if (!spec) return;
  const cv = document.createElement('canvas');
  cv.className = 'tpl-prev-canvas';
  thumbEl.appendChild(cv);
  // Hide static text label — canvas takes over
  thumbEl.querySelector('.tpl-thumb-text')?.classList.add('hidden');

  const sizeCanvas = () => {
    const r = thumbEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width  = Math.max(2, Math.round(r.width * dpr));
    cv.height = Math.max(2, Math.round(r.height * dpr));
    cv._dpr = dpr;
  };
  sizeCanvas();

  // Static "best frame" preview (peak animation)
  const peak = spec.duration * 0.55;
  drawTplPreview(cv, spec, peak);

  // Animated loop on hover
  let raf = null, t0 = 0, hovering = false;
  const tick = (now) => {
    if (!hovering) return;
    if (!t0) t0 = now;
    const t = ((now - t0) / 1000) % spec.duration;
    drawTplPreview(cv, spec, t);
    raf = requestAnimationFrame(tick);
  };
  thumbEl.parentElement.addEventListener('mouseenter', () => {
    hovering = true; t0 = 0;
    sizeCanvas();
    raf = requestAnimationFrame(tick);
  });
  thumbEl.parentElement.addEventListener('mouseleave', () => {
    hovering = false;
    if (raf) cancelAnimationFrame(raf);
    drawTplPreview(cv, spec, peak);     // back to "best frame"
  });
  // Resize on window resize
  window.addEventListener('resize', () => {
    sizeCanvas();
    drawTplPreview(cv, spec, hovering ? 0 : peak);
  });
}

// ============================================================
//  Export
// ============================================================
function buildExportPayload(aspectOverride) {
  const payload = {
    project: state.project || 'default',
    video: state.video?.filename,
    audio: state.audio?.filename || null,
    aspect: aspectOverride || state.aspect,
    template: state.template,
    colorGrade: state.fx.grade,
    vignette: state.fx.vignette,
    filmGrain: state.fx.grain,
    letterbox: !!state.letterbox,
    inMark:  state.inMark,
    outMark: state.outMark,
    musicVolume: (state.music.volume || 60) / 100,
    musicFadeIn: state.music.fadeIn,
    musicFadeOut: state.music.fadeOut,
    musicMode: state.music.mode,
    layers: state.layers.map(l => ({ ...l, img: undefined, canvasW, canvasH })),
  };
  // Multi-clip mode: state.segments is the source of truth (Magic Edit, manual
  // drags from the library, multi-file drops all populate it). Fall back to
  // state.editPlan?.segments only if state.segments is empty for some reason —
  // belt-and-braces for very old projects loaded before the segments rework.
  const runtimeSegs = (state.segments && state.segments.length)
    ? state.segments.map(s => ({
        clipFilename: s.filename,
        sourceIn:     Number(s.sourceIn)  || 0,
        sourceOut:    Number(s.sourceOut) || 0,
        transition:   s.transition || { type: 'cut', duration: 0 },
      }))
    : null;
  const fallbackSegs = state.editPlan?.segments;
  const segs = runtimeSegs || (Array.isArray(fallbackSegs) && fallbackSegs.length ? fallbackSegs : null);
  if (segs && segs.length > 0) {
    // Skip empty/invalid filenames so a half-loaded library doesn't poison
    // the export. If literally everything got filtered, drop segments and
    // let the backend fall through to legacy single-clip mode.
    const filtered = segs.filter(s => s.clipFilename);
    if (filtered.length) {
      payload.segments = filtered;
      if (!payload.audio && state.editPlan?.audio?.musicFilename) {
        payload.audio = state.editPlan.audio.musicFilename;
      }
    }
  }
  return payload;
}
async function startExport(aspect) {
  const hasSegments = (state.segments?.length > 0) || (state.editPlan?.segments?.length > 0);
  if (!state.video && !hasSegments) { toast('Upload a video first'); return; }
  const payload = buildExportPayload(aspect);
  try {
    const r = await fetch('/api/export', {
      method: 'POST', headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) { toast(`Error: ${data.error}`); return; }
    pollExport(data.jobId);
  } catch (e) { toast(`Export failed: ${e.message}`); }
}
function pollExport(jobId) {
  $('export-progress').classList.remove('hidden');
  $('export-done').classList.add('hidden');
  $('export-bar').style.width = '0%';
  $('export-status').textContent = 'Queued…';
  const es = new EventSource(`/api/export/stream/${jobId}`);
  es.onmessage = (ev) => {
    try {
      const job = JSON.parse(ev.data);
      const pct = job.progress || 0;
      $('export-bar').style.width = `${pct}%`;
      $('export-status').textContent = job.status === 'error'
          ? `Error: ${(job.error||'').slice(0,160)}`
          : `${job.status} — ${pct}%`;
      if (job.status === 'done') {
        es.close();
        $('export-done').classList.remove('hidden');
        $('export-link').innerHTML = `<i data-lucide="check-circle-2"></i><span>Download ${job.output}</span>`;
        $('export-link').href = job.url;
        refreshIcons();
        toast('Export complete', { gold:true });
        // 🎉 Cinematic export celebration
        window.MC?.motion?.exportComplete?.(stageInner);
      } else if (job.status === 'error') es.close();
    } catch {}
  };
  es.onerror = () => es.close();
}

// ============================================================
//  Project save/load
// ============================================================
/**
 * Legacy export — DOWNLOADS a JSON blob to disk. Format is the pre-v1
 * ad-hoc shape (version: 2). Kept around for offline export / manual
 * project sharing. For SERVER persistence use MC.project.save() instead,
 * which writes the schema-validated v1 document into the project folder.
 */
function exportProjectBlob() {
  const data = {
    version: 2,
    video: state.video, audio: state.audio,
    aspect: state.aspect, template: state.template,
    fx: state.fx, music: state.music, letterbox: state.letterbox,
    layers: state.layers.map(l => ({...l, img: undefined})),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'motioncut_project.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Project file downloaded');
}

/** Persist the project to the server via the v1 document API. */
async function saveProjectToServer() {
  try {
    await window.MC.project.save(state);
    toast('Project saved', { gold: true });
  } catch (e) {
    toast('Save failed: ' + e.message);
    console.error('[editor] save failed', e);
  }
}

/**
 * Restore the editor's runtime state from a v1 project document.
 * Used on page reload to resume where the user left off.
 *
 * Note on round-trip: deserialize gives us editor-shape fields. We merge
 * them into the live state object so existing references (in canvas
 * draw, inspector, timeline) stay valid.
 */
function restoreFromDocument(doc) {
  if (!doc || !window.MC?.project?.deserialize) return;
  const restored = window.MC.project.deserialize(doc, state.project);
  // Merge top-level fields. We don't replace the state object reference
  // (lots of closures hold it) — we mutate it in place.
  Object.assign(state, {
    _projectId:  restored._projectId,
    _created_at: restored._created_at,
    template:    restored.template,
    aspect:      restored.aspect,
    inMark:      restored.inMark,
    outMark:     restored.outMark,
    fx:          restored.fx,
    letterbox:   restored.letterbox,
    music:       restored.music,
    beats:       restored.beats || [],
    brand:       Object.assign({}, state.brand, restored.brand || {}),
    layers:      restored.layers || [],
    segments:    restored.segments || [],
  });
  if (state.segments.length) reflowSegments(state.segments);
  // Video: only swap if the doc references one. Don't clobber an active
  // upload that hasn't yet been saved. Multi-clip projects: activate the
  // first segment so the canvas paints something on load — the segment-swap
  // loop will keep state.video in sync as the playhead moves.
  if (state.segments.length) {
    activateSegment(state.segments[0], state.segments[0].sourceIn);
    if (stageEmpty) stageEmpty.classList.add('hidden');
  } else if (restored.video?.filename) {
    const url = '/projects/' + encodeURIComponent(state.project)
              + '/files/'    + encodeURIComponent(restored.video.filename);
    state.video = Object.assign({}, restored.video, { url });
    if (video) { video.src = url; video.load(); }
    if (stageEmpty) stageEmpty.classList.add('hidden');
  }
  if (restored.audio?.filename) {
    const url = '/projects/' + encodeURIComponent(state.project)
              + '/files/'    + encodeURIComponent(restored.audio.filename);
    state.audio = Object.assign({}, restored.audio, { url });
  }

  setAspect(state.aspect);
  syncStyleControls();
  renderLayersPanel(); renderInspector();
  try { window.MC?.timeline?.render?.(); } catch {}
  draw();
  toast('Project restored', { gold: true });
}
function loadProjectFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      state.video = data.video || null;
      state.audio = data.audio || null;
      state.fx = data.fx || state.fx;
      state.music = data.music || state.music;
      state.template = data.template || 'custom';
      state.letterbox = !!data.letterbox;
      state.layers = (data.layers || []).map(l => {
        if (l.type === 'logo' && l.url) {
          const img = new Image(); img.crossOrigin = 'anonymous'; img.src = l.url; l.img = img;
        }
        return l;
      });
      if (state.video?.url) { video.src = state.video.url; stageEmpty?.classList.add('hidden'); }
      setAspect(data.aspect || '16:9');
      syncStyleControls(); renderLayersPanel(); renderInspector(); snapshot(); draw();
      toast('Project loaded');
    } catch (e) { toast(`Load failed: ${e.message}`); }
  };
  reader.readAsText(file);
}

// ============================================================
//  Command palette
// ============================================================
const CMDS = [
  { id:'export-169', label:'Export 16:9 (1920×1080)', cat:'Export', icon:'monitor', run:()=>startExport('16:9') },
  { id:'export-916', label:'Export 9:16 (1080×1920)', cat:'Export', icon:'smartphone', run:()=>startExport('9:16') },
  { id:'aspect-169', label:'Aspect: 16:9', cat:'Aspect', icon:'rectangle-horizontal', run:()=>setAspect('16:9') },
  { id:'aspect-916', label:'Aspect: 9:16', cat:'Aspect', icon:'rectangle-vertical', run:()=>setAspect('9:16') },
  { id:'aspect-11',  label:'Aspect: 1:1',  cat:'Aspect', icon:'square', run:()=>setAspect('1:1') },
  { id:'add-text',   label:'Add text layer', cat:'Add', icon:'type', run:()=>addTextQuick() },
  { id:'add-overlay',label:'Add color overlay', cat:'Add', icon:'square', run:()=>addColorQuick() },
  { id:'tpl-cin',    label:'Template: Cinematic', cat:'Template', icon:'film', run:()=>applyTemplate('cinematic') },
  { id:'tpl-real',   label:'Template: Real Estate', cat:'Template', icon:'home', run:()=>applyTemplate('real_estate') },
  { id:'tpl-trav',   label:'Template: Travel', cat:'Template', icon:'plane', run:()=>applyTemplate('travel') },
  { id:'tpl-soc',    label:'Template: Social 9:16', cat:'Template', icon:'instagram', run:()=>applyTemplate('social') },
  { id:'tpl-corp',   label:'Template: Corporate', cat:'Template', icon:'briefcase', run:()=>applyTemplate('corporate') },
  { id:'grade-nat',  label:'Grade: Natural',     cat:'Grade', icon:'palette', run:()=>setGrade('natural') },
  { id:'grade-cin',  label:'Grade: Cinematic',   cat:'Grade', icon:'palette', run:()=>setGrade('cinematic') },
  { id:'grade-teal', label:'Grade: Teal & Orange',cat:'Grade', icon:'palette', run:()=>setGrade('teal_orange') },
  { id:'grade-mood', label:'Grade: Moody Dark',  cat:'Grade', icon:'palette', run:()=>setGrade('moody_dark') },
  { id:'grade-airy', label:'Grade: Bright Airy', cat:'Grade', icon:'palette', run:()=>setGrade('bright_airy') },
  { id:'grade-bw',   label:'Grade: B&W',         cat:'Grade', icon:'palette', run:()=>setGrade('bw') },
  { id:'fx-vig',     label:'Toggle vignette',    cat:'FX',    icon:'circle', run:()=>{ state.fx.vignette = !state.fx.vignette; syncStyleControls(); draw(); } },
  { id:'fx-grain',   label:'Toggle film grain',  cat:'FX',    icon:'sparkle', run:()=>{ state.fx.grain = !state.fx.grain; syncStyleControls(); draw(); } },
  { id:'undo',       label:'Undo',               cat:'Edit',  icon:'undo-2', run:undo },
  { id:'redo',       label:'Redo',               cat:'Edit',  icon:'redo-2', run:redo },
  { id:'save',         label:'Save project',         cat:'File', icon:'save',     run:saveProjectToServer },
  { id:'export-blob',  label:'Download project as file', cat:'File', icon:'download', run:exportProjectBlob },
  { id:'play',       label:'Play / Pause',       cat:'Playback',icon:'play', run:togglePlay },
  { id:'mark-in',    label:'Set in mark (I)',    cat:'Trim', icon:'log-in',   run:setInMark },
  { id:'mark-out',   label:'Set out mark (O)',   cat:'Trim', icon:'log-out',  run:setOutMark },
  { id:'mark-clear', label:'Clear in/out marks', cat:'Trim', icon:'rotate-ccw', run:clearMarks },
  { id:'select-all', label:'Select all layers (⌘A)', cat:'Edit', icon:'box-select', run:selectAll },
  { id:'duplicate',  label:'Duplicate selected (⌘D)', cat:'Edit', icon:'copy', run:duplicateSelected },
  { id:'snap-beat',  label:'Toggle snap to beats', cat:'Audio', icon:'audio-waveform', run:()=>{ state.snapToBeat = !state.snapToBeat; toast('Snap to beat: '+(state.snapToBeat?'on':'off'), { gold:state.snapToBeat }); }},
  { id:'detect-beats', label:'Detect beats from music', cat:'Audio', icon:'activity', run:()=>{ if (!state.audio) toast('Drop music first'); else detectBeats(state.audio.url); }},
  { id:'theme',      label:'Toggle light / dark theme', cat:'View',  icon:'sun', run:toggleTheme },
  { id:'magic',      label:'Magic Edit (AI cinematic edit)', cat:'AI', icon:'sparkles', run:()=>$('btn-magic')?.click() },
];

// ============================================================
//  Projects (folders) & media library
// ============================================================
async function fetchProjects() {
  try {
    const r = await fetch('/api/projects');
    const d = await r.json();
    state.projects = d.projects || [];
    return state.projects;
  } catch { return []; }
}

async function createProject(name) {
  const r = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return r.json();
}

async function deleteProject(id) {
  const r = await fetch('/api/projects/' + encodeURIComponent(id), { method: 'DELETE' });
  return r.json();
}

async function fetchProjectFiles(id) {
  try {
    const r = await fetch('/api/projects/' + encodeURIComponent(id) + '/files');
    const d = await r.json();
    return d.files || [];
  } catch { return []; }
}

function setProject(id) {
  state.project = id || 'default';
  try { localStorage.setItem('mc-project', state.project); } catch {}
  const proj = state.projects.find(p => p.id === state.project);
  $('project-name').textContent = proj?.name || 'Default';
  refreshLibrary();
  loadBrandKit();
}

async function refreshProjectMenu() {
  await fetchProjects();
  const list = $('project-list');
  if (!list) return;
  list.innerHTML = state.projects.map(p => `
    <div class="project-item ${p.id === state.project ? 'active' : ''}" data-id="${p.id}">
      <i data-lucide="${p.id === state.project ? 'folder-open' : 'folder'}"></i>
      <div class="project-item-info">
        <div class="project-item-name">${escapeHTML(p.name)}</div>
        <div class="project-item-meta">${p.file_count} file${p.file_count===1?'':'s'}</div>
      </div>
      ${p.id === 'default' ? '' : `<button class="project-del" data-del="${p.id}" title="Delete"><i data-lucide="trash-2"></i></button>`}
    </div>
  `).join('') || `<div class="muted small" style="padding:10px;text-align:center">No projects</div>`;
  refreshIcons();
  list.querySelectorAll('.project-item').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.project-del')) return;
      const id = row.dataset.id;
      setProject(id);
      const proj = state.projects.find(p => p.id === id);
      toast(window.MC?.i18n?.t('toast.project_switched', { n: proj?.name || id }) || ('Switched: ' + id), { gold: true });
      $('project-menu').classList.add('hidden');
      refreshProjectMenu();
    });
  });
  list.querySelectorAll('.project-del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.del;
      const t = window.MC?.i18n?.t || ((k)=>k);
      if (!confirm(t('project.confirm_delete'))) return;
      await deleteProject(id);
      if (state.project === id) setProject('default');
      toast(t('toast.project_deleted'));
      refreshProjectMenu();
    });
  });
}

async function refreshLibrary() {
  const lib = $('library');
  if (!lib) return;
  const t = window.MC?.i18n?.t || ((k)=>k);
  const files = await fetchProjectFiles(state.project);
  if (!files.length) {
    lib.innerHTML = `<div class="library-empty muted small">${escapeHTML(t('library.empty'))}</div>`;
    return;
  }
  lib.innerHTML = files.map(f => {
    const icon = f.kind === 'video' ? 'film' : f.kind === 'image' ? 'image' : 'music';
    const display = f.name.replace(/^[a-f0-9]{6,16}_/, '');
    // Videos and images can be dragged onto the timeline's video track to
    // append a segment. Audio stays click-only — there's no audio-track drop yet.
    const draggable = (f.kind === 'video' || f.kind === 'image') ? 'draggable="true"' : '';
    return `
      <div class="lib-item" ${draggable} data-name="${escapeHTML(f.name)}" data-url="${escapeHTML(f.url)}" data-kind="${f.kind}" data-duration="${f.duration || 0}" title="${escapeHTML(display)}">
        <i data-lucide="${icon}"></i>
        <span class="lib-name">${escapeHTML(display)}</span>
        <span class="lib-kind">${escapeHTML(t('library.' + f.kind))}</span>
        <button class="lib-del" data-del="${escapeHTML(f.name)}" title="${escapeHTML(t('library.delete'))}"><i data-lucide="x"></i></button>
      </div>`;
  }).join('');
  refreshIcons();
  lib.querySelectorAll('.lib-item[draggable="true"]').forEach(it => {
    it.addEventListener('dragstart', (e) => {
      const payload = {
        filename: it.dataset.name,
        url:      it.dataset.url,
        kind:     it.dataset.kind,
        duration: parseFloat(it.dataset.duration) || 0,
      };
      const json = JSON.stringify(payload);
      // Set both a custom MIME and text/plain — some browsers (and DnD test
      // harnesses) only forward standard types, and we'd rather degrade
      // than refuse the drop.
      try { e.dataTransfer.setData('application/x-motioncut-lib', json); } catch {}
      try { e.dataTransfer.setData('text/plain', json); } catch {}
      e.dataTransfer.effectAllowed = 'copy';
    });
  });
  lib.querySelectorAll('.lib-item').forEach(it => {
    it.addEventListener('click', (e) => {
      if (e.target.closest('.lib-del')) return;     // X click handled separately
      const meta = {
        filename: it.dataset.name,
        url: it.dataset.url,
        kind: it.dataset.kind,
        duration: 0,
      };
      if (meta.kind === 'video') applyVideo(meta);
      // Library clicks reuse files already on disk — route images through
      // the same full-canvas factory as window drops, not the logo path.
      else if (meta.kind === 'image') applyImageFromLibrary(meta);
      else if (meta.kind === 'audio') applyMusic(meta);
    });
  });
  lib.querySelectorAll('.lib-del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = btn.dataset.del;
      const tt = window.MC?.i18n?.t || ((k)=>k);
      if (!confirm(tt('library.confirm_delete'))) return;
      try {
        const r = await fetch('/api/projects/' + encodeURIComponent(state.project) + '/files/' + encodeURIComponent(name), { method: 'DELETE' });
        if (!r.ok) {
          const d = await r.json().catch(()=>({}));
          toast('Error: ' + (d.error || r.status));
          return;
        }
        // If the deleted file was currently in use, reset the editor reference
        if (state.video?.filename === name) {
          state.video = null;
          if (video) { video.removeAttribute('src'); video.load(); }
          stageEmpty?.classList.remove('hidden');
          $('dropzone-video').classList.remove('has-file');
          $('dropzone-video').querySelector('.dz-title').textContent = tt('dz.video.title');
        }
        if (state.audio?.filename === name) {
          state.audio = null;
          $('dropzone-audio').classList.remove('has-file');
          $('dropzone-audio').querySelector('.dz-title').textContent = tt('dz.audio.title');
          const mi = $('music-info');
          mi.classList.remove('has-file');
          mi.querySelector('span').textContent = tt('style.music.none');
          mi.querySelector('span').classList.add('muted');
        }
        // If a logo OR image layer used this file, drop it
        const before = state.layers.length;
        state.layers = state.layers.filter(l => !((l.type === 'logo' || l.type === 'image') && l.src === name));
        if (state.layers.length !== before) { renderLayersPanel(); draw(); }
        // Drop any segments that referenced the now-deleted file. reflow + reactivate.
        const segsBefore = state.segments.length;
        state.segments = state.segments.filter(s => s.filename !== name);
        if (state.segments.length !== segsBefore) {
          reflowSegments(state.segments);
          if (state.segments[0]) activateSegment(state.segments[0], state.segments[0].sourceIn);
          else { state.video = null; if (video) { video.removeAttribute('src'); video.load(); } }
          try { window.MC?.timeline?.render?.(); } catch {}
          draw();
        }
        toast(tt('toast.file_deleted'));
        refreshLibrary();
      } catch (err) {
        toast('Error: ' + err.message);
      }
    });
  });
}

function bindProjectPicker() {
  const btn = $('btn-project');
  const menu = $('project-menu');
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const wasHidden = menu.classList.contains('hidden');
    menu.classList.toggle('hidden');
    if (wasHidden) await refreshProjectMenu();
  });
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== btn) menu.classList.add('hidden');
  });
  $('btn-new-project').addEventListener('click', async () => {
    const t = window.MC?.i18n?.t || ((k)=>k);
    const name = prompt(t('project.prompt'), '');
    if (!name) return;
    const proj = await createProject(name);
    await fetchProjects();
    setProject(proj.id);
    toast(t('toast.project_created', { n: proj.name }), { gold: true });
    await refreshProjectMenu();
    menu.classList.add('hidden');
  });
  $('btn-rename-project').addEventListener('click', async () => {
    const t = window.MC?.i18n?.t || ((k)=>k);
    const cur = state.projects.find(p => p.id === state.project);
    const name = prompt(t('project.save_prompt'), cur?.name === 'default' ? '' : (cur?.name || ''));
    if (!name) return;
    const r = await fetch('/api/projects/' + encodeURIComponent(state.project) + '/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const d = await r.json();
    if (!r.ok) { toast(`Error: ${d.error || r.status}`); return; }
    await fetchProjects();
    setProject(d.id);
    toast(t('toast.project_created', { n: d.name }), { gold: true });
    await refreshProjectMenu();
    menu.classList.add('hidden');
  });
  $('btn-library-refresh')?.addEventListener('click', refreshLibrary);
}

// ============================================================
//  Theme toggle
// ============================================================
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const btn = $('btn-theme');
  if (btn) {
    const ic = btn.querySelector('[data-lucide]');
    if (ic) ic.setAttribute('data-lucide', t === 'light' ? 'moon' : 'sun');
    refreshIcons();
  }
  try { localStorage.setItem('mc-theme', t); } catch {}
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}
function setGrade(g) { state.fx.grade = g; syncStyleControls(); applyCanvasFilter(); draw(); snapshot(); }
function addTextQuick() {
  const l = makeTextLayer({ end: video.duration||8 });
  state.layers.push(l); state.selectedId = l.id;
  renderLayersPanel(); renderInspector(); positionFloatingToolbar(); snapshot(); draw();
}
function addColorQuick() {
  const l = makeColorLayer();
  state.layers.push(l); state.selectedId = l.id;
  renderLayersPanel(); renderInspector(); positionFloatingToolbar(); snapshot(); draw();
}

let cmdkIdx = 0, cmdkShown = [];
function openCmdk() {
  $('cmdk-backdrop').classList.add('show');
  $('cmdk-input').value = '';
  $('cmdk-input').focus();
  renderCmdk('');
}
function closeCmdk() { $('cmdk-backdrop').classList.remove('show'); }
function renderCmdk(query) {
  const q = query.trim().toLowerCase();
  cmdkShown = q ? CMDS.filter(c => (c.label + ' ' + c.cat).toLowerCase().includes(q)) : CMDS;
  cmdkIdx = 0;
  const html = cmdkShown.length ? cmdkShown.map((c, i) => `
    <div class="cmdk-row ${i===0?'on':''}" data-i="${i}">
      <i data-lucide="${c.icon}"></i>
      <span class="cmdk-label">${c.label}</span>
      <span class="cmdk-cat">${c.cat}</span>
    </div>`).join('') : `<div class="cmdk-empty">No commands match "${escapeHTML(query)}"</div>`;
  $('cmdk-results').innerHTML = html;
  refreshIcons();
  $('cmdk-results').querySelectorAll('.cmdk-row').forEach(row => {
    row.addEventListener('click', () => { runCmdkAt(parseInt(row.dataset.i,10)); });
  });
}
function runCmdkAt(i) {
  const c = cmdkShown[i]; if (!c) return;
  closeCmdk(); setTimeout(() => c.run(), 50);
}
function bindCmdk() {
  $('cmdk-trigger').addEventListener('click', openCmdk);
  $('cmdk-backdrop').addEventListener('click', (e) => { if (e.target.id === 'cmdk-backdrop') closeCmdk(); });
  $('cmdk-input').addEventListener('input', (e) => renderCmdk(e.target.value));
  $('cmdk-input').addEventListener('keydown', (e) => {
    const rows = $('cmdk-results').querySelectorAll('.cmdk-row');
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdkIdx = Math.min(rows.length-1, cmdkIdx+1); updateCmdkSel(rows); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); cmdkIdx = Math.max(0, cmdkIdx-1); updateCmdkSel(rows); }
    else if (e.key === 'Enter')     { e.preventDefault(); runCmdkAt(cmdkIdx); }
  });
  // Global Escape — works even if focus left the input
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('cmdk-backdrop').classList.contains('show')) {
      e.preventDefault();
      closeCmdk();
    }
  }, true);
}
function updateCmdkSel(rows) {
  rows.forEach((r,i) => r.classList.toggle('on', i===cmdkIdx));
  rows[cmdkIdx]?.scrollIntoView({ block: 'nearest' });
}

// ============================================================
//  Context menu
// ============================================================
function showContextMenu(x, y, items) {
  const menu = $('ctx-menu');
  menu.innerHTML = items.map(it => it.divider
    ? `<div class="ctx-menu-divider"></div>`
    : `<div class="ctx-menu-item ${it.danger?'danger':''}" data-act="${it.id}">
         <i data-lucide="${it.icon||'circle'}"></i>
         <span>${it.label}</span>
         ${it.shortcut?`<span class="ctx-menu-shortcut">${it.shortcut}</span>`:''}
       </div>`).join('');
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  menu.classList.add('show');
  refreshIcons();
  menu.querySelectorAll('.ctx-menu-item').forEach(el => {
    el.addEventListener('click', () => {
      const act = el.dataset.act;
      const found = items.find(i => i.id === act);
      hideContextMenu();
      if (found) found.run();
    });
  });
  setTimeout(() => {
    document.addEventListener('mousedown', hideContextMenu, { once:true });
  }, 50);
}
function hideContextMenu() { $('ctx-menu').classList.remove('show'); }

function contextItemsForLayer(id) {
  return [
    { id:'rename',  label:'Rename',          icon:'pencil', run: () => {
        const row = layersPanelEl.querySelector(`.layer-row[data-id="${id}"]`);
        const nm = row?.querySelector('.layer-name'); if (nm) beginRename(id, nm);
      }},
    { id:'duplicate', label:'Duplicate',     icon:'copy', shortcut:'⌘D', run: () => duplicateLayer(id) },
    { divider:true },
    { id:'front',   label:'Bring to front',  icon:'chevrons-up',   run: () => bringToFront(id) },
    { id:'back',    label:'Send to back',    icon:'chevrons-down', run: () => sendToBack(id) },
    { divider:true },
    { id:'hide',    label:'Toggle visibility', icon:'eye-off',  run: () => toggleVisibility(id) },
    { id:'lock',    label:'Toggle lock',     icon:'lock',     run: () => toggleLock(id) },
    { divider:true },
    { id:'delete',  label:'Delete',          icon:'trash-2', shortcut:'Del', danger:true, run: () => deleteLayer(id) },
  ];
}

// ============================================================
//  Playback / scrubber
// ============================================================
function togglePlay() {
  if (!video.src) { toast('Drop a video first'); return; }
  if (video.paused) video.play(); else video.pause();
}
function selectAll() {
  state.selectedIds = new Set(state.layers.map(l => l.id));
  state.selectedId = state.layers.length ? state.layers[state.layers.length-1].id : null;
  renderLayersPanel(); renderInspector(); positionFloatingToolbar(); draw();
}
function setInMark() {
  if (!state.video) return;
  state.inMark = video.currentTime;
  toast(`In mark: ${fmtTime(state.inMark)}`, { gold:true });
  try { window.MC?.timeline?.render?.(); } catch {}
  snapshot();
}
function setOutMark() {
  if (!state.video) return;
  state.outMark = video.currentTime;
  toast(`Out mark: ${fmtTime(state.outMark)}`, { gold:true });
  try { window.MC?.timeline?.render?.(); } catch {}
  snapshot();
}
function clearMarks() {
  state.inMark = state.outMark = null;
  toast('Marks cleared');
  try { window.MC?.timeline?.render?.(); } catch {}
  snapshot();
}

function deleteSelected() {
  const ids = state.selectedIds.size ? [...state.selectedIds] : (state.selectedId ? [state.selectedId] : []);
  if (!ids.length) return;
  state.layers = state.layers.filter(l => !ids.includes(l.id));
  state.selectedId = null;
  state.selectedIds.clear();
  renderLayersPanel(); renderInspector(); positionFloatingToolbar(); draw(); snapshot();
}
function duplicateSelected() {
  const ids = state.selectedIds.size ? [...state.selectedIds] : (state.selectedId ? [state.selectedId] : []);
  ids.forEach(id => duplicateLayer(id));
}

// ============================================================
//  Keyboard
// ============================================================
function onKey(e) {
  const t = e.target;
  const isField = t && (t.tagName==='INPUT' || t.tagName==='TEXTAREA' || t.tagName==='SELECT');

  // Cmd+K palette
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdk(); return; }

  if (isField) return;

  if (e.code === 'Space')      { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft')   { video.currentTime = Math.max(0, video.currentTime - 1/30); }
  else if (e.key === 'ArrowRight')  { video.currentTime = Math.min(video.duration||0, video.currentTime + 1/30); }
  else if (e.key === '-' || e.key === '_') { video.currentTime = Math.max(0, video.currentTime - 1/30); }
  else if (e.key === '+' || e.key === '=') { video.currentTime = Math.min(video.duration||0, video.currentTime + 1/30); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); }
  else if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); }
  else if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); }
  else if (e.key === 'i' || e.key === 'I') { setInMark(); }
  else if (e.key === 'o' || e.key === 'O') { setOutMark(); }
  else if (e.key.toLowerCase() === 't') { addTextQuick(); }
  else if (e.key.toLowerCase() === 'l') { $('file-image').click(); }
  else if (e.key.toLowerCase() === 'o') { addColorQuick(); }
}

// ============================================================
//  Init
// ============================================================
function init() {
  // Bind DOM refs
  video        = $('video');
  canvas       = $('canvas');
  ctx          = canvas.getContext('2d');
  stageWrap    = $('stage-wrap');
  stageInner   = $('stage-inner');
  stageEmpty   = $('stage-empty');
  scrubber     = $('scrubber');           // may be null (legacy)
  layersPanelEl   = $('layers-panel');
  inspectorBodyEl = $('layer-props');
  snapSvg      = $('snap-svg');
  dragTooltip  = $('drag-tooltip');
  canvasFloatingEl = $('canvas-floating');
  toastEl      = $('toast');

  // Expose editor API for sibling modules (timeline.js)
  window.MC = window.MC || {};
  window.MC.editor = {
    state, video, draw,
    renderInspector, renderLayersPanel,
    snapshot,
    addText: addTextQuick,
    addColor: addColorQuick,
    deleteLayer, duplicateLayer,
    bringToFront, sendToBack,
    toggleVisibility, toggleLock,
    setInMark, setOutMark, clearMarks,
    selectAll, deleteSelected, duplicateSelected,
    detectBeats,
    // Segments / multi-clip surface — exposed so timeline.js (and any future
    // consumer) can mutate the timeline without depending on internal globals.
    appendSegment, removeSegment, segmentAt, activateSegment, reflowSegments,
  };

  // Health check
  fetch('/api/health').then(r=>r.json()).then(j => {
    const el = $('ffmpeg-status');
    el.querySelector('.lbl').textContent = j.ffmpeg ? 'FFmpeg ready' : 'FFmpeg missing';
    el.classList.toggle('bad', !j.ffmpeg);
  }).catch(()=>{});

  setAspect('16:9');
  syncStyleControls();

  // Drop overlay (full window)
  bindDropOverlay();

  // Per-zone clicks/drops (for click-to-browse)
  bindDropzone('dropzone-video', 'file-video', 'video');
  // dropzone-image (the right-rail "Add image" zone) and btn-add-logo (image-
  // plus icon, title "Add image") both add full-canvas image layers — NOT
  // logos. The only path that produces a small corner logo is the brand-kit
  // logo picker (brand-logo-pick), which lives in the Brand panel and isn't
  // touched here. Matches user spec: "Logo is ONLY added via the explicit
  // Logo button click — NOT by drag-drop".
  bindDropzone('dropzone-image', 'file-image', 'image');
  bindDropzone('dropzone-audio', 'file-audio', 'audio');
  $('stage-empty-pick')?.addEventListener('click', () => $('file-video').click());

  // Add layer buttons
  $('btn-add-text').addEventListener('click', addTextQuick);
  $('btn-add-logo').addEventListener('click', () => $('file-image').click());
  $('btn-add-color').addEventListener('click', addColorQuick);

  // Style: grade chips
  document.querySelectorAll('.grade-chip').forEach(c => {
    c.addEventListener('click', () => setGrade(c.dataset.grade));
  });
  $('fx-vignette').addEventListener('change', e => { state.fx.vignette = e.target.checked; draw(); snapshot(); });
  $('fx-grain').addEventListener('change',    e => { state.fx.grain    = e.target.checked; draw(); snapshot(); });

  // Music
  $('music-volume').addEventListener('input', e => { state.music.volume = parseInt(e.target.value,10); $('music-vol-label').textContent = state.music.volume + '%'; });
  $('music-fadein').addEventListener('change', e => state.music.fadeIn = e.target.checked);
  $('music-fadeout').addEventListener('change', e => state.music.fadeOut = e.target.checked);
  $('music-mode').addEventListener('change', e => state.music.mode = e.target.value);

  // Aspect
  document.querySelectorAll('.aspect-segmented .aspect').forEach(b =>
    b.addEventListener('click', () => setAspect(b.dataset.aspect)));

  // Templates — animated mini-previews + click handler
  document.querySelectorAll('.tpl').forEach(b => {
    b.addEventListener('click', () => applyTemplate(b.dataset.template));
    const thumb = b.querySelector('.tpl-thumb');
    if (thumb) setupTplPreview(thumb, b.dataset.template);
  });

  // Theme toggle
  applyTheme(localStorage.getItem('mc-theme') || 'dark');
  $('btn-theme')?.addEventListener('click', toggleTheme);

  // Projects: load list, set current from localStorage, populate library
  state.project = localStorage.getItem('mc-project') || 'default';
  bindProjectPicker();
  fetchProjects().then(async () => {
    const proj = state.projects.find(p => p.id === state.project);
    if (!proj) state.project = 'default';
    const display = state.projects.find(p => p.id === state.project);
    $('project-name').textContent = display?.name || 'Default';
    refreshLibrary();
    loadBrandKit();
    // Auto-restore the persisted project document if it exists. Lets the
    // user reload the tab and resume exactly where they left off.
    try {
      const doc = await window.MC?.project?.load?.(state.project);
      if (doc) restoreFromDocument(doc);
    } catch (e) { console.warn('[editor] project doc load failed', e); }
  });
  bindBrandKit();

  // Language toggle (cycles through registered languages)
  $('btn-lang')?.addEventListener('click', () => {
    const langs = window.MC?.i18n?.getLangs?.() || [{code:'en'}];
    const cur = window.MC?.i18n?.getLang?.() || 'en';
    const idx = langs.findIndex(l => l.code === cur);
    const next = langs[(idx + 1) % langs.length].code;
    window.MC?.i18n?.setLang?.(next);
  });
  // Refresh dynamic UI when language changes
  window.addEventListener('mc-lang-change', () => {
    renderInspector(); renderLayersPanel();
    // Refresh aspect-desc to current language
    const desc = $('aspect-desc');
    const key = ASPECT_DESC_KEY[state.aspect];
    if (desc && key && window.MC?.i18n?.t) desc.textContent = window.MC.i18n.t(key);
  });

  // Playback
  $('btn-play').addEventListener('click', togglePlay);
  video.addEventListener('play',  () => $('play-icon').setAttribute('data-lucide','pause') || refreshIcons());
  video.addEventListener('pause', () => $('play-icon').setAttribute('data-lucide','play')  || refreshIcons());
  if (scrubber) {
    scrubber.addEventListener('input', () => {
      if (video.duration > 0) video.currentTime = (scrubber.value/1000) * video.duration;
    });
  }

  // Mute toggle
  $('btn-mute').addEventListener('click', () => {
    video.muted = !video.muted;
    $('btn-mute').querySelector('[data-lucide]').setAttribute('data-lucide', video.muted ? 'volume-x' : 'volume-2');
    refreshIcons();
  });

  // Undo/redo/save/load
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-save-project').addEventListener('click', saveProjectToServer);
  $('load-project').addEventListener('change', e => { if (e.target.files[0]) loadProjectFile(e.target.files[0]); });

  // Export
  $('btn-export-169').addEventListener('click', () => startExport('16:9'));
  $('btn-export-916').addEventListener('click', () => startExport('9:16'));

  // Canvas drag
  canvas.addEventListener('mousedown', onCanvasMouseDown);
  canvas.addEventListener('mousemove', onCanvasMouseMove);
  window.addEventListener('mouseup',  onCanvasMouseUp);
  // Double-click any text layer to edit inline
  canvas.addEventListener('dblclick', (e) => {
    const { x, y } = canvasCoordsFromEvent(e);
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      if (l.type !== 'text' || !l.visible || l.locked) continue;
      if (pointInLayer(x, y, l)) { startInlineTextEdit(l.id); break; }
    }
  });

  // Canvas right-click
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const { x, y } = canvasCoordsFromEvent(e);
    let hit = null;
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      if (pointInLayer(x, y, l)) { hit = l; break; }
    }
    if (hit) {
      state.selectedId = hit.id;
      renderLayersPanel(); renderInspector(); draw();
      showContextMenu(e.clientX, e.clientY, contextItemsForLayer(hit.id));
    } else {
      showContextMenu(e.clientX, e.clientY, [
        { id:'add-text',  label:'Add text',          icon:'type',   shortcut:'T', run: addTextQuick },
        { id:'add-overlay', label:'Add color overlay', icon:'square', shortcut:'O', run: addColorQuick },
        { divider:true },
        { id:'paste-tpl', label:'Apply template…',   icon:'sparkles', run: openCmdk },
      ]);
    }
  });

  // Floating toolbar actions
  canvasFloatingEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    const id = state.selectedId; if (!id) return;
    const a = btn.dataset.action;
    if (a === 'duplicate')   duplicateLayer(id);
    if (a === 'bring-front') bringToFront(id);
    if (a === 'send-back')   sendToBack(id);
    if (a === 'lock')        toggleLock(id);
    if (a === 'hide')        toggleVisibility(id);
    if (a === 'delete')      deleteLayer(id);
  });

  // Cmd+K palette
  bindCmdk();

  // Magic Edit
  bindMagicEdit();

  // Keyboard
  window.addEventListener('keydown', onKey);

  // Snapshot baseline + start render loop
  snapshot();
  refreshIcons();

  // Init the multi-track timeline once editor API is published
  try {
    window.MC?.timeline?.init?.(window.MC.editor);
  } catch (e) { console.warn('[editor] timeline init failed', e); }

  loop();
}

document.addEventListener('DOMContentLoaded', init);
})();
