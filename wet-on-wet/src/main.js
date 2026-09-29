// Glue: audio worklet ⇄ painter, scheduling, and the (mostly invisible) UI.
//
// The worklet stamps every musical event with the AudioContext time of the
// block that produced it. We hold events until that moment actually leaves
// the speakers (currentTime - outputLatency) and only then drop the paint, so
// each bloom opens exactly as its note is heard.

import { Watercolor } from './visual/watercolor.js';
import { paletteFor, pigmentFor, mixA } from './visual/palette.js';

const $ = (s) => document.querySelector(s);
const qs = new URLSearchParams(location.search);
const state = {
  seed: +(qs.get('seed') || (Math.random() * 1e6) | 0),
  volume: +(qs.get('volume') ?? 0.8),
  space: +(qs.get('space') ?? 0.58),
  density: +(qs.get('density') ?? 0.47),
  wind: +(qs.get('wind') ?? 0.18),
  night: qs.get('night') === '1',
  weather: 0.3,
  started: false,
};

let ctx = null, node = null, painter = null;
const queue = [];
const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);
const pick = (xs) => xs[(Math.random() * xs.length) | 0];
const chance = (p) => Math.random() < p;

// ---------------------------------------------------------------------------
// Painter

try {
  painter = new Watercolor($('#c'), { night: state.night });
} catch (err) {
  console.error(err);
  $('#nogl').hidden = false;
}

// The current key decides the palette; every note is coloured by its degree.
const IONIAN = [0, 2, 4, 5, 7, 9, 11];
let key = { root: [0, 7, 2, 9][(Math.random() * 4) | 0], mode: 'ionian', scale: IONIAN, pcs: [0, 4, 7] };
let pal = paletteFor(key.root, key.mode);
const pig = (pc) => pigmentFor(pal, key, ((pc % 12) + 12) % 12);
/** Sometimes a drop picks up a second colour from the same palette. */
const pigMix = (pc) => (chance(0.3) ? mixA(pig(pc), pick(pal.A.slice(0, 3)), rnd(0.25, 0.5)) : pig(pc));

// Placement: a coarse coverage map remembers where paint has landed. New drops
// try a handful of spots and take the emptiest, so the whole sheet fills over
// time; some become satellites of a recent drop, so groups still form.
const GW = 24, GH = 14;
const cover = new Float32Array(GW * GH);
const recent = [];
function coverAt(x, y) {
  const i = Math.min(GW - 1, Math.max(0, (x * GW) | 0)), j = Math.min(GH - 1, Math.max(0, (y * GH) | 0));
  return cover[j * GW + i];
}
function mark(x, y, r, amt) {
  const rx = Math.ceil(r * GW / painter.aspect) + 1, ry = Math.ceil(r * GH) + 1;
  const ci = (x * GW) | 0, cj = (y * GH) | 0;
  for (let j = cj - ry; j <= cj + ry; j++) for (let i = ci - rx; i <= ci + rx; i++) {
    if (i < 0 || j < 0 || i >= GW || j >= GH) continue;
    const dx = ((i + 0.5) / GW - x) * painter.aspect, dy = (j + 0.5) / GH - y;
    const f = Math.exp(-(dx * dx + dy * dy) / (r * r * 2.5));
    cover[j * GW + i] += amt * f;
  }
}
/** Choose a spot. prefY (0..1) nudges pitch toward height, loosely. */
function spot(prefY = null, satellite = 0.3) {
  if (recent.length && chance(satellite)) {
    const s = pick(recent), a = rnd(0, 6.28), d = rnd(0.03, 0.1);
    const x = s.x + (Math.cos(a) * d) / painter.aspect, y = s.y + Math.sin(a) * d;
    if (x > 0.03 && x < 0.97 && y > 0.05 && y < 0.96) return [x, y];
  }
  let best = null, bs = 1e9;
  for (let k = 0; k < 10; k++) {
    const x = rnd(0.04, 0.96), y = rnd(0.07, 0.95);
    const s = coverAt(x, y) + (prefY == null ? 0 : Math.abs(y - prefY) * 0.6) + rnd(0, 0.15);
    if (s < bs) { bs = s; best = [x, y]; }
  }
  return best;
}
function remember(x, y, r) {
  mark(x, y, r, 1);
  recent.push({ x, y });
  if (recent.length > 6) recent.shift();
}
const pitchY = (m, lo, hi) => Math.min(0.92, Math.max(0.1, (m - lo) / (hi - lo)));

