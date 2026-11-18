// Run: node --test tests/flasher.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameParser } from '../js/flasher/serial.js';
import { parsePartitionTable } from '../js/flasher/erase.js';
import * as C from '../js/flasher/commands.js';
import * as S from '../js/flasher/scan.js';
import * as G from '../js/flasher/galvo.js';

test('frame parser: NUL terminators, log lines, chunk boundaries', () => {
  const frames = [], logs = [];
  const push = createFrameParser((o, raw) => frames.push(o ?? raw), (l) => logs.push(l));
  const stream = '[I] boot {noise\n++\n{"steppers":[{"stepperid":1,"isDone":0}],"qid":2}\n--\n\0'
    + "++{'b':0}--\n" + '++\n{"qid":2,"state":"done"}\n--\n\0';
  for (let i = 0; i < stream.length; i += 7) push(stream.slice(i, i + 7));   // arbitrary chunking
  assert.deepEqual(frames, [{ steppers: [{ stepperid: 1, isDone: 0 }], qid: 2 }, { qid: 2, state: 'done' }]);
  assert.deepEqual(logs, ['[I] boot {noise', "++{'b':0}--"]);
});

test('commands use current firmware keys', () => {
  const m = C.motorMove(1, 1000, { speed: 5000, acceleration: 100000 });
  assert.equal(m.task, '/motor_act');
  assert.deepEqual(m.motor.steppers[0], { stepperid: 1, position: 1000, speed: 5000, isabs: 0, acceleration: 100000 });
  assert.ok(!('accel' in m.motor.steppers[0]) && !('isaccel' in m.motor.steppers[0]));
  assert.deepEqual(C.motorStop(2).motor.steppers[0], { stepperid: 2, isStop: 1 });
  assert.equal(C.home(1, { hardhome: true }).home.steppers[0].hardhome, 1);
  assert.deepEqual(C.ledFill(1, 2, 3).led, { action: 'fill', r: 1, g: 2, b: 3 });
  assert.deepEqual(C.setRemoteNodeId(11, 12), { task: '/can_act', setRemoteNodeId: 12, target: 11 });
  assert.deepEqual(C.tmcSet(1, { msteps: 16, rms_current: 0 }), { task: '/tmc_act', axis: 1, msteps: 16 });
  assert.equal(C.sdo(11, C.parseIndex('0x2001'), 2, 'i32').sdo.index, 8193);
  assert.throws(() => C.setOwnNodeId(0));
  assert.throws(() => C.setOwnNodeId(128));
  assert.ok(!C.toLine(m).includes('\n'));
});

test('partition table parser finds NVS', () => {
  const entry = (type, sub, off, size, name) => {
    const b = new Uint8Array(32);
    b.set([0xaa, 0x50, type, sub]);
    const dv = new DataView(b.buffer);
    dv.setUint32(4, off, true); dv.setUint32(8, size, true);
    b.set(new TextEncoder().encode(name), 12);
    return b;
  };
  const table = new Uint8Array(0xc00).fill(0xff);
  table.set(entry(1, 2, 0x9000, 0x4000, 'nvs'), 0);
  table.set(entry(1, 0, 0xd000, 0x2000, 'otadata'), 32);
  table.set(entry(0, 0x10, 0x10000, 0x140000, 'app0'), 64);
  const pt = parsePartitionTable(table);
  assert.equal(pt.length, 3);
  assert.deepEqual(pt.find((p) => p.type === 1 && p.subtype === 2), { type: 1, subtype: 2, offset: 0x9000, size: 0x4000, name: 'nvs' });
});

test('route builders: v4 satellite preset and validation', () => {
  assert.deepEqual(C.routeSet('MOTOR', 4, 'REMOTE', 14, 0, true),
    { task: '/route_set', type: 'MOTOR', id: 4, where: 'REMOTE', nodeId: 14, subAxis: 0, persist: 1 });
  assert.deepEqual(C.routeSet('LASER', 1, 'LOCAL'), { task: '/route_set', type: 'LASER', id: 1, where: 'LOCAL' });
  const pre = C.multiAxisRoutes(14);
  assert.equal(pre.length, 7);
  assert.deepEqual(pre.map((c) => [c.type, c.id, c.subAxis]), [
    ['MOTOR', 4, 0], ['MOTOR', 5, 1], ['MOTOR', 6, 2], ['MOTOR', 7, 3],
    ['LASER', 5, 1], ['LASER', 6, 2], ['LASER', 7, 3]]);
  assert.ok(pre.every((c) => c.nodeId === 14 && c.persist === 1));
  assert.throws(() => C.routeSet('MOTOR', 4, 'REMOTE', 14, 4));    // subAxis 0-3
  assert.throws(() => C.routeSet('MOTOR', 4, 'REMOTE', 200, 0));   // node 1-127
  assert.throws(() => C.routeSet('PUMP', 0, 'LOCAL'));
  assert.deepEqual(C.routeReset(), { task: '/route_set', reset: 1 });
  assert.deepEqual(C.setRole(2, 14), { task: '/config_set', canRole: 2, canNodeId: 14 });
});

