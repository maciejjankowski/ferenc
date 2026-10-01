// Boot + DOM wiring + render loop.

import { App, KNOB_KEYS } from './app.js';
import { Knob, wheelSteps } from './ui/knob.js';
import { drawViz } from './ui/viz.js';
import { NUM_TRACKS, MACHINES } from './params.js';
import { patName, patternHasContent } from './project.js';

const app = new App();
window.ferenc = app; // handy for debugging from the console

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const panel = $('#panel');

// ---- layout scaling -------------------------------------------------------------------

let scale = 1;
function fit() {
  scale = Math.min(innerWidth / 1630, innerHeight / 1010);
  panel.style.transform = `scale(${scale})`;
}
addEventListener('resize', fit);
fit();

// ---- tiny DOM write cache ---------------------------------------------------------------

const cache = new WeakMap();
function put(el, prop, val) {
  let c = cache.get(el);
  if (!c) cache.set(el, (c = {}));
  if (c[prop] === val) return;
  c[prop] = val;
  if (prop === 'text') el.textContent = val;
  else if (prop === 'class') el.className = val;
  else if (prop === 'html') el.innerHTML = val;
  else el.style.setProperty(prop, val);
}

// ---- build dynamic controls -------------------------------------------------------------

const TRIG_KEYS = new Set(['note', 'vel', 'len']); // plain melodic trigs, not shown as p-locks
const keys = [];
const keyDown = new Set();
for (let i = 0; i < 16; i++) {
  const b = document.createElement('button');
  b.className = 'trig';
  b.style.setProperty('--x', 290 + (i % 8) * 172);
  b.style.setProperty('--y', i < 8 ? 756 : 876);
  b.innerHTML = `<span class="num">${i + 1}</span>`;
  b.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    keyDown.add(i);
    app.keyDown(i);
  });
  const up = () => { if (!keyDown.has(i)) return; keyDown.delete(i); app.keyUp(i); };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  b.addEventListener('contextmenu', e => { e.preventDefault(); app.keyContext(i); });
  $('#trigs').appendChild(b);
  keys.push(b);
}

const leds = [];
for (let i = 0; i < 8; i++) {
  const l = document.createElement('i');
  $('#leds').appendChild(l);
  leds.push(l);
}

const strip = [];
for (let i = 0; i < NUM_TRACKS; i++) {
  const d = document.createElement('div');
  d.className = 'ts';
  d.innerHTML = '<b></b><span></span><i></i>';
  d.addEventListener('click', () => app.selectTrack(i));
  d.addEventListener('contextmenu', e => { e.preventDefault(); app.toggleMute(i); });
  $('#tstrip').appendChild(d);
  strip.push({ el: d, b: d.querySelector('b'), s: d.querySelector('span'), m: d.querySelector('i') });
}

const cells = [];
for (let k = 0; k < 8; k++) {
  const c = document.createElement('div');
  c.className = 'cell';
  c.innerHTML = '<div class="lbl"><span></span><em></em></div><div class="val"></div><div class="bar"><i></i></div>';
  c.addEventListener('click', () => app.arm(app.armed === k ? null : k));
  $('#grid').appendChild(c);
  cells.push({ el: c, l: c.querySelector('.lbl span'), h: c.querySelector('.lbl em'), v: c.querySelector('.val'), bar: c.querySelector('.bar i') });
}

const knobs = $$('[data-knob]').map(el => {
  const k = +el.dataset.knob;
  return new Knob(el, {
    onBegin: () => { app.arm(k); app.knobBegin(k); },
    onMove: (d, fine) => app.knobMove(k, d, fine),
    onEnd: () => app.knobEnd(),
    onStep: (n, fine) => { app.arm(k); app.knobStep(k, n, fine); },
    onReset: () => app.knobReset(k),
  });
});

