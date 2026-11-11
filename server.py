"""UC2 firmware flasher: ImSwitch's firmware tools without ImSwitch.

Serves index.html and a small JSON API on top of imswitch/imcontrol/model/canbus
(the same code ImSwitch's UC2ConfigController uses): firmware lookup on the
firmware-image-server pallet or a GitHub release, the verified update of all
boards, CAN streaming OTA per node, esptool flashing over USB, CAN ids.

    python server.py            # http://localhost:8004
    PORT=8004 FIRMWARE_URL=http://host.docker.internal/firmware python server.py

API: GET or POST /api/<name>; arguments as query parameters or a JSON body.
Long jobs (flash, ota, update) start in the background; poll /api/status.

Never run this while ImSwitch holds the same serial port (AGENTS.md §6.6).
"""
import collections
import importlib.util
import json
import logging
import os
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import requests
import uc2rest

HERE = Path(__file__).resolve().parent
try:
    import canbus  # copied next to this file in the Docker image
except ImportError:  # running from the ImSwitch repo: load the package by path
    _pkg = HERE.parents[1] / "imswitch" / "imcontrol" / "model" / "canbus"
    _spec = importlib.util.spec_from_file_location("canbus", _pkg / "__init__.py",
                                                   submodule_search_locations=[str(_pkg)])
    canbus = importlib.util.module_from_spec(_spec)
    sys.modules["canbus"] = canbus
    _spec.loader.exec_module(canbus)

FIRMWARE_URL = os.environ.get("FIRMWARE_URL", "http://host.docker.internal/firmware")
FIRMWARE_RELEASE = os.environ.get("FIRMWARE_RELEASE") or None  # "latest" or a tag
IMSWITCH_URL = os.environ.get("IMSWITCH_URL", "http://host.docker.internal:8001")

# ── log ring buffer, shown in the UI ────────────────────────────────────────
LOG = collections.deque(maxlen=1000)
_seq = [0]


class _RingHandler(logging.Handler):
    def emit(self, record):
        _seq[0] += 1
        LOG.append((_seq[0], self.format(record)))


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
_ring = _RingHandler()
_ring.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%H:%M:%S"))
logging.getLogger().addHandler(_ring)
log = logging.getLogger("uc2-flasher")


class Link:
    """Our own serial connection to the USB board (the CAN master), as CanNetwork
    needs it: esptool releases it and restores it after flashing."""

    def __init__(self):
        self.esp, self.port, self.baud = None, None, None
        self._was_connected = False

    def connect(self, port, baud=None):
        self.disconnect()
        kwargs = {"baudrate": int(baud)} if baud else {}
        self.esp = uc2rest.UC2Client(serialport=port, logger=log, **kwargs)
        self.port, self.baud = port, baud
        return bool(self.esp.serial.is_connected)

    def disconnect(self):
        if self.esp is not None:
            try:
                self.esp.serial.closeSerial()
            except Exception as e:
                log.warning(f"Closing {self.port} failed (non-fatal): {e}")
        self.esp = None

    def release(self):
        self._was_connected = self.esp is not None
        self.disconnect()

    def restore(self):
        if self._was_connected:
            self.connect(self.port, self.baud)

    def current_port(self):
        return self.port if self.esp is not None else None

    def info(self) -> dict:
        """Identity of the connected board (ImSwitch's UC2ConfigManager.getFirmwareInfo)."""
        if self.esp is None:
            return {"connected": False}
        info = {}
        try:
            info = self.esp.state.get_firmware_info(timeout=2) or {}
        except Exception as e:
            log.debug(f"get_firmware_info failed: {e}")
        info["connected"] = bool(self.esp.serial.is_connected)
        info["serialport"] = self.port
        return info


link = Link()
net = canbus.CanNetwork(
    client=lambda: link.esp, firmware_url=FIRMWARE_URL, firmware_release=FIRMWARE_RELEASE,
    cache_dir=Path(tempfile.gettempdir()) / "uc2_ota_firmware_cache", link=link,
    hooks=canbus.UpdateHooks(usb_info=link.info, blockers=lambda: imswitch_blockers()),
    logger=log)


def imswitch_blockers() -> list:
    """ImSwitch must not share the serial port with us. Answered = running."""
    if not IMSWITCH_URL:
        return []
    try:
        requests.get(f"{IMSWITCH_URL}/imswitch/api/version", timeout=0.5, verify=False)
    except requests.RequestException:
        return []
    return [f"ImSwitch is running at {IMSWITCH_URL} and may hold the serial port. "
            "Stop it, or use its own firmware page."]


def _background(fn, *args, **kwargs) -> dict:
    """Refuse while the serial port is in use, else run *fn* in a thread."""
    busy = net.guard.busy_reasons()
    if busy or net.updater.state.get("state") == "running":
        return {"status": "busy", "message": (busy or ["A firmware update is running."])[0]}
    threading.Thread(target=fn, args=args, kwargs=kwargs, daemon=True).start()
    return {"status": "started"}


def _not_own_port(port):
    if port and port == link.current_port():
        return {"status": "error", "message": f"{port} is the connected board — disconnect "
                                              "first, or use Check boards / Update."}
    return None


# ── API: name -> handler(**kwargs) ──────────────────────────────────────────

