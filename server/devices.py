"""Paired devices: persistent id, editable name, role, token hash and last-used profile.

Roles
  host        keyboard and mouse allowed (and Xbox output). At most one device at a time.
  controller  Xbox output only, on its own virtual pad.
The first device to pair while there is no host becomes the host; later ones are controllers.

Tokens are random and only their SHA-256 is stored, so the devices file can't be used to log in.
Pairing uses a 4-digit code printed on the PC. A code is single use, expires after CODE_TTL seconds,
and five wrong guesses lock pairing for LOCKOUT seconds and replace the code.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile
import threading
import time
from pathlib import Path

HOST = "host"
CONTROLLER = "controller"
NAME_MAX = 24
CODE_TTL = 120
MAX_ATTEMPTS = 5
LOCKOUT = 30
ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")


class DeviceError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def clean_name(name) -> str:
    if not isinstance(name, str) or not name.strip():
        raise DeviceError(400, "Device name must be 1 to %d characters" % NAME_MAX)
    name = " ".join(name.split())
    if len(name) > NAME_MAX:
        raise DeviceError(400, "Device name must be 1 to %d characters" % NAME_MAX)
    return name


class PairingCode:
    """The 4-digit code shown on the PC. Never sent to a device."""

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.code: str | None = None
        self.expires = 0.0
        self.fails = 0
        self.locked_until = 0.0
        self.last_shown = 0.0

    def issue(self) -> tuple[str, bool]:
        """The current code, creating a new one if needed. Returns (code, is_new)."""
        now = self.clock()
        if self.code is None or now >= self.expires:
            self.code = f"{secrets.randbelow(10000):04d}"
            self.expires = now + CODE_TTL
            self.fails = 0
            return self.code, True
        return self.code, False

    def stale(self) -> bool:
        """No usable code right now (never issued, used up, expired, or replaced after a lock-out)."""
        return self.code is None or self.clock() >= self.expires

    def check(self, code) -> tuple[bool, str, int]:
        """(ok, reason, seconds until another try is allowed)."""
        now = self.clock()
        if now < self.locked_until:
            return False, "Too many wrong codes. Wait and try the new code on the PC.", int(self.locked_until - now) + 1
        if self.code is None or now >= self.expires:
            return False, "That code has expired. Look at the PC for the new one.", 0
        if isinstance(code, str) and hmac.compare_digest(code.strip(), self.code):
            self.code = None  # single use
            self.fails = 0
            return True, "", 0
        self.fails += 1
        if self.fails >= MAX_ATTEMPTS:
            self.code = None  # a fresh code is issued on the next connection attempt
            self.locked_until = now + LOCKOUT
            return False, "Too many wrong codes. Wait and try the new code on the PC.", LOCKOUT
        return False, f"Wrong code ({MAX_ATTEMPTS - self.fails} tries left).", 0


class DeviceStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.RLock()
        self._devices: dict[str, dict] = {}
        self._load()

    # ---- persistence ----

    def _load(self) -> None:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            devices = data.get("devices", {})
            if isinstance(devices, dict):
                self._devices = {k: v for k, v in devices.items() if ID_RE.fullmatch(k) and isinstance(v, dict)}
        except (OSError, ValueError, AttributeError):
            self._devices = {}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"devices": self._devices}, f, indent=2)
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    @staticmethod
    def _public(device_id: str, d: dict) -> dict:
        return {
            "id": device_id,
            "name": d["name"],
            "role": d["role"],
            "pairedAt": d.get("paired_at", 0),
            "lastProfile": d.get("last_profile"),
            "defaultProfilePending": bool(d.get("default_profile_pending")),
        }

    # ---- queries ----

    def get(self, device_id) -> dict | None:
        with self._lock:
            d = self._devices.get(device_id) if isinstance(device_id, str) else None
            return self._public(device_id, d) if d else None

    def list(self) -> list[dict]:
        with self._lock:
            return sorted((self._public(k, v) for k, v in self._devices.items()), key=lambda d: (d["role"] != HOST, d["name"].casefold()))

    def host_id(self) -> str | None:
        with self._lock:
            return next((k for k, v in self._devices.items() if v["role"] == HOST), None)

    def authenticate(self, device_id, token) -> dict | None:
        """The device if the token is the one issued at pairing, else None."""
        if not isinstance(device_id, str) or not isinstance(token, str):
            return None
        with self._lock:
            d = self._devices.get(device_id)
            if d and hmac.compare_digest(_hash(token), d["token_hash"]):
                return self._public(device_id, d)
        return None

    # ---- changes ----

    def pair(self, device_id, name) -> tuple[str, dict]:
        """Issue a token for this device id. The first device with no host becomes the host."""
        if not isinstance(device_id, str) or not ID_RE.fullmatch(device_id):
            raise DeviceError(400, "Invalid device id")
        name = clean_name(name)
        token = secrets.token_urlsafe(32)
        with self._lock:
            existing = self._devices.get(device_id)
            if existing:  # a known device pairing again (lost its token): keep its role
                existing.update(name=name, token_hash=_hash(token))
            else:
                role = HOST if self.host_id() is None else CONTROLLER
                self._devices[device_id] = {
                    "name": name, "role": role, "token_hash": _hash(token), "paired_at": int(time.time()),
                    "last_profile": None, "default_profile_pending": role == CONTROLLER,
                }
            self._save()
            return token, self._public(device_id, self._devices[device_id])

    def rename(self, device_id: str, name) -> dict:
        name = clean_name(name)
        with self._lock:
            d = self._require(device_id)
            d["name"] = name
            self._save()
            return self._public(device_id, d)

    def set_host(self, device_id: str) -> str | None:
        """Make this device the host and demote the old one. Returns the old host's id."""
        with self._lock:
            d = self._require(device_id)
            old = self.host_id()
            if old == device_id:
                return old
            if old:
                self._devices[old]["role"] = CONTROLLER
                self._devices[old]["default_profile_pending"] = False
            d["role"] = HOST
            d["default_profile_pending"] = False
            self._save()
            return old

    def forget(self, device_id: str) -> None:
        """Revoke the device: its token stops working and it must pair again."""
        with self._lock:
            self._require(device_id)
            del self._devices[device_id]
            self._save()

    def set_last_profile(self, device_id: str, profile_id: str | None) -> None:
        with self._lock:
            d = self._require(device_id)
            d["last_profile"] = profile_id
            d["default_profile_pending"] = False
            self._save()

    def _require(self, device_id: str) -> dict:
        d = self._devices.get(device_id) if isinstance(device_id, str) else None
        if not d:
            raise DeviceError(404, "Unknown device")
        return d
