"""Read-only view of the controllers plugged into this PC (the dashboard's "real controllers").

Hard rules:
  * Nothing here sends output to a controller: no rumble, no LED, no feature reports, no exclusive
    open. XInput is only polled with XInputGetState. Other gamepads are read through SDL2 (pygame-ce)
    with HIDAPI switched off (HIDAPI is the SDL driver that talks to DualShock/DualSense/Switch pads
    and can send them init reports) and background reads allowed (so the game keeps the focus).
  * Our own virtual pads are skipped here (the dashboard shows them from the PadManager instead).

The sampler runs on its own thread and only while the dashboard window is visible, so it can never
add latency to the input path. It publishes the newest list in `latest`.
"""

import ctypes
import os
import threading
import time
from ctypes import wintypes

from pads import SLOTS, XInput

SONY, NINTENDO, MICROSOFT = 0x054C, 0x057E, 0x045E
FAST_S = 1 / 30
SLOW_S = 1.0  # empty XInput slots and hot-plug checks

XINPUT_BUTTONS = {
    0x1000: "a", 0x2000: "b", 0x4000: "x", 0x8000: "y", 0x0100: "lb", 0x0200: "rb",
    0x0040: "l3", 0x0080: "r3", 0x0010: "start", 0x0020: "back",
    0x0001: "dpad_up", 0x0002: "dpad_down", 0x0004: "dpad_left", 0x0008: "dpad_right",
}

# Names shown on the diagram, by controller family (canonical Xbox-style key -> label).
LABELS = {
    "xbox": {"back": "View", "start": "Menu", "guide": "Xbox", "l3": "LS", "r3": "RS"},
    "playstation": {"a": "Cross", "b": "Circle", "x": "Square", "y": "Triangle", "lb": "L1", "rb": "R1",
                    "lt": "L2", "rt": "R2", "back": "Share", "start": "Options", "guide": "PS",
                    "l3": "L3", "r3": "R3"},
    "switch": {"a": "B", "b": "A", "x": "Y", "y": "X", "lb": "L", "rb": "R", "lt": "ZL", "rt": "ZR",
               "back": "-", "start": "+", "guide": "Home", "l3": "LS", "r3": "RS"},
}
LABELS["generic"] = LABELS["xbox"]
FAMILY_NAME = {"xbox": "Xbox", "playstation": "PlayStation", "switch": "Nintendo Switch", "generic": "Generic gamepad"}


def family_of(vid: int, name: str = "") -> str:
    if vid == SONY:
        return "playstation"
    if vid == NINTENDO:
        return "switch"
    if vid == MICROSOFT or "xbox" in name.lower():
        return "xbox"
    return "generic"


# ---- connection type (USB / Bluetooth), from the PnP instance ids of present HID devices ----

class _GUID(ctypes.Structure):
    _fields_ = [("a", wintypes.DWORD), ("b", wintypes.WORD), ("c", wintypes.WORD), ("d", ctypes.c_ubyte * 8)]


class _DevInfo(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("cls", _GUID), ("inst", wintypes.DWORD), ("reserved", ctypes.c_void_p)]


