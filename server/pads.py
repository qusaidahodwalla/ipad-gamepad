"""Virtual Xbox 360 pads for paired devices: slot checks, lifecycle and rumble.

Rules this module enforces:
  * We only ever create and write our own virtual pads (the PadManager.entries below). Real wired or
    Bluetooth controllers are never opened or changed; XInput is only *read* to count used slots.
  * A pad is created when a device needs one and removed when it is dropped. After a disconnect
    the pad is kept for a short grace period (inputs released), so a quick reconnect keeps it.
  * Before creating a pad, XInput slots 0-3 are polled. A slot counts as used if anything answers
    there (a real controller, one of our pads, another app's virtual pad). With all four used the
    pad is still created (games using SDL / Steam Input / Windows.Gaming.Input can see more than
    four); it just has no XInput slot, and the device is told so. Only if the driver refuses to
    create it is the device told "No controller slots free".
"""

import ctypes
import os
import threading
import time
from ctypes import wintypes

from gamepad import Gamepad

SLOTS = 4
GRACE_S = 10.0
NO_SLOTS = "No controller slots free"
KBM_ONLY = "KB/M only mode"  # acquire() answer while the app runs without virtual pads
INDEX_WAIT_S = 2.0  # how long to wait for the OS to give a new pad its XInput slot


class _XPad(ctypes.Structure):
    _fields_ = [
        ("wButtons", wintypes.WORD),
        ("bLeftTrigger", ctypes.c_ubyte),
        ("bRightTrigger", ctypes.c_ubyte),
        ("sThumbLX", ctypes.c_short),
        ("sThumbLY", ctypes.c_short),
        ("sThumbRX", ctypes.c_short),
        ("sThumbRY", ctypes.c_short),
    ]


class _XState(ctypes.Structure):
    _fields_ = [("dwPacketNumber", wintypes.DWORD), ("Gamepad", _XPad)]


class XInput:
    """Read-only view of the XInput slots. Nothing here opens, writes to or changes a controller."""

    def __init__(self):
        self._get = None
        for name in ("xinput1_4", "xinput1_3", "xinput9_1_0"):
            try:
                get = ctypes.WinDLL(name).XInputGetState
            except (OSError, AttributeError):
                continue
            get.argtypes = (wintypes.DWORD, ctypes.POINTER(_XState))
            get.restype = wintypes.DWORD
            self._get = get
            break

    def read(self, index: int) -> dict | None:
        """The current state of one slot, or None if nothing is connected there."""
        if self._get is None:
            return None
        state = _XState()
        if self._get(index, ctypes.byref(state)) != 0:  # ERROR_SUCCESS means connected
            return None
        g = state.Gamepad
        return {
            "buttons": g.wButtons, "lt": g.bLeftTrigger, "rt": g.bRightTrigger,
            "lx": g.sThumbLX, "ly": g.sThumbLY, "rx": g.sThumbRX, "ry": g.sThumbRY,
        }

    def used_slots(self) -> set[int]:
        return {i for i in range(SLOTS) if self.read(i) is not None}


class PadEntry:
    def __init__(self, device_id: str, pad: Gamepad, index: int):
        self.device_id = device_id
        self.pad = pad
        self.index = index  # XInput user index 0-3, or None for an "extra" pad beyond the four slots
        self.notice_pending = index is None  # the device still has to be told it is an extra pad
        self.timer: threading.Timer | None = None  # grace-period timer while disconnected
        self.grace_until: float | None = None  # monotonic time the pad is removed (dashboard display only)