// A drop and its fate: most stay as they fell, some keep spreading into a
// larger soft bloom, some run as drips.
function drop(x, y, A, { r, water = 0.9, amount = 0.8, push = 30, spread = 0.25, run = 0.2 }) {
  painter.splat({ x, y, r, water, A, amount, push, swirl: rnd(-0.4, 0.4), soft: 0.8, rag: 0.1 });
  remember(x, y, r);
  if (chance(spread)) bloom(x, y, A, r * rnd(2, 3.6), amount * 0.5);
  else if (y > 0.25 && chance(run * (0.6 + 0.8 * state.weather))) drip(x + rnd(-0.4, 0.4) * r / painter.aspect, y - r * 0.8, A, rnd(0.4, 2));
}

function paint(ev) {
  if (!painter) return;
  switch (ev.k) {
    case 'chord': {
      if (ev.scale) {
        key = { root: ev.root, mode: ev.mode, scale: ev.scale, pcs: ev.pcs };
        pal = paletteFor(key.root, key.mode);
      }
      if (ev.key) showChord(ev);
      // A soft pair of blooms in the chord's colours.
      const [x, y] = spot(null, 0.1);
      bloom(x, y, pig(ev.rootPc), rnd(0.05, 0.085), rnd(0.25, 0.4), 0.8);
      const pc2 = pick(ev.pcs.slice(1));
      const a = rnd(0, 6.28), d = rnd(0.04, 0.07);
      bloom(x + Math.cos(a) * d / painter.aspect, y + Math.sin(a) * d, pig(pc2), rnd(0.035, 0.065), rnd(0.25, 0.4), 1.6);
      break;
    }
    case 'pad': {
      const [x, y] = spot(pitchY(ev.m, 45, 84));
      drop(x, y, pigMix(ev.m), { r: rnd(0.018, 0.032), water: 0.95, amount: rnd(0.35, 0.55), push: 12, spread: 0.55, run: 0.3 });
      break;
    }
    case 'bass': {
      // The low end arrives as a deep, slow bloom low on the sheet that
      // often runs: the palette's dark, tinted by the chord root.
      const [x, y] = spot(0.22, 0.05);
      const A = mixA(pal.A[3], pig(ev.m), 0.3);
      bloom(x, y, A, rnd(0.06, 0.09), 0.75);
      if (chance(0.5)) drip(x + rnd(-0.02, 0.02), y - 0.04, A, rnd(2, 5));
      break;
    }
    case 'drone': {
      const [x, y] = spot(0.18, 0.05);
      bloom(x, y, mixA(pig(ev.m), pal.A[3], 0.5), rnd(0.04, 0.07), 0.3);
      break;
    }
    case 'note': {
      if (ev.touch) break; // already painted at the pointer
      const glass = ev.i === 'glass';
      const [x, y] = spot(pitchY(ev.m, 55, 98));
      const A = pigMix(ev.m);
      if (glass) {
        drop(x, y, A, { r: 0.006 + 0.008 * ev.v, water: 0.7, amount: 0.9, push: 15, spread: 0.1, run: 0.05 });
        spatter(x, y, A, 3 + ((Math.random() * 4) | 0), 0.045);
      } else {
        const r = (ev.i === 'bell' ? 0.014 : 0.011) + 0.016 * ev.v;
        drop(x, y, A, { r, water: 0.95, amount: 0.7 + 0.5 * ev.v, push: 25 + 30 * ev.v, spread: ev.i === 'felt' ? 0.4 : 0.22, run: 0.3 });
      }
      break;
    }
  }
}

