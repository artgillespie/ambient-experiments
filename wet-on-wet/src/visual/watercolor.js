// A WebGL2 watercolor painter.
//
// Two coupled simulations:
//   • a coarse incompressible fluid (velocity, pressure) that sloshes water
//     around: splat pushes, a slow curl-noise current, friction on dry paper;
//   • a fine pigment layer: WET = suspended pigment (rgb absorbance) + water (a),
//     DRY = pigment deposited into the paper (rgb absorbance).
//
// Per frame the pigment step (one MRT pass) does, in order:
//   advect by the fluid (only where wet) and by gravity (drips: very wet paint
//   runs down in fibre-guided rivulets) → water spreads into paper only when it
//   pools → capillary flow carries pigment down water gradients toward the
//   drying rim (dark edges) → evaporation → deposition (faster when drying and
//   on paper grain: granulation) → re-wetting lifts dry pigment (backruns) →
//   very slow fading, so an installation never saturates.
// Display is subtractive: paper × exp(-absorbance), with paper relief, a wet
// sheen, and a luminous "night" rendering of the same pigment field.

const VERT = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.));
out vec2 vUv;
void main(){ vec2 p = P[gl_VertexID]; vUv = p*.5+.5; gl_Position = vec4(p,0.,1.); }`;

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
`;

const NOISE = `
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.-2.*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){ float s = 0., a = .5; for(int i=0;i<5;i++){ s += a*noise(p); p = p*2.03 + 17.1; a *= .5; } return s; }
`;

const PAPER = HEAD + NOISE + `
uniform float uAspect;
out vec4 o;
float worley(vec2 p){
  vec2 i = floor(p), f = fract(p); float d = 1.;
  for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
    vec2 g = vec2(x,y); vec2 c = g + vec2(hash(i+g), hash(i+g+7.7)) - f;
    d = min(d, dot(c,c));
  }
  return sqrt(d);
}
void main(){
  vec2 p = vUv*vec2(uAspect,1.);
  // cold-press tooth: soft cells + fbm
  float tooth = .55*(1.-worley(p*38.)) + .45*fbm(p*22.);
  float big = fbm(p*3.);
  // fibres: long thin stretched noise at a few angles
  float fib = 0.;
  for(int k=0;k<3;k++){
    float a = float(k)*2.1 + .4; mat2 R = mat2(cos(a),-sin(a),sin(a),cos(a));
    vec2 q = R*p;
    fib += smoothstep(.62,.9, noise(q*vec2(9.,160.) + float(k)*31.));
  }
  float gran = fbm(p*70.)*.55 + fbm(p*160. + 9.)*.3 + .15*(1.-worley(p*115. + fbm(p*9.)*2.));
  o = vec4(tooth*.8 + big*.2, gran, clamp(fib*.5 + big*.5, 0., 1.), 1.);
}`;

const COPY = HEAD + `uniform sampler2D uTex; out vec4 o; void main(){ o = texture(uTex, vUv); }`;
const CLEAR = HEAD + `uniform vec4 uValue; out vec4 o; void main(){ o = uValue; }`;

const MAXS = 16;
const SPLAT_WET = HEAD + NOISE + `
uniform sampler2D uWet;
uniform float uAspect;
uniform int uCount;
uniform vec4 uA[${MAXS}]; // x, y, radius, water
uniform vec4 uB[${MAXS}]; // absorbance rgb, amount
uniform vec4 uC[${MAXS}]; // seed, softness, raggedness, unused
out vec4 o;
void main(){
  vec4 w = texture(uWet, vUv);
  for(int i=0;i<${MAXS};i++){
    if(i >= uCount) break;
    vec2 d = (vUv - uA[i].xy)*vec2(uAspect,1.);
    float r = length(d);
    float R = uA[i].z;
    if(r > R*2.2) continue;
    float s = uC[i].x;
    vec2 dir = d/(r+1e-5);
    // Organic silhouette: low-frequency lobes + ragged fine edge.
    float lobes = (fbm(dir*2.1 + s) - .5)*1.3 + (noise(dir*5. + s*1.7) - .5)*.35;
    float rag = noise(vUv*vec2(uAspect,1.)*min(7.2/max(R,.01), 90.) + s*3.) - .5; // capped: huge coords lose float precision → straight edges
    float edge = R*(1. + .7*lobes + uC[i].z*rag);
    float m = 1. - smoothstep(edge*uC[i].y, edge, r);
    float core = mix(.55, 1., 1. - clamp(r/edge,0.,1.));
    w.a = min(w.a + uA[i].w*m, 1.6);
    w.rgb += uB[i].rgb * uB[i].a * m * core;
  }
  o = w;
}`;

