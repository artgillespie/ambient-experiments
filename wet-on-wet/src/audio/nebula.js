// NEBULA — a vast, modulated feedback-delay-network reverb in the spirit of
// Valhalla Supermassive.
//
//   in ─► predelay ─► input diffusion (4 allpasses / side) ─┐
//          ▲                                                ▼
//          │     ┌──────────── 16 delay lines ◄── inject (±, Hadamard rows)
//          │     │  modulated Hermite read (sine + random walk per line)
//          │     │  allpass *inside* the loop (density: echoes → smear)
//          │     │  damping LP + low-cut HP, RT60 gain
//          │     └─► 16×16 Hadamard mix ─► write back (soft-clipped)
//          │                 │
//          │           taps ─┴─► L / R (orthogonal sign vectors) ─► out
//          └── shimmer: octave-up grain shifter on the output, fed back in
//
// Line lengths span shortest..longest where longest = size and the spread
// between them is "warp". Large sizes with low density are cascading delays;
// high density turns them into a cloud. Delay-length changes are slewed so
// moving "size" produces slow tape-like pitch drift instead of clicks.
//
// Parameters (all set via set({...}), smoothed internally):
//   size 0..1      longest line ≈ 50 ms .. 2.2 s
//   warp 0..1      spread between lines (0 = all similar, 1 = 1:4)
//   density 0..1   in-loop + input diffusion
//   decay  s       RT60, 0.5 .. 120
//   damp   Hz      in-loop lowpass
//   lowcut Hz      in-loop highpass
//   modRate Hz, modDepth ms
//   predelay ms, shimmer 0..0.35, width 0..1

import { rng, softclip, fcoef, TAU } from './dsp.js';

const N = 16;
const parity = (x) => { x ^= x >> 8; x ^= x >> 4; x ^= x >> 2; x ^= x >> 1; return x & 1; };
const had = (row, j) => (parity(row & j) ? -1 : 1);

class Allpass {
  constructor(len) { this.buf = new Float32Array(Math.max(1, len)); this.i = 0; }
  tick(x, g) {
    const b = this.buf, i = this.i;
    const d = b[i];
    const y = -g * x + d;
    b[i] = x + g * y;
    this.i = i + 1 >= b.length ? 0 : i + 1;
    return y;
  }
}

export const NEBULA_DEFAULTS = {
  size: 0.62, warp: 0.55, density: 0.8, decay: 16, damp: 6000, lowcut: 110,
  modRate: 0.22, modDepth: 5, predelay: 30, shimmer: 0.1, width: 1,
};

export class Nebula {
  constructor(sr, seed = 11) {
    this.sr = sr;
    const r = rng(seed);
    let M = 1; while (M < sr * 2.6) M <<= 1;
    this.M = M; this.mask = M - 1;
    this.buf = new Float32Array(N * M);
    this.w = 0;

    // Each line gets a position in the spread (shuffled so neighbours in the
    // Hadamard aren't neighbours in length) plus a fixed irrational-ish jitter.
    const order = Array.from({ length: N }, (_, i) => i);
    for (let i = N - 1; i > 0; i--) { const j = (r() * (i + 1)) | 0; [order[i], order[j]] = [order[j], order[i]]; }
    this.pos = new Float64Array(N);
    this.jit = new Float64Array(N);
    for (let j = 0; j < N; j++) { this.pos[j] = (order[j] + 0.3 + 0.4 * r()) / N; this.jit[j] = 1 + (r() - 0.5) * 0.06; }
    this.d = new Float64Array(N);
    this.dT = new Float64Array(N);
    this.g = new Float64Array(N);
    this.lp = new Float64Array(N);
    this.hp = new Float64Array(N);
    this.y = new Float64Array(N);

    // In-loop allpasses share one write index.
    let A = 1; while (A < sr * 0.08) A <<= 1;
    this.A = A; this.amask = A - 1; this.aw = 0;
    this.ap = new Float32Array(N * A);
    this.apLen = new Int32Array(N);
    for (let j = 0; j < N; j++) this.apLen[j] = Math.round((0.006 + 0.05 * ((j * 0.618034) % 1) * (0.8 + 0.4 * r())) * sr);

    // Modulation: a rotating phasor per line plus a slewed random walk.
    this.mc = new Float64Array(N); this.ms = new Float64Array(N);
    this.mrate = new Float64Array(N);
    this.rw = new Float64Array(N); this.rwT = new Float64Array(N);
    for (let j = 0; j < N; j++) {
      const ph = r() * TAU;
      this.mc[j] = Math.cos(ph); this.ms[j] = Math.sin(ph);
      this.mrate[j] = 0.55 + 0.9 * r();
      this.rwT[j] = r() * 2 - 1;
    }
    this.r = r;

    // Input / output sign vectors: distinct Hadamard rows are orthogonal, so
    // L and R stay decorrelated through the network.
    this.iL = new Float64Array(N); this.iR = new Float64Array(N);
    this.oL = new Float64Array(N); this.oR = new Float64Array(N);
    for (let j = 0; j < N; j++) {
      this.iL[j] = had(5, j); this.iR[j] = had(10, j);
      this.oL[j] = had(3, j); this.oR[j] = had(12, j);
    }

    const ms = (x) => Math.round(x * sr / 1000);
    this.difL = [4.771, 3.595, 12.73, 9.307].map((x) => new Allpass(ms(x)));
    this.difR = [5.311, 3.119, 13.93, 8.123].map((x) => new Allpass(ms(x)));

    let P = 1; while (P < sr * 0.6) P <<= 1; // stereo-interleaved: 0.3 s per side
    this.pre = new Float32Array(P); this.pmask = P - 1; this.pw = 0;

    // Shimmer: two-grain octave-up shifter.
    let S = 1; while (S < sr * 0.25) S <<= 1;
    this.sh = new Float32Array(S); this.smask = S - 1; this.sw = 0;
    this.sph = 0; this.shWin = Math.round(sr * 0.11);
    this.shHp = 0; this.shLp = 0; this.shFb = 0;

    this.p = { ...NEBULA_DEFAULTS };
    this.t = { ...NEBULA_DEFAULTS };
    this.first = true;
  }

