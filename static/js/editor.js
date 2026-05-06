/* MotionCut editor — canvas overlay, layers, animations, templates, export */

(() => {
'use strict';

// ============================================================
//  Global state
// ============================================================
const state = {
  video:   null,        // {filename,url,duration}
  audio:   null,        // {filename,url,duration}
  aspect:  '16:9',      // 16:9 or 9:16
  layers:  [],          // see makeTextLayer / makeLogoLayer / makeColorLayer
  selectedId: null,
  template: 'custom',
  fx: { vignette: false, grain: false, grade: 'natural' },
  music: { volume: 60, fadeIn: false, fadeOut: false, mode: 'mix' },
};

// Canvas reference resolution (the JS coords). Sent to backend so it can scale.
const CANVAS_W = 1920;
const CANVAS_H = 1080;        // 16:9 default; recalculated for 9:16

const FONTS = [
  'Syne', 'Orbitron', 'Teko', 'Playfair Display',
  'JetBrains Mono', 'Bebas Neue', 'Arial', 'Georgia'
];

// Undo / redo
const history = { stack: [], idx: -1, max: 50 };

// ============================================================
//  DOM
// ============================================================
const $ = (id) => document.getElementById(id);
const video    = $('video');
const canvas   = $('canvas');
const ctx      = canvas.getContext('2d');
const stageWrap  = $('stage-wrap');
const stageInner = $('stage-inner');
const scrubber = $('scrubber');
const layerListEl = $('layer-list');
const layerPropsEl = $('layer-props');
const toastEl = $('toast');

let canvasW = CANVAS_W, canvasH = CANVAS_H;

// ============================================================
//  Helpers
// ============================================================
function uid() { return Math.random().toString(36).slice(2, 10); }

function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function toast(msg, ms=2500) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add('hidden'), ms);
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// ============================================================
//  Aspect ratio handling
// ============================================================
function setAspect(aspect) {
  state.aspect = aspect;
  if (aspect === '9:16') {
    stageWrap.classList.remove('aspect-16-9');
    stageWrap.classList.add('aspect-9-16');
    canvasW = 1080; canvasH = 1920;
  } else {
    stageWrap.classList.remove('aspect-9-16');
    stageWrap.classList.add('aspect-16-9');
    canvasW = 1920; canvasH = 1080;
  }
  resizeCanvas();
  document.querySelectorAll('.aspect-toggle .aspect').forEach(b => {
    b.classList.toggle('on', b.dataset.aspect === aspect);
  });
  draw();
}

function resizeCanvas() {
  // Use display size with high-DPI backing buffer.
  const r = stageInner.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.max(2, Math.round(r.width  * dpr));
  canvas.height = Math.max(2, Math.round(r.height * dpr));
  // Logical drawing is in canvasW x canvasH coordinates; scale ctx accordingly.
  ctx.setTransform(canvas.width / canvasW, 0, 0, canvas.height / canvasH, 0, 0);
}

window.addEventListener('resize', () => { resizeCanvas(); draw(); });

// ============================================================
//  Layer factories
// ============================================================
function makeTextLayer(opts={}) {
  return Object.assign({
    id: uid(),
    type: 'text',
    text: 'Your Headline',
    x: canvasW * 0.5,
    y: canvasH * 0.5,
    width: 800,
    height: 100,
    fontFamily: 'Syne',
    fontSize: 96,
    fontWeight: 700,
    color: '#ffffff',
    align: 'center',
    start: 0,
    end:   8,
    animation: 'fade',
  }, opts);
}

function makeLogoLayer(opts={}) {
  return Object.assign({
    id: uid(),
    type: 'logo',
    src: null,
    url: null,
    img: null,
    x: 60, y: 60,
    width: 240, height: 240,
    opacity: 1,
    start: 0, end: 9999,
  }, opts);
}

function makeColorLayer(opts={}) {
  return Object.assign({
    id: uid(),
    type: 'color',
    color: '#000000',
    opacity: 0.35,
    x: 0, y: 0, width: canvasW, height: canvasH,
    start: 0, end: 9999,
  }, opts);
}

// ============================================================
//  History (undo/redo)
// ============================================================
function snapshot() {
  // Strip non-serialisable refs (Image objects).
  const pruned = {
    ...state,
    layers: state.layers.map(l => {
      const c = { ...l }; delete c.img; return c;
    }),
  };
  // Truncate redo branch.
  history.stack = history.stack.slice(0, history.idx + 1);
  history.stack.push(JSON.stringify(pruned));
  if (history.stack.length > history.max) history.stack.shift();
  history.idx = history.stack.length - 1;
}

function restore(json) {
  try {
    const data = JSON.parse(json);
    state.layers = (data.layers || []).map(l => {
      if (l.type === 'logo' && l.url) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = l.url;
        l.img = img;
      }
      return l;
    });
    state.selectedId = data.selectedId || null;
    state.aspect    = data.aspect || '16:9';
    state.fx        = data.fx || state.fx;
    state.music     = data.music || state.music;
    state.template  = data.template || 'custom';
    setAspect(state.aspect);
    syncFxControls();
    rebuildLayerList();
    showLayerProps();
    draw();
  } catch (e) { console.error(e); }
}

