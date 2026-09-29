// Sound sources. Every voice adds into a bus: { dL, dR, sL, sR } where d* is
// the dry signal and s* the reverb send. Voices never allocate while playing.

import { mtof, sinp, blep, SVF, Pink, softclip, tcoef, clamp } from './dsp.js';

// ---------------------------------------------------------------------------
// PAD: three detuned PolyBLEP saws through a breathing lowpass, plus a pure
// sine body. Slow exponential swells; common tones can be held across chords.

export class PadVoice {
  constructor(sr, r) {
    this.sr = sr; this.r = r;
    this.active = false;
    this.ph = new Float64Array(4);
    this.f = new SVF(); this.fR = new SVF();
    this.env = 0; this.target = 0; this.coef = 0;
  }
  start(midi, { level = 1, attack = 7, bright = 0.5, pan = 0 } = {}) {
    const r = this.r;
    this.midi = midi;
    this.freq = mtof(midi);
    this.active = true; this.released = false;
    this.level = level; this.bright = bright; this.pan = pan;
    this.target = 1;
    this.coef = tcoef(attack / 3, this.sr);
    this.det = [0, 1 + (r() * 4 + 5) / 1731, 1 - (r() * 4 + 5) / 1731];
    for (let i = 0; i < 4; i++) this.ph[i] = r();
    this.lfoPh = r(); this.lfoRate = 0.03 + r() * 0.05;
    this.lfo2Ph = r(); this.lfo2Rate = 0.011 + r() * 0.02;
  }
  release(sec = 10) { this.released = true; this.target = 0; this.coef = tcoef(sec / 4, this.sr); }
  process(bus, n, bright, send) {
    if (!this.active) return;
    const sr = this.sr, f0 = this.freq;
    // Block-rate modulation.
    this.lfoPh += (this.lfoRate * n) / sr;
    this.lfo2Ph += (this.lfo2Rate * n) / sr;
    const breath = 0.78 + 0.22 * sinp(this.lfoPh);
    const openness = clamp(0.35 * this.bright + 0.65 * bright + 0.25 * sinp(this.lfo2Ph), 0, 1);
    const fc = Math.min(f0 * (1.2 + 7 * openness * openness) + 150, 9000);
    this.f.set(fc, 0.75, sr);
    this.fR.set(fc * 1.07, 0.75, sr);
    const dt0 = f0 / sr, dt1 = dt0 * this.det[1], dt2 = dt0 * this.det[2];
    const ph = this.ph;
    const gl = this.level * 0.05 * breath;
    const pl = 0.5 - this.pan * 0.4, pr = 0.5 + this.pan * 0.4;
    let env = this.env; const tgt = this.target, k = this.coef;
    const { dL, dR, sL, sR } = bus;
    for (let i = 0; i < n; i++) {
      env += (tgt - env) * k;
      let p0 = ph[0] + dt0; if (p0 >= 1) p0 -= 1; ph[0] = p0;
      let p1 = ph[1] + dt1; if (p1 >= 1) p1 -= 1; ph[1] = p1;
      let p2 = ph[2] + dt2; if (p2 >= 1) p2 -= 1; ph[2] = p2;
      const s0 = 2 * p0 - 1 - blep(p0, dt0);
      const s1 = 2 * p1 - 1 - blep(p1, dt1);
      const s2 = 2 * p2 - 1 - blep(p2, dt2);
      const body = sinp(p0) * 0.9;
      const l = this.f.tick(s0 * 0.5 + s1) + body;
      const rr = this.fR.tick(s0 * 0.5 + s2) + body;
      const a = env * gl;
      const oL = l * a * pl * 2, oR = rr * a * pr * 2;
      dL[i] += oL; dR[i] += oR;
      sL[i] += oL * send; sR[i] += oR * send;
    }
    this.env = env;
    if (this.released && env < 1e-4) this.active = false;
  }
}

// ---------------------------------------------------------------------------
// FM: two-operator bells / glass / felt / tine, stereo-detuned carriers so
// every strike slowly beats and shimmers.

export const FM_INST = {
  bell:  { ratio: 3.5,  index: 2.6, idxDecay: 1.1, ampDecay: 6.5, attack: 0.004, level: 0.55, p2: 0,    p2a: 0 },
  glass: { ratio: 2.0,  index: 1.3, idxDecay: 0.35, ampDecay: 4.2, attack: 0.002, level: 0.4, p2: 5.04, p2a: 0.18 },
  tine:  { ratio: 1.0,  index: 2.0, idxDecay: 0.3, ampDecay: 3.2, attack: 0.003, level: 0.6,  p2: 14.1, p2a: 0.05 },
  felt:  { ratio: 1.0,  index: 0.9, idxDecay: 0.7, ampDecay: 2.6, attack: 0.025, level: 0.75, p2: 2.0,  p2a: 0.12 },
  // A low felt-mallet strike: soft attack, long bloom, a touch of 3rd harmonic.
  deep:  { ratio: 1.0,  index: 1.1, idxDecay: 0.9, ampDecay: 5.0, attack: 0.012, level: 1.4,  p2: 3.0,  p2a: 0.1 },
};