def hid_connections() -> dict[tuple[int, int], str]:
    """(vid, pid) -> "USB" | "Bluetooth" | "unknown" for every present HID device. Read-only."""
    import re

    out: dict[tuple[int, int], set[str]] = {}
    try:
        setupapi = ctypes.WinDLL("setupapi", use_last_error=True)
        setupapi.SetupDiGetClassDevsW.restype = ctypes.c_void_p
        setupapi.SetupDiGetClassDevsW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR, wintypes.HWND, wintypes.DWORD)
        setupapi.SetupDiEnumDeviceInfo.argtypes = (ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_DevInfo))
        setupapi.SetupDiGetDeviceInstanceIdW.argtypes = (ctypes.c_void_p, ctypes.POINTER(_DevInfo), wintypes.LPWSTR, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD))
        setupapi.SetupDiDestroyDeviceInfoList.argtypes = (ctypes.c_void_p,)
        DIGCF_PRESENT, DIGCF_ALLCLASSES = 0x2, 0x4
        h = setupapi.SetupDiGetClassDevsW(None, "HID", None, DIGCF_PRESENT | DIGCF_ALLCLASSES)
        if h in (None, ctypes.c_void_p(-1).value):
            return {}
        try:
            info = _DevInfo()
            info.size = ctypes.sizeof(_DevInfo)
            i = 0
            buf = ctypes.create_unicode_buffer(512)
            while setupapi.SetupDiEnumDeviceInfo(h, i, ctypes.byref(info)):
                i += 1
                if not setupapi.SetupDiGetDeviceInstanceIdW(h, ctypes.byref(info), buf, 512, None):
                    continue
                inst = buf.value.upper()
                usb = re.search(r"VID_([0-9A-F]{4})&PID_([0-9A-F]{4})", inst)
                # Bluetooth HID ids carry a vendor source: HID\{00001124-...}_VID&0002054C_PID&09CC
                bt = re.search(r"VID&[0-9A-F]{4}([0-9A-F]{4})_PID&([0-9A-F]{4})", inst)
                m = usb or bt
                if not m:
                    continue
                vid, pid = int(m.group(1), 16), int(m.group(2), 16)
                bt = bool(bt) and not usb
                out.setdefault((vid, pid), set()).add("Bluetooth" if bt else "USB")
        finally:
            setupapi.SetupDiDestroyDeviceInfoList(h)
    except Exception:
        return {}
    return {k: (next(iter(v)) if len(v) == 1 else "unknown") for k, v in out.items()}


def _norm(v: int, hi: float = 32767.0) -> float:
    return max(-1.0, min(1.0, v / hi))