function undo() {
  if (history.idx <= 0) return;
  history.idx--;
  restore(history.stack[history.idx]);
}
function redo() {
  if (history.idx >= history.stack.length - 1) return;
  history.idx++;
  restore(history.stack[history.idx]);
}

// ============================================================
//  Upload
// ============================================================
async function uploadFile(file, kind) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('kind', kind);
  const r = await fetch('/api/upload', { method: 'POST', body: fd });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `upload failed (${r.status})`);
  }
  return r.json();
}

function bindDropzone(zoneId, inputId, kind, onUploaded) {
  const zone = $(zoneId);
  const input = $(inputId);
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('over');
    if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => {
    if (input.files[0]) handle(input.files[0]);
  });
  async function handle(file) {
    try {
      toast(`Uploading ${file.name}…`, 60000);
      const meta = await uploadFile(file, kind);
      zone.classList.add('has-file');
      zone.querySelector('strong').textContent = file.name;
      toast(`Loaded ${file.name}`);
      onUploaded(meta);
    } catch (err) {
      toast(`Error: ${err.message}`);
    }
  }
}

// ============================================================
//  Layer interaction (drag & resize)
// ============================================================
const HANDLE_SIZE = 14;       // logical px in canvas coords
let drag = null;              // { id, mode:'move'|'resize', dx, dy, startX, startY, startW, startH }

function getLayerBounds(l) {
  if (l.type === 'text') {
    // approximate width by rendering metrics
    ctx.save();
    ctx.font = `${l.fontWeight} ${l.fontSize}px ${l.fontFamily}`;
    const m = ctx.measureText(l.text || '');
    ctx.restore();
    const w = m.width + 20;
    const h = l.fontSize * 1.4;
    return { x: l.x - w/2, y: l.y - h/2, w, h };
  }
  return { x: l.x, y: l.y, w: l.width, h: l.height };
}

function pointInLayer(px, py, l) {
  const b = getLayerBounds(l);
  return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
}

function pointInResizeHandle(px, py, l) {
  const b = getLayerBounds(l);
  const hx = b.x + b.w, hy = b.y + b.h;
  return px >= hx - HANDLE_SIZE && px <= hx + HANDLE_SIZE
      && py >= hy - HANDLE_SIZE && py <= hy + HANDLE_SIZE;
}

function canvasCoordsFromEvent(e) {
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width  * canvasW;
  const y = (e.clientY - r.top)  / r.height * canvasH;
  return { x, y };
}

canvas.addEventListener('mousedown', (e) => {
  const { x, y } = canvasCoordsFromEvent(e);
  // priority: hit test top-most layer
  let hit = null, mode = 'move';
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const l = state.layers[i];
    if (state.selectedId === l.id && pointInResizeHandle(x, y, l)) {
      hit = l; mode = 'resize'; break;
    }
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
    };
    showLayerProps();
    rebuildLayerList();
    draw();
  } else {
    state.selectedId = null;
    showLayerProps();
    rebuildLayerList();
    draw();
  }
});