function spatter(x, y, A, n, spread) {
  for (let i = 0; i < n; i++) {
    const a = rnd(0, 6.28), d = rnd(0.2, 1) * spread;
    painter.splat({ x: x + (Math.cos(a) * d) / painter.aspect, y: y + Math.sin(a) * d, r: rnd(0.002, 0.006), water: 0.5, A, amount: rnd(0.7, 1.2), push: 0, soft: 0.85, rag: 0.05 });
  }
}

// Blooms: a drop that keeps being fed water, so it creeps outward over a few
// seconds; its pigment thins as it grows and gathers at the spreading rim.
const blooms = [];
function bloom(x, y, A, R, amount, delay = 0) {
  if (blooms.length > 16) return;
  // Growth is lopsided: the bloom creeps in a preferred direction and throws
  // out a lobe now and then, so it never ends up a disc.
  const a = rnd(0, 6.28);
  blooms.push({ x, y, A, R, amount, delay, t: 0, dur: rnd(3, 7), acc: 1, seed: rnd(0, 100), dx: Math.cos(a), dy: Math.sin(a) });
  remember(x, y, R);
}
function stepBlooms(dt) {
  for (let i = blooms.length - 1; i >= 0; i--) {
    const b = blooms[i];
    if ((b.delay -= dt) > 0) continue;
    b.t += dt; b.acc += dt;
    const f = Math.min(1, b.t / b.dur);
    if (b.acc > 0.25) {
      b.acc = 0;
      const r = b.R * (0.3 + 0.55 * Math.sqrt(f));
      const drift = b.R * 0.45 * f;
      const cx = b.x + (b.dx * drift) / painter.aspect, cy = b.y + b.dy * drift;
      const amt = b.amount * (1 - 0.7 * f) * 0.5;
      painter.splat({ x: cx, y: cy, r, water: 0.42, A: b.A, amount: amt, push: 4, swirl: rnd(-0.5, 0.5), soft: 0.6, rag: 0.3, seed: b.seed + b.t * 0.3 });
      if (chance(0.45)) {
        const la = rnd(0, 6.28), ld = r * rnd(0.6, 1.0);
        painter.splat({ x: cx + (Math.cos(la) * ld) / painter.aspect, y: cy + Math.sin(la) * ld, r: r * rnd(0.3, 0.55), water: 0.4, A: b.A, amount: amt * 0.8, push: 3, soft: 0.6, rag: 0.3 });
      }
    }
    if (f >= 1) blooms.splice(i, 1);
  }
}

// Drips: beads that roll down under gravity, wobbling along the paper grain,
// leaving a thin trail and slowing to a stop as their water runs out.
const drips = [];
function drip(x, y, A, delay = 0) {
  if (drips.length > 24) return;
  drips.push({ x, y, A, delay, life: 1, speed: rnd(0.025, 0.05), ph: rnd(0, 6.28), wob: rnd(0.5, 1.4), acc: 0 });
}
function stepDrips(dt) {
  const g = painter.params.gravity;
  for (let i = drips.length - 1; i >= 0; i--) {
    const d = drips[i];
    if ((d.delay -= dt) > 0) continue;
    const v = d.speed * (0.25 + 0.75 * d.life) * (0.7 + 0.3 * Math.sin(d.ph * 2.3));
    d.ph += dt * d.wob;
    d.x += (g[0] * v + Math.sin(d.ph) * 0.0015) * dt / painter.aspect;
    d.y += g[1] * v * dt;
    d.life -= dt * rnd(0.03, 0.09);
    d.acc += dt;
    if (d.acc > 1 / 30) {
      d.acc = 0;
      painter.splat({ x: d.x, y: d.y, r: 0.0025 + 0.004 * d.life, water: 0.35, A: d.A, amount: 0.35 + 0.35 * d.life, push: 0, soft: 0.5, rag: 0.05 });
      mark(d.x, d.y, 0.01, 0.05);
    }
    if (d.life <= 0 || d.y < 0.01) {
      // the bead: a small pool at the end of the run
      painter.splat({ x: d.x, y: d.y, r: rnd(0.005, 0.009), water: 0.6, A: d.A, amount: 1.0, push: 2, soft: 0.8, rag: 0.08 });
      drips.splice(i, 1);
    }
  }
}

