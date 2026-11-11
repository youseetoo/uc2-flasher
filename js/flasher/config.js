// js/flasher/config.js
// Board catalog and shared state for the UC2 flasher / tester (index.html).

export const GITHUB_REPO = 'youseetoo/uc2-esp32';
export const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}`;
export const BINARIES_REPO = 'youseetoo/uc2-esp32-binaries';
// One branch per release tag in the binaries repo: <RAW_BASE>/<tag>/<boardId>-manifest.json
export const RAW_BASE = `https://raw.githubusercontent.com/${BINARIES_REPO}/refs/heads`;
export const IMSWITCH_REPO = 'openUC2/rpi-imswitch-os';
export const IMSWITCH_API = `https://api.github.com/repos/${IMSWITCH_REPO}`;
export const DOCS = 'https://docs.openuc2.com/dev/sw/interface';
// Static manifests that live in this site (legacy and third-party firmware)
const STATIC = 'https://youseetoo.github.io/static/firmware_build';   // legacy images live on youseetoo.github.io

export const CATEGORIES = {
  master: 'CAN master',
  frame: 'CAN satellite (FRAME)',
  standalone: 'Standalone',
  qbox: 'qBOX (ODMR)',
  other: 'Other firmware',
  legacy: 'Legacy (unmaintained)',
};

