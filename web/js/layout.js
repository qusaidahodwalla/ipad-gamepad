// Layout data: schema, defaults, presets, sanitizing. Storage lives in profiles.js.
//
// A layout is plain JSON so profiles / import / export can be added later by storing and
// exchanging these objects (run foreign ones through sanitizeLayout first).
//
// {
//   "version": 1,
//   "controls": [{
//     "id": "fire", "type": "button" | "fire" | "lookZone" | "joystick",
//     "x": 86.4, "y": 79.6, "w": 10.05, "h": 15.11,      // % of the play area (below the top bar)
//     "label": "FIRE", "opacity": 0.2..1, "shape": "circle" | "rounded",
//     "binding": { "kind": "key" | "mouse" | "wheel" | "xbox", "value": "..." } | null,
//     "mode": "hold" | "toggle",
//     "settings": { ... per type, see defaultSettingsFor ... }
//   }]
// }

export const LAYOUT_VERSION = 1;
const STORAGE_KEY = "padLayout";

export const TYPES = ["button", "fire", "lookZone", "joystick"];
export const TYPE_NAMES = { button: "Button", fire: "Fire button", lookZone: "Look zone", joystick: "Joystick" };
export const MOUSE_VALUES = ["left", "right", "middle"];
export const WHEEL_VALUES = ["up", "down"];
export const FALLBACK_XBOX = [
  "a", "b", "x", "y", "lb", "rb", "lt", "rt", "l3", "r3", "start", "back",
  "dpad_up", "dpad_down", "dpad_left", "dpad_right",
];
/** Aim smoothing windows in ms (applied on the PC). */
export const SMOOTHING = { off: 0, low: 8, medium: 16, high: 24 };
export const MIN_W = 4;
export const MIN_H = 5;

