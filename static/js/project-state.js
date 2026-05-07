/* ================================================================
   MotionCut — Project State Module
   ----------------------------------------------------------------
   Single source-of-truth API for project documents.

   The persisted document conforms to schemas/project.schema.json (v1).
   It is the I/O contract for:
     - Save / Load via Flask
     - Magic Edit (input = EditRequest, output = EditPlan)
     - Future AI features (planner, classifier, captioner...)
     - Undo / redo (diff between versions of this doc)

   Two coordinate systems coexist:
     - The persisted "project document" (this module's responsibility):
         nested, typed, schema-validated, language-agnostic.
     - The editor's runtime "state" object (in editor.js):
         flat for performance, shaped for direct canvas drawing.

   serialize(state) → projectDoc
   deserialize(projectDoc) → state

   Both directions preserve every field. If you add a new field to one,
   add it to the other; the schema must be updated too.

   ================================================================ */
(() => {
'use strict';

const SCHEMA_URL = 'https://motioncut.dev/schemas/project/v1.json';
const SCHEMA_VERSION = 1;

// ============================================================
//   JSDoc type definitions
//   These are the public contracts. Refer to project.schema.json
//   for authoritative validation rules.
// ============================================================

/**
 * @typedef {Object} ClipAnalysis
 * @property {number}   [shot_score]       0..1 composite quality score
 * @property {number}   [motion]           Avg pixel motion per second
 * @property {number}   [brightness]       0..1 mean luminance
 * @property {number}   [sharpness]        Laplacian variance proxy
 * @property {boolean}  [has_face]
 * @property {('drone'|'exterior'|'interior'|'detail'|'talking_head'|'unknown')} [shot_type]
 * @property {number[]} [scene_changes]    Cut times in seconds (intra-clip)
 * @property {number[]} [audio_peaks]      RMS peak times in seconds
 * @property {string[]} [dominant_colors]  Top colors as #rrggbb
 * @property {string}   [analyzed_at]      ISO timestamp
 */

/**
 * @typedef {Object} ClipMeta
 * @property {string}        id           Unique id, prefixed `clip_`
 * @property {string}        path         Filename relative to the project's uploads folder
 * @property {('video'|'image'|'audio')} kind
 * @property {number}        [duration]   Seconds (for video/audio)
 * @property {string}        [aspect_ratio]
 * @property {boolean}       [analyzed]   Whether the analysis cache is filled
 * @property {ClipAnalysis}  [analysis]
 */

/**
 * @typedef {Object} Transition
 * @property {('cut'|'xfade'|'fade'|'wipe'|'dip-to-black')} type
 * @property {number} [duration]  Seconds (0 for hard cuts)
 */

/**
 * @typedef {Object} Segment
 * @property {string}      id          Unique id, prefixed `seg_`
 * @property {string}      clip_id     References ClipMeta.id
 * @property {number}      source_in   Trim-in within the source clip
 * @property {number}      source_out  Trim-out within the source clip
 * @property {Transition}  [transition] Transition that follows this segment
 */

/**
 * @typedef {Object} Keyframe
 * @property {number} t  Time in seconds (project-relative)
 * @property {number} v  Scalar value at this time
 * @property {('linear'|'easeIn'|'easeOut'|'easeInOut'|'spring'|'back')} [e]
 */

/**
 * @typedef {Object} LayerTiming
 * @property {number} in
 * @property {number} out
 */

/**
 * @typedef {Object} LayerPosition
 * @property {number} x
 * @property {number} y
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [rotation]   Degrees
 * @property {number} [opacity]    0..1
 * @property {number} [scale]      Multiplier (default 1)
 */

/**
 * @typedef {Object} Layer
 * @property {string}   id
 * @property {('text'|'logo'|'color'|'image')} type
 * @property {string}   [name]
 * @property {boolean}  [visible]
 * @property {boolean}  [locked]
 * @property {string}   [blend_mode]
 * @property {Object}   content
 * @property {LayerTiming}  timing
 * @property {LayerPosition} position
 * @property {{in_type?:string, out_type?:string}} [animation]
 * @property {Object<string, Keyframe[]>} [keyframes]   prop → ordered keyframes
 * @property {?string}  [tracking_id]   Optional motion-track parent
 */

/**
 * @typedef {Object} AudioPlan
 * @property {?string}  music_path
 * @property {number}   volume         0..1
 * @property {boolean}  fade_in
 * @property {boolean}  fade_out
 * @property {('mix'|'replace')} mix_mode
 * @property {number[]} [beat_anchors]
 */

/**
 * @typedef {Object} BrandKit
 * @property {string}  [agency_name]
 * @property {string}  [tagline]
 * @property {string}  [primary]   #rrggbb
 * @property {string}  [secondary]
 * @property {string}  [font]
 * @property {?string} [logo_path]
 */

/**
 * @typedef {Object} FxState
 * @property {('natural'|'cinematic'|'teal_orange'|'moody_dark'|'bright_airy'|'bw')} color_grade
 * @property {boolean} vignette
 * @property {boolean} film_grain
 * @property {boolean} letterbox
 */

/**
 * @typedef {Object} EditParams
 * @property {number}  duration
 * @property {('16:9'|'9:16'|'1:1')} aspect_ratio
 * @property {('slow'|'balanced'|'fast')} pacing
 * @property {string}  style_id
 */

/**
 * @typedef {Object} ProjectDocument  v1
 * @property {string}        schema
 * @property {1}             version
 * @property {string}        id
 * @property {string}        name
 * @property {string}        created_at      ISO timestamp
 * @property {string}        modified_at     ISO timestamp
 * @property {EditParams}    [edit_params]
 * @property {ClipMeta[]}    [clips]
 * @property {Segment[]}     [segments]
 * @property {Layer[]}       [layers]
 * @property {AudioPlan}     [audio]
 * @property {BrandKit}      [brand]
 * @property {?string}       [brand_id]
 * @property {FxState}       [fx]
 * @property {{in_mark:?number, out_mark:?number, current_time:number}} [playhead]
 * @property {Object}        [ai]
 */

/**
 * @typedef {Object} EditRequest
 *   Input contract for any edit-generating function (Magic Edit, AI planner...).
 * @property {number}  duration
 * @property {('16:9'|'9:16'|'1:1')} aspect_ratio
 * @property {('slow'|'balanced'|'fast')} pacing
 * @property {string}  style_id
 * @property {ClipMeta[]} clips
 * @property {?AudioPlan} music
 * @property {BrandKit}  brand
 */

/**
 * @typedef {Object} EditPlan
 *   Output contract for any edit-generating function.
 * @property {Segment[]} segments
 * @property {Layer[]}   layers
 * @property {AudioPlan} audio
 * @property {FxState}   fx
 */

// ============================================================
//   Validator
//   Hand-rolled, no external dependency. Mirrors project.schema.json.
//   Returns { valid, errors: string[] }.
// ============================================================

const HEX6_RE = /^#[0-9a-fA-F]{6}$/;

// Valid style_id values — mirrors schemas/project.schema.json. Update both
// when adding a new template. Matches every value editor.js writes to
// state.template (legacy + Magic Edit variants).
const KNOWN_STYLE_IDS = [
  'custom',
  'cinematic', 'real_estate', 'travel', 'social', 'corporate',
  're_drone_reveal', 're_property_tour', 're_listing_card', 're_agent_intro',
  'social_hook_reveal', 'social_listicle',
  'cinematic_three_act', 'kinetic_word_pop',
  'magic_cinematic', 'magic_luxury_re', 'magic_social_reel', 'magic_editorial',
  'magic_modern_luxury', 'magic_moody', 'magic_energetic', 'magic_corporate',
];

function pushErr(errors, path, msg) { errors.push(`${path}: ${msg}`); }

function checkType(v, types, errors, path) {
  const t = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
  if (!types.includes(t)) {
    pushErr(errors, path, `expected ${types.join('|')}, got ${t}`);
    return false;
  }
  return true;
}

function checkEnum(v, allowed, errors, path) {
  if (v == null) return true;
  if (!allowed.includes(v)) {
    pushErr(errors, path, `must be one of ${allowed.join(',')}`);
    return false;
  }
  return true;
}

function validateKeyframe(kf, path, errors) {
  if (!checkType(kf, ['object'], errors, path)) return;
  if (typeof kf.t !== 'number' || kf.t < 0) pushErr(errors, path + '.t', 'must be number ≥ 0');
  if (typeof kf.v !== 'number')              pushErr(errors, path + '.v', 'must be number');
  if (kf.e != null) checkEnum(kf.e, ['linear','easeIn','easeOut','easeInOut','spring','back'], errors, path + '.e');
}

function validateLayer(l, path, errors) {
  if (!checkType(l, ['object'], errors, path)) return;
  if (!l.id || typeof l.id !== 'string') pushErr(errors, path + '.id', 'required string');
  checkEnum(l.type, ['text','logo','color','image'], errors, path + '.type');
  if (!l.timing || typeof l.timing.in !== 'number' || typeof l.timing.out !== 'number') {
    pushErr(errors, path + '.timing', 'must have numeric in + out');
  }
  if (!l.position || typeof l.position !== 'object') {
    pushErr(errors, path + '.position', 'required object');
  } else {
    if (l.position.opacity != null && (l.position.opacity < 0 || l.position.opacity > 1))
      pushErr(errors, path + '.position.opacity', 'must be 0..1');
  }
  if (l.keyframes && typeof l.keyframes === 'object') {
    for (const [prop, arr] of Object.entries(l.keyframes)) {
      if (!Array.isArray(arr)) { pushErr(errors, `${path}.keyframes.${prop}`, 'must be array'); continue; }
      arr.forEach((kf, i) => validateKeyframe(kf, `${path}.keyframes.${prop}[${i}]`, errors));
    }
  }
}

function validateClip(c, path, errors) {
  if (!checkType(c, ['object'], errors, path)) return;
  if (!c.id || !/^clip_[A-Za-z0-9]+$/.test(c.id)) pushErr(errors, path + '.id', 'must match clip_*');
  if (!c.path || typeof c.path !== 'string')      pushErr(errors, path + '.path', 'required string');
  checkEnum(c.kind, ['video','image','audio'], errors, path + '.kind');
}

function validateSegment(s, path, errors) {
  if (!checkType(s, ['object'], errors, path)) return;
  if (!/^seg_[A-Za-z0-9]+$/.test(s.id || '')) pushErr(errors, path + '.id', 'must match seg_*');
  if (!/^clip_[A-Za-z0-9]+$/.test(s.clip_id || '')) pushErr(errors, path + '.clip_id', 'must match clip_*');
  if (typeof s.source_in !== 'number'  || s.source_in  < 0) pushErr(errors, path + '.source_in', 'number ≥ 0');
  if (typeof s.source_out !== 'number' || s.source_out < 0) pushErr(errors, path + '.source_out', 'number ≥ 0');
  if (s.transition && s.transition.type)
    checkEnum(s.transition.type, ['cut','xfade','fade','wipe','dip-to-black'], errors, path + '.transition.type');
}

/**
 * @param {ProjectDocument} doc
 * @returns {{valid:boolean, errors:string[]}}
 */
function validate(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return { valid: false, errors: ['document must be an object'] };
  if (doc.schema !== SCHEMA_URL)        pushErr(errors, 'schema', `must equal ${SCHEMA_URL}`);
  if (doc.version !== SCHEMA_VERSION)   pushErr(errors, 'version', `must equal ${SCHEMA_VERSION}`);
  if (!doc.id || typeof doc.id !== 'string')        pushErr(errors, 'id', 'required string');
  if (!doc.name || typeof doc.name !== 'string')    pushErr(errors, 'name', 'required string');
  if (!doc.created_at || typeof doc.created_at !== 'string')   pushErr(errors, 'created_at', 'required ISO string');
  if (!doc.modified_at || typeof doc.modified_at !== 'string') pushErr(errors, 'modified_at', 'required ISO string');

  if (doc.edit_params) {
    const ep = doc.edit_params;
    if (ep.aspect_ratio != null) checkEnum(ep.aspect_ratio, ['16:9','9:16','1:1'], errors, 'edit_params.aspect_ratio');
    if (ep.pacing != null)       checkEnum(ep.pacing,       ['slow','balanced','fast'], errors, 'edit_params.pacing');
    if (ep.style_id != null)     checkEnum(ep.style_id, KNOWN_STYLE_IDS, errors, 'edit_params.style_id');
  }
  if (Array.isArray(doc.clips))    doc.clips.forEach((c, i) => validateClip(c, `clips[${i}]`, errors));
  if (Array.isArray(doc.segments)) doc.segments.forEach((s, i) => validateSegment(s, `segments[${i}]`, errors));
  if (Array.isArray(doc.layers))   doc.layers.forEach((l, i) => validateLayer(l, `layers[${i}]`, errors));

  if (doc.audio) {
    if (doc.audio.volume != null && (doc.audio.volume < 0 || doc.audio.volume > 1))
      pushErr(errors, 'audio.volume', 'must be 0..1');
    if (doc.audio.mix_mode != null) checkEnum(doc.audio.mix_mode, ['mix','replace'], errors, 'audio.mix_mode');
  }
  if (doc.brand) {
    if (doc.brand.primary   && !HEX6_RE.test(doc.brand.primary))   pushErr(errors, 'brand.primary', 'must be #rrggbb');
    if (doc.brand.secondary && !HEX6_RE.test(doc.brand.secondary)) pushErr(errors, 'brand.secondary', 'must be #rrggbb');
  }
  if (doc.fx) {
    if (doc.fx.color_grade != null)
      checkEnum(doc.fx.color_grade, ['natural','cinematic','teal_orange','moody_dark','bright_airy','bw'], errors, 'fx.color_grade');
  }
  return { valid: errors.length === 0, errors };
}

// ============================================================
//   ID minting
// ============================================================
function rand(n=8) { return Math.random().toString(36).slice(2, 2 + n); }
const newClipId  = () => 'clip_'  + rand();
const newSegId   = () => 'seg_'   + rand();
const newLayerId = () => 'layer_' + rand();
const newProjId  = () => 'proj_'  + Date.now().toString(36) + '_' + rand(4);

const isoNow = () => new Date().toISOString();

// ============================================================
//   serialize(state) → ProjectDocument
//   Takes editor.js's runtime state (the global mutable bag) and
//   produces a v1 project document. Idempotent.
// ============================================================

/**
 * Ensure the runtime state has stable identifiers for the project, video,
 * audio. Mutates state (intentionally — this is a setup function, not a
 * serializer). Call this BEFORE serialize() if you want stable round-trips.
 *
 * Default doc.id resolution order:
 *   1. state._projectId (already set this session)
 *   2. state.project    (the project folder name — canonical)
 *   3. 'default'
 *
 * After this call, serialize() is pure: it only reads from state.
 */
function ensureProjectId(state) {
  if (!state._projectId) {
    state._projectId = state.project || 'default';
  }
  if (state.video && !state.video._docId)  state.video._docId  = newClipId();
  if (state.audio && !state.audio._docId)  state.audio._docId  = newClipId();
  return state._projectId;
}

function serialize(state, opts = {}) {
  const now = isoNow();
  // Pure read: never mints new ids here. Caller must ensureProjectId() first
  // if they want stable ones — otherwise a transient default is used.
  const projId = opts.projectId
              || state._projectId
              || state.project
              || 'default';
  const name = opts.name || state.brand?.agencyName || (state.template ? `${state.template} project` : 'Untitled project');

  /** @type {ClipMeta[]} */
  const clips = [];
  // Helper: register a video/image source clip once and return its id. The
  // schema requires a clip_id on every segment, so we deterministically derive
  // an id from the filename to keep round-trips stable.
  function registerClip(filename, kind, duration) {
    if (!filename) return null;
    let c = clips.find(x => x.path === filename);
    if (c) return c.id;
    const id = 'clip_' + filename.replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || newClipId();
    c = { id, path: filename, kind: kind || 'video', duration: duration || 0 };
    if (kind === 'video') c.aspect_ratio = state.aspect || '16:9';
    clips.push(c);
    return id;
  }

  // Skip optimistic in-flight segments (still on a blob: URL). They'll get
  // picked up by the next snapshot once the upload promotes them.
  const liveSegments = (state.segments || []).filter(s => s.filename && !s._local);
  for (const s of liveSegments) {
    registerClip(s.filename, s.kind || 'video', s._duration || 0);
  }
  // Legacy fallback: pre-segments projects only had state.video.
  if (!liveSegments.length && state.video && !state.video._local) {
    registerClip(state.video.filename, 'video', state.video.duration || 0);
  }
  if (state.audio) {
    clips.push({
      id:       state.audio._docId || ('clip_' + (state.audio.filename || 'audio').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'unknown'),
      path:     state.audio.filename,
      kind:     'audio',
      duration: state.audio.duration || 0,
    });
  }
  // Image clips referenced by logo or image overlay layers.
  for (const l of (state.layers || [])) {
    if ((l.type === 'logo' || l.type === 'image') && l.src) {
      if (!clips.some(c => c.path === l.src)) {
        clips.push({ id: newClipId(), path: l.src, kind: 'image' });
      }
    }
  }

  /** @type {Segment[]} */
  const segments = [];
  if (liveSegments.length) {
    for (const s of liveSegments) {
      const cid = registerClip(s.filename, s.kind || 'video', s._duration || 0);
      if (!cid) continue;
      // Map runtime transition types onto the schema's enum. Anything else
      // collapses to a hard cut so the saved doc still validates.
      const t = s.transition || { type: 'cut', duration: 0 };
      let ttype = (t.type || 'cut').toLowerCase();
      if (ttype === 'crossfade') ttype = 'xfade';
      if (ttype === 'fade_to_black' || ttype === 'fadeblack') ttype = 'dip-to-black';
      if (!['cut','xfade','fade','wipe','dip-to-black'].includes(ttype)) ttype = 'cut';
      segments.push({
        id:         s.id && /^seg_[A-Za-z0-9]+$/.test(s.id) ? s.id : newSegId(),
        clip_id:    cid,
        source_in:  +s.sourceIn  || 0,
        source_out: Math.max((+s.sourceIn || 0) + 0.05, +s.sourceOut || 0),
        transition: { type: ttype, duration: +t.duration || 0 },
      });
    }
  } else {
    // Legacy single-clip projects: synthesize one segment from state.video + marks.
    const videoClip = clips.find(c => c.kind === 'video');
    if (videoClip) {
      segments.push({
        id:         newSegId(),
        clip_id:    videoClip.id,
        source_in:  state.inMark  ?? 0,
        source_out: state.outMark ?? (videoClip.duration || 0),
        transition: { type: 'cut', duration: 0 },
      });
    }
  }

  /** @type {Layer[]} */
  // Skip layers still in optimistic upload phase (_local=true). Their `src`
  // points to the local file name, not the server one — persisting them
  // would 404 on reload. They'll be picked up by the next snapshot once
  // the upload completes and `_local` is cleared.
  const layers = (state.layers || []).filter(l => !l._local).map(l => layerToDoc(l));

  /** @type {ProjectDocument} */
  const doc = {
    schema:      SCHEMA_URL,
    version:     SCHEMA_VERSION,
    id:          projId,
    name,
    created_at:  state._created_at || now,
    modified_at: now,

    edit_params: {
      duration:     (state.outMark ?? state.video?.duration ?? 0) - (state.inMark ?? 0),
      aspect_ratio: state.aspect || '16:9',
      pacing:       state._pacing || 'balanced',
      style_id:     state.template || 'custom',
    },

    clips,
    segments,
    layers,

    audio: {
      music_path:   state.audio?.filename || null,
      volume:       (state.music?.volume ?? 60) / 100,
      fade_in:      !!state.music?.fadeIn,
      fade_out:     !!state.music?.fadeOut,
      mix_mode:     state.music?.mode || 'mix',
      beat_anchors: state.beats || [],
    },

    brand: {
      agency_name: state.brand?.agencyName || '',
      tagline:     state.brand?.tagline    || '',
      primary:     state.brand?.primary    || '#f0c040',
      secondary:   state.brand?.secondary  || '#1a1a1a',
      font:        state.brand?.font       || 'Syne',
      logo_path:   state.brand?.logoFile   || null,
    },

    fx: {
      color_grade: state.fx?.grade    || 'natural',
      vignette:    !!state.fx?.vignette,
      film_grain:  !!state.fx?.grain,
      letterbox:   !!state.letterbox,
    },

    playhead: {
      in_mark:      state.inMark  ?? null,
      out_mark:     state.outMark ?? null,
      current_time: 0,
    },
  };
  return doc;
}

function layerToDoc(l) {
  /** @type {Layer} */
  const out = {
    id:         l.id?.startsWith('layer_') ? l.id : ('layer_' + (l.id || rand())),
    type:       l.type,
    name:       l.name || '',
    visible:    l.visible !== false,
    locked:     !!l.locked,
    blend_mode: l.blendMode || 'source-over',
    timing:     { in: l.start ?? 0, out: l.end ?? 9999 },
    position: {
      x:        l.x ?? 0,
      y:        l.y ?? 0,
      width:    l.width  ?? 0,
      height:   l.height ?? 0,
      rotation: l.rotation ?? 0,
      opacity:  l.opacity ?? 1,
      scale:    1,
    },
    animation: {
      in_type:  l.animation || 'none',
      out_type: l.exit || 'auto',
    },
  };
  if (l.kf) {
    out.keyframes = {};
    for (const [prop, arr] of Object.entries(l.kf)) {
      out.keyframes[prop] = (arr || []).map(k => ({ t: k.t, v: k.v, e: k.e }));
    }
  }
  if (l.type === 'text') {
    out.content = {
      text:        l.text || '',
      font_family: l.fontFamily || 'Syne',
      font_size:   l.fontSize   || 64,
      font_weight: l.fontWeight || 700,
      color:       l.color      || '#ffffff',
      align:       l.align      || 'center',
    };
  } else if (l.type === 'logo' || l.type === 'image') {
    out.content = { src: l.src || null };
  } else if (l.type === 'color') {
    out.content = { color: l.color || '#000000' };
  }
  return out;
}

// ============================================================
//   deserialize(doc) → state
//   Returns an editor.js-compatible state object. Caller is
//   responsible for merging it into the live state.
// ============================================================

/**
 * Rebuild a runtime editor state from a project document.
 *
 * @param {ProjectDocument} doc
 * @param {string} [projectId]  The project folder name. Used to rebuild
 *                              logo image URLs (the doc only stores the
 *                              filename; the actual URL needs the folder
 *                              context). Defaults to doc.id.
 */
function deserialize(doc, projectId) {
  const v = validate(doc);
  if (!v.valid) {
    console.warn('[project-state] deserialize: validation issues', v.errors);
    // Continue best-effort. Strict callers should call validate() first.
  }
  const pid = projectId || doc.id || 'default';
  const layers = (doc.layers || []).map(L => docToLayer(L, pid));
  return {
    _projectId:  doc.id,
    _created_at: doc.created_at,
    template:    doc.edit_params?.style_id || 'custom',
    aspect:      doc.edit_params?.aspect_ratio || '16:9',
    inMark:      doc.playhead?.in_mark  ?? null,
    outMark:     doc.playhead?.out_mark ?? null,
    fx: {
      grade:    doc.fx?.color_grade || 'natural',
      vignette: !!doc.fx?.vignette,
      grain:    !!doc.fx?.film_grain,
    },
    letterbox: !!doc.fx?.letterbox,
    music: {
      volume:  Math.round(((doc.audio?.volume ?? 0.6) * 100)),
      fadeIn:  !!doc.audio?.fade_in,
      fadeOut: !!doc.audio?.fade_out,
      mode:    doc.audio?.mix_mode || 'mix',
    },
    beats: doc.audio?.beat_anchors || [],
    brand: {
      agencyName: doc.brand?.agency_name || '',
      tagline:    doc.brand?.tagline     || '',
      primary:    doc.brand?.primary     || '#f0c040',
      secondary:  doc.brand?.secondary   || '#1a1a1a',
      font:       doc.brand?.font        || 'Syne',
      logoFile:   doc.brand?.logo_path   || null,
      logoUrl:    null,
    },
    // Reconstruct runtime segments from the doc's segments + clips. The
    // multi-clip timeline reads state.segments; state.video tracks whichever
    // segment is currently active so the existing draw/inspector path works.
    segments: (() => {
      const docSegs = doc.segments || [];
      if (!docSegs.length) return [];
      const clipById = new Map((doc.clips || []).map(c => [c.id, c]));
      let cursor = 0;
      const out = [];
      for (const s of docSegs) {
        const clip = clipById.get(s.clip_id);
        if (!clip) continue;
        // Map schema transition names back to runtime names.
        const t = s.transition || { type: 'cut', duration: 0 };
        let rt = (t.type || 'cut').toLowerCase();
        if (rt === 'xfade') rt = 'crossfade';
        if (rt === 'dip-to-black') rt = 'fade_to_black';
        const sIn  = +s.source_in  || 0;
        const sOut = Math.max(sIn + 0.05, +s.source_out || 0);
        const dur  = sOut - sIn;
        const seg = {
          id: s.id, filename: clip.path, kind: clip.kind || 'video',
          url: pid ? ('/projects/' + encodeURIComponent(pid) + '/files/' + encodeURIComponent(clip.path)) : null,
          sourceIn: sIn, sourceOut: sOut,
          timelineIn: cursor, timelineOut: cursor + dur,
          transition: { type: rt, duration: +t.duration || 0 },
          _duration: clip.duration || dur,
        };
        out.push(seg);
        cursor = seg.timelineOut;
        const overlap = (rt === 'crossfade' || rt === 'xfade' || rt === 'fade'
                       || rt === 'fade_to_black' || rt === 'dip-to-black')
          ? Math.max(0, +t.duration || 0) : 0;
        cursor -= overlap;
      }
      return out;
    })(),
    video: (() => {
      // Pick the first video segment as the initially-active source so the
      // canvas has something to render on load.
      const seg = (doc.segments || []).find(s => {
        const clip = (doc.clips || []).find(c => c.id === s.clip_id);
        return clip && clip.kind === 'video';
      });
      if (seg) {
        const clip = (doc.clips || []).find(c => c.id === seg.clip_id);
        return clip ? { filename: clip.path, duration: clip.duration, _docId: clip.id } : null;
      }
      // Fallback for legacy docs that didn't write segments.
      const c = (doc.clips || []).find(x => x.kind === 'video');
      return c ? { filename: c.path, duration: c.duration, _docId: c.id } : null;
    })(),
    audio: (() => {
      const c = (doc.clips || []).find(x => x.kind === 'audio');
      return c ? { filename: c.path, duration: c.duration, _docId: c.id } : null;
    })(),
    layers,
  };
}

function docToLayer(L, projectId) {
  const out = {
    id:        L.id,
    type:      L.type,
    name:      L.name || '',
    visible:   L.visible !== false,
    locked:    !!L.locked,
    blendMode: L.blend_mode || 'source-over',
    start:     L.timing?.in  ?? 0,
    end:       L.timing?.out ?? 9999,
    x:         L.position?.x ?? 0,
    y:         L.position?.y ?? 0,
    width:     L.position?.width  ?? 0,
    height:    L.position?.height ?? 0,
    rotation:  L.position?.rotation ?? 0,
    opacity:   L.position?.opacity  ?? 1,
    animation: L.animation?.in_type  || 'none',
    exit:      L.animation?.out_type || 'auto',
  };
  if (L.keyframes) {
    out.kf = {};
    for (const [prop, arr] of Object.entries(L.keyframes)) {
      out.kf[prop] = (arr || []).map(k => ({ t: k.t, v: k.v, e: k.e }));
    }
  }
  if (L.type === 'text') {
    out.text       = L.content?.text         ?? '';
    out.fontFamily = L.content?.font_family  ?? 'Syne';
    out.fontSize   = L.content?.font_size    ?? 64;
    out.fontWeight = L.content?.font_weight  ?? 700;
    out.color      = L.content?.color        ?? '#ffffff';
    out.align      = L.content?.align        ?? 'center';
  } else if (L.type === 'logo' || L.type === 'image') {
    // Rebuild the runtime image so the canvas can draw it.
    // The doc stores only the filename; the URL is derived from the project's
    // file-serving route (/projects/<pid>/files/<filename>).
    out.src = L.content?.src || null;
    if (out.src && projectId) {
      const url = '/projects/' + encodeURIComponent(projectId)
                + '/files/'   + encodeURIComponent(out.src);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = url;
      // Trigger a redraw once the bytes land — the editor's loop already
      // re-paints continuously, so this is mostly defensive.
      img.onload = () => { try { window.MC?.editor?.draw?.(); } catch {} };
      out.url = url;
      out.img = img;
    } else {
      out.url = null;
      out.img = null;
    }
  } else if (L.type === 'color') {
    out.color = L.content?.color || '#000000';
  }
  return out;
}

// ============================================================
//   migrateLocal()
//   Reads pre-v1 leftovers from localStorage (theme/lang/project
//   pointers + per-project brand kit) and assembles them into a
//   v1 document. Used once when an old session is opened.
// ============================================================

function migrateLocal(currentEditorState) {
  const state = currentEditorState || {};
  // Pull brand kit from legacy localStorage if not already in state
  try {
    const projId = state.project || localStorage.getItem('mc-project') || 'default';
    const raw = localStorage.getItem('mc-brand-' + projId);
    if (raw && (!state.brand || !state.brand.agencyName)) {
      const b = JSON.parse(raw);
      state.brand = Object.assign({}, state.brand, b);
    }
  } catch {}
  return serialize(state);
}

// ============================================================
//   Network: save / load
// ============================================================

async function save(state, opts = {}) {
  // Make sure ids are stable before serializing
  ensureProjectId(state);
  const doc = serialize(state, opts);
  const v = validate(doc);
  if (!v.valid) throw new Error('Project document invalid: ' + v.errors.join('; '));

  const project = state.project || 'default';
  // Sanity check: doc.id should match the folder we're writing into.
  // If they diverge, something has minted a fresh id elsewhere — log it
  // so we can trace, but don't refuse the save (the file path uses `project`).
  if (doc.id !== project) {
    console.warn('[project-state] doc.id !== state.project',
                 { 'doc.id': doc.id, 'state.project': project });
  }

  const r = await fetch('/api/project/save', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ project, document: doc }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `save failed (${r.status})`);
  }
  return r.json();
}

async function load(projectId) {
  const r = await fetch('/api/project/load/' + encodeURIComponent(projectId));
  if (!r.ok) {
    if (r.status === 404) return null;
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `load failed (${r.status})`);
  }
  const data = await r.json();
  return data.document || null;
}

// ============================================================
//   Public API
// ============================================================

window.MC = window.MC || {};
window.MC.project = {
  SCHEMA_URL,
  SCHEMA_VERSION,
  validate,
  serialize,
  deserialize,
  ensureProjectId,
  migrateLocal,
  save,
  load,
  // ID factories exposed for AI features that mint segments / layers
  newClipId, newSegId, newLayerId, newProjId,
};

})();
