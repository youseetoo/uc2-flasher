// js/flasher/scan.js
// Scan tab: tile scan with a USB webcam and the XY stage, live mosaic at the stage positions.
// Moves are relative from a position tracked here (the board's own counter is never used) and
// wait for the board's {"qid":q,"steppers":[{"stepperid":i,"isDone":1}]} reply, as in the
// UC2 Control Android app. With a folder picked, every scan is saved in ImSwitch's ShitScope
// layout (scan.json, tiles.json, tiles/tile_0000.jpg) plus tiles/TileConfiguration.txt for
// Fiji's Grid/Collection stitching; both register the tiles, this page only places them.

import * as serial from './serial.js';
import * as C from './commands.js';

const $ = (id) => document.getElementById(id);
const num = (id, fallback = 0) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : fallback; };
const STEPPERS = [C.AXES.X, C.AXES.Y];
const MAX_TILES_PER_AXIS = 100;
// ponytail: the live mosaic is a preview with its long side capped here; full resolution
// comes from the saved tiles (Fiji / ImSwitch registration and stitching).
const MOSAIC_MAX_PX = 6000;
const KEY = 'uc2-scan';

// ── Pure helpers (unit-tested in tests/flasher.test.mjs) ─────────────────
// Stage µm → µm along the image axes (x right, y down) of the mosaic.
export function toImage(x, y, { swap = false, flipX = false, flipY = false } = {}) {
  const [a, b] = swap ? [y, x] : [x, y];
  return [flipX ? -a : a, flipY ? -b : b];
}

// Field of view along stage X and Y: with swapped axes stage X runs along the image height.
export const stageFov = (fovW, fovH, swap) => (swap ? [fovH, fovW] : [fovW, fovH]);

// Tile centres in scan order, centred on (x0, y0); snake reverses odd rows (shitscope_scan.plan_grid).
export function grid(x0, y0, nx, ny, stepX, stepY, snake = true) {
  x0 -= ((nx - 1) * stepX) / 2;
  y0 -= ((ny - 1) * stepY) / 2;
  const tiles = [];
  for (let iy = 0; iy < ny; iy++) {
    for (let i = 0; i < nx; i++) {
      const ix = snake && iy % 2 ? nx - 1 - i : i;
      tiles.push({ ix, iy, x: x0 + ix * stepX, y: y0 + iy * stepY });
    }
  }
  return tiles;
}

// ── Stage ────────────────────────────────────────────────────────────────
const pos = [0, 0];                 // µm, from the moves sent here
let queue = Promise.resolve();      // stage operations, one at a time

function onStage(fn) {
  queue = queue.then(fn).catch((e) => serial.log(`Stage: ${e.message}`, 'error'));
}

