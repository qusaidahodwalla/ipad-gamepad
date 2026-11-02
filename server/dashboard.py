"""Live data for the PC dashboard: one WebSocket (/dash), loopback only.

The page that shows it is served from web/dashboard/ like the rest of the web app, but the data is
not: /dash accepts only a loopback client that sends this launch's random token and a local Origin
(a browser lets any web page open a WebSocket to localhost, so loopback alone is not enough).
Admin actions need the token too. Nothing here sends input anywhere; it only reads state.
"""

import asyncio
import hmac
import json
import os
import secrets
import threading
import time

from fastapi import FastAPI, WebSocket

from devices import HOST, DeviceError
from gamepad import BUTTON_NAMES
from realpads import LABELS, RealControllers

DASH_TOKEN = os.environ.get("PAD_DASH_TOKEN") or secrets.token_urlsafe(24)
FPS = 30
KEEPALIVE_S = 1.0
LOOPBACK = {"127.0.0.1", "::1"}


def local_origin(origin: str | None, port: int) -> bool:
    return origin is None or origin in (f"http://127.0.0.1:{port}", f"http://localhost:{port}")


def pad_state(pad) -> dict:
    """Live state of one of our own virtual pads, straight from the object we write to."""
    held = set(pad.held)
    return {
        "lx": pad.stick[0], "ly": pad.stick[1], "rx": pad.right[0], "ry": pad.right[1],
        "lt": 1.0 if "lt" in held else 0.0, "rt": 1.0 if "rt" in held else 0.0,
        "pressed": sorted(held - {"lt", "rt"}),
    }


