// js/flasher/app.js
// UC2 firmware flasher + tester (index.html): releases, board catalog, flashing, tabs.

import { GITHUB_API, IMSWITCH_API, IMSWITCH_REPO, RAW_BASE, BOARDS, CATEGORIES, state } from './config.js';
import * as serial from './serial.js';
import * as C from './commands.js';
import { eraseFlash } from './erase.js';
import { initHardwareTest } from './hwtest.js';
import { initCan } from './can.js';
import { initScan } from './scan.js';
import * as M from './microscope.js';

const $ = (id) => document.getElementById(id);

// Old board IDs (pre-CANopen release naming, old links) → current IDs
const ID_ALIASES = {
  'can-hat-master-v2': 'uc2-can-master', 'esp32-uc2-v4-can-hybrid': 'uc2-can-standalone-v4',
  'xiao-can-slave-motor': 'uc2-can-slave-motor', 'xiao-can-slave-laser': 'uc2-can-slave-laser',
  'xiao-can-slave-led': 'uc2-can-slave-led', 'xiao-can-slave-illumination': 'uc2-can-slave-led',
  'xiao-can-slave-galvo': 'uc2-can-slave-galvo',
};
const TAB_ALIASES = { hardware: 'test' };
const NATIVE_USB = (b) => b.chip !== 'ESP32';   // XIAO/S3/C3 boards: USB-CDC, baud ignored

// ── Releases ──────────────────────────────────────────────────────────────
async function loadReleases() {
  const sel = $('releaseSelect');
  try {
    const r = await fetch(`${GITHUB_API}/releases?per_page=50`);
    if (!r.ok) throw new Error(`GitHub API ${r.status}${r.status === 403 ? ' (rate limit – try again later)' : ''}`);
    state.releases = (await r.json()).filter((x) => x.assets?.length);
    for (const rel of state.releases) {
      const o = document.createElement('option');
      o.value = rel.tag_name;
      o.textContent = `${rel.tag_name}${rel.prerelease ? '  (pre-release)' : ''} — ${rel.published_at.slice(0, 10)}`;
      sel.appendChild(o);
    }
    if (state.releaseMode !== 'auto' && state.releaseMode !== 'stable') sel.value = state.releaseMode;
  } catch (e) {
    serial.log(`Could not load firmware releases: ${e.message}`, 'error');
    $('releaseError').textContent = `Could not load releases (${e.message}). Static boards still work.`;
    $('releaseError').classList.remove('hidden');
  }
}

async function isAvailable(tag, boardId) {
  const key = `${tag}|${boardId}`;
  if (!(key in state.availability)) {
    state.availability[key] = fetch(`${RAW_BASE}/${tag}/${boardId}-manifest.json`, { method: 'HEAD' })
      .then((r) => r.ok).catch(() => false);
  }
  return state.availability[key];
}

async function resolveTag(boardId) {
  const mode = state.releaseMode;
  if (mode === 'stable') {
    const rel = state.releases.find((r) => !r.prerelease);
    return rel && (await isAvailable(rel.tag_name, boardId)) ? rel.tag_name : null;
  }
  if (mode !== 'auto') return (await isAvailable(mode, boardId)) ? mode : null;
  for (const rel of state.releases.slice(0, 10)) {           // newest first
    if (await isAvailable(rel.tag_name, boardId)) return rel.tag_name;
  }
  return null;
}

// ── ImSwitch OS → firmware release ───────────────────────────────────────
async function loadImSwitchReleases() {
  try {
    const r = await fetch(`${IMSWITCH_API}/releases?per_page=20`);
    if (!r.ok) return;
    state.imswitchReleases = await r.json();
    const sel = $('imswitchSelect');
    for (const rel of state.imswitchReleases) {
      const o = document.createElement('option');
      o.value = rel.tag_name;
      o.textContent = `${rel.tag_name}${rel.prerelease ? ' (pre-release)' : ''}`;
      sel.appendChild(o);
    }
  } catch { /* optional feature */ }
}

