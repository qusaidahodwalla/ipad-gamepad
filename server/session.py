"""State for one connected, paired device: what it holds, and how to release it.

Every device has its own Session, so a disconnect, release_all or heartbeat timeout only affects
that device. Role rules live here: the host may use keyboard, mouse and Xbox output; a controller
may only send Xbox output (to its own virtual pad), and anything else is dropped with a notice.
"""

import math
import time

from injector import Injector
from keymap import KEYMAP
from pads import PadManager
from smoother import MouseSmoother

HOST = "host"
CONTROLLER = "controller"

# Messages a controller may not send: they would move the real keyboard or mouse.
HOST_ONLY = {"k", "b", "w", "m", "mu", "smooth"}
KBM_HOST_MESSAGE = "Disabled in KB/M only mode"
KBM_CONTROLLER_MESSAGE = "PC is in KB/M only mode — controllers unavailable"
DENY_MESSAGE = "This device is a controller: keyboard and mouse input is blocked. Use Xbox buttons and the right stick."
NOTICE_EVERY_S = 5.0


def _num(v, lo=0.0, hi=100000.0):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return round(min(hi, max(lo, v)), 1) if math.isfinite(v) else None


def clean_stats(data: dict) -> dict:
    """Keep only the known report fields, bounded. Nothing in here ever reaches an input."""
    text = lambda v: v[:40] if isinstance(v, str) else None
    return {
        "ping": _num(data.get("ping")), "avg": _num(data.get("avg")), "jitter": _num(data.get("jitter")),
        "profile": text(data.get("profile")), "mode": data.get("mode") if data.get("mode") in ("wasd", "xbox") else None,
        "sprint": bool(data.get("sprint")), "lock": bool(data.get("lock")),
    }


class Session:
    def __init__(self, device_id: str, name: str, role: str, injector: Injector, smoother: MouseSmoother, pads: PadManager):
        self.device_id = device_id
        self.name = name
        self.role = role
        self.injector = injector
        self.smoother = smoother
        self.pads = pads
        self.ws = None  # set by the endpoint so a newer connection of the same device can close this one
        self.held_keys: set[str] = set()
        self.held_buttons: set[str] = set()
        self.last_seen = time.monotonic()
        self.msg_count = 0  # reset by the stats loop each second
        self._last_notice: dict[str, float] = {}
        self.stats: dict = {}  # last report-only `stats` message from the device (shown on the dashboard)
        self.move_px = 0.0  # running total of mouse movement requested (the dashboard turns it into a rate)

    @property
    def is_host(self) -> bool:
        return self.role == HOST

    @property
    def pad(self):
        return self.pads.get(self.device_id)

    @property
    def holding(self) -> bool:
        pad = self.pad
        return bool(self.held_keys or self.held_buttons or (pad and pad.active))

    def touch(self) -> None:
        self.last_seen = time.monotonic()
        self.msg_count += 1

    def _notice(self, key: str, message: str) -> list[dict]:
        """A notice for the device, at most once every few seconds per kind."""
        now = time.monotonic()
        if now - self._last_notice.get(key, -1e9) < NOTICE_EVERY_S:
            return []
        self._last_notice[key] = now
        return [{"t": "n", "msg": message}]

    def handle(self, data: dict) -> list[dict]:
        """Apply one message (not ping, mode, hello or pair). Returns messages for the client.

        Unknown or malformed messages are ignored.
        """
        t = data.get("t")
        if t in HOST_ONLY and not self.is_host:
            return self._notice("deny", DENY_MESSAGE)
        if t == "stats":
            self.stats = clean_stats(data)  # report only: changes nothing
            return []
        if t == "m":
            x, y = float(data.get("x", 0)), float(data.get("y", 0))
            self.smoother.add(x, y)
            if math.isfinite(x) and math.isfinite(y):
                self.move_px += abs(x) + abs(y)
        elif t == "mu":  # an aiming finger lifted: emit whatever is still buffered right now
            self.smoother.flush()
        elif t == "smooth":
            self.smoother.set_window(data.get("ms", 0))
        elif t == "k":
            name = data.get("k")
            if name not in KEYMAP:
                return []
            if data.get("d"):
                if name not in self.held_keys:
                    self.held_keys.add(name)
                    self.injector.key(name, True)
            elif name in self.held_keys:
                self.held_keys.discard(name)
                self.injector.key(name, False)
        elif t == "b":
            btn = data.get("b")
            if btn not in ("l", "r", "m"):
                return []
            if data.get("d"):
                if btn not in self.held_buttons:
                    self.held_buttons.add(btn)
                    self.injector.mouse_button(btn, True)
            elif btn in self.held_buttons:
                self.held_buttons.discard(btn)
                self.injector.mouse_button(btn, False)
        elif t == "w":
            self.injector.mouse_wheel(1 if float(data.get("d", 1)) > 0 else -1)
        elif t in ("s", "s2", "g"):
            pad = self.pad
            if pad is None and self.pads.kbm_only:
                return self._notice("kbm", KBM_HOST_MESSAGE if self.is_host else KBM_CONTROLLER_MESSAGE)
            if pad is None:
                # The pad could not be created (no free slot, driver missing): say so now and then.
                return self._notice("nopad", "No virtual controller is available for this device.")
            if t == "s":
                pad.set_stick(float(data.get("x", 0)), float(data.get("y", 0)))
            elif t == "s2":
                pad.set_right_stick(float(data.get("x", 0)), float(data.get("y", 0)))
            else:
                name = data.get("b")
                if isinstance(name, str):
                    pad.set_button(name, bool(data.get("d")))
        elif t == "r":
            self.release_all("client request")
        return []

    def release_all(self, reason: str) -> None:
        keys, buttons = sorted(self.held_keys), sorted(self.held_buttons)
        pad = self.pad
        pad_was_active = bool(pad and pad.active)
        for name in keys:
            self.injector.key(name, False)
        for btn in buttons:
            self.injector.mouse_button(btn, False)
        if pad:
            pad.reset()
        self.held_keys.clear()
        self.held_buttons.clear()
        if self.is_host:
            self.smoother.clear()  # buffered aim movement and the sub-pixel remainder
        if keys or buttons or pad_was_active:
            print(f"[release] {self.name}: {reason}: keys={keys} buttons={buttons} pad={pad_was_active}")
