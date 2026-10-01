// Headless tests: run the AudioWorklet processor in Node with a shimmed global scope,
// plus wavetable, WAV sniffing and sequencer logic. `npm test` (node >= 18).

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultTrackParams, trackPhys, M_WAVE, M_SMPL, M_GRAN, PARAMS } from '../js/params.js';
import { buildWavetable, fft } from '../js/audio/wavetable.js';
import { factorySounds } from '../js/factory.js';
import { sniffWav } from '../js/pool.js';
import { Sequencer } from '../js/sequencer.js';
import { newProject, step } from '../js/project.js';

// ---- AudioWorkletGlobalScope shim ------------------------------------------------------
const SR = 48000;
globalThis.sampleRate = SR;
globalThis.currentFrame = 0;
let Proc = null;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: m => this.port.sent.push(m), sent: [], onmessage: null }; } };
globalThis.registerProcessor = (_name, cls) => { Proc = cls; };
await import('../js/audio/worklet.js');

const SOUNDS = Object.fromEntries(factorySounds(44100).map(s => [s.name, s]));

function makeEngine() {
  globalThis.currentFrame = 0;
  const p = new Proc();
  const send = m => p.port.onmessage({ data: m });
  const load = (slot, s) => {
    const len = s.ch[0].length;
    const wt = s.kind === 'cycle' ? buildWavetable(s.ch[0], s.clm || len, s.clm ? Math.floor(len / s.clm) : 1) : null;
    send({ t: 'smp', slot, s: { ch: s.ch, sr: s.sr, len, wt } });
  };
  const track = (tr, over) => send({ t: 'trk', tr, p: trackPhys({ ...defaultTrackParams(), ...over }) });
  const render = seconds => {
    const blocks = Math.ceil(seconds * SR / 128);
    const L = new Float32Array(blocks * 128), R = new Float32Array(blocks * 128);
    for (let b = 0; b < blocks; b++) {
      const outs = [0, 1, 2].map(() => [new Float32Array(128), new Float32Array(128)]);
      p.process([], outs);
      L.set(outs[0][0], b * 128); R.set(outs[0][1], b * 128);
      globalThis.currentFrame += 128;
    }
    return { L, R };
  };
  const active = () => p.voices.filter(v => v.on).length;
  return { p, send, load, track, render, active };
}

const stats = a => {
  let peak = 0, sum = 0, nan = false;
  for (const v of a) { if (!Number.isFinite(v)) nan = true; peak = Math.max(peak, Math.abs(v)); sum += v * v; }
  return { peak, rms: Math.sqrt(sum / a.length), nan };
};

function zeroCrossFreq(a, from = 0) {
  let n = 0, first = -1, last = -1;
  for (let i = from + 1; i < a.length; i++) {
    if (a[i - 1] < 0 && a[i] >= 0) { if (first < 0) first = i; last = i; n++; }
  }
  return (n - 1) / ((last - first) / SR);
}

// ---- tests -----------------------------------------------------------------------------

test('WAVE machine plays a band-limited saw at the right pitch', () => {
  const e = makeEngine();
  e.load(2, SOUNDS.SAW);
  e.track(0, { mach: M_WAVE, smp: 2 });
  e.send({ t: 'on', tr: 0, n: 69, vel: 1, time: null, dur: 0, locks: null });
  const { L } = e.render(0.5);
  const s = stats(L);
  assert.equal(s.nan, false);
  assert.ok(s.rms > 0.1, 'audible: rms ' + s.rms);
  assert.ok(s.peak < 2, 'bounded: peak ' + s.peak);
  const f = zeroCrossFreq(L, 4800);
  assert.ok(Math.abs(f - 440) < 2, 'A4 = 440Hz, got ' + f);
});

