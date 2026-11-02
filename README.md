# iPad Gamepad

Use your iPad or phone as a customizable touch controller (keyboard/mouse or Xbox) for Windows PC games.

A small Windows program serves a touch app over your home network. Open it in the browser of an iPad, iPhone
or Android device, pair once with a 4-digit code, and the device becomes a controller: look zone, buttons,
a movement joystick, a layout editor, and more. Several devices can be connected at once.

> **Screenshots:** _placeholder, add images to `docs/images/` and link them here._
>
> | Touch app (play mode) | Layout editor | PC dashboard |
> |---|---|---|
> | _screenshot_ | _screenshot_ | _screenshot_ |

## Features

- **Touch layout you design:** drag, resize and bind buttons, a fire button, a look zone and joysticks. Profiles are saved on the PC and shared by every device. Built-in presets: Default, Mobile FPS, Phone Controller, Phone Controller (Sticks).
- **Keyboard and mouse output:** keys, mouse buttons, wheel and mouse look injected with Windows `SendInput`, with optional aim smoothing for jittery Wi-Fi.
- **Xbox output (optional):** a virtual Xbox 360 controller per device through the ViGEmBus driver: analog left and right stick, triggers, buttons, rumble forwarded to the device. More than four pads are possible (XInput-only games just won't see the extra ones).
- **Movement joystick** with WASD or analog output, sprint ring, sprint lock and tap or hold sprint.
- **Multiple devices:** pairing with a code, a host (keyboard and mouse) and controllers (own virtual pad), per-device sessions so one disconnecting never releases another's inputs.
- **PC dashboard (desktop app):** live view of every connected device, our virtual pads and the real controllers on the PC (read only), with a tray icon, three views, filters and a size slider.
- **KB/M only mode:** never loads the virtual-controller driver client, for games that dislike it.
- **Stuck-input protection:** everything a device holds is released on disconnect, heartbeat loss, page hide or leaving play mode.

## Requirements

- **Windows 10 or 11** (the program injects Windows input and uses Windows APIs).
- A touch device with a modern browser (Safari on iPad/iPhone, Chrome on Android) on the **same Wi-Fi or LAN** as the PC. Router "client isolation" must be off.
- **Optional, for Xbox features:** the [ViGEmBus](https://github.com/nefarius/ViGEmBus/releases) driver. It is not included and not required for keyboard and mouse use. Note that ViGEmBus is end-of-life (no longer maintained).
- The desktop window uses the Microsoft Edge WebView2 runtime, included with current Windows 10/11.
- Running from source only: Python 3.11 or newer.

## Install

### A. Download the release (easiest)

1. Download `iPad-Gamepad-vX.Y.Z-windows.zip` from the [Releases](../../releases) page and unzip the **whole folder** somewhere.
2. Run `iPad Gamepad.exe`. Windows SmartScreen may warn about an unrecognized app because the exe is not code-signed; that is expected for a hobby project. Allow it through Windows Firewall on **Private** networks when asked.
3. A window and a tray icon appear. Closing the window hides it to the tray; **Quit** in the tray menu stops everything.

### B. Run from source

1. Install Python 3.11+.
2. Double-click `run.bat`. It creates `.venv`, installs `requirements.txt` and starts the server (no window; the address and a QR code print in the terminal).
3. For the desktop app and dashboard from source: `.venv\Scripts\pip install -r requirements-app.txt`, then `.venv\Scripts\python app.py`. To build the exe yourself: `build.bat`.
4. For Xbox features from source: install ViGEmBus, then `.venv\Scripts\pip install -r requirements-xbox.txt` (its setup launches the driver installer, so do this deliberately).

## Quick start

1. Start the program on the PC. The dashboard's **Pairing** section (or the terminal in `run.bat`) shows the address, like `http://192.168.x.x:8000`, and a 4-digit code once a device tries to connect.
2. On the iPad or phone, open that address in the browser (or scan the QR code in the terminal).
3. Enter the code and a name for the device. Pairing happens once; the device stays signed in.
4. Optional: Share > **Add to Home Screen** to run it fullscreen like an app.
5. Hold the lock icon in the top bar to edit the layout. If a game ignores input, run the program as Administrator.

More in the [user guide](docs/USER_GUIDE.md); file formats, the network protocol and build notes are in the [developer notes](docs/DEVELOPER_NOTES.md).

## Please read: disclaimers

- **Hobby project.** This is a personal project, provided as is, with no warranty. It is **not affiliated with, endorsed by or sponsored by any game, game publisher, Apple, Microsoft, Sony, Nintendo or Valve**. All product names and trademarks belong to their owners and are used only to describe compatibility.
- **Online games and anti-cheat.** Games with anti-cheat may ignore injected input, block it, or treat it as cheating and **ban your account**. Use it at your own risk and test on an alternate account first. **Do not use this to gain an unfair advantage.** It is meant for single-player and games that allow touch or alternative input.
- **Local network only, plain HTTP.** Traffic between your devices and the PC is **not encrypted**. Pairing uses a code and a per-device token, but anyone on the same network could watch or tamper with traffic. Use it only on a trusted home Wi-Fi, never on public or shared networks, and never expose the port to the internet.
- **ViGEmBus is end-of-life.** The virtual-controller driver used for Xbox features is no longer maintained by its author. It works today but may break with future Windows updates. KB/M only mode never loads its client; uninstalling the driver itself is up to you.
- **Input injection needs care.** The program presses keys and moves your mouse on request of paired devices. Only pair devices you own, and use **Forget** on the dashboard or in the Devices dialog to revoke one.

## Contributing and issues

Issues and pull requests are welcome. Please do not post pairing codes, device tokens or your `profiles/` and `devices.json` files in issues.

## License

[MIT](LICENSE), copyright (c) 2026 Qusai Dahodwalla. The release zip bundles third-party software under its own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
