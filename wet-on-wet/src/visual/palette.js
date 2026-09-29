// Curated watercolor palettes. Each key paints from one small palette so that
// every drop on the paper belongs with its neighbours.
//
// Palettes sit on a ring; neighbours share pigments or temperature. A key picks
// its palette from its parent major scale's position on the circle of fifths,
// so relative modes (same notes) share a palette and a modulation by a fifth
// steps to the neighbouring palette. Within a palette, scale degree picks the
// pigment role: tonic and fifth the main colours, the 3rd/6th the supporting
// one, the 7th a dark, the 4th the (rare) accent.
//
// Colours are masstone reflectance (sRGB hex). The painter works in absorbance,
// A = -ln(reflectance) per channel, which mixes subtractively.

const RING = [
  { name: 'harbor', hex: ['#3a8cc2', '#2b9a92', '#c28a45', '#2d3a64', '#cf5f7c'] },
  { name: 'lagoon', hex: ['#2b9a92', '#3f8f6a', '#e2c64a', '#3261ad', '#e07a5f'] },
  { name: 'meadow', hex: ['#6d9140', '#cf9a32', '#e6cf72', '#4f4a3a', '#3a8cc2'] },
  { name: 'ember', hex: ['#cf9a32', '#cc6a34', '#7e2e48', '#2d3a64', '#6d9140'] },
  { name: 'dusk', hex: ['#cf5f7c', '#7a55a8', '#e3b27a', '#6e2a40', '#3a4fa3'] },
  { name: 'tide', hex: ['#3a4fa3', '#9a86c0', '#d99aac', '#45546f', '#c28a45'] },
];

const FIFTHS_POS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5].reduce((a, pc, i) => ((a[pc] = i), a), []);
// Semitones from each mode's tonic down to its parent major scale.
const PARENT = { lydian: 5, ionian: 0, mixolydian: 7, dorian: 2, aeolian: 9 };
// scale degree (0..6) → role index (main, second, third, dark, accent)
const ROLE = [0, 2, 1, 4, 0, 1, 3];

const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export function absorb(hex) {
  const v = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  return v.map((x) => -Math.log(Math.max(0.015, x)));
}

export const PALETTES = RING.map((p) => ({ name: p.name, hex: p.hex, A: p.hex.map(absorb) }));

/** Palette for a key. */
export function paletteFor(root, mode) {
  const parent = (((root - (PARENT[mode] ?? 0)) % 12) + 12) % 12;
  return PALETTES[FIFTHS_POS[parent] % PALETTES.length];
}

/** Absorbance for a MIDI note / pitch class within a key's palette. */
export function pigmentFor(pal, key, pc) {
  const rel = (((pc - key.root) % 12) + 12) % 12;
  let deg = key.scale.indexOf(rel);
  if (deg < 0) deg = key.scale.findIndex((s) => s > rel) - 1;
  return pal.A[ROLE[Math.max(0, deg)]];
}

export const mixA = (a, b, t) => a.map((x, i) => x * (1 - t) + b[i] * t);
