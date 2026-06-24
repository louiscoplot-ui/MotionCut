/* ================================================================
   MotionCut — RE-1: Real-Estate Reel workflow
   "🏠 RE Reel" -> setup modal -> auto-order clips by shot_type -> price
   tiering (per-clip trim + aspect) -> typed overlays -> mandatory preview ->
   export through the existing mature path (btn-export-169 / -916).

   Operates on window.MC.editor.state.segments and reads shot_type from the
   shared aiBadges cache (ML-3). Overlays are real text layers via
   editor.addOverlay(). Never exports without the preview confirmation.
   ================================================================ */
(() => {
'use strict';

function ed() { return window.MC && window.MC.editor; }
function cacheMap() { return (window.MC.aiBadges && window.MC.aiBadges.getCache()) || {}; }
function shotOf(seg) { return (cacheMap()[seg.filename] || {}).shot_type || 'unknown'; }

function parsePrice(str) {
  if (str == null) return null;
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ''));
  return isFinite(n) && n > 0 ? n : null;
}
function formatPrice(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}
function tierFor(price) {
  if (price == null)        return { name: 'Default (no price)', perClip: 5.0, aspect: '16:9', letterbox: false, total: null };
  if (price < 500000)       return { name: '< $500k',  perClip: 3.5, aspect: '9:16', letterbox: false, total: 30 };
  if (price <= 2000000)     return { name: '$500k–2M', perClip: 5.5, aspect: '16:9', letterbox: false, total: 45 };
  return                           { name: '> $2M',    perClip: 8.5, aspect: '16:9', letterbox: true,  total: 60 };
}

// Order: drone_wide -> exterior -> interior -> detail -> drone_outro.
// Unknowns keep their existing relative order at the end.
function buildOrder(segs) {
  const by = { drone: [], exterior: [], interior: [], detail: [], unknown: [] };
  for (const s of segs) {
    const t = shotOf(s);
    (by[t] || by.unknown).push(s);
  }
  const order = [];
  if (by.drone.length) order.push(by.drone[0]);                 // drone_wide
  order.push(...by.exterior, ...by.interior, ...by.detail);
  if (by.drone.length > 2) order.push(...by.drone.slice(1, -1));
  if (by.drone.length >= 2) order.push(by.drone[by.drone.length - 1]); // drone_outro
  order.push(...by.unknown);
  const seen = new Set(), final = [];
  for (const s of order) if (!seen.has(s.id)) { seen.add(s.id); final.push(s); }
  for (const s of segs) if (!seen.has(s.id)) final.push(s);     // safety: nothing dropped
  return final;
}

function applyWorkflow(info) {
  const E = ed(); if (!E) return { error: 'Editor not ready.' };
  const st = E.state;
  let segs = st.segments || [];
  if (!segs.length) return { error: 'Add clips to the timeline first.' };

  const knownCount = segs.filter(s => shotOf(s) !== 'unknown').length;
  const ordered = buildOrder(segs);
  st.segments = ordered;

  const price = parsePrice(info.price);
  const tier = tierFor(price);

  // Tiered per-clip trim (clamped to each clip's available source length).
  for (const s of ordered) {
    const avail = ((s._duration || s.sourceOut) - s.sourceIn) || tier.perClip;
    const len = Math.max(0.5, Math.min(tier.perClip, avail));
    s.sourceOut = s.sourceIn + len;
  }
  E.reflowSegments(st.segments);
  st.letterbox = tier.letterbox;

  // Typed overlays (real text layers spanning each clip's timeline range).
  const firstDrone = ordered.find(s => shotOf(s) === 'drone') || ordered[0];
  const firstExt   = ordered.find(s => shotOf(s) === 'exterior') || ordered[0];
  if (price != null && firstDrone)
    E.addOverlay({ text: formatPrice(price), position: 'top-right', start: firstDrone.timelineIn, end: firstDrone.timelineOut, name: 'Price' });
  if (info.address && firstExt)
    E.addOverlay({ text: info.address, position: 'bottom-center', start: firstExt.timelineIn, end: firstExt.timelineOut, name: 'Address' });
  for (const s of ordered.filter(x => shotOf(x) === 'interior'))
    E.addOverlay({ text: 'Room', position: 'bottom-left', start: s.timelineIn, end: s.timelineOut, name: 'Room' });
  if (info.agent && ordered[0])
    E.addOverlay({ text: info.agent, position: 'bottom-left', start: 0, end: Math.min(4, ordered[0].timelineOut || 4), name: 'Agent' });

  try { E.snapshot(); } catch {}
  const total = ordered.reduce((p, s) => p + (s.timelineOut - s.timelineIn), 0);
  return {
    tier, price,
    rows: ordered.map(s => ({ name: s.filename.replace(/^[a-f0-9]{6,16}_/, ''), type: shotOf(s), dur: +(s.timelineOut - s.timelineIn).toFixed(1) })),
    total: +total.toFixed(1),
    allUnknown: knownCount === 0,
  };
}