class RealControllers:
    def __init__(self, pads):
        self.pads = pads  # PadManager: tells us which XInput slots are ours
        self.latest: list[dict] = []
        self.sdl_error: str | None = None
        self._xinput = None if pads.dry_run else XInput()
        self._active = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._sdl = None  # pygame module once initialised (sampler thread only)
        self._pads_open: list[dict] = []
        self._hid: dict[tuple[int, int], str] = {}
        self._hid_at = 0.0
        self._slow_at = 0.0
        self._empty_until = [0.0] * SLOTS

    # ---- lifecycle ----

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="real-controllers", daemon=True)
            self._thread.start()

    def set_active(self, on: bool) -> None:
        (self._active.set if on else self._active.clear)()

    def stop(self) -> None:
        self._stop.set()
        self._active.set()
        if self._thread:
            self._thread.join(3)

    # ---- sampler thread ----

    def _run(self) -> None:
        while not self._stop.is_set():
            if not self._active.wait(0.5):
                continue
            try:
                self.latest = self._sample()
            except Exception as exc:  # never let a flaky driver kill the sampler
                self.sdl_error = self.sdl_error or f"{type(exc).__name__}: {exc}"
            self._stop.wait(FAST_S)
        self._close_sdl()

    def _sample(self) -> list[dict]:
        now = time.monotonic()
        items: list[dict] = []
        entries = list(self.pads.entries.values())
        ours = {e.index for e in entries if e.index is not None}
        ours_extra = sum(1 for e in entries if e.index is None)  # our pads beyond XInput slots 1-4
        if self.pads.dry_run:  # tests: pretend these slots hold real controllers
            for slot in sorted(self.pads.fake_real - ours):
                items.append(self._xinput_item(slot, {"buttons": 0, "lt": 0, "rt": 0, "lx": 0, "ly": 0, "rx": 0, "ry": 0}))
        elif self._xinput is not None:
            for slot in range(SLOTS):
                if slot in ours or now < self._empty_until[slot]:
                    continue
                state = self._xinput.read(slot)
                if state is None:
                    self._empty_until[slot] = now + SLOW_S  # empty slots are slow to poll: ask rarely
                    continue
                items.append(self._xinput_item(slot, state))
        xinput_total = len(ours) + len(items)  # XInput slots in use: ours plus real ones
        items.extend(self._sdl_items(now, xinput_total, ours_extra))
        self._label_duplicates(items)
        return items

    def _xinput_item(self, slot: int, st: dict) -> dict:
        pressed = [name for mask, name in XINPUT_BUTTONS.items() if st["buttons"] & mask]
        return {
            "id": f"xinput{slot}", "api": "XInput", "name": f"Xbox-compatible controller (XInput slot {slot + 1})",
            "family": "xbox", "familyName": FAMILY_NAME["xbox"], "slot": slot, "player": slot + 1,
            "connection": self._xinput_connection(), "mapped": True, "labels": LABELS["xbox"],
            "lx": _norm(st["lx"]), "ly": _norm(st["ly"]), "rx": _norm(st["rx"]), "ry": _norm(st["ry"]),
            "lt": st["lt"] / 255, "rt": st["rt"] / 255, "pressed": pressed,
        }

    def _xinput_connection(self) -> str:
        """Xbox pads: USB/Bluetooth if every Microsoft HID device agrees, else unknown."""
        kinds = {v for (vid, _), v in self._hid.items() if vid == MICROSOFT}
        return next(iter(kinds)) if len(kinds) == 1 else "unknown"

    # ---- SDL (non-XInput gamepads) ----

    def _init_sdl(self) -> bool:
        if self._sdl is not None:
            return True
        if self.sdl_error:
            return False
        # Set before SDL loads: no HIDAPI (the drivers that can send output reports), background reads
        # on, and a dummy video driver (we only need the joystick event pump, never a window).
        os.environ.update({
            "SDL_JOYSTICK_HIDAPI": "0", "SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS": "1",
            "SDL_VIDEODRIVER": "dummy", "PYGAME_HIDE_SUPPORT_PROMPT": "1",
        })
        try:
            import pygame

            pygame.display.init()
            pygame.joystick.init()
            from pygame._sdl2 import controller

            controller.init()
            self._sdl = pygame
            self._controller = controller
        except Exception as exc:
            self.sdl_error = f"Other gamepads can't be listed ({type(exc).__name__}: {exc})"
            return False
        return True

    def _close_sdl(self) -> None:
        if self._sdl is not None:
            try:
                self._pads_open.clear()
                self._sdl.joystick.quit()
                self._sdl.display.quit()
            except Exception:
                pass
            self._sdl = None

    def _sdl_items(self, now: float, xinput_total: int = 0, ours_extra: int = 0) -> list[dict]:
        if not self._init_sdl():
            return []
        pg = self._sdl
        pg.event.pump()
        if now >= self._slow_at:
            self._slow_at = now + SLOW_S
            if pg.joystick.get_count() != len(self._pads_open) or not self._pads_open and pg.joystick.get_count():
                self._reopen()
            if now - self._hid_at > 5:
                self._hid_at = now
                self._hid = hid_connections()
        items = []
        xbox_like = [p for p in self._pads_open if p["skip"]]
        # XInput-class pads (real or virtual) normally show through XInput. Any surplus beyond what
        # XInput reports plus our own extra pads is a real Xbox-style pad outside the four slots.
        surplus = max(0, len(xbox_like) - xinput_total - ours_extra)
        outside = {id(p) for p in xbox_like[len(xbox_like) - surplus:]} if surplus else set()
        for p in self._pads_open:
            if p["skip"] and id(p) not in outside:
                continue
            try:
                item = self._sdl_item(p)
                if id(p) in outside:
                    item["outsideXInput"] = True
                    item["name"] = f"{p['name']} (outside XInput slots)"
                    if ours_extra:  # SDL can't tell our extra pads from these: say so
                        item["ambiguous"] = "Our own extra virtual pads look the same to SDL, so this card may show one of them."
                items.append(item)
            except Exception:
                self._slow_at = 0  # it probably went away: re-list on the next pass
        return items

    def _reopen(self) -> None:
        pg = self._sdl
        self._pads_open = []
        for i in range(pg.joystick.get_count()):
            try:
                js = pg.joystick.Joystick(i)
                guid = js.get_guid()
                name = js.get_name()
                vid = int(guid[10:12] + guid[8:10], 16)
                pid = int(guid[18:20] + guid[16:18], 16)
                mapped = bool(self._controller.is_controller(i))
                ctl = self._controller.Controller(i) if mapped else None
                family = family_of(vid, name)
                # XInput-class pads (real or virtual) are listed through XInput already: skip them here.
                skip = family == "xbox" and mapped
                self._pads_open.append({"js": js, "ctl": ctl, "name": name, "vid": vid, "pid": pid, "family": family,
                                        "mapped": mapped, "skip": skip, "id": f"sdl{i}-{guid[:8]}-{js.get_instance_id()}"})
            except Exception:
                continue

    def _sdl_item(self, p: dict) -> dict:
        pg, family = self._sdl, p["family"]
        conn = self._hid.get((p["vid"], p["pid"]), "unknown")
        item = {
            "id": p["id"], "api": "SDL", "name": p["name"], "family": family, "familyName": FAMILY_NAME[family],
            "connection": conn, "mapped": p["mapped"], "vidpid": f"{p['vid']:04X}:{p['pid']:04X}",
            "labels": dict(LABELS[family]),
        }
        if p["mapped"]:
            c = p["ctl"]
            axis = c.get_axis
            item.update(
                lx=_norm(axis(pg.CONTROLLER_AXIS_LEFTX)), ly=-_norm(axis(pg.CONTROLLER_AXIS_LEFTY)),
                rx=_norm(axis(pg.CONTROLLER_AXIS_RIGHTX)), ry=-_norm(axis(pg.CONTROLLER_AXIS_RIGHTY)),
                lt=max(0.0, _norm(axis(pg.CONTROLLER_AXIS_TRIGGERLEFT))), rt=max(0.0, _norm(axis(pg.CONTROLLER_AXIS_TRIGGERRIGHT))),
            )
            names = {
                "a": pg.CONTROLLER_BUTTON_A, "b": pg.CONTROLLER_BUTTON_B, "x": pg.CONTROLLER_BUTTON_X, "y": pg.CONTROLLER_BUTTON_Y,
                "back": pg.CONTROLLER_BUTTON_BACK, "guide": pg.CONTROLLER_BUTTON_GUIDE, "start": pg.CONTROLLER_BUTTON_START,
                "l3": pg.CONTROLLER_BUTTON_LEFTSTICK, "r3": pg.CONTROLLER_BUTTON_RIGHTSTICK,
                "lb": pg.CONTROLLER_BUTTON_LEFTSHOULDER, "rb": pg.CONTROLLER_BUTTON_RIGHTSHOULDER,
                "dpad_up": pg.CONTROLLER_BUTTON_DPAD_UP, "dpad_down": pg.CONTROLLER_BUTTON_DPAD_DOWN,
                "dpad_left": pg.CONTROLLER_BUTTON_DPAD_LEFT, "dpad_right": pg.CONTROLLER_BUTTON_DPAD_RIGHT,
            }
            item["pressed"] = [n for n, b in names.items() if c.get_button(b)]
            if family == "playstation" and p["pid"] in (0x0CE6, 0x0DF2):
                item["labels"]["back"] = "Create"
        else:  # no known mapping: show what the device reports, by number
            js = p["js"]
            item["rawAxes"] = [round(js.get_axis(i), 2) for i in range(js.get_numaxes())]
            item["rawButtons"] = [i for i in range(js.get_numbuttons()) if js.get_button(i)]
            item["rawButtonCount"] = js.get_numbuttons()
            item["rawHats"] = [list(js.get_hat(i)) for i in range(js.get_numhats())]
        return item

    # ---- duplicates ----

    @staticmethod
    def _label_duplicates(items: list[dict]) -> None:
        """A PlayStation/Switch pad next to an XInput pad is often one pad seen twice (Steam Input,
        DS4Windows and similar emulate Xbox). We can't be sure, so label both and hide neither."""
        non_xbox = [i for i in items if i["family"] in ("playstation", "switch")]
        xin = [i for i in items if i["api"] == "XInput"]
        if non_xbox and xin:
            note = "Possible duplicate: a PlayStation/Switch pad and an Xbox-style pad are both present. One may be an emulation of the other (Steam Input, DS4Windows)."
            for i in (*non_xbox, *xin):
                i["duplicate"] = note