const SPLAT_VEL = HEAD + `
uniform sampler2D uVel;
uniform float uAspect;
uniform int uCount;
uniform vec4 uA[${MAXS}]; // x, y, radius, push
uniform vec4 uC[${MAXS}]; // seed, softness, raggedness, swirl
out vec4 o;
void main(){
  vec2 v = texture(uVel, vUv).xy;
  for(int i=0;i<${MAXS};i++){
    if(i >= uCount) break;
    vec2 d = (vUv - uA[i].xy)*vec2(uAspect,1.);
    float R = uA[i].z*1.3;
    float g = exp(-dot(d,d)/(R*R));
    vec2 dir = normalize(d + 1e-5);
    vec2 tang = vec2(-dir.y, dir.x);
    v += (dir + tang*uC[i].w) * uA[i].w * g;
  }
  o = vec4(v, 0., 1.);
}`;

const ADVECT_VEL = HEAD + NOISE + `
uniform sampler2D uVel, uWet;
uniform vec2 uTexel;
uniform float uDt, uTime, uFlow, uAspect;
out vec4 o;
float pot(vec2 p){ return fbm(p*vec2(uAspect,1.)*2.2 + vec2(uTime*.021, -uTime*.013)); }
void main(){
  vec2 v = texture(uVel, vUv).xy;
  vec2 c = vUv - uDt*v*uTexel;
  vec2 nv = texture(uVel, c).xy;
  float water = texture(uWet, vUv).a;
  float mob = smoothstep(.02, .45, water);
  // curl-noise current (divergence free), only moves water
  float e = .01;
  float px = pot(vUv + vec2(e,0.)) - pot(vUv - vec2(e,0.));
  float py = pot(vUv + vec2(0.,e)) - pot(vUv - vec2(0.,e));
  nv += uDt*uFlow*vec2(py, -px)/(2.*e) * mob;
  // viscosity + paper friction
  nv *= 1./(1. + uDt*(.35 + 3.5*(1.-mob)));
  o = vec4(nv, 0., 1.);
}`;

const DIVERGENCE = HEAD + `
uniform sampler2D uVel; uniform vec2 uTexel; out vec4 o;
void main(){
  float L = texture(uVel, vUv - vec2(uTexel.x,0.)).x;
  float R = texture(uVel, vUv + vec2(uTexel.x,0.)).x;
  float B = texture(uVel, vUv - vec2(0.,uTexel.y)).y;
  float T = texture(uVel, vUv + vec2(0.,uTexel.y)).y;
  vec2 C = texture(uVel, vUv).xy;
  if(vUv.x - uTexel.x < 0.) L = -C.x;
  if(vUv.x + uTexel.x > 1.) R = -C.x;
  if(vUv.y - uTexel.y < 0.) B = -C.y;
  if(vUv.y + uTexel.y > 1.) T = -C.y;
  o = vec4(.5*(R - L + T - B), 0., 0., 1.);
}`;

const PRESSURE = HEAD + `
uniform sampler2D uP, uDiv; uniform vec2 uTexel; out vec4 o;
void main(){
  float L = texture(uP, vUv - vec2(uTexel.x,0.)).x;
  float R = texture(uP, vUv + vec2(uTexel.x,0.)).x;
  float B = texture(uP, vUv - vec2(0.,uTexel.y)).x;
  float T = texture(uP, vUv + vec2(0.,uTexel.y)).x;
  float d = texture(uDiv, vUv).x;
  o = vec4((L + R + B + T - d)*.25, 0., 0., 1.);
}`;

