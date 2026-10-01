// Parameter model shared by the UI, the sequencer and the audio engine.
//
// Values are stored in "panel units" (mostly 0..127, like the hardware) so they
// map 1:1 to knobs and MIDI CCs. `phys` converts a panel value into the
// DSP-ready value the AudioWorklet consumes (seconds, semitones, gains...).

export const NUM_TRACKS = 8;
export const MAX_STEPS = 64;
export const NUM_BANKS = 4;
export const PATTERNS_PER_BANK = 16;
export const NUM_PATTERNS = NUM_BANKS * PATTERNS_PER_BANK;
export const NUM_SLOTS = 128;
export const TICKS_PER_STEP = 24; // 96 PPQN internal clock, 1 step = 1/16 note at 1X

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = n => {
  n = Math.round(n);
  return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
};

export const LEN_STEPS = [0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, Infinity];
export const LEN_LABELS = ['1/128', '1/64', '3/128', '1/32', '3/64', '1/16', '3/32', '1/8', '3/16', '1/4', '3/8',
  '1/2', '3/4', '1/1', '3/2', '2/1', '3/1', '4/1', 'INF'];
export const CONDS = ['---', 'FILL', '!FILL', '1ST', '!1ST', '1:2', '2:2', '1:3', '2:3', '3:3', '1:4', '2:4', '3:4', '4:4', '1:8', '8:8'];
export const SCALES = [
  { l: '1/8X', t: 192 }, { l: '1/4X', t: 96 }, { l: '1/2X', t: 48 }, { l: '3/4X', t: 32 },
  { l: '1X', t: 24 }, { l: '3/2X', t: 16 }, { l: '2X', t: 12 },
];
export const DEFAULT_SCALE = 4;

export const MACHINES = ['WAVE', 'SMPL', 'GRAN'];
export const M_WAVE = 0, M_SMPL = 1, M_GRAN = 2;
export const FILTER_TYPES = ['LP2', 'LP4', 'BP', 'HP', 'NTCH'];
export const AMP_MODES = ['ADSR', 'AHD'];
export const SMP_MODES = ['FWD', 'REV', 'LOOP', 'RLOP', 'PING'];
export const GRAIN_WINDOWS = ['HANN', 'TRI', 'TRAP', 'PERC', 'RPRC', 'RECT'];
export const JITTER_MODES = ['FREE', 'OCT', 'OCT5'];
export const EMIT_MODES = ['ASYN', 'SYNC'];
export const LFO_WAVES = ['TRI', 'SINE', 'SQR', 'SAW', 'RAMP', 'EXP', 'RND', 'SMTH'];
export const LFO_MODES = ['FREE', 'TRIG', 'ONE'];
// Must stay in sync with the D_* constants in audio/worklet.js
export const LFO_DESTS = ['---', 'PTCH', 'FREQ', 'RESO', 'AMP', 'PAN', 'WPOS', 'STRT', 'GPOS', 'SIZE', 'DENS', 'SPRY', 'DRIV'];
export const LFO_SYNC = [
  { l: 'OFF', b: 0 }, { l: '1/32', b: 0.125 }, { l: '1/16', b: 0.25 }, { l: '1/8', b: 0.5 }, { l: '1/4', b: 1 },
  { l: '1/2', b: 2 }, { l: '1BAR', b: 4 }, { l: '2BAR', b: 8 }, { l: '4BAR', b: 16 }, { l: '8BAR', b: 32 },
];
export const DELAY_DIVS = [
  { l: '1/64', b: 1 / 16 }, { l: '1/32T', b: 1 / 12 }, { l: '1/32', b: 1 / 8 }, { l: '1/16T', b: 1 / 6 },
  { l: '1/32D', b: 3 / 16 }, { l: '1/16', b: 1 / 4 }, { l: '1/8T', b: 1 / 3 }, { l: '1/16D', b: 3 / 8 },
  { l: '1/8', b: 1 / 2 }, { l: '1/4T', b: 2 / 3 }, { l: '1/8D', b: 3 / 4 }, { l: '1/4', b: 1 },
  { l: '1/2T', b: 4 / 3 }, { l: '1/4D', b: 3 / 2 }, { l: '1/2', b: 2 }, { l: '1/2D', b: 3 }, { l: '1/1', b: 4 },
];
export const KB_SCALES = [
  { l: 'CHRM', s: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { l: 'MAJ', s: [0, 2, 4, 5, 7, 9, 11] },
  { l: 'MIN', s: [0, 2, 3, 5, 7, 8, 10] },
  { l: 'DOR', s: [0, 2, 3, 5, 7, 9, 10] },
  { l: 'PHRY', s: [0, 1, 3, 5, 7, 8, 10] },
  { l: 'LYD', s: [0, 2, 4, 6, 7, 9, 11] },
  { l: 'MIXO', s: [0, 2, 4, 5, 7, 9, 10] },
  { l: 'HMIN', s: [0, 2, 3, 5, 7, 8, 11] },
  { l: 'PENT', s: [0, 2, 4, 7, 9] },
  { l: 'MPEN', s: [0, 3, 5, 7, 10] },
  { l: 'BLUE', s: [0, 3, 5, 6, 7, 10] },
  { l: 'WHOL', s: [0, 2, 4, 6, 8, 10] },
];

// ---- conversions & formatting -------------------------------------------------

export const envTime = v => 0.001 * Math.pow(10, 4 * v / 127); // 1ms .. 10s
export const cutoffNote = v => 16 + v * 119 / 127;               // ~20Hz .. ~20kHz as MIDI note
export const noteHz = n => 440 * Math.pow(2, (n - 69) / 12);
const gain100 = v => (v / 100) * (v / 100);                       // 100 = unity
const signed = v => (v > 0 ? '+' : '') + fmtNum(v);
const pct = v => Math.round(v / 1.27) + '%';

export function fmtNum(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 2 : 1);
}
export function fmtSec(s) {
  if (s < 0.01) return (s * 1000).toFixed(1) + 'ms';
  if (s < 1) return Math.round(s * 1000) + 'ms';
  if (s < 10) return s.toFixed(2) + 's';
  return s.toFixed(1) + 's';
}
export function fmtHz(hz) {
  if (hz < 100) return hz.toFixed(1) + 'Hz';
  if (hz < 1000) return Math.round(hz) + 'Hz';
  return (hz / 1000).toFixed(hz < 10000 ? 2 : 1) + 'k';
}