// The OS pins ghcr.io/youseetoo/firmware-image-server:<tag>. <tag> is either a release
// tag or sha-<commit>. For a commit, pick the oldest release that contains it.
async function firmwareForImSwitch(osTag) {
  const y = await fetch(`https://raw.githubusercontent.com/${IMSWITCH_REPO}/refs/tags/${osTag}/deployments/firmware.pkg/deployment.compose.yml`);
  if (!y.ok) throw new Error(`deployment file not found (${y.status})`);
  const m = (await y.text()).match(/firmware-image-server:([\w.\-]+)/);
  if (!m) throw new Error('no firmware-image-server image in the deployment file');
  const tag = m[1];
  if (state.releases.some((r) => r.tag_name === tag)) return { tag, note: `pins release ${tag}` };
  const sha = tag.replace(/^sha-/, '');
  const c = await fetch(`${GITHUB_API}/commits/${sha}`);
  if (!c.ok) throw new Error(`commit ${sha} not found`);
  const commitDate = new Date((await c.json()).commit.committer.date);
  const candidates = state.releases.filter((r) => new Date(r.published_at) >= commitDate).reverse();  // oldest first
  for (const rel of candidates.slice(0, 5)) {
    const cmp = await fetch(`${GITHUB_API}/compare/${sha}...${rel.tag_name}`);
    if (cmp.ok && ['ahead', 'identical'].includes((await cmp.json()).status)) {
      return { tag: rel.tag_name, note: `pins firmware commit ${sha}; oldest release containing it: ${rel.tag_name}` };
    }
  }
  return { tag: null, note: `pins firmware commit ${sha}, which is in no release yet` };
}

// ── Boards ────────────────────────────────────────────────────────────────
function renderCategories() {
  const sel = $('boardCategory');
  for (const [k, v] of Object.entries(CATEGORIES)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = v;
    sel.appendChild(o);
  }
}

function renderBoards() {
  const grid = $('boardGrid');
  const q = $('boardSearch').value.trim().toLowerCase();
  grid.innerHTML = '';
  for (const [id, b] of Object.entries(BOARDS)) {
    if (state.category !== 'all' && b.category !== state.category) continue;
    if (q && !`${id} ${b.name} ${b.env ?? ''}`.toLowerCase().includes(q)) continue;
    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = `
      <div class="card board-card h-100 ${state.selectedBoard === id ? 'selected' : ''} ${b.category === 'legacy' ? 'opacity-75' : ''}" data-board="${id}" tabindex="0">
        <div class="card-body text-center p-2">
          <img src="${b.image}" alt="" class="board-img mb-2" onerror="this.src='./IMAGES/placeholder.svg'">
          <h6 class="card-title mb-1 small">${b.name}</h6>
          <span class="badge bg-secondary">${b.chip}</span>
          ${b.node ? `<span class="badge bg-info">node ${b.node}</span>` : ''}
          ${b.category === 'legacy' ? '<span class="badge bg-warning text-dark">legacy</span>' : ''}
        </div>
      </div>`;
    const card = col.firstElementChild;
    card.addEventListener('click', () => selectBoard(id));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectBoard(id); });
    grid.appendChild(col);
  }
  if (!grid.children.length) grid.innerHTML = '<p class="text-muted">No board matches.</p>';
}

async function selectBoard(id) {
  const b = BOARDS[id];
  if (!b) { serial.log(`Unknown board "${id}"`, 'warning'); return; }
  state.selectedBoard = id;
  document.querySelectorAll('.board-card').forEach((c) => c.classList.toggle('selected', c.dataset.board === id));
  $('selectedBoardName').textContent = b.name;
  $('selectedBoardChip').textContent = `${b.chip}${b.env ? ` · ${b.env}` : ''}`;
  $('baudRate').value = String(b.baud ?? 115200);
  showBoardInfo(id, b);
  await updateManifest();
  updateDirectLink();
}

function showBoardInfo(id, b) {
  const usb = NATIVE_USB(b) ? 'native USB (baud ignored)' : `USB-UART, ${b.baud ?? 115200} baud`;
  $('boardInfo').innerHTML = `
    <div class="d-flex gap-3">
      <img src="${b.image}" alt="" style="width:90px;height:90px;object-fit:contain" onerror="this.src='./IMAGES/placeholder.svg'">
      <div>
        <h5 class="mb-1">${b.name}</h5>
        <p class="mb-2">${b.description}</p>
        <table class="table table-sm mb-2 small"><tbody>
          ${b.env ? `<tr><th>Firmware env</th><td><code>${b.env}</code></td></tr>` : ''}
          <tr><th>Chip</th><td>${b.chip}</td></tr>
          <tr><th>Serial</th><td>${usb}</td></tr>
          ${b.node ? `<tr><th>CAN node after flashing</th><td>${b.node}</td></tr>` : ''}
          <tr><th>Source</th><td>${b.source === 'release' ? 'uc2-esp32 release' : 'static image (not versioned)'}</td></tr>
        </tbody></table>
        ${b.category === 'frame' ? '<p class="small mb-1"><i class="bi bi-arrow-right-circle"></i> After flashing, set the node ID in the <a href="#" data-goto="configure">Configure CAN</a> tab (only needed if the default is not the right axis/device).</p>' : ''}
        ${b.docs ? `<a href="${b.docs}" target="_blank" class="small">Documentation <i class="bi bi-box-arrow-up-right"></i></a>` : ''}
      </div>
    </div>`;
  $('boardInfoCard').classList.remove('hidden');
}