let mainStart = 0;
const mainKnob = new Knob($('#k-main'), {
  size: 80,
  onBegin: () => { mainStart = app.project.master; },
  onMove: (d, fine) => app.setMaster(Math.round(mainStart + d / (fine ? 10 : 2))),
  onStep: n => app.setMaster(app.project.master + n),
  onReset: () => app.setMaster(90),
});

let dataSteps = 0;
const dataKnob = new Knob($('#k-data'), {
  size: 80,
  onBegin: () => { dataSteps = 0; },
  onMove: (d, fine) => {
    const s = Math.trunc(d / 6);
    if (s !== dataSteps) { app.dataKnob(s - dataSteps, fine); dataSteps = s; }
  },
  onStep: (n, fine) => app.dataKnob(n, fine),
});

// ---- buttons ----------------------------------------------------------------------------

for (const b of $$('[data-btn]')) {
  const name = b.dataset.btn;
  b.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    b.classList.add('down');
    app.press(name, 'down');
  });
  const up = () => { if (!b.classList.contains('down')) return; b.classList.remove('down'); app.press(name, 'up'); };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  b.addEventListener('contextmenu', e => e.preventDefault());
}

// ---- menus (event delegation, survives re-renders) --------------------------------------

const menuEl = $('#menu');
menuEl.addEventListener('click', e => {
  const t = e.target.closest('[data-a]');
  if (!t || t.tagName === 'INPUT') return;
  app.menu().click?.(t.dataset.a, t.dataset.v);
  app.invalidate();
});
menuEl.addEventListener('change', e => {
  const t = e.target.closest('[data-a]');
  if (t) app.menu().input?.(t.dataset.a, t.value);
});
menuEl.addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur?.(); });

// ---- files ---------------------------------------------------------------------------------

const fileIn = $('#file-in'), folderIn = $('#folder-in'), projIn = $('#proj-in');
fileIn.addEventListener('change', () => { app.loadFiles(fileIn.files, { assign: true }); fileIn.value = ''; });
folderIn.addEventListener('change', () => { app.loadFiles(folderIn.files, { assign: true }); folderIn.value = ''; });
projIn.addEventListener('change', () => { if (projIn.files[0]) app.importProject(projIn.files[0]); projIn.value = ''; });

async function entriesToFiles(entries) {
  const out = [];
  const walk = async entry => {
    if (!entry) return;
    if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

const drop = $('#drop');
let dragDepth = 0;
addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; drop.classList.add('on'); e.preventDefault(); } });
addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drop.classList.remove('on'); });
addEventListener('drop', async e => {
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('on');
  if (!app.state.powered) await powerOn();
  const items = [...(e.dataTransfer.items || [])].map(it => it.webkitGetAsEntry?.()).filter(Boolean);
  const files = items.length ? await entriesToFiles(items) : [...e.dataTransfer.files];
  const json = files.find(f => f.name.endsWith('.json'));
  if (json) { app.importProject(json); return; }
  app.loadFiles(files, { assign: true });
});

// ---- help / power --------------------------------------------------------------------------

const help = $('#help');
function toggleHelp(force) { help.hidden = force === undefined ? !help.hidden : !force; }
help.addEventListener('click', e => { if (e.target === help) toggleHelp(false); });

app.ui = {
  pickFiles: () => fileIn.click(),
  pickFolder: () => folderIn.click(),
  pickProject: () => projIn.click(),
  toggleHelp,
};

for (const b of $$('[data-ui]')) {
  b.addEventListener('click', async () => {
    if (b.dataset.ui === 'help') toggleHelp();
    if (b.dataset.ui === 'power') {
      if (!app.state.powered) await powerOn();
      else if (app.engine.ctx.state === 'running') { app.seq.stop(); await app.engine.ctx.suspend(); app.toast('AUDIO SUSPENDED'); }
      else { await app.engine.ctx.resume(); app.toast('AUDIO ON'); }
    }
  });
}

