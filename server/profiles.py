"""Profile storage on the PC: one JSON file per profile in the profiles folder.

A profile file (also the export format) is:
  {"version": 1, "name": "...", "mode": "wasd" | "xbox", "layout": {"version": 1, "controls": [...]}}

The file name is a stable id (slug); renaming changes only "name". Profiles are validated strictly
on every read and write; a bad file is rejected with a message that names the offending field.
"""

import json
import math
import os
import re
import tempfile
import threading
from pathlib import Path

from gamepad import BUTTON_NAMES
from keymap import KEYMAP

PROFILE_VERSION = 1
LAYOUT_VERSION = 1
MAX_CONTROLS = 80
NAME_MAX = 40
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
STATE_FILE = "_state.json"
PRESET_ALIASES = {"codm": "mobile-fps"}  # old preset ids, mapped to the current ones

TYPES = ("button", "fire", "lookZone", "joystick")
SHAPES = ("circle", "rounded")
BUTTON_MODES = ("hold", "toggle")
OUTPUT_MODES = ("wasd", "xbox")
SMOOTHING = ("off", "low", "medium", "high")
MOUSE = ("left", "right", "middle")
WHEEL = ("up", "down")
JOY_STYLES = ("fixed", "floating")


class ProfileError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ---- validation ----

def _bad(message: str):
    raise ProfileError(400, message)


def _number(value, where: str, lo: float, hi: float):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _bad(f"{where} must be a number")
    if not lo - 1e-9 <= value <= hi + 1e-9:
        _bad(f"{where} must be between {lo} and {hi} (got {value})")
    return value


def _string(value, where: str, lo: int, hi: int) -> str:
    if not isinstance(value, str):
        _bad(f"{where} must be text")
    if not lo <= len(value) <= hi:
        _bad(f"{where} must be {lo} to {hi} characters (got {len(value)})")
    return value


def _choice(value, where: str, options):
    if value not in options:
        _bad(f"{where} must be one of {', '.join(map(str, options))} (got {value!r})")
    return value


def _flag(value, where: str) -> bool:
    if not isinstance(value, bool):
        _bad(f"{where} must be true or false")
    return value


def _binding(b, where: str) -> dict:
    if not isinstance(b, dict):
        _bad(f"{where} must be an object with kind and value")
    kind, value = b.get("kind"), b.get("value")
    _choice(kind, f"{where}.kind", ("key", "mouse", "wheel", "xbox"))
    allowed = {"key": KEYMAP, "mouse": MOUSE, "wheel": WHEEL, "xbox": BUTTON_NAMES}[kind]
    if not isinstance(value, str) or value not in allowed:
        _bad(f"{where}.value {value!r} is not a known {kind} binding")
    return {"kind": kind, "value": value}


_SETTINGS = {
    "button": {"showBinding": True},
    # output: "mouse" (relative mouse look) or "stick" (right stick: stickDeadzone %, stickRadius px, stickCurve)
    "fire": {"sensitivity": 1.5, "smoothing": "low", "output": "mouse", "stickDeadzone": 10, "stickRadius": 90, "stickCurve": "linear"},
    "lookZone": {"sensitivity": 1.5, "smoothing": "low", "output": "mouse", "stickDeadzone": 10, "stickRadius": 90, "stickCurve": "linear"},
    "joystick": {
        "style": "fixed", "deadzone": 15, "sprint": True, "radius": 72, "baseX": 0.5, "baseY": 0.68,
        "stick": "left", "stickCurve": "linear",
        "sprintStart": 100, "sprintStop": 90, "sprintForwardOnly": True, "sprintStyle": "hold",
        "sprintTapStop": False, "sprintKey": "lshift", "sprintPad": "l3", "sprintLock": False,
    },
}


