// MotionCut — MediaPipe face detection Web Worker.
// Reuses the dedicated-worker pattern from analysis.worker.js. Pulls the
// face_detection bundle from jsdelivr via importScripts(); if the bundle
// (or its WASM/Asset siblings) can't be reached we fall back to
// has_face:false so the generate pipeline never blocks.
//
// Protocol (postMessage):
//   in : { type:"DETECT_FACES", payload:{ frames:[ImageBitmap], width, height } }
//   out: { type:"FACE_RESULT", has_face, face_confidence, face_center, fallback }
//        { type:"PROGRESS",    pct }
//        { type:"ERROR",       message }
//
// `frames` are ImageBitmap instances transferred from the main thread —
// the main thread does the heavy decode (drawing a <video> frame to a
// canvas) and hands the bitmap to the Worker zero-copy.

'use strict';

const MEDIAPIPE_CDN_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/face_detection@0.4/';

let _detectorPromise = null;
let _libLoaded = false;

function ensureLib() {
  if (_libLoaded) return true;
  try {
    importScripts(MEDIAPIPE_CDN_BASE + 'face_detection.js');
    if (!self.FaceDetection) throw new Error('FaceDetection global missing');
    _libLoaded = true;
    return true;
  } catch (err) {
    self.postMessage({
      type: 'ERROR',
      message: 'mediapipe unavailable: ' + (err && err.message || err),
    });
    return false;
  }
}

async function getDetector() {
  if (_detectorPromise) return _detectorPromise;
  if (!ensureLib()) throw new Error('mediapipe unavailable');
  const Cls = self.FaceDetection;
  _detectorPromise = (async () => {
    const det = new Cls({
      // MediaPipe pulls its WASM + .tflite assets from the same dir as the
      // bundle. Pointing locateFile back at jsdelivr keeps everything CDN.
      locateFile: (file) => MEDIAPIPE_CDN_BASE + file,
    });
    det.setOptions({ model: 'short', minDetectionConfidence: 0.5 });
    // The MediaPipe Solution API requires an explicit initialize() before
    // the first send(). The library exposes it via .initialize() in 0.4.x.
    if (typeof det.initialize === 'function') await det.initialize();
    return det;
  })();
  return _detectorPromise;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type !== 'DETECT_FACES') {
      self.postMessage({ type: 'ERROR', message: 'unknown message: ' + msg.type });
      return;
    }
    const { frames, width, height } = msg.payload || {};
    if (!frames || !frames.length) {
      self.postMessage({ type: 'FACE_RESULT', has_face: false, face_confidence: 0,
                         face_center: null, fallback: false });
      return;
    }

    let det;
    try {
      det = await getDetector();
    } catch (libErr) {
      // CDN unreachable / CSP / WASM blocked — graceful fallback.
      self.postMessage({
        type: 'FACE_RESULT',
        has_face: false, face_confidence: 0, face_center: null,
        fallback: true,
      });
      return;
    }

    let bestConf = 0;
    let bestCenter = null;
    let detections = 0;
    for (let i = 0; i < frames.length; i++) {
      const bm = frames[i];
      // MediaPipe accepts an ImageBitmap directly via send({ image }).
      const results = await new Promise((resolve) => {
        det.onResults((res) => resolve(res));
        det.send({ image: bm }).then(() => {}, () => resolve(null));
      });
      const dets = (results && results.detections) || [];
      if (dets.length) {
        detections++;
        for (const d of dets) {
          const score = (d.score && d.score[0]) || 0;
          if (score > bestConf) {
            bestConf = score;
            // BoundingBox is normalised 0..1 in MediaPipe.
            const bb = d.boundingBox || {};
            if (typeof bb.xCenter === 'number' && typeof bb.yCenter === 'number') {
              bestCenter = { x: bb.xCenter, y: bb.yCenter };
            }
          }
        }
      }
      self.postMessage({ type: 'PROGRESS', pct: Math.round(((i + 1) / frames.length) * 100) });
    }

    self.postMessage({
      type: 'FACE_RESULT',
      has_face: detections > 0,
      face_confidence: +bestConf.toFixed(3),
      face_center: bestCenter,
      fallback: false,
    });
  } catch (err) {
    self.postMessage({ type: 'ERROR', message: String((err && err.message) || err) });
    self.postMessage({
      type: 'FACE_RESULT',
      has_face: false, face_confidence: 0, face_center: null, fallback: true,
    });
  }
};

self.onerror = (e) => {
  self.postMessage({ type: 'ERROR', message: (e && e.message) || 'worker onerror' });
};
