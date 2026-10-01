// Web MIDI: note/CC/bend/program-change input, note + clock output, thru.

const KEY = 'ferenc.midi';

export class Midi {
  constructor(app) {
    this.app = app;
    this.access = null;
    this.inputs = [];
    this.outputs = [];
    this.out = null;
    this.supported = typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess;
    this.error = this.supported ? '' : 'Web MIDI not supported in this browser';
    this.active = new Map(); // channel -> Set(notes) sent and not yet released
    this.settings = { in: 'ALL', out: '', ach: 0, clkIn: 0, clkOut: 0, thru: 0, pc: 1 };
    try { Object.assign(this.settings, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* defaults */ }
  }

  save() { try { localStorage.setItem(KEY, JSON.stringify(this.settings)); } catch { /* private mode */ } }

  async init() {
    if (!this.supported) return false;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      this.error = 'MIDI access denied';
      console.warn('[midi]', e);
      return false;
    }
    this.access.onstatechange = () => this.refresh();
    this.refresh();
    return true;
  }

  refresh() {
    if (!this.access) return;
    this.inputs = [...this.access.inputs.values()];
    this.outputs = [...this.access.outputs.values()];
    for (const inp of this.inputs) {
      const on = this.settings.in === 'ALL' || inp.id === this.settings.in;
      inp.onmidimessage = on ? e => this.onMessage(e) : null;
    }
    this.out = this.outputs.find(o => o.id === this.settings.out) || null;
    this.app.invalidate?.();
  }

  // option lists for the settings knobs
  inputOptions() { return [{ id: 'NONE', name: 'NONE' }, { id: 'ALL', name: 'ALL' }, ...this.inputs.map(p => ({ id: p.id, name: p.name }))]; }
  outputOptions() { return [{ id: '', name: 'NONE' }, ...this.outputs.map(p => ({ id: p.id, name: p.name }))]; }

  set(key, value) {
    this.settings[key] = value;
    this.save();
    if (key === 'in' || key === 'out') this.refresh();
    if (key === 'clkIn') this.app.seq.extClock = !!value;
  }

  onMessage(e) {
    const d = e.data;
    if (!d || !d.length) return;
    const st = d[0];
    const app = this.app;
    if (st >= 0xF8) {
      if (!this.settings.clkIn) return;
      if (st === 0xF8) app.seq.clockIn(e.timeStamp);
      else if (st === 0xFA) app.seq.extStart();
      else if (st === 0xFB) app.seq.extContinue();
      else if (st === 0xFC) app.seq.extStop();
      return;
    }
    app.flash('midiIn');
    if (this.settings.thru && this.out && st < 0xF0) this.out.send(d);
    const type = st & 0xF0, ch = (st & 0x0F) + 1;
    if (type === 0xC0) { if (this.settings.pc) app.programChange(d[1]); return; }
    const tr = app.trackForChannel(ch);
    if (tr === null) return;
    if (type === 0x90 && d[2] > 0) app.midiNoteOn(tr, d[1], d[2]);
    else if (type === 0x80 || type === 0x90) app.midiNoteOff(tr, d[1]);
    else if (type === 0xB0) app.midiCC(tr, d[1], d[2]);
    else if (type === 0xE0) app.midiBend(tr, ((d[2] << 7) | d[1]) - 8192);
  }

  send(bytes, time = null) {
    if (!this.out) return;
    try {
      if (time == null) this.out.send(bytes);
      else this.out.send(bytes, Math.max(performance.now(), this.app.engine.toPerf(time)));
      this.app.flash('midiOut');
    } catch (e) { console.warn('[midi] send', e); }
  }

  noteOn(ch, n, vel, time = null) {
    this.send([0x90 | (ch - 1), n & 127, Math.max(1, vel | 0)], time);
    if (!this.active.has(ch)) this.active.set(ch, new Set());
    this.active.get(ch).add(n);
  }

  noteOff(ch, n, time = null) {
    this.send([0x80 | (ch - 1), n & 127, 0], time);
    this.active.get(ch)?.delete(n);
  }

  realtime(byte, time = null) { if (this.settings.clkOut) this.send([byte], time); }
  clockTick(time) { if (this.settings.clkOut) this.send([0xF8], time); }

  panicOut() {
    for (const [ch, notes] of this.active) {
      for (const n of notes) this.send([0x80 | (ch - 1), n, 0]);
      notes.clear();
    }
  }
}
