// Band-limited wavetable builder.
//
// Each cycle is analysed into harmonics and re-synthesised at TABLE_SIZE points
// into MIP levels (level k keeps harmonics <= MAX_H >> k). The worklet picks the
// level whose highest harmonic stays below Nyquist for the played pitch, so
// bright single cycles (saws, Oxford Overdrive style waves) do not alias.

export const TABLE_SIZE = 2048;
export const MAX_H = TABLE_SIZE / 2;
const MAX_MIP_SAMPLES = 64 * TABLE_SIZE; // above this many cycle samples skip upper mips to save memory

export function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j, b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

const isPow2 = n => n > 0 && (n & (n - 1)) === 0;

/** Harmonic spectrum (k = 1..H) of one cycle of length M. Returns {re, im, H}. */
function analyse(cycle) {
  const M = cycle.length;
  const H = Math.min(MAX_H - 1, Math.ceil(M / 2) - 1);
  const re = new Float64Array(H + 1), im = new Float64Array(H + 1);
  if (isPow2(M)) {
    const r = Float64Array.from(cycle), i = new Float64Array(M);
    fft(r, i, false);
    for (let k = 1; k <= H; k++) { re[k] = r[k]; im[k] = i[k]; }
  } else {
    const cos = new Float64Array(M), sin = new Float64Array(M);
    for (let m = 0; m < M; m++) { cos[m] = Math.cos(2 * Math.PI * m / M); sin[m] = Math.sin(2 * Math.PI * m / M); }
    for (let k = 1; k <= H; k++) {
      let sr = 0, si = 0, idx = 0;
      for (let m = 0; m < M; m++) {
        sr += cycle[m] * cos[idx];
        si -= cycle[m] * sin[idx];
        idx += k; if (idx >= M) idx -= M;
      }
      re[k] = sr; im[k] = si;
    }
  }
  return { re, im, H, M };
}

/**
 * Build mip-mapped tables.
 * @param {Float32Array} data mono sample data
 * @param {number} cycLen samples per cycle
 * @param {number} frames number of cycles (wavetable frames)
 * @returns {{cyc:number, frames:number, levelH:number[], levels:Float32Array[]}}
 */
export function buildWavetable(data, cycLen, frames) {
  const N = TABLE_SIZE, stride = N + 1;
  // big wavetables get sparser mips (every 2 octaves) to bound memory
  const levelH = [];
  for (let h = MAX_H; h >= 1; h = Math.floor(h / (frames * N > MAX_MIP_SAMPLES ? 4 : 2))) levelH.push(h);
  const levels = levelH.map(() => new Float32Array(frames * stride));
  const re = new Float64Array(N), im = new Float64Array(N);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    const spec = analyse(data.subarray(f * cycLen, f * cycLen + cycLen));
    const scale = N / spec.M;
    for (let l = 0; l < levelH.length; l++) {
      const hmax = Math.min(spec.H, levelH[l]);
      re.fill(0); im.fill(0);
      for (let k = 1; k <= hmax; k++) {
        re[k] = spec.re[k] * scale; im[k] = spec.im[k] * scale;
        re[N - k] = re[k]; im[N - k] = -im[k];
      }
      fft(re, im, true);
      const out = levels[l], o = f * stride;
      for (let i = 0; i < N; i++) {
        out[o + i] = re[i];
        if (l === 0 && Math.abs(re[i]) > peak) peak = Math.abs(re[i]);
      }
      out[o + N] = out[o];
    }
  }
  if (peak > 0) {
    const g = 0.9 / peak;
    for (const lv of levels) for (let i = 0; i < lv.length; i++) lv[i] *= g;
  }
  return { cyc: N, frames, levelH, levels };
}