let booting = null;
function powerOn() {
  if (!booting) {
    $('#boot-btn').textContent = 'STARTING…';
    booting = app.boot().then(() => {
      $('#boot').classList.add('gone');
    }).catch(err => {
      console.error(err);
      booting = null;
      $('#boot-btn').textContent = 'RETRY';
      $('.boot-hint').textContent = 'Audio failed to start: ' + (err.message || err) + ' — needs a modern browser served over http(s)';
    });
  }
  return booting;
}
$('#boot-btn').addEventListener('click', powerOn);

$('#h-flags').addEventListener('click', () => app.setKeyMode(app.keyMode === 'edit' ? 'play' : 'edit'));

// ---- keyboard / mouse edit ------------------------------------------------------------------

addEventListener('keydown', e => {
  if (!help.hidden && e.key === 'Escape') { toggleHelp(false); return; }
  if (!app.state.powered) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); powerOn(); }
    return;
  }
  app.onKey(e, true);
});
addEventListener('keyup', e => { if (app.state.powered) app.onKey(e, false); });
addEventListener('blur', () => {
  app.allNotesOff();
  app.holdKnob = null;
  app.state.func = false;
  app.invalidate();
});
// deltas from client coordinates (movementX/Y is unreliable across browsers / synthetic events)
let lastMX = null, lastMY = null;
addEventListener('mousemove', e => {
  if (app.holdKnob && lastMX !== null) app.mouseEdit(e.clientX - lastMX, e.clientY - lastMY, e.shiftKey);
  lastMX = e.clientX;
  lastMY = e.clientY;
});

const wacc = { v: 0 };
addEventListener('wheel', e => {
  if (!app.state.powered || app.armed === null || !help.hidden) return;
  if (e.target.closest?.('#menu .list, .knob')) return;
  const n = wheelSteps(wacc, e);
  if (app.bindings()[app.armed]) {
    e.preventDefault();
    if (n) app.wheelArmed(n, e.shiftKey);
  }
}, { passive: false });

// ---- render ---------------------------------------------------------------------------------

const canvas = $('#viz');
const g = canvas.getContext('2d');
const grid = $('#grid');
const H = {
  pat: $('#h-pat'), q: $('#h-q'), trk: $('#h-trk'), mach: $('#h-mach'), name: $('#h-name'),
  flags: $('#h-flags'), state: $('#h-state'), bpm: $('#h-bpm'),
};
const toastEl = $('#toast');
const btnEls = Object.fromEntries($$('[data-btn]').map(b => [b.dataset.btn, b]));
const ledIn = $('#led-midiin'), ledOut = $('#led-midiout'), ledPow = $('#led-power');

function sizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const cssW = r.width / scale, cssH = r.height / scale;
  g.setTransform(w / cssW, 0, 0, h / cssH, 0, 0);
  return [cssW, cssH];
}

