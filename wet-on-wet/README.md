# wet on wet

A generative ambient web installation. Slow modal music, played through **Nebula**, a vast
modulated feedback-delay-network reverb, and painted live as dripping watercolor.
Zero dependencies, no build step.

```sh
npm start                 # http://localhost:8080
npm run render            # offline render → out/render.wav + level report (Node, no browser)
npm run ir                # Nebula impulse response + decay/stereo stats
node tools/render.mjs --secs 600 --seed 42 --space 0.8
```

URL params: `?seed=N&night=1&space=0..1&density=0..1&wind=0..1&volume=0..1`.
Keys: **space** hold/resume · **N** day/night · **F** fullscreen · **H** hide text · **C** clear paper · **R** new piece.
Click/touch the painting to drop a note and a bead of colour where you touch.

## Layout

```
src/audio/        runs in the AudioWorklet *and* in Node (tools/render.mjs)
  dsp.js          rng, sine table, PolyBLEP, SVF, pink noise, softclip
  nebula.js       the reverb
  voices.js       pad (detuned saws + breathing LP), FM bell/glass/tine/felt/deep, drone, bass, aeolian harp
  composer.js     harmony, voice leading, tape loops, phrases, weather
  engine.js       voices → dry/send buses → Nebula → master
  worklet.js      thin AudioWorkletProcessor wrapper
src/visual/
  watercolor.js   WebGL2 fluid + wet/dry pigment simulation and display
  palette.js      six curated 5-pigment palettes on a ring; key → palette, degree → pigment
src/main.js       scheduling (paint lands when the note is *heard*), UI
```

## Music

- **Harmony** walks a weighted chord graph inside a mode (lydian, ionian, dorian, aeolian,
  mixolydian), 18–45 s per chord, with add9/7/sus colours. Every few chords it may modulate
  by a fifth, to the relative mode, or to the parallel mode.
- **Pads** are voice-led: common tones are held across changes and only moving voices swell in.
- **Tape loops** (after Eno's *Music for Airports*): seven loops with incommensurate periods
  (13–45 s). Each stores scale degrees *relative to the current chord*, so a loop keeps its
  rhythm forever while harmony recolours its pitches.
- **Weather** is a slow deterministic macro (0..1, periods ~3 min / 73 s / 31 s) that drives
  activity, brightness, glass flurries, occasional melodic phrases, and the room itself.
- **Low end, occasionally**: after a quiet gap, a chord change may bring a sub **bass swell**
  on its root (slow raised-cosine attack, held for most of the chord, long release; mostly dry)
  and sometimes a deep felt-mallet strike. It paints a dark, slow bloom low on the sheet.
- The **drone** alternates between a tonic pedal and following the chord root. The **aeolian
  harp** is pink noise through high-Q bandpasses tuned to chord tones.

## Nebula (reverb)

In the spirit of Valhalla Supermassive rather than a room simulation:
16 delay lines (≈50 ms – 2.2 s, spread set by *warp*) with **modulated Hermite-interpolated
reads** (a sine plus a random walk per line), an **allpass inside every feedback loop**
(density turns echoes into a cloud), in-loop damping and low cut, a 16×16 fast Walsh–Hadamard
mix, soft-clipped writes, orthogonal L/R taps, 4+4 input diffusers, and an **octave-up
shimmer** grain shifter feeding the output back into the input. Size changes are slewed, so
the room drifts in pitch like tape instead of clicking. The weather slowly moves the whole
room (size, warp, density, decay, damping, modulation, shimmer).

## Watercolor

A coarse stable-fluid solver moves water. A fine pigment layer (suspended absorbance and water)
deposits into a dry layer. Each frame: advection, only where wet · pooling water spreads ·
wet-in-wet bleeding · conservative capillary flow toward the drying rim (dark tidelines) ·
evaporation · deposition caught by paper grain (granulation) · rewetting lifts a little dry
pigment (backruns) · **dry-down**: heavy paint lightens toward a permanent stain, never to
nothing. A very slow ghosting (45 min half-life) keeps an all-day installation from saturating.

Each drop has a fate: most stay as they fall, some become **blooms** (fed for a few seconds, so
they creep outward lopsidedly and throw lobes), and some **drip** (beads that roll down,
wobbling and slowing, and end in a small pool). Placement uses a coarse coverage map: a new
drop tries ten spots and takes the emptiest, or becomes a satellite of a recent drop, so the
whole sheet fills while groups still form.

**Colour**: each key paints from one curated palette (harbor, lagoon, meadow, ember, dusk,
tide). The palette comes from the key's parent major scale on the circle of fifths, so relative
modes share a palette and modulating by a fifth steps to a neighbouring one. Scale degree picks
the pigment role: tonic/5th main colours, 3rd/6th supporting, 7th dark, 4th the rare accent.
Display is subtractive (`paper × e^−A`) with paper relief and a wet sheen. Night mode renders
the same field as pigment-light on indigo.

Tuning notes: keep `params.flow` ≲ 1 (a stronger current shears washes into straight-edged
marbling). In a throttled tab, `wow.advance(frames)` in the console steps the painting manually.
