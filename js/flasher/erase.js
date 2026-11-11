// js/flasher/erase.js
// Erase flash with esptool-js. "Settings only" reads the partition table from the
// device and erases exactly the NVS partition (offsets differ between boards:
// ESP32 0x9000+0x6000, XIAO ESP32-S3 0x9000+0x4000, Waveshare 0x9000+0x5000).

import { isConnected, disconnect } from './serial.js';

const PT_OFFSET = 0x8000;
const ESP_ERASE_REGION = 0xd1;       // supported by the esptool stub loader
const CHUNK = 256 * 1024;

// Erase [offset, offset+size) in chunks. flashBegin() is NOT an erase when the stub
// runs (the stub erases lazily while data is written), so use ERASE_REGION.
async function eraseRegion(loader, offset, size, onProgress) {
  for (let done = 0; done < size; done += CHUNK) {
    const len = Math.min(CHUNK, size - done);
    const data = new Uint8Array(8);
    const dv = new DataView(data.buffer);
    dv.setUint32(0, offset + done, true);
    dv.setUint32(4, len, true);
    await loader.checkCommand('erase region', ESP_ERASE_REGION, data, undefined, 30000);
    onProgress((done + len) / size);
  }
}

// Parse an ESP-IDF partition table (pure; unit-tested)
export function parsePartitionTable(bytes) {
  const parts = [];
  for (let i = 0; i + 32 <= bytes.length; i += 32) {
    if (bytes[i] !== 0xaa || bytes[i + 1] !== 0x50) break;
    const dv = new DataView(bytes.buffer, bytes.byteOffset + i, 32);
    const name = new TextDecoder().decode(bytes.subarray(i + 12, i + 28)).replace(/\0.*$/s, '');
    parts.push({ type: bytes[i + 2], subtype: bytes[i + 3], offset: dv.getUint32(4, true), size: dv.getUint32(8, true), name });
  }
  return parts;
}

function out(msg, type = 'info') {
  const el = document.getElementById('eraseConsole');
  if (!el) return;
  const d = document.createElement('div');
  d.className = type;
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}
function progress(pct, text) {
  document.getElementById('eraseProgressBar').style.width = `${pct}%`;
  document.getElementById('eraseStatus').textContent = text;
}

export async function eraseFlash() {
  const mode = document.querySelector('input[name="eraseType"]:checked').value;
  const btn = document.getElementById('eraseFlashBtn');
  let transport = null;
  btn.disabled = true;
  document.getElementById('eraseProgress').classList.remove('hidden');
  try {
    await window.waitForESPTool(5000).catch(() => { throw new Error('ESPTool.js failed to load – reload the page'); });
    if (isConnected()) { out('Closing the test connection…', 'warning'); await disconnect(); }

    const port = await navigator.serial.requestPort();
    transport = new window.Transport(port, false);
    const loader = new window.ESPLoader({
      transport, baudrate: 115200,
      terminal: { clean() {}, writeLine: (t) => out(t), write: (t) => out(t) },
    });
    progress(15, 'Connecting to the bootloader…');
    await loader.main();          // detects chip, uploads stub (needed for readFlash)

    let offset, size;
    if (mode === 'nvs') {
      progress(30, 'Reading partition table…');
      const pt = parsePartitionTable(await loader.readFlash(PT_OFFSET, 0xc00));
      const nvs = pt.find((p) => p.type === 1 && p.subtype === 2);
      if (!nvs) throw new Error('No NVS partition found in the partition table');
      ({ offset, size } = nvs);
      out(`NVS partition "${nvs.name}" at 0x${offset.toString(16)}, 0x${size.toString(16)} bytes`);
    } else {
      offset = 0;
      try { size = (await loader.getFlashSize()) * 1024; } catch { size = 8 * 1024 * 1024; out('Flash size unknown, assuming 8 MB', 'warning'); }
      out(`Erasing all ${size / 1048576} MB (30–120 s)…`, 'warning');
    }

    const t0 = Date.now();
    await eraseRegion(loader, offset, size, (f) =>
      progress(40 + Math.round(f * 55), `Erasing… ${Math.round(f * 100)} % (${Math.round((Date.now() - t0) / 1000)} s)`));

    progress(97, 'Resetting…');
    try { await loader.hardReset(); } catch { out('Reset the board manually', 'warning'); }
    try { await transport.disconnect(); } catch { /* port closed by reset */ }
    transport = null;
    progress(100, 'Done');
    out(mode === 'nvs' ? '✓ Settings erased (node ID, role, positions back to build defaults)' : '✓ Flash erased – flash a firmware next', 'success');
  } catch (e) {
    progress(0, 'Failed');
    out(`✗ ${e.message}`, 'error');
    if (transport) { try { await transport.disconnect(); } catch { /* ignore */ } }
  } finally {
    btn.disabled = false;
  }
}
