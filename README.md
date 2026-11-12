# UC2 flasher

Flash, test and configure UC2 ESP32 boards (CAN master HAT+, CAN satellites, standalone boards).
One page, two ways to reach the board:

| Served by | Board on | How |
|---|---|---|
| GitHub Pages / any static host | this computer | WebSerial (Chrome/Edge): esp-web-tools flashes, esptool-js erases |
| `server/server.py` (Docker, on the microscope) | the microscope's USB | the server holds the port; esptool flashes, uc2rest bridges the serial console |

The page detects the server (`api/rx`) and switches to server mode by itself. Server mode adds:

- **Install** in the Flash tab writes `esp32_<env>[_merged].bin` with esptool on the microscope, from
  the firmware pallet (`firmware-image-server`, default) or a GitHub release.
- **Microscope** tab: firmware source, check every board (USB master + CAN bus scan) against it,
  update the outdated ones (CAN nodes first, master last, each verified by the version it reports),
  CAN streaming OTA of one node.
- The **Test**, **Scan** and **Configure CAN** tabs work unchanged: their JSON lines go through
  `api/serial_send`, the board's output comes back through `api/rx`.
- Erase is hidden (it needs WebSerial); Install has "erase the chip first".

The firmware logic is ImSwitch's `imswitch/imcontrol/model/canbus` (the code behind
`UC2ConfigController`), pulled from GitHub at build time, not copied.

## Run

```bash
docker compose up --build        # http://localhost:8004
```

Without Docker (from an ImSwitch checkout):

```bash
pip install -r server/requirements.txt
CANBUS_DIR=<ImSwitch>/imswitch/imcontrol/model/canbus python server/server.py
```

| Env | Default | |
|---|---|---|
| `FIRMWARE_URL` | `http://host.docker.internal/firmware` | firmware pallet behind Caddy |
| `FIRMWARE_RELEASE` | – | `latest` or a tag: GitHub release instead |
| `IMSWITCH_URL` | `http://host.docker.internal:8001` | when `/imswitch/api/version` answers, connect/update are refused |
| `PORT` | `8004` | |
| `WEB_DIR` | repo root | the page to serve |
| `CANBUS_DIR` | – | canbus package outside Docker |

**Stop ImSwitch first.** A serial port has one owner; ImSwitch holds the HAT's port while it runs.

## Container image

`.github/workflows/docker.yml` runs the JS tests and builds `ghcr.io/youseetoo/uc2-flasher`
(linux/amd64 + arm64) on every push to `main` and on `v*` tags. `IMSWITCH_REF` (build arg, pinned to an ImSwitch commit in the Dockerfile;
workflow input) picks the ImSwitch branch the canbus package comes from. The build vendors
Bootstrap into the image (`server/vendor_assets.py`), so the page works on a microscope without
internet; esp-web-tools stays on the CDN because only WebSerial mode uses it.

## API

`GET` or `POST /api/<name>`, arguments as query parameters or JSON body. Flash, OTA and update
start in the background; `GET /api/status?since=<log seq>` returns their progress and new log
lines. See `API` in `server/server.py`.

## Tests

```bash
node --test tests/flasher.test.mjs
```