def setup(app: FastAPI, ctx) -> None:
    """Register /dash. `ctx` is the server module (sessions, pads, devices, pairing, ...)."""
    real = RealControllers(ctx.pads)
    ctx.real = real
    clients: dict[WebSocket, bool] = {}  # socket -> wants data (window visible)
    refreshed = [0.0]
    rates: dict[str, tuple[float, float, float]] = {}  # device id -> (time, move_px, px/s)

    def refresh_active() -> None:
        real.set_active(any(clients.values()))

    def mouse_rate(did: str, px: float, now: float) -> float:
        t, last_px, rate = rates.get(did, (now, px, 0.0))
        if now - t >= 0.25:
            rate = max(0.0, (px - last_px) / (now - t))
            t, last_px = now, px
        rates[did] = (t, last_px, rate)
        return rate

    def pairing_info() -> dict:
        p = ctx.pairing
        if p.stale():
            return {"code": None, "ttl": 0}
        return {"code": p.code, "ttl": max(0, int(p.expires - p.clock()))}

    def snapshot() -> dict:
        now = time.monotonic()
        if now - refreshed[0] >= 1.0:  # an extra pad may have been given an XInput slot since
            refreshed[0] = now
            ctx.pads.refresh_indexes()
        entries = dict(ctx.pads.entries)
        devs = []
        for d in ctx.devices.list():
            did = d["id"]
            s = ctx.sessions.get(did)
            entry = entries.get(did)
            grace = None
            if entry and not s and entry.grace_until:
                grace = max(0.0, entry.grace_until - now)
            devs.append({
                "id": did, "name": d["name"], "role": d["role"], "online": s is not None,
                "player": entry.index + 1 if entry and entry.index is not None else None, "extra": bool(entry and entry.index is None),
                "hasPad": entry is not None, "grace": grace,
                "stats": s.stats if s else {},
                "keys": sorted(s.held_keys) if s else [], "buttons": sorted(s.held_buttons) if s else [],
                "mouse": round(mouse_rate(did, s.move_px, now), 0) if s else 0,
                "pad": pad_state(entry.pad) if entry else None,
            })
        names = {d["id"]: d["name"] for d in devs}
        pad_list = [{
            "slot": e.index, "player": e.index + 1 if e.index is not None else None, "owner": did, "ownerName": names.get(did, "?"),
            "grace": max(0.0, e.grace_until - now) if e.grace_until else None, "state": pad_state(e.pad),
        } for did, e in sorted(entries.items(), key=lambda kv: (kv[1].index is None, kv[1].index or 0, kv[0]))]
        return {
            "t": "state", "devices": devs, "pads": pad_list, "real": list(real.latest),
            "sdlError": real.sdl_error, "pairing": pairing_info(), "hostId": ctx.devices.host_id(),
            "kbm": ctx.settings.public(ctx.restart_hook is not None),
        }

    async def admin(data: dict) -> dict:
        action, did = data.get("action"), data.get("id")
        try:
            if action == "code":
                code, new = ctx.pairing.issue()
                if new:
                    print(f"[pairing] code requested from the dashboard: {code}")
                return {"ok": True, "msg": "Pairing code ready."}
            if action == "newcode":
                ctx.pairing.code = None
                ctx.pairing.locked_until = 0.0
                code, _ = ctx.pairing.issue()
                print(f"[pairing] new code from the dashboard: {code}  (valid {ctx.CODE_TTL // 60} minutes)")
                return {"ok": True, "msg": "New pairing code."}
            if action == "setkbm":
                ctx.settings.set_kbm_only(bool(data.get("on")))
                return {"ok": True, "msg": "Saved. Restart required." if ctx.settings.restart_required else "Saved."}
            if action == "restart":
                hook = ctx.restart_hook
                if hook is None:
                    return {"ok": False, "msg": "Restart is only available in the desktop app. Restart the server yourself."}
                threading.Thread(target=hook, name="restart", daemon=True).start()  # reply first, then restart
                return {"ok": True, "msg": "Restarting..."}
            if action == "makehost":
                if not ctx.devices.get(did):
                    return {"ok": False, "msg": "Unknown device."}
                await ctx.make_host(did)
                return {"ok": True, "msg": "Host changed."}
            if action == "forget":
                d = ctx.devices.get(did)
                if not d:
                    return {"ok": False, "msg": "Unknown device."}
                if d["role"] == HOST:  # same rule as the Devices dialog on the iPad
                    return {"ok": False, "msg": "The host can't be forgotten. Make another device the host first."}
                await ctx.forget(did)
                return {"ok": True, "msg": f"Forgot {d['name']}."}
        except DeviceError as exc:
            return {"ok": False, "msg": exc.message}
        return {"ok": False, "msg": "Unknown action."}

    @app.websocket("/dash")
    async def dash(ws: WebSocket) -> None:
        token = ws.query_params.get("token", "")
        host = ws.client.host if ws.client else ""
        if host not in LOOPBACK or not local_origin(ws.headers.get("origin"), ctx.PORT) or not hmac.compare_digest(token, DASH_TOKEN):
            await ws.close(code=1008)
            return
        await ws.accept()
        clients[ws] = True
        refresh_active()
        real.start()
        await ws.send_text(json.dumps({
            "t": "hello", "url": f"http://{ctx.lan_ip()}:{ctx.PORT}", "dry": ctx.injector.dry_run,
            "xboxButtons": BUTTON_NAMES, "labels": LABELS["xbox"],
        }))

        async def sender() -> None:
            last, last_at = "", 0.0
            while True:
                if clients.get(ws):
                    text = json.dumps(snapshot(), separators=(",", ":"))
                    now = time.monotonic()
                    if text != last or now - last_at >= KEEPALIVE_S:
                        await ws.send_text(text)
                        last, last_at = text, now
                await asyncio.sleep(1 / FPS)

        task = asyncio.create_task(sender())
        try:
            while True:
                data = json.loads(await ws.receive_text())
                if not isinstance(data, dict):
                    continue
                if data.get("t") == "active":
                    clients[ws] = bool(data.get("on"))
                    refresh_active()
                elif data.get("t") == "admin":
                    if not hmac.compare_digest(str(data.get("token", "")), DASH_TOKEN):
                        await ws.send_text(json.dumps({"t": "result", "ok": False, "msg": "Not allowed."}))
                        continue
                    result = await admin(data)
                    await ws.send_text(json.dumps({"t": "result", **result}))
        except Exception:
            pass  # closed
        finally:
            task.cancel()
            clients.pop(ws, None)
            refresh_active()
