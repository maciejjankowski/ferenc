// Screen menus. Each menu returns:
//   html()        markup for the screen body (re-rendered when the app is dirty)
//   bindings()    8 knob bindings (or nulls)
//   click(a, v)   delegated clicks on [data-a] elements
//   up/down/left/right/yes/no/data(d)  optional navigation handlers (no() returning true = handled)

import { PARAMS, SCALES, KB_SCALES, FX_PAGES, NUM_TRACKS, NUM_SLOTS, MACHINES, noteName } from '../params.js';
import { patName, patternHasContent } from '../project.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n, w = 3) => String(n).padStart(w, '0');

const def = (id, label, min, max, d, o = {}) => ({
  id, label, min, max, def: d, int: o.int ?? true, opts: o.opts || null, fmt: o.fmt || null, lock: false, phys: v => v,
});
const ONOFF = ['OFF', 'ON'];
const chanFmt = zero => v => (v === 0 ? zero : String(v));

let confirmKey = null;
let confirmUntil = 0;
function confirm(app, key, msg) {
  const now = performance.now();
  if (confirmKey === key && now < confirmUntil) { confirmKey = null; return true; }
  confirmKey = key;
  confirmUntil = now + 2500;
  app.toast(msg + ' · PRESS AGAIN');
  return false;
}

export function menuFor(app, name) {
  switch (name) {
    case 'samples': return samples(app);
    case 'project': return project(app);
    case 'settings': return settings(app);
    case 'tempo': return tempo(app);
    case 'seqsetup': return seqsetup(app);
    case 'trksetup': return trksetup(app);
    case 'kbsetup': return kbsetup(app);
    case 'fx': return fx(app);
    case 'mixer': return mixer(app);
    case 'song': return song(app);
  }
  return { title: name, html: () => '' };
}

function samples(app) {
  const st = app.state, pool = app.pool;
  const move = d => { st.cursor = Math.max(0, Math.min(NUM_SLOTS - 1, st.cursor + d)); app.menuScroll = true; };
  return {
    title: 'SAMPLES',
    hideGrid: true,
    html() {
      const cur = app.curTrack().p.smp;
      let rows = '';
      for (let i = 0; i < NUM_SLOTS; i++) {
        const e = pool.slots[i];
        let tag = '', len = '';
        if (e) {
          if (e.kind === 'cycle') { tag = e.frames > 1 ? 'WT' : 'CYC'; len = e.frames > 1 ? e.frames + 'fr' : e.cycLen + 'smp'; }
          else { tag = 'SMP'; len = (e.len / e.sr).toFixed(2) + 's'; }
        }
        rows += `<div class="row${i === st.cursor ? ' cur' : ''}${e ? '' : ' empty'}" data-a="slot" data-v="${i}">` +
          `<span class="n">${pad(i + 1)}</span><span class="nm">${e ? esc(e.name) : '---'}</span>` +
          `<span class="tag">${tag}</span><span class="len">${len}</span><span class="mk">${i === cur ? '◀' : ''}</span></div>`;
      }
      return `<div class="list" data-scroll>${rows}</div>
        <div class="actions">
          <button data-a="load">LOAD FILES</button><button data-a="folder">LOAD FOLDER</button>
          <button data-a="kind">CYC ⇄ SMP</button><button data-a="del">DELETE</button>
        </div>
        <div class="hint">click = assign to T${st.track + 1} + preview · drop files anywhere · ▲▼ / LEVEL browse · YES assign</div>`;
    },
    up: () => move(-1), down: () => move(1), data: d => move(d),
    yes: () => app.preview(st.cursor),
    click(a, v) {
      if (a === 'slot') { st.cursor = +v; if (pool.slots[+v]) app.preview(+v); }
      else if (a === 'load') app.ui.pickFiles();
      else if (a === 'folder') app.ui.pickFolder();
      else if (a === 'kind') {
        const e = pool.slots[st.cursor];
        if (e) pool.setKind(st.cursor, e.kind === 'cycle' ? 'sample' : 'cycle').then(() => app.toast(`${e.name}: ${pool.slots[st.cursor].kind.toUpperCase()}`));
      } else if (a === 'del') {
        const e = pool.slots[st.cursor];
        if (e && confirm(app, 'del' + st.cursor, 'DELETE ' + e.name)) pool.remove(st.cursor).then(() => app.toast('DELETED'));
      }
    },
  };
}