const PRETTY = {
  lshift: "L Shift", rshift: "R Shift", lctrl: "L Ctrl", rctrl: "R Ctrl", lalt: "L Alt", ralt: "R Alt",
  space: "Space", tab: "Tab", esc: "Esc", enter: "Enter", backspace: "Backspace", caps: "Caps Lock",
  up: "Up", down: "Down", left: "Left", right: "Right",
  dpad_up: "D-pad Up", dpad_down: "D-pad Down", dpad_left: "D-pad Left", dpad_right: "D-pad Right",
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export const prettyName = (name) => PRETTY[name] ?? String(name).toUpperCase();

export function bindingText(b) {
  if (!b) return "";
  if (b.kind === "key") return prettyName(b.value);
  if (b.kind === "mouse") return `Mouse ${cap(b.value)}`;
  if (b.kind === "wheel") return `Wheel ${cap(b.value)}`;
  return `Xbox ${prettyName(b.value)}`;
}

/** The status cluster (ping, profile, mode, fullscreen, lock). x/y null = the default top-right spot. */
export const defaultCluster = () => ({ x: null, y: null, orientation: "horizontal", opacity: 1 });

export function sanitizeCluster(raw) {
  const d = defaultCluster();
  const src = raw && typeof raw === "object" ? raw : {};
  const placed = typeof src.x === "number" && Number.isFinite(src.x) && typeof src.y === "number" && Number.isFinite(src.y);
  return {
    x: placed ? Math.min(100, Math.max(0, src.x)) : null,
    y: placed ? Math.min(100, Math.max(0, src.y)) : null,
    orientation: src.orientation === "vertical" ? "vertical" : d.orientation,
    opacity: typeof src.opacity === "number" && Number.isFinite(src.opacity) ? Math.min(1, Math.max(0.3, src.opacity)) : d.opacity,
  };
}

export function defaultSettingsFor(type) {
  if (type === "button") return { showBinding: true };
  // output "mouse" = relative mouse look; "stick" = right stick (floating: the touch point is the centre,
  // stickRadius px of drag = full deflection, stickDeadzone %, stickCurve linear | exponential).
  if (type === "fire" || type === "lookZone") {
    return { sensitivity: 1.5, smoothing: "low", output: "mouse", stickDeadzone: 10, stickRadius: 90, stickCurve: "linear" };
  }
  // baseX/baseY: where the base sits (fixed style) or is hinted (floating), as fractions of the zone.
  if (type === "joystick") {
    return {
      style: "fixed", deadzone: 15, radius: 72, baseX: 0.5, baseY: 0.68,
      // stick: "left" (WASD keys, or the left stick in XBOX mode) or "right" (always the right stick; no sprint).
      // stickCurve shapes the analog output: linear, or exponential (gentle near the centre).
      stick: "left", stickCurve: "linear",
      // Sprint: `sprint` is the master switch. Distances are % of the stick radius.
      sprint: true, sprintStart: 100, sprintStop: 90, sprintForwardOnly: true,
      sprintStyle: "hold", sprintTapStop: false, sprintKey: "lshift", sprintPad: "l3", sprintLock: false,
    };
  }
  return {};
}

const TEMPLATES = {
  button: { w: 12, h: 12, label: "BTN", shape: "rounded", binding: { kind: "key", value: "space" } },
  fire: { w: 10.05, h: 15.11, label: "FIRE", shape: "circle", binding: { kind: "mouse", value: "left" } },
  lookZone: { w: 40, h: 60, label: "LOOK", shape: "rounded", binding: null },
  joystick: { w: 40, h: 60, label: "MOVE", shape: "rounded", binding: null },
};

let idCounter = 0;
export const newId = (type) => `${type}-${Date.now().toString(36)}${(idCounter++).toString(36)}`;

/** A new control of the given type, centred on screen. */
export function makeControl(type, overrides = {}) {
  const t = TEMPLATES[type];
  return {
    id: newId(type),
    type,
    x: +((100 - t.w) / 2).toFixed(2),
    y: +((100 - t.h) / 2).toFixed(2),
    w: t.w,
    h: t.h,
    label: t.label,
    opacity: 1,
    shape: t.shape,
    binding: t.binding ? { ...t.binding } : null,
    mode: "hold",
    settings: defaultSettingsFor(type),
    ...overrides,
  };
}

/** Legacy (Phase 1-2) tuning, read once so the first default layout keeps the user's feel. */
export function readLegacy() {
  const out = {};
  try {
    const s = JSON.parse(localStorage.getItem("padSettings") || "{}");
    if (s.style === "fixed" || s.style === "floating") out.style = s.style;
    if (typeof s.deadzone === "number") out.deadzone = s.deadzone;
    if (typeof s.sprint === "boolean") out.sprint = s.sprint;
    const sens = parseFloat(localStorage.getItem("sens"));
    if (Number.isFinite(sens)) out.sens = sens;
  } catch {}
  return out;
}

/**
 * The shipped layout: reproduces the Phase 2 geometry on a 1194x794 play area.
 * Zones come first so they sit under the buttons.
 */
export function defaultLayout(legacy = {}) {
  const sens = legacy.sens ?? 1.5;
  const c = (type, id, geo, extra) => makeControl(type, { id, ...geo, ...extra });
  return {
    version: LAYOUT_VERSION,
    preset: "default",
    cluster: defaultCluster(),
    controls: [
      c("lookZone", "look", { x: 45, y: 1.76, w: 53.9, h: 96.47 }, {
        settings: { ...defaultSettingsFor("lookZone"), sensitivity: sens },
      }),
      c("joystick", "move", { x: 1.2, y: 1.76, w: 40, h: 96.47 }, {
        settings: {
          ...defaultSettingsFor("joystick"),
          style: legacy.style ?? "fixed",
          deadzone: legacy.deadzone ?? 15,
          sprint: legacy.sprint ?? true,
        },
      }),
      c("button", "jump", { x: 2.18, y: 3.27, w: 13.3, h: 10.58 }, {
        label: "JUMP", binding: { kind: "key", value: "space" },
      }),
      c("button", "crouch", { x: 16.33, y: 3.27, w: 13.3, h: 10.58 }, {
        label: "CROUCH", binding: { kind: "key", value: "c" },
      }),
      c("button", "reload", { x: 30.49, y: 3.27, w: 13.3, h: 10.58 }, {
        label: "RELOAD", binding: { kind: "key", value: "r" },
      }),
      c("button", "ads", { x: 77.55, y: 84.13, w: 7.04, h: 10.58 }, {
        label: "ADS", shape: "circle", binding: { kind: "mouse", value: "right" },
        settings: { showBinding: false },
      }),
      c("fire", "fire", { x: 86.43, y: 79.6, w: 10.05, h: 15.11 }, {
        label: "FIRE", shape: "circle", binding: { kind: "mouse", value: "left" },
        settings: { ...defaultSettingsFor("fire"), sensitivity: sens },
      }),
    ],
  };
}

// ---- Mobile FPS preset (positions only: plain shapes and text labels) ----

// Reference stage used to turn "diameter as % of height" into the stored w (% of width).
// Circles render from h and keep their centre, so w only matters for that centre.
const REF = { w: 1194, h: 834 };
const r2 = (v) => Math.round(v * 100) / 100;
/** Circle centred at (X, Y) % with diameter d % of screen height. */
const circle = (X, Y, d, ref = REF) => {
  const w = (d * ref.h) / ref.w;
  return { x: r2(X - w / 2), y: r2(Y - d / 2), w: r2(w), h: d };
};
/** Rectangle centred at (X, Y) % of size W x H %. */
const rect = (X, Y, W, H) => ({ x: r2(X - W / 2), y: r2(Y - H / 2), w: W, h: H });

export function mobileFpsLayout() {
  const key = (value) => ({ kind: "key", value });
  const btn = (id, label, geo, binding, extra = {}) =>
    makeControl("button", { id, label, binding, ...geo, ...extra });
  const round = { shape: "circle" };
  return {
    version: LAYOUT_VERSION,
    preset: "mobile-fps",
    cluster: defaultCluster(),
    controls: [
      // Zones first so they sit behind every button.
      makeControl("lookZone", { id: "look", label: "LOOK", x: 45, y: 0, w: 55, h: 100 }),
      makeControl("joystick", {
        id: "move", label: "MOVE", x: 0, y: 0, w: 40, h: 100,
        // Floating base within the left zone; idle hint at X16 Y85, base d15% of height.
        settings: { ...defaultSettingsFor("joystick"), style: "floating", radius: 63, baseX: 0.4, baseY: 0.85 },
      }),
      btn("melee", "Melee", circle(6, 25, 15), key("v"), round),
      makeControl("fire", { id: "fire-left", label: "Left Fire", ...circle(6, 46, 16), shape: "circle" }),
      btn("special", "Special", circle(17, 48, 10), key("f"), round),
      btn("sprint", "Sprint", circle(16, 59, 7), key("lshift"), { ...round, mode: "toggle" }),
      btn("streak1", "Streak 1", rect(30, 90, 6, 6), key("3")),
      btn("streak2", "Streak 2", rect(36, 90, 6, 6), key("4")),
      btn("streak3", "Streak 3", rect(42, 90, 6, 6), key("5")),
      btn("swap", "Weapon swap", rect(49, 77, 19, 7.5), { kind: "wheel", value: "up" }),
      btn("primary", "Primary", rect(81, 38, 12, 6), key("1")),
      btn("secondary", "Secondary", rect(92, 38, 10, 6), key("2")),
      btn("reload", "Reload", circle(95, 30, 10), key("r"), round),
      btn("ads", "ADS", circle(76, 51, 9.5), { kind: "mouse", value: "right" }, round),
      btn("crouch", "Crouch", circle(84.5, 52, 12), key("c"), round),
      btn("prone", "Prone", circle(93, 48, 12.5), key("lctrl"), round),
      btn("jump", "Jump", circle(81, 62, 7.5), key("space"), round),
      btn("tactical", "Tactical", circle(88, 62, 7), key("q"), round),
      btn("grenade2", "Grenade 2", circle(93.5, 59, 7), key("g"), round),
      btn("lethal", "Lethal", circle(94, 71, 7), key("e"), round),
    ],
  };
}

// ---- Phone Controller preset: Xbox output only, for phones in landscape (640x360 or larger) ----
//
// Every touch target is at least 48 px at 640x360: 14 % of the height is 50 px, and shoulder buttons
// are 14 % x 14 % (90 x 50 px). Output is all Xbox (left stick, right stick look, buttons).

const PHONE_REF = { w: 640, h: 360 };

export function phoneLayout() {
  const D = 14; // button diameter, % of screen height
  const dot = (id, label, X, Y, value) => makeControl("button", {
    id, label, shape: "circle", binding: { kind: "xbox", value }, ...circle(X, Y, D, PHONE_REF),
    settings: { showBinding: false },
  });
  const key = (id, label, X, Y, W, value) => makeControl("button", {
    id, label, binding: { kind: "xbox", value }, ...rect(X, Y, W, 14), settings: { showBinding: false },
  });
  return {
    version: LAYOUT_VERSION,
    preset: "phone",
    // The status bar sits in a free row under the shoulder buttons, translucent.
    cluster: { x: 21, y: 18.5, orientation: "horizontal", opacity: 0.7 },
    controls: [
      makeControl("lookZone", {
        id: "look", label: "LOOK (RIGHT STICK)", x: 42, y: 20, w: 58, h: 80,
        settings: { ...defaultSettingsFor("lookZone"), output: "stick", stickRadius: 70, smoothing: "off" },
      }),
      makeControl("joystick", {
        id: "move", label: "MOVE (LEFT STICK)", x: 0, y: 56, w: 38, h: 44,
        settings: { ...defaultSettingsFor("joystick"), style: "floating", radius: 48, sprint: false, baseY: 0.55 },
      }),
      key("lt", "LT", 9, 10.5, 14, "lt"),
      key("lb", "LB", 25, 10.5, 14, "lb"),
      key("back", "Back", 40.5, 10.5, 10, "back"),
      key("start", "Start", 53.5, 10.5, 10, "start"),
      key("rb", "RB", 75, 10.5, 14, "rb"),
      key("rt", "RT", 91, 10.5, 14, "rt"),
      dot("dup", "Up", 14, 26, "dpad_up"),
      dot("dleft", "Left", 5.5, 40, "dpad_left"),
      dot("dright", "Right", 22.5, 40, "dpad_right"),
      dot("ddown", "Down", 14, 54, "dpad_down"),
      dot("y", "Y", 86, 38, "y"),
      dot("x", "X", 77, 54, "x"),
      dot("b", "B", 95, 54, "b"),
      dot("a", "A", 86, 70, "a"),
      dot("l3", "L3", 35, 88, "l3"),
      dot("r3", "R3", 65, 88, "r3"),
    ],
  };
}

/**
 * Phone Controller (Sticks): the same layout with a fixed right joystick instead of the look zone.
 * Built from phoneLayout(), which is left exactly as it was.
 */
export function phoneSticksLayout() {
  const base = phoneLayout();
  const controls = base.controls.filter((c) => c.id !== "look");
  const rstick = makeControl("joystick", {
    id: "rstick", label: "RIGHT STICK", x: 40, y: 50, w: 32, h: 50,
    settings: {
      ...defaultSettingsFor("joystick"), stick: "right", style: "fixed", radius: 48, deadzone: 10,
      sprint: false, baseX: 0.5, baseY: 0.55,
    },
  });
  // R3 moves aside so it doesn't sit on the stick's base.
  Object.assign(controls.find((c) => c.id === "r3"), circle(74, 88, 14, PHONE_REF));
  return { ...base, preset: "phone-sticks", controls: [rstick, ...controls] };
}

// roles: who may use the preset. A controller can only send Xbox output.
export const PRESETS = [
  { id: "default", name: "Default", build: () => defaultLayout(), roles: ["host"] },
  { id: "mobile-fps", name: "Mobile FPS", build: mobileFpsLayout, roles: ["host"] },
  { id: "phone", name: "Phone Controller", build: phoneLayout, roles: ["host", "controller"] },
  { id: "phone-sticks", name: "Phone Controller (Sticks)", build: phoneSticksLayout, roles: ["host", "controller"] },
];
const PRESET_IDS = PRESETS.map((p) => p.id);
/** Old preset ids saved in existing profiles, mapped to their current ids (so nothing breaks). */
const PRESET_ALIASES = { codm: "mobile-fps" };
const presetId = (id) => PRESET_ALIASES[id] ?? id;

/**
 * Make stored circle widths consistent with their heights on this screen (diameter follows
 * height, centre stays put). The editor calls this so its percent maths matches what is drawn.
 */
export function fitCircles(layout, W, H) {
  for (const c of layout.controls) {
    if (c.shape !== "circle" || !c.binding) continue;
    const cx = c.x + c.w / 2;
    c.w = r2((c.h * H) / W);
    c.x = r2(Math.min(Math.max(cx - c.w / 2, 0), 100 - c.w));
  }
}

const num = (v, min, max, fallback) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

function sanitizeBinding(b, fallback) {
  if (!b || typeof b !== "object" || typeof b.value !== "string") return fallback;
  if (b.kind === "mouse" && MOUSE_VALUES.includes(b.value)) return { kind: "mouse", value: b.value };
  if (b.kind === "wheel" && WHEEL_VALUES.includes(b.value)) return { kind: "wheel", value: b.value };
  if (b.kind === "key" || b.kind === "xbox") return { kind: b.kind, value: b.value.slice(0, 24) };
  return fallback;
}

/** Sprint options. Stop is kept below start so sprint cannot flicker at the edge. */
function sanitizeSprint(src, d) {
  const start = Math.round(num(src.sprintStart, 50, 130, d.sprintStart));
  const stopWanted = Math.round(num(src.sprintStop, 10, 129, Math.max(10, start - 10)));
  return {
    sprintStart: start,
    sprintStop: Math.min(stopWanted, start - 1),
    sprintForwardOnly: typeof src.sprintForwardOnly === "boolean" ? src.sprintForwardOnly : d.sprintForwardOnly,
    sprintStyle: src.sprintStyle === "tap" ? "tap" : "hold",
    sprintTapStop: typeof src.sprintTapStop === "boolean" ? src.sprintTapStop : d.sprintTapStop,
    sprintKey: typeof src.sprintKey === "string" && src.sprintKey && src.sprintKey.length <= 24 ? src.sprintKey : d.sprintKey,
    sprintPad: typeof src.sprintPad === "string" && src.sprintPad && src.sprintPad.length <= 24 ? src.sprintPad : d.sprintPad,
    sprintLock: typeof src.sprintLock === "boolean" ? src.sprintLock : d.sprintLock,
  };
}

function sanitizeSettings(type, s) {
  const d = defaultSettingsFor(type);
  const src = s && typeof s === "object" ? s : {};
  if (type === "button") return { showBinding: typeof src.showBinding === "boolean" ? src.showBinding : d.showBinding };
  if (type === "fire" || type === "lookZone") {
    return {
      sensitivity: num(src.sensitivity, 0.2, 4, d.sensitivity),
      smoothing: Object.hasOwn(SMOOTHING, src.smoothing) ? src.smoothing : d.smoothing,
      output: src.output === "stick" ? "stick" : "mouse",
      stickDeadzone: Math.round(num(src.stickDeadzone, 0, 40, d.stickDeadzone)),
      stickRadius: Math.round(num(src.stickRadius, 30, 200, d.stickRadius)),
      stickCurve: src.stickCurve === "exponential" ? "exponential" : "linear",
    };
  }
  if (type === "joystick") {
    return {
      style: src.style === "floating" ? "floating" : "fixed",
      deadzone: Math.round(num(src.deadzone, 0, 40, d.deadzone)),
      sprint: typeof src.sprint === "boolean" ? src.sprint : d.sprint,
      radius: Math.round(num(src.radius, 40, 110, d.radius)),
      baseX: num(src.baseX, 0, 1, d.baseX),
      baseY: num(src.baseY, 0, 1, d.baseY),
      stick: src.stick === "right" ? "right" : "left",
      stickCurve: src.stickCurve === "exponential" ? "exponential" : "linear",
      ...sanitizeSprint(src, d),
    };
  }
  return {};
}

/** Returns a clean layout, or null if `raw` is not a usable version-1 layout. */
export function sanitizeLayout(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== LAYOUT_VERSION || !Array.isArray(raw.controls)) return null;
  const seen = new Set();
  const controls = [];
  for (const r of raw.controls) {
    if (!r || typeof r !== "object" || !TYPES.includes(r.type)) continue;
    const t = TEMPLATES[r.type];
    const w = num(r.w, MIN_W, 100, t.w);
    const h = num(r.h, MIN_H, 100, t.h);
    let id = typeof r.id === "string" && r.id && !seen.has(r.id) ? r.id : newId(r.type);
    seen.add(id);
    const hasBinding = r.type === "button" || r.type === "fire";
    controls.push({
      id,
      type: r.type,
      x: num(r.x, 0, 100 - w, 0),
      y: num(r.y, 0, 100 - h, 0),
      w,
      h,
      label: typeof r.label === "string" ? r.label.slice(0, 24) : t.label,
      opacity: num(r.opacity, 0.2, 1, 1),
      // Zones are hit-tested as rectangles, so they are never drawn as circles.
      shape: hasBinding && (r.shape === "circle" || r.shape === "rounded") ? r.shape : hasBinding ? t.shape : "rounded",
      binding: hasBinding ? sanitizeBinding(r.binding, { ...t.binding }) : null,
      mode: r.mode === "toggle" && hasBinding ? "toggle" : "hold",
      settings: sanitizeSettings(r.type, r.settings),
    });
  }
  return {
    version: LAYOUT_VERSION,
    preset: PRESET_IDS.includes(presetId(raw.preset)) ? presetId(raw.preset) : "default",
    cluster: sanitizeCluster(raw.cluster),
    controls,
  };
}

