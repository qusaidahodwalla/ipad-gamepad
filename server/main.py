"""Companion server: the web app, a WebSocket for several paired devices at once, and the API.

Devices pair once with a 4-digit code shown here, then hold a saved token. The host device may use
keyboard and mouse; controller devices only get their own virtual Xbox pad. Each device has its
own session, so one disconnecting never releases another's inputs.
"""

import asyncio
import json
import os
import secrets
import socket
import sys
import threading
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request, Response, WebSocket
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from devices import CODE_TTL, CONTROLLER, HOST, DeviceError, DeviceStore, PairingCode
from gamepad import BUTTON_NAMES, INSTALL_HINT
from injector import Injector
from keymap import KEY_NAMES
from paths import data_dir, migrate, resource_root
from appsettings import AppSettings
from pads import NO_SLOTS, PadManager
from profiles import ProfileError, Profiles, validate_for_role, validate_profile
from session import KBM_CONTROLLER_MESSAGE, KBM_HOST_MESSAGE, Session
from smoother import MouseSmoother, measure_loop

PORT = int(os.environ.get("PAD_PORT") or 8000)
HEARTBEAT_TIMEOUT = 1.0  # seconds without any message before a device's inputs are released
PAD_RETRY_S = 3.0  # a controller without a pad retries now and then (a slot may have freed up)
EXPORT_LINK_TTL = 60
ROOT = resource_root()
WEB_DIR = ROOT / "web"
# One JSON file per profile; the paired-devices file. Both live in %APPDATA%\iPadGamepad (shared by
# run.bat and the packaged app). The env vars override them (used by tests, which then skip migration).
if not (os.environ.get("PAD_PROFILES_DIR") and os.environ.get("PAD_DEVICES_FILE")) and not os.environ.get("PAD_NO_MIGRATE"):
    for note in migrate(data_dir()):
        print(f"[data] copied {note} into {data_dir()} (the originals were left in place)")
PROFILES_DIR = Path(os.environ.get("PAD_PROFILES_DIR") or data_dir() / "profiles")
DEVICES_FILE = Path(os.environ.get("PAD_DEVICES_FILE") or data_dir() / "devices.json")

injector = Injector()
smoother = MouseSmoother(injector)  # only the host moves the mouse
profiles = Profiles(PROFILES_DIR)
devices = DeviceStore(DEVICES_FILE)
pairing = PairingCode()
settings = AppSettings()
KBM = settings.running  # KB/M only: no vgamepad, no ViGEmClient, no virtual pads (fixed until restart)
pads = PadManager(injector.dry_run, kbm_only=KBM)
sessions: dict[str, Session] = {}  # device id -> its live session
exports: dict[str, tuple[str, float]] = {}  # one-time download links: nonce -> (profile id, expiry)
loop: asyncio.AbstractEventLoop | None = None
restart_hook = None  # set by the desktop app: restarts the whole app (the dashboard's Restart button)
real = None  # the dashboard's read-only controller sampler (set by dashboard.setup)
app = FastAPI()


class NoCacheStatic(StaticFiles):
    """Always revalidate so edits show up on the device without clearing the browser cache."""

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


# ---- sending ----

async def push(session: Session, message: dict) -> None:
    try:
        await session.ws.send_text(json.dumps(message))
    except Exception:
        pass  # the socket is going away; its own handler cleans up


def on_rumble(device_id: str, large: int, small: int) -> None:
    """Called from the driver's thread when a game rumbles a device's virtual pad."""
    s = sessions.get(device_id)
    if s is None or loop is None or getattr(s, "last_rumble", None) == (large, small):
        return
    s.last_rumble = (large, small)
    asyncio.run_coroutine_threadsafe(push(s, {"t": "rumble", "l": large, "s": small}), loop)


pads.on_rumble = on_rumble


# ---- pads ----

EXTRA_NOTICE = "Connected, but XInput-only games may not see this controller (slots 1–4 full)."


async def announce_pad(session: Session) -> None:
    """Tell a device it has a pad: its Player number, or that it is an extra pad beyond XInput."""
    did = session.device_id
    await push(session, {"t": "pad", "player": pads.player(did), "extra": pads.is_extra(did)})
    if pads.take_extra_notice(did):
        await push(session, {"t": "n", "msg": EXTRA_NOTICE})