def _settings(ctype: str, s, where: str) -> dict:
    if s is None:
        s = {}
    if not isinstance(s, dict):
        _bad(f"{where} must be an object")
    out = dict(_SETTINGS[ctype])
    for key, value in s.items():
        if key not in out:
            continue  # unknown keys are dropped
        w = f"{where}.{key}"
        if key in ("showBinding", "sprint", "sprintForwardOnly", "sprintTapStop", "sprintLock"):
            out[key] = _flag(value, w)
        elif key == "sensitivity":
            out[key] = _number(value, w, 0.2, 4)
        elif key == "smoothing":
            out[key] = _choice(value, w, SMOOTHING)
        elif key == "style":
            out[key] = _choice(value, w, JOY_STYLES)
        elif key == "deadzone":
            out[key] = _number(value, w, 0, 40)
        elif key == "radius":
            out[key] = _number(value, w, 40, 110)
        elif key in ("baseX", "baseY"):
            out[key] = _number(value, w, 0, 1)
        elif key == "output":
            out[key] = _choice(value, w, ("mouse", "stick"))
        elif key == "stickDeadzone":
            out[key] = _number(value, w, 0, 40)
        elif key == "stickRadius":
            out[key] = _number(value, w, 30, 200)
        elif key == "stick":
            out[key] = _choice(value, w, ("left", "right"))
        elif key == "stickCurve":
            out[key] = _choice(value, w, ("linear", "exponential"))
        elif key == "sprintStart":
            out[key] = _number(value, w, 50, 130)
        elif key == "sprintStop":
            out[key] = _number(value, w, 1, 129)
        elif key == "sprintStyle":
            out[key] = _choice(value, w, ("hold", "tap"))
        elif key == "sprintKey":
            if value not in KEYMAP:
                _bad(f"{w} {value!r} is not a known key")
            out[key] = value
        elif key == "sprintPad":
            if value not in BUTTON_NAMES:
                _bad(f"{w} {value!r} is not a known Xbox button")
            out[key] = value
    if ctype == "joystick":
        if "sprintStart" in s and "sprintStop" not in s:
            out["sprintStop"] = max(1, out["sprintStart"] - 10)  # older files: default is start - 10
        if out["sprintStop"] >= out["sprintStart"]:
            _bad(f"{where}.sprintStop ({out['sprintStop']}) must be below sprintStart ({out['sprintStart']})")
    return out


def _control(c, index: int, seen: set) -> dict:
    where = f"layout.controls[{index}]"
    if not isinstance(c, dict):
        _bad(f"{where} must be an object")
    cid = _string(c.get("id"), f"{where}.id", 1, 64)
    if cid in seen:
        _bad(f"{where}.id {cid!r} is used twice")
    seen.add(cid)
    ctype = _choice(c.get("type"), f"{where}.type", TYPES)
    x = _number(c.get("x"), f"{where}.x", 0, 100)
    y = _number(c.get("y"), f"{where}.y", 0, 100)
    w = _number(c.get("w"), f"{where}.w", 1, 100)
    h = _number(c.get("h"), f"{where}.h", 1, 100)
    if x + w > 100.5 or y + h > 100.5:
        _bad(f"{where} ({cid}) extends past the screen edge")
    binding = None
    if ctype in ("button", "fire"):
        binding = _binding(c.get("binding"), f"{where}.binding")
    return {
        "id": cid,
        "type": ctype,
        "x": x,
        "y": y,
        "w": w,
        "h": h,
        "label": _string(c.get("label"), f"{where}.label", 0, 24),
        "opacity": _number(c.get("opacity"), f"{where}.opacity", 0.2, 1),
        "shape": _choice(c.get("shape"), f"{where}.shape", SHAPES),
        "binding": binding,
        "mode": _choice(c.get("mode"), f"{where}.mode", BUTTON_MODES),
        "settings": _settings(ctype, c.get("settings"), f"{where}.settings"),
    }


def _cluster(c) -> dict:
    """The status cluster: x/y are both null (default top-right spot) or both % of the screen."""
    if c is None:
        c = {}
    if not isinstance(c, dict):
        _bad("layout.cluster must be an object")
    x, y = c.get("x"), c.get("y")
    if (x is None) != (y is None):
        _bad("layout.cluster.x and layout.cluster.y must both be numbers or both be null")
    if x is not None:
        x = _number(x, "layout.cluster.x", 0, 100)
        y = _number(y, "layout.cluster.y", 0, 100)
    return {
        "x": x,
        "y": y,
        "orientation": _choice(c.get("orientation", "horizontal"), "layout.cluster.orientation", ("horizontal", "vertical")),
        "opacity": _number(c.get("opacity", 1), "layout.cluster.opacity", 0.3, 1),
    }


