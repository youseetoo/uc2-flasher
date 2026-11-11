// js/flasher/microscope.js
// Server mode (page served by server/server.py on the microscope): the board is on the
// server's USB port. Flashing goes through esptool on the server; the Microscope tab checks
// every board against the firmware source and updates them (USB master + CAN nodes).

import { api, server, log, isConnected } from './serial.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const STATUS_CLASS = {
  up_to_date: 'text-success', done: 'text-success', success: 'text-success',
  update_available: 'text-warning', running: 'text-warning', warning: 'text-warning',
  failed: 'text-danger', error: 'text-danger', refused: 'text-danger', busy: 'text-danger',
  unreachable: 'text-danger', no_firmware: 'text-danger',
};
const show = (id, res) => {
  const text = res.reasons ? res.reasons.join(' ') : (res.message ?? res.status ?? '');
  $(id).innerHTML = `<span class="${STATUS_CLASS[res.status] ?? ''}">${esc(text)}</span>`;
  return res;
};

export function setMode(useServer) {
  server.use = useServer;
  document.body.classList.toggle('server-mode', useServer);
}

export async function loadPorts() {
  const ports = await api('ports');
  const html = ports.map((p) => `<option value="${esc(p.device)}">${esc(p.device)} — ${esc(p.description)}</option>`).join('');
  for (const id of ['serverPort', 'flashPort']) {
    const keep = $(id).value;
    $(id).innerHTML = html || '<option value="">no serial port</option>';
    if (keep) $(id).value = keep;
  }
}

// ── Firmware source ──────────────────────────────────────────────────────
let files = [];
async function loadSource() {
  const s = await api('source');
  $('mSource').textContent = s.source === 'github'
    ? `GitHub ${s.github_repo} (${s.github_release})` : `${s.firmware_server_url} (firmware pallet)`;
  const res = await api('files');
  files = res.files ?? [];
  $('mFileCount').textContent = res.status === 'success' ? `${files.length}, version ${res.server_version ?? 'unknown'}` : 'unreachable';
  if (res.status !== 'success') show('mSourceMsg', res);
  $('mFiles').innerHTML = files.map((f) => `<tr><td class="font-monospace">${esc(f.filename)}</td><td class="font-monospace">${esc(f.version ?? '–')}</td></tr>`).join('');
  $('mOtaFile').innerHTML = '<option value="">its own image</option>' + files.map((f) => `<option>${esc(f.filename)}</option>`).join('');
}

export async function useSource(release) {
  const res = release ? await api('set_release', { release }) : await api('set_server', {});
  show('mSourceMsg', res);
  await loadSource();
  return res;
}

export function fillReleases(releases) {
  $('mRelease').innerHTML = '<option value="latest">latest GitHub release</option>'
    + releases.map((r) => `<option value="${esc(r.tag_name)}">${esc(r.tag_name)}${r.prerelease ? ' (pre-release)' : ''}</option>`).join('');
}

// ── Flash one board over USB (Flash tab) ─────────────────────────────────
// board: a BOARDS entry with .env; release: a tag, or null = the firmware pallet
export async function flashBoard(board, release) {
  const msg = (m, status) => show('serverFlashMsg', { status, message: m });
  msg(release ? `Firmware from release ${release}…` : 'Firmware from the pallet…');
  const src = await useSource(release);
  if (src.status !== 'success') return msg(src.message, 'error');
  const name = [`esp32_${board.env}_merged.bin`, `esp32_${board.env}.bin`].find((n) => files.some((f) => f.filename === n));
  if (!name) return msg(`esp32_${board.env}[_merged].bin is not on ${$('mSource').textContent}`, 'error');
  const port = $('flashPort').value;
  if (!confirm(`Flash ${name} onto ${port}? Saved settings on the board are reset.`)) return msg('');
  watchFlash = true;
  show('serverFlashMsg', await api('flash', {
    port, firmware_filename: name, erase_flash: $('flashErase').checked,
    chip: board.chip.toLowerCase().replace('-', ''),
  }));
}
let watchFlash = false, onFlashed = () => {};

