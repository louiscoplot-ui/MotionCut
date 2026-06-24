/* ================================================================
   MotionCut — ML-3: Real-Estate shot classifier (ONNX, browser worker)
   Plain Worker (no module syntax) to match the analysis/whisper/mediapipe
   pattern. Frames are extracted on the MAIN thread (shot-classify.js, via
   the shared frameUtil) and passed in as ImageBitmaps — worker-side video
   decode is not reliably supported, and this keeps one extraction path.

   Pipeline (when static/models/re-classifier.onnx is present):
     resize 224x224 -> ImageNet normalize -> ResNet ONNX -> softmax(4) ->
     majority vote across frames.

   STUB FALLBACK: when the model file is absent (HEAD 404) or onnxruntime-web
   fails to load, falls back to coarse heuristics from clip geometry/length.
   This is deliberately NOT machine learning — replace by dropping a trained
   re-classifier.onnx into static/models/.
   ================================================================ */
'use strict';

const CLASSES = ['drone', 'exterior', 'interior', 'detail'];
const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/ort.min.js';
const MODEL_URL = '/static/models/re-classifier.onnx';

let ort = null;
let session = null;
let triedLoad = false;

function loadORT() {
  if (ort) return ort;
  importScripts(ORT_CDN);
  ort = self.ort;
  return ort;
}

async function getSession() {
  if (session) return session;
  if (triedLoad) return null;
  triedLoad = true;
  try {
    const head = await fetch(MODEL_URL, { method: 'HEAD' });
    if (!head.ok) return null;             // model not provided -> heuristic
    loadORT();
    session = await ort.InferenceSession.create(MODEL_URL);
    return session;
  } catch (e) {
    return null;
  }
}

function preprocess(bitmap) {
  const c = new OffscreenCanvas(224, 224);
  const cx = c.getContext('2d');
  cx.drawImage(bitmap, 0, 0, 224, 224);
  const { data } = cx.getImageData(0, 0, 224, 224);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const out = new Float32Array(3 * 224 * 224);
  for (let i = 0; i < 224 * 224; i++) {
    for (let ch = 0; ch < 3; ch++) {
      const v = data[i * 4 + ch] / 255;
      out[ch * 224 * 224 + i] = (v - mean[ch]) / std[ch];
    }
  }
  return out;
}

function softmax(a) {
  const m = Math.max.apply(null, a);
  const e = a.map(x => Math.exp(x - m));
  const s = e.reduce((p, c) => p + c, 0) || 1;
  return e.map(x => x / s);
}

// STUB — coarse, non-ML. See header.
function heuristic(meta) {
  const width = (meta && meta.width) || 0;
  const duration = (meta && meta.duration) || 0;
  let shot_type, confidence = 0.4;
  if (width >= 3000) { shot_type = 'drone'; confidence = 0.5; }   // 4K source ~ aerial
  else if (duration > 8) { shot_type = 'exterior'; }
  else if (duration < 5) { shot_type = 'detail'; }
  else { shot_type = 'interior'; }
  return { shot_type, confidence, fallback: true };
}

self.onmessage = async (e) => {
  const { type, payload } = e.data || {};
  if (type !== 'CLASSIFY_CLIP') return;
  const { frames = [], clip_id, meta } = payload || {};
  try {
    const sess = await getSession();
    if (!sess) {
      self.postMessage(Object.assign({ type: 'CLASSIFICATION_RESULT', clip_id }, heuristic(meta)));
      return;
    }
    const votes = {};
    let best = 0;
    for (const bm of frames) {
      const input = preprocess(bm);
      const tensor = new ort.Tensor('float32', input, [1, 3, 224, 224]);
      const feeds = {};
      feeds[sess.inputNames[0]] = tensor;
      const out = await sess.run(feeds);
      const logits = Array.from(out[sess.outputNames[0]].data).slice(0, 4);
      const probs = softmax(logits);
      let mi = 0;
      for (let i = 1; i < 4; i++) if (probs[i] > probs[mi]) mi = i;
      votes[CLASSES[mi]] = (votes[CLASSES[mi]] || 0) + 1;
      best = Math.max(best, probs[mi]);
    }
    let shot_type = 'interior', cnt = -1;
    for (const k in votes) if (votes[k] > cnt) { cnt = votes[k]; shot_type = k; }
    self.postMessage({ type: 'CLASSIFICATION_RESULT', clip_id, shot_type, confidence: best, fallback: false });
  } catch (err) {
    self.postMessage(Object.assign({ type: 'CLASSIFICATION_RESULT', clip_id, error: String(err) }, heuristic(meta)));
  }
};