def validate_layout(layout) -> dict:
    if not isinstance(layout, dict):
        _bad("layout must be an object")
    if layout.get("version") != LAYOUT_VERSION:
        _bad(f"layout.version must be {LAYOUT_VERSION} (got {layout.get('version')!r})")
    controls = layout.get("controls")
    if not isinstance(controls, list):
        _bad("layout.controls must be a list")
    if len(controls) > MAX_CONTROLS:
        _bad(f"layout has {len(controls)} controls; the limit is {MAX_CONTROLS}")
    preset = layout.get("preset", "default")
    if not isinstance(preset, str) or not re.fullmatch(r"[a-z0-9-]{1,24}", preset):
        _bad("layout.preset must be a short lowercase id")
    preset = PRESET_ALIASES.get(preset, preset)  # profiles saved before the rename keep working
    seen: set = set()
    sticks = [c["settings"].get("stick", "left") for c in controls if isinstance(c, dict) and c.get("type") == "joystick"
              and isinstance(c.get("settings"), dict)]
    joysticks = [c for c in controls if isinstance(c, dict) and c.get("type") == "joystick"]
    if len(joysticks) > 2 or sticks.count("right") > 1 or len(joysticks) - sticks.count("right") > 1:
        _bad("layout can have at most one left and one right joystick")
    return {
        "version": LAYOUT_VERSION,
        "preset": preset,
        "cluster": _cluster(layout.get("cluster")),
        "controls": [_control(c, i, seen) for i, c in enumerate(controls)],
    }


def validate_name(name) -> str:
    if not isinstance(name, str):
        _bad("name must be text")
    name = name.strip()
    if not 1 <= len(name) <= NAME_MAX:
        _bad(f"name must be 1 to {NAME_MAX} characters")
    return name


def validate_profile(data) -> dict:
    if not isinstance(data, dict):
        _bad("Profile must be a JSON object")
    if data.get("version") != PROFILE_VERSION:
        _bad(f"Unsupported profile version {data.get('version')!r} (expected {PROFILE_VERSION})")
    return {
        "version": PROFILE_VERSION,
        "name": validate_name(data.get("name")),
        "mode": _choice(data.get("mode"), "mode", OUTPUT_MODES),
        "layout": validate_layout(data.get("layout")),
    }


def validate_for_role(profile: dict, role: str) -> None:
    """A controller can only send Xbox output: no keyboard, mouse or wheel bindings, no mouse look."""
    if role != "controller":
        return
    problems = []
    for c in profile["layout"]["controls"]:
        b = c["binding"]
        if b and b["kind"] != "xbox":
            problems.append(f'"{c["label"] or c["id"]}" uses a {b["kind"]} binding')
        if c["type"] in ("fire", "lookZone") and c["settings"]["output"] != "stick":
            problems.append(f'"{c["label"] or c["id"]}" aims with the mouse (use Right stick)')
    if profile["mode"] != "xbox":
        problems.append("the output mode is WASD (use XBOX)")
    if problems:
        shown = "; ".join(problems[:3]) + (f" and {len(problems) - 3} more" if len(problems) > 3 else "")
        raise ProfileError(400, f"A controller profile can only use Xbox buttons and the right stick: {shown}.")


# ---- storage ----

def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40].strip("-")
    return slug or "profile"


