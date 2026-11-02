"""Windows input injection through SendInput (ctypes).

Keyboard uses scancodes (KEYEVENTF_SCANCODE) because many games ignore virtual-key input.
Mouse uses relative movement with a fractional remainder so small deltas are not lost.
Set INPUT_DRY_RUN=1 to log instead of injecting (for testing without moving the real cursor).
"""

import ctypes
import math
import os
from ctypes import wintypes

from keymap import KEYMAP

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
WHEEL_DELTA = 120  # one notch

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008

ULONG_PTR = ctypes.c_size_t


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUTUNION(ctypes.Union):
    # HARDWAREINPUT is included so sizeof(INPUT) matches what SendInput expects.
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


_BUTTON_FLAGS = {
    "l": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    "r": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    "m": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}


class Injector:
    def __init__(self, dry_run: bool | None = None):
        self.dry_run = bool(os.environ.get("INPUT_DRY_RUN")) if dry_run is None else dry_run
        self._rem_x = 0.0
        self._rem_y = 0.0
        self.log: list[tuple] = []  # populated in dry-run mode only
        if not self.dry_run:
            self._send_input = ctypes.windll.user32.SendInput
            self._send_input.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
            self._send_input.restype = wintypes.UINT

    def _send(self, inp: INPUT) -> None:
        if self._send_input(1, ctypes.byref(inp), ctypes.sizeof(INPUT)) != 1:
            raise ctypes.WinError(ctypes.get_last_error())

    def mouse_move(self, dx: float, dy: float) -> None:
        self._rem_x += dx
        self._rem_y += dy
        ix = math.trunc(self._rem_x)
        iy = math.trunc(self._rem_y)
        if ix == 0 and iy == 0:
            return
        self._rem_x -= ix
        self._rem_y -= iy
        if self.dry_run:
            self.log.append(("move", ix, iy))
            return
        inp = INPUT(type=INPUT_MOUSE)
        inp.mi = MOUSEINPUT(ix, iy, 0, MOUSEEVENTF_MOVE, 0, 0)
        self._send(inp)

    def reset_remainder(self) -> None:
        self._rem_x = self._rem_y = 0.0

    def mouse_button(self, button: str, down: bool) -> None:
        flags = _BUTTON_FLAGS[button][0 if down else 1]
        if self.dry_run:
            self.log.append(("button", button, down))
            return
        inp = INPUT(type=INPUT_MOUSE)
        inp.mi = MOUSEINPUT(0, 0, 0, flags, 0, 0)
        self._send(inp)

    def mouse_wheel(self, direction: int) -> None:
        """One notch: direction > 0 scrolls up (away from the user), otherwise down."""
        if self.dry_run:
            self.log.append(("wheel", 1 if direction > 0 else -1))
            return
        delta = WHEEL_DELTA if direction > 0 else -WHEEL_DELTA
        inp = INPUT(type=INPUT_MOUSE)
        inp.mi = MOUSEINPUT(0, 0, delta & 0xFFFFFFFF, MOUSEEVENTF_WHEEL, 0, 0)  # DWORD, two's complement
        self._send(inp)

    def key(self, name: str, down: bool) -> None:
        scan, extended = KEYMAP[name]
        if self.dry_run:
            self.log.append(("key", name, down))
            return
        flags = KEYEVENTF_SCANCODE
        if extended:
            flags |= KEYEVENTF_EXTENDEDKEY
        if not down:
            flags |= KEYEVENTF_KEYUP
        inp = INPUT(type=INPUT_KEYBOARD)
        inp.ki = KEYBDINPUT(0, scan, flags, 0, 0)
        self._send(inp)
