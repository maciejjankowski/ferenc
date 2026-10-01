// Screen visualisations (canvas). One draw function per parameter page.

import { PARAMS, M_WAVE, M_SMPL, M_GRAN, MACHINES, LFO_DESTS, SMP_MODES, envTime, cutoffNote, noteHz, noteName, LEN_STEPS } from '../params.js';

const C = {
  bg: '#04090b', fg: '#e6f3f6', mid: '#8fb3bd', dim: '#2b4047', faint: '#14252b',
  hot: '#ffb547', red: '#ff5a4e', green: '#7dffb0',
};

const TAU = Math.PI * 2;

function lfoWave(shape, ph, cyc) {
  const h = n => { n = Math.sin(n * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };
  switch (shape) {
    case 0: return ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
    case 1: return Math.sin(TAU * ph);
    case 2: return ph < 0.5 ? 1 : -1;
    case 3: return 1 - 2 * ph;
    case 4: return 2 * ph - 1;
    case 5: return Math.exp(-6 * ph);
    case 6: return h(cyc) * 2 - 1;
    case 7: { const a = h(cyc) * 2 - 1, b = h(cyc + 1) * 2 - 1; return a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * ph)); }
  }
  return 0;
}

function label(g, text, x, y, color = C.mid, align = 'left', size = 11) {
  g.font = `${size}px ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'top';
  g.fillText(text, x, y);
}

function drawPeaks(g, peaks, x0, y0, w, h, color, from = 0, to = 1) {
  const n = peaks.length / 2;
  g.fillStyle = color;
  const mid = y0 + h / 2;
  for (let x = 0; x < w; x++) {
    const a = from + (to - from) * x / w, b = from + (to - from) * (x + 1) / w;
    const i0 = Math.floor(a * n), i1 = Math.max(i0 + 1, Math.floor(b * n));
    let mn = 1, mx = -1;
    for (let i = i0; i < i1 && i < n; i++) { mn = Math.min(mn, peaks[i * 2]); mx = Math.max(mx, peaks[i * 2 + 1]); }
    if (mx < mn) continue;
    const top = mid - mx * h * 0.48, bot = mid - mn * h * 0.48;
    g.fillRect(x0 + x, top, 1, Math.max(1, bot - top));
  }
}

function envShape(g, x0, y0, w, h, a, d, s, r, color, ahd = false) {
  const ta = Math.sqrt(a), td = Math.sqrt(d), ts = ahd ? 0 : 0.5, tr = ahd ? 0 : Math.sqrt(r);
  const tot = ta + td + ts + tr || 1;
  const k = w / tot;
  const Y = v => y0 + h - v * h;
  g.strokeStyle = color; g.lineWidth = 2;
  g.beginPath();
  g.moveTo(x0, Y(0));
  let x = x0 + ta * k;
  g.lineTo(x, Y(1));
  const sus = ahd ? 0 : s;
  for (let i = 1; i <= 24; i++) g.lineTo(x + td * k * i / 24, Y(sus + (1 - sus) * Math.exp(-5 * i / 24)));
  x += td * k;
  if (!ahd) {
    g.lineTo(x + ts * k, Y(sus));
    x += ts * k;
    for (let i = 1; i <= 24; i++) g.lineTo(x + tr * k * i / 24, Y(sus * Math.exp(-5 * i / 24)));
  }
  g.stroke();
  g.fillStyle = 'rgba(230,243,246,0.06)';
  g.lineTo(x0 + w, Y(0)); g.lineTo(x0, Y(0)); g.fill();
}

function svfMag(type, r, k) {
  const den = Math.sqrt((1 - r * r) ** 2 + (k * r) ** 2);
  switch (type) {
    case 0: return 1 / den;
    case 1: return (1 / den) * (1 / Math.sqrt((1 - r * r) ** 2 + (1.4142 * r) ** 2));
    case 2: return (k * r) / den;
    case 3: return (r * r) / den;
    default: return Math.abs(1 - r * r) / den;
  }
}

export function drawViz(g, w, h, app) {
  g.fillStyle = C.bg;
  g.fillRect(0, 0, w, h);
  const st = app.state;
  const tr = app.curTrack();
  const P = id => app.pval(id);
  const mach = tr.p.mach;
  const page = st.page;
  const pad = 8;
  const pages = app.pageCount();
  label(g, page + (pages > 1 ? ` ${st.sub + 1}/${pages}` : '') + (page === 'SRC' ? ' · ' + MACHINES[mach] : ''), pad, 4, C.mid);
  if (st.lockStep !== null) label(g, `LOCK STEP ${String(st.lockStep + 1).padStart(2, '0')}`, w - pad, 4, C.hot, 'right');

  const X = pad, Y = 20, W = w - pad * 2, H = h - Y - 6;
  const slot = app.pool.slots[P('smp') | 0];

  if (page === 'SRC') {
    if (!slot) {
      label(g, 'EMPTY SLOT', w / 2, h / 2 - 16, C.mid, 'center', 14);
      label(g, 'press SAMPLES or drop audio files here', w / 2, h / 2 + 4, C.dim, 'center');
      return;
    }
    if (mach === M_WAVE) drawWave(g, X, Y, W, H, slot, P);
    else drawSample(g, X, Y, W, H, slot, P, mach, app);
    return;
  }
  if (page === 'TRIG') return drawLane(g, X, Y, W, H, app);
  if (page === 'FLTR') {
    const fc = noteHz(cutoffNote(P('freq')));
    const k = 2 - 2 * Math.min(0.995, P('reso') / 127);
    const type = P('ftyp');
    const fw = W * 0.62;
    g.strokeStyle = C.faint; g.lineWidth = 1;
    for (const f of [100, 1000, 10000]) {
      const x = X + fw * Math.log(f / 20) / Math.log(1000);
      g.beginPath(); g.moveTo(x, Y); g.lineTo(x, Y + H); g.stroke();
    }
    g.strokeStyle = C.fg; g.lineWidth = 2; g.beginPath();
    for (let x = 0; x <= fw; x++) {
      const f = 20 * Math.pow(1000, x / fw);
      const db = 20 * Math.log10(svfMag(type, f / fc, k) + 1e-6);
      const y = Y + H * (1 - (Math.max(-42, Math.min(24, db)) + 42) / 66);
      x === 0 ? g.moveTo(X + x, y) : g.lineTo(X + x, y);
    }
    g.stroke();
    label(g, 'ENV', X + fw + 14, Y, C.mid);
    envShape(g, X + fw + 14, Y + 16, W - fw - 14, H - 18, envTime(P('fatk')), envTime(P('fdec')), P('fsus') / 127, envTime(P('frel')),
      P('fenv') === 0 ? C.dim : C.fg);
    return;
  }
  if (page === 'AMP') {
    envShape(g, X, Y + 4, W * 0.78, H - 6, envTime(P('atk')), envTime(P('dec')), P('sus') / 127, envTime(P('rel')), C.fg, P('amod') === 1);
    const px = X + W * 0.9, pan = P('pan') / 64;
    g.strokeStyle = C.dim; g.lineWidth = 1;
    g.beginPath(); g.arc(px, Y + H / 2, 22, Math.PI, 0); g.stroke();
    g.strokeStyle = C.fg; g.lineWidth = 2;
    g.beginPath(); g.moveTo(px, Y + H / 2);
    g.lineTo(px + Math.sin(pan * Math.PI / 2) * 22, Y + H / 2 - Math.cos(pan * Math.PI / 2) * 22); g.stroke();
    label(g, 'PAN', px, Y + H / 2 + 6, C.mid, 'center');
    return;
  }
  if (page === 'FX') {
    const bits = P('br') === 0 ? 0 : 16 - P('br') * 15 / 127;
    const q = bits ? Math.pow(2, bits - 1) : 0;
    const hold = Math.pow(2, P('srr') / 127 * 6);
    const drv = P('driv') / 127, dg = 1 + drv * drv * 24;
    g.strokeStyle = C.dim; g.lineWidth = 1; g.beginPath();
    for (let x = 0; x <= W; x++) { const y = Y + H / 2 - Math.sin(TAU * 2 * x / W) * H * 0.4; x ? g.lineTo(X + x, y) : g.moveTo(X, y); }
    g.stroke();
    g.strokeStyle = C.fg; g.lineWidth = 2; g.beginPath();
    let held = 0, cnt = 0;
    for (let x = 0; x <= W; x++) {
      if (cnt <= 0 || P('srr') === 0) { held = Math.sin(TAU * 2 * x / W) * 0.8; cnt += hold * W / 256; }
      cnt -= 1;
      let v = held;
      if (q) v = Math.round(v * q) / q;
      if (drv > 0.001) v = Math.tanh(v * dg);
      const y = Y + H / 2 - v * H * 0.45;
      x ? g.lineTo(X + x, y) : g.moveTo(X, y);
    }
    g.stroke();
    label(g, `DEL ${Math.round(P('dly'))}  REV ${Math.round(P('rev'))}`, X + W, Y + H - 12, C.mid, 'right');
    return;
  }
  if (page === 'MOD') {
    const k = st.sub + 1;
    const wav = P(`l${k}wav`), sph = P(`l${k}sph`) / 128, dep = P(`l${k}dep`) / 64, dst = P(`l${k}dst`);
    g.strokeStyle = C.faint; g.beginPath(); g.moveTo(X, Y + H / 2); g.lineTo(X + W, Y + H / 2); g.stroke();
    g.strokeStyle = dst && dep ? C.fg : C.dim; g.lineWidth = 2; g.beginPath();
    for (let x = 0; x <= W; x++) {
      const t = sph + 2 * x / W, cyc = Math.floor(t);
      const y = Y + H / 2 - lfoWave(wav, t - cyc, cyc) * (dep || 1) * H * 0.45;
      x ? g.lineTo(X + x, y) : g.moveTo(X, y);
    }
    g.stroke();
    label(g, `LFO${k} → ${LFO_DESTS[dst]}`, X + W, Y, dst ? C.fg : C.dim, 'right');
  }
}

function drawWave(g, X, Y, W, H, slot, P) {
  const wt = slot.wt;
  if (!wt) {
    drawPeaks(g, slot.peaks, X, Y, W, H, C.mid);
    label(g, 'SAMPLE AS CYCLE', X + W, Y + H - 12, C.hot, 'right');
    return;
  }
  const tbl = wt.levels[0], stride = wt.cyc + 1;
  const pos = (P('wpos') / 127) * (wt.frames - 1);
  const drawFrame = (f, x0, y0, w, h, color, lw) => {
    g.strokeStyle = color; g.lineWidth = lw; g.beginPath();
    const fi = Math.floor(f), ff = f - fi, f2 = Math.min(fi + 1, wt.frames - 1);
    for (let x = 0; x <= w; x++) {
      const i = Math.floor(x / w * (wt.cyc - 1));
      const v = tbl[fi * stride + i] * (1 - ff) + tbl[f2 * stride + i] * ff;
      const y = y0 + h / 2 - v * h * 0.45;
      x ? g.lineTo(x0 + x, y) : g.moveTo(x0, y);
    }
    g.stroke();
  };
  if (wt.frames > 1) {
    const n = Math.min(wt.frames, 24);
    const fw = W * 0.72, fh = H * 0.62, dx = (W - fw) / n, dy = (H - fh) / n;
    for (let i = n - 1; i >= 0; i--) {
      const f = i * (wt.frames - 1) / (n - 1);
      drawFrame(f, X + i * dx, Y + H - fh - i * dy, fw, fh, C.faint, 1);
    }
    const i = pos / (wt.frames - 1) * (n - 1);
    drawFrame(pos, X + i * dx, Y + H - fh - i * dy, fw, fh, C.fg, 2);
    label(g, `WT ${wt.frames} FR`, X + W, Y + H - 12, C.mid, 'right');
  } else {
    g.strokeStyle = C.faint; g.beginPath(); g.moveTo(X, Y + H / 2); g.lineTo(X + W, Y + H / 2); g.stroke();
    drawFrame(0, X, Y, W, H, C.fg, 2);
    label(g, `CYCLE ${slot.cycLen}`, X + W, Y + H - 12, C.mid, 'right');
  }
  const uni = P('uni');
  if (uni > 1) label(g, `UNISON x${uni}`, X, Y + H - 12, C.mid);
}

function drawSample(g, X, Y, W, H, slot, P, mach, app) {
  const viz = app.engine.viz;
  drawPeaks(g, slot.peaks, X, Y, W, H, mach === M_GRAN ? C.dim : C.mid);
  if (mach === M_SMPL) {
    let a = P('strt') / 127, b = P('end') / 127;
    if (b < a) [a, b] = [b, a];
    g.fillStyle = 'rgba(4,9,11,0.7)';
    g.fillRect(X, Y, W * a, H);
    g.fillRect(X + W * b, Y, W * (1 - b), H);
    const mode = P('mode');
    g.fillStyle = C.fg;
    g.fillRect(X + W * a, Y, 1, H);
    g.fillRect(X + W * b - 1, Y, 1, H);
    if (mode >= 2) {
      const lp = P('lpos') / 127;
      const lx = mode === 3 ? b - lp * (b - a) : a + lp * (b - a);
      g.fillStyle = C.hot; g.fillRect(X + W * lx, Y, 1, H);
      label(g, 'L', X + W * lx + 3, Y + 2, C.hot);
    }
    label(g, SMP_MODES[mode], X + W, Y + H - 12, C.mid, 'right');
    if (viz.tr === app.state.track) {
      for (let i = 0; i < viz.heads.length; i += 2) {
        g.fillStyle = `rgba(255,181,71,${0.3 + 0.7 * viz.heads[i + 1]})`;
        g.fillRect(X + W * viz.heads[i], Y, 2, H);
      }
    }
  } else {
    const pos = P('gpos') / 127;
    const spray = (P('gspr') / 127) ** 2;
    const centers = viz.tr === app.state.track && viz.cent.length ? viz.cent : [pos];
    for (const c of centers) {
      g.fillStyle = 'rgba(230,243,246,0.08)';
      const half = spray * 0.5 * W;
      g.fillRect(X + W * c - half, Y, half * 2, H);
      if (X + W * c + half > X + W) g.fillRect(X, Y, X + W * c + half - (X + W), H);
      if (X + W * c - half < X) g.fillRect(X + W + (X + W * c - half - X), Y, X - (X + W * c - half), H);
      g.fillStyle = C.fg; g.fillRect(X + W * c, Y, 1, H);
    }
    if (viz.tr === app.state.track) {
      for (let i = 0; i < viz.heads.length; i += 2) {
        const x = X + W * viz.heads[i];
        const y = Y + H * (0.1 + 0.8 * ((i * 0.6180339) % 1));
        const a = viz.heads[i + 1];
        g.fillStyle = `rgba(255,181,71,${0.15 + 0.85 * a})`;
        g.beginPath(); g.arc(x, y, 1.5 + a * 3, 0, TAU); g.fill();
      }
    }
    label(g, `SIZE ${PARAMS.gsiz.fmt(P('gsiz'))} · DENS ${PARAMS.gden.fmt(P('gden'))}`, X + W, Y + H - 12, C.mid, 'right');
  }
  label(g, slot.name, X, Y + H - 12, C.mid);
}

function drawLane(g, X, Y, W, H, app) {
  const t = app.state.track;
  const pt = app.pattern().tracks[t];
  const P = app.curTrack().p;
  const notes = [];
  for (const k in pt.steps) if (+k < pt.len) notes.push(pt.steps[k].locks.note ?? P.note);
  let lo = Math.min(P.note - 6, ...notes), hi = Math.max(P.note + 6, ...notes);
  const sw = W / pt.len;
  const play = app.seq.audibleStep(t);
  for (let i = 0; i < pt.len; i++) {
    const x = X + i * sw;
    if (i % 4 === 0) { g.fillStyle = C.faint; g.fillRect(x, Y, 1, H); }
    if (i === play) { g.fillStyle = 'rgba(230,243,246,0.12)'; g.fillRect(x, Y, sw, H); }
    const s = pt.steps[i];
    if (!s) continue;
    const n = s.locks.note ?? P.note, v = (s.locks.vel ?? P.vel) / 127;
    const len = Math.min(LEN_STEPS[s.locks.len ?? P.len], pt.len - i);
    const y = Y + H - 8 - (n - lo) / Math.max(1, hi - lo) * (H - 16);
    const locked = Object.keys(s.locks).some(k => !['note', 'vel', 'len'].includes(k));
    g.fillStyle = i === app.state.lockStep ? C.hot : locked ? '#ffd28a' : C.fg;
    g.globalAlpha = 0.35 + 0.65 * v;
    g.fillRect(x + 1, y - 3, Math.max(3, (Number.isFinite(len) ? len : pt.len - i) * sw - 2), 6);
    g.globalAlpha = 1;
  }
  label(g, `${noteName(hi)}`, X + W, Y, C.dim, 'right');
  label(g, `${noteName(lo)}`, X + W, Y + H - 12, C.dim, 'right');
}
