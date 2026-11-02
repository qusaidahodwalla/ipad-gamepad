# User guide

Details for the features listed in the main [README](../README.md).

## Desktop app and PC dashboard

`app.py` (or the packaged `iPad Gamepad.exe`, below) runs the same server plus a native window and a tray icon. `run.bat` is unchanged: server only, no window.

- **Window:** titled "iPad Gamepad" (Edge WebView2, included in current Windows 10/11). Closing it with X only hides it to the tray.
- **Tray menu:** Show dashboard (also the double-click), Show pairing code, Quit. **Quit is the only thing that stops the app**: it releases every held key and button, removes all our virtual pads and stops the mouse smoothing thread.
- **One copy only:** starting it again just shows the window of the running copy. `"iPad Gamepad.exe" --quit` asks the running copy to quit.
- **Dashboard sections:** *Pairing* (code, new code, address to open on a device); *App devices* (name, role, Player #, connected / reconnect window / offline, ping and jitter, active profile, WASD or XBOX, sprint and lock state, held keys, mouse buttons, mouse movement rate, the device's own virtual pad, and Make host / Forget with the same rules as the iPad Devices dialog); *Virtual controllers* (our pads: slot, Player #, owner, live state); *Real controllers* (read only).
- **Summary bar, views, filters:** the top bar reads "Controllers: N total · XInput slots X/4 used (real R · virtual V) · Other M" and turns amber at 4/4 (extra controllers only work in games that don't use XInput). The header has filter chips (All / App devices / Our pads / Real controllers), three views (**Detailed**; **Grid** of smaller cards that wrap to as many columns as fit; **List** with one row per device: name, type, slot or Player #, ping, two mini stick dots, trigger bars, lit buttons) and a size slider (50-150 %). The choices are remembered between launches, as are the window's size and position (`window.json` in the data folder). Only the visible view and sections are updated.
- **Real controllers:** Xbox-compatible pads on XInput slots 0-3 that are not ours, Xbox-style pads beyond the four slots (read through SDL and marked "outside XInput slots"; SDL cannot tell them apart from our own extra virtual pads, so those cards say so when both exist), plus other gamepads (PlayStation, Switch Pro, generic HID) read through SDL2 (pygame-ce) with HIDAPI switched off and background reads on. The app only polls and reads: no rumble, no LED or feature reports, never opened exclusively, nothing is written to a real controller. Each card shows the controller family, connection (USB, Bluetooth, or unknown when Windows doesn't say) and, for known PlayStation/Switch pads, the proper button names (Cross, Circle, ZL...); a controller SDL has no mapping for shows raw axis and button numbers. If a PlayStation/Switch pad and an Xbox-style pad are both present (Steam Input, DS4Windows and similar emulate Xbox), both are labelled "possible duplicate" instead of being hidden.
- **Live data:** the app devices report `{"t":"stats", ...}` about once a second (ping, jitter, profile name, mode, sprint, lock). It is report only and never changes any input. The dashboard feed (`/dash`, about 30 fps, sent only when something changed) is read on its own thread and only while the window is visible, so it adds no input latency.
- **Security:** `/dash` accepts only a loopback client that presents a random per-launch token and a local Origin (a web page could otherwise open a WebSocket to localhost); admin actions need the token too. The static dashboard page itself is served like the rest of `web/`, but it shows nothing without the token.

### KB/M only mode

For games that refuse to start while a virtual-controller driver is around. When it is **on**, the server never imports `vgamepad` and never loads the ViGEmClient DLL: only keyboard and mouse input (SendInput) is used. (`vgamepad` and the DLL are loaded lazily, only when a virtual pad is first created, in `run.bat` and in the packaged app alike.) It does **not** uninstall the ViGEmBus driver. If a game still objects to the driver being installed, uninstall ViGEmBus yourself (Windows Settings, Apps) and reinstall it when you want controller features back.

- **Set it:** the dashboard header checkbox or the tray item "KB/M only mode". It is saved app-wide in `%APPDATA%\iPadGamepad\settings.json` (not per profile), default off. It takes effect after a restart: the dashboard shows "Restart required" with a Restart button (and the tray gets "Restart now to apply KB/M change"). Restart quits the normal way first (inputs released, virtual pads removed, smoother stopped), then starts a new copy. The server-only `run.bat` has no Restart button: restart it yourself. `set KBM_ONLY=1` before `run.bat` (or the exe) forces it on for that run; the checkbox is then locked.
- **While on:** the dashboard header and the iPad status cluster show **KB/M ONLY**. The host's WASD/XBOX switch is locked to WASD (nothing is saved to the profile). Controls that need a virtual pad (Xbox bindings, right joysticks, look zones and fire buttons set to Right stick) stay visible but greyed and inactive, with the notice "Disabled in KB/M only mode" the first time one is touched; profiles are never modified, so turning the mode off restores everything. Controller-role devices can still pair but get "PC is in KB/M only mode — controllers unavailable". The dashboard's real-controller monitoring (XInput / SDL, read only) still works. `release_all` and all stuck-input protection are unchanged.

## Where your data lives

Profiles and paired devices are in `%APPDATA%\iPadGamepad` (`profiles\`, `devices.json`) for both `run.bat` and the packaged app, so they share one set. The first time that folder is used, any `profiles\` and `devices.json` found in the project folder (or next to / above the packaged app) are **copied** in; the originals stay where they were as a backup and are never changed or deleted. Later runs use only the `%APPDATA%` copy. Set `PAD_DATA_DIR` to use another folder.

## Layout editor

Everything on screen comes from a layout (JSON, saved on the iPad in `localStorage["padLayout"]`).

- **Screen:** the play area is the whole safe-area box (full screen in Home Screen mode). The status cluster (ping, jitter, profile name, WASD/XBOX, fullscreen, lock) floats in the top-right corner over it; in Home Screen mode it sits below the iOS status bar (at least 30 px from the top). Nothing else moves. While editing it shows as a draggable ghost under the edit bar (see **Status bar** below). On the first tap in play mode the app asks the browser for fullscreen and silently ignores a refusal; the fullscreen button in the cluster toggles it (second tap exits, and it does nothing if the browser doesn't support it).
- **Status bar:** tap the status cluster in edit mode to select it and drag it anywhere. It snaps to the grid and always stays fully on screen. Its panel has **Orientation** (horizontal, or vertical so it can sit along a side edge) and **Opacity** (30-100 %). It can't be resized, duplicated or deleted. A button under it is outlined in yellow as a warning, because in play mode the bar takes the touch (zones under it are by design and not flagged). The position is saved in the profile as % of the screen; profiles that never moved it keep the default top-right spot (and in Home Screen mode it still sits below the iOS status bar).
- **Presets:** Default and Mobile FPS are read-only templates. Use them through `New from Default / Mobile FPS` in the profile menu, which makes a profile you can edit. `RESET LAYOUT` restores the preset the current layout is based on (undoable). Mobile FPS is positions only, with plain shapes and text labels.
- **Enter:** long-press the lock icon in the status cluster (about 0.8 s). Entering sends `release_all` and stops all input.
- **Move / resize:** drag a control; drag the blue corner handle to resize (circles stay round). `GRID` snaps to 2 % of the screen. Controls cannot leave the screen. Overlapping controls are outlined in yellow (a button over the look or joystick zone is by design and not flagged).
- **Edit:** tap a control for the side panel: label, shape, opacity (20-100 %), size, binding, hold/toggle, duplicate, delete. Look zone and fire have sensitivity; the joystick has style, deadzone, sprint ring and stick radius.
- **Bindings:** keyboard key (letters, digits, F1-F12, L/R Shift/Ctrl/Alt, Space, Tab, Esc, Enter, Backspace, arrows, Caps), mouse left/right/middle, wheel up/down (one notch per press), or an Xbox button (A, B, X, Y, LB, RB, LT, RT, L3, R3, Start, Back, D-pad).
- **Toggle:** stays down until tapped again, with a glow and an ON tag. `release_all` clears all toggles.
- **Add control:** button, fire button, look zone, joystick (left), right joystick. A profile can have up to one left and one right joystick.
- **Undo** keeps 50 steps. **Reset to default** is also undoable. **Done** returns to play. Changes are saved as you go.

The WASD/XBOX output mode is part of the profile (the switch in the status cluster changes and saves it). If the layout contains any Xbox binding, the PC creates the virtual pad up front (ViGEmBus needed, see below).

The layout file format is in [DEVELOPER_NOTES.md](DEVELOPER_NOTES.md#layout-schema).

## Aim smoothing

Wi-Fi jitter delivers touch deltas in bursts. With smoothing on, the PC does not inject each delta the instant it arrives. Every delta drains linearly over the window and a ~1 kHz thread emits it, so movement is spread evenly in time while the total stays exactly the same (the sub-pixel remainder is kept). Set it per look zone / fire control in the editor panel: `Off` (0 ms, injected immediately, as before), `Low` 8 ms (default), `Medium` 16 ms, `High` 24 ms. The cost is up to that much extra latency on aim.

- Lifting an aiming finger flushes whatever is still buffered at once, so a drag is exact. `release_all`, edit mode and disconnects discard the buffer and the remainder instead, so nothing drifts afterwards.
- The server has one window. The iPad sends it on connect, after editing, and when an aim finger lands on a control whose setting differs. If you aim with two fingers on controls with different settings, the most recent one wins for new movement.
- At startup the PC logs the measured output loop (rate and worst gap) and which timer it uses. It tries a high-resolution waitable timer, then `timeBeginPeriod(1)` plus a short spin.
- The status cluster shows jitter: the standard deviation of ping over the last 10 s.

## Devices, pairing and roles

Several devices can be connected at once. Each has its own session: its held keys and buttons, its virtual pad and its last-used profile, so a disconnect, `release_all` or heartbeat timeout only ever affects that device.

- **Pairing:** a new device sends nothing until it is paired. When an unpaired device connects, the PC terminal prints a 4-digit code. The code is single use, valid for 2 minutes, and five wrong guesses lock pairing for 30 seconds and replace the code. After pairing the PC gives the device a random token (only its SHA-256 is stored, in `devices.json` in the data folder, see **Where your data lives**), which the device keeps. Unpaired devices get no input and a 401 from the API. Everything is plain HTTP on your LAN, so only use this on a network you trust.
- **Roles:** the first device to pair becomes the **host**; later ones are **controllers**. The host may use keyboard, mouse and Xbox output (only one host at a time). A controller can only send Xbox output to its own virtual pad; keyboard, mouse and wheel input from it is dropped with a notice, and the PC refuses to save a controller profile that uses them or mouse look.
- **Devices dialog** (profile menu, or the switcher in play mode): lists every device with its role, online state and player number. Any device can rename itself. Only the **current host** can rename others, make another device the host (the old host becomes a controller and everything it holds is released) or change roles. **Forget** revokes a device's token and removes its virtual pad: the host can forget any other device, and a controller can forget itself; the host can't forget itself.
- **One virtual pad per controller:** created when the controller connects and removed after a 10 second grace period once it disconnects (a quick reconnect keeps the same pad and player number). The host gets a pad too when its profile uses Xbox output. The pad appears in `joy.cpl`.
- **Slots:** Windows allows 4 XInput controllers. Before creating a pad the PC reads XInput slots 0-3 (read-only). A slot counts as used if anything answers there: a real wired or Bluetooth controller, one of our pads, another program's virtual pad. If all four are used the pad is **still created** (the limit is XInput's, not Windows': games using Steam Input, SDL or Windows.Gaming.Input can see more than four), and the device is told "Connected, but XInput-only games may not see this controller (slots 1–4 full)." once. Such an "extra" pad has no XInput slot, so it shows "EXT" instead of "P#" and "Extra controller" on the dashboard (it gets its Player number later if a slot frees up). Only if ViGEm refuses to create another pad is the device told "No controller slots free", and a controller retries every few seconds. Real controllers are never opened, written to or merged: only the pads this program created are ever written.
- **Player number:** the "P1".."P4" badge in the status bar is the pad's Windows slot plus one. The PC prints `[pad] ... slot N` for every pad it creates.
- **Rumble:** if the game rumbles a pad, the PC forwards it to that device. Devices with `navigator.vibrate` (Android Chrome) vibrate; iOS has no vibration and ignores it.

## Right stick look

Look zones and fire buttons have **Aim output**: `Mouse` (relative mouse look, as before) or `Right stick`. In right-stick mode the stick floats: the place you touch is the centre and the drag distance is the deflection. Settings: deadzone (%), max radius (px of drag for full deflection) and response curve (`Linear`, or `Exponential` which is gentle near the centre and fast at the edge). Fire buttons aim the same way. A controller's profile must use Right stick.

## Phone Controller preset

For phones in landscape, 640x360 or larger: left stick, right-stick look zone, A/B/X/Y, LB/RB, LT/RT, D-pad, Start/Back and L3/R3. Every touch target is at least 48 px at 640x360. New controller devices start on it (a profile named "<device> controller"). It's also in **New from...** for any device.

**Phone Controller (Sticks)** is the same layout with a fixed **right joystick** in place of the look zone (R3 moves aside to make room). Both presets are in **New from...**; new controllers still start on the original.

## Profiles

A profile is a name, a layout (all controls, bindings and per-control settings) and the WASD/XBOX output mode. The PC keeps them as JSON files in the `profiles/` folder of the data folder (see **Where your data lives**; one file per profile, named after a stable id, e.g. `my-profile.json`; renaming only changes the name inside). The PC's files are the source of truth, so they survive restarting the server or the device's app, and every paired device shares the same profile folder (each remembers its own last-used profile). Set `PAD_PROFILES_DIR` to use another folder (and `PAD_DEVICES_FILE` for the devices file).

- **iPad cache:** the active profile is also kept in `localStorage["padProfile"]`, so the app loads instantly. Edits are saved to the PC about 0.4 s after they happen. If the PC is unreachable the edits stay on the iPad (marked unsynced, with a notice) and are pushed when it reconnects. On every connect the PC's copy wins unless the iPad has unsent edits.
- **First run:** your previously saved layout and output mode are migrated into a profile named **My layout** (the old `padLayout` key is left in place as a backup).
- **Edit mode:** the profile button in the edit bar opens the menu: switch, New from Default / Mobile FPS, Duplicate, Rename, Delete (with confirmation; the last profile can't be deleted), Export, Import. The menu actions apply to the active profile.
- **Play mode:** long-press the profile name in the status cluster to open a quick switcher. Switching sends `release_all` first.
- **Export / import:** Export downloads the saved profile file. Import adds a file as a **new** profile (a name that already exists gets a number, e.g. "My layout 2") and switches to it; layout and mode are identical to the file. Files are validated on the iPad and again on the PC; a bad file is refused with a message naming the field, and unreadable files in the folder are skipped and reported.
- **Profile file:** `{"version": 1, "name": "...", "mode": "wasd" | "xbox", "layout": { ...layout schema above... }}`.

The HTTP API is listed in [DEVELOPER_NOTES.md](DEVELOPER_NOTES.md#http-api).

## Joystick

| Option | Meaning |
|---|---|
| Stick | `Left` (WASD keys, or the left stick in XBOX mode) or `Right`: the Xbox **right stick**, in any output mode. A profile can have one of each. A right joystick has no sprint |
| Style | `fixed`: base stays put (a touch must start near it). `floating`: base appears under the first touch in the zone |
| Output (status cluster) | `WASD`: 8 directions, diagonals hold two keys, hysteresis on 45 degree edges. `XBOX`: analog left stick |
| Deadzone | 0-40 %, default 15 % (applied on the iPad) |
| Response curve | analog output only (XBOX left stick, right stick): `Linear`, or `Exponential` (gentle near the centre, fast at the edge) |
| Stick radius | px; full deflection (and the 100 % mark for sprint distances) |

A right joystick (or any look/fire in right-stick mode) needs the virtual Xbox pad: with the layout using one, the PC creates the pad even when the output mode is WASD. If the pad can't be created (driver missing, no free slot) the device gets the usual notice. `release_all` and a disconnect center the right stick as well.

### Sprint

All of these are joystick settings in the edit panel, saved in the profile. Distances are a % of the stick radius.

| Option | Meaning |
|---|---|
| Sprint on/off | master switch; when off no sprint ring is drawn |
| Start distance | 50-130 %, default 100 %. Sprint begins when the thumb goes beyond this; the dashed ring on the base is drawn here |
| Stop distance | default start - 10 %, always kept below start. Sprint ends below it, so it can't flicker at the edge |
| Forward only | default on. Sprint only within 45 degrees of straight up (it stays on until 50 degrees, so the cone edge doesn't flicker) |
| Output | `Hold` holds the sprint key/button while sprinting. `Tap` sends one ~40 ms press when sprint starts, and again when it stops if "Tap again on stop" is on (that also fires when you lift the thumb) |
| Sprint key / button | key used in WASD mode (default `lshift`) and Xbox button used in XBOX mode (default `L3`); both editable |
| Sprint lock | default off. Lift the thumb while beyond the start distance and moving forward (within 45 degrees of up) and you keep running forward and sprinting with no finger down. A "LOCK" pill shows. It ends when the stick is touched again and the thumb is below the stop distance; with a floating base the thumb starts at the centre, so touching again ends it at once |

While sprinting the ring is highlighted. `release_all` (leaving the app, edit mode, disconnect, heartbeat loss) clears sprint, sprint lock and any pending tap, and changing WASD/XBOX does too. Profiles saved before these options existed load with sprint on/off as it was and the defaults above.

Keys and stick values are sent only when they change.

## XBOX mode

Only needed for XBOX joystick output or Xbox button bindings. Keyboard and mouse use needs none of this.

1. Install the **ViGEmBus** driver (<https://github.com/nefarius/ViGEmBus/releases>; the project is end-of-life and no longer maintained, but still works at the time of writing). Reboot if the installer asks.
2. Install the Python package into the project's environment:
   `.venv\Scripts\pip install -r requirements-xbox.txt`
   **Note:** `vgamepad` is built from source and its setup launches the bundled ViGEmBus installer (admin approval prompt), so do this deliberately. It is kept out of `requirements.txt` for that reason.
3. Switch the status cluster to `XBOX`. The virtual Xbox 360 controller is created the first time you do, and unplugged again when you switch back to `WASD`. Check it in `joy.cpl` (Set up USB game controllers).

If the driver or package is missing, the PC logs a message, the iPad shows a notice, and the mode falls back to WASD.

Mouse look still goes through the mouse in both modes. Some games switch their on-screen prompts to controller glyphs while an Xbox pad is active.

## Stuck-input protection

The PC releases every key, mouse button and Xbox input **that device** holds (and centers its virtual sticks) when its socket closes, when no message arrives from it for 1 second, when it sends `r`, or when the same device reconnects. Other devices are never affected. The iPad sends `r` when the page is hidden, loses focus, is closed, or enters edit mode, and clears its own toggle states at the same time.