const GRADIENT = HEAD + `
uniform sampler2D uP, uVel; uniform vec2 uTexel; out vec4 o;
void main(){
  float L = texture(uP, vUv - vec2(uTexel.x,0.)).x;
  float R = texture(uP, vUv + vec2(uTexel.x,0.)).x;
  float B = texture(uP, vUv - vec2(0.,uTexel.y)).x;
  float T = texture(uP, vUv + vec2(0.,uTexel.y)).x;
  vec2 v = texture(uVel, vUv).xy - .5*vec2(R - L, T - B);
  o = vec4(v, 0., 1.);
}`;

const PIGMENT = HEAD + NOISE + `
uniform sampler2D uWet, uDry, uVel, uPaper;
uniform vec2 uTexel, uVelTexel, uGrav;
uniform float uDt, uTime, uAspect, uEvap, uDrip, uFade, uFloor, uGhost, uLift, uDeposit;
layout(location=0) out vec4 oWet;
layout(location=1) out vec4 oDry;

vec4 W(vec2 uv){ return texture(uWet, uv); }

void main(){
  vec4 paper = texture(uPaper, vUv);
  vec4 here = W(vUv);

  // ---- gravity drips: very wet paint runs, guided by fibres into rivulets
  vec2 up = -uGrav;
  float wAbove = max(W(vUv + up*uTexel*2.).a, W(vUv + up*uTexel*5.).a);
  float wm = max(here.a, wAbove);
  float lane = noise(vec2(vUv.x*uAspect*70. + paper.b*3., uTime*.004));
  lane = smoothstep(.72, .9, lane*.8 + paper.b*.35);
  float run = uDrip * smoothstep(.78, 1.25, wm) * (.02 + 1.8*lane);

  // ---- advection by the fluid (only mobile where wet) and gravity
  vec2 vel = texture(uVel, vUv).xy * uVelTexel;
  float mob = smoothstep(.02, .45, wm);
  vec2 disp = uDt*(vel*mob + uGrav*run);
  vec4 c = W(vUv - disp);

  // ---- neighbours
  vec4 nL = W(vUv - vec2(uTexel.x,0.)), nR = W(vUv + vec2(uTexel.x,0.));
  vec4 nB = W(vUv - vec2(0.,uTexel.y)), nT = W(vUv + vec2(0.,uTexel.y));
  vec4 avg = (nL + nR + nB + nT)*.25;

  // water: spreads into neighbours only when it pools; tooth makes edges ragged
  float tooth = paper.r;
  float spread = (.10 + .25*tooth) * smoothstep(.22, .6, max(avg.a, c.a));
  c.a += (avg.a - c.a)*spread;

  // pigment: wet-in-wet bleeding, only between wet cells
  float wetHere = smoothstep(.015, .12, c.a);
  float bleed = .22*wetHere*(.5 + tooth);
  vec3 avgP = (nL.rgb*step(.015,nL.a) + nR.rgb*step(.015,nR.a) + nB.rgb*step(.015,nB.a) + nT.rgb*step(.015,nT.a))*.25;
  float avgW = (step(.015,nL.a) + step(.015,nR.a) + step(.015,nB.a) + step(.015,nT.a))*.25;
  c.rgb += (avgP - c.rgb*avgW)*bleed;

  // capillary flow: pigment drifts down water gradients toward the drying
  // rim (dark edges). Conservative pairwise exchange computed from the
  // un-advected field with smooth weights, so it stays isotropic and stable.
  float kc = 2.2, capc = .05;
  float sHere = smoothstep(.01, .08, here.a);
  vec3 inflow = vec3(0.); float outflow = 0.;
  #define CAP(n) { float dw = n.a - here.a; \
     if(dw > 0.) inflow += n.rgb * min(capc, kc*dw) * sHere; \
     else outflow += min(capc, -kc*dw) * smoothstep(.01, .08, n.a); }
  CAP(nL) CAP(nR) CAP(nB) CAP(nT)
  c.rgb = c.rgb*(1. - min(outflow, .2)) + inflow;

  // ---- evaporation (edges and thin films dry first)
  float thin = 1. - smoothstep(0., .35, c.a);
  c.a = max(0., c.a - uEvap*uDt*(.7 + .6*paper.g)*(1. + 1.8*thin));

  // ---- deposition into paper (granulation: grain catches pigment)
  vec4 dry = texture(uDry, vUv);
  float dryness = 1. - smoothstep(0., .3, c.a);
  float rate = uDeposit*(.04 + 3.*dryness*dryness) * (.7 + .6*paper.g);
  vec3 dep = c.rgb*clamp(rate*uDt, 0., 1.);
  c.rgb -= dep;
  dry.rgb += dep;

  // ---- re-wetting lifts some dried pigment back into suspension (backruns)
  vec3 lift = dry.rgb*clamp(uLift*uDt*smoothstep(.35, 1.1, c.a), 0., .5);
  dry.rgb -= lift; c.rgb += lift;

  // ---- drying down: heavy paint lightens toward a permanent stain (never
  // gone, like real watercolor); only a very slow ghosting over the hours
  // keeps a long-running installation from saturating.
  float m = max(max(dry.r, dry.g), dry.b);
  if(m > uFloor){ float m2 = uFloor + (m - uFloor)*exp(-uFade*uDt); dry.rgb *= m2/m; }
  dry.rgb *= exp(-uGhost*uDt);
  c.rgb = max(c.rgb, 0.);
  // Pigment saturates: cap the load while keeping its hue.
  c.rgb *= min(1., 2.6/max(max(c.r, c.g), max(c.b, 1e-4)));
  dry.rgb = max(dry.rgb, 0.);
  dry.rgb *= min(1., 3.2/max(max(dry.r, dry.g), max(dry.b, 1e-4)));

  oWet = c;
  oDry = vec4(dry.rgb, 1.);
}`;

