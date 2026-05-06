/* ================================================================
   MotionCut — Motion System (GSAP-powered)
   Premium, subtle, 60fps. Inspired by Apple / Arc / Linear / Figma.
   No bouncy gamer easings. No motion over 600ms on UI chrome.
   ================================================================ */
(() => {
'use strict';

// Bail gracefully if GSAP missing
if (!window.gsap) {
  console.warn('[motion] GSAP not loaded — motion system disabled.');
  window.MC = window.MC || {};
  window.MC.motion = { disabled: true, on: () => {}, off: () => {}, pulse: () => {}, panel: () => {}, drag: () => {}, snap: () => {}, hover: () => {}, toast: () => {}, exportComplete: () => {} };
  return;
}

const gsap = window.gsap;

// ============================================================
//  MOTION TOKENS
//  Single source of truth — every animation reads from here.
// ============================================================
const TOKENS = {
  ease: {
    // Power curves — UI default. Confident, never bouncy.
    standard:  'power3.out',
    decel:     'power2.out',
    accel:     'power2.in',
    smooth:    'power4.out',     // panel slide-ins
    quart:     'power4.inOut',   // mode crossfade
    // Subtle spring — only for press release, not chrome.
    softSpring:'back.out(1.4)',
    // Elastic-feel overshoot reserved for *celebration* (export complete).
    celebrate: 'expo.out',
  },
  dur: {
    instant:  0.08,
    fast:     0.16,
    base:     0.24,
    slow:     0.36,
    cinema:   0.6,    // mode change / hero reveal
  },
  stagger: {
    tight:    0.025,
    base:     0.04,
    loose:    0.08,
  },
};

// Honor user's reduced-motion preference
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (REDUCED) {
  for (const k in TOKENS.dur) TOKENS.dur[k] = 0.001;
}

// ============================================================
//  PRIMITIVES
// ============================================================

/** Smoothly fade/slide an element in. */
function appearIn(el, opts = {}) {
  if (!el) return;
  return gsap.fromTo(el,
    { opacity: 0, y: opts.y ?? 6, scale: opts.scale ?? 1 },
    {
      opacity: 1, y: 0, scale: 1,
      duration: opts.duration ?? TOKENS.dur.base,
      ease: opts.ease ?? TOKENS.ease.smooth,
      delay: opts.delay ?? 0,
      clearProps: 'transform',
      onComplete: opts.onComplete,
    });
}

/** Subtle pulse — used for emphasis, e.g. when exporting starts. */
function pulse(el, opts = {}) {
  if (!el) return;
  const tl = gsap.timeline();
  tl.to(el, { scale: opts.scale ?? 1.03, duration: 0.16, ease: TOKENS.ease.standard });
  tl.to(el, { scale: 1,   duration: 0.32, ease: TOKENS.ease.softSpring });
  return tl;
}

/** Press-down feedback — snappy, 80ms. */
function press(el) {
  if (!el) return;
  gsap.to(el, { scale: 0.97, duration: TOKENS.dur.instant, ease: TOKENS.ease.accel,
    onComplete: () => gsap.to(el, { scale: 1, duration: TOKENS.dur.fast, ease: TOKENS.ease.softSpring }) });
}

/** Hover lift — no shadow tween, just transform. CSS keeps the shadow. */
function hoverLift(el) {
  if (!el) return;
  gsap.to(el, { y: -1, duration: TOKENS.dur.fast, ease: TOKENS.ease.decel });
}
function hoverDrop(el) {
  if (!el) return;
  gsap.to(el, { y: 0, duration: TOKENS.dur.fast, ease: TOKENS.ease.decel });
}

/** Panel slide-in from right rail — used on mount. */
function panelSlideIn(el, delay = 0) {
  if (!el) return;
  gsap.from(el, {
    opacity: 0, y: 8,
    duration: TOKENS.dur.slow,
    ease: TOKENS.ease.smooth,
    delay,
    clearProps: 'all',
  });
}

/** FLIP-style reorder for a list of children (e.g. layer rows). */
function reorderFLIP(parent, callback) {
  const children = [...parent.children];
  const first = children.map(c => c.getBoundingClientRect());
  callback(); // mutate DOM order externally
  const last  = [...parent.children].map(c => c.getBoundingClientRect());
  [...parent.children].forEach((c, i) => {
    const oldRect = first[children.indexOf(c)];
    if (!oldRect) return;
    const dx = oldRect.left - last[i].left;
    const dy = oldRect.top  - last[i].top;
    if (dx === 0 && dy === 0) return;
    gsap.fromTo(c, { x: dx, y: dy }, {
      x: 0, y: 0,
      duration: TOKENS.dur.base,
      ease: TOKENS.ease.smooth,
      clearProps: 'all',
    });
  });
}

// ============================================================
//  MAGNETIC HOVER
//  Buttons subtly attract toward the cursor — Arc-style.
//  Use sparingly. Reserved for primary CTAs.
// ============================================================
function magnetize(el, opts = {}) {
  if (!el || REDUCED) return;
  const strength = opts.strength ?? 0.18;   // 0..0.4 — 0.18 is "premium subtle"
  const radius   = opts.radius   ?? 80;     // distance in px where magnet applies

  const onMove = (e) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top  + r.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) {
      gsap.to(el, { x: 0, y: 0, duration: TOKENS.dur.base, ease: TOKENS.ease.smooth });
      return;
    }
    gsap.to(el, {
      x: dx * strength,
      y: dy * strength,
      duration: TOKENS.dur.fast,
      ease: TOKENS.ease.decel,
    });
  };
  const reset = () => gsap.to(el, { x: 0, y: 0, duration: TOKENS.dur.base, ease: TOKENS.ease.smooth });

  el.addEventListener('mousemove', onMove);
  el.addEventListener('mouseleave', reset);
}

