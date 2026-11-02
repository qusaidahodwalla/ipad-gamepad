import { applyCluster } from "./cluster.js";
import { Controls } from "./controls.js";
import { DeviceIdentity } from "./device.js";
import { showDevices } from "./devices-ui.js";
import { pairingDialog } from "./dialog.js";
import { Editor } from "./editor.js";
import { Hud } from "./hud.js";
import { needsXbox, roleProblems, usesXboxBinding } from "./layout.js";
import { Net } from "./net.js";
import { ProfileUI } from "./profile-ui.js";
import { ProfileStore, setApiAuth } from "./profiles.js";
import { Settings } from "./settings.js";

const LONG_PRESS_MS = 800;
// What would move the PC's real keyboard or mouse. A controller can't send these (the PC drops them).
const HOST_ONLY = new Set(["k", "b", "w", "m", "mu", "smooth"]);

// Home Screen app: lets the CSS keep the status cluster clear of the iOS status bar.
if (
  navigator.standalone ||
  matchMedia("(display-mode: standalone)").matches ||
  matchMedia("(display-mode: fullscreen)").matches
) {
  document.documentElement.classList.add("standalone");
}

// This device's identity (id, pairing token, name) and what the PC says its role is.
const identity = new DeviceIdentity();
setApiAuth(() => identity.headers());
let role = null; // "host" | "controller", known once the PC has welcomed this device

const hud = new Hud();
const toast = (msg) => hud.toast(msg);
const store = new ProfileStore({ toast });
const settings = new Settings(store.mode);
hud.bindSettings(settings);
let editing = false;
let kbm = false; // the PC runs in KB/M only mode: no virtual pads, WASD only (profiles are never changed for it)

/** Tell the PC the joystick output mode and whether the layout needs a virtual Xbox pad. */
function announce() {
  net.send({ t: "mode", m: settings.get("mode"), pad: !kbm && usesXboxBinding(store.layout) });
  controls.announceSmoothing(); // no-op while editing; exitEdit announces again
}

// ---- Pairing ----

let pairing = null; // the open pairing dialog, if any

function showPairing() {
  if (pairing) return;
  pairing = pairingDialog({
    name: identity.name,
    onSubmit: ({ name, code }) => {
      identity.setName(name);
      net.send({ t: "pair", id: identity.id, code, name });
    },
  });
}

function hidePairing() {
  pairing?.close();
  pairing = null;
}

// ---- Roles ----

/** Tell a controller when its profile has controls it can't use (keyboard, mouse, mouse look). */
function warnRoleProblems() {
  const problems = roleProblems(store.layout, role);
  if (problems.length) {
    toast(`This profile has ${problems.length} control${problems.length > 1 ? "s" : ""} a controller can't use (keyboard or mouse). They do nothing.`);
  }
}

function applyRole(next) {
  role = next;
  hud.setRole(role);
  editor.setRole(role);
  if (role === "controller") {
    settings.set("mode", "xbox"); // keyboard output isn't available to a controller
    warnRoleProblems();
  }
  profileUI.refresh();
}

/** A controller runs on a phone-style profile: reuse its own one, or make it from the Phone preset. */
async function ensureControllerProfile() {
  const wanted = `${identity.name} controller`;
  try {
    const info = await store.list();
    const mine = info.profiles.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
    if (mine) await store.activate(mine.id);
    else await store.createControllerDefault(wanted.slice(0, 40));
  } catch (err) {
    toast(`Couldn't set up a controller profile: ${err.message}`);
  }
}

// ---- Network ----

let lastBuzz = 0;
/** Android: forward rumble from this device's virtual pad. iOS has no vibration, so this is skipped. */
function buzz(large, small) {
  if (!navigator.vibrate) return;
  const strength = Math.max(large, small);
  if (strength === 0) {
    navigator.vibrate(0);
    return;
  }
  const now = performance.now();
  if (now - lastBuzz < 60) return; // games update rumble very often
  lastBuzz = now;
  navigator.vibrate(Math.round(30 + (strength / 255) * 120));
}