const DISPLAY = HEAD + NOISE + `
uniform sampler2D uWet, uDry, uPaper;
uniform vec2 uTexel, uRes;
uniform float uNight, uTime, uAspect;
out vec4 o;
void main(){
  vec4 wet = texture(uWet, vUv);
  vec3 dry = texture(uDry, vUv).rgb;
  vec4 paper = texture(uPaper, vUv);
  float hL = texture(uPaper, vUv - vec2(uTexel.x,0.)).r, hR = texture(uPaper, vUv + vec2(uTexel.x,0.)).r;
  float hB = texture(uPaper, vUv - vec2(0.,uTexel.y)).r, hT = texture(uPaper, vUv + vec2(0.,uTexel.y)).r;
  vec3 n = normalize(vec3((hL - hR)*2.2, (hB - hT)*2.2, 1.));
  vec3 Ld = normalize(vec3(-.5, .6, .8));
  float shade = .93 + .1*dot(n, Ld);

  float water = wet.a;
  float wetness = smoothstep(.02, .5, water);
  // wet paint reads deeper; granulating pigment settles in the tooth
  vec3 A = dry*(.84 + .36*paper.g) + wet.rgb*(1.05 + .1*wetness);
  vec3 refl = exp(-A);

  // --- day: warm cotton paper
  vec3 paperC = vec3(.957, .937, .894) * mix(.985, 1.02, paper.b);
  vec3 day = paperC*shade*refl;
  day *= 1. - .05*wetness;                         // damp paper darkens
  vec3 H = normalize(Ld + vec3(0.,0.,1.));
  day += .07*wetness*pow(max(dot(n, H), 0.), 40.);   // wet sheen

  // --- night: pigment as light on deep indigo
  float dens = 1. - exp(-(A.r + A.g + A.b)*.45);
  float amin = min(A.r, min(A.g, A.b));
  vec3 hue = exp(-(A - amin)*2.6/(.6 + .2*(A.r + A.g + A.b)));
  vec3 bg = vec3(.006, .007, .014)*(.8 + .4*paper.r);
  vec3 night = bg + hue*pow(dens, .8)*(.85 + .25*wetness) + .06*wetness*pow(max(dot(n,H),0.),30.)*hue;

  vec3 col = mix(day, night, uNight);
  // vignette + dither
  vec2 q = vUv - .5; q.x *= uAspect;
  col *= 1. - .22*dot(q,q)*mix(1., 1.6, uNight);
  col += (hash(gl_FragCoord.xy + fract(uTime)*91.) - .5)/255.;
  o = vec4(pow(max(col, 0.), vec3(1./2.2)), 1.);
}`;

// ---------------------------------------------------------------------------