// Sends one move; resolves once the board reports that stepper done for the move's qid.
function moveAndWait(cmd, timeoutMs) {
  const id = cmd.motor.steppers[0].stepperid;
  return new Promise((resolve, reject) => {
    let timer = 0;
    const off = serial.onFrame((m) => {
      if (m.qid !== cmd.qid) return;
      if (m.success < 0) done(new Error(`board rejected the move: ${JSON.stringify(m)}`));
      else if (m.steppers?.some((s) => s.stepperid === id && s.isDone === 1)) done();
    });
    const done = (err) => { off(); clearTimeout(timer); if (err) reject(err); else resolve(); };
    timer = setTimeout(() => done(new Error(`stepper ${id} reported no "done" within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    serial.send(cmd).then((ok) => ok || done(new Error('not connected')), done);
  });
}

async function moveTo(x, y) {
  const um = [num('scanUmX'), num('scanUmY')], speed = Math.max(1, num('scanSpeed', 15000));
  if (!um[0] || !um[1]) throw new Error('µm/step must not be 0');
  for (const [i, target] of [x, y].entries()) {
    const steps = Math.round((target - pos[i]) / um[i]);
    if (!steps) continue;   // an axis that does not move sends no isDone
    await moveAndWait(C.motorMove(STEPPERS[i], steps, { speed, acceleration: num('scanAccel', 0) }),
      5000 + (1000 * Math.abs(steps)) / speed);
    pos[i] += steps * um[i];
    $('scanPos').textContent = `X ${pos[0].toFixed(1)} µm · Y ${pos[1].toFixed(1)} µm`;
  }
}

// ── Camera ───────────────────────────────────────────────────────────────
let stream = null;

async function listCameras(want = $('scanCamera').value) {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  $('scanCamera').replaceChildren(...cams.map((d, i) => new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  if (cams.some((d) => d.deviceId === want)) $('scanCamera').value = want;
}

async function startCamera() {
  stopCamera();
  const [width, height] = $('scanRes').value.split('x').map(Number);
  const id = $('scanCamera').value;
  stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: id ? { exact: id } : undefined, width: { ideal: width }, height: { ideal: height } },
  });
  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => { stopCamera(); $('scanCamInfo').textContent = 'Camera disconnected.'; });
  const v = $('scanVideo');
  v.srcObject = stream;
  await v.play();
  await listCameras(track.getSettings().deviceId);   // names appear once camera access is granted
  $('scanCamInfo').textContent = `${track.label} · ${v.videoWidth} × ${v.videoHeight} px`;
  $('scanCamBtn').innerHTML = '<i class="bi bi-stop-fill"></i> Stop';
  persist();
  plan();
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $('scanVideo').srcObject = null;
  $('scanCamBtn').innerHTML = '<i class="bi bi-camera-video"></i> Start';
}

// ── Plan and mosaic ──────────────────────────────────────────────────────
let last = null;   // last scan: { tiles, shots: [{x, y, bmp}], scale } for re-placing

const orientation = () => ({ swap: $('scanSwap').checked, flipX: $('scanFlipX').checked, flipY: $('scanFlipY').checked });
const clampN = (n) => Math.max(1, Math.min(MAX_TILES_PER_AXIS, Math.round(n)));

function plan() {
  const v = $('scanVideo'), [rw, rh] = $('scanRes').value.split('x').map(Number);
  const W = v.videoWidth || rw, H = v.videoHeight || rh;   // the camera's frames once it runs
  const px = num('scanPx', 1), ov = Math.min(90, Math.max(0, num('scanOverlap', 25))) / 100;
  const nx = clampN(num('scanNx', 3)), ny = clampN(num('scanNy', 3));
  const fov = stageFov(W * px, H * px, $('scanSwap').checked);
  const step = fov.map((f) => f * (1 - ov));
  const tiles = grid(pos[0], pos[1], nx, ny, step[0], step[1], $('scanSnake').checked);
  const mm = (um) => (um / 1000).toFixed(2);
  $('scanInfo').textContent = `${W} × ${H} px · FOV ${mm(W * px)} × ${mm(H * px)} mm · step X ${step[0].toFixed(0)} µm, Y ${step[1].toFixed(0)} µm`
    + ` · area ${mm((nx - 1) * step[0] + fov[0])} × ${mm((ny - 1) * step[1] + fov[1])} mm (stage X × Y) · ${tiles.length} tiles`;
  return { tiles, W, H, px, ov, nx, ny, step };
}

// Every shot at its stage position, later tiles on top (no registration, no blending).
function renderMosaic() {
  if (!last?.shots.length) return;
  const f = last.scale / num('scanPx', 1), o = orientation();   // mosaic px per µm
  const at = (t) => toImage(t.x, t.y, o).map((v) => v * f);
  const pts = last.tiles.map(at), xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), { width: w, height: h } = last.shots[0].bmp;
  const cv = $('scanMosaic');
  cv.width = Math.min(16384, Math.ceil(Math.max(...xs) - x0 + w));
  cv.height = Math.min(16384, Math.ceil(Math.max(...ys) - y0 + h));
  const ctx = cv.getContext('2d');
  for (const s of last.shots) {
    const [x, y] = at(s);
    ctx.drawImage(s.bmp, Math.round(x - x0), Math.round(y - y0));
  }
}

// ── Scan ─────────────────────────────────────────────────────────────────
let folder = null, scanning = false, stopRequested = false;

async function writeFile(dir, name, data) {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(data);
  await w.close();
}

async function saveIndex(dir, meta, records) {
  await writeFile(dir, 'scan.json', JSON.stringify(meta, null, 1));
  await writeFile(dir, 'tiles.json', JSON.stringify(records, null, 1));
  // Fiji: Plugins › Stitching › Grid/Collection stitching › Positions from file › Defined by TileConfiguration
  const rows = records.map((r) => `${r.file.slice(6)}; ; (${(r.x / meta.um_per_px).toFixed(1)}, ${(r.y / meta.um_per_px).toFixed(1)})`);
  await writeFile(await dir.getDirectoryHandle('tiles'), 'TileConfiguration.txt',
    `# Define the number of dimensions we are working on\ndim = 2\n\n# Define the image coordinates\n${rows.join('\n')}\n`);
  await writeFile(dir, 'mosaic.png', await new Promise((r) => $('scanMosaic').toBlob(r)));
}

function setScanning(on) {
  scanning = on;
  document.querySelectorAll('#scan-pane fieldset').forEach((f) => { f.disabled = on; });
  $('scanStart').disabled = on || !serial.isConnected();
  $('scanStop').disabled = !on;
}

const clock = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

async function scan() {
  if (scanning) return;
  const track = stream?.getVideoTracks()[0];
  if (track?.readyState !== 'live') throw new Error('Start the camera first');
  if (!serial.isConnected()) throw new Error('Connect the board first (console below)');
  await queue;   // a jog still on its way

  const p = plan(), o = orientation(), start = [...pos], n = p.tiles.length;
  if (!(p.px > 0)) throw new Error('Set the pixel size first');
  const grab = new ImageCapture(track), settle = Math.max(0, num('scanSettle', 300));
  const scale = Math.min(1, MOSAIC_MAX_PX / (Math.max(p.nx, p.ny) * Math.max(p.W, p.H)));
  const name = `scan_${new Date().toLocaleString('sv').replace(/[-:]/g, '').replace(' ', '_')}`;
  const dir = folder && (await folder.getDirectoryHandle(name, { create: true }));
  const tilesDir = dir && (await dir.getDirectoryHandle('tiles', { create: true }));
  const enc = new OffscreenCanvas(p.W, p.H);
  // x, y are saved along the image axes, so registration (ImSwitch, Fiji) needs no orientation
  const img = (t) => { const [x, y] = toImage(t.x, t.y, o); return { ix: t.ix, iy: t.iy, x, y }; };
  const meta = {
    um_per_px: p.px, image_width: p.W, image_height: p.H, step_x_um: p.step[0], step_y_um: p.step[1], overlap: p.ov,
    pattern: $('scanSnake').checked ? 'snake' : 'raster', settle_ms: settle,
    orientation: { swap_xy: o.swap, flip_x: o.flipX, flip_y: o.flipY },
    xy: 'x, y: tile position along the image axes (orientation applied); stage_x, stage_y: stage position; µm',
    um_per_step: [num('scanUmX'), num('scanUmY')], plan: p.tiles.map(img),
    start: { X: start[0], Y: start[1] }, camera: track.label, time: new Date().toISOString(), app: 'openUC2 web flasher',
  };
  last?.shots.forEach((s) => s.bmp.close());
  last = { tiles: p.tiles, shots: [], scale };
  const records = [];
  const lock = await navigator.wakeLock?.request('screen').catch(() => null);   // no sleep mid-scan
  stopRequested = false;
  setScanning(true);
  $('scanStatus').textContent = `Scanning ${n} tiles…`;
  const t0 = performance.now();
  try {
    for (const [k, t] of p.tiles.entries()) {
      if (stopRequested) break;
      await moveTo(t.x, t.y);
      // grabFrame() returns the newest frame at once, so wait out vibration and camera latency first
      await new Promise((r) => setTimeout(r, settle));
      const frame = await grab.grabFrame();
      const file = `tiles/tile_${String(k).padStart(4, '0')}.jpg`;
      if (tilesDir) {
        // ponytail: encode and write inline, the stage waits; overlap with the next move if speed matters
        enc.getContext('2d').drawImage(frame, 0, 0);
        await writeFile(tilesDir, file.slice(6), await enc.convertToBlob({ type: 'image/jpeg', quality: 0.92 }));
      }
      records.push({ ...img(t), k, file, stage_x: pos[0], stage_y: pos[1] });
      const bmp = scale < 1 ? await createImageBitmap(frame, {
        resizeWidth: Math.round(frame.width * scale), resizeHeight: Math.round(frame.height * scale), resizeQuality: 'medium',
      }) : frame;
      if (bmp !== frame) frame.close();
      last.shots.push({ x: t.x, y: t.y, bmp });
      renderMosaic();
      const el = performance.now() - t0;
      $('scanBar').style.width = `${(100 * (k + 1)) / n}%`;
      $('scanStatus').textContent = `Tile ${k + 1} / ${n} · ${clock(el)} · ETA ${clock((el / (k + 1)) * (n - k - 1))}`;
    }
    if ($('scanReturn').checked) await moveTo(...start);
    $('scanStatus').textContent = `${records.length < n ? 'Stopped' : 'Done'}: ${records.length} / ${n} tiles in ${clock(performance.now() - t0)}`
      + (dir ? ` · saved to ${folder.name}/${name}` : '');
  } finally {
    lock?.release();
    setScanning(false);
    if (dir && records.length) await saveIndex(dir, meta, records).catch((e) => serial.log(`Saving the scan index failed: ${e.message}`, 'error'));
  }
}

// ── Settings (per browser) ───────────────────────────────────────────────
const fields = () => document.querySelectorAll('input[id^="scan"], select[id^="scan"]');

function restore() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* storage blocked */ }
  fields().forEach((el) => {
    if (el.id in s) el[el.type === 'checkbox' ? 'checked' : 'value'] = s[el.id];
  });
  return s;
}

function persist() {
  const s = {};
  fields().forEach((el) => { s[el.id] = el.type === 'checkbox' ? el.checked : el.value; });
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
}

// ── Init ─────────────────────────────────────────────────────────────────
export function initScan() {
  const saved = restore();
  if (navigator.mediaDevices) {
    listCameras(saved.scanCamera).catch(() => {});
    navigator.mediaDevices.addEventListener('devicechange', () => listCameras().catch(() => {}));
  } else {
    $('scanCamInfo').textContent = 'No camera access here: the page must be served over https (or from localhost).';
  }
  const camError = (e) => { $('scanCamInfo').textContent = `Camera: ${e.message || e.name}`; };   // OverconstrainedError has no message
  $('scanCamBtn').addEventListener('click', () => (stream ? stopCamera() : startCamera().catch(camError)));
  $('scanCamera').addEventListener('change', () => stream && startCamera().catch(camError));
  $('scanRes').addEventListener('change', () => stream && startCamera().catch(camError));

  document.querySelectorAll('[data-scan-jog]').forEach((b) => b.addEventListener('click', () => {
    const d = (b.dataset.scanJog[1] === '+' ? 1 : -1) * num('scanJogStep', 500);
    onStage(() => (b.dataset.scanJog[0] === 'X' ? moveTo(pos[0] + d, pos[1]) : moveTo(pos[0], pos[1] + d)));
  }));

  $('scanFolderBtn').addEventListener('click', async () => {
    try {
      folder = await window.showDirectoryPicker({ id: 'uc2-scan', mode: 'readwrite' });
      $('scanFolder').textContent = `each scan gets a folder in ${folder.name}`;
    } catch (e) { if (e.name !== 'AbortError') serial.log(e.message, 'error'); }
  });
  $('scanStart').addEventListener('click', () => scan().catch((e) => {
    $('scanStatus').textContent = `Scan failed: ${e.message}`;
    serial.log(`Scan: ${e.message}`, 'error');
  }));
  $('scanStop').addEventListener('click', () => {
    stopRequested = true;
    $('scanStatus').textContent = 'Stopping after this tile…';
  });
  $('scanSavePng').addEventListener('click', () => $('scanMosaic').toBlob((b) => {
    if (!b) return;
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(b), download: 'mosaic.png' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }));

  $('scan-pane').addEventListener('input', (e) => {
    if (!e.target.id.startsWith('scan')) return;   // the console's fields live here too
    plan();
    renderMosaic();   // pixel size and orientation re-place the last scan
  });
  $('scan-pane').addEventListener('change', (e) => { if (e.target.id.startsWith('scan')) persist(); });
  plan();
}
