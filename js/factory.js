// Built-in sounds generated at boot (deterministic), so the instrument plays before
// any user samples are loaded. Not persisted: regenerated every start.

import { TABLE_SIZE } from './audio/wavetable.js';

const N = TABLE_SIZE;
const TAU = Math.PI * 2;

function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cycle = f => { const a = new Float32Array(N); for (let i = 0; i < N; i++) a[i] = f(i / N); return a; };

function additive(amps) {
  return cycle(x => {
    let s = 0;
    for (let k = 1; k < amps.length; k++) if (amps[k]) s += amps[k] * Math.sin(TAU * k * x);
    return s;
  });
}

function table(frames, fn) {
  const a = new Float32Array(N * frames);
  for (let f = 0; f < frames; f++) for (let i = 0; i < N; i++) a[f * N + i] = fn(f / (frames - 1), i / N);
  return a;
}

const shapes = [
  x => Math.sin(TAU * x),
  x => (x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4),
  x => 1 - 2 * x,
  x => (x < 0.5 ? 1 : -1),
];

function normalize(arrs, peak = 0.9) {
  let m = 0;
  for (const a of arrs) for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  if (m > 0) for (const a of arrs) for (let i = 0; i < a.length; i++) a[i] *= peak / m;
  return arrs;
}

/** Soft, band-limited saw table used by the texture generator. */
const SOFT_SAW = additive(Array.from({ length: 14 }, (_, k) => (k ? 1 / k : 0)));

function texture(sr) {
  const len = Math.floor(sr * 6);
  const L = new Float32Array(len), R = new Float32Array(len);
  const rnd = rng(7);
  // A minor 9 pad, 3 detuned voices per note, slow independent swells
  const notes = [45, 52, 55, 59, 60, 64];
  for (const [ni, n] of notes.entries()) {
    const f0 = 440 * Math.pow(2, (n - 69) / 12);
    for (let d = 0; d < 3; d++) {
      const det = Math.pow(2, ((d - 1) * 9 + (rnd() - 0.5) * 4) / 1200);
      const pan = (d - 1) * 0.6 + (rnd() - 0.5) * 0.3;
      const rate = 0.15 + rnd() * 0.35, ph0 = rnd();
      let ph = rnd(), lp = 0;
      const inc = f0 * det / sr;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const x = ph * N, xi = x | 0, xf = x - xi;
        const v = SOFT_SAW[xi] + xf * (SOFT_SAW[(xi + 1) & (N - 1)] - SOFT_SAW[xi]);
        ph += inc; if (ph >= 1) ph -= 1;
        const cut = 0.02 + 0.06 * (0.5 + 0.5 * Math.sin(TAU * (t * 0.11 + ni * 0.13)));
        lp += cut * (v - lp);
        const amp = 0.06 * (0.55 + 0.45 * Math.sin(TAU * (t * rate + ph0)));
        L[i] += lp * amp * (1 - pan) * 0.5;
        R[i] += lp * amp * (1 + pan) * 0.5;
      }
    }
  }
  // FM bell plinks
  for (let b = 0; b < 14; b++) {
    const start = Math.floor(rnd() * (len - sr * 1.6));
    const f = 440 * Math.pow(2, ([69, 72, 76, 79, 81, 84, 88][(rnd() * 7) | 0] - 69) / 12);
    const pan = rnd() * 2 - 1, dur = Math.floor(sr * 1.5), amp = 0.12 + rnd() * 0.1;
    for (let i = 0; i < dur && start + i < len; i++) {
      const t = i / sr;
      const env = Math.exp(-t * 3.2);
      const v = Math.sin(TAU * f * t + 2.5 * env * Math.sin(TAU * f * 3.5 * t)) * env * amp;
      L[start + i] += v * (1 - pan) * 0.5;
      R[start + i] += v * (1 + pan) * 0.5;
    }
  }
  // breathy noise wash through a swept band-pass
  let lo = 0, bp = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const fc = 600 + 2400 * (0.5 + 0.5 * Math.sin(TAU * t * 0.17));
    const g = 2 * Math.sin(Math.PI * fc / sr);
    const nz = rnd() * 2 - 1;
    lo += g * bp; const hi = nz - lo - 0.6 * bp; bp += g * hi;
    const a = 0.05 * (0.5 + 0.5 * Math.sin(TAU * t * 0.23));
    L[i] += bp * a; R[i] += bp * a * 0.8;
  }
  // gentle fade at the edges so grains wrapping the buffer stay smooth
  const fade = Math.floor(sr * 0.05);
  for (let i = 0; i < fade; i++) { const g = i / fade; L[i] *= g; R[i] *= g; L[len - 1 - i] *= g; R[len - 1 - i] *= g; }
  return normalize([L, R], 0.85);
}