// ============================================================
//  TOAST motion
// ============================================================
function toastIn(el) {
  if (!el) return;
  gsap.fromTo(el,
    { opacity: 0, x: 12, scale: 0.98 },
    { opacity: 1, x: 0, scale: 1, duration: TOKENS.dur.base, ease: TOKENS.ease.smooth, clearProps: 'all' });
}

// ============================================================
//  EXPORT CELEBRATION
//  When export completes — full-frame gold flash + soft scale.
// ============================================================
function exportComplete(stageEl) {
  if (!stageEl) return;
  const flash = document.createElement('div');
  Object.assign(flash.style, {
    position: 'absolute', inset: '0',
    background: 'radial-gradient(circle at 50% 50%, rgba(240,192,64,0.55), rgba(240,192,64,0.0) 70%)',
    pointerEvents: 'none',
    zIndex: 7,
    opacity: '0',
    mixBlendMode: 'screen',
  });
  stageEl.appendChild(flash);
  const tl = gsap.timeline({ onComplete: () => flash.remove() });
  tl.to(flash, { opacity: 1, duration: 0.18, ease: TOKENS.ease.celebrate });
  tl.to(flash, { opacity: 0, duration: 0.6,  ease: TOKENS.ease.smooth }, '+=0.05');
  // tiny scale punch on the frame
  gsap.fromTo(stageEl, { scale: 1 }, { scale: 1.012, duration: 0.18, yoyo: true, repeat: 1, ease: TOKENS.ease.standard });
}

// ============================================================
//  SNAP guide flash (cyan/gold lines that appear when an element snaps)
// ============================================================
function flashSnapGuide(svgLine) {
  if (!svgLine || REDUCED) return;
  gsap.fromTo(svgLine,
    { attr: { 'stroke-opacity': 0 } , scale: 1 },
    { attr: { 'stroke-opacity': 0.9 }, duration: 0.12, ease: TOKENS.ease.decel });
}

// ============================================================
//  SCRUB inertia — gentle settle when releasing the playhead.
// ============================================================
function scrubInertia(scrubberEl, fromVal, toVal, onUpdate) {
  if (!scrubberEl || REDUCED) { onUpdate(toVal); return; }
  const obj = { v: fromVal };
  gsap.to(obj, {
    v: toVal,
    duration: 0.32,
    ease: TOKENS.ease.smooth,
    onUpdate: () => onUpdate(obj.v),
  });
}

// ============================================================
//  Stage empty-state breathing — subtle, infinite, low-amp
// ============================================================
function breathe(el) {
  if (!el || REDUCED) return;
  return gsap.to(el, {
    opacity: 0.55,
    duration: 2.4,
    ease: 'sine.inOut',
    yoyo: true,
    repeat: -1,
  });
}

// ============================================================
//  Modal / overlay fade
// ============================================================
function overlayShow(el) {
  if (!el) return;
  gsap.fromTo(el,
    { opacity: 0 },
    { opacity: 1, duration: TOKENS.dur.base, ease: TOKENS.ease.decel });
  const inner = el.querySelector('.cmdk, .drop-overlay-inner, .ctx-menu');
  if (inner) {
    gsap.fromTo(inner,
      { y: -8, scale: 0.98, opacity: 0 },
      { y: 0,  scale: 1, opacity: 1, duration: TOKENS.dur.slow, ease: TOKENS.ease.smooth });
  }
}
function overlayHide(el) {
  if (!el) return;
  gsap.to(el, { opacity: 0, duration: TOKENS.dur.fast, ease: TOKENS.ease.accel });
}

