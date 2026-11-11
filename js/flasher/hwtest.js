// js/flasher/hwtest.js
// Test tab: motors, homing, lasers, LED array, TMC, system. All commands come from commands.js.

import { send, onFrame } from './serial.js';
import * as C from './commands.js';

const $ = (id) => document.getElementById(id);
const num = (id, fallback = 0) => { const v = parseInt($(id).value, 10); return Number.isFinite(v) ? v : fallback; };

function rgb() {
  const hex = $('ledColor').value;   // #rrggbb
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

const ALL_AXES = { ...C.AXES, ...C.AXES_EXT };

function motorRows() {
  const tbody = $('motorRows');
  for (const [axis, id] of Object.entries(ALL_AXES)) {
    const tr = document.createElement('tr');
    if (id >= 4) tr.className = 'ext-id d-none';
    tr.innerHTML = `
      <th class="align-middle">${axis} <small class="text-muted">(${id})</small></th>
      <td><input type="number" class="form-control form-control-sm" id="steps${axis}" value="1000" style="max-width:110px"></td>
      <td class="text-nowrap">
        <button class="btn btn-sm btn-outline-success" data-needs-conn data-act="move" data-dir="-1" data-axis="${axis}"><i class="bi bi-dash-lg"></i></button>
        <button class="btn btn-sm btn-outline-success" data-needs-conn data-act="move" data-dir="1" data-axis="${axis}"><i class="bi bi-plus-lg"></i></button>
      </td>
      <td class="text-nowrap">
        <button class="btn btn-sm btn-outline-warning" data-needs-conn data-act="jog" data-dir="-1" data-axis="${axis}">&laquo; jog</button>
        <button class="btn btn-sm btn-outline-warning" data-needs-conn data-act="jog" data-dir="1" data-axis="${axis}">jog &raquo;</button>
      </td>
      <td class="text-nowrap">
        <button class="btn btn-sm btn-danger" data-needs-conn data-act="stop" data-axis="${axis}"><i class="bi bi-stop-fill"></i></button>
        <button class="btn btn-sm btn-outline-secondary" data-needs-conn data-act="home" data-axis="${axis}"><i class="bi bi-house"></i></button>
      </td>
      <td class="font-monospace small" id="pos${axis}">–</td>`;
    tbody.appendChild(tr);
  }
  tbody.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const axis = b.dataset.axis, id = ALL_AXES[axis], dir = parseInt(b.dataset.dir || '1', 10);
    const speed = num('motorSpeed', 20000), acceleration = num('motorAccel', 0);
    if (b.dataset.act === 'move') send(C.motorMove(id, dir * num(`steps${axis}`, 1000), { speed, acceleration }));
    if (b.dataset.act === 'jog') send(C.motorJog(id, dir * Math.abs(num('jogSpeed', 5000))));
    if (b.dataset.act === 'stop') send(C.motorStop(id));
    if (b.dataset.act === 'home') send(C.home(id, {
      timeout: num('homeTimeout', 20000), speed: num('homeSpeed', 15000), direction: num('homeDirection', -1),
      endstoppolarity: num('homePolarity', -1), endstoprelease: num('homeRelease', 0), hardhome: $('homeHard').checked,
    }));
  });
}

function laserRows() {
  const box = $('laserRows');
  for (let id = 0; id <= 7; id++) {
    const row = document.createElement('div');
    row.className = id >= 5 ? 'light-channel-row ext-id d-none' : 'light-channel-row';
    row.innerHTML = `
      <strong style="width:4.5rem">Laser ${id}</strong>
      <input type="range" class="form-range" min="0" max="1023" value="0" id="laserRange${id}" data-needs-conn>
      <input type="number" class="form-control form-control-sm" style="width:90px" min="0" value="0" id="laserVal${id}" data-needs-conn>
      <button class="btn btn-sm btn-outline-danger" data-needs-conn id="laserOff${id}">Off</button>`;
    box.appendChild(row);
    const range = row.querySelector(`#laserRange${id}`), val = row.querySelector(`#laserVal${id}`);
    const set = (v) => { range.value = v; val.value = v; send(C.laser(id, v)); };
    range.addEventListener('change', () => set(parseInt(range.value, 10)));
    val.addEventListener('change', () => set(parseInt(val.value, 10) || 0));
    row.querySelector(`#laserOff${id}`).addEventListener('click', () => set(0));
  }
  $('laserMax').addEventListener('change', () => {
    const max = num('laserMax', 1023);
    document.querySelectorAll('#laserRows input[type=range]').forEach((r) => { r.max = max; });
  });
}

