"""App-wide settings (not per profile), kept in %APPDATA%\\iPadGamepad\\settings.json.

Only one setting so far: "KB/M only" mode. When it is on, the server never imports vgamepad and never
loads the ViGEmClient DLL: only keyboard and mouse input (SendInput) is used. The value in effect is
read once at startup, so changing it needs a restart of the server. The environment variable
KBM_ONLY=1 forces it on for that run (what run.bat users set). The ViGEmBus driver itself is never
touched; uninstalling it is up to the user.
"""

import json
import os
import tempfile
from pathlib import Path

from paths import data_dir

TRUE = {"1", "true", "yes", "on"}


class AppSettings:
    def __init__(self, path: Path | None = None):
        override = os.environ.get("PAD_SETTINGS_FILE")
        self.path = Path(path or override or data_dir() / "settings.json")
        self.forced = os.environ.get("KBM_ONLY", "").strip().lower() in TRUE
        self.saved = self._load()
        self.running = self.forced or self.saved  # fixed for the life of this process

    def _load(self) -> bool:
        try:
            return bool(json.loads(self.path.read_text(encoding="utf-8")).get("kbmOnly", False))
        except (OSError, ValueError, AttributeError):
            return False

    def set_kbm_only(self, on: bool) -> None:
        """Save the choice; it takes effect after a restart."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"kbmOnly": bool(on)}, f, indent=2)
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
        self.saved = bool(on)

    @property
    def restart_required(self) -> bool:
        return (self.forced or self.saved) != self.running

    def public(self, can_restart: bool) -> dict:
        return {
            "running": self.running, "saved": self.saved, "forced": self.forced,
            "restartRequired": self.restart_required, "canRestart": can_restart,
        }
