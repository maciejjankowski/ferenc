// Sample pool: 128 slots holding single cycles, wavetables and long samples.

import { buildWavetable, TABLE_SIZE } from './audio/wavetable.js';
import { NUM_SLOTS } from './params.js';
import { db, safe } from './storage.js';

export const CYCLE_MAX = 4096;   // anything this short is treated as a single cycle by default
export const FACTORY_SLOTS = 16; // user samples load from this slot upward
const MAX_FRAMES = 256;
const PEAK_BUCKETS = 1024;

/** Read sample rate and Serum-style `clm ` cycle length from a WAV header. */
export function sniffWav(buf) {
  if (buf.byteLength < 12) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) return null;
  let off = 12, sr = 0, clm = 0;
  while (off + 8 <= buf.byteLength) {
    const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ' && off + 16 <= buf.byteLength) sr = dv.getUint32(off + 12, true);
    else if (id === 'clm ') {
      const txt = new TextDecoder().decode(new Uint8Array(buf, off + 8, Math.min(size, 64, buf.byteLength - off - 8)));
      const m = /<!>(\d+)/.exec(txt);
      if (m) clm = +m[1];
    }
    off += 8 + size + (size & 1);
  }
  return { sr, clm };
}

/** Decode without resampling when possible (keeps single-cycle lengths exact). */
export async function decodeAudio(buf, ctx) {
  const info = sniffWav(buf) || {};
  let audio = null;
  if (info.sr >= 3000 && info.sr <= 384000 && typeof OfflineAudioContext !== 'undefined') {
    try { audio = await new OfflineAudioContext(1, 1, info.sr).decodeAudioData(buf.slice(0)); } catch { audio = null; }
  }
  if (!audio) audio = await ctx.decodeAudioData(buf.slice(0));
  const ch = [];
  for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) ch.push(new Float32Array(audio.getChannelData(c)));
  return { ch, sr: audio.sampleRate, clm: info.clm || 0 };
}

function computePeaks(ch) {
  const len = ch[0].length;
  const out = new Float32Array(PEAK_BUCKETS * 2);
  for (let b = 0; b < PEAK_BUCKETS; b++) {
    const a = Math.floor(b * len / PEAK_BUCKETS), z = Math.max(a + 1, Math.floor((b + 1) * len / PEAK_BUCKETS));
    let mn = 1, mx = -1;
    for (let i = a; i < z && i < len; i++) {
      for (const c of ch) { const v = c[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    }
    out[b * 2] = mn; out[b * 2 + 1] = mx;
  }
  return out;
}

function mono(ch) {
  if (ch.length === 1) return ch[0];
  const out = new Float32Array(ch[0].length);
  for (let i = 0; i < out.length; i++) out[i] = (ch[0][i] + ch[1][i]) * 0.5;
  return out;
}

/** Decide cycle length / frames for a buffer interpreted as a cycle or wavetable. */
function cycleLayout(len, clm) {
  if (clm > 0 && len >= clm) return { cycLen: clm, frames: Math.min(MAX_FRAMES, Math.floor(len / clm)) };
  if (len <= CYCLE_MAX) return { cycLen: len, frames: 1 };
  if (len % TABLE_SIZE !== 0 && len <= CYCLE_MAX * 4) return { cycLen: len, frames: 1 };
  return { cycLen: TABLE_SIZE, frames: Math.max(1, Math.min(MAX_FRAMES, Math.floor(len / TABLE_SIZE))) };
}

export class Pool {
  constructor() {
    this.slots = new Array(NUM_SLOTS).fill(null);
    this.engine = null;
    this.onChange = () => {};
  }

  label(i) { const s = this.slots[i]; return s ? s.name : '---'; }
  shortLabel(i) { const s = this.slots[i]; return s ? s.name.slice(0, 9) : '---'; }
  firstFree(from = FACTORY_SLOTS) {
    for (let i = from; i < NUM_SLOTS; i++) if (!this.slots[i]) return i;
    for (let i = 0; i < NUM_SLOTS; i++) if (!this.slots[i]) return i;
    return -1;
  }
  findByName(name) { return this.slots.findIndex(s => s && s.name === name); }

  /** Build a slot entry from decoded channels. */
  makeEntry(name, ch, sr, { clm = 0, kind = null, factory = false, bytes = null } = {}) {
    const len = ch[0].length;
    const k = kind || (clm || len <= CYCLE_MAX ? 'cycle' : 'sample');
    const e = { name, kind: k, sr, len, ch, clm, factory, bytes, override: kind, peaks: computePeaks(ch), wt: null, cycLen: len, frames: 1 };
    if (k === 'cycle') {
      const { cycLen, frames } = cycleLayout(len, clm);
      e.cycLen = cycLen; e.frames = frames;
      e.wt = buildWavetable(mono(ch), cycLen, frames);
    }
    return e;
  }

  set(slot, entry) {
    this.slots[slot] = entry;
    this.send(slot);
    this.onChange(slot);
  }

  send(slot) {
    if (!this.engine) return;
    const e = this.slots[slot];
    if (!e) { this.engine.post({ t: 'smpdel', slot }); return; }
    this.engine.post({ t: 'smp', slot, s: { ch: e.ch, sr: e.sr, len: e.len, wt: e.wt } });
  }

  sendAll() { for (let i = 0; i < NUM_SLOTS; i++) if (this.slots[i]) this.send(i); }

  async loadFile(file, ctx, slot = -1) {
    const bytes = await file.arrayBuffer();
    return this.loadBytes(file.name.replace(/\.[^.]+$/, ''), bytes, ctx, { slot });
  }

  async loadBytes(name, bytes, ctx, { slot = -1, kind = null, persist = true } = {}) {
    const dec = await decodeAudio(bytes, ctx);
    if (!dec.ch.length || dec.ch[0].length < 2) throw new Error('empty audio: ' + name);
    if (slot < 0) slot = this.firstFree();
    if (slot < 0) throw new Error('pool full');
    const e = this.makeEntry(name, dec.ch, dec.sr, { clm: dec.clm, kind, bytes });
    this.set(slot, e);
    if (persist) await safe(db.put('samples', slot, { slot, name, bytes, kind }));
    return slot;
  }

  async setKind(slot, kind) {
    const e = this.slots[slot];
    if (!e || e.kind === kind) return;
    const n = this.makeEntry(e.name, e.ch, e.sr, { clm: e.clm, kind, factory: e.factory, bytes: e.bytes });
    this.set(slot, n);
    if (!e.factory && e.bytes) await safe(db.put('samples', slot, { slot, name: e.name, bytes: e.bytes, kind }));
  }

  async remove(slot) {
    const e = this.slots[slot];
    if (!e) return;
    this.set(slot, null);
    if (!e.factory) await safe(db.del('samples', slot));
  }

  async clearUser() {
    for (let i = 0; i < NUM_SLOTS; i++) if (this.slots[i] && !this.slots[i].factory) this.set(i, null);
    await safe(db.clear('samples'));
  }

  /** Restore user samples saved in IndexedDB. */
  async restore(ctx) {
    const rows = (await safe(db.all('samples'), [])) || [];
    for (const r of rows) {
      try {
        await this.loadBytes(r.name, r.bytes, ctx, { slot: r.slot, kind: r.kind, persist: false });
      } catch (e) { console.warn('restore failed', r.name, e); }
    }
    return rows.length;
  }
}
