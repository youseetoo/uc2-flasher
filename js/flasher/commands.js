// js/flasher/commands.js
// Builders for the UC2 serial JSON commands (firmware uc2-esp32, CANopen generation).
// Reference: https://docs.openuc2.com/dev/sw/interface/reference/serial-commands
// Pure functions: return plain objects, no I/O.

let nextQid = 1;
const qid = () => (nextQid = (nextQid % 9999) + 1);

export const AXES = { A: 0, X: 1, Y: 2, Z: 3 };
// Extra logical axes on a CAN master, e.g. the four axes of a standalone v4 satellite
export const AXES_EXT = { B: 4, C: 5, D: 6, E: 7 };

// ── Motor ────────────────────────────────────────────────────────────────
export function motorMove(stepperid, position, { speed = 20000, acceleration = 0, isabs = 0 } = {}) {
  const s = { stepperid, position, speed, isabs };
  if (acceleration > 0) s.acceleration = acceleration;   // 'accel'/'isaccel' are ignored by the firmware
  return { task: '/motor_act', qid: qid(), motor: { steppers: [s] } };
}
export const motorJog = (stepperid, speed) =>
  ({ task: '/motor_act', motor: { steppers: [{ stepperid, isforever: 1, speed }] } });
export const motorStop = (stepperid) =>
  ({ task: '/motor_act', motor: { steppers: [{ stepperid, isStop: 1 }] } });
export const motorEnable = (on, auto) =>
  (auto === undefined ? { task: '/motor_act', isen: on ? 1 : 0 } : { task: '/motor_act', isen: on ? 1 : 0, isenauto: auto ? 1 : 0 });
export const motorSetPosition = (stepperid, posval) =>
  ({ task: '/motor_act', setpos: { steppers: [{ stepperid, posval }] } });
export const motorGet = () => ({ task: '/motor_get', qid: qid() });

export function home(stepperid, { timeout = 20000, speed = 15000, direction = -1, endstoppolarity = -1, endstoprelease = 0, hardhome = false } = {}) {
  const s = { stepperid, timeout, speed, direction, endstoppolarity };
  if (endstoprelease) s.endstoprelease = endstoprelease;   // only used for CAN axes
  if (hardhome) s.hardhome = 1;                            // must be a number
  return { task: '/home_act', qid: qid(), home: { steppers: [s] } };
}

// ── Laser / LED ──────────────────────────────────────────────────────────
export const laser = (LASERid, LASERval) => ({ task: '/laser_act', qid: qid(), LASERid, LASERval });
export const ledFill = (r, g, b) => ({ task: '/ledarr_act', qid: qid(), led: { action: 'fill', r, g, b } });
export const ledOff = () => ({ task: '/ledarr_act', qid: qid(), led: { action: 'off' } });
export const ledHalves = (region, r, g, b) => ({ task: '/ledarr_act', led: { action: 'halves', region, r, g, b } });
export const ledRings = (radius, r, g, b) => ({ task: '/ledarr_act', led: { action: 'rings', radius, r, g, b } });
export const ledSingle = (ledIndex, r, g, b) => ({ task: '/ledarr_act', led: { action: 'single', ledIndex, r, g, b } });

// ── TMC2209 ──────────────────────────────────────────────────────────────
export function tmcSet(axis, values) {
  const cmd = { task: '/tmc_act', axis };
  for (const k of ['msteps', 'rms_current', 'sgthrs', 'semin', 'semax', 'blank_time', 'toff']) {
    if (Number.isFinite(values[k]) && values[k] > 0) cmd[k] = values[k];   // 0 = keep
  }
  return cmd;
}
export const tmcGet = (axis) => ({ task: '/tmc_get', axis });

// ── State / system ───────────────────────────────────────────────────────
export const stateGet = () => ({ task: '/state_get', qid: qid() });
export const modulesGet = () => ({ task: '/modules_get' });
export const busPower = (on) => ({ task: '/state_act', power: on ? 1 : 0 });
export const restart = () => ({ task: '/state_act', restart: 1 });
export const btScan = () => ({ task: '/bt_scan' });

