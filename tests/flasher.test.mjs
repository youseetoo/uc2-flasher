// Run: node --test tests/flasher.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameParser } from '../js/flasher/serial.js';
import { parsePartitionTable } from '../js/flasher/erase.js';
import * as C from '../js/flasher/commands.js';
import * as S from '../js/flasher/scan.js';

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