// ---- definitions ---------------------------------------------------------------
// [id, label, min, max, default, options]
// options: int, opts (enum labels), fmt(v, app), phys(v), lock (p-lockable, default true)

const T = v => envTime(v);
const tf = v => fmtSec(envTime(v));

const TRACK_DEFS = [
  // machine (set via FUNC+SRC / track setup)
  ['mach', 'MACH', 0, 2, 0, { opts: MACHINES, lock: false }],
  // TRIG
  ['note', 'NOTE', 0, 127, 60, { int: true, fmt: noteName }],
  ['vel', 'VEL', 1, 127, 100, { int: true, phys: v => v / 127 }],
  ['len', 'LEN', 0, LEN_STEPS.length - 1, 5, { opts: LEN_LABELS }],
  ['prob', 'PROB', 0, 100, 100, { int: true, fmt: v => v + '%' }],
  ['cond', 'COND', 0, CONDS.length - 1, 0, { opts: CONDS }],
  ['micro', 'MCRO', -23, 23, 0, { int: true, fmt: v => (v > 0 ? '+' : '') + v + '/384' }],
  ['port', 'PORT', 0, 127, 0, { phys: v => (v === 0 ? 0 : envTime(v) * 0.5), fmt: v => (v === 0 ? 'OFF' : fmtSec(envTime(v) * 0.5)) }],
  ['poly', 'VOIC', 1, 8, 8, { int: true, lock: false, fmt: v => (v === 1 ? 'MONO' : String(v)) }],
  // SRC (shared)
  ['tune', 'TUNE', -24, 24, 0, { int: true, fmt: signed }],
  ['fine', 'FINE', -64, 63, 0, { phys: v => v / 64, fmt: signed }],
  ['smp', 'SMP', 0, NUM_SLOTS - 1, 0, { int: true, fmt: (v, app) => (app ? app.pool.shortLabel(v) : String(v)) }],
  ['lev', 'LEV', 0, 127, 100, { phys: gain100, fmt: v => fmtNum(Math.round(v)) }],
  // SRC WAVE
  ['wpos', 'WPOS', 0, 127, 0, { phys: v => v / 127 }],
  ['uni', 'UNI', 1, 7, 1, { int: true, fmt: v => (v === 1 ? 'OFF' : 'x' + v) }],
  ['dtun', 'DTUN', 0, 127, 24, { phys: v => (v / 127) * (v / 127) * 100, fmt: v => ((v / 127) * (v / 127) * 100).toFixed(1) + 'c' }],
  ['sprd', 'SPRD', 0, 127, 64, { phys: v => v / 127, fmt: pct }],
  // SRC SMPL
  ['strt', 'STRT', 0, 127, 0, { phys: v => v / 127 }],
  ['end', 'END', 0, 127, 127, { phys: v => v / 127 }],
  ['mode', 'MODE', 0, SMP_MODES.length - 1, 0, { opts: SMP_MODES }],
  ['lpos', 'LPOS', 0, 127, 0, { phys: v => v / 127 }],
  // SRC GRAN
  ['gpos', 'POS', 0, 127, 32, { phys: v => v / 127, fmt: pct }],
  ['gsiz', 'SIZE', 0, 127, 70, { phys: v => 0.005 * Math.pow(200, v / 127), fmt: v => fmtSec(0.005 * Math.pow(200, v / 127)) }],
  ['gden', 'DENS', 0, 127, 70, { phys: v => Math.pow(200, v / 127), fmt: v => Math.pow(200, v / 127).toFixed(1) + '/s' }],
  ['gspr', 'SPRY', 0, 127, 10, { phys: v => (v / 127) * (v / 127), fmt: pct }],
  ['gscn', 'SCAN', -64, 63, 0, { phys: v => v / 32, fmt: v => (v / 32).toFixed(2) + 'x' }],
  ['gpjt', 'PJIT', 0, 127, 0, { phys: v => v / 127 * 24, fmt: v => '±' + (v / 127 * 24).toFixed(1) }],
  ['gjmd', 'JMOD', 0, JITTER_MODES.length - 1, 0, { opts: JITTER_MODES }],
  ['grev', 'RVRS', 0, 100, 0, { int: true, phys: v => v / 100, fmt: v => v + '%' }],
  ['gwin', 'WIN', 0, GRAIN_WINDOWS.length - 1, 0, { opts: GRAIN_WINDOWS }],
  ['gpsp', 'PSPR', 0, 127, 40, { phys: v => v / 127, fmt: pct }],
  ['gemt', 'EMIT', 0, EMIT_MODES.length - 1, 0, { opts: EMIT_MODES }],
  // FLTR
  ['fatk', 'ATK', 0, 127, 0, { phys: T, fmt: tf }],
  ['fdec', 'DEC', 0, 127, 64, { phys: T, fmt: tf }],
  ['fsus', 'SUS', 0, 127, 0, { phys: v => v / 127, fmt: pct }],
  ['frel', 'REL', 0, 127, 64, { phys: T, fmt: tf }],
  ['freq', 'FREQ', 0, 127, 127, { phys: cutoffNote, fmt: v => fmtHz(noteHz(cutoffNote(v))) }],
  ['reso', 'RESO', 0, 127, 0, { phys: v => Math.min(0.995, v / 127) }],
  ['ftyp', 'TYPE', 0, FILTER_TYPES.length - 1, 0, { opts: FILTER_TYPES }],
  ['fenv', 'ENV', -64, 63, 0, { phys: v => v / 64 * 72, fmt: signed }],
  // AMP
  ['atk', 'ATK', 0, 127, 0, { phys: T, fmt: tf }],
  ['dec', 'DEC', 0, 127, 64, { phys: T, fmt: tf }],
  ['sus', 'SUS', 0, 127, 127, { phys: v => v / 127, fmt: pct }],
  ['rel', 'REL', 0, 127, 40, { phys: T, fmt: tf }],
  ['amod', 'MODE', 0, AMP_MODES.length - 1, 0, { opts: AMP_MODES }],
  ['vels', 'VELS', 0, 127, 64, { phys: v => v / 127, fmt: pct }],
  ['pan', 'PAN', -64, 63, 0, { phys: v => v / 64, fmt: v => (v === 0 ? 'C' : (v < 0 ? 'L' : 'R') + fmtNum(Math.abs(v))) }],
  ['vol', 'VOL', 0, 127, 100, { phys: gain100, fmt: v => fmtNum(Math.round(v)) }],
  // FX
  ['br', 'BR', 0, 127, 0, { phys: v => (v === 0 ? 0 : 16 - v * 15 / 127), fmt: v => (v === 0 ? 'OFF' : (16 - v * 15 / 127).toFixed(1) + 'b') }],
  ['srr', 'SRR', 0, 127, 0, { phys: v => Math.pow(2, v / 127 * 6), fmt: v => (v === 0 ? 'OFF' : '/' + Math.pow(2, v / 127 * 6).toFixed(1)) }],
  ['driv', 'DRIV', 0, 127, 0, { phys: v => v / 127 }],
  ['dly', 'DEL', 0, 127, 0, { phys: v => (v / 127) * (v / 127) }],
  ['rev', 'REV', 0, 127, 0, { phys: v => (v / 127) * (v / 127) }],
];

