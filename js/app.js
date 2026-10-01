// Application controller: owns the project, wires panel input to engine/sequencer/MIDI.

import {
  PARAMS, FX_PARAMS, PAGES, NUM_TRACKS, CC_MAP, KB_SCALES, M_WAVE, M_SMPL, MACHINES,
  clampParam, formatParam, trackPhys, locksPhys,
} from './params.js';
import { newProject, newPattern, newPatternTrack, step, clone, migrate, demoProject, patName } from './project.js';
import { Engine } from './audio/engine.js';
import { Pool, FACTORY_SLOTS } from './pool.js';
import { Sequencer } from './sequencer.js';
import { Midi } from './midi.js';
import { factorySounds } from './factory.js';
import { db, safe } from './storage.js';
import { menuFor } from './ui/menus.js';

const LONG_PRESS = 380;
const NOTE_KEYS = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9,
  KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
};

export class App {
  constructor() {
    this.project = newProject();
    this.engine = new Engine();
    this.pool = new Pool();
    this.seq = new Sequencer(this);
    this.midi = new Midi(this);
    this.state = {
      track: 0, page: 'SRC', sub: 0,
      menu: null, menuSub: 0, cursor: 0,
      func: false, funcLatched: false, funcUsed: false,
      mode: 'grid', modeLatched: false, modeUsed: false,
      kb: false,
      lockStep: null, heldStep: null,
      stepPage: 0, follow: true,
      rec: false, quantize: true, fill: false, fillLatch: false,
      song: false, bank: 0,
      toast: '', toastUntil: 0,
      powered: false,
    };
    this.ui = null;
    this.dirty = true;
    this.clipboard = null;
    this.undo = null;
    this.kbHeld = new Map();     // input id -> {tr, note}
    this.recs = new Map();       // `${tr}:${note}` -> record handle
    this.sustain = false;
    this.sustained = [];
    this.flashes = { midiIn: 0, midiOut: 0 };
    this.trigFlash = new Float64Array(NUM_TRACKS);
    this.taps = [];
    this.saveTimer = 0;
    this.drag = null;
    this.stepDown = null;
    this.armed = null;       // knob index selected from the keyboard (or last touched)
    this.holdKnob = null;    // knob key held: mouse movement edits it
    try { this.keyMode = localStorage.getItem('ferenc.keys') || 'edit'; } catch { this.keyMode = 'edit'; }
  }

  // ---- boot --------------------------------------------------------------------

  async boot() {
    await this.engine.init();
    this.pool.engine = this.engine;
    this.pool.onChange = () => this.invalidate();
    for (const f of factorySounds(44100)) {
      this.pool.slots[f.slot] = this.pool.makeEntry(f.name, f.ch, f.sr, { clm: f.clm || 0, kind: f.kind, factory: true });
    }
    await this.pool.restore(this.engine.ctx);
    this.pool.sendAll();
    const saved = await safe(db.get('kv', 'autosave'));
    this.project = saved ? migrate(saved) : demoProject();
    this.applyProject();
    this.midi.init().then(() => { this.seq.extClock = !!this.midi.settings.clkIn; this.invalidate(); });
    this.state.powered = true;
    this.engine.vizTrack(this.state.track);
    this.toast(saved ? 'PROJECT RESTORED' : 'DEMO LOADED · PRESS PLAY');
  }

  applyProject() {
    const pr = this.project;
    for (let i = 0; i < NUM_TRACKS; i++) this.engine.setTrack(i, trackPhys(pr.tracks[i].p));
    this.engine.setBpm(pr.bpm);
    this.engine.setFx(pr.fx, pr.bpm);
    this.engine.setVolume(pr.master);
    this.state.lockStep = null;
    this.state.stepPage = 0;
    this.invalidate();
  }

  // ---- accessors -----------------------------------------------------------------

  curTrack() { return this.project.tracks[this.state.track]; }
  pattern() { return this.project.patterns[this.project.current]; }
  ptrack(i = this.state.track) { return this.pattern().tracks[i]; }

  lockIndex() { return this.state.heldStep ?? this.state.lockStep; }
  lockTarget(create = false) {
    const i = this.lockIndex();
    if (i === null) return null;
    const steps = this.ptrack().steps;
    if (!steps[i] && create) steps[i] = step();
    return steps[i] || null;
  }

  pval(id) {
    const s = this.lockTarget();
    if (s && s.locks[id] !== undefined) return s.locks[id];
    return this.curTrack().p[id];
  }

  invalidate() { this.dirty = true; }

