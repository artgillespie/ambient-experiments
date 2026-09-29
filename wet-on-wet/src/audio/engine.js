// The engine: voices → buses → Nebula → master. A plain object that runs in
// the AudioWorklet and in Node. Time only advances in process(); randomness is
// seeded, so the same seed renders the same piece.

import { rng, clamp, softclip } from './dsp.js';
import { PadVoice, FMVoice, Drone, Air, Bass } from './voices.js';
import { Nebula } from './nebula.js';
import { Composer } from './composer.js';

const MAX_BLOCK = 1024;

export class Engine {
  constructor({ sampleRate, seed = 1 }) {
    this.sr = sampleRate;
    this.seed = seed;
    this.r = rng(seed);
    const buf = () => new Float32Array(MAX_BLOCK);
    this.bus = { dL: buf(), dR: buf(), sL: buf(), sR: buf() };
    this.wL = buf(); this.wR = buf();
    this.pads = Array.from({ length: 10 }, () => new PadVoice(sampleRate, this.r));
    this.fm = Array.from({ length: 24 }, () => new FMVoice(sampleRate, this.r));
    this.drone = new Drone(sampleRate, this.r);
    this.air = new Air(sampleRate, this.r);
    this.bass = new Bass(sampleRate);
    this.reverb = new Nebula(sampleRate, seed + 101);
    this.events = [];
    this.time = 0;
    this.frames = 0;
    this.volume = 0.8; this.vol = 0;
    this.space = 0.58; // user macro: room size/decay
    this.wind = 0.18; // user macro: aeolian harp + noise sweep level
    this.hpL = 0; this.hpR = 0;
    this.peak = 0; this.rms = 0;
    this.padBright = 0.5;
    this.composer = new Composer(this, seed);
  }

  emit(ev) { ev.t = this.time; this.events.push(ev); if (this.events.length > 256) this.events.shift(); }

  // ---- called by the composer --------------------------------------------
  setPad(notes, { attack, release, bright }) {
    this.padBright = bright;
    const keep = new Set();
    for (const v of this.pads) {
      if (!v.active || v.released) continue;
      if (notes.includes(v.midi) && !keep.has(v.midi)) keep.add(v.midi);
      else v.release(release);
    }
    notes.forEach((m, i) => {
      if (keep.has(m)) return;
      const v = this.pads.find((p) => !p.active) || this.pads.reduce((a, b) => (a.env < b.env ? a : b));
      const pan = notes.length > 1 ? (i / (notes.length - 1)) * 1.4 - 0.7 : 0;
      v.start(m, { level: m < 57 ? 0.7 : 1, attack, bright, pan });
      this.emit({ k: 'pad', m, pan, attack });
    });
  }
  setDrone(midi, level) {
    const changed = Math.abs((this.droneMidi ?? -99) - midi) > 0;
    this.droneMidi = midi;
    this.drone.set(midi, level);
    if (changed) this.emit({ k: 'drone', m: midi });
  }
  tuneAir(midis) { this.air.tune(midis); }
  playBass(midi, opts) {
    if (this.bass.active) return false;
    this.bass.start(midi, opts);
    this.emit({ k: 'bass', m: midi, dur: opts.attack + opts.hold });
    return true;
  }
  setAirLevel(l) { this.air.setLevel(l); }

  playNote(midi, vel, inst, pan, extra) {
    let v = this.fm.find((x) => !x.active);
    if (!v) v = this.fm.reduce((a, b) => (a.amp < b.amp ? a : b));
    v.start(midi, vel, inst, clamp(pan, -1, 1));
    this.emit({ k: 'note', m: midi, v: vel, i: inst, p: pan, ...extra });
  }

  // ---- external control ---------------------------------------------------
  setVolume(v) { this.volume = clamp(v, 0, 1); }
  setSpace(s) { this.space = clamp(s, 0, 1); }
  setDensity(d) { this.composer.density = clamp(d, 0, 1); }
  setWind(v) { this.wind = clamp(v, 0, 1.5); }
  touch(x, y) { this.composer.touch(x, y); }

  status() {
    const c = this.composer;
    return { time: this.time, weather: c.weather, key: c.current && `${c.root} ${c.mode}`, chord: c.current?.name };
  }

  // ---- audio --------------------------------------------------------------
  process(L, R, n) {
    const { dL, dR, sL, sR } = this.bus;
    dL.fill(0, 0, n); dR.fill(0, 0, n); sL.fill(0, 0, n); sR.fill(0, 0, n);
    const c = this.composer;
    c.tick(this.time);
    const w = c.weather, s = this.space;

    // The room breathes with the weather; "space" scales it.
    this.reverb.set({
      size: 0.38 + 0.42 * s + 0.12 * w,
      warp: 0.45 + 0.3 * w,
      density: 0.72 + 0.2 * (1 - w),
      decay: 6 + 30 * s * s + 8 * w,
      damp: 3800 + 4200 * w,
      lowcut: 90 + 60 * (1 - s),
      modRate: 0.12 + 0.25 * w,
      modDepth: 3 + 6 * w,
      predelay: 20 + 50 * s,
      shimmer: 0.03 + 0.22 * Math.max(0, w - 0.35),
      width: 1,
    });

    const bright = clamp(this.padBright * 0.6 + w * 0.4, 0, 1);
    for (const p of this.pads) p.process(this.bus, n, bright, 0.7);
    for (const v of this.fm) v.process(this.bus, n, 0.95);
    this.drone.process(this.bus, n, 0.18);
    this.bass.process(this.bus, n, 0.12);
    this.air.process(this.bus, n, 0.9);

    const wL = this.wL, wR = this.wR;
    this.reverb.process(sL, sR, wL, wR, n);

    // Master: dry/wet sum, gentle fade-in and volume, DC block, soft limiter.
    const sr = this.sr;
    const volT = this.volume * this.volume * clamp(this.time / 6, 0, 1);
    const vk = 1 - Math.exp(-1 / (0.05 * sr));
    const hk = 1 - Math.exp(-6.283 * 18 / sr);
    const dry = 0.55, wet = 1.0, trim = 1.9;
    let vol = this.vol, hpL = this.hpL, hpR = this.hpR, peak = 0, sq = 0;
    for (let i = 0; i < n; i++) {
      vol += (volT - vol) * vk;
      let l = (dL[i] * dry + wL[i] * wet) * trim;
      let r = (dR[i] * dry + wR[i] * wet) * trim;
      hpL += (l - hpL) * hk; hpR += (r - hpR) * hk;
      l = (l - hpL) * vol; r = (r - hpR) * vol;
      l = limit(l); r = limit(r);
      L[i] = l; R[i] = r;
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > peak) peak = a;
      sq += l * l + r * r;
    }
    this.vol = vol; this.hpL = hpL; this.hpR = hpR;
    this.peak = peak;
    this.rms = Math.sqrt(sq / (2 * n));
    this.time += n / sr;
    this.frames += n;
  }
}

function limit(x) {
  const a = x < 0 ? -x : x;
  if (a <= 0.7) return x;
  const y = 0.7 + 0.28 * softclip((a - 0.7) / 0.28);
  return x < 0 ? -y : y;
}
