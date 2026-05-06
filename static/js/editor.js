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
  video: null,
  audio: null,
  aspect: '16:9',
  layers: [],
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
};

const history = { stack: [], idx: -1, max: 60 };

const interaction = {
  pointerDownAt: 0,
  pointerDownPos: null,
  pointerDragArmed: false,
};

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
let _layerCounter = { text: 0, logo: 0, color: 0 };
function nextName(type) {
  _layerCounter[type] = (_layerCounter[type] || 0) + 1;
  const labels = { text: 'Text', logo: 'Logo', color: 'Overlay' };
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
    fontFamily: 'Syne', fontSize: 96, fontWeight: 700,
    color: '#ffffff', align: 'center',
    start: 0, end: 8,
    animation: 'fade',
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
  const kind = kindHint || inferKind(file);
  if (!kind) { toast(`Unsupported file: ${file.name}`); return; }
  const wasVideo = !!state.video;
  const zoneMap = { video: 'dropzone-video', image: 'dropzone-image', audio: 'dropzone-audio' };
  const activeZone = $(zoneMap[kind]);
  activeZone?.classList.add('is-loading');
  try {
    toast(`Uploading ${file.name}…`, { ms: 60000, gold: true });
    const meta = await uploadFile(file, kind, pct => {
      toast(`Uploading ${file.name} — ${pct.toFixed(0)}%`, { ms: 60000, gold: true });
    });
    if (kind === 'video') {
      applyVideo(meta);
      toast(wasVideo ? `Now editing ${meta.filename.replace(/^[a-f0-9]+_/,'')}` : `Loaded ${file.name}`, { gold:true });
    } else if (kind === 'image') {
      applyLogo(meta);
      toast(`Logo added: ${file.name}`);
    } else if (kind === 'audio') {
      applyMusic(meta);
      toast(`Music: ${file.name}`);
    }
    // Refresh the project library so newly uploaded files appear in it
    refreshLibrary();
  } catch (e) {
    toast(`Error: ${e.message}`);
  } finally {
    activeZone?.classList.remove('is-loading');
  }
}