canvas.addEventListener('mousemove', (e) => {
  const { x, y } = canvasCoordsFromEvent(e);
  if (!drag) {
    // hover cursor
    const sel = state.layers.find(l => l.id === state.selectedId);
    if (sel && pointInResizeHandle(x, y, sel)) canvas.style.cursor = 'nwse-resize';
    else if (state.layers.some(l => pointInLayer(x, y, l))) canvas.style.cursor = 'move';
    else canvas.style.cursor = 'default';
    return;
  }
  const l = state.layers.find(L => L.id === drag.id);
  if (!l) return;
  if (drag.mode === 'move') {
    l.x = clamp(x - drag.offX, 0, canvasW);
    l.y = clamp(y - drag.offY, 0, canvasH);
  } else {
    if (l.type === 'text') {
      const newH = Math.max(20, y - drag.anchorY);
      l.fontSize = clamp(Math.round(newH / 1.4), 12, 400);
    } else {
      l.width  = Math.max(20, x - drag.anchorX);
      l.height = Math.max(20, y - drag.anchorY);
    }
  }
  draw();
});

window.addEventListener('mouseup', () => {
  if (drag) { drag = null; snapshot(); showLayerProps(); }
});

// ============================================================
//  Drawing
// ============================================================
function applyCanvasFilter() {
  const f = [];
  const g = state.fx.grade;
  if (g === 'cinematic')   f.push('contrast(1.08) saturate(0.95)');
  if (g === 'teal_orange') f.push('contrast(1.05) saturate(1.25) hue-rotate(-8deg)');
  if (g === 'moody_dark')  f.push('brightness(0.9) contrast(1.15) saturate(0.9)');
  if (g === 'bright_airy') f.push('brightness(1.08) contrast(0.95) saturate(1.1)');
  if (g === 'bw')          f.push('grayscale(1) contrast(1.08)');
  video.style.filter = f.join(' ');
}

function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

