// js/flasher/galvo.js
// Galvo tab: raster scan and arbitrary points for the galvo scanner (/galvo_act, /galvo_get).
// The controls follow ImSwitch's GalvoScannerController (frontend/src/components/GalvoScannerController.jsx).
// The timing plot ports the firmware's HighSpeedScannerCore::buildLineProfile, so it shows what the
// board outputs (±1 DAC count: the firmware computes in float32). The pure helpers up to
// "UI" are unit-tested in tests/flasher.test.mjs; nothing touches the DOM before initGalvo().

import * as serial from './serial.js';
import * as C from './commands.js';

const $ = (id) => document.getElementById(id);
const KEY = 'uc2-galvo';
const DAC_MAX = 4095;
export const MAX_LINE_SAMPLES = 4096;   // SCANNER_MAX_LINE_SAMPLES in the firmware
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clamp12 = (v) => clamp(Math.trunc(v), 0, DAC_MAX);

// Same defaults as ImSwitch: the validated FLIM raster (25 µs dwell, eased fly-back, overscan)
export const DEFAULTS = {
  nx: 256, ny: 256, x_min: 500, x_max: 3500, y_min: 500, y_max: 3500,
  sample_period_us: 25, frame_count: 0, bidirectional: false,
  pre_samples: 64, fly_samples: 256, line_settle_samples: 128, overscan_samples: 32,
  trig_delay_us: 0, trig_width_us: 0,
  enable_trigger: 1, apply_x_lut: 0, laser_blanking: 0, hw_pixel_clock: 0,
};

// ── Pure helpers ─────────────────────────────────────────────────────────
// Samples in one line: the firmware drops the fly-back when scanning bidirectionally.
export const lineSamples = (c) =>
  c.pre_samples + 2 * c.overscan_samples + c.nx + (c.bidirectional ? 0 : c.fly_samples) + c.line_settle_samples;

// Mirrors the checks in HighSpeedScannerCore::setConfig, so a bad value is caught before the board refuses it.
export function validate(c) {
  const errors = [], warnings = [];
  for (const k of ['nx', 'ny', 'pre_samples', 'fly_samples', 'sample_period_us', 'trig_delay_us', 'trig_width_us',
    'line_settle_samples', 'frame_count', 'overscan_samples']) {
    if (!(c[k] >= 0 && c[k] <= 65535)) errors.push(`${k} must be 0–65535`);
  }
  if (c.nx < 1 || c.ny < 1) errors.push('NX and NY must be at least 1');
  for (const k of ['x_min', 'x_max', 'y_min', 'y_max']) {
    if (!(c[k] >= 0 && c[k] <= DAC_MAX)) errors.push(`${k} must be 0–${DAC_MAX} (12-bit DAC)`);
  }
  if (c.x_min >= c.x_max) errors.push('X min must be below X max');
  if (c.y_min >= c.y_max) errors.push('Y min must be below Y max');
  const total = lineSamples(c);
  if (total > MAX_LINE_SAMPLES) {
    errors.push(`One line has ${total} samples (pre + 2×overscan + NX${c.bidirectional ? '' : ' + fly-back'} + settle); the board allows ${MAX_LINE_SAMPLES}`);
  }
  if (c.hw_pixel_clock && (c.sample_period_us < 2 || c.nx > 1023)) {
    warnings.push('The hardware pixel clock needs a period of at least 2 µs and NX ≤ 1023; otherwise the board uses software pulses.');
  }
  if (c.overscan_samples && c.nx > 1) {
    const over = ((c.x_max - c.x_min) / (c.nx - 1)) * c.overscan_samples;
    if (c.x_min - over < 0 || c.x_max + over > DAC_MAX) {
      warnings.push('The overscan ramp runs past the DAC range and is clipped, so the mirror is not at constant velocity at the line ends. Move the window inwards or reduce the overscan.');
    }
  }
  // Settings that spoiled FLIM images in the bench test of 2026-11-17 (see DOCS_ARTEFACTS)
  if (c.sample_period_us < 25) {
    warnings.push('Dwell below 25 µs: the board needs about 22 µs per sample, so pixel times become uneven and frames take longer than shown.');
  }
  if (!c.bidirectional && !c.fly_samples) {
    warnings.push('No fly-back: the mirror cannot jump back in one sample, so the first columns of every line are taken while it is still moving.');
  }
  if (!c.pre_samples && !c.overscan_samples) {
    warnings.push('No pre-blank or overscan: the first pixels are taken while the mirror is still accelerating (squeezed left edge).');
  }
  return { errors, warnings };
}

