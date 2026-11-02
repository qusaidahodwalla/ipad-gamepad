"""The one key table: name -> (set 1 scancode, extended flag).

Names are what the layout JSON stores in a key binding; /api/keys serves them to the editor.
"""

KEYMAP: dict[str, tuple[int, bool]] = {}

for _i, _c in enumerate("qwertyuiop"):
    KEYMAP[_c] = (0x10 + _i, False)
for _i, _c in enumerate("asdfghjkl"):
    KEYMAP[_c] = (0x1E + _i, False)
for _i, _c in enumerate("zxcvbnm"):
    KEYMAP[_c] = (0x2C + _i, False)

for _i, _c in enumerate("1234567890"):
    KEYMAP[_c] = (0x02 + _i, False)

for _n in range(1, 11):
    KEYMAP[f"f{_n}"] = (0x3A + _n, False)  # F1..F10 = 0x3B..0x44
KEYMAP["f11"] = (0x57, False)
KEYMAP["f12"] = (0x58, False)

KEYMAP.update(
    {
        "lshift": (0x2A, False),
        "rshift": (0x36, False),
        "lctrl": (0x1D, False),
        "rctrl": (0x1D, True),
        "lalt": (0x38, False),
        "ralt": (0x38, True),
        "space": (0x39, False),
        "tab": (0x0F, False),
        "esc": (0x01, False),
        "enter": (0x1C, False),
        "backspace": (0x0E, False),
        "caps": (0x3A, False),
        "up": (0x48, True),
        "down": (0x50, True),
        "left": (0x4B, True),
        "right": (0x4D, True),
    }
)

KEY_NAMES: list[str] = list(KEYMAP)
