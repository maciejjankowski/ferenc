// Main-thread side of the audio engine: AudioContext, the DSP worklet, send FX and master bus.

import { FX_PARAMS, DELAY_DIVS } from '../params.js';

class Delay {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    const split = ctx.createChannelSplitter(2);
    this.input.connect(split);
    const G = v => { const g = ctx.createGain(); g.gain.value = v; return g; };
    this.dl = ctx.createDelay(5); this.dr = ctx.createDelay(5);
    this.hpL = ctx.createBiquadFilter(); this.hpR = ctx.createBiquadFilter();
    this.lpL = ctx.createBiquadFilter(); this.lpR = ctx.createBiquadFilter();
    for (const f of [this.hpL, this.hpR]) { f.type = 'highpass'; f.Q.value = 0.5; }
    for (const f of [this.lpL, this.lpR]) { f.type = 'lowpass'; f.Q.value = 0.5; }
    // input routing (normal vs ping-pong) is done with gains so it never needs reconnecting
    this.inLL = G(1); this.inRR = G(1); this.inRL = G(0);
    split.connect(this.inLL, 0); split.connect(this.inRR, 1); split.connect(this.inRL, 1);
    this.inLL.connect(this.dl); this.inRR.connect(this.dr); this.inRL.connect(this.dl);
    this.dl.connect(this.hpL).connect(this.lpL);
    this.dr.connect(this.hpR).connect(this.lpR);
    this.fbLL = G(0); this.fbLR = G(0); this.fbRR = G(0); this.fbRL = G(0);
    this.lpL.connect(this.fbLL).connect(this.dl);
    this.lpL.connect(this.fbLR).connect(this.dr);
    this.lpR.connect(this.fbRR).connect(this.dr);
    this.lpR.connect(this.fbRL).connect(this.dl);
    // stereo width matrix
    this.wLL = G(1); this.wLR = G(0); this.wRL = G(0); this.wRR = G(1);
    const merge = ctx.createChannelMerger(2);
    this.lpL.connect(this.wLL).connect(merge, 0, 0);
    this.lpL.connect(this.wLR).connect(merge, 0, 1);
    this.lpR.connect(this.wRL).connect(merge, 0, 0);
    this.lpR.connect(this.wRR).connect(merge, 0, 1);
    this.output = G(1);
    this.revSend = G(0);
    merge.connect(this.output);
    merge.connect(this.revSend);
  }

  set(p, bpm) {
    const t = this.ctx.currentTime, P = (id) => FX_PARAMS[id].phys(p[id]);
    const time = Math.min(4.9, DELAY_DIVS[p.dtim].b * 60 / bpm);
    this.dl.delayTime.setTargetAtTime(time, t, 0.03);
    this.dr.delayTime.setTargetAtTime(time, t, 0.03);
    const fb = P('dfb'), pp = p.dx === 1;
    const s = (g, v) => g.gain.setTargetAtTime(v, t, 0.01);
    s(this.inLL, pp ? 0.5 : 1); s(this.inRR, pp ? 0 : 1); s(this.inRL, pp ? 0.5 : 0);
    s(this.fbLL, pp ? 0 : fb); s(this.fbRR, pp ? 0 : fb); s(this.fbLR, pp ? fb : 0); s(this.fbRL, pp ? fb : 0);
    const w = P('dwid');
    s(this.wLL, (1 + w) / 2); s(this.wRR, (1 + w) / 2); s(this.wLR, (1 - w) / 2); s(this.wRL, (1 - w) / 2);
    for (const f of [this.hpL, this.hpR]) f.frequency.setTargetAtTime(P('dhp'), t, 0.02);
    for (const f of [this.lpL, this.lpR]) f.frequency.setTargetAtTime(P('dlp'), t, 0.02);
    s(this.output, P('dvol'));
    s(this.revSend, P('drev'));
  }
}