// One line of the scan as the board builds it: X DAC value per sample, split into regions
// (pre-blank | overscan | image | overscan | fly-back | settle). Null when the line is empty or too long.
export function lineProfile(c) {
  const total = lineSamples(c);
  if (total < 1 || total > MAX_LINE_SAMPLES) return null;
  const bidir = !!c.bidirectional, ov = c.overscan_samples, fly = bidir ? 0 : c.fly_samples;
  const slope = c.nx > 1 ? (c.x_max - c.x_min) / (c.nx - 1) : 0;   // per-pixel slope; overscan continues it
  const startX = c.x_min - slope * ov, endX = c.x_max + slope * ov;
  const x = [], regions = [];
  const at = (v) => clamp12(v + 0.5);
  const block = (name, n, f) => {
    const from = x.length;
    for (let i = 0; i < n; i++) x.push(f(i));
    regions.push({ name, from, to: x.length });
  };
  block('pre', c.pre_samples, () => at(startX));
  block('lead-in', ov, (i) => at(startX + slope * i));
  const imgStart = x.length;
  block('image', c.nx, (i) => (c.nx <= 1 ? c.x_min : at(c.x_min + slope * i)));
  const imgEnd = x.length;
  block('lead-out', ov, (i) => at(c.x_max + slope * (i + 1)));
  block('fly-back', fly, (i) => (fly === 1 ? at(startX)
    : at(endX + (startX - endX) * (0.5 - 0.5 * Math.cos((Math.PI * i) / (fly - 1))))));   // cosine ease
  block('settle', c.line_settle_samples, () => at(bidir ? endX : startX));
  return { x, regions, imgStart, imgEnd, total: x.length, startX, endX, mirrorSum: Math.round(startX + endX) };
}

// Odd lines of a bidirectional scan run the same profile mirrored.
export const mirrorLine = (p) => p.x.map((v) => clamp12(p.mirrorSum - v));

// Frame time from the real line length (not just NX), at the configured dwell, plus the Y step and
// line marker at each line start (56 µs, measured at 25 µs dwell on 2026-11-17).
export const LINE_OVERHEAD_US = 56;
export function scanTiming(c) {
  const line = lineSamples(c);
  const frameUs = c.sample_period_us > 0 ? c.ny * (line * c.sample_period_us + LINE_OVERHEAD_US) : 0;
  return { line, pixels: c.nx * c.ny, frameUs, hz: frameUs > 0 ? 1e6 / frameUs : Infinity };
}

// What each parameter does, and where FLIM image artefacts come from
export const DOCS_SCAN = 'https://docs.openuc2.com/usage/disc/galvo-addon/reference/scan-parameters';
export const DOCS_ARTEFACTS = 'https://docs.openuc2.com/usage/disc/galvo-addon/explanation/flim-image-artefacts';
// Timing part of DEFAULTS (the validated FLIM raster): the "FLIM timing" preset keeps resolution and window
export const FLIM_TIMING = Object.fromEntries(Object.entries(DEFAULTS)
  .filter(([k]) => !['nx', 'ny', 'x_min', 'x_max', 'y_min', 'y_max', 'frame_count'].includes(k)));

// Scan path in DAC counts, at most max×max samples (like the ImSwitch preview); odd lines reversed when bidirectional.
export function rasterPath(c, max = 64) {
  const nx = clamp(c.nx | 0, 1, max), ny = clamp(c.ny | 0, 1, max), pts = [];
  for (let iy = 0; iy < ny; iy++) {
    const y = ny > 1 ? c.y_min + ((c.y_max - c.y_min) * iy) / (ny - 1) : c.y_min;
    for (let k = 0; k < nx; k++) {
      const ix = c.bidirectional && iy % 2 ? nx - 1 - k : k;
      pts.push({ x: nx > 1 ? c.x_min + ((c.x_max - c.x_min) * ix) / (nx - 1) : c.x_min, y });
    }
  }
  return pts;
}

// A window of `width` counts around `center`, slid (not shrunk) to stay inside 0..4095. Returns [min, max].
export function windowFromCenterWidth(center, width) {
  const w = clamp(Math.round(width) || 1, 1, DAC_MAX);
  const lo = clamp(Math.round(center - w / 2), 0, DAC_MAX - w);
  return [lo, lo + w];
}

// Drag in the preview: 'move' slides the rectangle, 'nw'|'ne'|'sw'|'se' pulls a corner. dx, dy in DAC counts.
export function dragArea(a, mode, dx, dy) {
  if (mode === 'move') {
    const shift = (lo, hi, d) => { const w = hi - lo, n = clamp(Math.round(lo + d), 0, DAC_MAX - w); return [n, n + w]; };
    const [x_min, x_max] = shift(a.x_min, a.x_max, dx), [y_min, y_max] = shift(a.y_min, a.y_max, dy);
    return { x_min, x_max, y_min, y_max };
  }
  const n = { ...a };
  if (mode.includes('w')) n.x_min = clamp(Math.round(a.x_min + dx), 0, a.x_max - 1);
  if (mode.includes('e')) n.x_max = clamp(Math.round(a.x_max + dx), a.x_min + 1, DAC_MAX);
  if (mode.includes('n')) n.y_min = clamp(Math.round(a.y_min + dy), 0, a.y_max - 1);
  if (mode.includes('s')) n.y_max = clamp(Math.round(a.y_max + dy), a.y_min + 1, DAC_MAX);
  return n;
}

export function circlePoints(cx, cy, r, n, dwell_us) {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return { x: clamp(Math.round(cx + r * Math.cos(a)), 0, DAC_MAX), y: clamp(Math.round(cy + r * Math.sin(a)), 0, DAC_MAX), dwell_us };
  });
}

export function gridPoints(a, gx, gy, dwell_us) {
  const at = (lo, hi, i, n) => Math.round(n > 1 ? lo + ((hi - lo) * i) / (n - 1) : (lo + hi) / 2);
  const pts = [];
  for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) pts.push({ x: at(a.x_min, a.x_max, i, gx), y: at(a.y_min, a.y_max, j, gy), dwell_us });
  return pts;
}