def pad_problem(error: str) -> str:
    if error == NO_SLOTS:
        return NO_SLOTS
    print(f"[xbox] unavailable ({error}). {INSTALL_HINT}")
    return "Controller features unavailable (ViGEmBus missing)"


async def attach_pad(session: Session, quiet: bool = False) -> None:
    """Give the device its virtual pad (or tell it why not). Creation can take a moment: off-loop."""
    if getattr(session, "pad_busy", False):
        return
    if KBM:
        if not quiet:
            await push(session, {"t": "n", "msg": KBM_CONTROLLER_MESSAGE})
        return
    session.pad_busy = True
    try:
        pad, error = await loop.run_in_executor(None, pads.acquire, session.device_id)
    finally:
        session.pad_busy = False
    if pad:
        await announce_pad(session)
    elif not quiet:
        await push(session, {"t": "n", "msg": f"{NO_SLOTS}." if error == NO_SLOTS else pad_problem(error)})


async def handle_mode(session: Session, data: dict) -> None:
    """The device says which joystick output it uses and whether its layout needs a pad."""
    xbox_mode = data.get("m") == "xbox"
    if KBM:  # no pads at all: a host is forced to WASD, a controller is refused
        await push(session, {"t": "pad", "player": None, "extra": False})
        if session.role == CONTROLLER:
            for note in session._notice("kbm", KBM_CONTROLLER_MESSAGE):
                await push(session, note)
        elif xbox_mode:
            await push(session, {"t": "n", "m": "wasd", "msg": KBM_HOST_MESSAGE})
        return
    if session.role == CONTROLLER or xbox_mode or data.get("pad"):
        pad, error = await loop.run_in_executor(None, pads.acquire, session.device_id)
        if pad:
            await announce_pad(session)
            return
        text = pad_problem(error)
        if session.role == HOST and xbox_mode:
            await push(session, {"t": "n", "m": "wasd", "msg": f"{text}. Using WASD."})
        elif error == NO_SLOTS:
            await push(session, {"t": "n", "msg": f"{NO_SLOTS}."})
        else:
            await push(session, {"t": "n", "msg": text})
    else:
        pads.drop(session.device_id)  # keyboard-only host: unplug the pad (as before)
        await push(session, {"t": "pad", "player": None})


# ---- sessions ----

async def watchdog(session: Session) -> None:
    """Release held inputs on heartbeat loss, print msgs/s, and retry a missing controller pad."""
    last_stat = time.monotonic()
    last_retry = last_stat
    while True:
        await asyncio.sleep(0.1)
        now = time.monotonic()
        if session.holding and now - session.last_seen > HEARTBEAT_TIMEOUT:
            session.release_all("heartbeat timeout")
        if session.role == CONTROLLER and session.pad is None and not KBM and now - last_retry >= PAD_RETRY_S:
            last_retry = now
            asyncio.create_task(attach_pad(session, quiet=True))
        if now - last_stat >= 1.0:
            if session.msg_count:
                print(f"[{session.name}] {session.msg_count} msg/s")
            session.msg_count = 0
            last_stat = now


async def open_session(ws: WebSocket, dev: dict, peer: str) -> Session:
    old = sessions.get(dev["id"])
    if old:  # the same device reconnecting: its old socket goes away, nobody else is affected
        old.release_all("replaced by a new connection")
        try:
            await old.ws.close()
        except Exception:
            pass
    session = Session(dev["id"], dev["name"], dev["role"], injector, smoother, pads)
    session.ws = ws
    sessions[dev["id"]] = session
    print(f"[connect] {dev['name']} ({dev['role']}) from {peer}")
    await push(session, {
        "t": "welcome", "id": dev["id"], "name": dev["name"], "role": dev["role"],
        "hostId": devices.host_id(), "defaultProfile": dev["defaultProfilePending"], "kbm": KBM,
    })
    if session.role == CONTROLLER:
        await attach_pad(session)  # a controller's pad exists from the moment it connects
    return session


async def close_session(session: Session) -> None:
    session.release_all("socket closed")
    if sessions.get(session.device_id) is session:  # not already replaced by a reconnect
        del sessions[session.device_id]
        pads.release(session.device_id)  # keep the pad through a short grace period
    print(f"[disconnect] {session.name}")


