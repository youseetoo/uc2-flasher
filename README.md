# UC2 firmware flasher (standalone)

ImSwitch's firmware tools without ImSwitch: a small web page + JSON API in one Docker
container. It runs the same code as ImSwitch's `UC2ConfigController`
(`imswitch/imcontrol/model/canbus`, copied into the image at build time):

- firmware lookup on the firmware pallet (`firmware-image-server`, `http://<pi>/firmware`) or a
  GitHub release of `youseetoo/uc2-esp32`, with sha256 checks against `version.json`
- check all boards (USB master + CAN bus scan) and update the outdated ones: CAN nodes first, the
  master last, each verified by the version it reports after the reboot
- CAN streaming OTA of one node, with its own or a chosen image
- esptool flashing over USB (the HAT, or any other port such as a XIAO), "which image fits?"
- CAN address of a freshly flashed board, node-id reassignment by MAC

## Run

From the ImSwitch repo root:

```bash
docker compose -f docker/uc2-flasher/compose.yml up --build
```

Open `http://<host>:8004`. Without Docker: `python docker/uc2-flasher/server.py` (needs
`pip install -r docker/uc2-flasher/requirements.txt`).

| Env | Default | |
|---|---|---|
| `FIRMWARE_URL` | `http://host.docker.internal/firmware` | firmware pallet behind Caddy |
| `FIRMWARE_RELEASE` | – | `latest` or a tag: use a GitHub release instead |
| `IMSWITCH_URL` | `http://host.docker.internal:8001` | when it answers, connect/update are refused |
| `PORT` | `8004` | |

**Stop ImSwitch first.** A serial port has one owner; ImSwitch holds the HAT's port while it runs.

## API

`GET` or `POST /api/<name>`, arguments as query parameters or JSON body. Flash, OTA and update start
in the background; `GET /api/status?since=<log seq>` returns their progress and new log lines.
Names: `ports connect disconnect info status source set_server set_release releases files check update
update_cancel scan ota ota_many ota_cancel reassign restart flash flash_cancel recommend
send_can_address probe` (see `API` in `server.py`).
