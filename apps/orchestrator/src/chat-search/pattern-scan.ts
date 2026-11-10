import { Worker } from 'node:worker_threads';

/** What a scan found: for each message index, the [start, end) of the matches (at most MAX_PER_TEXT). */
export interface ScanResult {
  /** message index → matches */
  found: Map<number, [number, number][]>;
  /** the time ran out (nothing is returned: a partial answer would be misleading) */
  timedOut: boolean;
}

export const MAX_PER_TEXT = 20;

// The scan runs in a worker thread that is killed when the time is up: a pattern that backtracks for ever (`(a+)+$`) must never stop the server.
// The worker's code is a string so that it needs no file next to the build.
const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const { source, texts, max } = workerData;
const re = new RegExp(source, 'giu');
const found = [];
for (let i = 0; i < texts.length; i++) {
  re.lastIndex = 0;
  const ms = [];
  for (let m = re.exec(texts[i]); m && ms.length < max; m = re.exec(texts[i])) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    ms.push([m.index, m.index + m[0].length]);
  }
  if (ms.length) found.push([i, ms]);
}
parentPort.postMessage({ done: found });
`;

/** Runs the (already checked) pattern over the texts with a time limit. */
export function scanTexts(source: string, texts: string[], budgetMs: number): Promise<ScanResult> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_CODE, { eval: true, workerData: { source, texts, max: MAX_PER_TEXT } });
    const partial = new Map<number, [number, number][]>();
    let settled = false;
    const finish = (r: ScanResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ found: partial, timedOut: true }), budgetMs);
    worker.on('message', (m: { done?: [number, [number, number][]][] }) => {
      if (m.done) finish({ found: new Map(m.done), timedOut: false });
    });
    worker.on('error', () => finish({ found: partial, timedOut: true }));
    worker.on('exit', () => finish({ found: partial, timedOut: false }));
  });
}