async def refresh_role(device_id: str) -> None:
    """A device's role changed on the server: release everything and tell it."""
    s = sessions.get(device_id)
    d = devices.get(device_id)
    if not s or not d:
        return
    s.release_all("role changed")
    s.role = d["role"]
    pads.drop(device_id)  # start clean: a controller gets a pad below, a host only when it needs one
    await push(s, {"t": "role", "role": s.role, "hostId": devices.host_id()})
    if s.role == CONTROLLER:
        await attach_pad(s)


async def handshake(ws: WebSocket, data: dict, peer: str) -> Session | None:
    """Before pairing only hello and pair do anything. Everything else from the socket is ignored."""
    t = data.get("t")
    if t == "hello":
        dev = devices.authenticate(data.get("id"), data.get("token"))
        if dev:
            return await open_session(ws, dev, peer)
        code, is_new = pairing.issue()
        if is_new or time.monotonic() - pairing.last_shown > 30:
            pairing.last_shown = time.monotonic()
            print(f"\n[pairing] A new device ({peer}) wants to pair. Enter this code on it: {code}  (valid {CODE_TTL // 60} minutes)\n")
        await ws.send_text('{"t":"auth","state":"unpaired"}')
    elif t == "pair":
        ok, reason, retry = pairing.check(data.get("code"))
        if not ok:
            print(f"[pairing] {peer}: {reason}")
            if pairing.stale():
                # The code was used up or expired (another device just paired): show a fresh one now,
                # so a device that is already waiting doesn't have to reconnect to get it.
                code, _ = pairing.issue()
                print(f"\n[pairing] New code for {peer}: {code}  (valid {CODE_TTL // 60} minutes)\n")
            await ws.send_text(json.dumps({"t": "pair_failed", "reason": reason, "retry": retry}))
            return None
        try:
            token, dev = devices.pair(data.get("id"), data.get("name"))
        except DeviceError as exc:
            await ws.send_text(json.dumps({"t": "pair_failed", "reason": exc.message, "retry": 0}))
            return None
        print(f"[pairing] paired {dev['name']} as {dev['role']}")
        await ws.send_text(json.dumps({"t": "paired", "token": token, "id": dev["id"]}))
        return await open_session(ws, dev, peer)
    return None


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    global loop
    loop = asyncio.get_running_loop()
    await ws.accept()
    peer = ws.client.host if ws.client else "?"
    session: Session | None = None
    watch: asyncio.Task | None = None
    try:
        while True:
            text = await ws.receive_text()
            try:
                data = json.loads(text)
            except ValueError:
                continue
            if not isinstance(data, dict):
                continue
            if session:
                session.touch()
            if data.get("t") == "p":
                # Echo first, before any other work, so latency measures the network only.
                await ws.send_text('{"t":"o","id":%d}' % int(data.get("id", 0)))
                continue
            if session is None:
                session = await handshake(ws, data, peer)
                if session:
                    watch = asyncio.create_task(watchdog(session))
                continue
            if data.get("t") == "mode":
                await handle_mode(session, data)
                continue
            for reply in session.handle(data):
                await ws.send_text(json.dumps(reply))
    except Exception:
        pass  # disconnect or abrupt socket error; cleanup below is the same
    finally:
        if watch:
            watch.cancel()
        if session:
            await close_session(session)


# ---- HTTP API ----

@app.exception_handler(ProfileError)
async def profile_error(_request: Request, exc: ProfileError) -> JSONResponse:
    return JSONResponse({"detail": exc.message}, status_code=exc.status)


@app.exception_handler(DeviceError)
async def device_error(_request: Request, exc: DeviceError) -> JSONResponse:
    return JSONResponse({"detail": exc.message}, status_code=exc.status)


def current_device(request: Request) -> dict:
    """The paired device making this request (id and token headers), or a 401."""
    dev = devices.authenticate(request.headers.get("x-device-id"), request.headers.get("x-device-token"))
    if not dev:
        raise ProfileError(401, "This device is not paired. Pair it with the code shown on the PC.")
    return dev


def require_host(dev: dict, what: str) -> None:
    if dev["role"] != HOST:
        raise ProfileError(403, f"Only the current host can {what}.")


async def _body(request: Request) -> dict:
    try:
        data = await request.json()
    except Exception:
        raise ProfileError(400, "Request body is not valid JSON")
    if not isinstance(data, dict):
        raise ProfileError(400, "Request body must be a JSON object")
    return data


def _checked_for(dev: dict, data: dict) -> dict:
    """Validate a profile body and, for a controller, that it only uses Xbox output."""
    validate_for_role(validate_profile(data), dev["role"])
    return data


