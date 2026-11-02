# Third-party notices

iPad Gamepad itself is released under the MIT License (see `LICENSE`). It uses and, in the Windows
release zip, **bundles** the third-party software below. Versions are the ones the v1.0.0 release was
built with. This is a good-faith inventory, not legal advice.

The release zip contains a `licenses\` folder with the license texts shipped by these packages
(`tools/make_release.py` copies them in). Where a package ships no license file, the "Source of this
information" column says so: those entries come from the upstream project's published license and
should be checked against the upstream repository before you rely on them.

## Python packages

| Package | Version | License | Needs attention |
|---|---|---|---|
| [fastapi](https://github.com/fastapi/fastapi) | 0.143.3 | MIT | |
| [starlette](https://github.com/encode/starlette) | 1.8.0 | BSD-3-Clause | |
| [uvicorn](https://github.com/encode/uvicorn) | 0.54.0 | BSD-3-Clause | |
| [pydantic](https://github.com/pydantic/pydantic) / pydantic-core | 2.14.1 / 2.50.1 | MIT | |
| annotated-types, annotated-doc, typing-inspection | 0.8.0, 0.0.5, 0.4.4 | MIT | |
| [typing-extensions](https://github.com/python/typing_extensions) | 4.16.0 | PSF-2.0 | |
| [anyio](https://github.com/agronholm/anyio), [idna](https://github.com/kjd/idna), [click](https://github.com/pallets/click) | 4.15.1, 3.20, 8.5.0 | MIT, BSD-3-Clause, BSD-3-Clause | |
| [h11](https://github.com/python-hyper/h11), [httptools](https://github.com/MagicStack/httptools), [websockets](https://github.com/python-websockets/websockets), [watchfiles](https://github.com/samuelcolvin/watchfiles) | 0.16.0, 0.9.0, 17.2, 1.3.0 | MIT, MIT, BSD-3-Clause, MIT | |
| PyYAML, python-dotenv, colorama | 6.0.3, 1.2.4, 0.4.6 | MIT, BSD-3-Clause, BSD-3-Clause | |
| [qrcode](https://github.com/lincolnloop/python-qrcode) | 8.2 | BSD | |
| [Pillow](https://github.com/python-pillow/Pillow) | 13.0.0 | MIT-CMU (HPND) | Its wheel bundles libjpeg, libpng, FreeType, libtiff, libwebp, lcms2, zlib and others; their notices are in Pillow's own `LICENSE`, which goes into `licenses\`. |
| [pystray](https://github.com/moses-palmer/pystray) | 0.19.5 | **LGPL-3.0** | **Yes, see "LGPL" below.** |
| [pywebview](https://github.com/r0x0r/pywebview) | 6.2.1 | BSD-3-Clause | |
| [pythonnet](https://github.com/pythonnet/pythonnet), [clr-loader](https://github.com/pythonnet/clr-loader), cffi, pycparser | 3.2.1, 0.3.1, 2.1.1, 3.11 | MIT, MIT, MIT-0, BSD-3-Clause | |
| [bottle](https://github.com/bottlepy/bottle), proxy-tools, six | 0.13.4, 0.1.0, 1.17.0 | MIT, MIT, MIT | |
| [pygame-ce](https://github.com/pygame-community/pygame-ce) | 2.5.8 | **LGPL-2.1** | **Yes, see "LGPL" below** (also bundles SDL2 and codec libraries). |
| [vgamepad](https://github.com/yannbouteiller/vgamepad) | 0.1.0 | MIT (Yann Bouteiller) | Bundles the ViGEmClient DLL, see below. |
| opentelemetry-api, setuptools | 1.45.1, 84.0.0 | Apache-2.0, MIT | Apache-2.0 notices go into `licenses\`. |
| [PyInstaller](https://github.com/pyinstaller/pyinstaller) (build tool; its bootloader is inside the exe) | 6.22.3 | GPL-2.0-or-later **with a special exception** | See "PyInstaller" below. |

Build-time only (not part of the shipped program): altgraph, pefile, pywin32-ctypes,
pyinstaller-hooks-contrib, pip.

## Native components and files inside the release folder

| Component | License | Source of this information |
|---|---|---|
| Python 3.14 runtime (`python314.dll`, `.pyd` modules) | PSF License | Python distribution |
| OpenSSL (`libcrypto-3.dll`, `libssl-3.dll`) and libffi | Apache-2.0 and MIT | Python distribution |
| Microsoft Visual C++ runtime (`VCRUNTIME140*.dll`) and Universal CRT (`api-ms-win-crt-*.dll`, `ucrtbase.dll`) | Microsoft redistributable terms | Microsoft; redistribution of these files is permitted by those terms |
| ViGEmClient.dll (inside the `vgamepad` folder, x64 and x86) | MIT, copyright (c) 2018 Benjamin Höglinger-Stelzer | Verified against the upstream repository (nefarius/ViGEmClient, `LICENSE`); no license file ships with the DLL, so the text is added to `licenses\ViGEmClient\` |
| Microsoft.Web.WebView2.Core.dll, Microsoft.Web.WebView2.WinForms.dll | Microsoft WebView2 SDK license terms (redistribution allowed) | pywebview ships them |
| WebBrowserInterop.x64/x86.dll | BSD-3-Clause (pywebview) | pywebview |
| SDL2.dll | zlib | SDL project; pygame-ce ships no license file |
| SDL2_image, SDL2_ttf, SDL2_mixer | zlib | SDL project; same |
| freetype.dll | FreeType License (or GPL-2.0, dual) | FreeType project; same |
| libpng, libjpeg, libtiff, libwebp | libpng license, IJG/BSD, libtiff license, BSD-3-Clause | upstream projects; same |
| libogg, libopus, libopusfile, libwavpack | BSD-3-Clause | upstream projects; same |
| **libxmp.dll** | **LGPL-2.1-or-later** | upstream libxmp; **verify the exact build** |
| portmidi.dll | MIT-style | upstream; same |
| `pygame/freesansbold.ttf` | GNU FreeFont (GPL with font exception) | pygame; same |

NOT bundled and not installed by this project: the **ViGEmBus driver** (BSD-3-Clause per its upstream
repository, by Nefarius Software Solutions; the repository is archived and the project end-of-life) and the Microsoft Edge **WebView2 Runtime**, which
current Windows 10/11 provide.

## What is required of you

1. **Permissive licenses (MIT, BSD, Apache-2.0, zlib, PSF, MIT-CMU):** keep the copyright and license
   text with the distribution. The `licenses\` folder in the release zip does that. For Apache-2.0
   components also keep any NOTICE file.
2. **FreeType (used through pygame-ce and Pillow):** under the FreeType License the documentation must
   credit it. Included here: *Portions of this software are copyright (c) The FreeType Project
   (www.freetype.org). All rights reserved.* Likewise libjpeg: *This software is based in part on the
   work of the Independent JPEG Group.*
3. **LGPL (pystray LGPL-3.0, pygame-ce LGPL-2.1, libxmp LGPL-2.1+):** you may ship them inside an MIT
   program, but you must:
   - give a prominent notice that the program uses these libraries and include their license texts
     (done here and in `licenses\`; pystray's LGPL-3.0 also requires the GPL-3.0 text it refers to,
     which pystray ships as `COPYING`);
   - let users replace the library with a modified version and run the program with it. This project
     is open source and `build.bat` rebuilds the exe against whatever versions are in `.venv`, which is
     the way to do that. Caveat: PyInstaller stores pure-Python modules (pystray) inside the exe's
     archive, so replacing them means rebuilding rather than swapping a file. If you want a plain
     file swap, build with PyInstaller's `--noarchive` option or drop the dependency.
   - Do not forbid reverse engineering for debugging such modifications (the MIT license does not).
4. **PyInstaller:** the bootloader in the exe is GPL-2.0-or-later but carries an exception that allows
   the generated executable to be distributed under any license, so the exe can stay MIT. Keep the
   PyInstaller copyright notice (in `licenses\`).
5. **ViGEmClient.dll:** MIT, verified upstream. Its license text is included in `licenses\ViGEmClient\`.
   Keep the DLL as an unmodified, separate file.
6. **Trademarks:** Xbox, Windows and WebView2 are Microsoft trademarks; PlayStation, DualShock and
   DualSense are Sony's; Switch is Nintendo's; Steam is Valve's; iPad is Apple's. They are named only
   to describe compatibility. This project is not affiliated with or endorsed by any of them.

## Optional: shrinking the obligations

The program only needs pygame's joystick and event code (to read other gamepads, read only). The SDL
mixer, image and font DLLs and libxmp in the release folder are not used by it. Excluding them from
the PyInstaller spec would remove most of the native-library notices above (and the libxmp LGPL
item). That needs a rebuild and a test that `import pygame` still works without them; it is not done
in v1.0.0.
