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
  video: null,
  audio: null,
  aspect: '16:9',
  layers: [],
  selectedId: null,
  template: 'custom',
  fx:    { vignette: false, grain: false, grade: 'natural' },
  music: { volume: 60, fadeIn: false, fadeOut: false, mode: 'mix' },
  letterbox: false,
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
function setAspect(aspect) {
  state.aspect = aspect;
  stageWrap.classList.remove('aspect-16-9','aspect-9-16','aspect-1-1');
  if (aspect === '9:16')      { stageWrap.classList.add('aspect-9-16'); canvasW = CANVAS_W_916; canvasH = CANVAS_H_916; }
  else if (aspect === '1:1')  { stageWrap.classList.add('aspect-1-1');  canvasW = CANVAS_W_11;  canvasH = CANVAS_H_11; }
  else                        { stageWrap.classList.add('aspect-16-9'); canvasW = CANVAS_W_169; canvasH = CANVAS_H_169; }

  document.querySelectorAll('.aspect-segmented .aspect').forEach(b => {
    b.classList.toggle('on', b.dataset.aspect === aspect);
  });
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
  try {
    toast(`Uploading ${file.name}…`, { ms: 60000, gold: true });
    const meta = await uploadFile(file, kind, pct => {
      toast(`Uploading ${file.name} — ${pct.toFixed(0)}%`, { ms: 60000, gold: true });
    });
    toast(`Loaded ${file.name}`);
    if (kind === 'video')  applyVideo(meta);
    if (kind === 'image')  applyLogo(meta);
    if (kind === 'audio')  applyMusic(meta);
  } catch (e) {
    toast(`Error: ${e.message}`);
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
  $('dropzone-audio').classList.add('has-file');
  $('dropzone-audio').querySelector('.dz-title').textContent = 'Music set';
  const mi = $('music-info');
  mi.classList.add('has-file');
  mi.querySelector('span').textContent = meta.filename + ' · ' + fmtTime(meta.duration||0);
  mi.querySelector('span').classList.remove('muted');
  try { window.MC?.timeline?.render?.(); } catch {}
}

// ============================================================
//  Drop-anywhere overlay
// ============================================================
function bindDropOverlay() {
  const overlay = $('drop-overlay');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
    depth++;
    overlay.classList.add('show');
  });
  window.addEventListener('dragleave', (e) => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.classList.remove('show');
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('show');
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
    if (e.dataTransfer.files[0]) await handleFile(e.dataTransfer.files[0], kind);
  });
  input.addEventListener('change', async () => {
    if (input.files[0]) await handleFile(input.files[0], kind);
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
  const b = getLayerBounds(l);
  return px >= b.x + b.w - HANDLE && px <= b.x + b.w + HANDLE
      && py >= b.y + b.h - HANDLE && py <= b.y + b.h + HANDLE;
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

function onCanvasMouseDown(e) {
  if (e.button === 2) return; // context menu handles right-click
  const { x, y } = canvasCoordsFromEvent(e);
  let hit = null, mode = 'move';
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const l = state.layers[i];
    if (!l.visible || l.locked) continue;
    if (state.selectedId === l.id && pointInResizeHandle(x, y, l)) { hit = l; mode = 'resize'; break; }
    if (pointInLayer(x, y, l)) { hit = l; mode = 'move'; break; }
  }
  if (hit) {
    state.selectedId = hit.id;
    const b = getLayerBounds(hit);
    drag = {
      id: hit.id, mode,
      offX: x - hit.x, offY: y - hit.y,
      startX: hit.x, startY: hit.y,
      startW: hit.width || b.w, startH: hit.height || b.h,
      anchorX: b.x, anchorY: b.y,
      origMouse: { x, y },
    };
  } else {
    state.selectedId = null;
  }
  renderLayersPanel(); renderInspector(); positionFloatingToolbar(); draw();
}

function onCanvasMouseMove(e) {
  const { x, y } = canvasCoordsFromEvent(e);
  if (!drag) {
    const sel = state.layers.find(l => l.id === state.selectedId);
    if (sel && pointInResizeHandle(x, y, sel)) canvas.style.cursor = 'nwse-resize';
    else if (state.layers.some(l => pointInLayer(x, y, l))) canvas.style.cursor = 'move';
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
    l.x = clamp(l.x + snap.dx, 0, canvasW);
    l.y = clamp(l.y + snap.dy, 0, canvasH);
    drawSnapGuides(snap.guides);
    showDragTooltip(e, l);
  } else if (drag.mode === 'resize') {
    if (l.type === 'text') {
      const newH = Math.max(20, y - drag.anchorY);
      l.fontSize = clamp(Math.round(newH / 1.4), 12, 400);
    } else {
      l.width  = Math.max(20, x - drag.anchorX);
      l.height = Math.max(20, y - drag.anchorY);
    }
  }
  positionFloatingToolbar();
  draw();
}

function onCanvasMouseUp() {
  if (drag) { drag = null; clearSnapGuides(); hideDragTooltip(); snapshot(); renderInspector(); }
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
  if (!l.visible || t < l.start || t > l.end) return;
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
  if (!l.visible || t < l.start || t > l.end) return;
  if (!l.img || !l.img.complete) return;
  ctx.save();
  ctx.globalCompositeOperation = l.blendMode || 'source-over';
  ctx.globalAlpha = l.opacity ?? 1;
  ctx.drawImage(l.img, l.x, l.y, l.width, l.height);
  ctx.restore();
}

function drawColorLayer(l) {
  if (!l.visible) return;
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
  const sel = state.layers.find(l => l.id === state.selectedId);
  if (!sel || !sel.visible) return;
  const b = getLayerBounds(sel);
  ctx.save();
  ctx.strokeStyle = '#f0c040'; ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.setLineDash([]);
  // 4 corner handles
  ctx.fillStyle = '#f0c040';
  const corners = [[b.x,b.y],[b.x+b.w,b.y],[b.x,b.y+b.h],[b.x+b.w,b.y+b.h]];
  for (const [cx,cy] of corners) {
    ctx.fillRect(cx - HANDLE/2, cy - HANDLE/2, HANDLE, HANDLE);
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
    else if (l.type === 'color') drawColorLayer(l);
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
  const empty = state.layers.length === 0;
  if (empty) {
    layersPanelEl.innerHTML = `
      <div class="layers-empty">
        <i data-lucide="square-stack" class="empty-icon"></i>
        <div>No layers yet</div>
        <div class="muted small">Add text, logo, or overlay above</div>
      </div>`;
    refreshIcons();
    return;
  }
  // Render top→bottom = top of z-stack first (last in array)
  const rows = [...state.layers].reverse().map(l => {
    const active = l.id === state.selectedId ? 'active' : '';
    const hidden = !l.visible ? 'is-hidden' : '';
    return `
      <div class="layer-row ${active} ${hidden}" data-id="${l.id}">
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
      handle: '.layer-row',
      filter: 'button, .layer-name',
      preventOnFilter: false,
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
      state.selectedId = id;
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
    inspectorBodyEl.innerHTML = `
      <div class="inspector-empty">
        <i data-lucide="mouse-pointer-2" class="empty-icon"></i>
        <div class="muted small">Select a layer to edit</div>
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
//  Export
// ============================================================
function buildExportPayload(aspectOverride) {
  return {
    video: state.video?.filename,
    audio: state.audio?.filename || null,
    aspect: aspectOverride || state.aspect,
    template: state.template,
    colorGrade: state.fx.grade,
    vignette: state.fx.vignette,
    filmGrain: state.fx.grain,
    letterbox: !!state.letterbox,
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
];
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
    if (e.key === 'Escape') { closeCmdk(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); cmdkIdx = Math.min(rows.length-1, cmdkIdx+1); updateCmdkSel(rows); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); cmdkIdx = Math.max(0, cmdkIdx-1); updateCmdkSel(rows); }
    else if (e.key === 'Enter')     { e.preventDefault(); runCmdkAt(cmdkIdx); }
  });
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
function deleteSelected() {
  if (state.selectedId) deleteLayer(state.selectedId);
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
  else if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); if (state.selectedId) duplicateLayer(state.selectedId); }
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

  // Templates
  document.querySelectorAll('.tpl').forEach(b =>
    b.addEventListener('click', () => applyTemplate(b.dataset.template)));

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