@app.get("/api/profiles")
def list_profiles(request: Request) -> dict:
    dev = current_device(request)
    profiles_, problems = profiles.list()
    known = {p["id"] for p in profiles_}
    last = dev["lastProfile"] if dev["lastProfile"] in known else None
    if last is None and dev["role"] == HOST:
        last = profiles.last()  # the host's earlier (pre-multi-device) choice
    return {"profiles": profiles_, "last": last, "problems": problems}


@app.post("/api/profiles")
async def create_profile(request: Request) -> dict:
    dev = current_device(request)
    return profiles.create(_checked_for(dev, await _body(request)))


@app.get("/api/profiles/{pid}")
def get_profile(pid: str, request: Request) -> dict:
    current_device(request)
    return profiles.get(pid)


@app.put("/api/profiles/{pid}")
async def save_profile(pid: str, request: Request) -> dict:
    dev = current_device(request)
    return profiles.save(pid, _checked_for(dev, await _body(request)))


@app.post("/api/profiles/{pid}/rename")
async def rename_profile(pid: str, request: Request) -> dict:
    current_device(request)
    return profiles.rename(pid, (await _body(request)).get("name"))


@app.post("/api/profiles/{pid}/duplicate")
async def duplicate_profile(pid: str, request: Request) -> dict:
    current_device(request)
    return profiles.duplicate(pid, (await _body(request)).get("name"))


@app.delete("/api/profiles/{pid}")
def delete_profile(pid: str, request: Request) -> dict:
    current_device(request)
    profiles.delete(pid)
    return {"ok": True}


@app.post("/api/profiles/{pid}/export-link")
def export_link(pid: str, request: Request) -> dict:
    """A one-time download link (a plain browser download can't send the token header)."""
    current_device(request)
    profiles.export_text(pid)  # 404/400 if it can't be exported
    now = time.monotonic()
    for key in [k for k, (_, exp) in exports.items() if exp < now]:
        del exports[key]
    nonce = secrets.token_urlsafe(16)
    exports[nonce] = (pid, now + EXPORT_LINK_TTL)
    return {"url": f"/api/export/{nonce}"}