// ── CAN (CANopen builds) ─────────────────────────────────────────────────
export const canGet = () => ({ task: '/can_get' });
export function canScan(probeRange = false) {
  const c = { task: '/can_act', scan: true, qid: qid() };
  if (probeRange) c.probeRange = true;
  return c;
}
export function setOwnNodeId(nodeId) {
  assertNode(nodeId);
  return { task: '/can_act', nodeId };
}
export function setRemoteNodeId(target, newId) {
  assertNode(target); assertNode(newId);
  return { task: '/can_act', setRemoteNodeId: newId, target };
}
export const rebootNode = (nodeId) => ({ task: '/can_act', restart: nodeId });   // 0 = the board itself
export const routeGet = () => ({ task: '/route_get' });
export const ROUTE_TYPES = ['MOTOR', 'LASER', 'LED', 'GALVO', 'HOME', 'TMC'];
// MOTOR also sets HOME and TMC of that axis (firmware). subAxis = axis/channel on the node.
export function routeSet(type, id, where, nodeId = 0, subAxis = id, persist = false) {
  if (!ROUTE_TYPES.includes(type)) throw new Error(`type must be one of ${ROUTE_TYPES.join(', ')}`);
  if (!Number.isInteger(id) || id < 0 || id > 63) throw new Error('id must be 0–63');
  const c = { task: '/route_set', type, id, where };
  if (where === 'REMOTE') {
    assertNode(nodeId);
    if (!Number.isInteger(subAxis) || subAxis < 0 || subAxis > 3) throw new Error('subAxis must be 0–3');
    c.nodeId = nodeId; c.subAxis = subAxis;
  }
  if (persist) c.persist = 1;
  return c;
}
export const routeReset = () => ({ task: '/route_set', reset: 1 });
// Routes for a multi-axis satellite (standalone v4): motors motorBase..+3 -> axes 0-3,
// lasers laserBase..+2 -> its laser channels 1-3.
export function multiAxisRoutes(nodeId, motorBase = 4, laserBase = 5) {
  const cmds = [];
  for (let k = 0; k < 4; k++) cmds.push(routeSet('MOTOR', motorBase + k, 'REMOTE', nodeId, k, true));
  for (let k = 0; k < 3; k++) cmds.push(routeSet('LASER', laserBase + k, 'REMOTE', nodeId, k + 1, true));
  return cmds;
}

// ── Runtime config (NVS, needs a reboot) ─────────────────────────────────
export const configGet = () => ({ task: '/config_get' });
export function setRole(role, nodeId) {   // 0 standalone, 1 master, 2 satellite
  const c = { task: '/config_set', canRole: role };
  if (nodeId !== undefined) { assertNode(nodeId); c.canNodeId = nodeId; }
  return c;
}

const SDO_TYPES = ['u8', 'u16', 'u32', 'i32'];
export function sdo(node, index, sub, type, op = 'r', value) {
  assertNode(node);
  if (!SDO_TYPES.includes(type)) throw new Error(`type must be one of ${SDO_TYPES.join(', ')}`);
  const s = { node, index, sub, op, type };   // index is sent as a decimal number
  if (op === 'w') s.value = value;
  return { task: '/can_act', sdo: s };
}

function assertNode(n) {
  if (!Number.isInteger(n) || n < 1 || n > 127) throw new Error('CANopen node ID must be 1–127');
}

// Parse "0x2001" or "8193" into a number
export function parseIndex(text) {
  const t = String(text).trim();
  const n = /^0x/i.test(t) ? parseInt(t, 16) : parseInt(t, 10);
  if (!Number.isFinite(n) || n < 0 || n > 0xffff) throw new Error('OD index must be 0x0000–0xFFFF');
  return n;
}

export const toLine = (cmd) => JSON.stringify(cmd);   // compact, single line (pretty JSON is rejected)