function drawTextLayer(l, t) {
  ctx.save();
  let alpha = 1;
  let dx = 0, dy = 0;
  let drawText = l.text || '';

  if (t < l.start || t > l.end) { ctx.restore(); return; }
  const local = t - l.start;
  const dur   = l.end - l.start;
  const inP   = clamp(local / 0.6, 0, 1);
  const outP  = clamp((l.end - t) / 0.6, 0, 1);

  switch (l.animation) {
    case 'fade':
      alpha = Math.min(easeOut(inP), easeOut(outP));
      break;
    case 'tracking': {
      alpha = Math.min(easeOut(inP), easeOut(outP));
      const spread = (1 - easeOut(Math.min(local / 1.0, 1))) * 40;
      ctx.letterSpacing = spread + 'px';
      break;
    }
    case 'reveal': {
      alpha = Math.min(easeOut(inP), easeOut(outP));
      // scan reveal: clip rect grows
      const p = easeOut(clamp(local / 0.8, 0, 1));
      const b = getLayerBounds(l);
      ctx.beginPath();
      ctx.rect(b.x, b.y, b.w * p, b.h);
      ctx.clip();
      break;
    }
    case 'typewriter': {
      const cps = Math.max(8, drawText.length / Math.max(0.5, dur * 0.4));
      const n = Math.min(drawText.length, Math.floor(local * cps));
      drawText = drawText.slice(0, n) + (Math.floor(local*2) % 2 ? '|' : ' ');
      alpha = Math.min(easeOut(inP), easeOut(outP));
      break;
    }
    case 'zoom':
    case 'glow':
      alpha = Math.min(easeOut(inP), easeOut(outP));
      ctx.shadowColor = l.color;
      ctx.shadowBlur = 20 + 10 * Math.sin(local * 4);
      break;
    case 'bounce': {
      alpha = Math.min(easeOut(inP), easeOut(outP));
      dy = -Math.abs(Math.sin(local * 3)) * 14 * outP;
      break;
    }
    case 'cinematic': {
      alpha = Math.min(easeOut(inP), easeOut(outP));
      dy = (1 - easeOut(inP)) * -20;
      break;
    }
    default:
      alpha = Math.min(easeOut(inP), easeOut(outP));
  }

  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.fillStyle    = l.color;
  ctx.textAlign    = l.align || 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${l.fontWeight || 700} ${l.fontSize}px "${l.fontFamily}", sans-serif`;

  // subtle shadow for legibility
  ctx.shadowColor = ctx.shadowColor || 'rgba(0,0,0,0.55)';
  ctx.shadowBlur  = ctx.shadowBlur  || 8;

  if (l.animation === 'zoom') {
    const s = 1 + 0.04 * Math.sin(local * 3);
    ctx.translate(l.x + dx, l.y + dy);
    ctx.scale(s, s);
    ctx.fillText(drawText, 0, 0);
  } else {
    ctx.fillText(drawText, l.x + dx, l.y + dy);
  }
  ctx.restore();
}

function drawLogoLayer(l, t) {
  if (t < l.start || t > l.end) return;
  if (!l.img || !l.img.complete) return;
  ctx.save();
  ctx.globalAlpha = l.opacity ?? 1;
  ctx.drawImage(l.img, l.x, l.y, l.width, l.height);
  ctx.restore();
}

function drawColorLayer(l) {
  ctx.save();
  ctx.fillStyle = l.color;
  ctx.globalAlpha = l.opacity;
  ctx.fillRect(l.x, l.y, l.width, l.height);
  ctx.restore();
}

function drawLetterbox() {
  const bar = canvasH * 0.12;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvasW, bar);
  ctx.fillRect(0, canvasH - bar, canvasW, bar);
  ctx.restore();
}

function drawVignette() {
  const g = ctx.createRadialGradient(
    canvasW/2, canvasH/2, Math.min(canvasW,canvasH)*0.3,
    canvasW/2, canvasH/2, Math.max(canvasW,canvasH)*0.7
  );
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0,0,canvasW,canvasH);
  ctx.restore();
}

function drawGrain() {
  // Cheap pseudo grain — random dots only every other frame.
  const N = 800;
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = '#fff';
  for (let i = 0; i < N; i++) {
    const x = Math.random() * canvasW;
    const y = Math.random() * canvasH;
    ctx.fillRect(x, y, 2, 2);
  }
  ctx.restore();
}

function drawSelection() {
  const sel = state.layers.find(l => l.id === state.selectedId);
  if (!sel) return;
  const b = getLayerBounds(sel);
  ctx.save();
  ctx.strokeStyle = '#f0c040';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  // resize handle
  ctx.setLineDash([]);
  ctx.fillStyle = '#f0c040';
  ctx.fillRect(b.x + b.w - HANDLE_SIZE/2, b.y + b.h - HANDLE_SIZE/2,
               HANDLE_SIZE, HANDLE_SIZE);
  ctx.restore();
}

function draw() {
  const t = video.currentTime || 0;
  ctx.clearRect(0, 0, canvasW, canvasH);

  // letterbox (template flag)
  if (state.letterbox) drawLetterbox();

  for (const l of state.layers) {
    if (l.type === 'text')  drawTextLayer(l, t);
    else if (l.type === 'logo') drawLogoLayer(l, t);
    else if (l.type === 'color') drawColorLayer(l);
  }

  if (state.fx.vignette) drawVignette();
  if (state.fx.grain)    drawGrain();

  drawSelection();
}

function loop() {
  draw();
  if (video.duration > 0) {
    const p = (video.currentTime / video.duration) * 1000;
    scrubber.value = p;
    scrubber.style.setProperty('--p', (p/10).toFixed(1) + '%');
    $('time-display').textContent =
      `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
  }
  requestAnimationFrame(loop);
}

// ============================================================
//  Layer list & properties UI
// ============================================================
function rebuildLayerList() {
  layerListEl.innerHTML = '';
  state.layers.forEach(l => {
    const chip = document.createElement('div');
    chip.className = 'layer-chip' + (l.id === state.selectedId ? ' active' : '');
    chip.innerHTML = `<span class="dot"></span>${escapeHTML(layerLabel(l))}`;
    chip.onclick = () => {
      state.selectedId = l.id;
      showLayerProps(); rebuildLayerList(); draw();
    };
    layerListEl.appendChild(chip);
  });
}