function renderMenu() {
  const st = app.state;
  if (!st.menu) {
    if (!menuEl.hidden) { menuEl.hidden = true; menuEl.innerHTML = ''; }
    grid.classList.remove('hidden');
    return;
  }
  const m = app.menu();
  grid.classList.toggle('hidden', !!m.hideGrid);
  menuEl.hidden = false;
  if (!app.dirty && !app.menuDirty) return;
  if (menuEl.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const list = menuEl.querySelector('[data-scroll], .list');
  const top = list ? list.scrollTop : 0;
  const pages = m.pages ? `${st.menuSub + 1}/${m.pages}` : '';
  menuEl.innerHTML = `<div class="mtitle"><span>${m.title}</span><span>${pages}</span></div>` + m.html();
  const nl = menuEl.querySelector('[data-scroll], .list');
  if (nl) {
    nl.scrollTop = top;
    if (app.menuScroll || app.menuDirty) {
      nl.querySelector('.row.cur')?.scrollIntoView({ block: 'nearest' });
      app.menuScroll = false;
    }
  }
  app.menuDirty = false;
}

function keyClasses(now) {
  const st = app.state, pr = app.project, pat = app.pattern();
  const t = st.track, pt = pat.tracks[t];
  const audible = app.seq.audibleStep(t);
  if (st.follow && app.seq.playing && audible >= 0 && st.lockStep === null && st.heldStep === null) {
    st.stepPage = Math.min(app.stepPages() - 1, Math.floor(audible / 16));
  }
  const aud = app.seq.playing ? app.engine.audibleTime() : -1;
  const flashing = i => aud >= 0 && aud >= app.trigFlash[i] && aud - app.trigFlash[i] < 0.11;
  const out = [];
  for (let i = 0; i < 16; i++) {
    let c = '';
    switch (st.mode) {
      case 'trk': c = i < NUM_TRACKS ? (i === t ? 'white' : flashing(i) ? 'on' : '') : 'off'; break;
      case 'mute': c = i < NUM_TRACKS ? (pr.tracks[i].mute ? 'off' : 'green') + (i === t ? ' sel' : '') : 'off'; break;
      case 'bank': c = i < 4 ? (i === st.bank ? 'white' : '') : 'off'; break;
      case 'ptn': {
        const idx = st.bank * 16 + i;
        c = idx === pr.current ? 'white' : patternHasContent(pr.patterns[idx]) ? 'on' : '';
        if (app.seq.queued === idx) c += ' blinky';
        break;
      }
      case 'perf':
        c = i < NUM_TRACKS ? (flashing(i) || app.kbHeld.has('k' + i) ? 'white' : '') : (pr.tracks[i - NUM_TRACKS].mute ? 'off' : 'green');
        break;
      default:
        if (st.kb) {
          const n = app.kbNote(i);
          c = app.kbHeld.has('k' + i) ? 'white' : n % 12 === pr.kb.root % 12 ? 'root' : '';
        } else {
          const idx = st.stepPage * 16 + i;
          if (idx >= pt.len) { c = 'off'; break; }
          const s = pt.steps[idx];
          if (s) c = Object.keys(s.locks).some(k => !TRIG_KEYS.has(k)) ? 'lock' : 'on';
          if (idx === audible) c += ' play';
          if (idx === st.lockStep || idx === st.heldStep) c += ' sel';
        }
    }
    out.push('trig ' + c + (keyDown.has(i) ? ' down' : ''));
  }
  // page LEDs: top row = pages / visible page, bottom row = playing page
  const pages = app.stepPages();
  const ap = audible >= 0 ? Math.floor(audible / 16) : -1;
  for (let k = 0; k < 4; k++) {
    put(leds[k], 'class', k === st.stepPage ? 'on' : k < pages ? 'dim' : '');
    put(leds[k + 4], 'class', 'g' + (k === ap ? ' on' : ''));
  }
  return out;
}

function frame() {
  requestAnimationFrame(frame);
  const st = app.state;
  if (!st.powered) return;
  const now = performance.now();
  const pr = app.project, tr = app.curTrack(), seq = app.seq;

  // keys
  const kc = keyClasses(now);
  for (let i = 0; i < 16; i++) put(keys[i], 'class', kc[i]);

  // button LEDs
  const lit = {
    func: st.func, kb: st.kb, trk: st.mode === 'trk' || st.mode === 'mute', ptn: st.mode === 'ptn' || st.mode === 'bank',
    song: st.song, rec: st.rec, play: seq.playing, page: st.fill, proj: st.mode === 'perf' || st.menu === 'project',
    settings: st.menu === 'settings', samples: st.menu === 'samples', tempo: st.menu === 'tempo',
  };
  for (const name in btnEls) {
    const el = btnEls[name];
    let on = name.startsWith('pg:') ? !st.menu && st.page === name.slice(3) : !!lit[name];
    let cls = el.className.replace(/\s*\b(lit|blink)\b/g, '');
    if (on) cls += ' lit';
    if (name === 'play' && seq.paused) cls += ' blink';
    put(el, 'class', cls);
  }

  // header
  put(H.pat, 'text', patName(pr.current));
  put(H.q, 'text', seq.queued !== null ? '→' + patName(seq.queued) : '');
  put(H.trk, 'text', 'T' + (st.track + 1));
  put(H.mach, 'text', MACHINES[tr.p.mach]);
  put(H.name, 'text', app.pool.label(app.pval('smp') | 0));
  const flags = [app.keyMode === 'edit' ? 'EDIT' : 'PLAY'];
  if (st.rec) flags.push('●REC');
  if (st.fill) flags.push('FILL');
  if (st.song) flags.push('SONG');
  if (st.kb) flags.push('KB' + (pr.kb.oct ? (pr.kb.oct > 0 ? '+' : '') + pr.kb.oct : ''));
  else if (pr.kb.oct) flags.push('OCT' + (pr.kb.oct > 0 ? '+' : '') + pr.kb.oct);
  put(H.flags, 'text', flags.join(' '));
  put(H.state, 'text', seq.playing ? '▶' : seq.paused ? '❚❚' : '■');
  put(H.bpm, 'text', (seq.extClock ? 'EXT ' : '') + pr.bpm.toFixed(1));

  // track strip
  const peaks = app.engine.viz.peaks;
  for (let i = 0; i < NUM_TRACKS; i++) {
    const t = pr.tracks[i], s = strip[i];
    put(s.el, 'class', 'ts' + (i === st.track ? ' cur' : '') + (t.mute ? ' mute' : ''));
    put(s.b, 'text', String(i + 1));
    put(s.s, 'text', app.pool.shortLabel(t.p.smp).slice(0, 6));
    put(s.m, 'width', Math.min(100, (peaks[i] || 0) * 110).toFixed(0) + '%');
  }

  // parameter grid + knobs
  const bs = app.bindings();
  for (let k = 0; k < 8; k++) {
    const b = bs[k], c = cells[k];
    const hint = app.keyMode === 'edit' ? KNOB_KEYS[k] : '';
    if (!b) {
      put(c.el, 'class', 'cell empty' + (app.armed === k ? ' hot' : ''));
      put(c.l, 'text', '—'); put(c.h, 'text', hint); put(c.v, 'text', ''); put(c.bar, 'width', '0');
      knobs[k].set(null);
      continue;
    }
    const v = b.get() ?? b.def.def;
    const d = b.def;
    const norm = d.max > d.min ? (v - d.min) / (d.max - d.min) : 0;
    const bip = d.min < 0;
    const locked = b.locked();
    put(c.el, 'class', 'cell' + (locked ? ' lock' : '') + (app.armed === k ? ' hot' : ''));
    put(c.l, 'text', d.label);
    put(c.h, 'text', hint);
    put(c.v, 'text', b.fmt(v));
    if (bip) {
      const z = -d.min / (d.max - d.min);
      put(c.bar, 'left', (Math.min(z, norm) * 100).toFixed(1) + '%');
      put(c.bar, 'width', (Math.abs(norm - z) * 100).toFixed(1) + '%');
    } else {
      put(c.bar, 'left', '0');
      put(c.bar, 'width', (norm * 100).toFixed(1) + '%');
    }
    knobs[k].set(norm, { bipolar: bip, locked });
    knobs[k].el.classList.toggle('armed', app.armed === k);
  }
  mainKnob.set(pr.master / 127);
  dataKnob.set(app.pval('vol') / 127);

  renderMenu();
  if (!st.menu) {
    const [w, h] = sizeCanvas();
    drawViz(g, w, h, app);
  }

  put(toastEl, 'class', now < st.toastUntil ? 'on' : '');
  if (now < st.toastUntil) put(toastEl, 'text', st.toast);
  ledIn.classList.toggle('on', now - app.flashes.midiIn < 90);
  ledOut.classList.toggle('on', now - app.flashes.midiOut < 90);
  ledPow.classList.toggle('on', app.engine.ctx?.state === 'running');
  app.dirty = false;
}

requestAnimationFrame(frame);
