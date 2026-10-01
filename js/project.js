// Project data model. Plain JSON-serialisable objects.
//
// project.tracks[i]   sound + routing for track i (kit is shared by all patterns)
// project.patterns[p] sequence data: per-track length/scale + sparse steps {index: step}
// step = { locks: { paramId: value } }  (a present step is an active trig)

import { NUM_TRACKS, NUM_PATTERNS, DEFAULT_SCALE, defaultTrackParams, defaultFxParams, M_WAVE, M_SMPL, M_GRAN } from './params.js';

export function newPatternTrack() { return { len: 16, scale: DEFAULT_SCALE, steps: {} }; }
export function newPattern() {
  return { len: 16, swing: 50, tracks: Array.from({ length: NUM_TRACKS }, newPatternTrack) };
}
export function newTrack(i) {
  return { name: 'T' + (i + 1), p: defaultTrackParams(), inCh: 0, outCh: 0, int: 1, mute: false };
}

export function newProject() {
  const pr = {
    v: 1,
    name: 'UNTITLED',
    bpm: 120,
    master: 90,
    tracks: Array.from({ length: NUM_TRACKS }, (_, i) => newTrack(i)),
    patterns: Array.from({ length: NUM_PATTERNS }, newPattern),
    current: 0,
    fx: defaultFxParams(),
    kb: { oct: 0, root: 0, scale: 0 },
    song: [],
  };
  return pr;
}

export const step = (locks = {}) => ({ locks });
export const patName = i => 'ABCD'[Math.floor(i / 16)] + String((i % 16) + 1).padStart(2, '0');

export function patternHasContent(pat) {
  return pat.tracks.some(t => Object.keys(t.steps).length > 0);
}

export function clone(o) { return JSON.parse(JSON.stringify(o)); }

/** Fill in fields missing from older / hand-edited project files. */
export function migrate(pr) {
  const base = newProject();
  const out = Object.assign(base, pr);
  out.tracks = base.tracks.map((t, i) => {
    const src = (pr.tracks || [])[i] || {};
    return { ...t, ...src, p: { ...t.p, ...(src.p || {}) } };
  });
  out.patterns = Array.from({ length: NUM_PATTERNS }, (_, i) => {
    const src = (pr.patterns || [])[i];
    const pat = newPattern();
    if (!src) return pat;
    pat.len = src.len ?? 16;
    pat.swing = src.swing ?? 50;
    pat.tracks = pat.tracks.map((t, j) => ({ ...t, ...((src.tracks || [])[j] || {}) }));
    return pat;
  });
  out.fx = { ...defaultFxParams(), ...(pr.fx || {}) };
  out.kb = { ...base.kb, ...(pr.kb || {}) };
  return out;
}

/** First-run demo: drums + bass + pad + granular texture, using factory slots. */
export function demoProject() {
  const pr = newProject();
  pr.name = 'DEMO';
  pr.bpm = 112;
  const T = (i, o) => Object.assign(pr.tracks[i].p, o);
  // T1 kick (SMPL)
  T(0, { mach: M_SMPL, smp: 13, poly: 1, dec: 90, sus: 127, rel: 60, vol: 110 });
  // T2 snare (SMPL) with a little reverb
  T(1, { mach: M_SMPL, smp: 14, poly: 2, rev: 40, vol: 90 });
  // T3 hats: noise, short AHD, high-pass
  T(2, { mach: M_SMPL, smp: 12, poly: 2, amod: 1, dec: 22, ftyp: 3, freq: 104, reso: 20, vol: 70, pan: -12 });
  // T4 bass: SAW, mono glide, LP4 with envelope
  T(3, { mach: M_WAVE, smp: 2, poly: 1, port: 40, ftyp: 1, freq: 40, reso: 50, fenv: 30, fdec: 50, fsus: 10, dec: 70, sus: 90, rel: 30, uni: 2, dtun: 30, vol: 88 });
  // T5 pad: PWM wavetable, LFO on WPOS, delay + reverb
  T(4, { mach: M_WAVE, smp: 7, poly: 6, atk: 70, dec: 80, sus: 100, rel: 85, uni: 4, dtun: 40, sprd: 110, freq: 88, reso: 15,
    l1dst: 6, l1wav: 1, l1spd: 30, l1dep: 40, dly: 50, rev: 70, vol: 60, len: 13 });
  // T6 granular texture cloud
  T(5, { mach: M_GRAN, smp: 10, poly: 2, atk: 80, rel: 90, gpos: 30, gsiz: 85, gden: 80, gspr: 30, gscn: 4, gpsp: 90,
    gpjt: 24, gjmd: 1, rev: 90, vol: 70, len: 18 });
  // T7 FM wavetable lead with vibrato
  T(6, { mach: M_WAVE, smp: 8, poly: 4, wpos: 40, atk: 10, dec: 60, sus: 70, rel: 50, freq: 95, dly: 60, vol: 64,
    l1dst: 1, l1wav: 1, l1spd: 70, l1dep: 1, l1fad: 70, l2dst: 6, l2wav: 0, l2spd: 20, l2dep: 30 });
  // T8 glass grains, sparse
  T(7, { mach: M_GRAN, smp: 11, poly: 3, gsiz: 50, gden: 60, gspr: 60, gpsp: 127, grev: 30, gwin: 3, rev: 100, dly: 40, vol: 55, len: 11 });
  pr.fx.drev = 30;

  const pat = pr.patterns[0];
  const S = (tr, idx, locks = {}) => { pat.tracks[tr].steps[idx] = step(locks); };
  for (const i of [0, 4, 8, 12]) S(0, i);
  S(0, 14, { vel: 70 });
  S(1, 4); S(1, 12); S(1, 15, { vel: 50, cond: 5 });
  for (let i = 0; i < 16; i++) if (i % 2 === 1) S(2, i, { vel: i % 4 === 3 ? 100 : 60 });
  S(2, 14, { vel: 50, prob: 50 });
  const bass = [[0, 33], [3, 33], [6, 45], [8, 31], [10, 31], [11, 43], [14, 36]];
  for (const [i, n] of bass) S(3, i, { note: n });
  S(3, 6, { note: 45, len: 3 });
  S(4, 0, { note: 57 });
  S(4, 8, { note: 55 });
  S(5, 0, { note: 60 });
  S(6, 2, { note: 76, len: 9 }); S(6, 7, { note: 79, len: 7 }); S(6, 10, { note: 74, len: 9, cond: 6 });
  S(7, 5, { note: 72 }); S(7, 13, { note: 79, prob: 60 });
  return pr;
}
