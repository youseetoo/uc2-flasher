// js/flasher/serial.js
// One shared serial connection for the Test, Scan and Configure tabs: WebSerial in this
// browser, or (served by server/server.py) the server's port to a board on the microscope.
// Replies from the firmware are framed as "++\n<json>\n--\n\0"; everything else is log output.

const listeners = new Set();
let port = null, reader = null, writer = null, readLoop = null;
let bridge = null;   // {since, connected, timer} while connected through the server
let showLogs = true;

// ── Flasher server (same origin; absent on GitHub Pages) ─────────────────
export const server = { available: false, use: false };

export async function api(name, body) {
  const r = await fetch(`api/${name}`, body === undefined ? {} :
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

export async function detectServer() {
  try { server.available = 'lines' in (await api('rx?since=999999999')); }
  catch { server.available = false; }
  server.use = server.available;
  return server.available;
}

// ── Frame parser (pure, unit-tested in tests/frame-parser.test.mjs) ──────
export function createFrameParser(onFrame, onLog) {
  let buf = '', inFrame = false, frame = '';
  return (chunk) => {
    buf += chunk.replace(/\0/g, '');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      const t = line.trim();
      if (t === '++') { inFrame = true; frame = ''; continue; }
      if (t === '--' && inFrame) {
        inFrame = false;
        let obj = null;
        try { obj = JSON.parse(frame); } catch { /* keep raw */ }
        onFrame(obj, frame);
        continue;
      }
      if (inFrame) frame += t;
      else if (t) onLog(t);
    }
  };
}

// ── Console ──────────────────────────────────────────────────────────────
export function log(text, type = 'info') {
  const el = document.getElementById('consoleOutput');
  if (!el) return;
  if (type === 'log' && !showLogs) return;
  const line = document.createElement('div');
  line.className = type;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  el.appendChild(line);
  while (el.childElementCount > 800) el.firstElementChild.remove();
  el.scrollTop = el.scrollHeight;
}
export function clearConsole() {
  const el = document.getElementById('consoleOutput');
  if (el) el.innerHTML = '';
}
export function setShowLogs(v) { showLogs = v; }

// ── Connection ───────────────────────────────────────────────────────────
export const isConnected = () => !!writer || !!bridge?.connected;
export function onFrame(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function frameParser() {
  return createFrameParser(
    (obj, raw) => {
      log(raw, obj ? 'success' : 'warning');
      if (obj) listeners.forEach((fn) => { try { fn(obj); } catch (e) { console.error(e); } });
    },
    (line) => log(line, 'log'),
  );
}

// port: the server's serial port (server mode only)
export async function connect(baudRate, serverPort) {
  if (server.use) return connectServer(baudRate, serverPort);
  if (!('serial' in navigator)) throw new Error('WebSerial not supported – use Chrome, Edge or Opera');
  port = await navigator.serial.requestPort();
  await port.open({ baudRate, bufferSize: 8192 });
  const decoder = new TextDecoderStream();
  port.readable.pipeTo(decoder.writable).catch(() => {});
  reader = decoder.readable.getReader();
  const encoder = new TextEncoderStream();
  encoder.readable.pipeTo(port.writable).catch(() => {});
  writer = encoder.writable.getWriter();

  const parse = frameParser();
  readLoop = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) parse(value);
      }
    } catch (e) {
      if (e.name !== 'NetworkError') log(`Read error: ${e.message}`, 'error');
    }
  })();
  updateStatus();
  log(`Connected at ${baudRate} baud. Opening the port usually resets the board – wait ~2 s.`, 'info');
}

async function connectServer(baudRate, serverPort, force = false) {
  if (!serverPort) throw new Error('Pick the board\'s serial port on the microscope');
  log(`Connecting to ${serverPort} on the microscope…`, 'info');
  const res = await api('connect', { port: serverPort, baud: baudRate, force });
  if (res.status === 'refused') {
    if (confirm(`${res.reasons.join('\n')}\n\nConnect anyway?`)) return connectServer(baudRate, serverPort, true);
    throw new Error(res.reasons.join(' '));
  }
  if (res.status !== 'success') throw new Error(res.message || 'connect failed');
  const parse = frameParser();
  bridge = { since: 0, connected: true, timer: null };
  const tick = async () => {
    if (!bridge) return;
    try {
      const r = await api(`rx?since=${bridge.since}`);
      for (const l of r.lines) parse(`${l.line}\n`);
      if (r.lines.length) bridge.since = r.lines[r.lines.length - 1].seq;
      if (bridge.connected !== r.connected) { bridge.connected = r.connected; updateStatus(); }
    } catch { /* server restarting */ }
    if (bridge) bridge.timer = setTimeout(tick, 250);
  };
  tick();
  updateStatus();
  log(`Connected to ${serverPort} on the microscope (${res.pindef || 'board'} ${res.fwVersion || ''}).`, 'info');
}

export async function disconnect() {
  if (bridge) {
    clearTimeout(bridge.timer);
    bridge = null;
    await api('disconnect').catch(() => {});
    updateStatus();
    log('Disconnected', 'info');
    return;
  }
  try { await reader?.cancel(); } catch { /* device gone */ }
  try { await writer?.close(); } catch { /* device gone */ }
  try { await readLoop; } catch { /* ignore */ }
  try { await port?.close(); } catch { /* device gone */ }
  port = reader = writer = readLoop = null;
  updateStatus();
  log('Disconnected', 'info');
}

export async function send(cmd) {
  const line = typeof cmd === 'string' ? cmd.trim() : JSON.stringify(cmd);
  if (!isConnected()) { log('Not connected – click "Connect" first', 'error'); return false; }
  if (line.startsWith('{')) {
    try { JSON.parse(line); } catch (e) { log(`Invalid JSON: ${e.message}`, 'error'); return false; }
  }
  if (bridge) {
    const res = await api('serial_send', { line });
    if (res.status !== 'success') { log(res.message || 'send failed', 'error'); return false; }
  } else await writer.write(line + '\n');
  log(`> ${line}`, 'sent');
  return true;
}

export function updateStatus() {
  const on = isConnected();
  document.querySelectorAll('[data-conn-status]').forEach((el) => {
    el.textContent = on ? 'Connected' : 'Disconnected';
    el.className = `badge ${on ? 'bg-success' : 'bg-secondary'}`;
  });
  document.querySelectorAll('[data-conn-btn]').forEach((el) => {
    el.innerHTML = on ? '<i class="bi bi-plug-fill"></i> Disconnect' : '<i class="bi bi-plug"></i> Connect';
  });
  document.querySelectorAll('[data-needs-conn]').forEach((el) => { el.disabled = !on; });
}