function project(app) {
  const pr = app.project;
  return {
    title: 'PROJECT',
    hideGrid: true,
    html() {
      const used = pr.patterns.filter(patternHasContent).length;
      const user = app.pool.slots.filter(e => e && !e.factory).length;
      return `<div class="form">
          <label>NAME <input data-a="name" maxlength="24" value="${esc(pr.name)}"></label>
          <div class="info">PATTERNS IN USE ${used} · USER SAMPLES ${user} · ${pr.bpm.toFixed(1)} BPM</div>
          <div class="info dim">Autosaves to this browser. SAVE = snapshot (FUNC+NO reloads it).</div>
        </div>
        <div class="actions wrap">
          <button data-a="save">SAVE</button><button data-a="reload">RELOAD</button>
          <button data-a="export">EXPORT FILE</button><button data-a="import">IMPORT FILE</button>
          <button data-a="new">NEW</button><button data-a="demo">DEMO</button><button data-a="clearsmp">CLEAR SAMPLES</button>
        </div>`;
    },
    input(a, v) { if (a === 'name') { pr.name = v.toUpperCase().slice(0, 24); app.changed(); } },
    click(a) {
      if (a === 'save') app.saveProject();
      else if (a === 'reload') app.reloadProject();
      else if (a === 'export') app.exportProject();
      else if (a === 'import') app.ui.pickProject();
      else if (a === 'new' && confirm(app, 'new', 'NEW PROJECT')) app.newProject(false);
      else if (a === 'demo' && confirm(app, 'demo', 'LOAD DEMO')) app.newProject(true);
      else if (a === 'clearsmp' && confirm(app, 'clr', 'CLEAR USER SAMPLES')) app.pool.clearUser().then(() => app.toast('USER SAMPLES CLEARED'));
    },
  };
}

function settings(app) {
  const m = app.midi, s = m.settings;
  const ins = m.inputOptions(), outs = m.outputOptions();
  const idxOf = (list, id) => Math.max(0, list.findIndex(o => o.id === id));
  const b = (d, get, set) => app.objBinding(d, get, set);
  const flag = (id, label) => b(def(id, label, 0, 1, 0, { opts: ONOFF }), () => s[id] ? 1 : 0, v => m.set(id, v));
  return {
    title: 'MIDI SETUP',
    bindings: () => [
      b(def('in', 'IN', 0, ins.length - 1, 1, { opts: ins.map(o => o.name.slice(0, 8)) }), () => idxOf(ins, s.in), v => m.set('in', ins[v].id)),
      b(def('out', 'OUT', 0, outs.length - 1, 0, { opts: outs.map(o => o.name.slice(0, 8)) }), () => idxOf(outs, s.out), v => m.set('out', outs[v].id)),
      b(def('ach', 'ACH', 0, 16, 0, { fmt: chanFmt('ALL') }), () => s.ach, v => m.set('ach', v)),
      flag('clkIn', 'CLKI'), flag('clkOut', 'CLKO'), flag('thru', 'THRU'), flag('pc', 'PRGC'), null,
    ],
    html() {
      const status = !m.supported ? 'NOT SUPPORTED (use Chrome/Edge/Firefox)' : m.access ? 'READY' : m.error || 'WAITING FOR PERMISSION';
      return `<div class="form">
        <div class="info">MIDI ${esc(status)}</div>
        <div class="info">IN&nbsp; ${esc(ins[idxOf(ins, s.in)]?.name || 'NONE')}</div>
        <div class="info">OUT ${esc(outs[idxOf(outs, s.out)]?.name || 'NONE')}</div>
        <div class="info dim">ACH: channel driving the active track (per-track channels: FUNC+FLTR).
        CC 16-23 = knobs A-H · 74 FREQ · 71 RESO · 73 ATK · 72 REL · 75 DEC · 7 VOL · 10 PAN · 1 LFO1 DEP ·
        76-79 GRAIN POS/SIZE/DENS/SPRY · 80 WPOS · 64 SUSTAIN · PB ±2 · PRG CHG = pattern</div>
      </div>
      <div class="actions">${m.access ? '<button data-a="rescan">RESCAN</button>' : m.supported ? '<button data-a="enable">ENABLE MIDI</button>' : ''}</div>`;
    },
    click(a) { if (a === 'rescan') m.refresh(); if (a === 'enable') m.init().then(() => app.invalidate()); },
  };
}

