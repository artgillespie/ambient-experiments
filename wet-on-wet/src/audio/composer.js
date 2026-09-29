// The composer: slow modal harmony, voice-led pads, and Eno-style tape loops.
//
// Harmony walks a weighted chord graph inside a mode, lingering 18–45 s per
// chord, and every few chords may modulate (up/down a fifth, relative or
// parallel mode). Loops have fixed, mutually incommensurate periods and
// store *scale degrees relative to the current chord*, so a loop keeps its
// rhythmic identity forever while its pitches are re-coloured by harmony.
// A slow "weather" macro (0..1) sets activity, brightness and the room.

import { rng, pickWeighted, clamp } from './dsp.js';

export const MODES = {
  lydian: [0, 2, 4, 6, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
};
const MODE_NAMES = Object.keys(MODES);
const MODE_W = [3, 2, 1, 2.5, 2];
export const NOTE_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
// Semitones from each mode's tonic down to its parent major scale.
const PARENT = { lydian: 5, ionian: 0, mixolydian: 7, dorian: 2, aeolian: 9 };
const DEGREE_W = [3, 1.6, 1, 3, 1.3, 2.6, 0.4];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

const mod = (a, b) => ((a % b) + b) % b;

export class Composer {
  constructor(engine, seed) {
    this.e = engine;
    this.r = rng(seed * 7919 + 13);
    const r = this.r;
    this.root = (r() * 12) | 0;
    this.mode = pickWeighted(r, MODE_NAMES, MODE_W);
    this.degree = 0;
    this.chordsInKey = 0;
    this.nextChordAt = 0;
    this.pad = [];
    this.queue = []; // [{at, midi, vel, inst, pan}]
    this.density = 0.47; // user bias (the "weather" slider)
    this.phaseW = [r() * 6.28, r() * 6.28, r() * 6.28];
    this.makeLoops();
    this.nextPhraseAt = 55 + r() * 40;
    this.nextFlurryAt = 80 + r() * 60;
    this.nextBassAt = 40 + r() * 50; // earliest time the low end may return
    this.weather = 0.3;
  }

  get scale() { return MODES[this.mode]; }

  /** Spell with flats in flat keys (F, B♭, E♭, A♭, D♭ parents), else sharps. */
  name(pc) {
    const parent = mod(this.root - PARENT[this.mode], 12);
    return ([5, 10, 3, 8, 1].includes(parent) ? NOTE_NAMES : SHARP_NAMES)[pc];
  }

  /** MIDI note of scale degree `deg` (may exceed 0..6) in octave `oct`. */
  degMidi(deg, oct) {
    const s = this.scale;
    return 12 * oct + this.root + s[mod(deg, 7)] + 12 * Math.floor(deg / 7);
  }
  pcOf(deg) { return mod(this.root + this.scale[mod(deg, 7)], 12); }

  /** Pitch at `pc` closest to `center`. */
  static near(pc, center) {
    const base = center - mod(center - pc, 12);
    return center - base > 6 ? base + 12 : base;
  }

  isDiminished(deg) {
    const s = this.scale;
    const iv = (a, b) => mod(s[mod(deg + b, 7)] - s[mod(deg + a, 7)], 12);
    return iv(0, 4) !== 7;
  }

  makeLoops() {
    const r = this.r;
    const insts = ['bell', 'glass', 'felt', 'bell', 'tine', 'glass', 'felt'];
    const centers = { bell: 74, glass: 86, felt: 64, tine: 69 };
    const degs = [0, 2, 4, 0, 2, 4, 1, 5, 6, 7];
    this.loops = insts.map((inst, i) => {
      const period = 13 + i * 4.3 + r() * 6.1;
      const count = 1 + ((r() * (inst === 'glass' ? 2 : 3)) | 0);
      const events = [];
      let at = r() * 1.5;
      for (let k = 0; k < count; k++) {
        events.push({ at, deg: degs[(r() * degs.length) | 0], vel: 0.35 + r() * 0.5 });
        at += 0.6 + r() * (inst === 'glass' ? 1.2 : 3.2);
      }
      return {
        inst, period, events, idx: 0,
        center: centers[inst] + ((r() * 7) | 0) - 3,
        pan: (r() * 2 - 1) * 0.8,
        affinity: 0.4 + r() * 0.6,
        enterAt: 6 + i * 9 + r() * 14,
        cycleStart: 0,
      };
    });
    for (const L of this.loops) L.cycleStart = L.enterAt;
  }

  /** Weather: layered slow sines, 0..1. Deterministic in time. */
  weatherAt(t) {
    const [a, b, c] = this.phaseW;
    const w = 0.5 + 0.28 * Math.sin((t / 181) * 6.283 + a) + 0.14 * Math.sin((t / 73) * 6.283 + b) + 0.06 * Math.sin((t / 31) * 6.283 + c);
    const intro = clamp(t / 90, 0, 1);
    return clamp((w + (this.density - 0.5) * 0.6) * (0.4 + 0.6 * intro), 0, 1);
  }

  chord() {
    const r = this.r, d = this.degree;
    const degs = [d, d + 2, d + 4];
    const roll = r();
    if (roll < 0.14) degs[1] = d + 1; // sus2
    else if (roll < 0.22) degs[1] = d + 3; // sus4
    if (r() < 0.55) degs.push(d + 6); // 7th
    if (r() < 0.6) degs.push(d + 8); // 9th
    const pcs = [...new Set(degs.map((x) => this.pcOf(x)))];
    return { degs, pcs, rootPc: this.pcOf(d), name: this.chordName(degs) };
  }

  chordName(degs) {
    const rt = this.pcOf(degs[0]);
    const has = (iv) => degs.some((x) => mod(this.pcOf(x) - rt, 12) === iv);
    let q = '';
    if (has(4)) q = has(11) ? 'maj7' : has(10) ? '7' : '';
    else if (has(3)) q = has(10) ? 'm7' : has(11) ? 'm(maj7)' : 'm';
    else q = has(2) ? 'sus2' : 'sus4';
    if (has(2) && (has(4) || has(3))) q = q.endsWith('7') ? q.replace('7', '9') : q + 'add9';
    return this.name(rt) + q;
  }

  voiceLead(pcs) {
    const prev = this.pad.length ? this.pad : [55, 62, 67, 71];
    const lo = 50, hi = 79;
    const cands = [];
    for (let m = lo; m <= hi; m++) if (pcs.includes(m % 12)) cands.push(m);
    const out = [];
    const used = new Set();
    for (const p of prev) {
      let best = null, bd = 1e9;
      for (const c of cands) {
        if (out.includes(c)) continue;
        const dist = Math.abs(c - p) + (used.has(c % 12) ? 5 : 0);
        if (dist < bd) { bd = dist; best = c; }
      }
      if (best != null) { out.push(best); used.add(best % 12); }
    }
    for (const pc of pcs) {
      if (used.has(pc) || out.length >= 5) continue;
      out.push(Composer.near(pc, 66)); used.add(pc);
    }
    out.sort((a, b) => a - b);
    // No close intervals in the lower register (keeps the pad clear).
    for (let i = 1; i < out.length; i++) if (out[i] < 62 && out[i] - out[i - 1] < 3) out[i] += 12;
    return [...new Set(out)].sort((a, b) => a - b).slice(0, 5);
  }

  nextChord(t) {
    const r = this.r;
    // Maybe modulate.
    if (this.chordsInKey >= 4 && r() < 0.35) {
      const k = r();
      if (k < 0.3) this.root = mod(this.root + 7, 12);
      else if (k < 0.55) this.root = mod(this.root + 5, 12);
      else if (k < 0.8) {
        // Relative mode: same notes, new tonic.
        const nm = pickWeighted(r, MODE_NAMES, MODE_W);
        const from = MODES[this.mode];
        const to = MODES[nm];
        // find tonic t' such that pcs(t', nm) == pcs(root, mode)
        const set = from.map((x) => mod(x + this.root, 12)).sort((a, b) => a - b).join();
        for (let t2 = 0; t2 < 12; t2++) {
          if (to.map((x) => mod(x + t2, 12)).sort((a, b) => a - b).join() === set) { this.root = t2; this.mode = nm; break; }
        }
      } else this.mode = pickWeighted(r, MODE_NAMES, MODE_W);
      this.degree = 0;
      this.chordsInKey = 0;
    } else {
      const opts = [], ws = [];
      for (let d = 0; d < 7; d++) {
        if (d === this.degree || this.isDiminished(d)) continue;
        opts.push(d); ws.push(DEGREE_W[d]);
      }
      this.degree = this.chordsInKey === 0 && t < 1 ? 0 : pickWeighted(r, opts, ws);
      this.chordsInKey++;
    }
    const ch = this.chord();
    this.current = ch;
    const w = this.weather;

    // Pads: hold common tones, release the rest, swell in the new ones.
    const notes = this.voiceLead(ch.pcs);
    this.e.setPad(notes, { attack: 6 + r() * 6, release: 9 + r() * 6, bright: 0.25 + w * 0.6 });
    this.pad = notes;

    // Drone: pedal on the tonic, or follow the chord root.
    const pedal = r() < 0.5 || this.degree === 0;
    const dpc = pedal ? this.root : ch.rootPc;
    this.e.setDrone(Composer.near(dpc, 36) + (Composer.near(dpc, 36) < 31 ? 12 : 0), 0.55 + 0.35 * (1 - w));

    // Aeolian harp tuned to chord tones up high.
    this.e.tuneAir(ch.pcs.map((pc, i) => Composer.near(pc, 84 + (i % 2) * 7)));

    const dur = (18 + r() * 22) * (1.25 - 0.5 * w);
    this.nextChordAt = t + dur;

    // Low end, now and then: a sub swell under the new chord, sometimes
    // announced by a deep mallet strike. Rare enough to feel like an event.
    if (t >= this.nextBassAt && r() < 0.35 + 0.35 * w) {
      let bm = Composer.near(ch.rootPc, 34);
      if (bm < 28) bm += 12;
      const hold = dur * (0.45 + 0.35 * r());
      if (this.e.playBass(bm, { attack: 3 + r() * 4, hold, release: 7 + r() * 6, level: 0.75 + 0.35 * w })) {
        if (r() < 0.45) this.e.playNote(bm + 12, 0.55 + 0.3 * w, 'deep', (r() - 0.5) * 0.3);
        this.nextBassAt = t + hold + 30 + r() * 45;
      }
    } else if (t >= this.nextBassAt && r() < 0.2) {
      // Just the strike.
      this.e.playNote(Composer.near(ch.rootPc, 40), 0.5 + 0.3 * w, 'deep', (r() - 0.5) * 0.3);
      this.nextBassAt = t + 30 + r() * 40;
    }
    this.e.emit({
      k: 'chord', root: this.root, mode: this.mode, scale: this.scale, pcs: ch.pcs, rootPc: ch.rootPc, name: ch.name,
      key: `${this.name(this.root)} ${this.mode}`, roman: ROMAN[this.degree], dur, notes,
    });
  }

  loopNote(L, ev) {
    const ch = this.current;
    const d = this.degree + ev.deg;
    const pc = this.pcOf(d);
    let midi = Composer.near(pc, L.center);
    // Avoid a semitone rub against a pad note in the same octave region.
    if (this.pad.some((p) => Math.abs(p - midi) === 1)) midi = Composer.near(ch.rootPc, L.center);
    return midi;
  }

  tick(t) {
    const r = this.r;
    this.weather = this.weatherAt(t);
    const w = this.weather;
    if (t >= this.nextChordAt) this.nextChord(t);

    // Tape loops.
    for (const L of this.loops) {
      if (t < L.enterAt) continue;
      while (L.idx < L.events.length && t >= L.cycleStart + L.events[L.idx].at) {
        const ev = L.events[L.idx++];
        const act = clamp(0.1 + 1.25 * w * L.affinity - (L.inst === 'glass' ? 0.25 : 0), 0.05, 0.95);
        if (r() < act) this.e.playNote(this.loopNote(L, ev), ev.vel * (0.55 + 0.45 * w), L.inst, L.pan + (r() - 0.5) * 0.2);
      }
      if (t >= L.cycleStart + L.period) {
        L.cycleStart += L.period;
        L.idx = 0;
        if (r() < 0.12) {
          const ev = L.events[(r() * L.events.length) | 0];
          ev.deg = [0, 2, 4, 1, 5, 7][(r() * 6) | 0];
        }
      }
    }

    // Occasional melody: a short stepwise phrase that resolves to a chord tone.
    if (t >= this.nextPhraseAt) {
      if (w > 0.25 && w < 0.9 && this.current) {
        const inst = r() < 0.6 ? 'felt' : 'tine';
        let deg = this.degree + [0, 2, 4][(r() * 3) | 0] + 7;
        let at = t + 0.2;
        const len = 4 + ((r() * 4) | 0);
        const pan = (r() - 0.5) * 0.6;
        for (let i = 0; i < len; i++) {
          if (i === len - 1) {
            // resolve to nearest chord tone
            const rel = mod(deg - this.degree, 7);
            deg += rel === 1 || rel === 3 ? -1 : rel === 5 ? -1 : rel === 6 ? 1 : 0;
          }
          const vel = 0.3 + 0.35 * Math.sin((Math.PI * (i + 0.5)) / len);
          this.queue.push({ at, deg, vel, inst, pan });
          at += 0.55 + r() * 1.4 + (i === len - 2 ? 0.6 : 0);
          deg += [-2, -1, -1, 1, 1, 2, 0][(r() * 7) | 0];
        }
      }
      this.nextPhraseAt = t + 50 + r() * 70;
    }

    // Glass flurries when the weather is bright.
    if (t >= this.nextFlurryAt) {
      if (w > 0.6 && this.current) {
        const cnt = 4 + ((r() * 5) | 0);
        const up = r() < 0.6;
        let at = t;
        const pcs = this.current.pcs;
        const pan0 = (r() - 0.5) * 1.4;
        for (let i = 0; i < cnt; i++) {
          const pc = pcs[(up ? i : cnt - i) % pcs.length];
          const midi = Composer.near(pc, 84 + (up ? i : cnt - i) * 2);
          this.queue.push({ at, midi, vel: 0.35 * (1 - i / (cnt + 2)), inst: 'glass', pan: pan0 + i * 0.08 });
          at += 0.09 + r() * 0.16;
        }
      }
      this.nextFlurryAt = t + 25 + r() * 45;
    }

    // Drain queue.
    if (this.queue.length) {
      const q = this.queue;
      for (let i = 0; i < q.length; ) {
        if (t >= q[i].at) {
          const n = q[i];
          const midi = n.midi ?? this.degMidi(n.deg, 4);
          this.e.playNote(midi, n.vel, n.inst, n.pan);
          q.splice(i, 1);
        } else i++;
      }
    }

    this.e.setAirLevel((0.25 + 0.75 * w * w) * this.e.wind);
  }

  /** A touch/click on the painting: y (0 bottom .. 1 top) picks a scale tone. */
  touch(x, y) {
    if (!this.current) return;
    const steps = Math.round(clamp(y, 0, 1) * 16);
    const d = this.degree + steps - 3;
    const midi = this.degMidi(d, 5);
    const inst = y > 0.6 ? 'glass' : y > 0.3 ? 'bell' : 'felt';
    this.e.playNote(midi, 0.55, inst, clamp(x * 2 - 1, -1, 1), { touch: 1 });
  }
}