// Two LFOs with identical layouts
for (const k of [1, 2]) {
  TRACK_DEFS.push(
    [`l${k}spd`, 'SPD', 0, 127, 48, { phys: v => 0.02 * Math.pow(1000, v / 127), fmt: v => fmtHz(0.02 * Math.pow(1000, v / 127)) }],
    [`l${k}syn`, 'SYNC', 0, LFO_SYNC.length - 1, 0, { opts: LFO_SYNC.map(s => s.l), phys: v => LFO_SYNC[v].b }],
    [`l${k}dst`, 'DEST', 0, LFO_DESTS.length - 1, 0, { opts: LFO_DESTS }],
    [`l${k}wav`, 'WAVE', 0, LFO_WAVES.length - 1, 0, { opts: LFO_WAVES }],
    [`l${k}sph`, 'SPH', 0, 127, 0, { phys: v => v / 128 }],
    [`l${k}mod`, 'MODE', 0, LFO_MODES.length - 1, 0, { opts: LFO_MODES }],
    [`l${k}fad`, 'FADE', 0, 127, 0, { phys: v => (v === 0 ? 0 : envTime(v)), fmt: v => (v === 0 ? 'OFF' : tf(v)) }],
    [`l${k}dep`, 'DEP', -64, 63, 0, { phys: v => v / 64, fmt: signed }],
  );
}