async function updateManifest() {
  const id = state.selectedBoard;
  if (!id) return;
  const b = BOARDS[id];
  const btn = $('installButton').querySelector('button[slot="activate"]');
  btn.disabled = true;
  $('firmwareWarning').classList.add('hidden');
  $('resolvedRelease').textContent = 'checking…';

  let url = null, tag = null;
  // Server mode flashes esp32_<env>[_merged].bin with esptool on the microscope
  const serverBtn = $('serverFlashBtn');
  serverBtn.disabled = true;
  if (serial.server.use && state.releaseMode === 'pallet') {
    state.resolvedTag = null;
    $('resolvedRelease').innerHTML = b.env ? '<span class="badge bg-info">firmware pallet</span>'
      : '<span class="badge bg-secondary">not on the pallet (static image)</span>';
    serverBtn.disabled = !b.env;
    return;
  }
  if (b.source === 'static') {
    url = b.manifest;
    $('resolvedRelease').innerHTML = '<span class="badge bg-secondary">static image</span>';
  } else {
    tag = await resolveTag(id);
    if (state.selectedBoard !== id) return;           // user clicked another board meanwhile
    if (tag) {
      url = `${RAW_BASE}/${tag}/${id}-manifest.json`;
      const rel = state.releases.find((r) => r.tag_name === tag);
      $('resolvedRelease').innerHTML = `<code>${tag}</code> ${rel?.prerelease ? '<span class="badge bg-warning text-dark">pre-release</span>' : '<span class="badge bg-success">stable</span>'}`;
    }
  }
  state.resolvedTag = tag;
  if (!url) {
    $('resolvedRelease').textContent = '–';
    $('firmwareWarning').classList.remove('hidden');
    return;
  }
  serverBtn.disabled = !b.env;
  $('installButton').manifest = url;
  $('installButton').setAttribute('manifest', url);
  $('manifestLink').href = url;
  btn.disabled = false;
}

function updateDirectLink() {
  const p = new URLSearchParams();
  if (state.selectedBoard) p.set('firmware', state.selectedBoard);
  if (state.releaseMode !== 'auto') p.set('release', state.releaseMode);
  $('directLink').value = `${location.origin}${location.pathname}?${p}`;
}

// ── Tabs and console ──────────────────────────────────────────────────────
function showTab(name) {
  const btn = $(`${TAB_ALIASES[name] ?? name}-tab`);
  if (btn) bootstrap.Tab.getOrCreateInstance(btn).show();
}

function setupTabs() {
  // One console card, moved into the console slot of the active tab
  document.querySelectorAll('#mainTabs button[data-bs-toggle="tab"]').forEach((btn) => {
    btn.addEventListener('shown.bs.tab', () => {
      const slot = document.querySelector(`${btn.dataset.bsTarget} .console-slot`);
      (slot ?? $('consoleHolder')).appendChild($('consoleCard'));
      const p = new URLSearchParams(location.search);
      p.set('tab', btn.id.replace('-tab', ''));
      history.replaceState(null, '', `?${p}`);
    });
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-goto]');
    if (a) { e.preventDefault(); showTab(a.dataset.goto); }
  });
}

