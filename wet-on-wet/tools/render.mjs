// Offline render + stats. The engine is plain JS, so it runs here unchanged.
//   node tools/render.mjs [--secs 180] [--seed 1] [--out out/render.wav] [--ir]
// --ir renders the Nebula impulse response instead and reports its decay.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Engine } from '../src/audio/engine.js';
import { Nebula } from '../src/audio/nebula.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? true : all[i + 1]] : null).filter(Boolean));
const sr = 48000, B = 128;
const secs = +(args.secs ?? 180);
const out = args.out ?? (args.ir ? 'out/ir.wav' : 'out/render.wav');

function wav(path, L, R) {
  const n = L.length, data = Buffer.alloc(44 + n * 4);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 4, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22);
  data.writeUInt32LE(sr, 24); data.writeUInt32LE(sr * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}
const db = (x) => (20 * Math.log10(x + 1e-12)).toFixed(1);

const total = Math.round(secs * sr);
const L = new Float32Array(total), R = new Float32Array(total);
const bl = new Float32Array(B), br = new Float32Array(B);
const t0 = performance.now();

if (args.ir) {
  const rv = new Nebula(sr, 5);
  const p = { size: +(args.size ?? 0.6), decay: +(args.decay ?? 8), density: +(args.density ?? 0.8), shimmer: +(args.shimmer ?? 0), modDepth: 4, predelay: 10 };
  rv.set(p);
  const iL = new Float32Array(B), iR = new Float32Array(B);
  for (let i = 0; i < total; i += B) {
    iL.fill(0); iR.fill(0);
    if (i === 0) { iL[0] = 1; iR[0] = 1; }
    rv.process(iL, iR, bl, br, B);
    L.set(bl.subarray(0, Math.min(B, total - i)), i); R.set(br.subarray(0, Math.min(B, total - i)), i);
  }
  console.log('params', p);
  // Energy decay curve (Schroeder), report -60 dB time.
  const e = new Float64Array(total);
  let acc = 0;
  for (let i = total - 1; i >= 0; i--) { acc += L[i] * L[i] + R[i] * R[i]; e[i] = acc; }
  const at = (dbv) => { for (let i = 0; i < total; i++) if (10 * Math.log10(e[i] / e[0]) < dbv) return (i / sr).toFixed(2); return '>' + secs; };
  console.log(`EDC: -10dB ${at(-10)}s  -20dB ${at(-20)}s  -30dB ${at(-30)}s  (RT60≈2×T30)`);
  let corr = 0, pl = 0, pr = 0;
  for (let i = 0; i < total; i++) { corr += L[i] * R[i]; pl += L[i] * L[i]; pr += R[i] * R[i]; }
  console.log('L/R correlation', (corr / Math.sqrt(pl * pr)).toFixed(3), ' total energy', db(Math.sqrt(pl + pr)), 'dB');
} else {
  const eng = new Engine({ sampleRate: sr, seed: +(args.seed ?? 1) });
  if (args.space) eng.setSpace(+args.space);
  const win = sr * 10;
  let wPeak = 0, wSq = 0, wN = 0;
  const kinds = {};
  for (let i = 0; i < total; i += B) {
    eng.process(bl, br, B);
    for (let j = 0; j < B && i + j < total; j++) {
      L[i + j] = bl[j]; R[i + j] = br[j];
      const a = Math.max(Math.abs(bl[j]), Math.abs(br[j]));
      if (!Number.isFinite(a)) { console.error('NaN at', (i + j) / sr); process.exit(1); }
      if (a > wPeak) wPeak = a;
      wSq += bl[j] * bl[j] + br[j] * br[j]; wN += 2;
      if ((i + j + 1) % win === 0) {
        const c = eng.composer;
        console.log(`${String(((i + j + 1) / sr) | 0).padStart(4)}s  peak ${db(wPeak).padStart(6)} dB  rms ${db(Math.sqrt(wSq / wN)).padStart(6)} dB  weather ${c.weather.toFixed(2)}  ${c.current?.name ?? ''} (${c.current ? c.mode : ''})`);
        wPeak = 0; wSq = 0; wN = 0;
      }
    }
    for (const ev of eng.events) kinds[ev.k + (ev.i ? ':' + ev.i : '')] = (kinds[ev.k + (ev.i ? ':' + ev.i : '')] || 0) + 1;
    eng.events.length = 0;
  }
  console.log('events', kinds);
}
const took = (performance.now() - t0) / 1000;
console.log(`rendered ${secs}s in ${took.toFixed(1)}s  (realtime ×${(secs / took).toFixed(1)})`);
wav(out, L, R);
console.log('wrote', out);