// ============================================================
//  GLOBAL SETUP — runs after DOMContentLoaded
//  Wire micro-interactions on common elements.
// ============================================================
function setup() {
  // 1. App boot — the whole frame eases in
  if (!REDUCED) {
    gsap.from('.topbar', { y: -8, opacity: 0, duration: TOKENS.dur.slow, ease: TOKENS.ease.smooth });
    gsap.from('.stage-col', { opacity: 0, duration: TOKENS.dur.slow, ease: TOKENS.ease.smooth, delay: 0.05 });
    gsap.from('.rail .panel', {
      opacity: 0, y: 12,
      duration: TOKENS.dur.slow,
      ease: TOKENS.ease.smooth,
      stagger: TOKENS.stagger.base,
      delay: 0.08,
    });
  }

  // 2. Primary CTA magnetism (gold export button)
  const cta = document.querySelector('.cta');
  if (cta) magnetize(cta, { strength: 0.20, radius: 90 });

  // 3. Press feedback on ALL buttons (delegated)
  document.addEventListener('mousedown', (e) => {
    const b = e.target.closest('button, .cta, .cta-outline, .tpl, .grade-chip');
    if (!b) return;
    press(b);
  });

  // 4. Hover lift on cards (delegated, lightweight)
  ['mouseenter', 'mouseleave'].forEach(evt => {
    document.body.addEventListener(evt, (e) => {
      const b = e.target.closest?.('.tpl, .grade-chip, .cta-outline');
      if (!b) return;
      if (evt === 'mouseenter') hoverLift(b); else hoverDrop(b);
    }, true);
  });

  // 5. Stage empty state — breathe
  const empty = document.getElementById('stage-empty');
  if (empty && !empty.classList.contains('hidden')) {
    breathe(empty.querySelector('.stage-empty-icon'));
  }

  // 6. Layer panel reorder — patch SortableJS to use FLIP-feel via SortableJS animation
  // (SortableJS has its own `animation: 200`; we ensure consistent timing.)

  // 7. Toast — observe DOM for show
  const toastEl = document.getElementById('toast');
  if (toastEl) {
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.attributeName === 'class' && !toastEl.classList.contains('hidden')) {
          toastIn(toastEl);
        }
      }
    });
    obs.observe(toastEl, { attributes: true });
  }

  // 8. Cmd+K palette / drop overlay — animate via observers
  const cmdk = document.getElementById('cmdk-backdrop');
  if (cmdk) {
    const obs = new MutationObserver(() => {
      if (cmdk.classList.contains('show')) overlayShow(cmdk);
    });
    obs.observe(cmdk, { attributes: true });
  }
  const drop = document.getElementById('drop-overlay');
  if (drop) {
    const obs = new MutationObserver(() => {
      if (drop.classList.contains('show')) overlayShow(drop);
    });
    obs.observe(drop, { attributes: true });
  }
  const ctx = document.getElementById('ctx-menu');
  if (ctx) {
    const obs = new MutationObserver(() => {
      if (ctx.classList.contains('show')) {
        gsap.fromTo(ctx,
          { opacity: 0, y: -4, scale: 0.97 },
          { opacity: 1, y: 0, scale: 1, duration: TOKENS.dur.fast, ease: TOKENS.ease.smooth });
      }
    });
    obs.observe(ctx, { attributes: true });
  }

  // 9. Scrubber — when user releases, gentle catch-up (handled by editor.js if it opts in via MC.motion.scrubInertia)

  // 10. Logo mark — cinematic slow pulse (replaces CSS-only pulse for smoother frames)
  const logo = document.querySelector('.logo-mark');
  if (logo && !REDUCED) {
    gsap.to(logo, {
      filter: 'drop-shadow(0 0 14px rgba(240,192,64,0.45))',
      duration: 1.6,
      ease: 'sine.inOut',
      yoyo: true,
      repeat: -1,
    });
  }
}

// ============================================================
//  Public API exposed on window.MC.motion
// ============================================================
window.MC = window.MC || {};
window.MC.motion = {
  TOKENS,
  appearIn, pulse, press, hoverLift, hoverDrop,
  panelSlideIn, reorderFLIP,
  magnetize,
  toastIn,
  exportComplete,
  flashSnapGuide,
  scrubInertia,
  breathe,
  overlayShow, overlayHide,
};

document.addEventListener('DOMContentLoaded', setup);

})();