const net = new Net({
  hello: () => ({ t: "hello", id: identity.id, token: identity.token, name: identity.name }),
  onStatus: (online) => hud.setOnline(online),
  onRtt: (ms) => hud.addRtt(ms),
  // Socket gone: the PC releases this device's inputs; clear local state (incl. toggles) so the visuals match.
  onClose: () => {
    controls.resetAll();
    hud.setPlayer(null);
  },
  onAuth: () => showPairing(), // the PC doesn't know this device yet
  onPaired: (msg) => identity.setToken(msg.token),
  onPairFailed: (msg) => pairing?.setMessage(msg.reason, true),
  onWelcome: (msg) => {
    hidePairing();
    identity.setName(msg.name);
    applyKbm(!!msg.kbm);
    applyRole(msg.role);
    announce(); // each connection starts with no mode on the PC
    if (msg.role === "controller" && msg.defaultProfile) ensureControllerProfile();
    else store.sync(); // the PC's profile files are the source of truth
  },
  onForgotten: () => {
    identity.forgetToken();
    role = null;
    toast("This device was removed from the PC. Pair it again to use it.");
  },
  onMessage: (msg) => {
    if (msg.t === "n") {
      // A notice from the PC; it may also force WASD back (XBOX unavailable).
      toast(msg.msg);
      if (msg.m) settings.set("mode", msg.m);
    } else if (msg.t === "pad") {
      const first = !document.getElementById("player").textContent;
      hud.setPlayer(msg.player, msg.extra);
      if (msg.player && first) toast(`You are Player ${msg.player}`);
    } else if (msg.t === "rumble") {
      buzz(msg.l, msg.s);
    } else if (msg.t === "role") {
      // The host moved the host role: release everything and re-announce under the new role.
      releaseAll();
      applyRole(msg.role);
      toast(msg.role === "host" ? "This device is now the host." : "This device is now a controller.");
      announce();
      if (msg.role === "controller" && roleProblems(store.layout, "controller").length) ensureControllerProfile();
    }
  },
});

let lastBlockedNotice = -Infinity;
// Controls send through this gate: nothing leaves while editing, and a controller can't send keyboard/mouse.
const send = (msg) => {
  if (editing) return;
  if (role === "controller" && HOST_ONLY.has(msg.t)) {
    const now = performance.now();
    if (msg.t !== "smooth" && msg.t !== "mu" && now - lastBlockedNotice > 5000) {
      lastBlockedNotice = now;
      toast("This device is a controller: keyboard and mouse controls are disabled.");
    }
    return;
  }
  net.send(msg);
};
const controls = new Controls(document.getElementById("stage"), send, hud, settings);
controls.load(store.layout);
applyCluster(store.layout.cluster);
settings.on("mode", announce);
settings.on("mode", (mode) => { if (!kbm) store.setMode(mode); }); // the output mode is saved with the profile (not the KB/M only override)

controls.disabled = (c) => kbm && needsXbox(c);
controls.onDisabledTouch = () => toast("Disabled in KB/M only mode");

/** KB/M only mode: lock WASD and grey out what needs a virtual pad. The profile itself is never touched. */
function applyKbm(on) {
  if (on === kbm) return;
  kbm = on;
  hud.setKbm(on);
  controls.warned = false;
  if (on) settings.set("mode", "wasd"); // the listener above skips saving it
  else settings.set("mode", role === "controller" ? "xbox" : store.mode); // back to the profile's own mode
  if (!editing) {
    controls.load(store.layout);
    announce();
  }
}

// Report-only numbers for the PC dashboard, about once a second. They never change any input.
setInterval(() => {
  if (!net.authed) return;
  net.send({ t: "stats", ...hud.pingStats(), profile: store.name, mode: settings.get("mode"), ...controls.sprintState() });
}, 1000);

function releaseAll() {
  net.send({ t: "r" });
  controls.resetAll();
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseAll();
});
window.addEventListener("blur", releaseAll);
window.addEventListener("pagehide", releaseAll);

// ---- Profiles and devices ----

