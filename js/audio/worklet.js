/* global sampleRate, currentFrame, registerProcessor, AudioWorkletProcessor */
// Ferenc DSP engine. Runs in the AudioWorkletGlobalScope, self-contained (no imports).
//
// Signal path per voice:
//   source (WAVE | SMPL | GRAN) -> LEV -> SRR -> BR -> SVF filter -> drive -> amp env -> pan
//   -> out 0 (main), out 1 (delay send), out 2 (reverb send)
//
// All parameters arrive already converted to physical units (see js/params.js).

const NUM_TRACKS = 8;
const MAX_VOICES = 96;
const MAX_GRAINS = 40;
const BLOCK = 128;
const CR = 32;              // control-rate sub-block (LFO, pitch, filter coefficients)
const TAU = Math.PI * 2;
const WIN_N = 1024;
const SILENCE = 1e-4;
const VIZ_EVERY = 12;       // blocks between visualisation posts (~32ms @48k)

const M_WAVE = 0, M_SMPL = 1, M_GRAN = 2;
// LFO destinations — keep in sync with LFO_DESTS in params.js
const D_PTCH = 1, D_FREQ = 2, D_RESO = 3, D_AMP = 4, D_PAN = 5, D_WPOS = 6, D_STRT = 7,
  D_GPOS = 8, D_SIZE = 9, D_DENS = 10, D_SPRY = 11, D_DRIV = 12, NUM_DEST = 13;

const LFO_KEYS = [1, 2].map(k => ({
  spd: `l${k}spd`, syn: `l${k}syn`, dst: `l${k}dst`, wav: `l${k}wav`,
  sph: `l${k}sph`, mod: `l${k}mod`, fad: `l${k}fad`, dep: `l${k}dep`,
}));

const WINDOWS = (() => {
  const mk = f => {
    const t = new Float32Array(WIN_N + 1);
    for (let i = 0; i <= WIN_N; i++) t[i] = f(i / WIN_N);
    return t;
  };
  return [
    mk(x => 0.5 - 0.5 * Math.cos(TAU * x)),                              // HANN
    mk(x => 1 - Math.abs(2 * x - 1)),                                     // TRI
    mk(x => Math.min(1, x * 8, (1 - x) * 8)),                             // TRAP
    mk(x => Math.min(1, x * 60) * Math.exp(-5 * x)),                      // PERC
    mk(x => Math.min(1, (1 - x) * 60) * Math.exp(-5 * (1 - x))),          // RPRC
    mk(x => Math.min(1, x * 200, (1 - x) * 200)),                         // RECT (declicked)
  ];
})();

const OCT5 = [0, 7, 12, 19, 24, -5, -12, -17, -24];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function fastTanh(x) {
  if (x < -3) return -1;
  if (x > 3) return 1;
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}

function hash01(n) {
  n |= 0;
  n = (n ^ 61) ^ (n >>> 16);
  n = (n + (n << 3)) | 0;
  n ^= n >>> 4;
  n = Math.imul(n, 0x27d4eb2d);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}

function lfoWave(shape, ph, cyc) {
  switch (shape) {
    case 0: return ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;  // TRI
    case 1: return Math.sin(TAU * ph);                                        // SINE
    case 2: return ph < 0.5 ? 1 : -1;                                         // SQR
    case 3: return 1 - 2 * ph;                                                // SAW (falling)
    case 4: return 2 * ph - 1;                                                // RAMP (rising)
    case 5: return Math.exp(-6 * ph);                                         // EXP (unipolar decay)
    case 6: return hash01(cyc) * 2 - 1;                                       // RND (S&H)
    case 7: {                                                                 // SMTH
      const a = hash01(cyc) * 2 - 1, b = hash01(cyc + 1) * 2 - 1;
      const t = 0.5 - 0.5 * Math.cos(Math.PI * ph);
      return a + (b - a) * t;
    }
  }
  return 0;
}

class Grain {
  constructor() {
    this.on = false; this.pos = 0; this.rate = 1; this.t = 0; this.inc = 1;
    this.gl = 1; this.gr = 1; this.amp = 1; this.win = WINDOWS[0]; this.off = 0;
  }
}