function setupConsole() {
  $('connectBtn').addEventListener('click', async () => {
    try {
      if (serial.isConnected()) await serial.disconnect();
      else await serial.connect(parseInt($('baudRate').value, 10), $('serverPort').value);
    } catch (e) { serial.log(e.message, 'error'); }
  });
  $('connMode').addEventListener('change', async (e) => {
    if (serial.isConnected()) await serial.disconnect();
    M.setMode(e.target.value === 'server');
    updateManifest();
  });
  $('clearConsoleBtn').addEventListener('click', serial.clearConsole);
  $('showLogs').addEventListener('change', (e) => serial.setShowLogs(e.target.checked));
  const sendCustom = () => {
    const v = $('customCommand').value.trim();
    if (v) serial.send(v).then((ok) => { if (ok) $('customCommand').value = ''; });
  };
  $('sendCommandBtn').addEventListener('click', sendCustom);
  $('customCommand').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCustom(); });
  const examples = {
    'Board info': C.stateGet(), 'Positions': C.motorGet(), 'Modules': C.modulesGet(),
    'CAN status': C.canGet(), 'CAN scan': C.canScan(), 'Routing table': C.routeGet(),
    'Move X +1000': C.motorMove(1, 1000), 'LED white': C.ledFill(255, 255, 255),
  };
  const ex = $('commandExamples');
  for (const [label, cmd] of Object.entries(examples)) {
    const o = document.createElement('option');
    o.value = C.toLine(cmd); o.textContent = label;
    ex.appendChild(o);
  }
  ex.addEventListener('change', () => { $('customCommand').value = ex.value; ex.selectedIndex = 0; });
}

// ── Flash tab events ──────────────────────────────────────────────────────
function setupFlash() {
  $('releaseSelect').addEventListener('change', (e) => {
    state.releaseMode = e.target.value;
    $('imswitchSelect').value = '';
    $('imswitchNote').textContent = '';
    updateManifest(); updateDirectLink();
  });
  $('imswitchSelect').addEventListener('change', async (e) => {
    const os = e.target.value;
    $('imswitchNote').textContent = os ? 'resolving…' : '';
    if (!os) return;
    try {
      const { tag, note } = await firmwareForImSwitch(os);
      $('imswitchNote').textContent = `ImSwitch OS ${os} ${note}.`;
      if (tag) { state.releaseMode = tag; $('releaseSelect').value = tag; updateManifest(); updateDirectLink(); }
    } catch (err) { $('imswitchNote').textContent = `Could not resolve: ${err.message}`; }
  });
  $('boardCategory').addEventListener('change', (e) => { state.category = e.target.value; renderBoards(); });
  $('boardSearch').addEventListener('input', renderBoards);
  $('copyLinkBtn').addEventListener('click', () => navigator.clipboard.writeText($('directLink').value));
  $('eraseFlashBtn').addEventListener('click', eraseFlash);

  $('installButton').addEventListener('state-changed', (e) => {
    const s = e.detail?.state;
    if ((s === 'initializing' || s === 'preparing') && serial.isConnected()) serial.disconnect();
    if (s === 'finished') afterFlash();
  });
  $('serverFlashBtn').addEventListener('click', () =>
    M.flashBoard(BOARDS[state.selectedBoard], state.releaseMode === 'pallet' ? null : state.resolvedTag));
}

function afterFlash() {
  serial.log(`✓ Flashed ${state.selectedBoard}${state.resolvedTag ? ` (${state.resolvedTag})` : ''}`, 'success');
  if ($('postFlashTest').checked) {
    showTab(BOARDS[state.selectedBoard]?.category === 'frame' ? 'configure' : 'test');
    $('postFlashBanner').classList.remove('hidden');
  }
}

// Page served by server/server.py: the board is on the microscope's USB port
async function initServerMode(p) {
  if (!(await serial.detectServer())) return;
  document.body.classList.add('server-available');
  M.setMode(true);
  const o = new Option('Firmware pallet on the microscope', 'pallet');
  $('releaseSelect').prepend(o);
  if (!p.has('release')) state.releaseMode = 'pallet';
  $('releaseSelect').value = state.releaseMode === 'pallet' ? 'pallet' : $('releaseSelect').value;
  await M.initMicroscope({ afterFlash });
}

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  const p = new URLSearchParams(location.search);
  await initServerMode(p);
  if (!('serial' in navigator) && !serial.server.available) $('browserWarning').classList.remove('hidden');
  if (p.has('release')) state.releaseMode = p.get('release');
  $('releaseSelect').value = ['auto', 'stable', 'pallet'].includes(state.releaseMode) ? state.releaseMode : 'auto';

  renderCategories();
  setupTabs();
  setupConsole();
  setupFlash();
  initHardwareTest();
  initCan();
  initScan();
  renderBoards();
  serial.updateStatus();
  if (p.has('canid')) $('ownNodeId').value = p.get('canid');
  if (p.has('tab')) showTab(p.get('tab'));

  await loadReleases();
  if (serial.server.available) M.fillReleases(state.releases);
  loadImSwitchReleases();
  const fw = p.get('firmware');
  if (fw) await selectBoard(ID_ALIASES[fw] ?? fw);
  $('loadingReleases').classList.add('hidden');
}

init();
