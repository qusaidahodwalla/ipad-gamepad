"""Where the app keeps its data, and where its bundled files live.

Data (profiles/ and devices.json) goes in %APPDATA%\\iPadGamepad for both run.bat and the packaged
app, so they share one set of profiles and one list of paired devices. The first time that folder
is used, existing data from the project folder is COPIED in; the originals are left untouched.
"""

import os
import shutil
import sys
from pathlib import Path

APP_DIR_NAME = "iPadGamepad"
FROZEN = bool(getattr(sys, "frozen", False))


def resource_root() -> Path:
    """The folder that contains web/ (the project root, or the bundle when packaged)."""
    if FROZEN:
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def data_dir() -> Path:
    override = os.environ.get("PAD_DATA_DIR")
    if override:
        return Path(override)
    base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(base) / APP_DIR_NAME


def _legacy_candidates() -> list[Path]:
    """Folders that may hold profiles/ and devices.json from before the move to APPDATA."""
    if not FROZEN:
        return [resource_root()]
    exe = Path(sys.executable).resolve().parent
    return [exe, exe.parent, exe.parent.parent]  # next to the exe, or dist\ or the project above it


def migrate(target: Path) -> list[str]:
    """Copy old profiles/ and devices.json into `target` if it has none yet. Returns what was copied."""
    copied: list[str] = []
    target.mkdir(parents=True, exist_ok=True)
    profiles, devices = target / "profiles", target / "devices.json"
    for src in _legacy_candidates():
        if not profiles.exists() and (src / "profiles").is_dir():
            shutil.copytree(src / "profiles", profiles)
            copied.append(f"profiles from {src}")
        if not devices.exists() and (src / "devices.json").is_file():
            shutil.copy2(src / "devices.json", devices)
            copied.append(f"devices.json from {src}")
    return copied