function applyVideo(meta) {
  state.video = meta;
  video.src = meta.url; video.load();
  video.onloadedmetadata = () => {
    state.layers.forEach(l => { if (l.end > 9000) l.end = video.duration; });
    if (stageEmpty) stageEmpty.classList.add('hidden');
    draw();
    try { window.MC?.timeline?.render?.(); } catch {}
  };
  $('dropzone-video').classList.add('has-file');
  $('dropzone-video').querySelector('.dz-title').textContent = meta.filename.slice(0,18);
}
function applyLogo(meta) {
  const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async'; img.src = meta.url;
  const layer = makeLogoLayer({ src: meta.filename, url: meta.url, img });
  img.onload = async () => {
    try { if (img.decode) await img.decode(); } catch {}
    const r = img.naturalWidth / Math.max(1, img.naturalHeight);
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

function onCanvasPointerDown(e) {
  if (e.button === 2) return;
  const { x, y } = canvasCoordsFromEvent(e);
  interaction.pointerDownAt = performance.now();
  interaction.pointerDownPos = { x, y };
  interaction.pointerDragArmed = false;
  let hit = null, mode = 'move', corner = null;
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const l = state.layers[i];
    if (!l.visible || l.locked) continue;
    if (state.selectedId === l.id) {
      const c = getResizeCorner(x, y, l);
      if (c) { hit = l; mode = 'resize'; corner = c; break; }
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
    drag = {
      id: hit.id, mode, corner,
      offX: x - hit.x, offY: y - hit.y,
      startX: hit.x, startY: hit.y,
      startW: hit.width || b.w, startH: hit.height || b.h,
      startFontSize: hit.fontSize || 64,
      origHalfDiag: Math.hypot(b.w, b.h) / 2,
      anchor: opposite,
      origMouse: { x, y },
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

function onCanvasPointerMove(e) {
  const { x, y } = canvasCoordsFromEvent(e);
  if (interaction.pointerDownPos && !interaction.pointerDragArmed) {
    const dx = x - interaction.pointerDownPos.x;
    const dy = y - interaction.pointerDownPos.y;
    if (Math.hypot(dx, dy) > 4) interaction.pointerDragArmed = true;
  }
  if (!drag) {
    const sel = state.layers.find(l => l.id === state.selectedId);
    if (sel) {
      const c = getResizeCorner(x, y, sel);
      if (c) { canvas.style.cursor = cursorForCorner(c); return; }
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

function onCanvasPointerUp() {
  if (drag) { drag = null; clearSnapGuides(); hideDragTooltip(); snapshot(); renderInspector(); }
  interaction.pointerDownPos = null;
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
  if (!l.visible) return;
  // While paused, ALWAYS show selected layers at full opacity so the user
  // can see what they're editing — even if the playhead is outside the
  // layer's time range.
  const selected = state.selectedIds.has(l.id) || state.selectedId === l.id;
  const peek = selected && video?.paused;
  if (!peek && (t < l.start || t > l.end)) return;
  // For animation math, clamp time into the layer's range during peek
  if (peek) t = Math.max(l.start, Math.min(l.end, l.start + (l.end - l.start) * 0.5));
  ctx.save();
  ctx.globalCompositeOperation = l.blendMode || 'source-over';
  let alpha = (l.opacity ?? 1), dx = 0, dy = 0;
  let drawText = l.text || '';
  const local = t - l.start, dur = l.end - l.start;
  const inP = clamp(local / 0.6, 0, 1);
  const outP = clamp((l.end - t) / 0.6, 0, 1);

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

  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.fillStyle = l.color;
  ctx.textAlign = l.align || 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${l.fontWeight || 700} ${l.fontSize}px "${l.fontFamily}", sans-serif`;
  ctx.shadowColor = ctx.shadowColor || 'rgba(0,0,0,0.55)';
  ctx.shadowBlur  = ctx.shadowBlur  || 8;

  if (l.animation === 'zoom') {
    const s = 1 + 0.04 * Math.sin(local * 3);
    ctx.translate(l.x + dx, l.y + dy); ctx.scale(s, s);
    ctx.fillText(drawText, 0, 0);
  } else {
    ctx.fillText(drawText, l.x + dx, l.y + dy);
  }
  ctx.restore();
}

function drawLogoLayer(l, t) {
  if (!l.visible) return;
  const selected = state.selectedIds.has(l.id) || state.selectedId === l.id;
  const peek = selected && video?.paused;
  if (!peek && (t < l.start || t > l.end)) return;
  if (!l.img || !l.img.complete) return;
  ctx.save();
  ctx.globalCompositeOperation = l.blendMode || 'source-over';
  ctx.globalAlpha = l.opacity ?? 1;
  ctx.drawImage(l.img, l.x, l.y, l.width, l.height);
  ctx.restore();
}

function drawColorLayer(l, t) {
  if (!l.visible) return;
  const selected = state.selectedIds.has(l.id) || state.selectedId === l.id;
  const peek = selected && video?.paused;
  if (!peek && (t < l.start || t > l.end)) return;
  ctx.save();
  ctx.globalCompositeOperation = l.blendMode || 'source-over';
  ctx.fillStyle = l.color; ctx.globalAlpha = l.opacity;
  ctx.fillRect(l.x, l.y, l.width, l.height);
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
    else if (l.type === 'logo') drawLogoLayer(l, t);
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
  return t === 'text' ? 'type' : t === 'logo' ? 'image' : 'square';
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
  const now = performance.now();
  if (!interaction.pointerDragArmed && now - interaction.pointerDownAt < 180) return;
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
  html += `<div class="inspector-section">
    <div class="inspector-section-label">Position & size</div>
    <div class="row-grid-2">
      <label class="row col"><span data-scrub="x">X</span><input type="number" data-prop="x" value="${Math.round(l.x)}"/></label>
      <label class="row col"><span data-scrub="y">Y</span><input type="number" data-prop="y" value="${Math.round(l.y)}"/></label>
    </div>`;

  if (l.type === 'text') {
    html += `
      <label class="row col"><span data-scrub="fontSize">Size</span><input type="number" data-prop="fontSize" value="${l.fontSize}"/></label>
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
  } else if (l.type === 'logo') {
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
    <label class="row col"><span class="no-scrub">Opacity <em>${opacityPct}%</em></span>
      <input type="range" min="0" max="100" value="${opacityPct}" data-prop="opacity100"/></label>
    <label class="row col no-scrub"><span class="no-scrub">Blend</span>
      <select data-prop="blendMode">
        ${['source-over','multiply','screen','overlay','soft-light','hard-light','color-dodge','color-burn','difference','lighten','darken'].map(b=>`<option ${b===l.blendMode?'selected':''}>${b}</option>`).join('')}
      </select></label>`;

  if (l.type === 'text') {
    html += `<label class="row col no-scrub"><span class="no-scrub">Animation</span>
      <select data-prop="animation">
        ${['none','fade','tracking','reveal','typewriter','zoom','glow','bounce','cinematic'].map(a=>`<option ${a===l.animation?'selected':''}>${a}</option>`).join('')}
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
  inspectorBodyEl.querySelectorAll('[data-prop]').forEach(inp => {
    const prop = inp.dataset.prop;
    inp.addEventListener('input', () => {
      const sel = state.layers.find(L => L.id === state.selectedId);
      if (!sel) return;
      let val = inp.type === 'number' ? parseFloat(inp.value) : inp.value;
      if (prop === 'opacity100') sel.opacity = (parseFloat(val)||0)/100;
      else if (prop === 'preset') applyLogoPreset(sel, val);
      else sel[prop] = val;
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
      makeTextLayer({ text:'ACME · INC', fontFamily:'Syne', fontSize:36, fontWeight:700,
        x:canvasW*0.92, y:canvasH*0.08, align:'right', color:'#ffffff', animation:'fade', start:0, end:999 }),
      makeTextLayer({ text:'Building tomorrow,\nshipping today.', fontFamily:'Playfair Display', fontSize:72, fontWeight:700,
        x:canvasW*0.08, y:canvasH*0.5, align:'left', color:'#ffffff', animation:'cinematic', start:0.4, end:999 }),
      makeColorLayer({ x:canvasW*0.08, y:canvasH*0.6, width:canvasW*0.2, height:3, color:'#f0c040', opacity:1 }),
      makeTextLayer({ text:'Q4 · 2026', fontFamily:'JetBrains Mono', fontSize:28, fontWeight:400,
        x:canvasW*0.08, y:canvasH*0.92, align:'left', color:'#f0c040', animation:'fade', start:0.8, end:999 }),
    ];
  },
};
function applyTemplate(name) {
  if (!templates[name]) return;
  templates[name]();
  state.selectedId = state.layers[0]?.id || null;
  renderLayersPanel(); renderInspector(); syncStyleControls(); positionFloatingToolbar();
  snapshot(); draw();
  toast(`Template: ${name.replace('_',' ')}`, { gold:true });
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
  return {
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
}
async function startExport(aspect) {
  if (!state.video) { toast('Upload a video first'); return; }
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
function saveProject() {
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
  toast('Project saved');
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
  { id:'save',       label:'Save project',       cat:'File',  icon:'save', run:saveProject },
  { id:'play',       label:'Play / Pause',       cat:'Playback',icon:'play', run:togglePlay },
  { id:'mark-in',    label:'Set in mark (I)',    cat:'Trim', icon:'log-in',   run:setInMark },
  { id:'mark-out',   label:'Set out mark (O)',   cat:'Trim', icon:'log-out',  run:setOutMark },
  { id:'mark-clear', label:'Clear in/out marks', cat:'Trim', icon:'rotate-ccw', run:clearMarks },
  { id:'select-all', label:'Select all layers (⌘A)', cat:'Edit', icon:'box-select', run:selectAll },
  { id:'duplicate',  label:'Duplicate selected (⌘D)', cat:'Edit', icon:'copy', run:duplicateSelected },
  { id:'snap-beat',  label:'Toggle snap to beats', cat:'Audio', icon:'audio-waveform', run:()=>{ state.snapToBeat = !state.snapToBeat; toast('Snap to beat: '+(state.snapToBeat?'on':'off'), { gold:state.snapToBeat }); }},
  { id:'detect-beats', label:'Detect beats from music', cat:'Audio', icon:'activity', run:()=>{ if (!state.audio) toast('Drop music first'); else detectBeats(state.audio.url); }},
  { id:'theme',      label:'Toggle light / dark theme', cat:'View',  icon:'sun', run:toggleTheme },
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
    return `
      <div class="lib-item" data-name="${escapeHTML(f.name)}" data-url="${escapeHTML(f.url)}" data-kind="${f.kind}" title="${escapeHTML(display)}">
        <i data-lucide="${icon}"></i>
        <span class="lib-name">${escapeHTML(display)}</span>
        <span class="lib-kind">${escapeHTML(t('library.' + f.kind))}</span>
        <button class="lib-del" data-del="${escapeHTML(f.name)}" title="${escapeHTML(t('library.delete'))}"><i data-lucide="x"></i></button>
      </div>`;
  }).join('');
  refreshIcons();
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
      else if (meta.kind === 'image') applyLogo(meta);
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
        // If a logo layer used this file, drop it
        const before = state.layers.length;
        state.layers = state.layers.filter(l => !(l.type === 'logo' && l.src === name));
        if (state.layers.length !== before) { renderLayersPanel(); draw(); }
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
  fetchProjects().then(() => {
    const proj = state.projects.find(p => p.id === state.project);
    if (!proj) state.project = 'default';
    const display = state.projects.find(p => p.id === state.project);
    $('project-name').textContent = display?.name || 'Default';
    refreshLibrary();
  });

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
  $('btn-save-project').addEventListener('click', saveProject);
  $('load-project').addEventListener('change', e => { if (e.target.files[0]) loadProjectFile(e.target.files[0]); });

  // Export
  $('btn-export-169').addEventListener('click', () => startExport('16:9'));
  $('btn-export-916').addEventListener('click', () => startExport('9:16'));

  // Canvas drag
  canvas.addEventListener('mousedown', onCanvasMouseDown);
  canvas.addEventListener('mousemove', onCanvasMouseMove);
  window.addEventListener('mouseup',  onCanvasMouseUp);

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