const FX_DEFS = [
  // delay
  ['dtim', 'TIME', 0, DELAY_DIVS.length - 1, 10, { opts: DELAY_DIVS.map(d => d.l) }],
  ['dx', 'X', 0, 1, 1, { opts: ['OFF', 'ON'] }],
  ['dwid', 'WID', 0, 127, 127, { phys: v => v / 127, fmt: pct }],
  ['dfb', 'FDBK', 0, 127, 56, { phys: v => v / 127 * 1.0, fmt: pct }],
  ['dhp', 'HPF', 0, 127, 24, { phys: v => 20 * Math.pow(500, v / 127), fmt: v => fmtHz(20 * Math.pow(500, v / 127)) }],
  ['dlp', 'LPF', 0, 127, 96, { phys: v => 200 * Math.pow(100, v / 127), fmt: v => fmtHz(200 * Math.pow(100, v / 127)) }],
  ['drev', 'REV', 0, 127, 0, { phys: v => (v / 127) * (v / 127) }],
  ['dvol', 'VOL', 0, 127, 100, { phys: gain100 }],
  // reverb
  ['rpre', 'PRE', 0, 127, 8, { phys: v => v / 127 * 0.25, fmt: v => fmtSec(v / 127 * 0.25) }],
  ['rdec', 'DEC', 0, 127, 70, { phys: v => 0.2 * Math.pow(100, v / 127), fmt: v => fmtSec(0.2 * Math.pow(100, v / 127)) }],
  ['rdmp', 'DAMP', 0, 127, 64, { phys: v => v / 127, fmt: pct }],
  ['rhp', 'HPF', 0, 127, 16, { phys: v => 20 * Math.pow(500, v / 127), fmt: v => fmtHz(20 * Math.pow(500, v / 127)) }],
  ['rlp', 'LPF', 0, 127, 100, { phys: v => 200 * Math.pow(100, v / 127), fmt: v => fmtHz(200 * Math.pow(100, v / 127)) }],
  ['rvol', 'VOL', 0, 127, 100, { phys: gain100 }],
];

