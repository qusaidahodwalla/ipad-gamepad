# Developer notes

## Layout schema

Version 1. Positions and sizes are percentages of the play area (the whole safe-area box):

Circles are sized by their **height** (`h` = diameter as % of screen height) and made square with CSS `aspect-ratio`, centred on `x + w/2`, so they stay round on any screen. `w` only fixes the centre for circles.

```json
{ "version": 1,
  "preset": "default | mobile-fps | phone | phone-sticks",
  "cluster": { "x": null, "y": null, "orientation": "horizontal | vertical", "opacity": 0.3..1 },
  "controls": [{
    "id": "fire", "type": "button | fire | lookZone | joystick",
    "x": 86.43, "y": 79.6, "w": 10.05, "h": 15.11,
    "label": "FIRE", "opacity": 1, "shape": "circle | rounded",
    "binding": { "kind": "key | mouse | wheel | xbox", "value": "left" },
    "mode": "hold | toggle",
    "settings": {}
  }] }
```

`cluster.x` / `cluster.y` are both `null` (default top-right spot) or both the cluster's top-left corner as % of the screen. `settings` by type: `button` `{showBinding}`, `fire` and `lookZone` `{sensitivity, smoothing: off|low|medium|high}`, `joystick` `{stick: left|right, style: fixed|floating, deadzone, stickCurve: linear|exponential, sprint, radius, baseX, baseY}` (`baseX`/`baseY`: fixed base or idle hint position as fractions of the zone, default 0.5/0.68). `lookZone` and `joystick` have `binding: null`. Validation lives in `sanitizeLayout` (`web/js/layout.js`); run any imported layout through it. Profiles and import/export can store and exchange these objects as they are.

## HTTP API

