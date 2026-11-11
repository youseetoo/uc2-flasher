// js/flasher/can.js
// Configure tab: node ID of the connected board, bus scan via a master, remote node IDs, raw SDO.

import { NODE_PRESETS } from './config.js';
import { send, onFrame, log } from './serial.js';
import * as C from './commands.js';

const $ = (id) => document.getElementById(id);

function safe(fn) {
  return (...a) => { try { return fn(...a); } catch (e) { log(e.message, 'error'); } };
}

function renderPresets() {
  const box = $('nodePresets');
  box.innerHTML = '';
  for (const p of NODE_PRESETS) {
    const b = document.createElement('button');
    b.className = 'btn btn-outline-primary btn-sm';
    b.dataset.needsConn = '';
    b.innerHTML = `${p.label} <span class="badge bg-light text-dark">${p.id}</span>`;
    b.addEventListener('click', safe(() => {
      if (p.id === 1 || confirm(`Set the connected board to node ${p.id} (${p.label})?\nOnly do this on a satellite connected via its own USB.`)) send(C.setOwnNodeId(p.id));
    }));
    box.appendChild(b);
  }
}

function renderScan(reply) {
  const tbody = $('scanTable').querySelector('tbody');
  tbody.innerHTML = '';
  const rows = reply.scan || [];
  if (reply.master) rows.unshift({ ...reply.master, deviceTypeStr: 'master', statusStr: 'self' });
  for (const n of rows) {
    const tr = document.createElement('tr');
    const cells = [n.canId, n.deviceTypeStr ?? n.deviceType, n.statusStr ?? n.status, n.fwVersion ?? '', n.fwImage ?? '', n.mac ?? ''];
    cells.forEach((v) => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
    const td = document.createElement('td');
    if (n.deviceTypeStr !== 'master') {
      const re = document.createElement('button');
      re.className = 'btn btn-outline-secondary btn-sm me-1';
      re.textContent = 'Reboot';
      re.addEventListener('click', safe(() => send(C.rebootNode(n.canId))));
      const id = document.createElement('button');
      id.className = 'btn btn-outline-primary btn-sm';
      id.textContent = 'Change ID';
      id.addEventListener('click', safe(() => {
        const v = prompt(`New node ID for node ${n.canId} (1–127):`);
        if (v) send(C.setRemoteNodeId(n.canId, parseInt(v, 10)));
      }));
      td.append(re, id);
    }
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  $('scanCount').textContent = `${rows.length} node(s)`;
}

function renderRoutes(routes) {
  const tbody = $('routeTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const r of routes) {
    const tr = document.createElement('tr');
    [r.type, r.id, r.where, r.nodeId ?? '', r.subAxis ?? ''].forEach((v) => {
      const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
    });
    const td = document.createElement('td');
    if (r.saved) td.innerHTML = '<span class="badge bg-info">saved</span>';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

export function initCan() {
  renderPresets();

  $('canRead').addEventListener('click', () => { send(C.canGet()); send(C.stateGet()); });
  $('setOwnNodeBtn').addEventListener('click', safe(() => send(C.setOwnNodeId(parseInt($('ownNodeId').value, 10)))));
  $('scanBtn').addEventListener('click', () => send(C.canScan($('probeRange').checked)));
  $('remoteIdBtn').addEventListener('click', safe(() =>
    send(C.setRemoteNodeId(parseInt($('remoteTarget').value, 10), parseInt($('remoteNew').value, 10)))));
  $('routeBtn').addEventListener('click', () => send(C.routeGet()));
  $('rtSetBtn').addEventListener('click', safe(() => send(C.routeSet(
    $('rtType').value, parseInt($('rtId').value, 10), $('rtWhere').value,
    parseInt($('rtNode').value, 10), parseInt($('rtSub').value, 10), $('rtPersist').checked))));
  $('maApplyBtn').addEventListener('click', safe(async () => {
    const cmds = C.multiAxisRoutes(parseInt($('maNode').value, 10),
      parseInt($('maMotorBase').value, 10), parseInt($('maLaserBase').value, 10));
    for (const c of cmds) { await send(c); await new Promise((r) => setTimeout(r, 120)); }
  }));
  $('rtResetBtn').addEventListener('click', () =>
    confirm('Forget all saved routes and restore the build defaults?') && send(C.routeReset()));
  $('roleBtn').addEventListener('click', safe(async () => {
    const role = parseInt($('roleSelect').value, 10);
    const node = role === 2 ? parseInt($('roleNode').value, 10) : (role === 1 ? 1 : undefined);
    const label = ['standalone', 'master', `satellite (node ${node})`][role];
    if (!confirm(`Make the connected board a ${label} and reboot it?`)) return;
    await send(C.setRole(role, node));
    setTimeout(() => send(C.restart()), 400);
  }));
  $('sdoBtn').addEventListener('click', safe(() => {
    const op = $('sdoOp').value;
    send(C.sdo(parseInt($('sdoNode').value, 10), C.parseIndex($('sdoIndex').value),
      parseInt($('sdoSub').value, 10), $('sdoType').value, op, parseInt($('sdoValue').value, 10)));
  }));

  onFrame((m) => {
    if (m.nmtStateStr !== undefined) {   // /can_get
      $('ownInfo').textContent = `node ${m.nodeId} · role ${['standalone', 'master', 'slave'][m.canRole] ?? m.canRole} · ${m.nmtStateStr} · bus ${m.bus?.state ?? '?'}`;
    }
    if (m.state?.pindef) $('ownPindef').textContent = `${m.state.pindef} · ${m.state.identifier_version ?? ''}`;
    if (Array.isArray(m.scan)) renderScan(m);
    if (Array.isArray(m) && (m.length === 0 || m[0].type)) renderRoutes(m);   // /route_get, /route_set
    if (m.msg && /reboot/.test(m.msg)) log(m.msg, 'info');
    if (m.status === 'saved') log(`Node ID ${m.nodeId} saved – the board restarts CANopen with the new ID`, 'success');
  });
}
