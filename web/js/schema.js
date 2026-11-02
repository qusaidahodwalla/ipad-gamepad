// Strict validation of profile JSON (imports, server replies, the local cache).
// Returns an error message naming the bad field, or null when the profile is acceptable.
// Mirrors server/profiles.py; the PC additionally checks key names against its key table.

import { MOUSE_VALUES, SMOOTHING, TYPES, WHEEL_VALUES } from "./layout.js";

const NAME_MAX = 40;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const oneOf = (v, list) => list.includes(v);

function range(v, where, lo, hi) {
  if (!isNum(v)) return `${where} must be a number`;
  if (v < lo - 1e-9 || v > hi + 1e-9) return `${where} must be between ${lo} and ${hi} (got ${v})`;
  return null;
}

function validateBinding(b, where) {
  if (!b || typeof b !== "object") return `${where} must be an object with kind and value`;
  if (!oneOf(b.kind, ["key", "mouse", "wheel", "xbox"])) return `${where}.kind must be key, mouse, wheel or xbox`;
  if (typeof b.value !== "string" || !b.value || b.value.length > 24) return `${where}.value must be a short text`;
  if (b.kind === "mouse" && !MOUSE_VALUES.includes(b.value)) return `${where}.value ${b.value} is not a mouse button`;
  if (b.kind === "wheel" && !WHEEL_VALUES.includes(b.value)) return `${where}.value ${b.value} is not a wheel direction`;
  return null;
}

function validateSettings(type, s, where) {
  if (s === undefined || s === null) return null;
  if (typeof s !== "object") return `${where} must be an object`;
  const checks = {
    showBinding: (v) => (typeof v === "boolean" ? null : `${where}.showBinding must be true or false`),
    sprint: (v) => (typeof v === "boolean" ? null : `${where}.sprint must be true or false`),
    sensitivity: (v) => range(v, `${where}.sensitivity`, 0.2, 4),
    smoothing: (v) => (Object.hasOwn(SMOOTHING, v) ? null : `${where}.smoothing must be off, low, medium or high`),
    style: (v) => (oneOf(v, ["fixed", "floating"]) ? null : `${where}.style must be fixed or floating`),
    deadzone: (v) => range(v, `${where}.deadzone`, 0, 40),
    radius: (v) => range(v, `${where}.radius`, 40, 110),
    baseX: (v) => range(v, `${where}.baseX`, 0, 1),
    baseY: (v) => range(v, `${where}.baseY`, 0, 1),
    output: (v) => (oneOf(v, ["mouse", "stick"]) ? null : `${where}.output must be mouse or stick`),
    stickDeadzone: (v) => range(v, `${where}.stickDeadzone`, 0, 40),
    stickRadius: (v) => range(v, `${where}.stickRadius`, 30, 200),
    stickCurve: (v) => (oneOf(v, ["linear", "exponential"]) ? null : `${where}.stickCurve must be linear or exponential`),
    stick: (v) => (oneOf(v, ["left", "right"]) ? null : `${where}.stick must be left or right`),
    sprintStart: (v) => range(v, `${where}.sprintStart`, 50, 130),
    sprintStop: (v) => range(v, `${where}.sprintStop`, 1, 129),
    sprintForwardOnly: (v) => (typeof v === "boolean" ? null : `${where}.sprintForwardOnly must be true or false`),
    sprintStyle: (v) => (oneOf(v, ["hold", "tap"]) ? null : `${where}.sprintStyle must be hold or tap`),
    sprintTapStop: (v) => (typeof v === "boolean" ? null : `${where}.sprintTapStop must be true or false`),
    sprintKey: (v) => (typeof v === "string" && v && v.length <= 24 ? null : `${where}.sprintKey must be a key name`),
    sprintPad: (v) => (typeof v === "string" && v && v.length <= 24 ? null : `${where}.sprintPad must be an Xbox button name`),
    sprintLock: (v) => (typeof v === "boolean" ? null : `${where}.sprintLock must be true or false`),
  };
  for (const [key, value] of Object.entries(s)) {
    const err = checks[key]?.(value);
    if (err) return err;
  }
  if (type === "joystick" && isNum(s.sprintStart) && isNum(s.sprintStop) && s.sprintStop >= s.sprintStart) {
    return `${where}.sprintStop (${s.sprintStop}) must be below sprintStart (${s.sprintStart})`;
  }
  return null;
}

