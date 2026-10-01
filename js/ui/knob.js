// Endless-style encoder knob rendered in SVG with a value ring.
// Interaction: vertical drag (Shift = fine), mouse wheel, double-click = reset / clear lock.

const SVGNS = 'http://www.w3.org/2000/svg';
const A0 = -135, A1 = 135;

function polar(cx, cy, r, deg) {
  const a = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx, cy, r, from, to) {
  if (Math.abs(to - from) < 0.01) return '';
  const [x0, y0] = polar(cx, cy, r, from), [x1, y1] = polar(cx, cy, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const sweep = to > from ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * Convert wheel events into integer steps: one step per notch for mouse wheels,
 * accumulated pixels for trackpads (so two-finger scrolling is not hyper-sensitive).
 */
export function wheelSteps(acc, e) {
  if (e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50) { acc.v = 0; return e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0; }
  acc.v -= e.deltaY;
  const n = Math.trunc(acc.v / 12);
  acc.v -= n * 12;
  return n;
}

export class Knob {
  /**
   * @param {HTMLElement} el container
   * @param {{size?:number, onBegin?:Function, onMove?:Function, onEnd?:Function, onStep?:Function, onReset?:Function}} h
   */
  constructor(el, h = {}) {
    this.el = el;
    this.h = h;
    const size = h.size || 72;
    const c = size / 2;
    this.c = c;
    this.r = c - 4;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.innerHTML = `
      <path class="k-track" d="${arcPath(c, c, this.r, A0, A1)}"/>
      <path class="k-arc" d=""/>
      <circle class="k-body" cx="${c}" cy="${c}" r="${c - 10}"/>
      <circle class="k-cap" cx="${c}" cy="${c}" r="${c - 14}"/>
      <line class="k-ind" x1="${c}" y1="${c - (c - 26)}" x2="${c}" y2="${c - (c - 15)}"/>`;
    el.appendChild(svg);
    this.arc = svg.querySelector('.k-arc');
    this.ind = svg.querySelector('.k-ind');
    this.last = '';
    this.bind();
  }

  bind() {
    const el = this.el;
    let y0 = 0, x0 = 0, dragging = false;
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      dragging = true; y0 = e.clientY; x0 = e.clientX;
      el.classList.add('active');
      this.h.onBegin?.(e);
    });
    el.addEventListener('pointermove', e => {
      if (!dragging) return;
      const d = (y0 - e.clientY) + (e.clientX - x0) * 0.5;
      this.h.onMove?.(d, e.shiftKey, e);
    });
    const end = e => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('active');
      this.h.onEnd?.(e);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    const acc = { v: 0 };
    el.addEventListener('wheel', e => {
      e.preventDefault();
      e.stopPropagation();
      const n = wheelSteps(acc, e);
      if (n) this.h.onStep?.(n, e.shiftKey);
    }, { passive: false });
    el.addEventListener('dblclick', e => { e.preventDefault(); this.h.onReset?.(); });
  }

  /** @param {number|null} norm 0..1 (null = unassigned) */
  set(norm, { bipolar = false, locked = false } = {}) {
    const key = `${norm}|${bipolar}|${locked}`;
    if (key === this.last) return;
    this.last = key;
    this.el.classList.toggle('empty', norm === null);
    this.el.classList.toggle('locked', locked);
    if (norm === null) { this.arc.setAttribute('d', ''); this.ind.setAttribute('transform', `rotate(${A0} ${this.c} ${this.c})`); return; }
    const ang = A0 + (A1 - A0) * Math.min(1, Math.max(0, norm));
    const from = bipolar ? 0 : A0;
    this.arc.setAttribute('d', arcPath(this.c, this.c, this.r, Math.min(from, ang), Math.max(from, ang)));
    this.ind.setAttribute('transform', `rotate(${ang} ${this.c} ${this.c})`);
  }
}
