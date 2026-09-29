// Small DSP toolkit shared by the engine. No DOM, no WebAudio: runs in the
// AudioWorklet and in Node (tools/render.mjs) unchanged.

/** mulberry32: tiny seeded PRNG returning floats in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const TAU = Math.PI * 2;

/** Weighted choice: items [{w, ...}] or parallel arrays. */
export function pickWeighted(r, items, weights) {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += weights[i];
  let x = r() * sum;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i];
    if (x <= 0) return items[i];
  }
  return items[items.length - 1];
}

// Sine table, linearly interpolated (~-130 dB error).
const TBL = 4096;
const SIN = new Float32Array(TBL + 1);
for (let i = 0; i <= TBL; i++) SIN[i] = Math.sin((TAU * i) / TBL);
/** sin(2π p) for phase p in cycles. */
export function sinp(p) {
  p -= Math.floor(p);
  const x = p * TBL;
  const i = x | 0;
  const f = x - i;
  return SIN[i] + (SIN[i + 1] - SIN[i]) * f;
}

/** PolyBLEP residual for a unit-step discontinuity at phase 0. */
export function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

/** Cytomic/Simper trapezoidal state-variable filter. */
export class SVF {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.a1 = 1; this.a2 = 0; this.a3 = 0; this.k = 1; this.v1 = 0; }
  set(fc, q, sr) {
    const g = Math.tan((Math.PI * Math.min(fc, sr * 0.45)) / sr);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  /** Returns lowpass; bandpass is left in this.v1. */
  tick(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.v1 = v1;
    return v2;
  }
}

/** Paul Kellet's economy pink noise. */
export class Pink {
  constructor(r) { this.r = r; this.b0 = 0; this.b1 = 0; this.b2 = 0; }
  tick() {
    const w = this.r() * 2 - 1;
    this.b0 = 0.99765 * this.b0 + w * 0.099046;
    this.b1 = 0.963 * this.b1 + w * 0.2965164;
    this.b2 = 0.57 * this.b2 + w * 1.0526913;
    return (this.b0 + this.b1 + this.b2 + w * 0.1848) * 0.2;
  }
}

/** Smooth-ish saturation, unity slope at 0, bounded to ±1. */
export function softclip(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/** One-pole coefficient for a time constant in seconds. */
export const tcoef = (sec, sr) => 1 - Math.exp(-1 / Math.max(1e-5, sec * sr));
/** One-pole lowpass coefficient for a cutoff in Hz. */
export const fcoef = (hz, sr) => 1 - Math.exp((-TAU * hz) / sr);