export class FMVoice {
  constructor(sr, r) { this.sr = sr; this.r = r; this.active = false; this.age = 0; this.amp = 0; }
  start(midi, vel, inst, pan) {
    const sr = this.sr, P = FM_INST[inst];
    this.active = true; this.age = 0;
    this.f = mtof(midi);
    this.P = P;
    // Higher notes ring shorter, lower ones longer.
    const pitchK = clamp(Math.pow(2, -(midi - 72) / 30), 0.45, 1.8);
    this.amp = 0; this.peak = vel * P.level * 0.14;
    this.atkInc = 1 / Math.max(1, P.attack * sr);
    this.atk = 0;
    this.ampMul = Math.exp(-1 / (P.ampDecay * pitchK * sr));
    this.idx = P.index * (0.6 + 0.6 * vel);
    this.idxMul = Math.exp(-1 / (P.idxDecay * sr));
    this.p2a = P.p2a;
    this.p2Mul = Math.exp(-1 / (0.4 * sr));
    const cents = 1 + (0.6 + this.r() * 0.8) / 1731;
    this.fl = this.f * cents; this.fr = this.f / cents;
    this.pcl = 0; this.pcr = this.r(); this.pm = 0; this.pp2 = 0;
    this.pan = pan;
  }
  process(bus, n, send) {
    if (!this.active) return;
    const sr = this.sr, P = this.P;
    const dcl = this.fl / sr, dcr = this.fr / sr, dm = (this.f * P.ratio) / sr, dp2 = (this.f * P.p2) / sr;
    const pl = Math.sqrt(0.5 - this.pan * 0.5), pr = Math.sqrt(0.5 + this.pan * 0.5);
    let { pcl, pcr, pm, pp2, idx, atk, amp, p2a } = this;
    const peak = this.peak, idxMul = this.idxMul, ampMul = this.ampMul, atkInc = this.atkInc, p2Mul = this.p2Mul;
    const { dL, dR, sL, sR } = bus;
    for (let i = 0; i < n; i++) {
      if (atk < 1) { atk += atkInc; if (atk > 1) atk = 1; amp = atk * atk * peak; }
      else amp *= ampMul;
      pm += dm; if (pm >= 1) pm -= 1;
      pcl += dcl; if (pcl >= 1) pcl -= 1;
      pcr += dcr; if (pcr >= 1) pcr -= 1;
      pp2 += dp2; if (pp2 >= 1) pp2 -= 1;
      const mod = idx * 0.15915 * sinp(pm); // index in radians → cycles
      const extra = p2a * sinp(pp2);
      const l = (sinp(pcl + mod) + extra) * amp;
      const r = (sinp(pcr + mod) + extra) * amp;
      idx *= idxMul; p2a *= p2Mul;
      const oL = l * pl, oR = r * pr;
      dL[i] += oL; dR[i] += oR; sL[i] += oL * send; sR[i] += oR * send;
    }
    Object.assign(this, { pcl, pcr, pm, pp2, idx, atk, amp, p2a });
    this.age += n;
    if (atk >= 1 && amp < 2e-5) this.active = false;
  }
}

// ---------------------------------------------------------------------------
// DRONE: a gliding sine/fifth/octave organ, gently saturated, with a very
// slow tremolo. Mostly dry: the room already has enough low end.

export class Drone {
  constructor(sr, r) {
    this.sr = sr; this.r = r;
    this.freq = 0; this.target = 0; this.ph = [0, 0, 0, 0];
    this.level = 0; this.levelT = 0; this.trem = r();
  }
  set(midi, level) { this.target = mtof(midi); if (!this.freq) this.freq = this.target; this.levelT = level; }
  process(bus, n, send) {
    if (!this.freq) return;
    const sr = this.sr;
    const g = 1 - Math.exp(-n / (6 * sr));
    this.freq += (this.target - this.freq) * g;
    this.level += (this.levelT - this.level) * (1 - Math.exp(-n / (4 * sr)));
    this.trem += (0.07 * n) / sr;
    const lv = this.level * (0.8 + 0.2 * sinp(this.trem)) * 0.09;
    const f = this.freq, ph = this.ph;
    const d0 = f / sr, d1 = (f * 1.5 * 1.0006) / sr, d2 = (f * 2.0012) / sr, d3 = (f * 0.9994) / sr;
    const { dL, dR, sL, sR } = bus;
    for (let i = 0; i < n; i++) {
      ph[0] += d0; ph[1] += d1; ph[2] += d2; ph[3] += d3;
      if (ph[0] >= 1) ph[0] -= 1; if (ph[1] >= 1) ph[1] -= 1;
      if (ph[2] >= 1) ph[2] -= 1; if (ph[3] >= 1) ph[3] -= 1;
      const a = sinp(ph[0]) + 0.3 * sinp(ph[1]) + 0.18 * sinp(ph[2]);
      const b = sinp(ph[3]) + 0.3 * sinp(ph[1] + 0.25) + 0.18 * sinp(ph[2] + 0.5);
      const l = softclip(a * 0.9) * lv, r = softclip(b * 0.9) * lv;
      dL[i] += l; dR[i] += r; sL[i] += l * send; sR[i] += r * send;
    }
  }
}