  changed() {
    this.invalidate();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => safe(db.put('kv', 'autosave', this.project)), 800);
  }

  toast(msg, ms = 1400) {
    this.state.toast = msg;
    this.state.toastUntil = performance.now() + ms;
    this.invalidate();
  }

  flash(kind) { this.flashes[kind] = performance.now(); }

  // ---- parameters ------------------------------------------------------------------

  setParam(id, v, tr = this.state.track, { lockable = true } = {}) {
    const def = PARAMS[id];
    v = clampParam(def, v);
    const s = lockable && tr === this.state.track && def.lock ? this.lockTarget(this.state.heldStep !== null) : null;
    if (s) {
      s.locks[id] = v;
      if (this.stepDown) this.stepDown.turned = true;
    } else {
      const t = this.project.tracks[tr];
      if (t.p[id] === v) return;
      t.p[id] = v;
      this.engine.setParam(tr, id, def.phys(v));
      if (id === 'mach') { this.state.sub = 0; this.engine.allOff(true); }
    }
    this.changed();
  }

  resetParam(id) {
    const s = this.lockTarget();
    if (s && s.locks[id] !== undefined) { delete s.locks[id]; this.changed(); return; }
    this.setParam(id, PARAMS[id].def);
  }

  trackBinding(id) {
    const def = PARAMS[id];
    return {
      def,
      get: () => this.pval(id),
      set: v => this.setParam(id, v),
      reset: () => this.resetParam(id),
      locked: () => { const s = this.lockTarget(); return !!(s && s.locks[id] !== undefined); },
      fmt: v => formatParam(def, v, this),
    };
  }

  /** Binding for any {get,set} pair, used by menus. */
  objBinding(def, get, set) {
    return { def, get, set: v => { set(clampParam(def, v)); this.changed(); }, reset: () => { set(def.def); this.changed(); }, locked: () => false, fmt: v => formatParam(def, v, this) };
  }

  fxBinding(id) {
    const def = FX_PARAMS[id];
    return this.objBinding(def, () => this.project.fx[id], v => {
      this.project.fx[id] = v;
      this.engine.setFx(this.project.fx, this.project.bpm);
    });
  }

  pages() { return PAGES[this.state.page](this.curTrack().p.mach); }
  pageCount() {
    if (this.state.menu) return this.menu().pages || 1;
    return this.pages().length;
  }
  pageIds() { const p = this.pages(); return p[Math.min(this.state.sub, p.length - 1)]; }

  menu() { return menuFor(this, this.state.menu); }

  bindings() {
    if (this.state.menu) return this.menu().bindings?.() || new Array(8).fill(null);
    return this.pageIds().map(id => (id ? this.trackBinding(id) : null));
  }

  // ---- knobs ------------------------------------------------------------------------

  ppu(def, fine) {
    const range = def.max - def.min;
    let p;
    if (def.opts) p = Math.max(10, Math.min(24, 240 / def.opts.length));
    else if (def.int) p = Math.max(3, Math.min(24, 256 / range));
    else p = 256 / range;
    return fine ? p * (def.int ? 3 : 10) : p;
  }

  knobBegin(k) {
    const b = this.bindings()[k];
    if (!b) return;
    this.drag = { b, start: b.get() ?? b.def.def };
  }

  knobMove(k, dpx, fine) {
    if (!this.drag) return;
    const { b, start } = this.drag;
    const def = b.def;
    let v = start + dpx / this.ppu(def, fine);
    v = def.int ? Math.round(v) : fine ? Math.round(v * 100) / 100 : Math.round(v);
    b.set(clampParam(def, v));
  }

  knobEnd() { this.drag = null; }

  knobStep(k, dir, fine) {
    const b = this.bindings()[k];
    if (!b) return;
    const cur = b.get() ?? b.def.def;
    b.set(clampParam(b.def, cur + dir * (fine && !b.def.int ? 0.1 : 1)));
  }

  knobReset(k) { this.bindings()[k]?.reset?.(); }

  dataKnob(dir, fine) {
    const m = this.state.menu && this.menu();
    if (m?.data) { m.data(dir, fine); this.invalidate(); return; }
    this.trackBinding('vol').set(this.pval('vol') + dir * (fine ? 0.25 : 1));
  }

  setMaster(v) {
    this.project.master = Math.max(0, Math.min(127, v));
    this.engine.setVolume(this.project.master);
    this.changed();
  }

  // ---- FUNC & modes -------------------------------------------------------------------

  funcDown() {
    const st = this.state;
    if (st.func && st.funcLatched) { st.func = false; st.funcLatched = false; }
    else { st.func = true; st.funcUsed = false; st.funcLatched = false; }
    this.invalidate();
  }

  funcUp() {
    const st = this.state;
    if (!st.func) return;
    if (st.funcUsed) st.func = false; else st.funcLatched = true;
    this.invalidate();
  }

  consumeFunc() {
    const st = this.state;
    const f = st.func;
    if (f) { st.funcUsed = true; if (st.funcLatched) { st.func = false; st.funcLatched = false; } }
    return f;
  }

  modeDown(mode) {
    const st = this.state;
    if (st.mode === mode && st.modeLatched) { st.mode = 'grid'; st.modeLatched = false; }
    else { st.mode = mode; st.modeLatched = false; st.modeUsed = false; }
    this.invalidate();
  }

  modeUp(mode) {
    const st = this.state;
    if (st.mode !== mode) return;
    if (st.modeUsed) st.mode = 'grid'; else st.modeLatched = true;
    this.invalidate();
  }

  modeKeyUsed() {
    const st = this.state;
    st.modeUsed = true;
    if (st.modeLatched) { st.mode = 'grid'; st.modeLatched = false; }
  }

  // ---- buttons ----------------------------------------------------------------------

  press(name, phase = 'down') {
    const st = this.state;
    if (!st.powered) return;
    if (name === 'func') { phase === 'down' ? this.funcDown() : this.funcUp(); return; }
    if (name === 'trk' || name === 'ptn') {
      if (phase === 'down') {
        if (this.consumeFunc()) {
          const alt = name === 'trk' ? 'mute' : 'bank';
          st.mode = st.mode === alt ? 'grid' : alt;
          st.modeLatched = true;
          this.toast(alt === 'mute' ? 'MUTE MODE' : 'SELECT BANK');
          this.invalidate();
        } else this.modeDown(name);
      } else this.modeUp(name);
      return;
    }
    if (name === 'page') {
      if (phase === 'down') {
        if (this.consumeFunc()) { st.fillLatch = !st.fillLatch; st.fill = st.fillLatch; this.toast(st.fill ? 'FILL ON' : 'FILL OFF'); return; }
        this.pageHold = setTimeout(() => { this.pageHold = null; st.fill = true; this.invalidate(); }, LONG_PRESS);
      } else if (this.pageHold !== undefined) {
        if (this.pageHold) { clearTimeout(this.pageHold); this.pageHold = undefined; this.nextStepPage(); }
        else { this.pageHold = undefined; st.fill = st.fillLatch; }
        this.invalidate();
      }
      return;
    }
    if (phase !== 'down') return;
    const f = this.consumeFunc();
    const m = st.menu ? this.menu() : null;
    switch (name) {
      case 'kb': f ? this.openMenu('kbsetup') : (st.kb = !st.kb, st.mode = 'grid'); break;
      case 'song': f ? this.openMenu('song') : (st.song = !st.song, this.toast(st.song ? 'SONG MODE · PTN keys add to chain' : 'SONG MODE OFF')); break;
      case 'proj': if (f) { st.mode = st.mode === 'perf' ? 'grid' : 'perf'; st.modeLatched = true; this.toast(st.mode === 'perf' ? 'PERFORM: 1-8 PLAY · 9-16 MUTE' : 'PERFORM OFF'); } else this.openMenu('project'); break;
      case 'settings': f ? this.saveProject() : this.openMenu('settings'); break;
      case 'samples': this.openMenu('samples'); break;
      case 'tempo': f ? this.tap() : this.openMenu('tempo'); break;
      case 'rec': f ? this.copy() : (st.rec = !st.rec); break;
      case 'play': f ? this.clear() : this.seq.toggle(); break;
      case 'stop': f ? this.paste() : this.seq.stop(); break;
      case 'yes': if (f) this.saveProject(); else m?.yes?.(); break;
      case 'no':
        if (f) { this.reloadProject(); break; }
        if (this.undo && performance.now() < this.undo.until) { this.undo.fn(); this.undo = null; this.toast('UNDONE'); break; }
        if (st.menu) { if (!m?.no?.()) this.closeMenu(); }
        else if (st.lockStep !== null) st.lockStep = null;
        else if (st.mode !== 'grid') { st.mode = 'grid'; st.modeLatched = false; }
        else if (st.kb) st.kb = false;
        break;
      case 'up': if (m?.up) m.up(); else this.octave(1); break;
      case 'down': if (m?.down) m.down(); else this.octave(-1); break;
      case 'left': case 'right': {
        const d = name === 'left' ? -1 : 1;
        if (this.lockTarget()) this.setParam('micro', (this.pval('micro') || 0) + d);
        else if (m?.[name]) m[name]();
        else this.setStepPage(st.stepPage + d);
        break;
      }
      default:
        if (name.startsWith('pg:')) this.pageButton(name.slice(3), f);
    }
    this.invalidate();
  }

  pageButton(page, f) {
    const st = this.state;
    if (f) {
      switch (page) {
        case 'TRIG': st.quantize = !st.quantize; this.toast(st.quantize ? 'REC QUANTIZE ON' : 'REC QUANTIZE OFF'); return;
        case 'SRC': {
          const m = (this.curTrack().p.mach + 1) % MACHINES.length;
          this.setParam('mach', m, st.track, { lockable: false });
          st.page = 'SRC'; st.sub = 0; st.menu = null;
          this.toast('MACHINE: ' + MACHINES[m]);
          return;
        }
        case 'FLTR': this.openMenu('trksetup'); return;
        case 'AMP': this.openMenu('seqsetup'); return;
        case 'FX':
          if (st.menu === 'fx') st.menuSub = (st.menuSub + 1) % 2;
          else this.openMenu('fx');
          return;
        case 'MOD': this.openMenu('mixer'); return;
      }
    }
    if (st.menu) {
      this.closeMenu();
      if (st.page !== page) { st.page = page; st.sub = 0; }
      return;
    }
    if (st.page === page) st.sub = (st.sub + 1) % this.pages().length;
    else { st.page = page; st.sub = 0; }
  }

  openMenu(name) {
    const st = this.state;
    if (st.menu === name) { this.closeMenu(); return; }
    st.menu = name;
    st.menuSub = 0;
    st.cursor = name === 'samples' ? this.curTrack().p.smp : 0;
    this.menuDirty = true;
    this.invalidate();
  }

  closeMenu() { this.state.menu = null; this.menuDirty = true; this.invalidate(); }

  octave(d) {
    const kb = this.project.kb;
    kb.oct = Math.max(-4, Math.min(4, kb.oct + d));
    this.toast('OCTAVE ' + (kb.oct > 0 ? '+' : '') + kb.oct);
    this.changed();
  }

  stepPages() { return Math.max(1, Math.ceil(this.ptrack().len / 16)); }
  setStepPage(p) {
    const n = this.stepPages();
    this.state.stepPage = ((p % n) + n) % n;
    this.state.follow = false;
  }
  nextStepPage() { this.setStepPage(this.state.stepPage + 1); }

  selectTrack(i) {
    const st = this.state;
    if (i < 0 || i >= NUM_TRACKS) return;
    st.track = i;
    st.lockStep = null;
    st.sub = Math.min(st.sub, this.pages().length - 1);
    if (st.stepPage >= this.stepPages()) st.stepPage = 0;
    this.engine.vizTrack(i);
    this.menuDirty = true;
    this.invalidate();
  }

  toggleMute(i) {
    const t = this.project.tracks[i];
    t.mute = !t.mute;
    this.changed();
  }

  // ---- trig keys -----------------------------------------------------------------------

  kbNote(i) {
    const kb = this.project.kb;
    const sc = KB_SCALES[kb.scale].s;
    return 60 + kb.oct * 12 + kb.root + sc[i % sc.length] + 12 * Math.floor(i / sc.length);
  }

  keyDown(i, id = 'k' + i) {
    const st = this.state;
    if (!st.powered) return;
    const f = this.consumeFunc();
    switch (st.mode) {
      case 'trk': this.selectTrack(i % NUM_TRACKS); this.modeKeyUsed(); return;
      case 'mute': if (i < NUM_TRACKS) this.toggleMute(i); return;
      case 'bank': st.bank = i % 4; st.mode = 'ptn'; st.modeLatched = true; this.invalidate(); return;
      case 'ptn': {
        const idx = st.bank * 16 + i;
        if (st.song) { this.project.song.push(idx); this.toast('CHAIN: ' + this.project.song.map(patName).join(' ')); this.changed(); }
        else this.seq.selectPattern(idx);
        this.modeKeyUsed();
        return;
      }
      case 'perf':
        if (i < NUM_TRACKS) this.noteOn(i, this.project.tracks[i].p.note, 110, id);
        else this.toggleMute(i - NUM_TRACKS);
        return;
    }
    if (st.kb) { this.noteOn(st.track, this.kbNote(i), 100, id); return; }
    // grid editing
    const idx = st.stepPage * 16 + i;
    if (idx >= this.ptrack().len) return;
    if (f) { this.latchStep(idx); return; }
    st.heldStep = idx;
    this.stepDown = { idx, turned: false, latched: false, existed: !!this.ptrack().steps[idx] };
    this.stepTimer = setTimeout(() => {
      if (this.stepDown && this.stepDown.idx === idx && !this.stepDown.turned) {
        this.stepDown.latched = true;
        this.latchStep(idx);
      }
    }, LONG_PRESS);
    this.invalidate();
  }

  keyUp(i, id = 'k' + i) {
    const st = this.state;
    if (this.kbHeld.has(id)) { this.noteOff(id); return; }
    const sd = this.stepDown;
    if (!sd || sd.idx !== st.stepPage * 16 + i) return;
    clearTimeout(this.stepTimer);
    if (!sd.latched && !sd.turned) {
      const steps = this.ptrack().steps;
      if (steps[sd.idx]) {
        delete steps[sd.idx];
        if (st.lockStep === sd.idx) st.lockStep = null;
      } else steps[sd.idx] = step();
      this.changed();
    }
    this.stepDown = null;
    st.heldStep = null;
    this.invalidate();
  }

  latchStep(idx) {
    const st = this.state;
    if (st.lockStep === idx) { st.lockStep = null; this.invalidate(); return; }
    const steps = this.ptrack().steps;
    if (!steps[idx]) { steps[idx] = step(); this.changed(); }
    st.lockStep = idx;
    if (st.page === 'TRIG' || st.menu) { /* keep */ }
    this.invalidate();
  }

  keyContext(i) {
    if (this.state.mode !== 'grid' || this.state.kb) return;
    const idx = this.state.stepPage * 16 + i;
    if (idx < this.ptrack().len) this.latchStep(idx);
  }

  // ---- notes -----------------------------------------------------------------------------

  /** Sequencer trig (time in context seconds; dur 0 = held until released). */
  trigger(i, note, vel, time, dur, locks) {
    const t = this.project.tracks[i];
    if (t.int) this.engine.noteOn(i, note, vel / 127, time, dur, locksPhys(locks));
    if (t.outCh) {
      this.midi.noteOn(t.outCh, note, vel, time);
      if (dur) this.midi.noteOff(t.outCh, note, time + dur);
    }
    this.trigFlash[i] = time;
  }

  release(i, note, time) {
    const t = this.project.tracks[i];
    this.engine.noteOff(i, note, time);
    if (t.outCh) this.midi.noteOff(t.outCh, note, time);
  }

  /** Live note from keys, computer keyboard or MIDI. */
  noteOn(tr, note, vel, id) {
    if (!this.state.powered) return;
    this.engine.ctx.resume();
    if (this.kbHeld.has(id)) this.noteOff(id);
    const t = this.project.tracks[tr];
    if (t.int) this.engine.noteOn(tr, note, vel / 127);
    if (t.outCh) this.midi.noteOn(t.outCh, note, vel);
    this.kbHeld.set(id, { tr, note });
    this.trigFlash[tr] = this.engine.now;
    if (this.state.rec && this.seq.playing) this.recs.set(id, this.seq.recordNote(tr, note, vel));
    this.invalidate();
  }

  noteOff(id) {
    const h = this.kbHeld.get(id);
    if (!h) return;
    this.kbHeld.delete(id);
    if (this.recs.has(id)) { this.seq.recordNoteOff(this.recs.get(id)); this.recs.delete(id); }
    if (this.sustain) { this.sustained.push(h); return; }
    this.release(h.tr, h.note, null);
    this.invalidate();
  }

  allNotesOff() {
    for (const id of [...this.kbHeld.keys()]) this.noteOff(id);
  }

  // ---- MIDI input -------------------------------------------------------------------------

  trackForChannel(ch) {
    const i = this.project.tracks.findIndex(t => t.inCh === ch);
    if (i >= 0) return i;
    const ach = this.midi.settings.ach;
    return ach === 0 || ach === ch ? this.state.track : null;
  }

  midiNoteOn(tr, n, v) { this.noteOn(tr, n, v, `m${tr}:${n}`); }
  midiNoteOff(tr, n) { this.noteOff(`m${tr}:${n}`); }

  midiCC(tr, cc, val) {
    if (cc === 64) {
      this.sustain = val >= 64;
      if (!this.sustain) { for (const h of this.sustained) this.release(h.tr, h.note, null); this.sustained = []; }
      return;
    }
    if (cc === 120 || cc === 123) { this.engine.allOff(cc === 120); return; }
    const scale = (def) => def.min + (val / 127) * (def.max - def.min);
    if (cc === 1) { this.setParam('l1dep', Math.round(val / 2), tr, { lockable: false }); return; }
    if (cc >= 16 && cc <= 23 && !this.state.menu && tr === this.state.track) {
      const b = this.bindings()[cc - 16];
      if (b) b.set(clampParam(b.def, scale(b.def)));
      return;
    }
    const id = CC_MAP[cc];
    if (id) this.setParam(id, scale(PARAMS[id]), tr, { lockable: false });
  }

  midiBend(tr, v) { this.engine.bend(tr, (v / 8192) * 2); }
  programChange(p) { this.seq.selectPattern(p % this.project.patterns.length); }

  // ---- tempo -----------------------------------------------------------------------------

  setBpm(bpm, user = true) {
    bpm = Math.max(30, Math.min(300, Math.round(bpm * 10) / 10));
    this.project.bpm = bpm;
    this.engine.setBpm(bpm);
    this.engine.setFx(this.project.fx, bpm);
    if (user) this.changed(); else this.invalidate();
  }

  tap() {
    const now = performance.now();
    this.taps = this.taps.filter(t => now - t < 2500);
    this.taps.push(now);
    if (this.taps.length >= 2) {
      const iv = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
      this.setBpm(60000 / iv);
      this.toast('TAP ' + this.project.bpm.toFixed(1));
    } else this.toast('TAP...');
  }

  // ---- copy / paste / clear --------------------------------------------------------------

  setUndo(fn) { this.undo = { fn: () => { fn(); this.changed(); }, until: performance.now() + 6000 }; }

  copy() {
    const st = this.state;
    const s = this.lockTarget();
    if (s) { this.clipboard = { type: 'step', data: clone(s) }; this.toast('STEP COPIED'); }
    else if (st.mode === 'ptn') { this.clipboard = { type: 'pattern', data: clone(this.pattern()) }; this.toast('PATTERN COPIED'); }
    else { this.clipboard = { type: 'track', data: clone(this.ptrack()) }; this.toast('TRACK PATTERN COPIED'); }
  }

  paste() {
    const cb = this.clipboard;
    if (!cb) { this.toast('CLIPBOARD EMPTY'); return; }
    const pr = this.project, st = this.state, cur = pr.current, t = st.track;
    if (cb.type === 'step') {
      const i = this.lockIndex();
      if (i === null) { this.toast('SELECT A STEP TO PASTE'); return; }
      const steps = this.ptrack().steps, prev = steps[i];
      steps[i] = clone(cb.data);
      this.setUndo(() => { if (prev) pr.patterns[cur].tracks[t].steps[i] = prev; else delete pr.patterns[cur].tracks[t].steps[i]; });
    } else if (cb.type === 'pattern') {
      const prev = pr.patterns[cur];
      pr.patterns[cur] = clone(cb.data);
      this.setUndo(() => { pr.patterns[cur] = prev; });
    } else {
      const prev = this.pattern().tracks[t];
      this.pattern().tracks[t] = clone(cb.data);
      this.setUndo(() => { pr.patterns[cur].tracks[t] = prev; });
    }
    this.toast('PASTED · NO = UNDO');
    this.changed();
  }

  clear() {
    const pr = this.project, st = this.state, cur = pr.current, t = st.track;
    const s = this.lockTarget();
    if (s) {
      const prev = s.locks;
      s.locks = {};
      this.setUndo(() => { s.locks = prev; });
      this.toast('LOCKS CLEARED · NO = UNDO');
    } else if (st.mode === 'ptn') {
      const prev = pr.patterns[cur];
      pr.patterns[cur] = newPattern();
      this.setUndo(() => { pr.patterns[cur] = prev; });
      this.toast('PATTERN CLEARED · NO = UNDO');
    } else {
      const prev = this.ptrack();
      this.pattern().tracks[t] = { ...newPatternTrack(), len: prev.len, scale: prev.scale };
      this.setUndo(() => { pr.patterns[cur].tracks[t] = prev; });
      this.toast('TRACK CLEARED · NO = UNDO');
    }
    this.changed();
  }

  // ---- samples ------------------------------------------------------------------------------

  async loadFiles(files, { assign = false } = {}) {
    const audio = [...files].filter(f => /\.(wav|wave|aif|aiff|mp3|ogg|oga|flac|m4a|webm)$/i.test(f.name) || f.type.startsWith('audio/'));
    audio.sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }));
    if (!audio.length) { this.toast('NO AUDIO FILES'); return; }
    let first = -1, n = 0, failed = 0;
    for (const f of audio) {
      if (this.pool.firstFree() < 0) { this.toast(`POOL FULL · LOADED ${n}`); break; }
      try {
        const slot = await this.pool.loadFile(f, this.engine.ctx);
        if (first < 0) first = slot;
        n++;
        if (n % 8 === 0) this.toast(`LOADING ${n}/${audio.length}`);
      } catch (e) { failed++; console.warn('load failed', f.name, e); }
    }
    if (first >= 0 && assign) this.assignSample(first);
    if (first >= 0 && this.state.menu === 'samples') this.state.cursor = first;
    this.menuDirty = true;
    this.toast(`LOADED ${n} SAMPLE${n === 1 ? '' : 'S'}${failed ? ` · ${failed} FAILED` : ''}`, 2000);
  }

  /** Put slot on the current track, switching machine to a sensible one. */
  assignSample(slot) {
    const e = this.pool.slots[slot];
    if (!e) return;
    const tr = this.state.track;
    const mach = this.curTrack().p.mach;
    this.setParam('smp', slot, tr, { lockable: false });
    if (e.kind === 'cycle' && mach !== M_WAVE) this.setParam('mach', M_WAVE, tr, { lockable: false });
    if (e.kind === 'sample' && mach === M_WAVE) this.setParam('mach', M_SMPL, tr, { lockable: false });
  }

  preview(slot) {
    this.assignSample(slot);
    const t = this.state.track, n = this.curTrack().p.note;
    this.engine.ctx.resume();
    this.engine.noteOn(t, n, 0.8, null, 0.4);
  }

  // ---- project persistence -----------------------------------------------------------------

  async saveProject() {
    await safe(db.put('kv', 'autosave', this.project));
    await safe(db.put('kv', 'saved', this.project));
    this.toast('PROJECT SAVED');
  }

  async reloadProject() {
    const saved = await safe(db.get('kv', 'saved'));
    if (!saved) { this.toast('NOTHING SAVED YET'); return; }
    this.seq.stop();
    this.project = migrate(saved);
    this.applyProject();
    this.changed();
    this.toast('RELOADED LAST SAVE');
  }

  loadProject(pr, msg = 'PROJECT LOADED') {
    this.seq.stop();
    this.project = migrate(pr);
    this.applyProject();
    this.changed();
    this.toast(msg);
  }

  async exportProject() {
    const samples = [];
    for (let i = FACTORY_SLOTS; i < this.pool.slots.length; i++) {
      const e = this.pool.slots[i];
      if (e && !e.factory && e.bytes) samples.push({ slot: i, name: e.name, kind: e.override, b64: toB64(e.bytes) });
    }
    const blob = new Blob([JSON.stringify({ ferenc: 1, project: this.project, samples })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (this.project.name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.ferenc.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    this.toast(`EXPORTED (${samples.length} SAMPLES)`);
  }

  async importProject(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!data.project) throw new Error('not a ferenc project');
      if (data.samples?.length) {
        await this.pool.clearUser();
        for (const s of data.samples) {
          await this.pool.loadBytes(s.name, fromB64(s.b64), this.engine.ctx, { slot: s.slot, kind: s.kind || null });
        }
      }
      this.loadProject(data.project, 'IMPORTED ' + (data.project.name || ''));
    } catch (e) {
      console.warn(e);
      this.toast('IMPORT FAILED');
    }
  }

  newProject(demo = false) {
    this.loadProject(demo ? demoProject() : newProject(), demo ? 'DEMO LOADED' : 'NEW PROJECT');
  }

  // ---- computer keyboard -------------------------------------------------------------------
  // Two modes, toggled with Tab:
  //   EDIT  1-6 page groups, 7-0 menus, Q W E R / A S D F = knobs A-H (hold + move mouse = edit,
  //         tap = select, then wheel / arrows), Z X C V B N M , = tracks 1-8, G = preview note
  //   PLAY  A W S E D F T G Y H U J K O L P = notes, Z/X octave, 1-8 tracks

  setKeyMode(mode) {
    this.keyMode = mode;
    try { localStorage.setItem('ferenc.keys', mode); } catch { /* private mode */ }
    this.allNotesOff();
    this.holdKnob = null;
    this.toast(mode === 'edit' ? 'KEYS: EDIT (1-6 pages · QWER ASDF knobs)' : 'KEYS: PLAY (piano)', 1800);
  }

  arm(k) { this.armed = k; this.invalidate(); }

  /** Mouse movement while a knob key is held. */
  mouseEdit(dx, dy, fine) {
    const h = this.holdKnob;
    if (!h || !this.drag) return;
    h.acc += -dy + dx * 0.5;
    this.knobMove(h.k, h.acc, fine);
  }

  /** Wheel / trackpad scroll anywhere while a knob is selected. */
  wheelArmed(steps, fine) {
    if (this.armed === null || !this.bindings()[this.armed]) return false;
    this.knobStep(this.armed, steps, fine);
    return true;
  }

  onEditKey(e, down) {
    const st = this.state, code = e.code;
    if (code in EDIT_KNOBS) {
      e.preventDefault();
      const k = EDIT_KNOBS[code];
      if (down) {
        if (e.repeat) return true;
        this.arm(k);
        this.holdKnob = { k, acc: 0 };
        this.knobBegin(k);
      } else if (this.holdKnob?.k === k) {
        this.holdKnob = null;
        this.knobEnd();
      }
      return true;
    }
    if (code === 'KeyG') {
      e.preventDefault();
      if (down && !e.repeat) this.noteOn(st.track, this.pval('note'), 100, 'preview');
      else if (!down) this.noteOff('preview');
      return true;
    }
    if (!down) return false;
    if (code in EDIT_TRACKS) {
      e.preventDefault();
      if (this.consumeFunc()) this.toggleMute(EDIT_TRACKS[code]); else this.selectTrack(EDIT_TRACKS[code]);
      return true;
    }
    if (code in EDIT_GROUPS) { e.preventDefault(); this.press(EDIT_GROUPS[code]); return true; }
    if (code in EDIT_MENUS) {
      e.preventDefault();
      const m = EDIT_MENUS[code];
      if (m === 'fx' && st.menu === 'fx') st.menuSub = (st.menuSub + 1) % 2; else this.openMenu(m);
      this.invalidate();
      return true;
    }
    if ((code === 'Backspace' || code === 'Delete') && this.armed !== null) { e.preventDefault(); this.knobReset(this.armed); return true; }
    return false;
  }

  onKey(e, down) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const st = this.state, code = e.code;
    if (code === 'ShiftLeft' || code === 'ShiftRight') {
      if (down && !e.repeat) { st.func = true; st.funcUsed = false; st.funcLatched = false; }
      else if (!down) { st.func = false; st.funcLatched = false; }
      this.invalidate();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (code === 'Tab') {
      e.preventDefault();
      if (down && !e.repeat) this.setKeyMode(this.keyMode === 'edit' ? 'play' : 'edit');
      return;
    }
    if (this.keyMode === 'edit') {
      if (this.onEditKey(e, down)) return;
    } else {
      if (code in NOTE_KEYS) {
        e.preventDefault();
        const id = 'q' + code;
        if (down) {
          if (e.repeat) return;
          this.noteOn(st.track, 60 + this.project.kb.oct * 12 + NOTE_KEYS[code], 100, id);
        } else this.noteOff(id);
        return;
      }
      if (down && code.startsWith('Digit')) {
        const n = +code.slice(5);
        if (n >= 1 && n <= NUM_TRACKS) { if (this.consumeFunc()) this.toggleMute(n - 1); else this.selectTrack(n - 1); }
        return;
      }
      if (down && code === 'KeyZ') { this.octave(-1); return; }
      if (down && code === 'KeyX') { this.octave(1); return; }
    }
    if (!down) return;
    if (code === 'Space') {
      e.preventDefault();
      if (e.repeat) return;
      if (this.consumeFunc()) this.clear(); else this.seq.toggle();
      this.invalidate();
      return;
    }
    if (code === 'Escape' && this.armed !== null) { this.armed = null; this.invalidate(); return; }
    if ((code === 'ArrowUp' || code === 'ArrowDown') && this.armed !== null && this.bindings()[this.armed]) {
      e.preventDefault();
      this.knobStep(this.armed, code === 'ArrowUp' ? 1 : -1, e.shiftKey);
      return;
    }
    const map = { Enter: 'yes', Escape: 'no', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (map[code]) { e.preventDefault(); this.press(map[code]); return; }
    if (code === 'BracketLeft') { this.setStepPage(this.state.stepPage - 1); this.invalidate(); }
    else if (code === 'BracketRight') { this.setStepPage(this.state.stepPage + 1); this.invalidate(); }
    else if (code === 'Slash' && e.shiftKey) this.ui?.toggleHelp();
  }
}

const EDIT_KNOBS = { KeyQ: 0, KeyW: 1, KeyE: 2, KeyR: 3, KeyA: 4, KeyS: 5, KeyD: 6, KeyF: 7 };
const EDIT_TRACKS = { KeyZ: 0, KeyX: 1, KeyC: 2, KeyV: 3, KeyB: 4, KeyN: 5, KeyM: 6, Comma: 7 };
const EDIT_GROUPS = { Digit1: 'pg:TRIG', Digit2: 'pg:SRC', Digit3: 'pg:FLTR', Digit4: 'pg:AMP', Digit5: 'pg:FX', Digit6: 'pg:MOD' };
const EDIT_MENUS = { Digit7: 'fx', Digit8: 'mixer', Digit9: 'seqsetup', Digit0: 'samples' };
export const KNOB_KEYS = 'QWERASDF';

function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}
