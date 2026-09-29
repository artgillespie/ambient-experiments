// AudioWorkletProcessor around Engine. Thin by design: logic lives in
// engine.js so it can be rendered and measured in Node.
//
// In:  { kind: 'volume'|'space'|'density'|'wind', value } | { kind: 'touch', x, y }
// Out: { kind: 'events', list: [{...ev, at}] }   at = AudioContext time of block
//      { kind: 'meter', rms, peak, weather, at }  (~20 Hz)

import { Engine } from './engine.js';

class WetOnWetProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.engine = new Engine({ sampleRate, seed: o.seed || 1 });
    if (o.volume != null) this.engine.setVolume(o.volume);
    if (o.space != null) this.engine.setSpace(o.space);
    if (o.density != null) this.engine.setDensity(o.density);
    if (o.wind != null) this.engine.setWind(o.wind);
    this.blocks = 0;
    this.port.onmessage = ({ data: m }) => {
      const e = this.engine;
      if (m.kind === 'volume') e.setVolume(m.value);
      else if (m.kind === 'space') e.setSpace(m.value);
      else if (m.kind === 'density') e.setDensity(m.value);
      else if (m.kind === 'wind') e.setWind(m.value);
      else if (m.kind === 'touch') e.touch(m.x, m.y);
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const e = this.engine;
    e.process(L, R, L.length);
    if (e.events.length) {
      const at = currentTime;
      this.port.postMessage({ kind: 'events', list: e.events.map((ev) => ({ ...ev, at })) });
      e.events.length = 0;
    }
    if (++this.blocks % 18 === 0) {
      this.port.postMessage({ kind: 'meter', rms: e.rms, peak: e.peak, weather: e.composer.weather, at: currentTime });
    }
    return true;
  }
}

registerProcessor('wet-on-wet', WetOnWetProcessor);