/** Clear-water drops land now and then on older paint: small backruns. */
function rewet() {
  if (!painter || !recent.length) return;
  const s = pick(recent);
  painter.splat({ x: s.x + rnd(-0.04, 0.04), y: s.y + rnd(-0.04, 0.04), r: rnd(0.015, 0.04), water: rnd(0.8, 1.1), A: [0, 0, 0], amount: 0, push: rnd(8, 20), swirl: rnd(-1, 1), soft: 0.7, rag: 0.2 });
}

// Idle painting behind the title card, before audio exists.
function idlePaint() {
  if (state.started || !painter) return;
  const m = 60 + key.root + pick(key.scale) + 12 * ((Math.random() * 2) | 0);
  paint({ k: chance(0.25) ? 'pad' : 'note', m, v: rnd(0.3, 0.8), i: pick(['bell', 'felt', 'glass', 'tine']) });
  setTimeout(idlePaint, rnd(700, 1600));
}

// ---------------------------------------------------------------------------
// Frame loop

let last = performance.now(), nextRewet = performance.now() + 8000;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (ctx) {
    const heard = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    while (queue.length && queue[0].at <= heard) paint(queue.shift());
  }
  if (now > nextRewet) { rewet(); nextRewet = now + rnd(9000, 20000); }
  if (painter) tick(dt);
  requestAnimationFrame(frame);
}
function tick(dt) {
  const w = state.weather, t = painter.time;
  // Coverage memory fades with the paint's own dry-down.
  const k = Math.exp(-dt / 600);
  for (let i = 0; i < cover.length; i++) cover[i] *= k;
  const p = painter.params;
  p.flow = 0.25 + 0.5 * w; // more than ~1 shears washes into marbling
  p.drip = 0;
  stepBlooms(dt);
  stepDrips(dt);
  const tilt = 0.18 * Math.sin(t * 0.011) + 0.08 * Math.sin(t * 0.029);
  p.gravity = [Math.sin(tilt), -Math.cos(tilt)];
  painter.resize();
  painter.step(dt);
  painter.render();
}
requestAnimationFrame(frame);
if (painter) {
  // A first breath of colour so the page never opens on blank paper.
  paint({ k: 'chord', pcs: [key.root, (key.root + 4) % 12, (key.root + 7) % 12], rootPc: key.root });
  idlePaint();
}

// ---------------------------------------------------------------------------
// Audio

async function start() {
  if (state.started) return;
  state.started = true;
  $('#intro').classList.add('gone');
  ctx = new AudioContext({ latencyHint: 'playback' });
  await ctx.audioWorklet.addModule(new URL('./audio/worklet.js', import.meta.url));
  node = new AudioWorkletNode(ctx, 'wet-on-wet', {
    numberOfInputs: 0, outputChannelCount: [2],
    processorOptions: { seed: state.seed, volume: state.volume, space: state.space, density: state.density, wind: state.wind },
  });
  node.connect(ctx.destination);
  node.port.onmessage = ({ data: m }) => {
    if (m.kind === 'events') {
      for (const ev of m.list) {
        queue.push(ev);
      }
      queue.sort((a, b) => a.at - b.at);
    } else if (m.kind === 'meter') {
      state.weather = m.weather;
    }
  };
  if (ctx.state !== 'running') await ctx.resume();
  wake();
  history.replaceState(null, '', `?${new URLSearchParams({ ...Object.fromEntries(qs), seed: state.seed })}`);
  $('#seed').textContent = `seed ${state.seed}`;
  poke();
}