function tempo(app) {
  const pr = app.project;
  return {
    title: 'TEMPO',
    bindings: () => [
      app.objBinding(def('bpm', 'BPM', 30, 300, 120, { int: false, fmt: v => v.toFixed(1) }), () => pr.bpm, v => app.setBpm(v)),
      app.objBinding(def('swing', 'SWNG', 50, 80, 50, { fmt: v => v + '%' }), () => app.pattern().swing, v => { app.pattern().swing = v; }),
      app.objBinding(def('mlen', 'MLEN', 1, 64, 16), () => app.pattern().len, v => { app.pattern().len = v; }),
      null, null, null, null,
      app.objBinding(def('master', 'MAIN', 0, 127, 90), () => pr.master, v => app.setMaster(v)),
    ],
    html: () => `<div class="big">${pr.bpm.toFixed(1)}<small> BPM</small></div>
      <div class="hint">${app.seq.extClock ? 'EXTERNAL MIDI CLOCK' : 'INTERNAL CLOCK'} · FUNC+TAP = tap tempo · LEVEL/DATA = bpm (SHIFT fine)</div>`,
    data: (d, fine) => app.setBpm(pr.bpm + d * (fine ? 0.1 : 1)),
  };
}

function seqsetup(app) {
  const st = app.state;
  const pt = () => app.ptrack();
  return {
    title: 'SEQUENCER',
    bindings: () => [
      app.objBinding(def('tlen', 'TLEN', 1, 64, 16), () => pt().len, v => { pt().len = v; if (st.stepPage >= app.stepPages()) st.stepPage = 0; }),
      app.objBinding(def('tscl', 'SCAL', 0, SCALES.length - 1, 4, { opts: SCALES.map(s => s.l) }), () => pt().scale, v => { pt().scale = v; }),
      app.objBinding(def('mlen', 'MLEN', 1, 64, 16), () => app.pattern().len, v => { app.pattern().len = v; }),
      app.objBinding(def('swing', 'SWNG', 50, 80, 50, { fmt: v => v + '%' }), () => app.pattern().swing, v => { app.pattern().swing = v; }),
      app.objBinding(def('qnt', 'QNT', 0, 1, 1, { opts: ONOFF }), () => (st.quantize ? 1 : 0), v => { st.quantize = !!v; }),
      app.objBinding(def('folw', 'FOLW', 0, 1, 1, { opts: ONOFF }), () => (st.follow ? 1 : 0), v => { st.follow = !!v; }),
      null, null,
    ],
    html: () => `<div class="form">
        <div class="info">T${st.track + 1} LENGTH ${pt().len} · SCALE ${SCALES[pt().scale].l} · PATTERN ${patName(app.project.current)} MASTER ${app.pattern().len}</div>
        <div class="info dim">Per-track length/scale = polymeter. MLEN restarts all tracks. QNT = live-record quantize.</div>
      </div>
      <div class="actions"><button data-a="all">APPLY TLEN+SCAL TO ALL TRACKS</button></div>`,
    yes() { this.click('all'); },
    click(a) {
      if (a !== 'all') return;
      const src = pt();
      for (const t of app.pattern().tracks) { t.len = src.len; t.scale = src.scale; }
      app.changed();
      app.toast('APPLIED TO ALL TRACKS');
    },
  };
}

function trksetup(app) {
  const st = app.state;
  const tr = () => app.curTrack();
  const P = id => app.objBinding(PARAMS[id], () => tr().p[id], v => app.setParam(id, v, st.track, { lockable: false }));
  return {
    title: 'TRACK SETUP',
    bindings: () => [
      P('mach'), P('poly'),
      app.objBinding(def('inch', 'INCH', 0, 16, 0, { fmt: chanFmt('AUTO') }), () => tr().inCh, v => { tr().inCh = v; }),
      app.objBinding(def('outc', 'OUTC', 0, 16, 0, { fmt: chanFmt('OFF') }), () => tr().outCh, v => { tr().outCh = v; }),
      app.objBinding(def('int', 'INT', 0, 1, 1, { opts: ONOFF }), () => tr().int, v => { tr().int = v; }),
      null, null, null,
    ],
    html: () => `<div class="form">
        <div class="info">T${st.track + 1} · ${MACHINES[tr().p.mach]} · ${esc(app.pool.label(tr().p.smp))}</div>
        <div class="info dim">INCH: MIDI channel that always plays this track (AUTO = follows the active track).
        OUTC: send this track's sequencer notes to MIDI out. INT OFF = MIDI-only track (drive external synths).</div>
      </div>`,
  };
}