// ── UI ───────────────────────────────────────────────────────────────────
const HELP = {
  nx: 'Samples (pixels) per line. More = finer X resolution but slower lines.',
  ny: 'Lines per frame (Y resolution).',
  sample_period_us: 'Dwell per sample in µs = the pixel time; photons per pixel grow with it. The board needs about 22 µs per sample, so below 25 µs (and at 0) pixel times become uneven and frames take longer than shown. FLIM: 25.',
  frame_count: 'Frames to scan, then stop. 0 = scan until Stop. Only a board with its own galvo honours this; a raster started through a CAN master runs continuously.',
  bidirectional: 'Scan both ways: even lines left to right, odd lines right to left. About twice the frame rate, no fly-back, but needs a good phase/settle to avoid a zig-zag offset. The host must flip the odd lines.',
  pre_samples: 'Samples at the start of each line, right after the Y step, with X held at the start of the ramp; the line (and frame) marker goes out here. In FLIM LABS PLF the photons of pre-blank + lead-in overscan pile into column 0: crop it with a left offset of 1. FLIM: 64.',
  overscan_samples: 'Ramp samples before and after the image at the same per-pixel slope, so the mirror already moves at constant speed when the first pixel starts (without it the left edge is squeezed). Costs 2×overscan samples per line; the ramp must stay inside 0–4095. FLIM: 32.',
  fly_samples: 'Samples for the cosine-eased return to the start of the ramp (not used when bidirectional). Too few and the mirror cannot get back in time: the first columns of each line are distorted; 0 gave a dark, squeezed band at the left edge. FLIM: 256.',
  line_settle_samples: 'Samples held at the start of the ramp after the fly-back, before the next Y step, so ringing decays before the next line. FLIM: 128.',
  trig_delay_us: 'Gap between the frame marker and the line marker at the start of a frame (µs). Does not delay the pixel pulses.',
  trig_width_us: 'Pulse width in µs. Frame/line markers: 0 = 1 µs. Pixel pulse: software clock 0 = a few tens of ns (capped at half the dwell), hardware clock 0 = 1 µs. The PLF pixel size is set by the dwell, not by this. FLIM: 0.',
  enable_trigger: 'Emit the frame, line and pixel trigger outputs during the scan.',
  apply_x_lut: 'Linearise the mirror with the per-column X lookup table (needs an uploaded LUT).',
  laser_blanking: 'Gate the laser output HIGH only during the image samples (off during pre-blank, overscan, fly-back and settle). On the XIAO galvo board this pin (GPIO43) is also the console UART TX. FLIM: off.',
  hw_pixel_clock: 'Make the pixel pulses with the ESP32-S3 RMT peripheral instead of the software loop. Removes the faint 1 ms dot lattice and the brighter columns 32/96/160/224 that interrupts cause with the software clock (bench test 2026-11-17). Needs dwell ≥ 2 µs and NX ≤ 1023, otherwise software pulses. Validated FLIM default: off.',
};
const LABEL = {
  nx: 'NX (pixels/line)', ny: 'NY (lines)', sample_period_us: 'Dwell (µs/sample)', frame_count: 'Frame count',
  pre_samples: 'Pre-blank samples', overscan_samples: 'Overscan samples', fly_samples: 'Fly-back samples',
  line_settle_samples: 'Settle samples', trig_delay_us: 'Trigger delay (µs)', trig_width_us: 'Trigger width (µs)',
  bidirectional: 'Bidirectional', enable_trigger: 'Triggers', apply_x_lut: 'X LUT', laser_blanking: 'Laser blanking',
  hw_pixel_clock: 'HW pixel clock',
};
const GROUPS = {
  galvoRes: { nums: ['nx', 'ny'], flags: [] },
  galvoTiming: { nums: ['sample_period_us', 'frame_count'], flags: ['bidirectional'] },
  galvoAdv: { nums: ['pre_samples', 'overscan_samples', 'fly_samples', 'line_settle_samples', 'trig_delay_us', 'trig_width_us'],
    flags: ['enable_trigger', 'apply_x_lut', 'laser_blanking', 'hw_pixel_clock'] },
};
const numHtml = (k) => `<div class="col-6 col-md-4"><label class="form-label mb-0" for="galvo_${k}" title="${HELP[k]}">${LABEL[k]} <i class="bi bi-info-circle text-muted"></i></label>
  <input type="number" class="form-control form-control-sm" id="galvo_${k}" min="${k === 'nx' || k === 'ny' ? 1 : 0}" max="65535" step="1"></div>`;
const flagHtml = (k) => `<div class="col-6 col-md-3"><div class="form-check mt-3"><input class="form-check-input" type="checkbox" id="galvo_${k}">
  <label class="form-check-label" for="galvo_${k}" title="${HELP[k]}">${LABEL[k]} <i class="bi bi-info-circle text-muted"></i></label></div></div>`;
