// MotionCut — Whisper auto-caption Web Worker.
// Loads @xenova/transformers from CDN via importScripts, then runs the
// Xenova/whisper-tiny ONNX model entirely off the main thread. Model
// weights cache automatically via the browser Cache API (xenova lib
// handles this), so the ~75 MB hit happens only on first use.
//
// Protocol (postMessage):
//   in  : { type:"LOAD_MODEL" }
//         { type:"TRANSCRIBE", payload:{ pcm:Float32Array, sampleRate:16000, language } }
//   out : { type:"MODEL_PROGRESS",         pct, file? }
//         { type:"MODEL_READY",            cached:bool }
//         { type:"TRANSCRIPTION_PROGRESS", pct }
//         { type:"TRANSCRIPTION_READY",    segments, fallback }
//         { type:"ERROR",                  message }

'use strict';

const TRANSFORMERS_CDN =
  'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.0/dist/transformers.min.js';
const MODEL_ID = 'Xenova/whisper-tiny';

let _pipelinePromise = null;   // memoised pipeline() result
let _libLoaded = false;        // importScripts ran successfully?

function ensureLib() {
  if (_libLoaded) return true;
  try {
    importScripts(TRANSFORMERS_CDN);
    // After importScripts(), the library exposes itself on the worker
    // global scope as `self` properties.
    if (!self.transformers && !self.pipeline) {
      throw new Error('transformers global missing');
    }
    _libLoaded = true;
    return true;
  } catch (err) {
    self.postMessage({
      type: 'ERROR',
      message: 'transformers.js unavailable: ' + (err && err.message || err),
    });
    return false;
  }
}

function getLib() {
  // Different transformers builds expose either { pipeline, env } directly
  // on `self` or under `self.transformers`. Cover both.
  const root = self.transformers || self;
  return { pipeline: root.pipeline, env: root.env };
}

async function loadPipeline() {
  if (_pipelinePromise) return _pipelinePromise;
  if (!ensureLib()) throw new Error('transformers.js unavailable');
  const { pipeline, env } = getLib();
  if (!pipeline) throw new Error('pipeline() not found in transformers');
  // Force CDN-only — we have no local /models server route.
  if (env) {
    env.allowLocalModels = false;
    env.useBrowserCache  = true;
  }
  _pipelinePromise = pipeline('automatic-speech-recognition', MODEL_ID, {
    quantized: true,        // q8 onnx — keeps the download near ~40-75 MB
    progress_callback: (p) => {
      if (!p) return;
      // p.status: 'initiate' | 'download' | 'progress' | 'done' | 'ready'
      if (p.status === 'progress' && p.progress != null) {
        self.postMessage({
          type: 'MODEL_PROGRESS',
          pct: Math.round(p.progress),
          file: p.file || null,
        });
      }
    },
  });
  return _pipelinePromise;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'LOAD_MODEL') {
      await loadPipeline();
      self.postMessage({ type: 'MODEL_READY', cached: false });
    } else if (msg.type === 'TRANSCRIBE') {
      const { pcm, sampleRate, language } = msg.payload || {};
      if (!pcm || !pcm.length) {
        self.postMessage({ type: 'TRANSCRIPTION_READY', segments: [], fallback: false });
        return;
      }
      const pipe = await loadPipeline();
      self.postMessage({ type: 'TRANSCRIPTION_PROGRESS', pct: 15 });
      const opts = {
        return_timestamps: true,
        chunk_length_s:    30,
        stride_length_s:   5,
      };
      if (language && language !== 'auto') {
        opts.language = language;
        opts.task = 'transcribe';
      }
      const result = await pipe(pcm, opts);
      self.postMessage({ type: 'TRANSCRIPTION_PROGRESS', pct: 90 });
      // result.chunks: [{ text, timestamp:[start,end] }] when return_timestamps.
      const chunks = (result && result.chunks) || [];
      const segments = chunks
        .map((c) => {
          const [s, e2] = c.timestamp || [null, null];
          return {
            start: typeof s === 'number' ? s : 0,
            end:   typeof e2 === 'number' ? e2 : (s || 0) + 2,
            text:  (c.text || '').trim(),
          };
        })
        .filter((seg) => seg.text);
      self.postMessage({ type: 'TRANSCRIPTION_READY', segments, fallback: false });
    } else {
      self.postMessage({ type: 'ERROR', message: 'unknown message type: ' + msg.type });
    }
  } catch (err) {
    // Network failure, CSP block, OOM, … — surface as fallback so the
    // generate pipeline can continue without captions.
    const message = String((err && err.message) || err);
    console.warn('[whisper.worker] error:', message);
    self.postMessage({ type: 'TRANSCRIPTION_READY', segments: [], fallback: true });
    self.postMessage({ type: 'ERROR', message });
  }
};

self.onerror = (e) => {
  self.postMessage({
    type: 'ERROR',
    message: (e && e.message) || 'worker onerror',
  });
};