function send(kind, value) { node?.port.postMessage({ kind, value }); }

function showChord(ev) {
  const el = $('#chord');
  el.innerHTML = `<span class="key">${ev.key}</span><span class="dot">·</span><span class="roman">${ev.roman}</span><span class="dot">·</span><span class="name">${ev.name}</span>`;
}

let lock = null;
async function wake() {
  try { lock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.started) wake(); });

// ---------------------------------------------------------------------------
// UI

let hideTimer = 0;
function poke() {
  document.body.classList.add('awake');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (!$('#hud').matches(':hover')) document.body.classList.remove('awake'); }, 3500);
}
addEventListener('pointermove', poke);

$('#begin').addEventListener('click', start);

// Touch the painting: a drop of colour and a note, both where you touched.
$('#c').addEventListener('pointerdown', (e) => {
  if (!state.started) return start();
  const x = e.clientX / innerWidth, y = 1 - e.clientY / innerHeight;
  node?.port.postMessage({ kind: 'touch', x, y });
  if (painter) {
    const A = pigMix(pick(key.pcs));
    drop(x, y, A, { r: rnd(0.014, 0.026), water: 1, amount: 0.9, push: 40, spread: 0.3, run: 0.35 });
    spatter(x, y, A, 4, 0.05);
  }
});

const bind = (id, key, fn) => {
  const el = $(id);
  el.value = state[key];
  el.addEventListener('input', () => { state[key] = +el.value; fn(+el.value); });
};
bind('#volume', 'volume', (v) => send('volume', v));
bind('#space', 'space', (v) => send('space', v));
bind('#density', 'density', (v) => send('density', v));
bind('#wind', 'wind', (v) => send('wind', v));

function toggleNight() {
  state.night = !state.night;
  if (painter) painter.night = state.night ? 1 : 0;
  document.body.classList.toggle('night', state.night);
}
document.body.classList.toggle('night', state.night);
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}
function newSeed() {
  const p = new URLSearchParams(location.search);
  p.set('seed', (Math.random() * 1e6) | 0);
  location.search = p.toString();
}
async function togglePause() {
  if (!ctx) return;
  if (ctx.state === 'running') await ctx.suspend(); else await ctx.resume();
  document.body.classList.toggle('paused', ctx.state !== 'running');
}

$('#night').addEventListener('click', toggleNight);
$('#full').addEventListener('click', toggleFullscreen);
$('#reseed').addEventListener('click', newSeed);

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.key !== ' ') return;
  const k = e.key.toLowerCase();
  if (k === 'enter' && !state.started) start();
  else if (k === ' ') { e.preventDefault(); state.started ? togglePause() : start(); }
  else if (k === 'n') toggleNight();
  else if (k === 'f') toggleFullscreen();
  else if (k === 'h') document.body.classList.toggle('bare');
  else if (k === 'c') painter?.clear();
  else if (k === 'r') newSeed();
  else return;
  poke();
});

if (qs.get('autostart') === '1') {
  // Browsers still need one gesture; any key or click will do.
  addEventListener('pointerdown', start, { once: true });
}

// Console / automation hook: wow.advance(600) runs ten simulated seconds of
// painting even when the tab is throttled; wow.paint({...}) drops an event.
window.wow = {
  state, painter, paint, rewet,
  get ctx() { return ctx; }, get node() { return node; }, queue,
  advance(frames = 60, dt = 1 / 60) {
    for (let i = 0; i < frames; i++) {
      if (ctx) { const heard = ctx.currentTime; while (queue.length && queue[0].at <= heard) paint(queue.shift()); }
      stepBlooms(dt);
      stepDrips(dt);
      painter.step(dt);
    }
    painter.render();
    return painter.time;
  },
};