function glass(sr) {
  const len = Math.floor(sr * 3.5);
  const L = new Float32Array(len), R = new Float32Array(len);
  const parts = [[1, 1, 1.6], [2.32, 0.6, 2.2], [4.25, 0.4, 3], [6.63, 0.25, 4], [9.38, 0.15, 5.5], [13.1, 0.08, 7]];
  const f0 = 523.25;
  for (const [ri, [r, a, dk]] of parts.entries()) {
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.min(1, t * 200) * Math.exp(-t * dk * 0.5);
      const sh = 1 + 0.002 * Math.sin(TAU * t * (0.7 + ri * 0.3));
      L[i] += Math.sin(TAU * f0 * r * sh * t) * a * env;
      R[i] += Math.sin(TAU * f0 * r * (2 - sh) * t + ri) * a * env;
    }
  }
  return normalize([L, R], 0.85);
}

function noise(sr) {
  const rnd = rng(3);
  const a = new Float32Array(Math.floor(sr));
  for (let i = 0; i < a.length; i++) a[i] = (rnd() * 2 - 1) * 0.7;
  return [a];
}

function kick(sr) {
  const len = Math.floor(sr * 0.6);
  const a = new Float32Array(len);
  const rnd = rng(11);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const f = 44 + 140 * Math.exp(-t * 28);
    ph += f / sr;
    const click = t < 0.004 ? (rnd() * 2 - 1) * (1 - t / 0.004) * 0.4 : 0;
    a[i] = Math.tanh(1.6 * Math.sin(TAU * ph) * Math.exp(-t * 5.5)) + click;
  }
  return normalize([a], 0.95);
}

function snare(sr) {
  const len = Math.floor(sr * 0.35);
  const a = new Float32Array(len);
  const rnd = rng(5);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const n = rnd() * 2 - 1;
    lp += 0.5 * (n - lp);
    const body = Math.sin(TAU * 185 * t) * Math.exp(-t * 28) * 0.8;
    a[i] = body + (n - lp * 0.6) * Math.exp(-t * 16) * 0.7;
  }
  return normalize([a], 0.9);
}

function vox() {
  const f = 110;
  const formants = [[730, 1, 90], [1090, 0.55, 110], [2440, 0.3, 170]];
  const amps = [0];
  for (let k = 1; k <= 64; k++) {
    const hz = k * f;
    let a = 0.08 / k;
    for (const [c, g, w] of formants) a += g * Math.exp(-((hz - c) ** 2) / (2 * w * w));
    amps.push(a);
  }
  return additive(amps);
}

/** @returns {Array<{slot:number,name:string,ch:Float32Array[],sr:number,kind:string,clm?:number}>} */
export function factorySounds(sr = 44100) {
  const C = (slot, name, data) => ({ slot, name, ch: normalize([data]), sr, kind: 'cycle' });
  const W = (slot, name, data) => ({ slot, name, ch: normalize([data]), sr, kind: 'cycle', clm: N });
  const S = (slot, name, ch) => ({ slot, name, ch, sr, kind: 'sample' });
  return [
    C(0, 'SINE', cycle(shapes[0])),
    C(1, 'TRIANGLE', cycle(shapes[1])),
    C(2, 'SAW', cycle(shapes[2])),
    C(3, 'SQUARE', cycle(shapes[3])),
    C(4, 'PULSE25', cycle(x => (x < 0.25 ? 1 : -1))),
    C(5, 'ORGAN', additive([0, 1, 0.8, 0.6, 0.5, 0, 0.3, 0, 0.25])),
    C(6, 'VOX', vox()),
    W(7, 'PWM WT', table(32, (t, x) => (x < 0.5 - 0.45 * t ? 1 : -1))),
    W(8, 'FM WT', table(32, (t, x) => Math.sin(TAU * x + t * 5 * Math.sin(TAU * 2 * x)))),
    W(9, 'SHAPES WT', table(32, (t, x) => {
      const s = t * 3, i = Math.min(2, Math.floor(s)), f = s - i;
      return shapes[i](x) * (1 - f) + shapes[i + 1](x) * f;
    })),
    S(10, 'TEXTURE', texture(sr)),
    S(11, 'GLASS', glass(sr)),
    S(12, 'NOISE', noise(sr)),
    S(13, 'KICK', kick(sr)),
    S(14, 'SNARE', snare(sr)),
  ];
}