// source: 'release' = built by uc2-esp32 CI, one manifest per release tag
//         'static'  = fixed manifest URL (not versioned)
// baud:   only matters for boards with a USB-UART chip; XIAO/S3 boards use native USB.
// node:   default CANopen node ID after flashing.
export const BOARDS = {
  // ── CAN masters ─────────────────────────────────────────────────────────
  'uc2-can-master': {
    name: 'HAT+ ESP32 (CAN master)', chip: 'ESP32', category: 'master', source: 'release',
    image: './IMAGES/openuc2-HATv1.png', env: 'UC2_canopen_master_release', baud: 921600, node: 1,
    description: 'ESP32 on the Raspberry Pi HAT+ (FRAME). CANopen master: routes serial JSON to the satellites. CAN TX GPIO17 / RX GPIO18.',
    docs: `${DOCS}/reference/boards-and-node-ids`,
  },
  'uc2-can-standalone-v4': {
    name: 'Standalone v4 + CAN (hybrid)', chip: 'ESP32', category: 'master', source: 'release',
    image: './IMAGES/esp32-uc2-v4.png', env: 'UC2_canopen_standalone_v4_release', baud: 115200, node: 1,
    description: 'Standalone board v4 as CAN master: motors A/X/Y/Z and lasers 1–3 local, LED + laser 4 (node 30) and galvo (node 40) on CAN. CAN TX GPIO32 / RX GPIO33.',
    docs: `${DOCS}/reference/boards-and-node-ids`,
  },
  // ── CAN satellites ──────────────────────────────────────────────────────
  'uc2-can-slave-motor': {
    name: 'Motor satellite', chip: 'ESP32-S3', category: 'frame', source: 'release',
    image: './IMAGES/esp32s3-uc2-motor.jpg', env: 'UC2_canopen_slave_motor_release', node: 11,
    description: 'Stepper backpack (XIAO ESP32-S3, TMC2209, FastAccelStepper). Boots as node 11 (X). Set 10/12/13 for A/Y/Z in the Configure tab.',
    docs: `${DOCS}/how-to/add-can-satellite`,
  },
  'uc2-can-slave-accelmotor': {
    name: 'Motor satellite (AccelStepper)', chip: 'ESP32-S3', category: 'frame', source: 'release',
    image: './IMAGES/esp32s3-uc2-motor.jpg', env: 'UC2_canopen_slave_accelmotor_release', node: 11,
    description: 'Same as the motor satellite, AccelStepper back-end. Boots as node 11.',
    docs: `${DOCS}/how-to/add-can-satellite`,
  },
  'uc2-can-slave-laser': {
    name: 'Laser satellite', chip: 'ESP32-S3', category: 'frame', source: 'release',
    image: './IMAGES/esp32-uc2-xiao-can-laser.png', env: 'UC2_canopen_slave_laser_release', node: 20,
    description: 'Laser interface (XIAO ESP32-S3), 4 PWM channels = laser ids 0–3 on the HAT+ master. Node 20.',
    docs: `${DOCS}/reference/boards-and-node-ids`,
  },
  'uc2-can-slave-led': {
    name: 'LED / illumination satellite', chip: 'ESP32-S3', category: 'frame', source: 'release',
    image: './IMAGES/esp32-uc2-xiao-can-ledring.png', env: 'UC2_canopen_slave_led_release', node: 30,
    description: 'LED ring / array + laser channel (laser id 4 on the masters). Node 30.',
    docs: `${DOCS}/reference/boards-and-node-ids`,
  },
  'uc2-can-slave-galvo': {
    name: 'Galvo satellite', chip: 'ESP32-S3', category: 'frame', source: 'release',
    image: './IMAGES/esp32-uc2-xiao-can-galvo.png', env: 'UC2_canopen_slave_galvo_release', node: 40,
    description: 'Galvo interface (XIAO ESP32-S3, MCP4822 DAC). Node 40.',
    docs: `${DOCS}/reference/boards-and-node-ids`,
  },
  'uc2-can-slave-gpio': {
    name: 'GPIO / E-stop satellite', chip: 'ESP32-S3', category: 'frame', source: 'release',
    image: './IMAGES/placeholder.svg', env: 'UC2_canopen_slave_gpio_release', node: 60,
    description: 'E-stop input, collision ADC, 2 digital outputs, I2C bridge. Node 60.',
    docs: `${DOCS}/reference/serial-commands#digital-io`,
  },
  'uc2-can-bridge-ps4-usbhost': {
    name: 'PS4 controller bridge', chip: 'ESP32-S3', category: 'frame', source: 'release',
    image: './IMAGES/placeholder.svg', env: 'UC2_canopen_bridge_ps4_usbhost_release', node: 5,
    description: 'DualShock 4 over USB-OTG → SDO commands to the motor, laser and LED satellites. Node 5.',
    docs: `${DOCS}/reference/boards-and-node-ids`,
  },
  // ── Standalone (no CAN) ─────────────────────────────────────────────────
  'esp32-uc2-standalone-4': {
    name: 'Standalone v4', chip: 'ESP32', category: 'standalone', source: 'release',
    image: './IMAGES/esp32-uc2-v4.png', env: 'UC2_4', baud: 115200,
    description: 'Standalone board v4 without CAN. Motors A/X/Y/Z, lasers 1–4, LED ring.',
    docs: 'https://docs.openuc2.com/dev/hw/electronics/uc2-standalone-board/schematics-v4',
  },
  'esp32-uc2-standalone-3': {
    name: 'Standalone v3', chip: 'ESP32', category: 'standalone', source: 'release',
    image: './IMAGES/esp32-uc2-standalone-3.png', env: 'UC2_3', baud: 115200,
    description: 'Standalone board v3 (TCA9535 port expander).',
    docs: 'https://docs.openuc2.com/dev/hw/electronics/uc2-standalone-board/schematics-v3',
  },
  'esp32-uc2-standalone-2': {
    name: 'Standalone v2', chip: 'ESP32', category: 'standalone', source: 'release',
    image: './IMAGES/esp32-uc2-standalone-2.png', env: 'UC2_2', baud: 115200,
    description: 'Standalone board v2.',
    docs: 'https://docs.openuc2.com/dev/hw/electronics/uc2-standalone-board/schematics-v2',
  },
  'esp32-uc2-wemos': {
    name: 'WEMOS D1 R32 + CNC shield', chip: 'ESP32', category: 'standalone', source: 'release',
    image: './IMAGES/esp32-uc2-wemos.jpg', env: 'UC2_WEMOS', baud: 115200,
    description: 'Off-the-shelf WEMOS D1 R32 with CNC Shield v3.',
  },
  'seeed_xiao_esp32s3': {
    name: 'XIAO ESP32-S3 standalone', chip: 'ESP32-S3', category: 'standalone', source: 'release',
    image: './IMAGES/xiao.jpg', env: 'seeed_xiao_esp32s3',
    description: 'XIAO ESP32-S3 as standalone controller (motor, laser, LED) over USB.',
  },
  'seeed_xiao_esp32s3_ledring': {
    name: 'XIAO LED ring', chip: 'ESP32-S3', category: 'standalone', source: 'release',
    image: './IMAGES/esp32-uc2-ledring.jpg', env: 'seeed_xiao_esp32s3_ledring',
    description: 'XIAO LED ring / brightfield board over USB.',
  },
  'seeed_xiao_esp32s3_ledservo': {
    name: 'XIAO LED & servo', chip: 'ESP32-S3', category: 'standalone', source: 'release',
    image: './IMAGES/ledboard.jpg', env: 'seeed_xiao_esp32s3_ledservo',
    description: 'XIAO LED and servo board over USB.',
  },
  'waveshare_esp32s3_ledarray': {
    name: 'Waveshare ESP32-S3 matrix', chip: 'ESP32-S3', category: 'standalone', source: 'release',
    image: './IMAGES/waveshare.webp', env: 'waveshare_esp32s3_ledarray',
    description: 'Waveshare ESP32-S3 with 8×8 NeoPixel matrix. Gets hot at high brightness.',
  },
  // ── qBOX / other (static manifests in this repo) ────────────────────────
  'odmr-xiao-esp32s3': {
    name: 'ODMR server (XIAO ESP32-S3)', chip: 'ESP32-S3', category: 'qbox', source: 'static',
    manifest: `${STATIC}/odmr-xiao-esp32s3-manifest.json`,
    image: 'https://quantumminilabs.de/wp-content/uploads/2025/01/cropped-Quantumminilabs_Logo.png',
    description: 'qBOX ODMR server firmware.', docs: 'https://docs.openuc2.com/usage/disc/qbox/09_ODMR/',
  },
  'odmr-xiao-esp32c3': {
    name: 'ODMR server (XIAO ESP32-C3)', chip: 'ESP32-C3', category: 'qbox', source: 'static',
    manifest: `${STATIC}/odmr-xiao-esp32c3-manifest.json`,
    image: 'https://quantumminilabs.de/wp-content/uploads/2025/01/cropped-Quantumminilabs_Logo.png',
    description: 'qBOX ODMR server firmware.', docs: 'https://docs.openuc2.com/usage/disc/qbox/09_ODMR/',
  },
  'arkitekt-esp32': {
    name: 'Arkitekt client (ESP32)', chip: 'ESP32', category: 'other', source: 'static',
    manifest: `${STATIC}/arkitekt-esp32-manifest.json`, image: './IMAGES/processor.png',
    description: 'Arkitekt ESP32 client.', docs: 'https://github.com/jhnnsrs/arkitekt-esp32',
  },
  'arkitekt-esp32s3': {
    name: 'Arkitekt client (XIAO ESP32-S3)', chip: 'ESP32-S3', category: 'other', source: 'static',
    manifest: `${STATIC}/arkitekt-esp32s3-manifest.json`, image: './IMAGES/processor.png',
    description: 'Arkitekt ESP32-S3 client.', docs: 'https://github.com/jhnnsrs/arkitekt-esp32',
  },
  'xiao_webcam': {
    name: 'XIAO USB webcam', chip: 'ESP32-S3', category: 'other', source: 'static',
    manifest: `${STATIC}/xiao_webcam-manifest.json`, image: './IMAGES/xiao.jpg',
    description: 'Turns the XIAO ESP32-S3 Sense into a USB webcam.',
    docs: 'https://github.com/openUC2/openUC2_XIAO_Microscope_Webcam',
  },
  // ── Legacy (pre-CANopen, not built any more) ────────────────────────────
  'esp32-uc2-standalone-1': {
    name: 'Standalone v1 (2023)', chip: 'ESP32', category: 'legacy', source: 'static', baud: 115200,
    manifest: `${STATIC}/esp32-uc2-standalone-1-manifest.json`, image: './IMAGES/esp32-uc2-standalone-1.png',
    description: 'Deprecated board, 2023 firmware build. Serial commands may differ from the current reference.',
  },
  'esp32-uc2-standalone-3-beta': {
    name: 'Standalone v3 beta (2024)', chip: 'ESP32', category: 'legacy', source: 'static', baud: 115200,
    manifest: `${STATIC}/esp32-uc2-standalone-3-beta-manifest.json`, image: './IMAGES/esp32-uc2-standalone-3.png',
    description: 'Old 2024 build. Use "Standalone v3" for current firmware.',
  },
  'UC2_3_Xiao_Slave_Motor': {
    name: 'XIAO motor, I2C/old CAN (2024)', chip: 'ESP32-S3', category: 'legacy', source: 'static',
    manifest: `${STATIC}/UC2_3_Xiao_Slave_Motor-manifest.json`, image: './IMAGES/esp32s3-uc2-motor.jpg',
    description: 'Pre-CANopen motor slave. Does not work with current masters — use "Motor satellite".',
  },
  'seeed_xiao_esp32s3_can_slave_illumination': {
    name: 'XIAO illumination, old CAN (2025)', chip: 'ESP32-S3', category: 'legacy', source: 'static',
    manifest: `${STATIC}/seeed_xiao_esp32s3_can_slave_illumination-manifest.json`, image: './IMAGES/esp32-uc2-xiao-can-ledring.png',
    description: 'Pre-CANopen illumination slave. Does not work with current masters — use "LED / illumination satellite".',
  },
};

// CANopen node-ID presets (firmware defaults, see docs: boards-and-node-ids)
export const NODE_PRESETS = [
  { id: 1, label: 'Master' }, { id: 10, label: 'Motor A' }, { id: 11, label: 'Motor X' },
  { id: 12, label: 'Motor Y' }, { id: 13, label: 'Motor Z' }, { id: 20, label: 'Laser' },
  { id: 30, label: 'LED' }, { id: 40, label: 'Galvo' }, { id: 60, label: 'GPIO' },
];

export const state = {
  releases: [],          // GitHub releases with assets, newest first
  imswitchReleases: [],
  releaseMode: 'auto',   // 'auto' | 'stable' | <tag>
  resolvedTag: null,     // tag actually used for the selected board
  selectedBoard: null,
  category: 'all',
  availability: {},      // `${tag}|${board}` -> bool
};
