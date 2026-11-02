# PyInstaller spec: a ONE-FOLDER build, dist\iPad Gamepad\iPad Gamepad.exe (see build.bat).
# The bundled copy of vgamepad is whatever is installed in .venv; the ViGEmBus driver itself is
# NOT bundled and must already be installed on the PC for XBOX features.
import os

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

root = os.path.abspath(SPECPATH)

datas = [
    (os.path.join(root, "web"), "web"),
    (os.path.join(root, "assets"), "assets"),
]
# vgamepad needs its ViGEm client DLLs (not the driver installers next to them).
try:
    datas += collect_data_files("vgamepad", includes=["win/vigem/client/*/*.dll"])
except Exception as exc:
    print(f"WARNING: vgamepad not found, XBOX features will be missing from this build: {exc}")

hiddenimports = (
    collect_submodules("uvicorn")
    + collect_submodules("websockets")
    + ["pystray._win32", "vgamepad", "pygame._sdl2.controller", "qrcode"]
)

a = Analysis(
    [os.path.join(root, "app.py")],
    pathex=[os.path.join(root, "server")],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "numpy.testing", "pytest"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="iPad Gamepad",
    console=False,
    icon=os.path.join(root, "assets", "icon.ico"),
)
coll = COLLECT(exe, a.binaries, a.datas, name="iPad Gamepad")
