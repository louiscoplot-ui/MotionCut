// MotionCut — reusable Web Worker bridge.
// ES module so it can be `import`-ed from <script type="module">. The Worker
// files themselves stay plain (no module syntax) for maximum browser
// compatibility with `new Worker(url)`.
//
// Pattern:
//   const bridge = new WorkerBridge('/static/js/workers/analysis.worker.js');
//   bridge.on(msg => { ... });            // every message
//   bridge.send('ANALYSE_AUDIO', { ... }, [arrayBuffer]);   // transferables
//   const res = await bridge.wait(m => m.type === 'BEATS_READY');
//   bridge.terminate();

export class WorkerBridge {
  constructor(workerPath) {
    this.worker = new Worker(workerPath);
    this._listeners = new Set();
    this.worker.onmessage = (e) => {
      const data = e.data;
      this._listeners.forEach((fn) => {
        try { fn(data); } catch (_) {}
      });
    };
    this.worker.onerror = (e) => {
      // Surface as an ERROR message so wait()/on() consumers see the same
      // shape regardless of where the failure happened.
      const fake = { type: 'ERROR', message: (e && e.message) || 'worker error' };
      this._listeners.forEach((fn) => { try { fn(fake); } catch (_) {} });
    };
  }

  on(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  send(type, payload, transferables) {
    this.worker.postMessage({ type, payload }, transferables || []);
  }

  /** Resolve on the first message matching `predicate`. Rejects on ERROR or timeout. */
  wait(predicate, { timeout = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const unlisten = this.on((msg) => {
        if (msg && msg.type === 'ERROR') {
          if (timer) clearTimeout(timer);
          unlisten();
          reject(new Error(msg.message || 'worker error'));
          return;
        }
        if (predicate(msg)) {
          if (timer) clearTimeout(timer);
          unlisten();
          resolve(msg);
        }
      });
      if (timeout > 0) {
        timer = setTimeout(() => { unlisten(); reject(new Error('worker timeout')); }, timeout);
      }
    });
  }

  terminate() {
    try { this.worker.terminate(); } catch (_) {}
    this._listeners.clear();
  }
}