test('wavetable mip levels drop harmonics (top level is a pure sine)', () => {
  const saw = SOUNDS.SAW.ch[0];
  const wt = buildWavetable(saw, saw.length, 1);
  assert.equal(wt.levelH[0], 1024);
  assert.equal(wt.levelH.at(-1), 1);
  const top = wt.levels.at(-1).subarray(0, 2048);
  const re = Float64Array.from(top), im = new Float64Array(2048);
  fft(re, im, false);
  const mag = k => Math.hypot(re[k], im[k]);
  assert.ok(mag(1) > 100, 'fundamental present');
  for (let k = 2; k < 50; k++) assert.ok(mag(k) < 1e-6 * mag(1), 'harmonic ' + k + ' removed');
});

test('non power-of-two single cycles (AKWF 600 samples) are resynthesised exactly', () => {
  const f = x => Math.sin(2 * Math.PI * x) + 0.3 * Math.sin(2 * Math.PI * 3 * x);
  const cyc = Float32Array.from({ length: 600 }, (_, i) => f(i / 600));
  const wt = buildWavetable(cyc, 600, 1);
  const ref = Array.from({ length: 2048 }, (_, i) => f(i / 2048));
  const k = 0.9 / Math.max(...ref.map(Math.abs));
  let err = 0;
  for (let i = 0; i < 2048; i++) err = Math.max(err, Math.abs(wt.levels[0][i] - ref[i] * k));
  assert.ok(err < 1e-3, 'max error ' + err);
});

test('wavetable position morphs between frames', () => {
  const e = makeEngine();
  e.load(7, SOUNDS['PWM WT']);
  e.track(0, { mach: M_WAVE, smp: 7, wpos: 0 });
  e.send({ t: 'on', tr: 0, n: 48, vel: 1, time: null, dur: 0 });
  const a = stats(e.render(0.3).L);
  e.send({ t: 'prm', tr: 0, k: 'wpos', v: 1 });
  const b = stats(e.render(0.3).L);
  assert.equal(a.nan || b.nan, false);
  assert.notEqual(a.rms.toFixed(3), b.rms.toFixed(3), 'timbre changes with WPOS');
});

test('unison spreads voices in stereo', () => {
  const e = makeEngine();
  e.load(2, SOUNDS.SAW);
  e.track(0, { mach: M_WAVE, smp: 2, uni: 5, dtun: 80, sprd: 127 });
  e.send({ t: 'on', tr: 0, n: 57, vel: 1, time: null, dur: 0 });
  const { L, R } = e.render(0.4);
  let diff = 0;
  for (let i = 0; i < L.length; i++) diff += Math.abs(L[i] - R[i]);
  assert.ok(diff / L.length > 0.01, 'L and R differ');
});

test('SMPL one-shot ends and frees its voice; LOOP keeps playing', () => {
  const e = makeEngine();
  e.load(13, SOUNDS.KICK);
  e.track(0, { mach: M_SMPL, smp: 13, mode: 0 });
  e.send({ t: 'on', tr: 0, n: 60, vel: 1, time: null, dur: 0 });
  const s = stats(e.render(0.2).L);
  assert.ok(s.rms > 0.05 && !s.nan);
  e.render(0.6);
  assert.equal(e.active(), 0, 'voice released at sample end');

  e.track(0, { mach: M_SMPL, smp: 13, mode: 2, strt: 10, end: 40 });
  e.send({ t: 'on', tr: 0, n: 60, vel: 1, time: null, dur: 0 });
  e.render(1.5);
  assert.equal(e.active(), 1, 'looping voice still alive');
});

test('GRAN machine produces a stable grain cloud and posts grain positions', () => {
  const e = makeEngine();
  e.load(10, SOUNDS.TEXTURE);
  e.track(0, { mach: M_GRAN, smp: 10, gden: 110, gsiz: 70, gspr: 60, gpjt: 40, gjmd: 2, grev: 30, gscn: 20 });
  e.send({ t: 'viz', tr: 0 });
  e.send({ t: 'on', tr: 0, n: 60, vel: 1, time: null, dur: 0 });
  const { L, R } = e.render(1.0);
  const s = stats(L), r = stats(R);
  assert.equal(s.nan || r.nan, false);
  assert.ok(s.rms > 0.01, 'cloud audible: ' + s.rms);
  assert.ok(s.peak < 3, 'normalised: ' + s.peak);
  const viz = e.p.port.sent.filter(m => m.t === 'viz');
  assert.ok(viz.length > 5);
  assert.ok(viz.some(m => m.heads.length > 4), 'grain heads reported');
});