const windowHtml = (a) => `<div class="mb-2">
  <div class="fw-semibold small mb-1">${a.toUpperCase()} window <span class="text-muted fw-normal">(DAC counts, 0–${DAC_MAX})</span></div>
  <div class="row g-2 small">
    <div class="col-3"><label class="form-label mb-0" for="galvo_${a}_min">Min</label><input type="number" class="form-control form-control-sm" id="galvo_${a}_min" min="0" max="${DAC_MAX}"></div>
    <div class="col-3"><label class="form-label mb-0" for="galvo_${a}_max">Max</label><input type="number" class="form-control form-control-sm" id="galvo_${a}_max" min="0" max="${DAC_MAX}"></div>
    <div class="col-3"><label class="form-label mb-0" for="galvo_${a}_width" title="Width of the window. The centre stays; the window slides to stay inside 0–${DAC_MAX}.">${a === 'x' ? 'Width' : 'Height'}</label><input type="number" class="form-control form-control-sm" id="galvo_${a}_width" data-derived min="1" max="${DAC_MAX}"></div>
    <div class="col-3"><label class="form-label mb-0" for="galvo_${a}_center" title="Centre of the window. Drag the Position slider or the rectangle in the preview to move it.">Center</label><input type="number" class="form-control form-control-sm" id="galvo_${a}_center" data-derived min="0" max="${DAC_MAX}"></div>
  </div>
  <div class="d-flex align-items-center gap-2"><span class="small text-muted">Position</span><input type="range" class="form-range" id="galvo_${a}_pos" data-derived min="0" max="${DAC_MAX}"></div>
</div>`;

const REGION_COLOR = { pre: '#adb5bd', 'lead-in': '#fd7e14', image: '#20c997', 'lead-out': '#fd7e14', 'fly-back': '#4dabf7', settle: '#b197fc' };
const REGION_LABEL = { pre: 'pre-blank', 'lead-in': 'overscan', image: 'image', 'lead-out': 'overscan', 'fly-back': 'fly-back', settle: 'settle' };

const SIZE = 340, PAD = 25, INNER = SIZE - 2 * PAD, K = INNER / 4096;   // preview canvas px, DAC count → px
const pn = (dac) => PAD + dac * K;
const ps = (dac) => pn(dac).toFixed(1);

let mode = 'raster';                  // 'raster' | 'points'
let points = [];                      // [{x, y, dwell_us}]
let lastQid = 0;
let reading = false;                  // waiting for a status reply to fill the form from the board
let drag = null;                      // {mode, start, area} while the rectangle is dragged

function readCfg() {
  const c = {};
  for (const k of Object.keys(DEFAULTS)) {
    const el = $(`galvo_${k}`);
    c[k] = el.type === 'checkbox' ? (k === 'bidirectional' ? el.checked : +el.checked) : (parseInt(el.value, 10) || 0);
  }
  return c;
}

function writeCfg(c) {
  for (const k of Object.keys(DEFAULTS)) {
    if (!(k in c)) continue;
    const el = $(`galvo_${k}`);
    if (el.type === 'checkbox') el.checked = !!c[k]; else el.value = c[k];
  }
}

const park = () => ({ x: clamp(parseInt($('galvo_park_x').value, 10) || 0, 0, DAC_MAX), y: clamp(parseInt($('galvo_park_y').value, 10) || 0, 0, DAC_MAX) });
const dwell = () => Math.max(0, parseInt($('galvo_pts_dwell').value, 10) || 0);

// Width / centre / position of the window follow min/max (except the field being typed in).
function syncDerived(skip) {
  for (const a of ['x', 'y']) {
    const lo = parseInt($(`galvo_${a}_min`).value, 10) || 0, hi = parseInt($(`galvo_${a}_max`).value, 10) || 0;
    const w = Math.max(hi - lo, 1), pos = $(`galvo_${a}_pos`);
    const set = (id, v) => { const el = $(id); if (el !== skip) el.value = v; };
    set(`galvo_${a}_width`, hi - lo);
    set(`galvo_${a}_center`, Math.round((lo + hi) / 2));
    pos.min = Math.ceil(w / 2);
    pos.max = Math.max(Math.ceil(w / 2), DAC_MAX - Math.floor(w / 2));
    pos.disabled = w >= DAC_MAX;
    set(`galvo_${a}_pos`, Math.round((lo + hi) / 2));
  }
}

function setWindow(axis, { center, width }) {
  const lo = parseInt($(`galvo_${axis}_min`).value, 10) || 0, hi = parseInt($(`galvo_${axis}_max`).value, 10) || 0;
  const [a, b] = windowFromCenterWidth(center ?? (lo + hi) / 2, width ?? hi - lo);
  $(`galvo_${axis}_min`).value = a;
  $(`galvo_${axis}_max`).value = b;
}