function build(rows) {
  const out = {};
  for (const [id, label, min, max, def, o = {}] of rows) {
    const p = { id, label, min, max, def, int: !!o.int, lock: o.lock !== false, phys: o.phys || (v => v), fmt: o.fmt || null, opts: o.opts || null };
    if (p.opts) p.int = true;
    out[id] = p;
  }
  return out;
}

export const PARAMS = build(TRACK_DEFS);
export const FX_PARAMS = build(FX_DEFS);

/** Params that only drive the sequencer and never reach the DSP as locks. */
export const TRIG_ONLY = new Set(['note', 'vel', 'len', 'prob', 'cond', 'micro']);

export function formatParam(def, v, app) {
  if (v === undefined || v === null || Number.isNaN(v)) return '---';
  if (def.opts) return def.opts[Math.round(v)] ?? '---';
  if (def.fmt) return def.fmt(v, app);
  return fmtNum(Math.round(v * 100) / 100);
}

export function clampParam(def, v) {
  v = Math.min(def.max, Math.max(def.min, v));
  return def.int ? Math.round(v) : v;
}

export function defaultTrackParams() {
  const p = {};
  for (const id in PARAMS) p[id] = PARAMS[id].def;
  return p;
}

export function defaultFxParams() {
  const p = {};
  for (const id in FX_PARAMS) p[id] = FX_PARAMS[id].def;
  return p;
}

export function trackPhys(p) {
  const out = {};
  for (const id in PARAMS) out[id] = PARAMS[id].phys(p[id] ?? PARAMS[id].def);
  return out;
}

export function locksPhys(locks) {
  let out = null;
  for (const id in locks) {
    if (TRIG_ONLY.has(id) || !PARAMS[id]) continue;
    (out ||= {})[id] = PARAMS[id].phys(locks[id]);
  }
  return out;
}

// ---- parameter pages (8 knobs each). Pressing a page button again cycles sub-pages.

const LFO_PAGE = k => [`l${k}spd`, `l${k}syn`, `l${k}dst`, `l${k}wav`, `l${k}sph`, `l${k}mod`, `l${k}fad`, `l${k}dep`];

export const PAGES = {
  TRIG: () => [['note', 'vel', 'len', 'prob', 'cond', 'micro', 'port', 'poly']],
  SRC: mach => [
    [['tune', 'fine', 'smp', 'wpos', 'uni', 'dtun', 'sprd', 'lev']],
    [['tune', 'fine', 'smp', 'strt', 'end', 'mode', 'lpos', 'lev']],
    [['tune', 'fine', 'smp', 'gpos', 'gsiz', 'gden', 'gspr', 'gscn'],
      ['gpjt', 'gjmd', 'grev', 'gwin', 'gpsp', 'gemt', null, 'lev']],
  ][mach],
  FLTR: () => [['fatk', 'fdec', 'fsus', 'frel', 'freq', 'reso', 'ftyp', 'fenv']],
  AMP: () => [['atk', 'dec', 'sus', 'rel', 'amod', 'vels', 'pan', 'vol']],
  FX: () => [['br', 'srr', 'driv', null, 'dly', 'rev', null, null]],
  MOD: () => [LFO_PAGE(1), LFO_PAGE(2)],
};
export const PAGE_NAMES = ['TRIG', 'SRC', 'FLTR', 'AMP', 'FX', 'MOD'];
export const FX_PAGES = [
  ['dtim', 'dx', 'dwid', 'dfb', 'dhp', 'dlp', 'drev', 'dvol'],
  ['rpre', 'rdec', 'rdmp', null, 'rhp', 'rlp', null, 'rvol'],
];

// Fixed MIDI CC map (applies to the target track). 16..23 = knobs A..H of the active page.
export const CC_MAP = {
  7: 'vol', 10: 'pan', 71: 'reso', 72: 'rel', 73: 'atk', 74: 'freq', 75: 'dec', 76: 'gpos', 77: 'gsiz',
  78: 'gden', 79: 'gspr', 80: 'wpos', 81: 'strt', 82: 'driv', 83: 'gscn', 91: 'rev', 92: 'dly',
};