test('every grain window and emit mode renders cleanly', () => {
  for (let win = 0; win < 6; win++) {
    for (const gemt of [0, 1]) {
      const e = makeEngine();
      e.load(11, SOUNDS.GLASS);
      e.track(0, { mach: M_GRAN, smp: 11, gwin: win, gemt, gsiz: 10, gden: 127 });
      e.send({ t: 'on', tr: 0, n: 72, vel: 1, time: null, dur: 0 });
      const s = stats(e.render(0.3).L);
      assert.equal(s.nan, false, `win ${win} emit ${gemt}`);
      assert.ok(s.rms > 0.001, `win ${win} emit ${gemt} audible`);
    }
  }
});

test('filters stay stable at max resonance with envelope + LFO sweeps', () => {
  for (let ftyp = 0; ftyp < 5; ftyp++) {
    const e = makeEngine();
    e.load(2, SOUNDS.SAW);
    e.track(0, { mach: M_WAVE, smp: 2, ftyp, reso: 127, freq: 60, fenv: 63, fdec: 40, l1dst: 2, l1dep: 63, l1spd: 110, driv: 80, br: 60, srr: 40 });
    e.send({ t: 'on', tr: 0, n: 36, vel: 1, time: null, dur: 0 });
    const s = stats(e.render(0.5).L);
    assert.equal(s.nan, false, 'type ' + ftyp);
    assert.ok(s.peak < 8, `type ${ftyp} peak ${s.peak}`);
  }
});

test('note off releases; poly limit steals the oldest voice', () => {
  const e = makeEngine();
  e.load(0, SOUNDS.SINE);
  e.track(0, { mach: M_WAVE, smp: 0, rel: 10, poly: 2 });
  e.send({ t: 'on', tr: 0, n: 60, vel: 1, time: null, dur: 0 });
  e.send({ t: 'on', tr: 0, n: 64, vel: 1, time: null, dur: 0 });
  e.send({ t: 'on', tr: 0, n: 67, vel: 1, time: null, dur: 0 });
  e.render(0.05);
  assert.equal(e.active(), 2, 'poly 2');
  e.send({ t: 'off', tr: 0, n: 64, time: null });
  e.send({ t: 'off', tr: 0, n: 67, time: null });
  e.render(0.2);
  assert.equal(e.active(), 0, 'released');
});

test('scheduled notes start sample-accurately and honour duration', () => {
  const e = makeEngine();
  e.load(0, SOUNDS.SINE);
  e.track(0, { mach: M_WAVE, smp: 0, rel: 0 });
  const t = 1000 / SR; // frame 1000 (inside block 7)
  e.send({ t: 'on', tr: 0, n: 60, vel: 1, time: t, dur: 0.05 });
  const { L } = e.render(0.2);
  let first = -1;
  for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > 1e-6) { first = i; break; }
  assert.ok(first >= 1000 && first <= 1002, 'starts at frame 1000, got ' + first);
  assert.equal(e.active(), 0, 'gate closed after dur');
});

test('p-locks override track params for one voice only', () => {
  const e = makeEngine();
  e.load(0, SOUNDS.SINE);
  e.track(0, { mach: M_WAVE, smp: 0 });
  e.send({ t: 'on', tr: 0, n: 60, vel: 1, time: null, dur: 0, locks: { tune: PARAMS.tune.phys(12) } });
  const { L } = e.render(0.3);
  const f = zeroCrossFreq(L, 4800);
  assert.ok(Math.abs(f - 523.25) < 2, 'locked +12 → C5, got ' + f);
  assert.equal(e.p.tracks[0].p.tune, 0, 'track value untouched');
});