test('scan plan: centred snake grid, swapped field of view, orientation', () => {
  assert.deepEqual(S.grid(0, 0, 3, 2, 100, 50, true).map((t) => [t.ix, t.iy, t.x, t.y]), [
    [0, 0, -100, -25], [1, 0, 0, -25], [2, 0, 100, -25], [2, 1, 100, 25], [1, 1, 0, 25], [0, 1, -100, 25]]);
  assert.deepEqual(S.grid(0, 0, 2, 2, 10, 10, false).map((t) => t.ix), [0, 1, 0, 1]);   // raster
  assert.deepEqual(S.stageFov(1000, 500, false), [1000, 500]);
  assert.deepEqual(S.stageFov(1000, 500, true), [500, 1000]);   // stage X runs along the image height
  assert.deepEqual(S.toImage(1, 2), [1, 2]);
  assert.deepEqual(S.toImage(1, 2, { swap: true, flipX: true }), [-2, 1]);
  assert.deepEqual(S.toImage(1, 2, { flipY: true }), [1, -2]);
});

test('galvo commands: bool bidirectional, qid on acts, range checks', () => {
  const scan = C.galvoScan({ ...G.DEFAULTS, bidirectional: 1 });
  assert.equal(scan.task, '/galvo_act');
  assert.equal(scan.config.bidirectional, true);   // the board's local parser only accepts a JSON bool
  assert.equal(scan.config.nx, 256);
  assert.ok(Number.isInteger(scan.qid));
  assert.equal(C.galvoStop().stop, true);
  assert.deepEqual(C.galvoGoto(2048, 0).galvo, { x: 2048, y: 0 });
  assert.throws(() => C.galvoGoto(4096, 0));
  assert.throws(() => C.galvoGoto(1.5, 0));
  const pts = C.galvoPoints([{ x: 1, y: 2, dwell_us: 3, laser_intensity: 9 }], 'HIGH');
  assert.deepEqual(pts.points, [{ x: 1, y: 2, dwell_us: 3 }]);   // the board reads x, y, dwell_us only
  assert.equal(pts.laser_trigger, 'HIGH');
  assert.throws(() => C.galvoPoints([]));
  assert.throws(() => C.galvoPoints(Array(257).fill({ x: 0, y: 0, dwell_us: 1 })));
  assert.throws(() => C.galvoPoints([{ x: 0, y: 0, dwell_us: 1 }], 'MAYBE'));
  assert.equal(C.galvoTrigger('LOW').laser_trigger, 'LOW');
  assert.equal(C.galvoGet().task, '/galvo_get');
  assert.ok(!C.toLine(scan).includes('\n'));
});

test('galvo line profile matches the firmware layout', () => {
  const c = { ...G.DEFAULTS, nx: 4, x_min: 300, x_max: 600, overscan_samples: 2, pre_samples: 1, fly_samples: 0, line_settle_samples: 1, bidirectional: false };
  const p = G.lineProfile(c);
  // pre @ start_x | lead-in ramp | image | lead-out ramp | settle @ start_x   (slope 100/pixel)
  assert.deepEqual(p.x, [100, 100, 200, 300, 400, 500, 600, 700, 800, 100]);
  assert.deepEqual([p.imgStart, p.imgEnd, p.total], [3, 7, 10]);
  assert.deepEqual(p.regions.filter((r) => r.to > r.from).map((r) => [r.name, r.from, r.to]),
    [['pre', 0, 1], ['lead-in', 1, 3], ['image', 3, 7], ['lead-out', 7, 9], ['settle', 9, 10]]);
  assert.deepEqual(G.mirrorLine(p), [800, 800, 700, 600, 500, 400, 300, 200, 100, 800]);
  // bidirectional: no fly-back (even if set), settle holds at the far end
  const b = G.lineProfile({ ...c, bidirectional: true, fly_samples: 50 });
  assert.equal(b.total, 10);
  assert.equal(b.x.at(-1), 800);
  // unidirectional fly-back: cosine ease from end_x to start_x
  const f = G.lineProfile({ ...c, fly_samples: 3, line_settle_samples: 0, pre_samples: 0 });
  assert.deepEqual(f.x.slice(-3), [800, 450, 100]);
  assert.equal(G.lineProfile({ ...c, nx: 5000 }), null);   // longer than the board allows
});

