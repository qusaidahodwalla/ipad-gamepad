"""One virtual Xbox 360 controller via vgamepad (ViGEmBus driver).

Each paired device that needs a pad gets its own Gamepad instance (see pads.py, which decides when
to create and remove them). vgamepad is imported only when a pad is first created, so the driver
and the package stay optional for keyboard-and-mouse use.

Stick convention: x right is +1, y UP is +1 (matches XInput).
"""

import ctypes
import math
import time

INSTALL_HINT = (
    "XBOX needs the ViGEmBus driver and the vgamepad package "
    "(see README: 'XBOX mode'). Falling back to WASD / ignoring Xbox bindings."
)

# Binding name -> vgamepad XUSB_BUTTON attribute. LT and RT are analog triggers, handled separately.
BUTTONS = {
    "a": "XUSB_GAMEPAD_A",
    "b": "XUSB_GAMEPAD_B",
    "x": "XUSB_GAMEPAD_X",
    "y": "XUSB_GAMEPAD_Y",
    "lb": "XUSB_GAMEPAD_LEFT_SHOULDER",
    "rb": "XUSB_GAMEPAD_RIGHT_SHOULDER",
    "l3": "XUSB_GAMEPAD_LEFT_THUMB",
    "r3": "XUSB_GAMEPAD_RIGHT_THUMB",
    "start": "XUSB_GAMEPAD_START",
    "back": "XUSB_GAMEPAD_BACK",
    "dpad_up": "XUSB_GAMEPAD_DPAD_UP",
    "dpad_down": "XUSB_GAMEPAD_DPAD_DOWN",
    "dpad_left": "XUSB_GAMEPAD_DPAD_LEFT",
    "dpad_right": "XUSB_GAMEPAD_DPAD_RIGHT",
}
TRIGGERS = ("lt", "rt")
BUTTON_NAMES: list[str] = [*BUTTONS, *TRIGGERS]


class Gamepad:
    def __init__(self, dry_run: bool):
        self.dry_run = dry_run
        self.pad = None
        self._vg = None
        self.stick = (0.0, 0.0)  # left
        self.right = (0.0, 0.0)
        self.held: set[str] = set()
        self.rumble_cb = None  # called as (large, small) from the driver's thread
        self.log: list[tuple] = []  # dry-run only

    @property
    def active(self) -> bool:
        """True when any stick is deflected or any button/trigger is held."""
        return bool(self.held) or self.stick != (0.0, 0.0) or self.right != (0.0, 0.0)

    def ensure(self) -> str | None:
        """Create the controller if needed. Returns an error message, or None when ready."""
        if self.dry_run:
            self.pad = self.pad or object()
            return None
        if self.pad is not None:
            return None
        try:
            import vgamepad as vg

            self._vg = vg
            self.pad = vg.VX360Gamepad()
            self.pad.reset()
            self.pad.update()
            self.pad.register_notification(self._on_notification)
        except Exception as exc:  # ImportError, or ViGEmBus not found at connect time
            self.pad = None
            return f"{type(exc).__name__}: {exc}"
        return None

    # vgamepad compares this signature (names included) with its own template.
    def _on_notification(self, client, target, large_motor, small_motor, led_number, user_data):
        self.emit_rumble(large_motor, small_motor)

    def emit_rumble(self, large: int, small: int) -> None:
        cb = self.rumble_cb
        if cb:
            try:
                cb(int(large), int(small))
            except Exception:
                pass  # never let a callback error reach the driver thread

    def user_index(self) -> int | None:
        """The XInput user index (0-3) the OS gave this pad, if the driver already knows it."""
        if self.dry_run or self.pad is None:
            return None
        try:
            from vgamepad.win import vigem_client as vcli
            from vgamepad.win import vigem_commons as vcom

            idx = ctypes.c_ulong()
            err = vcli.vigem_target_x360_get_user_index(self.pad._busp, self.pad._devicep, ctypes.byref(idx))
            if err == vcom.VIGEM_ERRORS.VIGEM_ERROR_NONE and idx.value < 4:
                return int(idx.value)
        except Exception:
            pass
        return None

    def settle(self) -> None:
        """Force a neutral state to reach the OS on a freshly created pad.

        A brand-new pad can show stale stick values (left over in its XInput slot) until its first
        different report, because an all-zero report equals the pad's initial state and is not
        forwarded. A one-count nudge followed by a neutral report makes the zero report a real change.
        """
        if self.dry_run or self.pad is None:
            return
        self.pad.left_joystick(x_value=1, y_value=0)  # 1/32767: far inside any deadzone
        self.pad.update()
        self.pad.reset()
        self.pad.update()

    def close(self) -> None:
        """Unplug the virtual controller (vgamepad removes the target when the object is released)."""
        if self.pad is not None:
            self.reset()
            try:
                self.pad.unregister_notification()
            except Exception:
                pass
        self.pad = None
        self._vg = None

    def set_stick(self, x: float, y: float) -> None:
        if self.pad is None or not (math.isfinite(x) and math.isfinite(y)):
            return
        x = max(-1.0, min(1.0, x))
        y = max(-1.0, min(1.0, y))
        self.stick = (x, y)
        if self.dry_run:
            self.log.append(("stick", x, y))
            return
        self.pad.left_joystick_float(x_value_float=x, y_value_float=y)
        self.pad.update()

    def set_right_stick(self, x: float, y: float) -> None:
        if self.pad is None or not (math.isfinite(x) and math.isfinite(y)):
            return
        x = max(-1.0, min(1.0, x))
        y = max(-1.0, min(1.0, y))
        self.right = (x, y)
        if self.dry_run:
            self.log.append(("rstick", x, y))
            return
        self.pad.right_joystick_float(x_value_float=x, y_value_float=y)
        self.pad.update()

    def set_button(self, name: str, down: bool) -> None:
        """Press or release a named button (or digital LT/RT). Unknown names are ignored."""
        if self.pad is None or name not in BUTTON_NAMES:
            return
        if down == (name in self.held):
            return
        if down:
            self.held.add(name)
        else:
            self.held.discard(name)
        if self.dry_run:
            self.log.append(("button", name, down))
            return
        if name == "lt":
            self.pad.left_trigger(value=255 if down else 0)
        elif name == "rt":
            self.pad.right_trigger(value=255 if down else 0)
        else:
            button = getattr(self._vg.XUSB_BUTTON, BUTTONS[name])
            if down:
                self.pad.press_button(button=button)
            else:
                self.pad.release_button(button=button)
        self.pad.update()

    def reset(self) -> None:
        """Center both sticks, release every button and trigger."""
        self.stick = (0.0, 0.0)
        self.right = (0.0, 0.0)
        self.held.clear()
        if self.pad is None:
            return
        if self.dry_run:
            self.log.append(("reset",))
            return
        self.pad.reset()
        self.pad.update()
