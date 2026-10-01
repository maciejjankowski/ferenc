// Step sequencer: lookahead scheduler ("two clocks" pattern) running on a worker timer,
// 96 PPQN internal resolution, per-track length/scale (polymeter), swing, micro-timing,
// trig conditions, probability, parameter locks, live recording and MIDI clock in/out.

import { NUM_TRACKS, SCALES, LEN_STEPS, TICKS_PER_STEP, CONDS } from './params.js';
import { step } from './project.js';

const LOOKAHEAD = 0.12;     // seconds scheduled ahead
const INTERVAL = 25;        // ms between scheduler runs
const CLOCK_LATENCY = 0.03; // s added to incoming MIDI clock so events land in the future

function makeTimer(cb) {
  try {
    const src = 'let id=null;onmessage=e=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data)}';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = cb;
    return { start: () => w.postMessage(INTERVAL), stop: () => w.postMessage(0) };
  } catch {
    let id = 0;
    return { start: () => { clearInterval(id); id = setInterval(cb, INTERVAL); }, stop: () => clearInterval(id) };
  }
}

const freshTrack = () => ({ tick: 0, step: -1, started: false, loops: 0, inf: null });

export class Sequencer {
  constructor(app) {
    this.app = app;
    this.playing = false;
    this.paused = false;
    this.tick = 0;
    this.patTick = 0;
    this.nextTime = 0;
    this.queued = null;
    this.chainPos = 0;
    this.trk = Array.from({ length: NUM_TRACKS }, freshTrack);
    this.history = Array.from({ length: NUM_TRACKS }, () => []);
    this.skip = new Set();
    this.extClock = false;
    this.clockTimes = [];
    this.timer = makeTimer(() => this.pump());
    this.timer.start();
  }

  get project() { return this.app.project; }
  get pattern() { return this.project.patterns[this.project.current]; }
  get tickDur() { return 60 / this.project.bpm / 96; }
  get engine() { return this.app.engine; }

  stepDur(i) { return SCALES[this.pattern.tracks[i].scale].t * this.tickDur; }

  resetPositions() {
    this.tick = 0;
    this.patTick = 0;
    this.trk = Array.from({ length: NUM_TRACKS }, freshTrack);
    this.history.forEach(h => (h.length = 0));
    this.skip.clear();
  }

  start({ resume = false, at = null } = {}) {
    const eng = this.engine;
    if (!eng.ctx) return;
    eng.ctx.resume();
    if (!resume) {
      this.resetPositions();
      const pr = this.project;
      if (this.app.state.song && pr.song.length) { this.chainPos = 0; pr.current = pr.song[0]; }
      if (this.queued !== null) { pr.current = this.queued; this.queued = null; }
    }
    this.playing = true;
    this.paused = false;
    this.app.state.follow = true;
    this.nextTime = at ?? eng.now + 0.06;
    if (!resume) eng.syncLfo(this.nextTime);
    if (!this.extClock) this.app.midi.realtime(resume ? 0xFB : 0xFA, this.nextTime);
    this.app.invalidate();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.paused = true;
    this.releaseInf();
    this.engine.allOff(false);
    if (!this.extClock) this.app.midi.realtime(0xFC);
    this.app.midi.panicOut();
    this.app.invalidate();
  }

  stop() {
    const wasRunning = this.playing || this.paused;
    this.playing = false;
    this.paused = false;
    this.releaseInf();
    this.engine.allOff(!wasRunning);
    if (!this.extClock && wasRunning) this.app.midi.realtime(0xFC);
    this.app.midi.panicOut();
    this.resetPositions();
    if (this.queued !== null) { this.project.current = this.queued; this.queued = null; this.app.onPatternChanged(); }
    this.app.invalidate();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.start({ resume: this.paused });
  }

  releaseInf() {
    for (let i = 0; i < NUM_TRACKS; i++) {
      const st = this.trk[i];
      if (st.inf !== null) { this.app.release(i, st.inf, null); st.inf = null; }
    }
  }

  /** Select a pattern: immediate when stopped, at the next master-length boundary while playing. */
  selectPattern(idx) {
    if (this.playing) this.queued = idx === this.project.current ? null : idx;
    else { this.project.current = idx; this.queued = null; this.resetPositions(); this.app.onPatternChanged(); }
    this.app.invalidate();
  }

  pump() {
    if (!this.playing || this.extClock) return;
    const now = this.engine.now;
    if (this.nextTime < now - 0.25) this.nextTime = now + 0.01; // recover after a stall (tab sleep)
    const horizon = now + LOOKAHEAD;
    while (this.nextTime < horizon) {
      this.processTick(this.nextTime);
      this.nextTime += this.tickDur;
    }
  }

  nextPatternIndex() {
    if (this.queued !== null) { const q = this.queued; this.queued = null; return q; }
    const pr = this.project;
    if (this.app.state.song && pr.song.length) {
      this.chainPos = (this.chainPos + 1) % pr.song.length;
      return pr.song[this.chainPos];
    }
    return null;
  }