function layerLabel(l) {
  if (l.type === 'text') return `T: ${(l.text||'').slice(0,18)}`;
  if (l.type === 'logo') return 'Logo';
  if (l.type === 'color') return 'Color';
  return l.type;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function showLayerProps() {
  const l = state.layers.find(L => L.id === state.selectedId);
  if (!l) {
    layerPropsEl.innerHTML = '<p class="muted">Select a layer on the canvas to edit.</p>';
    return;
  }
  const commonTime = `
    <label class="row col"><span>Start (s)</span>
      <input type="number" step="0.1" min="0" value="${l.start}" data-prop="start"/></label>
    <label class="row col"><span>End (s)</span>
      <input type="number" step="0.1" min="0" value="${l.end}" data-prop="end"/></label>`;

  if (l.type === 'text') {
    layerPropsEl.innerHTML = `
      <label class="row col"><span>Text</span>
        <input type="text" value="${escapeHTML(l.text)}" data-prop="text"/></label>
      <label class="row col"><span>Font</span>
        <select data-prop="fontFamily">
          ${FONTS.map(f => `<option ${f===l.fontFamily?'selected':''}>${f}</option>`).join('')}
        </select></label>
      <label class="row col"><span>Size</span>
        <input type="number" min="8" max="400" value="${l.fontSize}" data-prop="fontSize"/></label>
      <label class="row col"><span>Weight</span>
        <select data-prop="fontWeight">
          ${[300,400,500,600,700,800,900].map(w =>
            `<option value="${w}" ${w==l.fontWeight?'selected':''}>${w}</option>`).join('')}
        </select></label>
      <label class="row"><span>Color</span>
        <input type="color" value="${l.color}" data-prop="color"/></label>
      <label class="row col"><span>Align</span>
        <select data-prop="align">
          ${['left','center','right'].map(a =>
            `<option ${a===l.align?'selected':''}>${a}</option>`).join('')}
        </select></label>
      <label class="row col"><span>Animation</span>
        <select data-prop="animation">
          ${['none','fade','tracking','reveal','typewriter','zoom','glow','bounce','cinematic'].map(a =>
            `<option ${a===l.animation?'selected':''}>${a}</option>`).join('')}
        </select></label>
      <label class="row col"><span>X</span>
        <input type="number" value="${Math.round(l.x)}" data-prop="x"/></label>
      <label class="row col"><span>Y</span>
        <input type="number" value="${Math.round(l.y)}" data-prop="y"/></label>
      ${commonTime}
    `;
  } else if (l.type === 'logo') {
    layerPropsEl.innerHTML = `
      <label class="row col"><span>Width</span>
        <input type="number" value="${Math.round(l.width)}" data-prop="width"/></label>
      <label class="row col"><span>Height</span>
        <input type="number" value="${Math.round(l.height)}" data-prop="height"/></label>
      <label class="row col"><span>Opacity ${Math.round((l.opacity||1)*100)}%</span>
        <input type="range" min="0" max="100" value="${Math.round((l.opacity||1)*100)}" data-prop="opacity100"/></label>
      <label class="row col"><span>Preset position</span>
        <select data-prop="preset">
          <option value="">—</option>
          <option value="tl">Top-left</option>
          <option value="tr">Top-right</option>
          <option value="bl">Bottom-left</option>
          <option value="br">Bottom-right</option>
          <option value="c">Center</option>
        </select></label>
      ${commonTime}
    `;
  } else if (l.type === 'color') {
    layerPropsEl.innerHTML = `
      <label class="row"><span>Color</span>
        <input type="color" value="${l.color}" data-prop="color"/></label>
      <label class="row col"><span>Opacity ${Math.round(l.opacity*100)}%</span>
        <input type="range" min="0" max="100" value="${Math.round(l.opacity*100)}" data-prop="opacity100"/></label>
      ${commonTime}
    `;
  }

  layerPropsEl.querySelectorAll('[data-prop]').forEach(inp => {
    inp.addEventListener('input', () => {
      const prop = inp.dataset.prop;
      const sel = state.layers.find(L => L.id === state.selectedId);
      if (!sel) return;
      let val = inp.value;
      if (inp.type === 'number') val = parseFloat(val);
      if (prop === 'opacity100') { sel.opacity = (parseFloat(val)||0)/100; }
      else if (prop === 'preset') {
        applyLogoPreset(sel, val);
      } else {
        sel[prop] = val;
      }
      draw();
      rebuildLayerList();
    });
    inp.addEventListener('change', () => snapshot());
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
//  Templates
// ============================================================
const templates = {
  cinematic: () => {
    state.template = 'cinematic';
    state.letterbox = true;
    state.fx.vignette = true;
    state.fx.grade = 'cinematic';
    state.layers = [
      makeTextLayer({
        text: 'A FILM BY YOU',
        fontFamily: 'Playfair Display', fontSize: 110, fontWeight: 700,
        x: canvasW/2, y: canvasH/2 - 30,
        color: '#ffffff', animation: 'cinematic', start: 0.4, end: 6,
      }),
      makeTextLayer({
        text: 'a short documentary',
        fontFamily: 'Syne', fontSize: 36, fontWeight: 400,
        x: canvasW/2, y: canvasH/2 + 60,
        color: '#f0c040', animation: 'fade', start: 1.0, end: 6,
      }),
    ];
  },
  real_estate: () => {
    state.template = 'real_estate';
    state.letterbox = false;
    state.fx.grade = 'bright_airy';
    state.layers = [
      makeTextLayer({
        text: 'OAK GROVE RESIDENCE',
        fontFamily: 'Orbitron', fontSize: 78, fontWeight: 800,
        x: canvasW * 0.28, y: canvasH * 0.78, align: 'left',
        color: '#ffffff', animation: 'tracking', start: 0.5, end: 12,
      }),
      makeTextLayer({
        text: 'Brisbane • QLD',
        fontFamily: 'Syne', fontSize: 30, fontWeight: 500,
        x: canvasW * 0.28, y: canvasH * 0.85, align: 'left',
        color: '#f0c040', animation: 'fade', start: 0.8, end: 12,
      }),
      makeTextLayer({
        text: '$1,495,000',
        fontFamily: 'Bebas Neue', fontSize: 80,
        x: canvasW * 0.85, y: canvasH * 0.12, align: 'right',
        color: '#f0c040', animation: 'fade', start: 0.4, end: 12,
      }),
    ];
  },
  travel: () => {
    state.template = 'travel';
    state.letterbox = false;
    state.fx.grade = 'teal_orange';
    state.layers = [
      makeColorLayer({
        x: 0, y: canvasH * 0.7, width: canvasW, height: canvasH * 0.3,
        color: '#000000', opacity: 0.4,
      }),
      makeTextLayer({
        text: 'WANDERLUST',
        fontFamily: 'Teko', fontSize: 200, fontWeight: 700,
        x: canvasW/2, y: canvasH/2,
        color: '#ffffff', animation: 'reveal', start: 0.3, end: 8,
      }),
      makeTextLayer({
        text: '📍  Kyoto, Japan',
        fontFamily: 'Syne', fontSize: 42, fontWeight: 500,
        x: canvasW/2, y: canvasH * 0.86,
        color: '#f0c040', animation: 'fade', start: 1.2, end: 10,
      }),
    ];
  },
  social: () => {
    state.template = 'social';
    setAspect('9:16');
    state.fx.vignette = true;
    state.fx.grade = 'moody_dark';
    state.layers = [
      makeTextLayer({
        text: 'WAIT FOR IT…',
        fontFamily: 'Bebas Neue', fontSize: 180,
        x: canvasW/2, y: canvasH * 0.25,
        color: '#ffffff', animation: 'bounce', start: 0.2, end: 5,
      }),
      makeTextLayer({
        text: '#viral  #fyp  #foryou',
        fontFamily: 'Syne', fontSize: 48, fontWeight: 600,
        x: canvasW/2, y: canvasH * 0.9,
        color: '#f0c040', animation: 'fade', start: 1.0, end: 999,
      }),
    ];
  },
  corporate: () => {
    state.template = 'corporate';
    state.letterbox = false;
    state.fx.grade = 'natural';
    state.layers = [
      makeTextLayer({
        text: 'ACME · INC',
        fontFamily: 'Syne', fontSize: 36, fontWeight: 700,
        x: canvasW * 0.92, y: canvasH * 0.08, align: 'right',
        color: '#ffffff', animation: 'fade', start: 0, end: 999,
      }),
      makeTextLayer({
        text: 'Building tomorrow,\nshipping today.',
        fontFamily: 'Playfair Display', fontSize: 72, fontWeight: 700,
        x: canvasW * 0.08, y: canvasH * 0.5, align: 'left',
        color: '#ffffff', animation: 'cinematic', start: 0.4, end: 999,
      }),
      makeColorLayer({
        x: canvasW * 0.08, y: canvasH * 0.6,
        width: canvasW * 0.2, height: 3,
        color: '#f0c040', opacity: 1,
      }),
      makeTextLayer({
        text: 'Q4 · 2026',
        fontFamily: 'JetBrains Mono', fontSize: 28, fontWeight: 400,
        x: canvasW * 0.08, y: canvasH * 0.92, align: 'left',
        color: '#f0c040', animation: 'fade', start: 0.8, end: 999,
      }),
    ];
  },
};

function applyTemplate(name) {
  if (!templates[name]) return;
  templates[name]();
  state.selectedId = state.layers[0]?.id || null;
  rebuildLayerList(); showLayerProps();
  syncFxControls();
  snapshot(); draw();
  toast(`Template applied: ${name}`);
}

// ============================================================
//  Effect controls sync
// ============================================================
function syncFxControls() {
  $('fx-vignette').checked = state.fx.vignette;
  $('fx-grain').checked    = state.fx.grain;
  $('fx-grade').value      = state.fx.grade;
  applyCanvasFilter();
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
    layers: state.layers.map(l => ({
      ...l,
      img: undefined,
      canvasW, canvasH,
    })),
  };
}

async function startExport(aspect) {
  if (!state.video) { toast('Upload a video first'); return; }
  const payload = buildExportPayload(aspect);
  try {
    const r = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      $('export-status').textContent =
        job.status === 'error'
          ? `Error: ${(job.error||'').slice(0,180)}`
          : `${job.status} — ${pct}%`;
      if (job.status === 'done') {
        es.close();
        $('export-done').classList.remove('hidden');
        $('export-link').href = job.url;
        $('export-link').textContent = `⤓ Download ${job.output}`;
        toast('Export complete');
      } else if (job.status === 'error') {
        es.close();
      }
    } catch {}
  };
  es.onerror = () => { es.close(); };
}

// ============================================================
//  Project save / load
// ============================================================
function saveProject() {
  const data = {
    version: 1,
    video: state.video, audio: state.audio,
    aspect: state.aspect, template: state.template,
    fx: state.fx, music: state.music,
    letterbox: !!state.letterbox,
    layers: state.layers.map(l => ({ ...l, img: undefined })),
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
          const img = new Image(); img.crossOrigin = 'anonymous'; img.src = l.url;
          l.img = img;
        }
        return l;
      });
      if (state.video?.url) video.src = state.video.url;
      setAspect(data.aspect || '16:9');
      syncFxControls();
      rebuildLayerList(); showLayerProps(); snapshot(); draw();
      toast('Project loaded');
    } catch (e) { toast(`Load failed: ${e.message}`); }
  };
  reader.readAsText(file);
}