test('sniffWav reads sample rate and Serum clm chunk', () => {
  const clm = new TextEncoder().encode('<!>2048 01000000 wavetable');
  const buf = new ArrayBuffer(12 + 24 + 8 + clm.length + (clm.length & 1) + 8);
  const dv = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); dv.setUint32(4, buf.byteLength - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 3, true); dv.setUint16(22, 1, true); dv.setUint32(24, 44100, true);
  str(36, 'clm '); dv.setUint32(40, clm.length, true); new Uint8Array(buf, 44).set(clm);
  const info = sniffWav(buf);
  assert.equal(info.sr, 44100);
  assert.equal(info.clm, 2048);
  assert.equal(sniffWav(new ArrayBuffer(4)), null);
});

// ---- sequencer --------------------------------------------------------------------------

function fakeApp() {
  const trigs = [];
  const app = {
    project: newProject(),
    state: { fill: false, song: false, quantize: true, follow: true },
    engine: { now: -1, ctx: { resume() {} }, syncLfo() {}, allOff() {}, audibleTime: () => 0 },
    midi: { realtime() {}, clockTick() {}, panicOut() {} },
    trigger: (i, note, vel, time, dur, locks) => trigs.push({ i, note, vel, time, dur, locks }),
    release() {}, invalidate() {}, onPatternChanged() {}, changed() {}, setBpm() {},
  };
  const seq = new Sequencer(app);
  seq.timer.stop();
  return { app, seq, trigs };
}

function run(seq, steps) {
  seq.playing = true;
  for (let t = 0; t < steps * 24; t++) seq.processTick(t * seq.tickDur);
}

test('sequencer: four-on-the-floor lands on quarter notes', () => {
  const { app, seq, trigs } = fakeApp();
  app.project.bpm = 120;
  const pt = app.project.patterns[0].tracks[0];
  for (const i of [0, 4, 8, 12]) pt.steps[i] = step();
  run(seq, 32);
  assert.equal(trigs.length, 8);
  trigs.forEach((t, k) => assert.ok(Math.abs(t.time - k * 0.5) < 1e-9, `beat ${k} at ${t.time}`));
});

test('sequencer: conditions, probability, swing, micro timing, scale', () => {
  const { app, seq, trigs } = fakeApp();
  const pat = app.project.patterns[0];
  pat.tracks[0].steps[0] = step({ cond: 5 });       // 1:2
  pat.tracks[1].steps[0] = step({ prob: 0 });
  pat.tracks[2].steps[1] = step();                  // odd step → swung
  pat.swing = 75;
  pat.tracks[3].steps[2] = step({ micro: 12 });     // half a step late
  pat.tracks[4].scale = 6;                          // 2X: 32 steps in 16 1X-steps
  pat.tracks[4].len = 32;
  pat.tracks[4].steps[30] = step();
  run(seq, 64);
  const by = i => trigs.filter(t => t.i === i);
  assert.equal(by(0).length, 2, '1:2 plays every other loop of 4');
  assert.equal(by(1).length, 0, 'prob 0 never plays');
  const sd = seq.tickDur * 24;
  assert.ok(Math.abs(by(2)[0].time - (sd + 0.5 * sd)) < 1e-9, 'swing 75% delays odd steps by half a step');
  assert.ok(Math.abs(by(3)[0].time - (2 * sd + 0.5 * sd)) < 1e-9, 'micro +12/24');
  assert.ok(Math.abs(by(4)[0].time - 15 * sd) < 1e-9, '2X scale: step 31 lands at 1X position 15');
});

test('sequencer: queued pattern switches at master length', () => {
  const { app, seq, trigs } = fakeApp();
  app.project.patterns[0].tracks[0].steps[0] = step({ note: 40 });
  app.project.patterns[1].tracks[0].steps[0] = step({ note: 50 });
  seq.playing = true;
  seq.queued = 1;
  run(seq, 32);
  assert.deepEqual(trigs.map(t => t.note), [40, 50]);
  assert.equal(app.project.current, 1);
});