function validateCluster(c) {
  if (c === undefined || c === null) return null; // older profiles: the default spot
  if (typeof c !== "object") return "layout.cluster must be an object";
  const hasX = c.x !== null && c.x !== undefined;
  const hasY = c.y !== null && c.y !== undefined;
  if (hasX !== hasY) return "layout.cluster.x and layout.cluster.y must both be numbers or both be null";
  if (hasX) {
    const err = range(c.x, "layout.cluster.x", 0, 100) ?? range(c.y, "layout.cluster.y", 0, 100);
    if (err) return err;
  }
  if (c.orientation !== undefined && !oneOf(c.orientation, ["horizontal", "vertical"])) {
    return "layout.cluster.orientation must be horizontal or vertical";
  }
  if (c.opacity !== undefined) return range(c.opacity, "layout.cluster.opacity", 0.3, 1);
  return null;
}

export function validateLayout(layout) {
  if (!layout || typeof layout !== "object") return "layout must be an object";
  if (layout.version !== 1) return `layout.version must be 1 (got ${JSON.stringify(layout.version)})`;
  if (!Array.isArray(layout.controls)) return "layout.controls must be a list";
  if (layout.controls.length > 80) return `layout has ${layout.controls.length} controls; the limit is 80`;
  const clusterError = validateCluster(layout.cluster);
  if (clusterError) return clusterError;
  const sticks = { left: 0, right: 0 };
  for (const c of layout.controls) {
    if (c && c.type === "joystick") sticks[c.settings?.stick === "right" ? "right" : "left"]++;
  }
  if (sticks.left > 1 || sticks.right > 1) return "layout can have at most one left and one right joystick";
  const seen = new Set();
  for (let i = 0; i < layout.controls.length; i++) {
    const c = layout.controls[i];
    const where = `layout.controls[${i}]`;
    if (!c || typeof c !== "object") return `${where} must be an object`;
    if (typeof c.id !== "string" || !c.id || c.id.length > 64) return `${where}.id must be 1 to 64 characters`;
    if (seen.has(c.id)) return `${where}.id "${c.id}" is used twice`;
    seen.add(c.id);
    if (!TYPES.includes(c.type)) return `${where}.type must be one of ${TYPES.join(", ")}`;
    let err =
      range(c.x, `${where}.x`, 0, 100) ?? range(c.y, `${where}.y`, 0, 100) ??
      range(c.w, `${where}.w`, 1, 100) ?? range(c.h, `${where}.h`, 1, 100) ??
      range(c.opacity, `${where}.opacity`, 0.2, 1);
    if (err) return err;
    if (c.x + c.w > 100.5 || c.y + c.h > 100.5) return `${where} (${c.id}) extends past the screen edge`;
    if (typeof c.label !== "string" || c.label.length > 24) return `${where}.label must be text of at most 24 characters`;
    if (!oneOf(c.shape, ["circle", "rounded"])) return `${where}.shape must be circle or rounded`;
    if (!oneOf(c.mode, ["hold", "toggle"])) return `${where}.mode must be hold or toggle`;
    if (c.type === "button" || c.type === "fire") {
      err = validateBinding(c.binding, `${where}.binding`);
      if (err) return err;
    }
    err = validateSettings(c.type, c.settings, `${where}.settings`);
    if (err) return err;
  }
  return null;
}

export function validateProfile(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return "Profile must be a JSON object";
  if (p.version !== 1) return `Unsupported profile version ${JSON.stringify(p.version)} (expected 1)`;
  if (typeof p.name !== "string" || !p.name.trim() || p.name.trim().length > NAME_MAX) {
    return `Profile name must be 1 to ${NAME_MAX} characters`;
  }
  if (!oneOf(p.mode, ["wasd", "xbox"])) return 'Profile mode must be "wasd" or "xbox"';
  return validateLayout(p.layout);
}
