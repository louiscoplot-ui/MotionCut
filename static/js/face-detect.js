/* ================================================================
   MotionCut — ML-2: MediaPipe face detection (browser worker)
   Also hosts the shared AI-badge layer + frame-extraction util reused by
   ML-3 (shot-classify.js).

   Per clip: extract ~1 frame/sec as ImageBitmaps -> mediapipe.worker.js ->
   FACE_RESULT -> persist to ai_cache (POST /api/clip/ai-cache) -> 👤 badge in
   the library. Detection is browser-only; on CDN/WASM failure the worker
   returns fallback and we simply leave has_face false. Never blocks the UI.
   ================================================================ */
(() => {
'use strict';

const FACE_WORKER = '/static/js/workers/mediapipe.worker.js';

// ---- shared AI-cache + badge layer ----------------------------------------
const _cache = {};        // filename -> ai_cache entry
const SHOT_ICON = { drone: '🚁', exterior: '🏠', interior: '🛋️', detail: '🔍' };

function pid() { return (window.MC?.editor?.state?.project) || 'default'; }

async function refresh() {
  try {
    const r = await fetch('/api/project/load/' + encodeURIComponent(pid()));
    if (!r.ok) return;
    const j = await r.json();
    const cache = (j.document && j.document.ai_cache) || {};
    Object.assign(_cache, cache);
    decorate();
  } catch {}
}

function setLocal(filename, patch) {
  _cache[filename] = Object.assign(_cache[filename] || {}, patch);
  decorate();
}

function decorate() {
  document.querySelectorAll('.lib-item[data-kind="video"]').forEach(item => {
    const name = item.getAttribute('data-name');
    const meta = item.querySelector('.lib-meta');
    if (!meta) return;
    const c = _cache[name] || {};
    // Face badge
    let fb = meta.querySelector('.ai-badge-face');
    if (c.has_face) {
      if (!fb) { fb = document.createElement('span'); fb.className = 'lib-badge ai-badge-face'; fb.textContent = '👤'; meta.appendChild(fb); }
      fb.title = 'Face detected (' + Math.round((c.face_confidence || 0) * 100) + '%)';
    } else if (fb) { fb.remove(); }
    // Shot badge (ML-3)
    let sb = meta.querySelector('.ai-badge-shot');
    if (c.shot_type && SHOT_ICON[c.shot_type]) {
      if (!sb) { sb = document.createElement('span'); sb.className = 'lib-badge ai-badge-shot'; meta.appendChild(sb); }
      sb.textContent = SHOT_ICON[c.shot_type];
      sb.title = 'Shot: ' + c.shot_type + (c.shot_confidence ? ` (${Math.round(c.shot_confidence * 100)}%)` : '');
    } else if (sb) { sb.remove(); }
  });
}

// Re-decorate whenever the library re-renders.
function observeLibrary() {
  const lib = document.querySelector('.library, #library, .media-library') ||
              document.querySelector('.lib-item')?.parentElement;
  if (!lib) return;
  const obs = new MutationObserver(() => decorate());
  obs.observe(lib, { childList: true, subtree: true });
}

// ---- frame extraction (shared with ML-3) ----------------------------------
function _seek(v, t) {
  return new Promise(res => {
    const h = () => { v.removeEventListener('seeked', h); res(); };
    v.addEventListener('seeked', h);
    try { v.currentTime = Math.min(t, (v.duration || t)); } catch { res(); }
  });
}
async function extractFrames(url, { fps = 1, maxFrames = 12, width = 256 } = {}) {
  const v = document.createElement('video');
  v.src = url; v.muted = true; v.crossOrigin = 'anonymous'; v.preload = 'auto';
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('video load failed')); });
  const dur = v.duration || 0;
  const count = Math.min(maxFrames, Math.max(1, Math.floor(dur * fps)));
  const ar = (v.videoHeight || 9) / (v.videoWidth || 16);
  const cw = width, chh = Math.max(2, Math.round(width * ar));
  const canvas = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(cw, chh)
    : Object.assign(document.createElement('canvas'), { width: cw, height: chh });
  const cx = canvas.getContext('2d');
  const frames = [];
  for (let i = 0; i < count; i++) {
    const t = dur * (i + 0.5) / count;
    await _seek(v, t);
    cx.drawImage(v, 0, 0, cw, chh);
    frames.push(await createImageBitmap(canvas));
  }
  return { frames, width: cw, height: chh, duration: dur };
}

async function persist(filename, patch) {
  try {
    await fetch('/api/clip/ai-cache', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid(), filename, ai_cache: patch }),
    });
  } catch {}
  setLocal(filename, patch);
}

// ---- face detection -------------------------------------------------------
let _busy = false;
async function analyze(filename, url) {
  const WB = window.MC && window.MC.WorkerBridge;
  if (!WB) return null;
  let bridge;
  try {
    const { frames, width, height } = await extractFrames(url, { fps: 1, maxFrames: 12, width: 256 });
    bridge = new WB(FACE_WORKER);
    bridge.send('DETECT_FACES', { frames, width, height }, frames);
    const res = await bridge.wait(m => m.type === 'FACE_RESULT', { timeout: 120000 });
    const patch = {
      has_face: !!res.has_face,
      face_confidence: res.face_confidence || 0,
      face_center: res.face_center || null,
    };
    await persist(filename, patch);
    return patch;
  } catch (e) {
    console.warn('[face]', filename, e);
    return null;
  } finally {
    try { bridge && bridge.terminate(); } catch {}
  }
}

// Analyze every library video that has no cached has_face yet. Sequential to
// avoid thrashing the GPU/WASM backend.
async function analyzeAll() {
  if (_busy) return;
  _busy = true;
  try {
    const items = Array.from(document.querySelectorAll('.lib-item[data-kind="video"]'));
    for (const it of items) {
      const name = it.getAttribute('data-name');
      const url = it.getAttribute('data-url');
      if (!name || !url) continue;
      if (_cache[name] && typeof _cache[name].has_face === 'boolean') continue;
      await analyze(name, url);
    }
  } finally { _busy = false; }
}

function injectButton() {
  const right = document.querySelector('.topbar-right');
  if (!right || document.getElementById('btn-faces')) return;
  const b = document.createElement('button');
  b.id = 'btn-faces';
  b.className = 'ic-btn';
  b.title = 'Detect faces in clips';
  b.innerHTML = '<i data-lucide="scan-face"></i>';
  b.onclick = analyzeAll;
  right.insertBefore(b, document.getElementById('btn-magic') || null);
  try { window.lucide && window.lucide.createIcons(); } catch {}
}

function boot() {
  injectButton();
  observeLibrary();
  refresh();
  setTimeout(refresh, 1500);   // library often loads async after boot
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

window.MC = window.MC || {};
window.MC.aiBadges  = { refresh, setLocal, decorate, getCache: () => _cache };
window.MC.frameUtil = { extractFrames };
window.MC.faceDetect = { analyze, analyzeAll };

})();
