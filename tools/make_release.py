r"""Package the built app as a release zip: add the license files, then zip dist\iPad Gamepad.

Run `build.bat` first (it creates dist\iPad Gamepad\), then:

    .venv\Scripts\python tools\make_release.py 1.0.0

Writes release\iPad-Gamepad-v<version>-windows.zip. Neither dist\ nor release\ is committed to git.
The zip is meant to be attached to a GitHub Release.
"""

import importlib.metadata as md
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = "iPad Gamepad"
DIST = ROOT / "dist" / APP
# Installed only to build the app (or tooling), not shipped inside it.
BUILD_ONLY = {"altgraph", "pefile", "pywin32-ctypes", "pyinstaller-hooks-contrib", "pip"}
LICENSE_WORDS = ("LICENSE", "LICENCE", "COPYING", "NOTICE")


def copy_licenses(target: Path) -> int:
    r"""Copy each shipped package's own license files (from its dist-info) into target\<name>-<version>."""
    count = 0
    for dist in md.distributions():
        name = dist.metadata["Name"]
        if name.lower().replace("_", "-") in BUILD_ONLY:
            continue
        for f in dist.files or []:
            base = Path(str(f)).name.upper()
            if any(w in base for w in LICENSE_WORDS) and ".dist-info" in str(f).replace("\\", "/"):
                src = Path(dist.locate_file(f))
                if src.is_file():
                    out = target / f"{name}-{dist.version}"
                    out.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, out / src.name)
                    count += 1
    # ViGEmClient.dll ships no license file: add the upstream MIT text kept in tools/licenses/.
    vigem = ROOT / "tools" / "licenses" / "ViGEmClient-LICENSE.txt"
    if vigem.is_file():
        (target / "ViGEmClient").mkdir(parents=True, exist_ok=True)
        shutil.copy2(vigem, target / "ViGEmClient" / "LICENSE.txt")
        count += 1
    # pygame-ce ships no license file in its metadata, but includes the LGPL text in its docs.
    try:
        lgpl = Path(md.distribution("pygame-ce").locate_file("pygame/docs/generated/LGPL.txt"))
        if lgpl.is_file():
            out = target / "pygame-ce-LGPL-2.1"
            out.mkdir(parents=True, exist_ok=True)
            shutil.copy2(lgpl, out / "LGPL-2.1.txt")
            count += 1
    except md.PackageNotFoundError:
        pass
    return count


def main() -> int:
    version = sys.argv[1] if len(sys.argv) > 1 else "1.0.0"
    if not (DIST / f"{APP}.exe").is_file():
        print(f"Missing {DIST / (APP + '.exe')}. Run build.bat first.")
        return 1
    for name in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
        shutil.copy2(ROOT / name, DIST / name)
    lic = DIST / "licenses"
    shutil.rmtree(lic, ignore_errors=True)
    n = copy_licenses(lic)
    (lic / "README.txt").write_text(
        "License texts of the third-party software in this folder. See ../THIRD_PARTY_NOTICES.md for what\n"
        "each component is, what needs attention (LGPL, FreeType, PyInstaller) and the notices that go with them.\n",
        encoding="utf-8")
    out_dir = ROOT / "release"
    out_dir.mkdir(exist_ok=True)
    zpath = out_dir / f"iPad-Gamepad-v{version}-windows.zip"
    zpath.unlink(missing_ok=True)
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in sorted(DIST.rglob("*")):
            if f.is_file():
                z.write(f, Path(APP) / f.relative_to(DIST))
    print(f"{n} license files added; wrote {zpath} ({zpath.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