function exportWithTier(tier) {
  const btn = tier.aspect === '9:16' ? document.getElementById('btn-export-916')
                                     : document.getElementById('btn-export-169');
  if (btn) btn.click();
}

// ---- Modal ----------------------------------------------------------------
let _preview = null;
function buildModal() {
  if (document.getElementById('re-backdrop')) return;
  const el = document.createElement('div');
  el.id = 're-backdrop';
  el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:9000';
  el.innerHTML = `
    <div style="background:#15161a;color:#eee;border:1px solid #2a2c33;border-radius:14px;width:min(520px,94vw);max-height:88vh;overflow:auto;padding:22px;font-family:Inter,system-ui">
      <div style="font-size:17px;font-weight:700;margin-bottom:10px">🏠 RE Reel</div>
      <div id="re-form">
        <label style="display:block;font-size:12px;color:#9aa;margin:8px 0 2px">Sale price (optional — drives tiering)</label>
        <input id="re-price" placeholder="$1,500,000" style="width:100%;padding:8px;border-radius:8px;border:1px solid #2a2c33;background:#0f1013;color:#eee">
        <label style="display:block;font-size:12px;color:#9aa;margin:8px 0 2px">Property address</label>
        <input id="re-address" placeholder="14 Jutland Pde, Cottesloe" style="width:100%;padding:8px;border-radius:8px;border:1px solid #2a2c33;background:#0f1013;color:#eee">
        <label style="display:block;font-size:12px;color:#9aa;margin:8px 0 2px">Agency / Agent</label>
        <input id="re-agent" placeholder="Jane Smith · Acme Realty" style="width:100%;padding:8px;border-radius:8px;border:1px solid #2a2c33;background:#0f1013;color:#eee">
      </div>
      <div id="re-preview" style="display:none;margin-top:14px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button id="re-cancel" style="padding:8px 14px;border-radius:8px;border:1px solid #2a2c33;background:transparent;color:#eee;cursor:pointer">Cancel</button>
        <button id="re-modify" style="display:none;padding:8px 14px;border-radius:8px;border:1px solid #2a2c33;background:transparent;color:#eee;cursor:pointer">Modify</button>
        <button id="re-gen"    style="padding:8px 14px;border-radius:8px;border:0;background:#f0c040;color:#111;font-weight:700;cursor:pointer">Generate edit</button>
        <button id="re-export" style="display:none;padding:8px 14px;border-radius:8px;border:0;background:#4ade80;color:#062;font-weight:700;cursor:pointer">Export</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#re-cancel').onclick = close;
  el.querySelector('#re-modify').onclick = close;   // back to manual timeline
  el.querySelector('#re-gen').onclick = onGenerate;
  el.querySelector('#re-export').onclick = () => { if (_preview) { exportWithTier(_preview.tier); close(); } };
  el.addEventListener('click', e => { if (e.target === el) close(); });
}
function open()  { buildModal(); document.getElementById('re-backdrop').style.display = 'flex'; }
function close() { const m = document.getElementById('re-backdrop'); if (m) m.style.display = 'none'; }

function onGenerate() {
  const val = id => (document.getElementById(id).value || '').trim();
  const res = applyWorkflow({ price: val('re-price'), address: val('re-address'), agent: val('re-agent') });
  const box = document.getElementById('re-preview');
  if (res.error) { box.style.display = 'block'; box.innerHTML = `<div style="color:#f88">${res.error}</div>`; return; }
  _preview = res;
  const warn = res.allUnknown
    ? `<div style="color:#f0c040;font-size:12px;margin-bottom:6px">No shot types detected — classify clips for smart ordering. Kept current order.</div>` : '';
  const rows = res.rows.map(r =>
    `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #23252b"><span>${r.type} · ${r.name.slice(0, 28)}</span><span class="mono">${r.dur}s</span></div>`
  ).join('');
  box.style.display = 'block';
  box.innerHTML = `${warn}
    <div style="font-size:12px;color:#9aa;margin-bottom:6px">Tier: <b style="color:#eee">${res.tier.name}</b> · ${res.tier.aspect}${res.tier.letterbox ? ' · letterbox' : ''} · total ~${res.total}s</div>
    ${rows}`;
  document.getElementById('re-gen').style.display = 'none';
  document.getElementById('re-modify').style.display = 'inline-block';
  document.getElementById('re-export').style.display = 'inline-block';
}

function injectButton() {
  const right = document.querySelector('.topbar-right');
  if (!right || document.getElementById('btn-re-reel')) return;
  const b = document.createElement('button');
  b.id = 'btn-re-reel';
  b.className = 'ic-btn';
  b.title = 'RE Reel — auto real-estate edit';
  b.textContent = '🏠';
  b.onclick = open;
  right.insertBefore(b, document.getElementById('btn-magic') || null);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectButton);
else injectButton();

window.MC = window.MC || {};
window.MC.reWorkflow = { open, applyWorkflow, buildOrder, tierFor, parsePrice, formatPrice };

})();