function ledMatrix() {
  const grid = $('ledMatrix');
  for (let i = 0; i < 64; i++) {
    const b = document.createElement('button');
    b.className = 'btn btn-sm btn-outline-secondary';
    b.textContent = i;
    b.dataset.needsConn = '';
    b.addEventListener('click', () => {
      const on = !b.classList.contains('btn-success');
      const [r, g, bl] = on ? rgb() : [0, 0, 0];
      send(C.ledSingle(i, r, g, bl));
      b.classList.toggle('btn-success', on);
      b.classList.toggle('btn-outline-secondary', !on);
    });
    grid.appendChild(b);
  }
}

export function initHardwareTest() {
  motorRows();
  laserRows();
  ledMatrix();
  $('showExtIds').addEventListener('change', (e) =>
    document.querySelectorAll('.ext-id').forEach((el) => el.classList.toggle('d-none', !e.target.checked)));

  // System
  $('btnState').addEventListener('click', () => send(C.stateGet()));
  $('btnModules').addEventListener('click', () => send(C.modulesGet()));
  $('btnMotorGet').addEventListener('click', () => send(C.motorGet()));
  $('btnPowerOn').addEventListener('click', () => send(C.busPower(true)));
  $('btnPowerOff').addEventListener('click', () => send(C.busPower(false)));
  $('btnRestart').addEventListener('click', () => confirm('Reboot the connected board?') && send(C.restart()));
  $('btnBtScan').addEventListener('click', () => send(C.btScan()));
  $('btnEnable').addEventListener('click', () => send(C.motorEnable(true)));
  $('btnDisable').addEventListener('click', () => send(C.motorEnable(false)));
  $('btnAutoEnable').addEventListener('click', () => send(C.motorEnable(true, true)));

  // LED
  $('ledFill').addEventListener('click', () => send(C.ledFill(...rgb())));
  $('ledOff').addEventListener('click', () => send(C.ledOff()));
  document.querySelectorAll('[data-led-half]').forEach((b) =>
    b.addEventListener('click', () => send(C.ledHalves(b.dataset.ledHalf, ...rgb()))));
  $('ledRing').addEventListener('click', () => send(C.ledRings(num('ledRadius', 3), ...rgb())));

  // TMC
  $('tmcSet').addEventListener('click', () => send(C.tmcSet(num('tmcAxis', 1), {
    msteps: num('tmcMsteps'), rms_current: num('tmcRms'), sgthrs: num('tmcSgthrs'),
    semin: num('tmcSemin'), semax: num('tmcSemax'), blank_time: num('tmcBlank'), toff: num('tmcToff'),
  })));
  $('tmcGet').addEventListener('click', () => send(C.tmcGet(num('tmcAxis', 1))));

  // Live positions from motor pushes and /motor_get
  onFrame((m) => {
    const steppers = m.steppers || m.motor?.steppers;
    if (!Array.isArray(steppers)) return;
    for (const s of steppers) {
      const axis = Object.keys(ALL_AXES).find((k) => ALL_AXES[k] === s.stepperid);
      if (axis && s.position !== undefined) $(`pos${axis}`).textContent = `${s.position}${s.isDone === 0 || s.isRunning ? ' …' : ''}`;
    }
  });
}
