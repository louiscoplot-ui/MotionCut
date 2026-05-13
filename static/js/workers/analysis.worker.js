// MotionCut — audio analysis Web Worker.
// Establishes the worker pattern that Whisper / MediaPipe / ONNX features
// will follow in later sprints. Pure dedicated-worker JS, no module syntax,
// no external dependencies.
//
// Protocol (postMessage):
//   in : { type:"ANALYSE_AUDIO", payload:{ audioBuffer:ArrayBuffer, sampleRate } }
//        { type:"ANALYSE_PCM",   payload:{ pcm:Float32Array, sampleRate } }
//   out: { type:"PROGRESS",       pct }
//        { type:"BEATS_READY",    beats, fallback }
//        { type:"WAVEFORM_READY", waveform }     // 200-point peak-per-bin
//        { type:"ERROR",          message }

'use strict';

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'ANALYSE_AUDIO') {
      await analyseAudioBuffer(msg.payload || {});
    } else if (msg.type === 'ANALYSE_PCM') {
      analysePCM(msg.payload || {});
    } else {
      self.postMessage({ type: 'ERROR', message: 'unknown message type: ' + msg.type });
    }
  } catch (err) {
    self.postMessage({ type: 'ERROR', message: String((err && err.message) || err) });
  }
};

self.onerror = (e) => {
  self.postMessage({ type: 'ERROR', message: (e && e.message) || 'worker onerror' });
};

// ---------------------------------------------------------------------------
// Audio buffer decode path — only works when OfflineAudioContext is exposed
// in the Worker scope (Chrome 94+ in dedicated Worker, partial elsewhere).
// When it's not available, we post fallback:true and the main thread is
// expected to decode and re-post as ANALYSE_PCM.
// ---------------------------------------------------------------------------
async function analyseAudioBuffer({ audioBuffer, sampleRate }) {
  const Ctx = (typeof OfflineAudioContext !== 'undefined' && OfflineAudioContext)
           || (typeof webkitOfflineAudioContext !== 'undefined' && webkitOfflineAudioContext);
  if (!Ctx || !audioBuffer) {
    self.postMessage({ type: 'BEATS_READY', beats: [], fallback: true });
    return;
  }
  try {
    const sr = sampleRate || 48000;
    // Over-size the context — actual decoded length comes from the
    // returned AudioBuffer. 10 min upper bound is plenty for music here.
    const ctx = new Ctx(2, sr * 600, sr);
    const buf = await ctx.decodeAudioData(audioBuffer);
    analysePCM({ pcm: buf.getChannelData(0), sampleRate: buf.sampleRate });
  } catch (err) {
    // decodeAudioData not implemented in this Worker scope, or codec
    // unsupported — surface as fallback so the bridge can decode on main.
    self.postMessage({ type: 'BEATS_READY', beats: [], fallback: true });
  }
}

// ---------------------------------------------------------------------------
// Beat detection (energy-based, no external lib).
// 1) RMS over 512-sample windows
// 2) Exponential smoothing (alpha=0.1)
// 3) Peak if energy > local_mean * 1.5 AND distance > 0.3 s
// Also emits a 200-point peak-per-bin waveform alongside the beats.
// ---------------------------------------------------------------------------
function analysePCM({ pcm, sampleRate }) {
  if (!pcm || !pcm.length || !sampleRate) {
    self.postMessage({ type: 'BEATS_READY', beats: [], fallback: false });
    self.postMessage({ type: 'WAVEFORM_READY', waveform: new Array(200).fill(0) });
    return;
  }
  const win = 512;
  const n = Math.max(1, Math.floor(pcm.length / win));
  const energies = new Float32Array(n);
  const progressEvery = Math.max(1, Math.floor(n / 10));

  for (let i = 0; i < n; i++) {
    let sum = 0;
    const base = i * win;
    for (let j = 0; j < win; j++) {
      const s = pcm[base + j];
      sum += s * s;
    }
    energies[i] = Math.sqrt(sum / win);
    if (i % progressEvery === 0) {
      self.postMessage({ type: 'PROGRESS', pct: Math.round((i / n) * 60) });
    }
  }

  // Exponential smoothing — kills sub-window jitter.
  const smoothed = new Float32Array(n);
  let s = energies[0] || 0;
  const alpha = 0.1;
  for (let i = 0; i < n; i++) {
    s = s + alpha * (energies[i] - s);
    smoothed[i] = s;
  }

  // Local mean window ≈ 1 s on either side of the current frame.
  const meanWin = Math.max(1, Math.floor(sampleRate / win));
  const beats = [];
  const minGapSec = 0.3;
  let lastBeatTime = -Infinity;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - meanWin);
    const hi = Math.min(n, i + meanWin);
    let sum = 0;
    for (let k = lo; k < hi; k++) sum += smoothed[k];
    const mean = sum / (hi - lo);
    if (energies[i] > mean * 1.5) {
      const t = (i * win) / sampleRate;
      if (t - lastBeatTime >= minGapSec) {
        beats.push(+t.toFixed(3));
        lastBeatTime = t;
      }
    }
  }
  self.postMessage({ type: 'PROGRESS', pct: 80 });

  // 200-point peak-per-bin waveform for the result page canvas.
  const points = 200;
  const wf = new Array(points);
  const binSize = Math.max(1, Math.floor(pcm.length / points));
  for (let i = 0; i < points; i++) {
    let peak = 0;
    const start = i * binSize;
    const end = Math.min(pcm.length, start + binSize);
    for (let j = start; j < end; j++) {
      const a = pcm[j];
      const v = a < 0 ? -a : a;
      if (v > peak) peak = v;
    }
    wf[i] = peak;
  }

  self.postMessage({ type: 'PROGRESS', pct: 100 });
  self.postMessage({ type: 'BEATS_READY', beats, fallback: false });
  self.postMessage({ type: 'WAVEFORM_READY', waveform: wf });
}