class Voice {
  constructor() {
    this.on = false; this.track = 0; this.note = 60; this.vel = 1; this.prm = null;
    this.start = 0; this.relAt = Infinity; this.released = false; this.age = 0;
    this.kill = false; this.killGain = 1;
    this.aSt = 0; this.aLvl = 0; this.fSt = 0; this.fLvl = 0;
    this.glide = 60;
    this.ph = new Float64Array(7);
    this.pos = 0; this.dir = 1; this.rs = 0; this.re = 0; this.ls = 0; this.le = 0; this.srcDone = false;
    this.scan = 0; this.nextGrain = 0; this.center = 0;
    this.grains = Array.from({ length: MAX_GRAINS }, () => new Grain());
    this.fz = new Float64Array(8);
    this.srrN = 0; this.srrL = 0; this.srrR = 0;
    this.lfoSeed = new Int32Array(2);
  }
}

class FerencEngine extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tracks = Array.from({ length: NUM_TRACKS }, () => ({ p: {}, bend: 0, last: null, peak: 0 }));
    this.samples = [];
    this.voices = Array.from({ length: MAX_VOICES }, () => new Voice());
    this.queue = [];
    this.bpm = 120;
    this.syncFrame = 0;
    this.age = 0;
    this.bufL = new Float32Array(CR);
    this.bufR = new Float32Array(CR);
    this.mods = new Float64Array(NUM_DEST);
    this.vizTrack = 0;
    this.vizCount = 0;
    this.port.onmessage = e => this.onMsg(e.data);
  }

  onMsg(m) {
    switch (m.t) {
      case 'smp': this.samples[m.slot] = m.s; break;
      case 'smpdel': this.samples[m.slot] = undefined; break;
      // mutate in place: live voices use the track params as their prototype
      case 'trk': Object.assign(this.tracks[m.tr].p, m.p); break;
      case 'prm': this.tracks[m.tr].p[m.k] = m.v; break;
      case 'on': case 'off': this.enqueue(m); break;
      case 'alloff': this.allOff(m.hard); break;
      case 'bend': this.tracks[m.tr].bend = m.v; break;
      case 'bpm': this.bpm = m.v; break;
      case 'sync': this.syncFrame = Math.round(m.time * sampleRate); break;
      case 'viz': this.vizTrack = m.tr; break;
    }
  }

  enqueue(m) {
    m.frame = m.time == null ? 0 : Math.round(m.time * sampleRate);
    const q = this.queue;
    let i = q.length;
    while (i > 0 && q[i - 1].frame > m.frame) i--;
    q.splice(i, 0, m);
  }

  allOff(hard) {
    this.queue.length = 0;
    for (const v of this.voices) {
      if (!v.on) continue;
      if (hard) { v.kill = true; } else if (v.relAt === Infinity) { v.relAt = 0; }
    }
  }

  // ---- voice allocation --------------------------------------------------------

  noteOn(m, f) {
    const tr = this.tracks[m.tr];
    const base = tr.p;
    if (base.mach === undefined) return;
    const P = Object.create(base);
    if (m.locks) for (const k in m.locks) P[k] = m.locks[k];

    const poly = Math.max(1, P.poly | 0);
    const mine = [];
    for (const v of this.voices) if (v.on && !v.kill && v.track === m.tr) mine.push(v);
    if (mine.length >= poly) {
      mine.sort((a, b) => a.age - b.age);
      for (let i = 0; i <= mine.length - poly; i++) mine[i].kill = true;
    }

    let v = null;
    for (const c of this.voices) if (!c.on) { v = c; break; }
    if (!v) {
      for (const c of this.voices) if (!v || (c.released && !v.released) || (c.released === v.released && c.age < v.age)) v = c;
    }

    v.on = true; v.track = m.tr; v.note = m.n; v.vel = m.vel; v.prm = P;
    v.start = f; v.relAt = m.dur > 0 ? f + Math.max(1, Math.round(m.dur * sampleRate)) : Infinity;
    v.released = false; v.kill = false; v.killGain = 1; v.age = ++this.age;
    v.aSt = 0; v.aLvl = 0; v.fSt = 0; v.fLvl = 0;
    v.glide = P.port > 0 && tr.last !== null ? tr.last : m.n;
    tr.last = m.n;
    const uni = P.uni | 0;
    for (let u = 0; u < 7; u++) v.ph[u] = uni > 1 ? Math.random() : 0;
    v.fz.fill(0);
    v.srrN = 0; v.srrL = 0; v.srrR = 0;
    v.lfoSeed[0] = (Math.random() * 1e6) | 0;
    v.lfoSeed[1] = (Math.random() * 1e6) | 0;
    v.srcDone = false;

    const smp = this.samples[P.smp | 0];
    const mach = P.mach | 0;
    if (smp && mach === M_SMPL) {
      this.mods.fill(0);
      this.evalLfos(v, P, f);
      const len = smp.len;
      let a = clamp(P.strt + this.mods[D_STRT], 0, 1), b = P.end;
      if (b < a) { const t = a; a = b; b = t; }
      v.rs = Math.floor(a * (len - 1));
      v.re = Math.max(v.rs + 1, Math.floor(b * (len - 1)));
      const span = v.re - v.rs;
      v.ls = v.rs + P.lpos * span;
      v.le = v.re - P.lpos * span;
      const rev = P.mode === 1 || P.mode === 3;
      v.pos = rev ? v.re : v.rs;
      v.dir = rev ? -1 : 1;
    } else if (mach === M_GRAN) {
      v.scan = 0; v.nextGrain = 0;
      for (const g of v.grains) g.on = false;
    }
  }

  noteOff(m, f) {
    for (const v of this.voices) {
      if (v.on && !v.kill && v.track === m.tr && v.note === m.n && v.relAt === Infinity) v.relAt = f;
    }
  }

  // ---- modulation --------------------------------------------------------------

  evalLfos(v, P, fAbs) {
    const mods = this.mods;
    for (let k = 0; k < 2; k++) {
      const K = LFO_KEYS[k];
      const dst = P[K.dst] | 0;
      const dep = P[K.dep];
      if (!dst || !dep) continue;
      const sync = P[K.syn];
      const rate = sync > 0 ? (this.bpm / 60) / sync : P[K.spd];
      const mode = P[K.mod] | 0;
      let x;
      if (mode === 0) {
        x = P[K.sph] + (fAbs - this.syncFrame) * rate / sampleRate;
      } else {
        const el = Math.max(0, fAbs - v.start) * rate / sampleRate;
        x = P[K.sph] + (mode === 2 && el >= 1 ? 0.99999 : el);
      }
      let cyc = Math.floor(x);
      const ph = x - cyc;
      if (mode !== 0) cyc += v.lfoSeed[k];
      let val = lfoWave(P[K.wav] | 0, ph, cyc) * dep;
      const fad = P[K.fad];
      if (fad > 0) val *= Math.min(1, Math.max(0, fAbs - v.start) / (fad * sampleRate));
      mods[dst] += val;
    }
  }

  // ---- render ------------------------------------------------------------------

  process(inputs, outputs) {
    const main = outputs[0], dly = outputs[1], rev = outputs[2];
    const mL = main[0], mR = main[1] || main[0];
    const dL = dly[0], dR = dly[1] || dly[0];
    const rL = rev[0], rR = rev[1] || rev[0];
    mL.fill(0); mR.fill(0); dL.fill(0); dR.fill(0); rL.fill(0); rR.fill(0);

    const t0 = currentFrame, t1 = t0 + BLOCK;
    const q = this.queue;
    while (q.length && q[0].frame < t1) {
      const m = q.shift();
      const f = Math.max(m.frame, t0);
      if (m.t === 'on') this.noteOn(m, f); else this.noteOff(m, f);
    }

    for (const v of this.voices) if (v.on) this.renderVoice(v, t0, mL, mR, dL, dR, rL, rR);

    if (++this.vizCount >= VIZ_EVERY) {
      this.vizCount = 0;
      this.postViz();
    }
    return true;
  }

  postViz() {
    const heads = [];
    const cent = [];
    for (const v of this.voices) {
      if (!v.on || v.track !== this.vizTrack) continue;
      const smp = this.samples[v.prm.smp | 0];
      if (!smp) continue;
      const mach = v.prm.mach | 0;
      if (mach === M_SMPL) {
        heads.push(v.pos / smp.len, v.aLvl);
      } else if (mach === M_GRAN) {
        cent.push(v.center);
        for (const g of v.grains) if (g.on) heads.push(g.pos / smp.len, g.win[Math.min(WIN_N, g.t | 0)] * v.aLvl);
      } else {
        cent.push(v.ph[0]);
      }
    }
    const peaks = new Float32Array(NUM_TRACKS);
    for (let i = 0; i < NUM_TRACKS; i++) { peaks[i] = this.tracks[i].peak; this.tracks[i].peak = 0; }
    this.port.postMessage({ t: 'viz', tr: this.vizTrack, heads, cent, peaks });
  }

  renderVoice(v, t0, mL, mR, dL, dR, rL, rR) {
    let i = v.start > t0 ? v.start - t0 : 0;
    if (i >= BLOCK) return;
    const P = v.prm;
    const tr = this.tracks[v.track];
    const smp = this.samples[P.smp | 0];
    if (!smp) { v.on = false; return; }
    const sr = sampleRate;
    const mach = P.mach | 0;
    const bufL = this.bufL, bufR = this.bufR, mods = this.mods;

    // envelopes (block rate)
    const ahd = (P.amod | 0) === 1;
    const aInc = 1 / Math.max(1, P.atk * sr);
    const aDec = Math.exp(-6.9 / Math.max(1, P.dec * sr));
    const aRel = Math.exp(-9.2 / Math.max(1, P.rel * sr));
    const aSus = ahd ? 0 : P.sus;
    const fInc = 1 / Math.max(1, P.fatk * sr);
    const fDec = Math.exp(-6.9 / Math.max(1, P.fdec * sr));
    const fRel = Math.exp(-9.2 / Math.max(1, P.frel * sr));
    const fSus = P.fsus;

    const velGain = 1 - P.vels + P.vels * v.vel * v.vel;
    const vol = P.vol * velGain;
    const dSend = P.dly, rSend = P.rev, lev = P.lev;
    const q = P.br > 0 ? Math.pow(2, P.br - 1) : 0;
    const srrN = P.srr > 1.01 ? P.srr : 0;
    const ftype = P.ftyp | 0;

    while (i < BLOCK) {
      const n = Math.min(CR, BLOCK - i);
      const fAbs = t0 + i;

      mods.fill(0);
      this.evalLfos(v, P, fAbs);

      if (P.port > 0) v.glide += (v.note - v.glide) * (1 - Math.exp(-n / (P.port * sr)));
      else v.glide = v.note;
      const pitch = v.glide + P.tune + P.fine + tr.bend + mods[D_PTCH] * 12;

      bufL.fill(0, 0, n);
      bufR.fill(0, 0, n);
      if (mach === M_WAVE) this.srcWave(v, P, smp, pitch, n);
      else if (mach === M_SMPL) this.srcSample(v, P, smp, pitch, n);
      else this.srcGran(v, P, smp, pitch, n);

      // filter coefficients (TPT state-variable filter)
      const cut = P.freq + P.fenv * v.fLvl + mods[D_FREQ] * 64;
      const fc = clamp(440 * Math.pow(2, (cut - 69) / 12), 16, sr * 0.45);
      const g = Math.tan(Math.PI * fc / sr);
      const k = 2 - 2 * clamp(P.reso + mods[D_RESO], 0, 0.995);
      const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
      const k2 = 1.4142;
      const b1 = 1 / (1 + g * (g + k2)), b2 = g * b1, b3 = g * b2;

      const pan = clamp(P.pan + mods[D_PAN], -1, 1);
      const gl = pan > 0 ? 1 - pan : 1, gr = pan < 0 ? 1 + pan : 1;
      const drv = clamp(P.driv + mods[D_DRIV], 0, 1);
      const dg = 1 + drv * drv * 24;
      const useDrv = drv > 0.001;
      const ampMod = mods[D_AMP] !== 0 ? clamp(1 + mods[D_AMP], 0, 2) : 1;

      const fz = v.fz;
      let s1L = fz[0], s2L = fz[1], s1R = fz[2], s2R = fz[3], u1L = fz[4], u2L = fz[5], u1R = fz[6], u2R = fz[7];
      let aLvl = v.aLvl, aSt = v.aSt, fLvl = v.fLvl, fSt = v.fSt;
      let peak = 0;

      for (let j = 0; j < n; j++) {
        if (!v.released && fAbs + j >= v.relAt) {
          v.released = true;
          if (!ahd) aSt = 3;
          fSt = 3;
        }
        // amp envelope
        if (aSt === 0) { aLvl += aInc; if (aLvl >= 1) { aLvl = 1; aSt = 1; } }
        else if (aSt === 1) {
          aLvl = aSus + (aLvl - aSus) * aDec;
          if (aLvl - aSus < 1e-5) { aLvl = aSus; aSt = aSus < SILENCE ? 4 : 2; }
        } else if (aSt === 2) aLvl = aSus;
        else if (aSt === 3) { aLvl *= aRel; if (aLvl < SILENCE) { aLvl = 0; aSt = 4; } }
        else aLvl = 0;
        // filter envelope
        if (fSt === 0) { fLvl += fInc; if (fLvl >= 1) { fLvl = 1; fSt = 1; } }
        else if (fSt === 1) { fLvl = fSus + (fLvl - fSus) * fDec; if (fLvl - fSus < 1e-5) { fLvl = fSus; fSt = 2; } }
        else if (fSt === 3) fLvl *= fRel;

        let xL = bufL[j] * lev, xR = bufR[j] * lev;
        if (srrN) {
          if (v.srrN <= 0) { v.srrL = xL; v.srrR = xR; v.srrN += srrN; }
          v.srrN -= 1;
          xL = v.srrL; xR = v.srrR;
        }
        if (q) { xL = Math.round(xL * q) / q; xR = Math.round(xR * q) / q; }

        // SVF, left
        let v3 = xL - s2L;
        let v1 = a1 * s1L + a2 * v3;
        let v2 = s2L + a2 * s1L + a3 * v3;
        s1L = 2 * v1 - s1L; s2L = 2 * v2 - s2L;
        let yL;
        if (ftype === 0) yL = v2;
        else if (ftype === 1) {
          const w3 = v2 - u2L, w1 = b1 * u1L + b2 * w3, w2 = u2L + b2 * u1L + b3 * w3;
          u1L = 2 * w1 - u1L; u2L = 2 * w2 - u2L; yL = w2;
        } else if (ftype === 2) yL = v1;
        else if (ftype === 3) yL = xL - k * v1 - v2;
        else yL = xL - k * v1;
        // SVF, right
        v3 = xR - s2R;
        v1 = a1 * s1R + a2 * v3;
        v2 = s2R + a2 * s1R + a3 * v3;
        s1R = 2 * v1 - s1R; s2R = 2 * v2 - s2R;
        let yR;
        if (ftype === 0) yR = v2;
        else if (ftype === 1) {
          const w3 = v2 - u2R, w1 = b1 * u1R + b2 * w3, w2 = u2R + b2 * u1R + b3 * w3;
          u1R = 2 * w1 - u1R; u2R = 2 * w2 - u2R; yR = w2;
        } else if (ftype === 2) yR = v1;
        else if (ftype === 3) yR = xR - k * v1 - v2;
        else yR = xR - k * v1;

        if (useDrv) { yL = fastTanh(yL * dg); yR = fastTanh(yR * dg); }

        let gain = aLvl * vol * ampMod;
        if (v.kill) {
          v.killGain -= 1 / 96;
          if (v.killGain <= 0) { v.killGain = 0; aSt = 4; }
          gain *= v.killGain;
        }
        if (gain > peak) peak = gain;
        const oL = yL * gain * gl, oR = yR * gain * gr;
        const o = i + j;
        mL[o] += oL; mR[o] += oR;
        if (dSend) { dL[o] += oL * dSend; dR[o] += oR * dSend; }
        if (rSend) { rL[o] += oL * rSend; rR[o] += oR * rSend; }
      }

      // flush denormals / blow-ups
      if (!(Math.abs(s1L) < 1e6)) { s1L = s2L = s1R = s2R = u1L = u2L = u1R = u2R = 0; }
      fz[0] = s1L; fz[1] = s2L; fz[2] = s1R; fz[3] = s2R; fz[4] = u1L; fz[5] = u2L; fz[6] = u1R; fz[7] = u2R;
      v.aLvl = aLvl; v.aSt = aSt; v.fLvl = fLvl; v.fSt = fSt;
      if (peak > tr.peak) tr.peak = peak;

      if (aSt === 4 || v.srcDone) { v.on = false; return; }
      i += n;
    }
  }

  // WAVE: band-limited (mip-mapped) single-cycle / wavetable oscillator with unison
  srcWave(v, P, smp, pitch, n) {
    const wt = smp.wt || this.rawTable(smp);
    const bufL = this.bufL, bufR = this.bufR;
    const uni = clamp(P.uni | 0, 1, 7);
    const base = 440 * Math.pow(2, (pitch - 69) / 12);
    const det = uni > 1 ? P.dtun : 0;
    const maxF = base * Math.pow(2, det / 2400);
    const cyc = wt.cyc;
    let lvl = 0;
    const H = wt.levelH;
    if (H) {
      const hmax = sampleRate * 0.5 / maxF;
      while (lvl < H.length - 1 && H[lvl] > hmax) lvl++;
    }
    const tbl = wt.levels[lvl];
    const stride = cyc + 1;
    const wp = clamp(P.wpos + this.mods[D_WPOS], 0, 1) * (wt.frames - 1);
    const f0 = wp | 0;
    const f1 = Math.min(f0 + 1, wt.frames - 1);
    const ff = wp - f0;
    const o0 = f0 * stride, o1 = f1 * stride;
    const norm = 1 / Math.sqrt(uni);
    const spread = P.sprd;
    for (let u = 0; u < uni; u++) {
      const sp = uni > 1 ? (u / (uni - 1)) * 2 - 1 : 0;
      let inc = base * Math.pow(2, sp * det / 2400) / sampleRate;
      if (inc >= 1) inc -= Math.floor(inc);
      const pan = sp * spread;
      const gl = (pan > 0 ? 1 - pan : 1) * norm, gr = (pan < 0 ? 1 + pan : 1) * norm;
      let ph = v.ph[u];
      for (let j = 0; j < n; j++) {
        const x = ph * cyc;
        const ix = x | 0;
        const fr = x - ix;
        let s = tbl[o0 + ix] + fr * (tbl[o0 + ix + 1] - tbl[o0 + ix]);
        if (ff > 0) {
          const s1 = tbl[o1 + ix] + fr * (tbl[o1 + ix + 1] - tbl[o1 + ix]);
          s += ff * (s1 - s);
        }
        bufL[j] += s * gl;
        bufR[j] += s * gr;
        ph += inc;
        if (ph >= 1) ph -= 1;
      }
      v.ph[u] = ph;
    }
  }

  // A long sample used as an oscillator: treat the whole buffer as one cycle (no mips).
  rawTable(smp) {
    if (!smp.raw) {
      const src = smp.ch[0];
      const t = new Float32Array(src.length + 1);
      t.set(src);
      t[src.length] = src[0];
      smp.raw = { cyc: src.length, frames: 1, levelH: null, levels: [t] };
    }
    return smp.raw;
  }

  // SMPL: classic sample playback with start/end/loop
  srcSample(v, P, smp, pitch, n) {
    if (v.srcDone) return;
    const bufL = this.bufL, bufR = this.bufR;
    const ch0 = smp.ch[0], ch1 = smp.ch[1] || ch0, len = smp.len;
    const rate = Math.pow(2, (pitch - 60) / 12) * smp.sr / sampleRate;
    const mode = P.mode | 0;
    const rs = v.rs, re = v.re, ls = v.ls, le = v.le;
    let pos = v.pos, dir = v.dir;
    for (let j = 0; j < n; j++) {
      const ip = pos | 0;
      const fr = pos - ip;
      const i2 = ip + 1 < len ? ip + 1 : ip;
      bufL[j] = ch0[ip] + fr * (ch0[i2] - ch0[ip]);
      bufR[j] = ch1[ip] + fr * (ch1[i2] - ch1[ip]);
      pos += rate * dir;
      if (mode === 0) { if (pos >= re) { v.srcDone = true; break; } }
      else if (mode === 1) { if (pos < rs) { v.srcDone = true; break; } }
      else if (mode === 2) { if (pos >= re) pos = ls + (pos - re) % Math.max(1, re - ls); }
      else if (mode === 3) { if (pos < rs) pos = le - (rs - pos) % Math.max(1, le - rs); }
      else if (dir > 0 && pos >= re) { pos = re - (pos - re); dir = -1; }
      else if (dir < 0 && pos < ls) { pos = ls + (ls - pos); dir = 1; }
      pos = clamp(pos, 0, len - 1);
    }
    v.pos = pos; v.dir = dir;
  }

  // GRAN: asynchronous / synchronous granular cloud over the sample
  srcGran(v, P, smp, pitch, n) {
    const len = smp.len;
    if (len < 2) return;
    const bufL = this.bufL, bufR = this.bufR, mods = this.mods;
    const ch0 = smp.ch[0], ch1 = smp.ch[1] || ch0;
    const ratio = smp.sr / sampleRate;
    const rate = Math.pow(2, (pitch - 60) / 12) * ratio;

    v.scan += P.gscn * n * ratio / len;
    v.scan -= Math.floor(v.scan);
    let center = P.gpos + mods[D_GPOS] + v.scan;
    center -= Math.floor(center);
    v.center = center;
    const spray = clamp(P.gspr + mods[D_SPRY], 0, 1);
    const sizeSec = clamp(P.gsiz * Math.pow(2, mods[D_SIZE] * 4), 0.002, 4);
    const dens = clamp(P.gden * Math.pow(2, mods[D_DENS] * 4), 0.25, 1000);
    const sizeF = sizeSec * sampleRate;
    const amp = 1 / Math.sqrt(Math.max(1, dens * sizeSec * 0.5));
    const mean = sampleRate / dens;

    while (v.nextGrain < n) {
      this.spawnGrain(v, P, len, center, spray, rate, sizeF, amp, Math.max(0, v.nextGrain | 0));
      v.nextGrain += (P.gemt | 0) === 1 ? mean : Math.max(1, -Math.log(1 - Math.random()) * mean);
    }
    v.nextGrain -= n;

    for (const g of v.grains) {
      if (!g.on) continue;
      let pos = g.pos, t = g.t;
      const inc = g.inc, r = g.rate, w = g.win;
      const gl = g.gl * g.amp, gr = g.gr * g.amp;
      for (let j = g.off; j < n; j++) {
        if (t >= WIN_N) { g.on = false; break; }
        const wv = w[t | 0];
        const ip = pos | 0;
        const fr = pos - ip;
        const i2 = ip + 1 >= len ? 0 : ip + 1;
        bufL[j] += (ch0[ip] + fr * (ch0[i2] - ch0[ip])) * wv * gl;
        bufR[j] += (ch1[ip] + fr * (ch1[i2] - ch1[ip])) * wv * gr;
        pos += r;
        if (pos >= len) pos -= len; else if (pos < 0) pos += len;
        t += inc;
      }
      g.pos = pos; g.t = t; g.off = 0;
    }
  }

  spawnGrain(v, P, len, center, spray, rate, sizeF, amp, off) {
    let g = null;
    for (const c of v.grains) if (!c.on) { g = c; break; }
    if (!g) return;
    let p = center + (Math.random() * 2 - 1) * spray * 0.5;
    p -= Math.floor(p);
    g.pos = p * (len - 1);
    let semis = 0;
    const pj = P.gpjt;
    if (pj > 0) {
      const mode = P.gjmd | 0;
      if (mode === 0) semis = (Math.random() * 2 - 1) * pj;
      else if (mode === 1) semis = 12 * Math.round((Math.random() * 2 - 1) * Math.floor(pj / 12 + 0.5));
      else {
        const opts = OCT5.filter(x => Math.abs(x) <= pj);
        semis = opts[(Math.random() * opts.length) | 0];
      }
    }
    g.rate = rate * Math.pow(2, semis / 12) * (Math.random() < P.grev ? -1 : 1);
    g.t = 0;
    g.inc = WIN_N / Math.max(1, sizeF);
    g.win = WINDOWS[P.gwin | 0] || WINDOWS[0];
    g.amp = amp;
    const pan = (Math.random() * 2 - 1) * P.gpsp;
    g.gl = pan > 0 ? 1 - pan : 1;
    g.gr = pan < 0 ? 1 + pan : 1;
    g.off = off;
    g.on = true;
  }
}

registerProcessor('ferenc-engine', FerencEngine);