// ── All boards ───────────────────────────────────────────────────────────
let devices = [];
async function check() {
  $('mCheckMsg').textContent = 'reading the boards…';
  const res = await api('check', { probe_range: $('mProbeRange').checked });
  devices = res.devices ?? [];
  $('mCheckMsg').textContent = res.status !== 'success' ? (res.message ?? 'failed')
    : `${devices.length} board(s), source version ${res.server_version ?? '(no version.json)'}, ${res.updates_available} update(s) available`
      + (res.server_reachable ? '' : ' — firmware source not reachable');
  $('mBoards').innerHTML = devices.map((d, i) => `<tr>
    <td><input type="checkbox" class="form-check-input" data-i="${i}" ${d.update_status === 'update_available' ? 'checked' : ''} aria-label="select"></td>
    <td>${esc(d.connection)}</td><td>${esc(d.canId ?? '–')}</td><td>${esc(d.deviceTypeStr)}</td>
    <td class="font-monospace">${esc(d.installed_version ?? '–')}</td><td class="font-monospace">${esc(d.available_version ?? '–')}</td>
    <td class="${STATUS_CLASS[d.update_status] ?? ''}">${esc(d.update_status)}</td></tr>`).join('');
}

async function update() {
  const picked = [...document.querySelectorAll('#mBoards input:checked')].map((c) => devices[c.dataset.i]);
  if (!picked.length) return show('mUpdateMsg', { status: 'error', message: 'Check boards, then select the ones to update.' });
  const canIds = picked.filter((d) => d.connection === 'can').map((d) => d.canId);
  const master = picked.some((d) => d.connection === 'usb');
  if (!confirm(`Update ${canIds.length} CAN node(s)${master ? ' and the USB master' : ''}? The boards reboot; motors lose their position.`)) return;
  show('mUpdateMsg', await api('update', { can_ids: canIds, include_master: master }));
}

let otaWatch = null;
async function ota() {
  const id = parseInt($('mOtaId').value, 10);
  if (!id) return show('mOtaMsg', { status: 'error', message: 'Enter a node id.' });
  if (!confirm(`Flash node ${id} over CAN?`)) return;
  otaWatch = id;
  show('mOtaMsg', await api('ota', { can_id: id, filename: $('mOtaFile').value || null }));
}

// ── One poll for the jobs and the server log ─────────────────────────────
let logSeq = 0;
async function poll() {
  try {
    const s = await api(`status?since=${logSeq}`);
    if (watchFlash && s.usb.status !== 'idle') {
      if (s.usb.progress >= 0) $('serverFlashBar').style.width = `${s.usb.progress}%`;
      show('serverFlashMsg', s.usb);
      if (['success', 'warning', 'failed', 'error'].includes(s.usb.status)) {
        watchFlash = false;
        if (s.usb.status !== 'failed' && s.usb.status !== 'error') onFlashed();
      }
    }
    const o = otaWatch !== null && s.ota[otaWatch];
    if (o) { $('mOtaBar').style.width = `${o.progress}%`; show('mOtaMsg', o); }
    const u = s.update;
    if (u.state !== 'idle') {
      show('mUpdateMsg', { status: u.state, message: `${u.state}: ${u.message ?? ''}${u.homing_required ? ' — home the motors' : ''}` });
      $('mSteps').innerHTML = (u.steps ?? []).map((st) => `<tr><td>${esc(st.connection)} ${esc(st.canId ?? '')}</td>
        <td class="font-monospace">${esc(st.from_version ?? '–')} → ${esc(st.to_version ?? '?')}</td>
        <td class="${STATUS_CLASS[st.status] ?? ''}">${esc(st.status)}</td><td>${esc(st.message ?? '')}</td></tr>`).join('');
    }
    if (s.log.length) {
      const el = $('serverLog');
      for (const l of s.log) {
        const d = document.createElement('div');
        d.textContent = l.line;
        el.appendChild(d);
      }
      while (el.childElementCount > 800) el.firstElementChild.remove();
      el.scrollTop = el.scrollHeight;
      logSeq = s.log[s.log.length - 1].seq;
    }
  } catch { /* server restarting */ }
  setTimeout(poll, 1000);
}

export async function initMicroscope({ afterFlash }) {
  onFlashed = afterFlash;
  $('mUsePallet').addEventListener('click', () => useSource(null));
  $('mUseRelease').addEventListener('click', () => useSource($('mRelease').value));
  $('mCheck').addEventListener('click', () => (isConnected() ? check() : show('mCheckMsg', { status: 'error', message: 'Connect to the CAN master (HAT) first.' })));
  $('mUpdate').addEventListener('click', update);
  $('mUpdateCancel').addEventListener('click', async () => show('mUpdateMsg', await api('update_cancel')));
  $('mOta').addEventListener('click', ota);
  $('mOtaCancel').addEventListener('click', async () => show('mOtaMsg', await api('ota_cancel')));
  const im = await api('imswitch');
  if (im.reasons.length) {
    $('imswitchWarning').textContent = im.reasons.join(' ');
    $('imswitchWarning').classList.remove('hidden');
  }
  await loadPorts();
  loadSource();
  poll();
  log('Served by the microscope: boards are flashed and tested on its USB ports.', 'info');
}
