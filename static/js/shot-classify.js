/* ================================================================
   MotionCut — ML-3: shot classifier integration
   Reuses frameUtil + aiBadges from face-detect.js. Per clip: extract 3
   frames (25/50/75%) -> classifier.worker.js -> persist shot_type to
   ai_cache -> badge in the library. Falls back to the worker's heuristic
   when no ONNX model is present.
   ================================================================ */
(() => {
'use strict';

const WORKER = '/static/js/workers/classifier.worker.js';
let _busy = false;

function pid() { return (window.MC?.editor?.state?.project) || 'default'; }

async function classify(filename, url) {
  const WB = window.MC && window.MC.WorkerBridge;
  const FU = window.MC && window.MC.frameUtil;
  if (!WB || !FU) return null;
  let bridge;
  try {
    const { frames, width, height, duration } = await FU.extractFrames(url, { fps: 1, maxFrames: 3, width: 224 });
    bridge = new WB(WORKER);
    bridge.send('CLASSIFY_CLIP', { frames, clip_id: filename, meta: { width, height, duration } }, frames);
    const res = await bridge.wait(m => m.type === 'CLASSIFICATION_RESULT', { timeout: 120000 });
    const patch = { shot_type: res.shot_type, shot_confidence: res.confidence || 0 };
    try {
      await fetch('/api/clip/ai-cache', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: pid(), filename, ai_cache: patch }),
      });
    } catch {}
    window.MC.aiBadges && window.MC.aiBadges.setLocal(filename, patch);
    return patch;
  } catch (e) {
    console.warn('[shot]', filename, e);
    return null;
  } finally {
    try { bridge && bridge.terminate(); } catch {}
  }
}

async function classifyAll() {
  if (_busy) return;
  _busy = true;
  try {
    const items = Array.from(document.querySelectorAll('.lib-item[data-kind="video"]'));
    const cache = (window.MC.aiBadges && window.MC.aiBadges.getCache()) || {};
    for (const it of items) {
      const name = it.getAttribute('data-name');
      const url = it.getAttribute('data-url');
      if (!name || !url) continue;
      const c = cache[name];
      if (c && c.shot_type && c.shot_type !== 'unknown') continue;
      await classify(name, url);
    }
  } finally { _busy = false; }
}

function injectButton() {
  const right = document.querySelector('.topbar-right');
  if (!right || document.getElementById('btn-shots')) return;
  const b = document.createElement('button');
  b.id = 'btn-shots';
  b.className = 'ic-btn';
  b.title = 'Classify shots (drone / exterior / interior / detail)';
  b.innerHTML = '<i data-lucide="shapes"></i>';
  b.onclick = classifyAll;
  right.insertBefore(b, document.getElementById('btn-magic') || null);
  try { window.lucide && window.lucide.createIcons(); } catch {}
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectButton);
else injectButton();

window.MC = window.MC || {};
window.MC.shotClassify = { classify, classifyAll };

})();