  processTick(time) {
    const pr = this.project;
    if (this.tick % 4 === 0 && !this.extClock) this.app.midi.clockTick(time);

    if (this.patTick >= this.pattern.len * TICKS_PER_STEP) {
      this.patTick = 0;
      const next = this.nextPatternIndex();
      if (next !== null && next !== pr.current) {
        pr.current = next;
        this.trk.forEach((st, i) => { this.trk[i] = { ...freshTrack(), inf: st.inf }; });
        this.skip.clear();
        this.app.onPatternChanged();
      } else {
        for (const st of this.trk) { st.tick = 0; st.step = -1; }
      }
    }

    const pat = this.pattern;
    for (let i = 0; i < NUM_TRACKS; i++) {
      const st = this.trk[i], pt = pat.tracks[i];
      const tps = SCALES[pt.scale].t;
      if (st.tick % tps === 0) {
        st.step = st.step < 0 ? 0 : (st.step + 1) % pt.len;
        if (st.step === 0) { if (st.started) st.loops++; st.started = true; }
        const h = this.history[i];
        h.push([time, st.step]);
        if (h.length > 24) h.shift();
        this.trigStep(i, st, pt, time, tps * this.tickDur);
      }
      st.tick++;
    }
    this.tick++;
    this.patTick++;
  }

  condOk(c, st) {
    const name = CONDS[c] || '---';
    switch (name) {
      case '---': return true;
      case 'FILL': return this.app.state.fill;
      case '!FILL': return !this.app.state.fill;
      case '1ST': return st.loops === 0;
      case '!1ST': return st.loops > 0;
      default: {
        const [a, b] = name.split(':').map(Number);
        return st.loops % b === a - 1;
      }
    }
  }

  trigStep(i, st, pt, time, stepDur) {
    const s = pt.steps[st.step];
    if (!s) return;
    const tr = this.project.tracks[i];
    if (tr.mute) return;
    if (this.skip.has(s)) { this.skip.delete(s); return; }
    const L = s.locks, P = tr.p;
    const prob = L.prob ?? P.prob;
    if (prob < 100 && Math.random() * 100 >= prob) return;
    if (!this.condOk(L.cond ?? P.cond, st)) return;
    let t = time;
    if (st.step % 2 === 1) t += (this.pattern.swing - 50) / 50 * stepDur;
    t += (L.micro ?? P.micro) / 24 * stepDur;
    t = Math.max(t, this.engine.now + 0.002);
    const note = L.note ?? P.note;
    const vel = L.vel ?? P.vel;
    const len = LEN_STEPS[L.len ?? P.len];
    if (st.inf !== null) { this.app.release(i, st.inf, t); st.inf = null; }
    const dur = Number.isFinite(len) ? len * stepDur : 0;
    if (!dur) st.inf = note;
    this.app.trigger(i, note, vel, t, dur, L);
  }

  /** The step currently audible on track i (for the UI playhead), or -1. */
  audibleStep(i) {
    if (!this.playing) return -1;
    const now = this.engine.audibleTime();
    const h = this.history[i];
    for (let k = h.length - 1; k >= 0; k--) if (h[k][0] <= now) return h[k][1];
    return -1;
  }

  // ---- live recording ------------------------------------------------------------

  recordNote(i, note, vel) {
    if (!this.playing) return null;
    const pt = this.pattern.tracks[i];
    const stepDur = this.stepDur(i);
    const now = this.engine.audibleTime();
    const h = this.history[i];
    let entry = null;
    for (let k = h.length - 1; k >= 0; k--) if (h[k][0] <= now) { entry = h[k]; break; }
    if (!entry) return null;
    const [t, s] = entry;
    const frac = (now - t) / stepDur;
    let idx = s, micro = 0;
    if (this.app.state.quantize) {
      if (frac >= 0.5) idx = (s + 1) % pt.len;
    } else {
      micro = Math.round(frac * 24);
      if (micro > 11) { idx = (s + 1) % pt.len; micro -= 24; }
      micro = Math.max(-23, Math.min(23, micro));
    }
    const stp = pt.steps[idx] || (pt.steps[idx] = step());
    Object.assign(stp.locks, { note, vel });
    if (micro) stp.locks.micro = micro; else delete stp.locks.micro;
    if (idx !== s && this.trk[i].step === s) this.skip.add(stp);
    this.app.changed();
    return { stp, start: now, stepDur };
  }

  recordNoteOff(rec) {
    if (!rec) return;
    const held = (this.engine.audibleTime() - rec.start) / rec.stepDur;
    let best = 0, bestD = Infinity;
    for (let k = 0; k < LEN_STEPS.length - 1; k++) {
      const d = Math.abs(Math.log(Math.max(0.05, held) / LEN_STEPS[k]));
      if (d < bestD) { bestD = d; best = k; }
    }
    rec.stp.locks.len = best;
    this.app.changed();
  }

  // ---- external MIDI clock -----------------------------------------------------------

  clockIn(perf) {
    if (!this.extClock) return;
    const time = this.engine.fromPerf(perf) + CLOCK_LATENCY;
    const ct = this.clockTimes;
    ct.push(time);
    if (ct.length > 25) ct.shift();
    let dt = this.tickDur * 4;
    if (ct.length >= 3) {
      dt = (ct[ct.length - 1] - ct[0]) / (ct.length - 1);
      const bpm = Math.round(600 / (dt * 24)) / 10;
      if (bpm >= 20 && bpm <= 400 && Math.abs(bpm - this.project.bpm) >= 0.3) this.app.setBpm(bpm, false);
    }
    if (!this.playing) return;
    for (let k = 0; k < 4; k++) this.processTick(Math.max(time + k * dt / 4, this.engine.now));
  }

  extStart() { this.clockTimes.length = 0; this.start({ resume: false }); }
  extContinue() { this.start({ resume: true }); }
  extStop() { if (this.playing) this.pause(); }
}