/** True when this control needs the virtual Xbox pad: an Xbox binding, a right-stick look/fire, or a right joystick. */
export const needsXbox = (c) =>
  (c.binding && c.binding.kind === "xbox") ||
  ((c.type === "lookZone" || c.type === "fire") && c.settings.output === "stick") ||
  (c.type === "joystick" && c.settings.stick === "right");

/** True when any control needs the virtual Xbox pad. */
export const usesXboxBinding = (layout) => layout.controls.some(needsXbox);

/**
 * What a controller can't do in this layout (it has Xbox output only): keyboard/mouse/wheel
 * bindings and mouse look. Empty list = fine. The PC refuses such profiles for controllers.
 */
export function roleProblems(layout, role) {
  if (role !== "controller") return [];
  const out = [];
  for (const c of layout.controls) {
    if (c.binding && c.binding.kind !== "xbox") out.push(`"${c.label || c.id}" uses a ${c.binding.kind} binding`);
    if ((c.type === "lookZone" || c.type === "fire") && c.settings.output !== "stick") out.push(`"${c.label || c.id}" aims with the mouse`);
  }
  return out;
}

/** Make a control valid for a controller: Xbox binding, right-stick look. */
export function adaptForController(c) {
  if (c.binding && c.binding.kind !== "xbox") c.binding = { kind: "xbox", value: "a" };
  if (c.type === "lookZone" || c.type === "fire") c.settings.output = "stick";
  return c;
}

/** The layout saved by Phases 3-4 (before profiles), sanitized, or null. Read once for migration. */
export function loadLegacyLayout() {
  try {
    return sanitizeLayout(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return null;
  }
}

/** Build a fresh layout from a built-in preset id (unknown ids fall back to Default). */
export function buildPreset(id) {
  return (PRESETS.find((p) => p.id === presetId(id)) ?? PRESETS[0]).build();
}