function kbsetup(app) {
  const kb = app.project.kb;
  return {
    title: 'KEYBOARD',
    bindings: () => [
      app.objBinding(def('oct', 'OCT', -4, 4, 0, { fmt: v => (v > 0 ? '+' : '') + v }), () => kb.oct, v => { kb.oct = v; }),
      app.objBinding(def('root', 'ROOT', 0, 11, 0, { fmt: v => noteName(v).replace(/-?\d+$/, '') }), () => kb.root, v => { kb.root = v; }),
      app.objBinding(def('scale', 'SCAL', 0, KB_SCALES.length - 1, 0, { opts: KB_SCALES.map(s => s.l) }), () => kb.scale, v => { kb.scale = v; }),
      null, null, null, null, null,
    ],
    html: () => `<div class="form">
        <div class="info">KEYS 1-16: ${Array.from({ length: 16 }, (_, i) => noteName(app.kbNote(i))).join(' ')}</div>
        <div class="info dim">KB button turns the 16 trig keys into a scale keyboard for the active track.
        Computer keys (Tab = PLAY mode) A W S E D F T G Y H U J K O L P = chromatic, Z/X = octave. REC arms live recording while playing.</div>
      </div>`,
  };
}

function fx(app) {
  const st = app.state;
  return {
    title: st.menuSub ? 'REVERB' : 'DELAY',
    pages: 2,
    bindings: () => FX_PAGES[st.menuSub].map(id => (id ? app.fxBinding(id) : null)),
    html: () => `<div class="form">
        <div class="info">${st.menuSub ? 'REVERB · algorithmic convolution' : 'DELAY · tempo-synced, X = ping-pong'} &nbsp; (${st.menuSub + 1}/2)</div>
        <div class="info dim">Track sends: FX page DEL / REV. Press FUNC+FX again or ◀ ▶ to switch.</div>
      </div>`,
    left: () => { st.menuSub = 0; }, right: () => { st.menuSub = 1; },
  };
}

function mixer(app) {
  const pr = app.project;
  return {
    title: 'MIXER',
    bindings: () => Array.from({ length: NUM_TRACKS }, (_, i) =>
      app.objBinding({ ...PARAMS.vol, label: 'VOL' + (i + 1) }, () => pr.tracks[i].p.vol, v => app.setParam('vol', v, i, { lockable: false }))),
    html: () => `<div class="mix">${pr.tracks.map((t, i) => `
        <div class="mstrip${t.mute ? ' muted' : ''}${i === app.state.track ? ' cur' : ''}" data-a="sel" data-v="${i}">
          <b>${i + 1}</b><span>${MACHINES[t.p.mach]}</span><span class="nm">${esc(app.pool.shortLabel(t.p.smp))}</span>
          <button data-a="mute" data-v="${i}">${t.mute ? 'MUTED' : 'ON'}</button>
        </div>`).join('')}</div>`,
    click(a, v) {
      if (a === 'mute') app.toggleMute(+v);
      else if (a === 'sel') app.selectTrack(+v);
    },
  };
}

function song(app) {
  const st = app.state, pr = app.project;
  return {
    title: 'SONG / CHAIN',
    hideGrid: true,
    html: () => `<div class="list">${pr.song.length ? pr.song.map((p, i) =>
      `<div class="row${i === st.cursor ? ' cur' : ''}" data-a="row" data-v="${i}"><span class="n">${pad(i + 1, 2)}</span><span class="nm">${patName(p)}</span></div>`).join('')
      : '<div class="row empty"><span class="nm">EMPTY CHAIN · enable SONG, then PTN + keys to append</span></div>'}</div>
      <div class="actions">
        <button data-a="toggle">${st.song ? 'SONG MODE: ON' : 'SONG MODE: OFF'}</button>
        <button data-a="add">ADD ${patName(pr.current)}</button><button data-a="del">DELETE</button><button data-a="clear">CLEAR</button>
      </div>`,
    up: () => { st.cursor = Math.max(0, st.cursor - 1); },
    down: () => { st.cursor = Math.min(Math.max(0, pr.song.length - 1), st.cursor + 1); },
    click(a, v) {
      if (a === 'row') st.cursor = +v;
      else if (a === 'toggle') st.song = !st.song;
      else if (a === 'add') { pr.song.push(pr.current); app.changed(); }
      else if (a === 'del') { pr.song.splice(st.cursor, 1); st.cursor = Math.max(0, Math.min(st.cursor, pr.song.length - 1)); app.changed(); }
      else if (a === 'clear' && confirm(app, 'clrsong', 'CLEAR CHAIN')) { pr.song = []; st.cursor = 0; app.changed(); }
    },
  };
}