@app.get("/api/export/{nonce}")
def export_download(nonce: str) -> Response:
    entry = exports.pop(nonce, None)
    if not entry or entry[1] < time.monotonic():
        raise ProfileError(404, "That download link has expired.")
    pid = entry[0]
    return Response(profiles.export_text(pid), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{pid}.json"'})


@app.get("/api/last-profile")
def get_last_profile(request: Request) -> dict:
    return {"last": current_device(request)["lastProfile"]}


@app.put("/api/last-profile")
async def put_last_profile(request: Request) -> dict:
    dev = current_device(request)
    pid = (await _body(request)).get("id")
    profiles.get(pid)  # must exist
    devices.set_last_profile(dev["id"], pid)
    return {"ok": True}


@app.get("/api/keys")
def api_keys(request: Request) -> dict:
    """Names the editor may bind. Single source of truth: keymap.py and gamepad.py."""
    current_device(request)
    return {"keys": KEY_NAMES, "xbox": BUTTON_NAMES}


@app.get("/api/devices")
def list_devices(request: Request) -> dict:
    dev = current_device(request)
    out = []
    for d in devices.list():
        out.append({
            "id": d["id"], "name": d["name"], "role": d["role"],
            "online": d["id"] in sessions, "player": pads.player(d["id"]), "you": d["id"] == dev["id"],
        })
    return {"devices": out, "hostId": devices.host_id(), "you": dev["id"]}


@app.post("/api/devices/{did}/rename")
async def rename_device(did: str, request: Request) -> dict:
    dev = current_device(request)
    if did != dev["id"]:
        require_host(dev, "rename other devices")
    updated = devices.rename(did, (await _body(request)).get("name"))
    if did in sessions:
        sessions[did].name = updated["name"]
    return {"id": did, "name": updated["name"]}


async def make_host(did: str) -> None:
    """Make this device the host; the old host becomes a controller. Used by the API and the dashboard."""
    old = devices.set_host(did)
    for changed in {did, old}:
        if changed:
            await refresh_role(changed)


async def forget(did: str) -> None:
    """Revoke a device now: token dead, session closed, its pad removed."""
    devices.forget(did)  # the token stops working at once
    s = sessions.get(did)
    if s:
        s.release_all("device forgotten")
        await push(s, {"t": "forgotten"})
        try:
            await s.ws.close()
        except Exception:
            pass
    pads.drop(did)  # its virtual pad goes away immediately


@app.post("/api/devices/{did}/role")
async def set_device_role(did: str, request: Request) -> dict:
    dev = current_device(request)
    require_host(dev, "transfer host or change device roles")
    role = (await _body(request)).get("role")
    if role == HOST:
        await make_host(did)
    elif role == CONTROLLER:
        if devices.host_id() == did:
            raise ProfileError(409, "Make another device the host first; there must be a host.")
    else:
        raise ProfileError(400, "role must be host or controller")
    return {"hostId": devices.host_id()}


@app.post("/api/devices/{did}/forget")
async def forget_device(did: str, request: Request) -> dict:
    dev = current_device(request)
    if did == dev["id"] and dev["role"] == HOST:
        raise ProfileError(409, "The host can't forget itself. Make another device the host first.")
    if did != dev["id"]:
        require_host(dev, "forget other devices")
    await forget(did)
    return {"ok": True}


import dashboard  # noqa: E402  (needs the objects above)

dashboard.setup(app, sys.modules[__name__])
app.mount("/", NoCacheStatic(directory=WEB_DIR, html=True), name="web")


# ---- startup ----

def lan_ip() -> str:
    # UDP connect sends no packet; it just asks the OS which interface routes outward.
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def print_banner() -> None:
    url = f"http://{lan_ip()}:{PORT}"
    print(f"\n  Open on a device: {url}\n")
    try:
        import qrcode

        sys.stdout.reconfigure(encoding="utf-8")
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.print_ascii(invert=True)
    except Exception as exc:  # QR is a convenience; never block startup
        print(f"(QR unavailable: {exc})")
    known = devices.list()
    print(f"\n  Paired devices: {len(known)}" + (f" (host: {next(d['name'] for d in known if d['role'] == HOST)})" if devices.host_id() else ""))
    print("  A device that is not paired yet shows a 4-digit code here when it connects.")
    if injector.dry_run:
        print("\n  DRY RUN: input is logged, not injected.")
    print()


class ServerThread:
    """The web server on a background thread, so a desktop app can own the main thread."""

    def __init__(self):
        self.server: uvicorn.Server | None = None
        self.thread: threading.Thread | None = None
        self.error: str | None = None

    def start(self, timeout: float = 10.0) -> bool:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)  # asyncio also enables it per connection
            sock.bind(("0.0.0.0", PORT))
        except OSError as exc:
            self.error = f"Port {PORT} is not available ({exc}). Is another copy (or run.bat) already running?"
            return False
        smoother.start()
        self.server = uvicorn.Server(uvicorn.Config(app, log_level="warning", ws_ping_interval=None))

        async def serve() -> None:
            global loop
            loop = asyncio.get_running_loop()
            await self.server.serve(sockets=[sock])

        self.thread = threading.Thread(target=lambda: asyncio.run(serve()), name="server", daemon=True)
        self.thread.start()
        end = time.monotonic() + timeout
        while not self.server.started and self.thread.is_alive() and time.monotonic() < end:
            time.sleep(0.05)
        return bool(self.server.started)

    def stop(self) -> None:
        """Release every input, stop serving, remove every virtual pad, stop the smoothing thread."""
        if loop is not None and self.thread and self.thread.is_alive():
            async def release_everything() -> None:
                for s in list(sessions.values()):
                    s.release_all("server stopping")
            try:
                asyncio.run_coroutine_threadsafe(release_everything(), loop).result(2)
            except Exception:
                pass
        if self.server:
            self.server.should_exit = True
        if self.thread:
            self.thread.join(8)
        if real is not None:
            real.stop()
        pads.shutdown()  # unplug every virtual pad we created (also those in a grace period)
        smoother.stop()


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    print_banner()
    hz, worst_ms, timer = measure_loop()
    print(f"[mouse] output loop {hz:.0f} Hz (worst gap {worst_ms:.1f} ms, {timer})")
    runner = ServerThread()
    if not runner.start():
        print(f"[error] {runner.error or 'server did not start'}")
        runner.stop()
        return
    print("  (the desktop dashboard is in the packaged app / app.py; this window is the server only)")
    try:
        while runner.thread.is_alive():
            runner.thread.join(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        runner.stop()


if __name__ == "__main__":
    main()