class Profiles:
    def __init__(self, directory: Path):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    # -- helpers --

    def _path(self, pid: str) -> Path:
        if not isinstance(pid, str) or not ID_RE.fullmatch(pid):
            raise ProfileError(400, "Invalid profile id")
        return self.dir / f"{pid}.json"

    def _write(self, path: Path, data: dict) -> None:
        # Write to a temp file in the same folder, then replace: a crash never leaves half a profile.
        fd, tmp = tempfile.mkstemp(dir=self.dir, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def _read(self, path: Path) -> dict:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise ProfileError(404, "Profile not found")
        except (OSError, ValueError) as exc:
            raise ProfileError(400, f"{path.name} is not valid JSON ({exc})")
        try:
            return validate_profile(raw)
        except ProfileError as exc:
            raise ProfileError(400, f"{path.name}: {exc.message}")

    def _files(self):
        return sorted(p for p in self.dir.glob("*.json") if not p.name.startswith("_"))

    def _names(self, exclude: str | None = None) -> set[str]:
        names = set()
        for p in self._files():
            if p.stem == exclude:
                continue
            try:
                names.add(self._read(p)["name"].casefold())
            except ProfileError:
                pass
        return names

    def _unique_name(self, name: str, exclude: str | None = None) -> str:
        taken = self._names(exclude)
        candidate, n = name, 1
        while candidate.casefold() in taken:
            n += 1
            suffix = f" {n}"
            candidate = name[: NAME_MAX - len(suffix)] + suffix
        return candidate

    def _new_id(self, name: str) -> str:
        base = slugify(name)
        pid, n = base, 1
        while (self.dir / f"{pid}.json").exists():
            n += 1
            pid = f"{base}-{n}"
        return pid

    # -- API --

    def list(self) -> tuple[list[dict], list[dict]]:
        """Returns (profiles, problems). Bad files are skipped and reported, never silently."""
        profiles, problems = [], []
        with self._lock:
            for path in self._files():
                if not ID_RE.fullmatch(path.stem):
                    problems.append({"file": path.name, "error": "file name is not a valid profile id"})
                    continue
                try:
                    p = self._read(path)
                except ProfileError as exc:
                    problems.append({"file": path.name, "error": exc.message})
                    continue
                profiles.append({"id": path.stem, "name": p["name"], "mode": p["mode"], "updated": int(path.stat().st_mtime)})
        profiles.sort(key=lambda p: p["name"].casefold())
        return profiles, problems

    def get(self, pid: str) -> dict:
        with self._lock:
            return {"id": pid, **self._read(self._path(pid))}

    def create(self, data) -> dict:
        profile = validate_profile(data)
        with self._lock:
            profile["name"] = self._unique_name(profile["name"])
            pid = self._new_id(profile["name"])
            self._write(self._path(pid), profile)
            return {"id": pid, **profile}

    def save(self, pid: str, data) -> dict:
        profile = validate_profile(data)
        with self._lock:
            path = self._path(pid)
            if not path.exists():
                raise ProfileError(404, "Profile not found")
            if profile["name"].casefold() in self._names(exclude=pid):
                raise ProfileError(409, f'Another profile is already named "{profile["name"]}"')
            self._write(path, profile)
            return {"id": pid, **profile}

    def rename(self, pid: str, name) -> dict:
        name = validate_name(name)
        with self._lock:
            path = self._path(pid)
            profile = self._read(path)
            if name.casefold() in self._names(exclude=pid):
                raise ProfileError(409, f'Another profile is already named "{name}"')
            profile["name"] = name
            self._write(path, profile)
            return {"id": pid, **profile}

    def duplicate(self, pid: str, name=None) -> dict:
        with self._lock:
            profile = self._read(self._path(pid))
            wanted = validate_name(name) if name else f'{profile["name"]} copy'[:NAME_MAX]
            profile["name"] = self._unique_name(wanted)
            new_id = self._new_id(profile["name"])
            self._write(self._path(new_id), profile)
            return {"id": new_id, **profile}

    def delete(self, pid: str) -> None:
        with self._lock:
            path = self._path(pid)
            if not path.exists():
                raise ProfileError(404, "Profile not found")
            if len([p for p in self.list()[0] if p["id"] != pid]) < 1:  # count readable profiles only
                raise ProfileError(409, "Can't delete the last profile")
            path.unlink()
            if self.last() == pid:
                (self.dir / STATE_FILE).unlink(missing_ok=True)

    def export_text(self, pid: str) -> str:
        with self._lock:
            profile = self._read(self._path(pid))
        return json.dumps(profile, indent=2, ensure_ascii=False)

    # -- last used --

    def last(self) -> str | None:
        try:
            pid = json.loads((self.dir / STATE_FILE).read_text(encoding="utf-8")).get("last")
        except (OSError, ValueError, AttributeError):
            return None
        if isinstance(pid, str) and ID_RE.fullmatch(pid) and (self.dir / f"{pid}.json").exists():
            return pid
        return None

    def set_last(self, pid: str) -> None:
        with self._lock:
            if not self._path(pid).exists():
                raise ProfileError(404, "Profile not found")
            self._write(self.dir / STATE_FILE, {"last": pid})