test('galvo validation mirrors the board', () => {
  assert.deepEqual(G.validate(G.DEFAULTS), { errors: [], warnings: [] });
  const bad = G.validate({ ...G.DEFAULTS, x_min: 3000, x_max: 3000, ny: 0 });
  assert.equal(bad.errors.length, 2);
  const long = G.validate({ ...G.DEFAULTS, nx: 4000, fly_samples: 200 });
  assert.match(long.errors[0], /4\d{3} samples/);
  assert.equal(G.validate({ ...G.DEFAULTS, nx: 4000, fly_samples: 200, bidirectional: true, pre_samples: 0, overscan_samples: 0, line_settle_samples: 0 }).errors.length, 0);   // no fly-back counted
  assert.equal(G.lineSamples(G.DEFAULTS), 64 + 2 * 32 + 256 + 256 + 128);
  assert.match(G.validate({ ...G.DEFAULTS, x_min: 0, x_max: 4095 }).warnings[0], /overscan/);   // ramp past the DAC range is clipped
  const fast = G.validate({ ...G.DEFAULTS, hw_pixel_clock: 1, sample_period_us: 1 }).warnings;
  assert.equal(fast.length, 2);
  assert.match(fast[0], /hardware pixel clock/);
  assert.match(fast[1], /22 µs/);
  // the as-found config of 2026-11-17: 1 µs dwell, no pre-blank, overscan or fly-back
  const asFound = G.validate({ ...G.DEFAULTS, sample_period_us: 1, pre_samples: 0, overscan_samples: 0, fly_samples: 0, line_settle_samples: 0 });
  assert.equal(asFound.errors.length, 0);
  assert.equal(asFound.warnings.length, 3);
  assert.equal(G.scanTiming(G.DEFAULTS).frameUs, 256 * (768 * 25 + G.LINE_OVERHEAD_US));   // 4.93 s, as measured
  assert.equal(G.scanTiming({ ...G.DEFAULTS, sample_period_us: 0 }).frameUs, 0);
  assert.deepEqual({ ...G.DEFAULTS, nx: 512, x_min: 900, sample_period_us: 1, ...G.FLIM_TIMING },
    { ...G.DEFAULTS, nx: 512, x_min: 900 });   // the FLIM timing preset keeps resolution and window
});

test('galvo geometry: window, drag, scan path, point generators', () => {
  assert.deepEqual(G.windowFromCenterWidth(2048, 1000), [1548, 2548]);
  assert.deepEqual(G.windowFromCenterWidth(100, 400), [0, 400]);          // slides, does not shrink
  assert.deepEqual(G.windowFromCenterWidth(4000, 400), [3695, 4095]);
  const a = { x_min: 1000, x_max: 2000, y_min: 1000, y_max: 3000 };
  assert.deepEqual(G.dragArea(a, 'move', -5000, 5000), { x_min: 0, x_max: 1000, y_min: 2095, y_max: 4095 });
  assert.deepEqual(G.dragArea(a, 'se', 100.4, -50), { ...a, x_max: 2100, y_max: 2950 });
  assert.deepEqual(G.dragArea(a, 'nw', 5000, 5000), { ...a, x_min: 1999, y_min: 2999 });   // never inverts
  const path = G.rasterPath({ nx: 3, ny: 2, x_min: 0, x_max: 100, y_min: 0, y_max: 50, bidirectional: true });
  assert.deepEqual(path.map((p) => [p.x, p.y]), [[0, 0], [50, 0], [100, 0], [100, 50], [50, 50], [0, 50]]);
  assert.equal(G.rasterPath({ ...G.DEFAULTS, nx: 512, ny: 512 }).length, 64 * 64);   // preview is capped
  assert.deepEqual(G.circlePoints(2048, 2048, 1000, 4, 7),
    [{ x: 3048, y: 2048, dwell_us: 7 }, { x: 2048, y: 3048, dwell_us: 7 }, { x: 1048, y: 2048, dwell_us: 7 }, { x: 2048, y: 1048, dwell_us: 7 }]);
  const win = { x_min: 0, x_max: 100, y_min: 0, y_max: 100 };
  assert.deepEqual(G.gridPoints(win, 2, 2, 5).map((p) => [p.x, p.y]), [[0, 0], [100, 0], [0, 100], [100, 100]]);
  assert.deepEqual(G.gridPoints(win, 1, 1, 5).map((p) => [p.x, p.y]), [[50, 50]]);
});