  set(params) { Object.assign(this.t, params); }

  _control(n) {
    const sr = this.sr, p = this.p, t = this.t;
    // Parameter smoothing (block rate, ~0.5 s).
    const k = this.first ? 1 : 1 - Math.exp(-n / (0.5 * sr));
    for (const key in t) p[key] += (t[key] - p[key]) * k;

    const longest = (0.05 + p.size * p.size * 2.15) * sr;
    const spread = 1 + 3 * p.warp;
    for (let j = 0; j < N; j++) {
      let d = (longest * this.jit[j]) / Math.pow(spread, this.pos[j]);
      d = Math.min(Math.max(d, 64), this.M - 16 - (p.modDepth * 2e-3 * sr) - 4);
      this.dT[j] = d;
      if (this.first) this.d[j] = d;
      const loopLen = this.d[j] + this.apLen[j];
      this.g[j] = Math.pow(10, (-3 * loopLen) / (Math.max(0.3, p.decay) * sr));
      // Random-walk targets drift every now and then.
      if (this.r() < n / sr * 0.7) this.rwT[j] = this.r() * 2 - 1;
    }
    this.first = false;
  }

  /** Mono or stereo send in, stereo wet out (overwrites outL/outR). */
  process(inL, inR, outL, outR, n) {
    this._control(n);
    const sr = this.sr, p = this.p;
    const buf = this.buf, mask = this.mask, M = this.M;
    const ap = this.ap, amask = this.amask, A = this.A, apLen = this.apLen;
    const d = this.d, dT = this.dT, g = this.g, lp = this.lp, hp = this.hp, y = this.y;
    const mc = this.mc, ms = this.ms, rw = this.rw, rwT = this.rwT;
    const iL = this.iL, iR = this.iR, oL = this.oL, oR = this.oR;
    const difL = this.difL, difR = this.difR;
    const pre = this.pre, pmask = this.pmask;
    const sh = this.sh, smask = this.smask, shWin = this.shWin;

    const aLP = fcoef(p.damp, sr), aHP = fcoef(p.lowcut, sr);
    const gA = Math.min(0.72, p.density * 0.72);
    const gD = 0.35 + 0.35 * p.density;
    const depth = p.modDepth * 1e-3 * sr;
    const slew = 1 - Math.exp(-1 / (1.8 * sr));
    const rwk = 1 - Math.exp(-1 / (2.5 * sr));
    const preN = Math.max(1, Math.round(p.predelay * 1e-3 * sr));
    const shAmt = p.shimmer;
    const width = p.width;
    const inGain = 0.3, outGain = 0.3;
    // Per-line rotation for this block.
    const cr = this._cr || (this._cr = new Float64Array(N));
    const sn = this._sn || (this._sn = new Float64Array(N));
    for (let j = 0; j < N; j++) {
      const th = (TAU * p.modRate * this.mrate[j]) / sr;
      cr[j] = Math.cos(th); sn[j] = Math.sin(th);
    }

    let w = this.w, aw = this.aw, pw = this.pw, sw = this.sw, sph = this.sph;
    let shHp = this.shHp, shLp = this.shLp, shFb = this.shFb;

    for (let i = 0; i < n; i++) {
      // Predelay (stereo interleaved in one ring: even = L, odd = R).
      pre[(pw * 2) & pmask] = inL[i] + shFb;
      pre[(pw * 2 + 1) & pmask] = inR[i] + shFb;
      let xl = pre[((pw - preN) * 2) & pmask];
      let xr = pre[((pw - preN) * 2 + 1) & pmask];
      pw++;
      for (let a = 0; a < 4; a++) { xl = difL[a].tick(xl, gD); xr = difR[a].tick(xr, gD); }
      xl *= inGain; xr *= inGain;

      let sumL = 0, sumR = 0;
      for (let j = 0; j < N; j++) {
        // Modulator.
        const c = mc[j], s = ms[j];
        mc[j] = c * cr[j] - s * sn[j];
        ms[j] = s * cr[j] + c * sn[j];
        rw[j] += (rwT[j] - rw[j]) * rwk;
        d[j] += (dT[j] - d[j]) * slew;
        const dd = d[j] + depth * (1 + 0.7 * s + 0.3 * rw[j]);
        // Hermite read.
        const pos = w - dd;
        const ip = Math.floor(pos);
        const f = pos - ip;
        const o = j * M;
        const xm1 = buf[o + ((ip - 1) & mask)], x0 = buf[o + (ip & mask)];
        const x1 = buf[o + ((ip + 1) & mask)], x2 = buf[o + ((ip + 2) & mask)];
        const c1 = 0.5 * (x1 - xm1);
        const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
        const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
        let v = ((c3 * f + c2) * f + c1) * f + x0;
        // In-loop allpass.
        const ao = j * A;
        const ad = ap[ao + ((aw - apLen[j]) & amask)];
        const ya = -gA * v + ad;
        ap[ao + aw] = v + gA * ya;
        v = ya;
        // Damping + low cut.
        lp[j] += (v - lp[j]) * aLP;
        hp[j] += (lp[j] - hp[j]) * aHP;
        v = (lp[j] - hp[j]) * g[j];
        y[j] = v;
        sumL += oL[j] * v;
        sumR += oR[j] * v;
      }
      // Fast Walsh–Hadamard transform, normalised (1/4 for 16 points).
      for (let h = 1; h < N; h <<= 1) {
        for (let a = 0; a < N; a += h << 1) {
          for (let b = a; b < a + h; b++) {
            const u = y[b], v = y[b + h];
            y[b] = u + v; y[b + h] = u - v;
          }
        }
      }
      for (let j = 0; j < N; j++) {
        let v = y[j] * 0.25 + xl * iL[j] + xr * iR[j];
        if (v > 1.2 || v < -1.2) v = 1.2 * softclip(v / 1.2);
        buf[j * M + w] = v;
      }
      w = (w + 1) & mask;
      aw = (aw + 1) & amask;

      const mid = (sumL + sumR) * 0.5, side = (sumL - sumR) * 0.5 * width;
      const L = (mid + side) * outGain, R = (mid - side) * outGain;
      outL[i] = L; outR[i] = R;

      // Shimmer: write the wet mono, read two octave-up grains.
      sh[sw] = (L + R) * 0.5;
      sph += 1 / shWin;
      if (sph >= 1) sph -= 1;
      let sOut = 0;
      for (let hIdx = 0; hIdx < 2; hIdx++) {
        let ph = sph + hIdx * 0.5;
        if (ph >= 1) ph -= 1;
        const dl = 2 + shWin * (1 - ph);
        const rp = sw - dl;
        const ri = Math.floor(rp);
        const rf = rp - ri;
        const a0 = sh[ri & smask], a1 = sh[(ri + 1) & smask];
        const win = Math.sin(Math.PI * ph);
        sOut += (a0 + (a1 - a0) * rf) * win * win;
      }
      sw = (sw + 1) & smask;
      // Band-limit the shimmer (keeps it airy, never fizzy or boomy).
      shLp += (sOut - shLp) * 0.35;
      shHp += (shLp - shHp) * 0.03;
      shFb = (shLp - shHp) * shAmt * 4;
    }
    // Renormalise phasors (drift from repeated rotation).
    for (let j = 0; j < N; j++) {
      const m = 1 / Math.hypot(mc[j], ms[j]);
      mc[j] *= m; ms[j] *= m;
      if (Math.abs(lp[j]) < 1e-20) lp[j] = 0;
      if (Math.abs(hp[j]) < 1e-20) hp[j] = 0;
    }
    this.w = w; this.aw = aw; this.pw = pw & (pmask >> 1); this.sw = sw; this.sph = sph;
    this.shHp = shHp; this.shLp = shLp; this.shFb = shFb;
  }
}