class PadManager:
    def __init__(self, dry_run: bool, xinput: XInput | None = None, grace: float = GRACE_S, kbm_only: bool = False):
        self.dry_run = dry_run
        self.kbm_only = kbm_only  # never create a pad (and so never import vgamepad or load ViGEmClient)
        self.xinput = None if dry_run else (xinput or XInput())
        self.grace = grace
        self.entries: dict[str, PadEntry] = {}
        # Dry-run only: pretend these XInput slots hold real controllers (tests).
        self.fake_real: set[int] = {int(s) for s in os.environ.get("PAD_FAKE_REAL_SLOTS", "").split(",") if s.strip()}
        self.on_rumble = None  # (device_id, large, small), called from the driver's thread
        self._lock = threading.RLock()  # guards `entries` only; never held while waiting on the OS
        self._create_lock = threading.Lock()  # one pad is created at a time

    # ---- reading ----

    def used_slots(self) -> set[int]:
        if self.dry_run:
            return set(self.fake_real) | {e.index for e in list(self.entries.values()) if e.index is not None}
        return self.xinput.used_slots()

    def get(self, device_id: str) -> Gamepad | None:
        e = self.entries.get(device_id)
        return e.pad if e else None

    def player(self, device_id: str) -> int | None:
        """'Player N' as the OS numbers it (XInput user index + 1)."""
        e = self.entries.get(device_id)
        return e.index + 1 if e and e.index is not None else None

    def is_extra(self, device_id: str) -> bool:
        """The device has a pad, but outside XInput slots 0-3."""
        e = self.entries.get(device_id)
        return bool(e and e.index is None)

    def take_extra_notice(self, device_id: str) -> bool:
        """True once per extra pad: the device should now be told XInput-only games may not see it."""
        e = self.entries.get(device_id)
        if e and e.notice_pending:
            e.notice_pending = False
            return True
        return False

    def refresh_indexes(self) -> None:
        """An extra pad may get an XInput slot later (a real controller left). Ask the driver, read only."""
        if self.dry_run:
            return
        for e in list(self.entries.values()):
            if e.index is None:
                idx = e.pad.user_index()
                if idx is not None and idx not in {o.index for o in list(self.entries.values())}:
                    e.index = idx

    # ---- lifecycle ----

    def acquire(self, device_id: str) -> tuple[Gamepad | None, str | None]:
        """The device's pad, creating it if needed. Returns (pad, None) or (None, reason).

        May take up to INDEX_WAIT_S while the OS assigns the slot; call it off the event loop.
        """
        if self.kbm_only:
            return None, KBM_ONLY
        with self._lock:
            e = self.entries.get(device_id)
            if e:  # still plugged in: a reconnect inside the grace period keeps the same pad
                self._cancel_timer(e)
                return e.pad, None
        with self._create_lock:
            with self._lock:
                e = self.entries.get(device_id)
                if e:
                    self._cancel_timer(e)
                    return e.pad, None
            used = self.used_slots()
            full = len(used) >= SLOTS
            pad = Gamepad(self.dry_run)
            error = pad.ensure()
            if error:
                if full and not error.startswith(("ImportError", "ModuleNotFoundError")):
                    return None, NO_SLOTS  # the driver would not make another one
                return None, error
            index = None if full else self._find_index(pad, used)
            if index is None and not full:
                pad.close()
                return None, NO_SLOTS if len(self.used_slots()) >= SLOTS else "The controller was created but Windows gave it no slot"
            # A new pad can show stale stick values until its first different report (see Gamepad.settle):
            # make sure a game never sees phantom stick drift.
            pad.settle()
            if index is None:
                print(f"[pad] {device_id[:8]}: extra virtual controller (XInput slots 1-4 are full: {sorted(used)})")
            else:
                print(f"[pad] {device_id[:8]}: virtual controller at XInput slot {index} (Player {index + 1}); slots in use before: {sorted(used)}")
            entry = PadEntry(device_id, pad, index)
            pad.rumble_cb = lambda large, small, d=device_id: self.on_rumble and self.on_rumble(d, large, small)
            with self._lock:
                self.entries[device_id] = entry
            return pad, None

    def _find_index(self, pad: Gamepad, used_before: set[int]) -> int | None:
        if self.dry_run:
            return next((i for i in range(SLOTS) if i not in used_before), None)
        deadline = time.monotonic() + INDEX_WAIT_S
        while time.monotonic() < deadline:
            idx = pad.user_index()  # the driver's own answer
            if idx is not None and idx not in used_before:
                return idx
            new = self.xinput.used_slots() - used_before  # or: the slot that just appeared
            if len(new) == 1:
                return next(iter(new))
            time.sleep(0.05)
        return None

    def release(self, device_id: str) -> None:
        """The device disconnected: release its inputs and remove the pad after the grace period."""
        with self._lock:
            e = self.entries.get(device_id)
            if not e:
                return
            e.pad.reset()
            self._cancel_timer(e)
            e.grace_until = time.monotonic() + self.grace
            e.timer = threading.Timer(self.grace, self._expire, (device_id, e))
            e.timer.daemon = True
            e.timer.start()

    def _expire(self, device_id: str, entry: PadEntry) -> None:
        with self._lock:
            if self.entries.get(device_id) is not entry or entry.timer is None:
                return  # it was reattached or already dropped
            self.entries.pop(device_id, None)
        entry.pad.close()

    def drop(self, device_id: str) -> None:
        """Remove the device's pad right now (forgotten device, role change, keyboard-only host)."""
        with self._lock:
            e = self.entries.pop(device_id, None)
        if e:
            self._cancel_timer(e)
            e.pad.close()

    def shutdown(self) -> None:
        for device_id in list(self.entries):
            self.drop(device_id)

    @staticmethod
    def _cancel_timer(entry: PadEntry) -> None:
        if entry.timer is not None:
            entry.timer.cancel()
            entry.timer = None
        entry.grace_until = None