// ============================================================
//  Wiring
// ============================================================
function init() {
  // Health
  fetch('/api/health').then(r => r.json()).then(j => {
    $('ffmpeg-status').textContent = `FFmpeg: ${j.ffmpeg ? 'ready' : 'NOT FOUND'}`;
    $('ffmpeg-status').style.color = j.ffmpeg ? '#7ee07e' : '#e64b4b';
  }).catch(() => $('ffmpeg-status').textContent = 'FFmpeg: ?');

  setAspect('16:9');

  // Dropzones
  bindDropzone('dropzone-video', 'file-video', 'video', (meta) => {
    state.video = meta;
    video.src = meta.url;
    video.load();
    video.onloadedmetadata = () => {
      // align default layer end times to video duration
      state.layers.forEach(l => { if (l.end > 9000) l.end = video.duration; });
      draw();
    };
  });
  bindDropzone('dropzone-image', 'file-image', 'image', (meta) => {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.src = meta.url;
    const layer = makeLogoLayer({
      src: meta.filename, url: meta.url, img,
      x: 60, y: 60, width: 240, height: 240,
    });
    img.onload = () => {
      const r = img.naturalWidth / img.naturalHeight;
      layer.height = layer.width / r;
      draw();
    };
    state.layers.push(layer);
    state.selectedId = layer.id;
    rebuildLayerList(); showLayerProps(); snapshot(); draw();
  });
  bindDropzone('dropzone-audio', 'file-audio', 'audio', (meta) => {
    state.audio = meta;
    $('music-info').textContent = `${meta.filename} (${fmtTime(meta.duration||0)})`;
  });

  // Add layer buttons
  $('btn-add-text').onclick = () => {
    const l = makeTextLayer({ end: video.duration || 8 });
    state.layers.push(l); state.selectedId = l.id;
    rebuildLayerList(); showLayerProps(); snapshot(); draw();
  };
  $('btn-add-logo').onclick = () => $('file-image').click();
  $('btn-add-color').onclick = () => {
    const l = makeColorLayer();
    state.layers.push(l); state.selectedId = l.id;
    rebuildLayerList(); showLayerProps(); snapshot(); draw();
  };

  // Effects
  $('fx-vignette').onchange = e => { state.fx.vignette = e.target.checked; draw(); snapshot(); };
  $('fx-grain').onchange    = e => { state.fx.grain    = e.target.checked; draw(); snapshot(); };
  $('fx-grade').onchange    = e => { state.fx.grade    = e.target.value;   applyCanvasFilter(); snapshot(); };

  // Music
  $('music-volume').oninput = e => {
    state.music.volume = parseInt(e.target.value, 10);
    $('music-vol-label').textContent = state.music.volume + '%';
  };
  $('music-fadein').onchange  = e => state.music.fadeIn = e.target.checked;
  $('music-fadeout').onchange = e => state.music.fadeOut = e.target.checked;
  $('music-mode').onchange    = e => state.music.mode = e.target.value;

  // Aspect toggle
  document.querySelectorAll('.aspect-toggle .aspect').forEach(b => {
    b.onclick = () => setAspect(b.dataset.aspect);
  });

  // Templates
  document.querySelectorAll('.tpl').forEach(b => {
    b.onclick = () => applyTemplate(b.dataset.template);
  });

  // Play/scrub
  $('btn-play').onclick = togglePlay;
  video.addEventListener('play',  () => $('btn-play').textContent = '❚❚');
  video.addEventListener('pause', () => $('btn-play').textContent = '▶');
  scrubber.addEventListener('input', () => {
    if (video.duration > 0) video.currentTime = (scrubber.value / 1000) * video.duration;
  });

  // Delete layer
  $('btn-delete-layer').onclick = deleteSelected;

  // Undo / redo
  $('btn-undo').onclick = undo;
  $('btn-redo').onclick = redo;

  // Save / load project
  $('btn-save-project').onclick = saveProject;
  $('load-project').addEventListener('change', e => {
    if (e.target.files[0]) loadProjectFile(e.target.files[0]);
  });

  // Export
  $('btn-export-169').onclick = () => startExport('16:9');
  $('btn-export-916').onclick = () => startExport('9:16');

  // Keyboard shortcuts
  window.addEventListener('keydown', onKey);

  // Initial snapshot for undo baseline.
  snapshot();
  loop();
}

function togglePlay() {
  if (!video.src) { toast('Upload a video first'); return; }
  if (video.paused) video.play(); else video.pause();
}

function deleteSelected() {
  if (!state.selectedId) return;
  state.layers = state.layers.filter(l => l.id !== state.selectedId);
  state.selectedId = null;
  rebuildLayerList(); showLayerProps(); snapshot(); draw();
}

function onKey(e) {
  // ignore when typing in form fields
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;

  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft')  { video.currentTime = Math.max(0, video.currentTime - 1/30); }
  else if (e.key === 'ArrowRight') { video.currentTime = Math.min(video.duration||0, video.currentTime + 1/30); }
  else if (e.key === '-' || e.key === '_') { video.currentTime = Math.max(0, video.currentTime - 1/30); }
  else if (e.key === '+' || e.key === '=') { video.currentTime = Math.min(video.duration||0, video.currentTime + 1/30); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); }
  else if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
}

document.addEventListener('DOMContentLoaded', init);

})();