class Reverb {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.pre = ctx.createDelay(1);
    this.conv = ctx.createConvolver();
    this.conv.normalize = false;
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass';
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass';
    this.output = ctx.createGain();
    this.input.connect(this.pre).connect(this.conv).connect(this.hp).connect(this.lp).connect(this.output);
    this.irKey = '';
    this.timer = 0;
  }

  set(p) {
    const t = this.ctx.currentTime, P = (id) => FX_PARAMS[id].phys(p[id]);
    this.pre.delayTime.setTargetAtTime(P('rpre'), t, 0.02);
    this.hp.frequency.setTargetAtTime(P('rhp'), t, 0.02);
    this.lp.frequency.setTargetAtTime(P('rlp'), t, 0.02);
    this.output.gain.setTargetAtTime(P('rvol'), t, 0.02);
    const key = p.rdec + ':' + p.rdmp;
    if (key !== this.irKey) {
      this.irKey = key;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.buildIR(P('rdec'), P('rdmp')), this.conv.buffer ? 120 : 0);
    }
  }

  buildIR(decay, damp) {
    const sr = this.ctx.sampleRate;
    const len = Math.min(sr * 14, Math.max(256, Math.ceil(sr * decay * 1.1)));
    const buf = this.ctx.createBuffer(2, len, sr);
    let energy = 0;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const env = Math.exp(-6.9 * t / decay) * Math.min(1, t / 0.004);
        const a = Math.min(0.97, damp * 0.97 * Math.min(1, t / decay * 1.5));
        lp += (1 - a) * ((Math.random() * 2 - 1) - lp);
        d[i] = lp * env;
        energy += d[i] * d[i];
      }
    }
    const g = 0.5 / Math.sqrt(energy / 2 + 1e-9);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] *= g; }
    this.conv.buffer = buf;
  }
}

export class Engine {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.viz = { heads: [], cent: [], peaks: new Float32Array(8), tr: 0 };
  }

  async init() {
    const ctx = this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    const node = this.node = new AudioWorkletNode(ctx, 'ferenc-engine', {
      numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [2, 2, 2],
    });
    node.port.onmessage = e => { if (e.data.t === 'viz') this.viz = e.data; };
    node.onprocessorerror = e => console.error('[worklet] processor error', e);

    this.master = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -4;
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;

    this.delay = new Delay(ctx);
    this.reverb = new Reverb(ctx);
    node.connect(this.master, 0);
    node.connect(this.delay.input, 1);
    node.connect(this.reverb.input, 2);
    this.delay.output.connect(this.master);
    this.delay.revSend.connect(this.reverb.input);
    this.reverb.output.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    this.limiter.connect(this.analyser);
    // recording / resampling tap for later phases
    this.out = this.limiter;
  }

  post(m) { this.node?.port.postMessage(m); }
  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  setTrack(tr, phys) { this.post({ t: 'trk', tr, p: phys }); }
  setParam(tr, k, v) { this.post({ t: 'prm', tr, k, v }); }
  noteOn(tr, n, vel, time = null, dur = 0, locks = null) { this.post({ t: 'on', tr, n, vel, time, dur, locks }); }
  noteOff(tr, n, time = null) { this.post({ t: 'off', tr, n, time }); }
  allOff(hard = false) { this.post({ t: 'alloff', hard }); }
  bend(tr, semis) { this.post({ t: 'bend', tr, v: semis }); }
  setBpm(bpm) { this.post({ t: 'bpm', v: bpm }); }
  syncLfo(time) { this.post({ t: 'sync', time }); }
  vizTrack(tr) { this.post({ t: 'viz', tr }); }

  setFx(p, bpm) { this.delay.set(p, bpm); this.reverb.set(p); }
  setVolume(v) { this.master?.gain.setTargetAtTime((v / 100) * (v / 100), this.now, 0.02); }

  /** Context time that is currently audible. */
  audibleTime() {
    const ts = this.ctx.getOutputTimestamp?.();
    if (!ts || !ts.contextTime) return this.ctx.currentTime - (this.ctx.outputLatency || 0) - this.ctx.baseLatency;
    return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
  }

  /** Convert an audio-context time to a performance.now() timestamp (for Web MIDI). */
  toPerf(time) {
    const ts = this.ctx.getOutputTimestamp?.();
    if (!ts || !ts.contextTime) {
      return performance.now() + (time - this.ctx.currentTime + (this.ctx.outputLatency || 0) + this.ctx.baseLatency) * 1000;
    }
    return ts.performanceTime + (time - ts.contextTime) * 1000;
  }

  /** Convert a performance.now() timestamp to audio-context time. */
  fromPerf(perf) {
    const ts = this.ctx.getOutputTimestamp?.();
    if (!ts || !ts.contextTime) return this.ctx.currentTime + (perf - performance.now()) / 1000;
    return ts.contextTime + (perf - ts.performanceTime) / 1000;
  }
}
