/* ================================================================
   MotionCut — AI plan panel (natural-language editing)
   Talks to POST /api/ai/plan. Adapted to the REAL editor API:
   clips come from /api/projects/<pid>/files (filename-keyed), the plan is
   applied by rebuilding window.MC.editor.state.segments via appendSegment().
   Degrades cleanly: 503 from the backend when no ANTHROPIC_API_KEY is set.
   ================================================================ */
(() => {
'use strict';

function ed() { return window.MC && window.MC.editor; }
function pid() { return (ed() && ed().state && ed().state.project) || 'default'; }

async function fetchClips() {
  try {
    const r = await fetch('/api/projects/' + encodeURIComponent(pid()) + '/files');
    if (!r.ok) return [];
    const files = await r.json();
    const cache = (window.MC.aiBadges && window.MC.aiBadges.getCache()) || {};
    return (Array.isArray(files) ? files : (files.files || []))
      .filter(f => f.kind === 'video')
      .map(f => ({ id: f.name, filename: f.name, duration: f.duration || 0, metadata: cache[f.name] || {} }));
  } catch { return []; }
}

function applyPlan(plan) {
  const E = ed(); if (!E) return;
  const st = E.state;
  st.segments = [];
  const ordered = (plan.segments || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const s of ordered) {
    const fn = s.clip_id;
    E.appendSegment({
      filename: fn,
      url: '/projects/' + encodeURIComponent(pid()) + '/files/' + encodeURIComponent(fn),
      kind: 'video',
      sourceIn: +s.start || 0,
      sourceOut: (+s.end > +s.start) ? +s.end : (+s.start || 0) + 2,
      _duration: (+s.end || 0) || 5,
      transition: s.transition && s.transition !== 'cut'
        ? { type: s.transition, duration: +s.transition_duration || 0.5 } : undefined,
    });
  }
  try { E.snapshot(); } catch {}
  try { window.MC.timeline && window.MC.timeline.render(); } catch {}
  try { window.MC.project && window.MC.project.save(st); } catch {}
}

// ---- Modal ----------------------------------------------------------------
function buildModal() {
  if (document.getElementById('ai-backdrop')) return;
  const el = document.createElement('div');
  el.id = 'ai-backdrop';
  el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:9000';
  el.innerHTML = `
    <div style="background:#15161a;color:#eee;border:1px solid #2a2c33;border-radius:14px;width:min(480px,94vw);padding:22px;font-family:Inter,system-ui">
      <div style="font-size:17px;font-weight:700;margin-bottom:4px">✨ Edit with AI</div>
      <div style="font-size:12px;color:#9aa;margin-bottom:8px">Describe the edit in plain language.</div>
      <textarea id="ai-prompt" placeholder="Reel immobilier 30s, drone d'abord, chaque piece 3-4s, transitions douces, fin sur l'exterieur"
        style="width:100%;height:84px;resize:vertical;font-size:13px;padding:8px;border-radius:8px;border:1px solid #2a2c33;background:#0f1013;color:#eee"></textarea>
      <div id="ai-status" style="font-size:12px;color:#9aa;min-height:16px;margin-top:8px"></div>
      <div id="ai-preview" style="display:none;margin-top:10px;max-height:240px;overflow:auto"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button id="ai-cancel" style="padding:8px 14px;border-radius:8px;border:1px solid #2a2c33;background:transparent;color:#eee;cursor:pointer">Close</button>
        <button id="ai-gen"    style="padding:8px 14px;border-radius:8px;border:0;background:#f0c040;color:#111;font-weight:700;cursor:pointer">Generate</button>
        <button id="ai-apply"  style="display:none;padding:8px 14px;border-radius:8px;border:0;background:#4ade80;color:#062;font-weight:700;cursor:pointer">Apply plan</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#ai-cancel').onclick = close;
  el.querySelector('#ai-gen').onclick = generate;
  el.addEventListener('click', e => { if (e.target === el) close(); });
}
function open()  { buildModal(); document.getElementById('ai-backdrop').style.display = 'flex'; }
function close() { const m = document.getElementById('ai-backdrop'); if (m) m.style.display = 'none'; }
function status(t) { const s = document.getElementById('ai-status'); if (s) s.textContent = t; }

let _plan = null;
async function generate() {
  const prompt = (document.getElementById('ai-prompt').value || '').trim();
  if (!prompt) { status('Describe the edit first.'); return; }
  const clips = await fetchClips();
  if (!clips.length) { status('No video clips in this project yet.'); return; }
  status('Asking Claude…');
  document.getElementById('ai-gen').disabled = true;
  try {
    const r = await fetch('/api/ai/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, clips }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    _plan = j.plan;
    status(j.explanation || `${_plan.segments.length} segments`);
    const box = document.getElementById('ai-preview');
    box.style.display = 'block';
    box.innerHTML = _plan.segments.map((s, i) =>
      `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #23252b">
         <span>${i + 1}. ${String(s.clip_id).replace(/^[a-f0-9]{6,16}_/, '').slice(0, 28)}</span>
         <span class="mono">${(s.end - s.start).toFixed(1)}s · ${s.transition || 'cut'}</span></div>`).join('');
    const apply = document.getElementById('ai-apply');
    apply.style.display = 'inline-block';
    apply.onclick = () => { applyPlan(_plan); status('Plan applied to the timeline.'); };
  } catch (e) {
    status('AI plan failed: ' + (e.message || e));
  } finally {
    document.getElementById('ai-gen').disabled = false;
  }
}

function injectButton() {
  const right = document.querySelector('.topbar-right');
  if (!right || document.getElementById('btn-ai-plan')) return;
  const b = document.createElement('button');
  b.id = 'btn-ai-plan';
  b.className = 'ic-btn';
  b.title = 'Edit with AI (natural language)';
  b.innerHTML = '<i data-lucide="sparkles"></i>';
  b.onclick = open;
  right.insertBefore(b, document.getElementById('btn-magic') || null);
  try { window.lucide && window.lucide.createIcons(); } catch {}
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectButton);
else injectButton();

window.MC = window.MC || {};
window.MC.aiPanel = { open, generate, applyPlan };

})();