// ── Preview: the 4096×4096 DAC range, the scan rectangle with its path, park position and points ──
function previewHtml(c) {
  const L = pn(c.x_min), R = pn(c.x_max), T = pn(c.y_min), B = pn(c.y_max);
  const raster = mode === 'raster', bidi = !!c.bidirectional, col = bidi ? '#ff9900' : '#00ff88';
  let s = `<rect x="${PAD}" y="${PAD}" width="${INNER}" height="${INNER}" fill="#12121f" stroke="#333"/>`;
  for (let i = 0; i <= 4; i++) {
    const g = PAD + (i / 4) * INNER, v = Math.min(DAC_MAX, Math.round((i / 4) * 4096));
    s += `<line x1="${g}" y1="${PAD}" x2="${g}" y2="${SIZE - PAD}" stroke="#2a2a4a" stroke-width=".5"/>`
      + `<line x1="${PAD}" y1="${g}" x2="${SIZE - PAD}" y2="${g}" stroke="#2a2a4a" stroke-width=".5"/>`
      + `<text x="${g}" y="${SIZE - 8}" font-size="8" fill="#666" text-anchor="middle">${v}</text>`
      + `<text x="3" y="${g + 3}" font-size="8" fill="#666">${v}</text>`;
  }
  if (raster) {
    const path = rasterPath(c);
    if (path.length > 1) s += `<polyline points="${path.map((p) => `${ps(p.x)},${ps(p.y)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="1" opacity=".8" pointer-events="none"/>`;
    path.slice(0, 200).forEach((p, i) => { s += `<circle cx="${ps(p.x)}" cy="${ps(p.y)}" r="${i ? 1.5 : 4}" fill="${i ? '#00aaff' : '#ff0000'}" pointer-events="none"/>`; });
  }
  s += `<rect data-drag="move" x="${L}" y="${T}" width="${Math.max(R - L, 1)}" height="${Math.max(B - T, 1)}" fill="rgba(0,150,255,.15)" stroke="#0096ff" stroke-width="2" stroke-dasharray="4,2" `
    + (raster ? `style="cursor:${drag ? 'grabbing' : 'grab'}"/>` : 'opacity=".35" pointer-events="none"/>');
  if (raster) {
    for (const [m, x, y, cur] of [['nw', L, T, 'nwse'], ['ne', R, T, 'nesw'], ['sw', L, B, 'nesw'], ['se', R, B, 'nwse']]) {
      s += `<rect data-drag="${m}" x="${x - 5}" y="${y - 5}" width="10" height="10" fill="#0096ff" stroke="#fff" style="cursor:${cur}-resize"/>`;
    }
  }
  if (points.length) {   // visiting order; the dashed segment closes the loop the board repeats
    const pp = points.map((p) => `${ps(p.x)},${ps(p.y)}`);
    s += `<polyline points="${pp.join(' ')}" fill="none" stroke="#ffd43b" stroke-width="1" opacity="${raster ? '.35' : '.9'}" pointer-events="none"/>`;
    if (points.length > 2) s += `<line x1="${ps(points.at(-1).x)}" y1="${ps(points.at(-1).y)}" x2="${ps(points[0].x)}" y2="${ps(points[0].y)}" stroke="#ffd43b" stroke-dasharray="3,3" opacity=".5" pointer-events="none"/>`;
    points.forEach((p, i) => {
      s += `<circle cx="${ps(p.x)}" cy="${ps(p.y)}" r="${points.length > 64 ? 2 : 4}" fill="#ffd43b" opacity="${raster ? '.5' : '1'}" pointer-events="none"/>`;
      if (points.length <= 64) s += `<text x="${pn(p.x) + 6}" y="${pn(p.y) - 5}" font-size="8" fill="#ffe066" pointer-events="none">${i + 1}</text>`;
    });
  }
  const pk = park();
  s += `<g stroke="#f06595" stroke-width="1.5" pointer-events="none"><line x1="${pn(pk.x) - 6}" y1="${ps(pk.y)}" x2="${pn(pk.x) + 6}" y2="${ps(pk.y)}"/><line x1="${ps(pk.x)}" y1="${pn(pk.y) - 6}" x2="${ps(pk.x)}" y2="${pn(pk.y) + 6}"/><circle cx="${ps(pk.x)}" cy="${ps(pk.y)}" r="3.5" fill="none"/></g>`;
  s += `<text x="${(L + R) / 2}" y="${B + 12 < SIZE - PAD ? B + 12 : T - 6}" font-size="9" fill="#8fd0ff" text-anchor="middle" pointer-events="none">${c.x_max - c.x_min}×${c.y_max - c.y_min} DAC</text>`;
  s += `<text x="${SIZE / 2}" y="12" font-size="10" font-weight="bold" fill="#888" text-anchor="middle">DAC range 0–${DAC_MAX}</text>`;
  if (raster) s += `<rect x="${SIZE - 85}" y="2" width="80" height="16" rx="3" fill="${col}" opacity=".3"/><text x="${SIZE - 45}" y="13" font-size="9" font-weight="bold" fill="${col}" text-anchor="middle">${bidi ? 'BIDI' : 'UNI'}</text>`;
  return s;
}

// ── Timing plot: X DAC value over two consecutive lines, with the trigger and laser windows ──
const PW = 400, PH = 176;
function profileHtml(c) {
  const p = lineProfile(c);
  if (!p) return `<text x="${PW / 2}" y="${PH / 2}" font-size="11" fill="#f14c4c" text-anchor="middle">line empty or too long – see the messages above</text>`;
  const L = 40, R = PW - 6, TOP = 8, BOT = 104, n = p.total * 2;
  const lines = [p.x, c.bidirectional ? mirrorLine(p) : p.x];
  const all = lines.flat(), lo = Math.min(...all), hi = Math.max(...all);
  const sx = (i) => (L + (i / n) * (R - L)).toFixed(1);
  const sy = (v) => (BOT - ((v - lo) / Math.max(hi - lo, 1)) * (BOT - TOP)).toFixed(1);
  const bar = (from, to, y, h, fill, opacity = 1) =>
    `<rect x="${sx(from)}" y="${y}" width="${Math.max(+sx(to) - +sx(from), 0.6)}" height="${h}" fill="${fill}" opacity="${opacity}"/>`;
  let s = '';
  lines.forEach((_, li) => p.regions.forEach((r) => {
    if (r.to > r.from) s += bar(li * p.total + r.from, li * p.total + r.to, TOP, BOT - TOP, REGION_COLOR[r.name], 0.2);
  }));
  s += `<polyline points="${lines.map((l, li) => l.map((v, i) => `${sx(li * p.total + i)},${sy(v)}`).join(' ')).join(' ')}" fill="none" stroke="#e9ecef" stroke-width="1.2"/>`;
  s += `<text x="${L - 3}" y="${TOP + 7}" font-size="8" fill="#888" text-anchor="end">${hi}</text><text x="${L - 3}" y="${BOT}" font-size="8" fill="#888" text-anchor="end">${lo}</text>`;
  let y = BOT + 8;
  const lane = (label, draw) => { s += `<text x="${L - 3}" y="${y + 8}" font-size="8" fill="#888" text-anchor="end">${label}</text>${draw(y)}`; y += 15; };
  if (c.enable_trigger) {
    lane('pixel', (yy) => [0, 1].map((li) => bar(li * p.total + p.imgStart, li * p.total + p.imgEnd, yy, 10, '#20c997')).join(''));
    lane('marker', (yy) => [0, 1].map((li) => bar(li * p.total, li * p.total + 0.4, yy, 10, '#f06595')).join('') + bar(0, 0.4, yy, 4, '#ffd43b'));   // line marker each line, frame marker (short, yellow) on line 0
  }
  if (c.laser_blanking) lane('laser', (yy) => [0, 1].map((li) => bar(li * p.total + p.imgStart, li * p.total + p.imgEnd, yy, 10, '#ff6b6b')).join(''));
  s += `<text x="${(L + R) / 2}" y="${PH - 2}" font-size="8" fill="#888" text-anchor="middle">sample index (line 1${c.bidirectional ? ', line 2 mirrored' : ', line 2'})</text>`;
  return s;
}

function legendHtml(c) {
  const p = lineProfile(c);
  if (!p) return '';
  const sum = {};
  for (const r of p.regions) sum[REGION_LABEL[r.name]] = (sum[REGION_LABEL[r.name]] || 0) + r.to - r.from;
  const color = Object.fromEntries(Object.entries(REGION_LABEL).map(([k, v]) => [v, REGION_COLOR[k]]));
  return Object.entries(sum).filter(([, v]) => v > 0)
    .map(([k, v]) => `<span class="me-2 text-nowrap"><span class="galvo-sw" style="background:${color[k]}"></span>${k} ${v}</span>`).join('')
    + `<span class="text-muted text-nowrap">= ${p.total} samples/line</span>`;
}

// ── Rendering ────────────────────────────────────────────────────────────
function render(skip) {
  const c = readCfg();
  syncDerived(skip);
  const { errors, warnings } = validate(c);
  const box = $('galvoIssues');
  box.replaceChildren(...[...errors.map((t) => [t, 'danger']), ...warnings.map((t) => [t, 'warning'])].map(([t, k]) => {
    const d = document.createElement('div');
    d.className = `alert alert-${k} py-1 px-2 mb-2 small`;
    d.textContent = t;
    return d;
  }));
  box.classList.toggle('hidden', !errors.length && !warnings.length);
  const t = scanTiming(c);
  $('galvoInfo').textContent = `${t.pixels.toLocaleString()} pixels · ${t.line} samples/line, ${Math.round((100 * c.nx) / Math.max(t.line, 1))} % on image pixels · `
    + (c.sample_period_us > 0 ? `frame ≈ ${t.frameUs >= 1e6 ? `${(t.frameUs / 1e6).toFixed(2)} s` : `${(t.frameUs / 1000).toFixed(1)} ms`} (${t.hz.toFixed(2)} Hz)` : 'dwell 0 = as fast as the DAC loop allows');
  $('galvoPreview').innerHTML = previewHtml(c);
  $('galvoProfile').innerHTML = profileHtml(c);
  $('galvoLegend').innerHTML = legendHtml(c);
}

function renderPoints() {
  $('galvoPtsBody').innerHTML = points.map((p, i) => `<tr><td class="text-muted align-middle">${i + 1}</td>`
    + ['x', 'y', 'dwell_us'].map((f) => `<td><input type="number" class="form-control form-control-sm" data-pt="${i}" data-f="${f}" min="0" max="${f === 'dwell_us' ? 4294967295 : DAC_MAX}" value="${p[f]}"></td>`).join('')
    + `<td><button class="btn btn-sm btn-outline-danger py-0" data-pt-del="${i}" aria-label="Remove point ${i + 1}"><i class="bi bi-x"></i></button></td></tr>`).join('');
  $('galvoPtsCount').textContent = `${points.length} / ${C.GALVO_MAX_POINTS}`;
  render();
}

function setPoints(list) {
  points = list.slice(0, C.GALVO_MAX_POINTS);
  if (list.length > points.length) msg(`Only the first ${C.GALVO_MAX_POINTS} points fit on the board.`, false);
  renderPoints();
  persist();
}

function msg(text, ok) {
  const el = $('galvoMsg');
  el.textContent = text;
  el.className = `small mt-2 ${ok ? 'text-success' : 'text-danger'}`;
}

function showStatus(m) {
  const chip = (text, cls, title) => {
    const b = document.createElement('span');
    b.className = `badge ${cls}`;
    b.textContent = text;
    if (title) b.title = title;
    return b;
  };
  const out = [chip(m.running ? 'Running' : 'Stopped', m.running ? 'bg-success' : 'bg-secondary')];
  if (m.current_frame !== undefined) out.push(chip(`frame ${m.current_frame}`, 'bg-light text-dark border'), chip(`line ${m.current_line}`, 'bg-light text-dark border'));
  if (m.scan_mode) out.push(chip(String(m.scan_mode).toLowerCase(), 'bg-info text-dark', 'scan mode'));
  if (m.trigger_mode) out.push(chip(`laser ${String(m.trigger_mode).toLowerCase()}`, 'bg-info text-dark', 'laser trigger mode'));
  if (m.timing_overruns) out.push(chip(`${m.timing_overruns} timing overruns`, 'bg-warning text-dark', 'Samples that started more than one dwell late. About 1000 per frame at 25 µs are normal with the current firmware (interrupts on the scan core); if nearly every sample overruns, the dwell is below what the board can do (about 22 µs).'));
  if (m.x !== undefined) out.push(chip(`x ${m.x} · y ${m.y}`, 'bg-light text-dark border', 'position read from the satellite'));
  $('galvoChips').replaceChildren(...out);
}

// Replies are matched by shape: a local board answers /galvo_act with {success: true|false, message|error},
// one behind a CAN master with {return: 0|1, qid}; /galvo_get returns the status.
function onFrame(m) {
  if ('running' in m && ('current_frame' in m || 'scanActive' in m || 'scan_mode' in m)) {
    showStatus(m);
    if (reading) {
      reading = false;
      if (m.config) { writeCfg(m.config); render(); persist(); msg('Config read from the board.', true); }
      else msg('This board returned status only (galvo behind a CAN master): no config to read.', false);
    }
  } else if (m.success === true || m.success === false) {
    msg(m.message || m.error || (m.success ? 'OK' : 'The board refused the command'), m.success);
  } else if ('return' in m && m.qid === lastQid) {
    msg(m.return ? 'Sent.' : (m.error || 'The board did not confirm the command (no route to a galvo, or the satellite did not answer)'), !!m.return);
  }
}

// ── Settings (per browser) ───────────────────────────────────────────────
const fields = () => document.querySelectorAll('#galvo-pane [id^="galvo_"]:not([data-derived])');

function restore() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* storage blocked */ }
  writeCfg(DEFAULTS);
  fields().forEach((el) => { if (el.id in s) el[el.type === 'checkbox' ? 'checked' : 'value'] = s[el.id]; });
  if (Array.isArray(s.points)) {
    points = s.points.map((p) => ({ x: clamp(+p.x | 0, 0, DAC_MAX), y: clamp(+p.y | 0, 0, DAC_MAX), dwell_us: Math.max(0, +p.dwell_us | 0) })).slice(0, C.GALVO_MAX_POINTS);
  }
  return s.mode === 'points' ? 'points' : 'raster';
}

function persist() {
  const s = { mode, points };
  fields().forEach((el) => { s[el.id] = el.type === 'checkbox' ? el.checked : el.value; });
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
}

function setMode(m) {
  mode = m;
  $('galvoRasterBlock').classList.toggle('hidden', m !== 'raster');
  $('galvoPointsBlock').classList.toggle('hidden', m !== 'points');
  $('galvoStartLabel').textContent = m === 'raster' ? 'Apply & start scan' : 'Send points & start';
  $('galvoPreview').style.cursor = m === 'points' ? 'crosshair' : '';
  $('galvoPreviewHint').textContent = m === 'raster'
    ? 'Drag the blue rectangle to move the scan, pull a corner to resize. Double-click moves the beam to that point. The pink cross is the park position.'
    : `Click to add a point (max ${C.GALVO_MAX_POINTS}). The beam visits them in order and loops. The pink cross is the park position.`;
  $(m === 'raster' ? 'galvoModeRaster' : 'galvoModePoints').checked = true;
  render();
}

// ── Init ─────────────────────────────────────────────────────────────────
export function initGalvo() {
  for (const [id, g] of Object.entries(GROUPS)) $(id).innerHTML = g.nums.map(numHtml).join('') + g.flags.map(flagHtml).join('');
  $('galvoWindow').innerHTML = windowHtml('x') + windowHtml('y');
  const startMode = restore();
  renderPoints();
  setMode(startMode);

  const run = (fn) => async () => {
    try { await fn(); } catch (e) { msg(e.message, false); serial.log(`Galvo: ${e.message}`, 'error'); }
  };
  // Sends a /galvo_act and, a moment later, asks for the status so the chips follow
  const send = async (cmd) => {
    lastQid = cmd.qid;
    const ok = await serial.send(cmd);
    if (ok) setTimeout(() => serial.send(C.galvoGet()), 400);
    return ok;
  };

  $('galvoStart').addEventListener('click', run(async () => {
    if (mode === 'points') return send(C.galvoPoints(points, $('galvo_trigger').value));
    const c = readCfg(), { errors } = validate(c);
    if (errors.length) throw new Error(errors[0]);
    return send(C.galvoScan(c));
  }));
  $('galvoStop').addEventListener('click', run(() => send(C.galvoStop())));
  $('galvoRefresh').addEventListener('click', run(() => serial.send(C.galvoGet())));
  $('galvoRead').addEventListener('click', run(async () => { reading = true; if (!(await serial.send(C.galvoGet()))) reading = false; }));
  $('galvoPark').addEventListener('click', run(() => { const p = park(); return send(C.galvoGoto(p.x, p.y)); }));
  $('galvoCenter').addEventListener('click', run(() => { $('galvo_park_x').value = 2048; $('galvo_park_y').value = 2048; render(); persist(); return send(C.galvoGoto(2048, 2048)); }));
  $('galvoTriggerSet').addEventListener('click', run(() => send(C.galvoTrigger($('galvo_trigger').value))));
  document.querySelectorAll('input[name="galvoMode"]').forEach((r) => r.addEventListener('change', () => { $('galvoMsg').textContent = ''; setMode(r.value); persist(); }));

  // Presets
  const PRESETS = {
    '64': { nx: 64, ny: 64 }, '256': { nx: 256, ny: 256 }, '512': { nx: 512, ny: 512 },
    full: { x_min: 0, x_max: DAC_MAX, y_min: 0, y_max: DAC_MAX }, center50: { x_min: 1024, x_max: 3072, y_min: 1024, y_max: 3072 },
    flim: FLIM_TIMING,
  };
  document.querySelectorAll('[data-galvo-preset]').forEach((b) => b.addEventListener('click', () => {
    writeCfg({ ...readCfg(), ...PRESETS[b.dataset.galvoPreset] });
    render(); persist();
  }));

  // Points
  const win = () => { const c = readCfg(); return { x_min: c.x_min, x_max: c.x_max, y_min: c.y_min, y_max: c.y_max }; };
  const num = (id, d) => Math.max(1, parseInt($(id).value, 10) || d);
  $('galvoPtsCircle').addEventListener('click', () => {
    const a = win();
    setPoints(circlePoints((a.x_min + a.x_max) / 2, (a.y_min + a.y_max) / 2, Math.min(a.x_max - a.x_min, a.y_max - a.y_min) / 2, num('galvo_pts_n', 32), dwell()));
  });
  $('galvoPtsGrid').addEventListener('click', () => setPoints(gridPoints(win(), num('galvo_pts_gx', 4), num('galvo_pts_gy', 4), dwell())));
  $('galvoPtsClear').addEventListener('click', () => setPoints([]));
  $('galvoPtsBody').addEventListener('input', (e) => {
    const i = e.target.dataset.pt, f = e.target.dataset.f;
    if (i === undefined) return;
    points[i][f] = clamp(parseInt(e.target.value, 10) || 0, 0, f === 'dwell_us' ? 4294967295 : DAC_MAX);
    render();
  });
  $('galvoPtsBody').addEventListener('change', persist);
  $('galvoPtsBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pt-del]');
    if (b) setPoints(points.filter((_, i) => i !== +b.dataset.ptDel));
  });

  // Form: any field re-renders the preview and plot
  const pane = $('galvo-pane');
  pane.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.id.startsWith('galvo_')) return;
    $('galvoMsg').textContent = '';   // it reported the last command, not the form being edited now
    const m = el.id.match(/^galvo_([xy])_(width|center|pos)$/);
    if (m) setWindow(m[1], m[2] === 'width' ? { width: +el.value } : { center: +el.value });
    render(m ? el : undefined);
  });
  pane.addEventListener('change', (e) => {
    if (!e.target.id.startsWith('galvo_')) return;
    render();   // typed width/centre values are replaced by the clamped result
    persist();
  });

  // Preview: drag the rectangle, click to add points, double-click to move the beam
  const svg = $('galvoPreview');
  const toDac = (e) => {
    const m = svg.getScreenCTM();
    if (!m) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(m.inverse());
    return { x: clamp((p.x - PAD) / K, 0, DAC_MAX), y: clamp((p.y - PAD) / K, 0, DAC_MAX) };
  };
  svg.addEventListener('pointerdown', (e) => {
    const d = toDac(e);
    if (!d) return;
    if (mode === 'points') {
      if (points.length >= C.GALVO_MAX_POINTS) return msg(`The board takes at most ${C.GALVO_MAX_POINTS} points.`, false);
      points.push({ x: Math.round(d.x), y: Math.round(d.y), dwell_us: dwell() });
      renderPoints(); persist();
      return;
    }
    const m = e.target.dataset?.drag;
    if (!m) return;
    const c = readCfg();
    drag = { mode: m, start: d, area: { x_min: c.x_min, x_max: c.x_max, y_min: c.y_min, y_max: c.y_max } };
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const d = toDac(e);
    if (!d) return;
    writeCfg(dragArea(drag.area, drag.mode, d.x - drag.start.x, d.y - drag.start.y));
    render();
  });
  const endDrag = () => { if (drag) { drag = null; render(); persist(); } };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('dblclick', (e) => run(async () => {
    const d = mode === 'raster' && toDac(e);
    if (!d) return;
    const x = Math.round(d.x), y = Math.round(d.y);
    $('galvo_park_x').value = x; $('galvo_park_y').value = y;
    render(); persist();
    await send(C.galvoGoto(x, y));
  })());

  serial.onFrame(onFrame);
  render();
}