def connect(port, baud=None, force=False):
    reasons = [] if force else imswitch_blockers()
    if reasons:
        return {"status": "refused", "reasons": reasons}
    try:
        ok = link.connect(port, baud)
    except Exception as e:
        link.disconnect()
        return {"status": "error", "message": f"Could not connect to {port}: {e}"}
    if not ok:
        link.disconnect()
        return {"status": "error", "message": f"No UC2 board answered on {port}."}
    return {"status": "success", **link.info()}


def disconnect():
    link.disconnect()
    return {"status": "success"}


def ota(can_id, filename=None):
    """One CAN node, optionally with a chosen image instead of its own."""
    def run():
        if net.guard.claim_can():
            return
        try:
            net.ota.upload(int(can_id), filename=filename or None)
        finally:
            net.guard.can.release()
    return _background(run)


def ota_many(can_ids):
    return _background(net.ota.start_many, [int(i) for i in can_ids])


def flash(port=None, firmware_filename=None, chip="auto", erase_flash=False, baud=921600):
    """esptool over USB. The connected board's link is released and restored;
    any other port is flashed without touching it."""
    own = not port or port == link.current_port()
    return _background(net.usb.flash, port=port or link.current_port(),
                       firmware_filename=firmware_filename or None, chip=chip,
                       erase_flash=bool(erase_flash), baud=int(baud),
                       reconnect_after=own, skip_disconnect=not own)


def recommend(port=""):
    """Which image fits the board on *port* (the connected one: over the link)."""
    if not port or port == link.current_port():
        identity = link.info()
        if not identity.get("connected"):
            return {"status": "error", "message": "No board connected — pick a port to probe."}
        if identity.get("isMaster") and not identity.get("canId"):
            identity["canId"] = 1
        found = {"status": "success", "port": link.port, "identity": identity,
                 "chip": net.usb.detect_chip(link.port)}
    else:
        found = net.usb.identify(port)
        if found.get("status") != "success":
            return found
    return {**found, **net.server.recommend(found["identity"])}


def send_can_address(port, address=1):
    return _not_own_port(port) or net.usb.send_can_address(port, address=int(address))


def probe(port):
    return _not_own_port(port) or net.usb.probe_state(port)


def status(since=0):
    since = int(since)
    return {"link": {"port": link.current_port(), "connected": link.esp is not None},
            "usb": net.usb.status, "ota": dict(net.ota.status), "update": net.updater.state,
            "log": [{"seq": s, "line": line} for s, line in list(LOG) if s > since]}


API = {
    "ports": net.usb.list_ports,
    "connect": connect,
    "disconnect": disconnect,
    "info": link.info,
    "status": status,
    "imswitch": lambda: {"reasons": imswitch_blockers()},
    # firmware source
    "source": net.server.source,
    "set_server": lambda url: net.server.set_url(url),
    "set_release": lambda release="latest", repo=None: net.server.set_release(release, repo),
    "releases": lambda repo=None: net.server.releases(repo),
    "files": net.server.files,
    "clear_cache": net.server.clear_cache,
    # all boards
    "check": lambda probe_range=False: net.updater.check(probe_range=bool(probe_range)),
    "update": lambda can_ids=None, include_master=False: net.updater.start(
        can_ids=[int(i) for i in can_ids] if can_ids is not None else None,
        include_master=bool(include_master)),
    "update_cancel": net.updater.cancel,
    # CAN
    "scan": lambda probe_range=False: net.bus.scan(probe_range=bool(probe_range)),
    "ota": ota,
    "ota_many": ota_many,
    "ota_cancel": net.ota.cancel,
    "reassign": lambda new_id, mac=None, target=None: net.bus.reassign(
        int(new_id), mac=mac, target=int(target) if target not in (None, "") else None),
    "restart": lambda can_id=0: net.bus.restart(int(can_id)) or {"status": "success"},
    # USB
    "flash": flash,
    "flash_cancel": net.usb.cancel_request,
    "recommend": recommend,
    "send_can_address": send_can_address,
    "probe": probe,
}


def _query_value(text):
    """?probe_range=false -> False, ?can_id=11 -> 11, ?port=/dev/ttyACM0 -> the string."""
    try:
        return json.loads(text)
    except ValueError:
        return text


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE / "static"), **kwargs)

    def log_message(self, fmt, *args):  # the UI polls /api/status every second
        pass

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._api()
        return super().do_GET()

    def do_POST(self):
        return self._api() if self.path.startswith("/api/") else self.send_error(404)

    def _api(self):
        url = urlsplit(self.path)
        handler = API.get(url.path[len("/api/"):])
        if handler is None:
            return self._json({"status": "error", "message": f"unknown endpoint {url.path}"}, 404)
        kwargs = {k: _query_value(v) for k, v in parse_qsl(url.query)}
        length = int(self.headers.get("Content-Length") or 0)
        try:
            if length:
                kwargs.update(json.loads(self.rfile.read(length)))
            result = handler(**kwargs)
        except TypeError as e:  # wrong / missing arguments
            return self._json({"status": "error", "message": str(e)}, 400)
        except Exception as e:
            log.exception(f"{url.path} failed")
            return self._json({"status": "error", "message": str(e)}, 500)
        self._json(result)

    def _json(self, payload, code=200):
        body = json.dumps(payload, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8004))
    log.info(f"UC2 flasher on http://0.0.0.0:{port} — firmware from "
             f"{FIRMWARE_RELEASE and f'GitHub release {FIRMWARE_RELEASE}' or FIRMWARE_URL}")
    ThreadingHTTPServer(("", port), Handler).serve_forever()
