/* ================================================================
   MotionCut — ML-1: Whisper captions (opt-in)
   Orchestrates whisper.worker.js via window.MC.WorkerBridge.

   Flow: opt-in modal -> LOAD_MODEL (download progress) -> extract 16kHz
   mono PCM from the active clip -> TRANSCRIBE -> caption text layers via
   window.MC.editor.addCaptionLayers(). Captions are normal text layers, so
   the existing export path already burns them in; "Export SRT" is offered
   separately.

   Model caching: @xenova/transformers caches the model in the browser's
   Cache Storage (not IndexedDB as the spec literally asked) — same "download
   once" UX, the library owns the storage. MODEL_READY.cached reports it.
   The model is never fetched without the explicit opt-in click below.
   ================================================================ */
(() => {
'use strict';

const WORKER = '/static/js/workers/whisper.worker.js';
let _last = null;        // last { segments, style }
let _busy = false;

function ed() { return window.MC && window.MC.editor; }
function activeUrl() {
  const s = ed() && ed().state;
  return (s && s.video && s.video.url) || null;
}

// ---- 16kHz mono PCM via OfflineAudioContext resample ----------------------
async function extractPCM16k(url) {
  const buf = await fetch(url).then(r => r.arrayBuffer());
  const tmp = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await tmp.decodeAudioData(buf);
  try { tmp.close(); } catch {}
  const sr = 16000;
  const frames = Math.max(1, Math.ceil(decoded.duration * sr));
  const off = new OfflineAudioContext(1, frames, sr);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

// ---- SRT ------------------------------------------------------------------
function srtTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}
function toSRT(segments) {
  return segments.map((s, i) =>
    `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${(s.text || '').trim()}\n`
  ).join('\n');
}
function downloadSRT(segments) {
  const blob = new Blob([toSRT(segments)], { type: 'application/x-subrip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'captions.srt';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---- Modal ----------------------------------------------------------------
function buildModal() {
  if (document.getElementById('cap-backdrop')) return;
  const el = document.createElement('div');
  el.id = 'cap-backdrop';
  el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:9000';
  el.innerHTML = `
    <div style="background:#15161a;color:#eee;border:1px solid #2a2c33;border-radius:14px;width:min(440px,92vw);padding:22px;font-family:Inter,system-ui">
      <div style="font-size:17px;font-weight:700;margin-bottom:4px">Generate subtitles</div>
      <div id="cap-sub" style="font-size:13px;color:#9aa">Downloads the Whisper model (~75 MB, once). Runs entirely in your browser.</div>
      <div id="cap-style" style="margin:14px 0;display:flex;gap:8px">
        <label style="flex:1"><input type="radio" name="cap-style" value="minimal" checked> Minimal</label>
        <label style="flex:1"><input type="radio" name="cap-style" value="bold"> Bold</label>
        <label style="flex:1"><input type="radio" name="cap-style" value="cinematic"> Cinematic</label>
      </div>
      <div id="cap-prog" style="height:6px;background:#2a2c33;border-radius:3px;overflow:hidden;display:none;margin:10px 0">
        <div id="cap-bar" style="height:100%;width:0;background:#f0c040;transition:width .2s"></div>
      </div>
      <div id="cap-status" style="font-size:12px;color:#9aa;min-height:16px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button id="cap-srt"    style="display:none;padding:8px 14px;border-radius:8px;border:1px solid #2a2c33;background:transparent;color:#eee;cursor:pointer">Export SRT</button>
        <button id="cap-cancel" style="padding:8px 14px;border-radius:8px;border:1px solid #2a2c33;background:transparent;color:#eee;cursor:pointer">Later</button>
        <button id="cap-go"     style="padding:8px 14px;border-radius:8px;border:0;background:#f0c040;color:#111;font-weight:700;cursor:pointer">Download & transcribe</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#cap-cancel').onclick = () => close();
  el.querySelector('#cap-go').onclick = () => run();
  el.querySelector('#cap-srt').onclick = () => { if (_last) downloadSRT(_last.segments); };
  el.addEventListener('click', e => { if (e.target === el) close(); });
}
function open()  { buildModal(); document.getElementById('cap-backdrop').style.display = 'flex'; }
function close()  { const m = document.getElementById('cap-backdrop'); if (m) m.style.display = 'none'; }
function setStatus(t) { const s = document.getElementById('cap-status'); if (s) s.textContent = t; }
function setBar(pct) {
  const p = document.getElementById('cap-prog'), b = document.getElementById('cap-bar');
  if (p) p.style.display = 'block';
  if (b) b.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

async function run() {
  if (_busy) return;
  const url = activeUrl();
  if (!url) { setStatus('Load a clip into the timeline first.'); return; }
  const WB = window.MC && window.MC.WorkerBridge;
  if (!WB) { setStatus('Worker bridge unavailable.'); return; }
  const style = (document.querySelector('input[name="cap-style"]:checked') || {}).value || 'minimal';

  _busy = true;
  document.getElementById('cap-go').disabled = true;
  let bridge;
  try {
    bridge = new WB(WORKER);
    bridge.on(m => {
      if (!m) return;
      if (m.type === 'MODEL_PROGRESS')        { setBar(m.pct || 0); setStatus(`Downloading model… ${m.pct || 0}%`); }
      else if (m.type === 'TRANSCRIPTION_PROGRESS') { setBar(m.pct || 0); setStatus(`Transcribing… ${m.pct || 0}%`); }
    });
    setStatus('Preparing model…');
    bridge.send('LOAD_MODEL', {});
    const ready = await bridge.wait(m => m.type === 'MODEL_READY', { timeout: 600000 });
    setStatus(ready.cached ? 'Model ready (cached). Extracting audio…' : 'Model ready. Extracting audio…');

    const pcm = await extractPCM16k(url);
    setBar(0); setStatus('Transcribing…');
    bridge.send('TRANSCRIBE', { pcm, sampleRate: 16000, language: 'auto' }, [pcm.buffer]);
    const res = await bridge.wait(m => m.type === 'TRANSCRIPTION_READY', { timeout: 900000 });

    if (res.fallback || !res.segments || !res.segments.length) {
      setStatus('No speech detected (or model unavailable).');
    } else {
      const n = ed().addCaptionLayers(res.segments, style);
      _last = { segments: res.segments, style };
      document.getElementById('cap-srt').style.display = 'inline-block';
      setStatus(`Added ${n} captions. You can edit them on the timeline.`);
    }
  } catch (e) {
    console.warn('[captions]', e);
    setStatus('Transcription failed: ' + (e.message || e));
  } finally {
    try { bridge && bridge.terminate(); } catch {}
    _busy = false;
    const go = document.getElementById('cap-go'); if (go) go.disabled = false;
  }
}

// ---- Trigger button (topbar) ----------------------------------------------
function injectButton() {
  const right = document.querySelector('.topbar-right');
  if (!right || document.getElementById('btn-captions')) return;
  const b = document.createElement('button');
  b.id = 'btn-captions';
  b.className = 'ic-btn';
  b.title = 'Generate subtitles (Whisper)';
  b.innerHTML = '<i data-lucide="captions"></i>';
  b.onclick = open;
  const magic = document.getElementById('btn-magic');
  right.insertBefore(b, magic || null);
  try { window.lucide && window.lucide.createIcons(); } catch {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectButton);
} else {
  injectButton();
}

window.MC = window.MC || {};
window.MC.captions = { open, run, toSRT, downloadSRT };

})();