export class Watercolor {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      throw new Error('Float render targets are not available');
    }
    this.quality = opts.quality ?? 1;
    this.night = opts.night ? 1 : 0;
    this.nightT = this.night;
    this.params = { evap: 0.055, drip: 0, fade: 1 / 300, floor: 0.85, ghost: Math.LN2 / 2700, lift: 0.07, deposit: 1, flow: 0.4, gravity: [0, -1] };
    this.pending = [];
    this.time = 0;
    this.vao = gl.createVertexArray();
    const P = (src) => this.program(src);
    this.prog = {
      paper: P(PAPER), copy: P(COPY), clear: P(CLEAR), splatWet: P(SPLAT_WET), splatVel: P(SPLAT_VEL),
      advectVel: P(ADVECT_VEL), div: P(DIVERGENCE), pressure: P(PRESSURE), grad: P(GRADIENT),
      pigment: P(PIGMENT), display: P(DISPLAY),
    };
    this.resize();
  }

  // ---- GL plumbing ----------------------------------------------------------
  program(frag) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  target(w, h, { internal, format, type, filter } = {}) {
    const gl = this.gl;
    internal ??= gl.RGBA16F; format ??= gl.RGBA; type ??= gl.HALF_FLOAT; filter ??= gl.LINEAR;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fb, w, h };
  }
  double(w, h, o) {
    const d = { a: this.target(w, h, o), b: this.target(w, h, o) };
    d.swap = () => { [d.a, d.b] = [d.b, d.a]; };
    return d;
  }
  free(t) { if (!t) return; const gl = this.gl; gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
  freeDouble(d) { if (d) { this.free(d.a); this.free(d.b); } }

  /** Bind program, textures (by uniform name) and scalar/vec uniforms. */
  use(prog, tex = {}, uni = {}) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    let unit = 0;
    for (const k in tex) {
      if (prog.u[k] == null) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex[k]);
      gl.uniform1i(prog.u[k], unit++);
    }
    for (const k in uni) {
      const loc = prog.u[k];
      if (loc == null) continue;
      const v = uni[k];
      if (typeof v === 'number') gl.uniform1f(loc, v);
      else if (v.int != null) gl.uniform1i(loc, v.int);
      else if (v instanceof Float32Array) gl.uniform4fv(loc, v);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
      else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
      else if (v.length === 4) gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
    }
  }
  draw(target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this.canvas.width, target ? target.h : this.canvas.height);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---- sizing ---------------------------------------------------------------
  resize() {
    const gl = this.gl, c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(c.clientWidth * dpr)), ch = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width === cw && c.height === ch && this.wet) return;
    c.width = cw; c.height = ch;
    this.aspect = cw / ch;
    const long = Math.round(Math.min(1600, Math.max(640, Math.max(cw, ch) * 0.6)) * this.quality);
    const W = this.aspect >= 1 ? long : Math.round(long * this.aspect);
    const H = this.aspect >= 1 ? Math.round(long / this.aspect) : long;
    const vw = Math.max(32, Math.round(W / 4)), vh = Math.max(32, Math.round(H / 4));

    const old = { wet: this.wet, dry: this.dry };
    this.wet = this.double(W, H);
    this.dry = this.double(W, H);
    this.vel = this.double(vw, vh);
    this.pres = this.double(vw, vh);
    this.div = this.target(vw, vh);
    this.free(this.paper);
    this.paper = this.target(W, H, { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE });
    this.texel = [1 / W, 1 / H];
    this.velTexel = [1 / vw, 1 / vh];

    this.use(this.prog.paper, {}, { uAspect: this.aspect });
    this.draw(this.paper);
    // Carry the painting across a resize.
    if (old.wet) {
      this.use(this.prog.copy, { uTex: old.wet.a.tex }); this.draw(this.wet.a);
      this.use(this.prog.copy, { uTex: old.dry.a.tex }); this.draw(this.dry.a);
      this.freeDouble(old.wet); this.freeDouble(old.dry);
    }
  }

  clear() {
    for (const t of [this.wet.a, this.wet.b, this.dry.a, this.dry.b, this.vel.a, this.vel.b]) {
      this.use(this.prog.clear, {}, { uValue: [0, 0, 0, 0] });
      this.draw(t);
    }
  }

  // ---- painting -------------------------------------------------------------
  /**
   * Queue a splat. x,y in 0..1 (y up). r relative to screen height.
   * water: added water (≈0.3 damp … 1.2 flooding). A: absorbance rgb. amount: pigment load.
   * push: outward velocity, swirl: tangential ratio, soft: 0..1 edge softness.
   */
  splat(s) { this.pending.push(s); }

  flushSplats() {
    const gl = this.gl;
    while (this.pending.length) {
      const batch = this.pending.splice(0, MAXS);
      const A = new Float32Array(MAXS * 4), B = new Float32Array(MAXS * 4), C = new Float32Array(MAXS * 4), AV = new Float32Array(MAXS * 4);
      batch.forEach((s, i) => {
        A.set([s.x, s.y, s.r, s.water ?? 0.6], i * 4);
        const pig = s.A || [0, 0, 0];
        B.set([pig[0], pig[1], pig[2], s.amount ?? 0], i * 4);
        C.set([s.seed ?? Math.random() * 100, s.soft ?? 0.75, s.rag ?? 0.12, s.swirl ?? 0], i * 4);
        AV.set([s.x, s.y, s.r, s.push ?? 0], i * 4);
      });
      this.use(this.prog.splatWet, { uWet: this.wet.a.tex }, { uAspect: this.aspect, uCount: { int: batch.length }, uA: A, uB: B, uC: C });
      this.draw(this.wet.b); this.wet.swap();
      this.use(this.prog.splatVel, { uVel: this.vel.a.tex }, { uAspect: this.aspect, uCount: { int: batch.length }, uA: AV, uC: C });
      this.draw(this.vel.b); this.vel.swap();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  step(dt) {
    const gl = this.gl, p = this.params;
    dt = Math.min(dt, 1 / 30);
    this.time += dt;
    this.nightT += (this.night - this.nightT) * (1 - Math.exp(-dt * 1.5));
    this.flushSplats();

    // Fluid.
    this.use(this.prog.advectVel, { uVel: this.vel.a.tex, uWet: this.wet.a.tex },
      { uTexel: this.velTexel, uDt: dt, uTime: this.time, uFlow: p.flow, uAspect: this.aspect });
    this.draw(this.vel.b); this.vel.swap();
    this.use(this.prog.div, { uVel: this.vel.a.tex }, { uTexel: this.velTexel });
    this.draw(this.div);
    this.use(this.prog.clear, {}, { uValue: [0, 0, 0, 0] }); this.draw(this.pres.a);
    for (let i = 0; i < 18; i++) {
      this.use(this.prog.pressure, { uP: this.pres.a.tex, uDiv: this.div.tex }, { uTexel: this.velTexel });
      this.draw(this.pres.b); this.pres.swap();
    }
    this.use(this.prog.grad, { uP: this.pres.a.tex, uVel: this.vel.a.tex }, { uTexel: this.velTexel });
    this.draw(this.vel.b); this.vel.swap();

    // Pigment (MRT: wet + dry in one pass).
    this.use(this.prog.pigment, { uWet: this.wet.a.tex, uDry: this.dry.a.tex, uVel: this.vel.a.tex, uPaper: this.paper.tex }, {
      uTexel: this.texel, uVelTexel: this.velTexel, uGrav: p.gravity, uDt: dt, uTime: this.time, uAspect: this.aspect,
      uEvap: p.evap, uDrip: p.drip, uFade: p.fade, uFloor: p.floor, uGhost: p.ghost, uLift: p.lift, uDeposit: p.deposit,
    });
    if (!this.mrt) this.mrt = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mrt);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.wet.b.tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.dry.b.tex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, this.wet.b.w, this.wet.b.h);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.wet.swap(); this.dry.swap();
  }

  render() {
    this.use(this.prog.display, { uWet: this.wet.a.tex, uDry: this.dry.a.tex, uPaper: this.paper.tex }, {
      uTexel: this.texel, uRes: [this.canvas.width, this.canvas.height], uNight: this.nightT, uTime: this.time, uAspect: this.aspect,
    });
    this.draw(null);
  }
}