// ---------------------------------------------------------------------------
// BASS: an occasional sub swell. Sine plus gentle 2nd/3rd harmonics (so it
// still speaks on small speakers), lowpassed and softly saturated, with a
// slow attack, a hold and a long release. Nearly dry: weight, not mud.

export class Bass {
  constructor(sr) {
    this.sr = sr; this.active = false; this.env = 0; this.ph = 0; this.lp = new SVF(); this.lpR = new SVF();
  }
  start(midi, { attack = 4, hold = 12, release = 8, level = 1 } = {}) {
    this.f = mtof(midi); this.active = true; this.t = 0;
    this.attack = attack; this.hold = hold; this.release = release; this.level = level;
    this.lp.set(220, 0.7, this.sr); this.lpR.set(235, 0.7, this.sr);
    this.vib = 0;
  }
  process(bus, n, send) {
    if (!this.active) return;
    const sr = this.sr, dt = n / sr;
    this.t += dt;
    // Envelope: raised-cosine in, hold, exponential out.
    const { t, attack, hold, release } = this;
    let target;
    if (t < attack) target = 0.5 - 0.5 * Math.cos((Math.PI * t) / attack);
    else if (t < attack + hold) target = 1;
    else target = Math.exp(-(t - attack - hold) / (release / 4));
    const env0 = this.env, env1 = target;
    if (t > attack + hold + release * 1.5) { this.active = false; this.env = 0; return; }
    this.vib += dt * 0.19;
    const f = this.f * (1 + 0.0015 * sinp(this.vib));
    const d = f / sr;
    const lv = this.level * 0.16;
    const { dL, dR, sL, sR } = bus;
    let ph = this.ph;
    for (let i = 0; i < n; i++) {
      ph += d; if (ph >= 1) ph -= 1;
      const e = env0 + ((env1 - env0) * i) / n;
      const x = sinp(ph) + 0.22 * sinp(2 * ph) + 0.08 * sinp(3 * ph + 0.1);
      const y = softclip(x * 0.85) * e * lv;
      const l = this.lp.tick(y), r = this.lpR.tick(y);
      dL[i] += l; dR[i] += r; sL[i] += l * send; sR[i] += r * send;
    }
    this.ph = ph; this.env = env1;
  }
}

// ---------------------------------------------------------------------------
// AIR: an aeolian harp. Pink noise through high-Q bandpasses tuned to chord
// tones, each with its own gusting amplitude, so the wind hums in key.

export class Air {
  constructor(sr, r, bands = 4) {
    this.sr = sr; this.r = r;
    this.noise = [new Pink(r), new Pink(r)];
    this.bands = Array.from({ length: bands }, (_, i) => ({
      f: new SVF(), fc: 1000, fcT: 1000, gust: 0, gustT: 0, pan: (i / (bands - 1)) * 2 - 1, q: 18,
    }));
    this.level = 0; this.levelT = 0;
    this.wash = new SVF(); this.washR = new SVF(); this.washPh = r();
  }
  tune(midis) { this.bands.forEach((b, i) => { b.fcT = mtof(midis[i % midis.length]); }); }
  setLevel(l) { this.levelT = l; }
  process(bus, n, send) {
    const sr = this.sr, r = this.r;
    this.level += (this.levelT - this.level) * (1 - Math.exp(-n / (3 * sr)));
    const glide = 1 - Math.exp(-n / (5 * sr));
    for (const b of this.bands) {
      b.fc += (b.fcT - b.fc) * glide;
      if (r() < (n / sr) * 0.25) b.gustT = Math.pow(r(), 2.2);
      b.gust += (b.gustT - b.gust) * (1 - Math.exp(-n / (2.5 * sr)));
      b.f.set(b.fc, b.q, sr);
    }
    this.washPh += (0.013 * n) / sr;
    const wc = 500 + 1800 * (0.5 + 0.5 * sinp(this.washPh));
    this.wash.set(wc, 0.9, sr); this.washR.set(wc * 1.13, 0.9, sr);
    const lv = this.level;
    if (lv < 1e-4) return;
    const bands = this.bands;
    const { dL, dR, sL, sR } = bus;
    for (let i = 0; i < n; i++) {
      const nl = this.noise[0].tick(), nr = this.noise[1].tick();
      let l = 0, rr = 0;
      for (let k = 0; k < bands.length; k++) {
        const b = bands[k];
        b.f.tick(k & 1 ? nr : nl);
        const v = b.f.v1 * b.gust * 0.9;
        l += v * (0.5 - b.pan * 0.45); rr += v * (0.5 + b.pan * 0.45);
      }
      this.wash.tick(nl); this.washR.tick(nr);
      l += this.wash.v1 * 0.05; rr += this.washR.v1 * 0.05;
      l *= lv; rr *= lv;
      dL[i] += l * 0.4; dR[i] += rr * 0.4; sL[i] += l * send; sR[i] += rr * send;
    }
  }
}