const openDevices = () => showDevices({ identity, toast, getRole: () => role });
const profileUI = new ProfileUI({ store, toast, getRole: () => role, openDevices });
store.onBeforeSwitch = () => releaseAll(); // everything up before another profile loads
store.onActivated = () => {
  releaseAll();
  settings.set("mode", role === "controller" ? "xbox" : kbm ? "wasd" : store.mode); // the profile's own output mode
  if (editing) editor.reload();
  else controls.load(store.layout);
  applyCluster(store.layout.cluster);
  announce();
  profileUI.refresh();
  if (role === "controller") warnRoleProblems();
};
store.onRenamed = () => profileUI.refresh();

// ---- Edit mode ----

const editor = new Editor({ stage: document.getElementById("stage"), store, onDone: exitEdit });

function enterEdit() {
  if (editing) return;
  releaseAll(); // everything up on the PC and on screen, toggles included
  editing = true;
  profileUI.close();
  controls.unload();
  editor.start();
}

function exitEdit() {
  if (!editing) return;
  editor.stop();
  editing = false;
  profileUI.close();
  controls.load(store.layout);
  applyCluster(store.layout.cluster);
  announce(); // the layout may now need (or no longer need) the virtual Xbox pad
  store.flush(); // make sure the PC has the final version
}

// The lock needs a deliberate long press so it cannot be triggered mid-game.
const lock = document.getElementById("lock-btn");
let lockTimer = null;
const cancelLock = (e) => {
  if (lockTimer === null) return;
  clearTimeout(lockTimer);
  lockTimer = null;
  lock.classList.remove("holding");
  if (e.type === "pointerup") hud.toast("Hold the lock to edit the layout");
};
lock.addEventListener("pointerdown", () => {
  lock.classList.add("holding");
  lockTimer = setTimeout(() => {
    lockTimer = null;
    lock.classList.remove("holding");
    enterEdit();
  }, LONG_PRESS_MS);
});
for (const type of ["pointerup", "pointercancel", "pointerleave"]) lock.addEventListener(type, cancelLock);

// Ask for fullscreen on the first tap in play mode. Browsers only allow it from a real tap, and
// iPad Home Screen apps may refuse it: any failure is ignored and nothing about the layout changes.
let triedFullscreen = false;
document.addEventListener(
  "pointerup",
  (e) => {
    if (triedFullscreen || editing || e.target.closest("#fs-btn")) return; // the button handles its own taps
    triedFullscreen = true;
    try {
      const root = document.documentElement;
      const request = root.requestFullscreen ?? root.webkitRequestFullscreen;
      request?.call(root)?.catch?.(() => {});
    } catch {}
  },
  true,
);

// Fullscreen button in the status cluster: toggles; unsupported or refused requests do nothing.
const fsBtn = document.getElementById("fs-btn");
const fullscreenElement = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
if (!(document.documentElement.requestFullscreen ?? document.documentElement.webkitRequestFullscreen)) {
  fsBtn.classList.add("unsupported");
}
fsBtn.addEventListener("click", () => {
  try {
    const root = document.documentElement;
    const result = fullscreenElement()
      ? (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document)
      : (root.requestFullscreen ?? root.webkitRequestFullscreen)?.call(root);
    result?.catch?.(() => {});
  } catch {}
});
for (const type of ["fullscreenchange", "webkitfullscreenchange"]) {
  document.addEventListener(type, () => fsBtn.classList.toggle("on", !!fullscreenElement()));
}

// Block browser gestures (pinch, double-tap zoom, context menu, rubber-band scroll).
for (const type of ["gesturestart", "gesturechange", "gestureend", "contextmenu"]) {
  document.addEventListener(type, (e) => e.preventDefault());
}
document.addEventListener(
  "touchmove",
  (e) => {
    // Sliders, the editor side panel, the profile lists and dialogs need native touch handling.
    if (e.target.type !== "range" && !e.target.closest("#panel, #profile-menu, #switcher, .dialog-backdrop")) e.preventDefault();
  },
  { passive: false },
);

net.connect();