| HTTP | Meaning |
|---|---|
| `GET /api/profiles` | list (`id`, `name`, `mode`), `last` used id, and `problems` (bad files) |
| `POST /api/profiles` | create from a profile body (name made unique) |
| `GET` / `PUT /api/profiles/{id}` | read / save |
| `POST /api/profiles/{id}/rename`, `/duplicate` | rename (`{"name"}`), duplicate |
| `DELETE /api/profiles/{id}` | delete (409 for the last one) |
| `POST /api/profiles/{id}/export-link` | a one-time download link for the file (a browser download can't send the token header); `GET /api/export/{nonce}` downloads it |
| `GET` / `PUT /api/last-profile` | this device's last used profile id |
| `GET /api/devices` | paired devices: role, online, player number |
| `POST /api/devices/{id}/rename` | rename (yourself, or any device if you are the host) |
| `POST /api/devices/{id}/role` | host only: `{"role":"host"}` transfers the host role |
| `POST /api/devices/{id}/forget` | revoke a device (host: any other device; others: themselves) |

Every `/api` call needs the device's `X-Device-Id` and `X-Device-Token` headers.

## Build the packaged app

1. Run `build.bat` (installs `requirements-app.txt` into `.venv`, then PyInstaller). The result is the folder `dist\iPad Gamepad\` with `iPad Gamepad.exe`; copy or run the whole folder (not only the exe).
2. The build bundles `web/`, the icon and the ViGEm **client** DLLs from the `vgamepad` copy in `.venv`. It does not bundle or install the **ViGEmBus driver**: for any XBOX feature (controller devices, XBOX mode, right stick) ViGEmBus must already be installed on the PC (see **XBOX mode**). Without it the app still runs for keyboard and mouse, and says "Controller features unavailable (ViGEmBus missing)".
3. Install `vgamepad` into `.venv` yourself first if you want XBOX features in the build (see **XBOX mode**; it launches the driver installer). `build.bat` prints a note if it is missing.
4. The packaged app writes `app.log` into the data folder (it has no console).

## Source layout

```
app.py              desktop app: server thread + pywebview window + tray, single instance, restart
server/  main.py (FastAPI app, /ws, server thread)   session.py (per-device held state, release)
         injector.py (SendInput)   smoother.py (aim smoothing, 1 kHz thread)   keymap.py (key table)
         gamepad.py (one virtual Xbox 360 pad; vgamepad is imported lazily here only)
         pads.py (virtual pads, XInput slots)   devices.py (paired devices, pairing code)
         profiles.py (profile files + validation)   appsettings.py (KB/M only setting)
         paths.py (data folder, first-run copy)   dashboard.py (/dash feed, admin actions)
         realpads.py (read-only real controllers: XInput + SDL)
web/     index.html, style.css, manifest, js/*.js (the touch app)
web/dashboard/      the PC dashboard page (index.html, dash.css, dash.js)
tools/make_release.py   adds licenses to dist\ and zips the release
```

## Message format (JSON over WebSocket)

| Direction | Message | Meaning |
|---|---|---|
| iPad to PC | `{"t":"m","x":dx,"y":dy}` | relative mouse move |
| | `{"t":"k","k":"w","d":1}` | key down (`d:0` up); names in `server/keymap.py` |
| | `{"t":"b","b":"l","d":1}` | mouse button `l`/`r`/`m` down (`d:0` up) |
| | `{"t":"w","d":1}` | one wheel notch (`1` up, `-1` down) |
| | `{"t":"smooth","ms":8}` | aim smoothing window (0, 8, 16, 24) |
| | `{"t":"mu"}` | an aiming finger lifted: flush buffered aim movement |
| | `{"t":"hello","id":...,"token":...,"name":...}` | first message: who this device is |
| | `{"t":"pair","id":...,"code":"1234","name":...}` | pair with the code shown on the PC |
| | `{"t":"p","id":n}` | ping, sent every 250 ms; also the heartbeat |
| | `{"t":"r"}` | release all |
| | `{"t":"stats","ping":..,"avg":..,"jitter":..,"profile":"..","mode":"wasd","sprint":false,"lock":false}` | report only, about once a second, any role; shown on the PC dashboard |
| | `{"t":"mode","m":"wasd"\|"xbox","pad":true}` | joystick output, and whether the layout needs the virtual pad; sent on connect, on change and after editing |
| | `{"t":"s","x":sx,"y":sy}` | left stick, -1..1, y up is positive |
| | `{"t":"s2","x":sx,"y":sy}` | right stick (right-stick look) |
| | `{"t":"g","b":"a","d":1}` | Xbox button down/up (`a b x y lb rb lt rt l3 r3 start back dpad_up/down/left/right`); sprint uses `l3` |
| PC to device | `{"t":"o","id":n}` | pong, echoed immediately |
| | `{"t":"auth","state":"unpaired"}` / `paired` (with `token`) / `pair_failed` (with `reason`) | the pairing handshake |
| | `{"t":"welcome","role":"host"\|"controller","hostId":...}` | authenticated |
| | `{"t":"role","role":...}` / `{"t":"forgotten"}` | the role changed / the device was revoked |
| | `{"t":"pad","player":n}` | this device's virtual pad and Windows player number (`null` = no pad) |
| | `{"t":"rumble","l":0-255,"s":0-255}` | rumble from the device's pad |
| | `{"t":"n","m":"wasd","msg":"..."}` | notice; `m` forces the mode back (XBOX unavailable) |
| HTTP | `GET /api/keys` | key and Xbox button names the editor can bind |

## Testing without moving your cursor

- `set INPUT_DRY_RUN=1` before starting the server logs input instead of injecting it, and replaces the virtual pads with a fake layer.
- `PAD_FAKE_REAL_SLOTS=0,1` (dry run only) pretends real controllers occupy those XInput slots.
- `PAD_PROFILES_DIR`, `PAD_DEVICES_FILE`, `PAD_SETTINGS_FILE` and `PAD_DATA_DIR` point the server at scratch folders so tests never touch real data. `PAD_PORT` changes the port, `PAD_DASH_TOKEN` fixes the dashboard token, `PAD_NO_MIGRATE=1` skips the first-run copy of old data.

## Notes

- The `ev/s` touch-rate readout still updates but is hidden (remove `hidden` from `#rate` in `web/index.html` to show it).
- Joystick tuning constants (radius, sprint thresholds, hysteresis) are at the top of `web/js/joystick.js`.
- Adding keys: add a scancode to `server/keymap.py`; the editor reads the list from `/api/keys`.
