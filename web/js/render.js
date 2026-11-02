// Builds the control DOM from a layout. Used by play mode and the editor so they look identical.

import { bindingText } from "./layout.js";

const ZONES = new Set(["lookZone", "joystick"]);
export const isZone = (c) => ZONES.has(c.type);

const REACH_BOTTOM = 99.5; // a zone whose bottom edge is at least this % down counts as flush with the bottom
const COMPACT_PX = 64; // controls smaller than this get a smaller label and no binding text

const isRoundButton = (c) => c.shape === "circle" && (c.type === "button" || c.type === "fire");

/**
 * Circles are sized by height and made square with aspect-ratio, centred on x + w/2, so they
 * stay round on any screen aspect. Everything else is a plain percentage box.
 */
export function applyGeometry(el, c) {
  el.style.top = `${c.y}%`;
  el.style.height = `${c.h}%`;
  if (isRoundButton(c)) {
    el.style.left = `${c.x + c.w / 2}%`;
    el.style.width = "auto";
    el.style.aspectRatio = "1 / 1";
    el.style.transform = "translateX(-50%)";
  } else {
    el.style.left = `${c.x}%`;
    el.style.width = `${c.w}%`;
    el.style.aspectRatio = "";
    el.style.transform = "";
  }
  el.style.opacity = c.opacity;
  // A zone that runs to the bottom edge also covers the home-indicator strip below the play area
  // (drawn and hit-tested by a pseudo-element, so the element's own rect never changes).
  el.classList.toggle("reach-bottom", isZone(c) && c.y + c.h >= REACH_BOTTOM);
}

function span(cls, text) {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

function createControlEl(c, stageW, stageH) {
  const el = document.createElement("div");
  el.className = `ctl t-${c.type} shape-${c.shape}`;
  if (c.type === "button" || c.type === "fire") {
    const hPx = (c.h * stageH) / 100;
    const wPx = isRoundButton(c) ? hPx : (c.w * stageW) / 100;
    if (Math.min(wPx, hPx) < COMPACT_PX) el.classList.add("compact");
  }
  el.dataset.id = c.id;
  el.dataset.type = c.type;
  el.style.zIndex = isZone(c) ? 1 : 2; // zones sit under buttons; DOM order breaks ties
  applyGeometry(el, c);

  if (c.type === "button" || c.type === "fire") {
    el.append(span("lbl", c.label));
    if (c.type === "button" && c.settings.showBinding) el.append(span("bind", bindingText(c.binding)));
    if (c.mode === "toggle") el.dataset.toggle = "1";
  } else {
    el.append(span("lbl", c.label));
  }

  if (c.type === "joystick") {
    const joy = document.createElement("div");
    joy.className = "joy";
    const r = c.settings.radius;
    joy.style.setProperty("--r", `${r}px`);
    // The ring marks where sprint starts (a % of the stick radius); hidden when sprint is off.
    joy.style.setProperty("--ring", `${(r * c.settings.sprintStart) / 100}px`);
    if (!c.settings.sprint || c.settings.stick === "right") joy.classList.add("nosprint"); // no ring without sprint
    joy.style.left = `${c.settings.baseX * 100}%`; // idle / fixed base position (play mode refines it in px)
    joy.style.top = `${c.settings.baseY * 100}%`;
    for (const part of ["joy-ring", "joy-base", "joy-knob", "joy-lock"]) {
      const d = document.createElement("div");
      d.className = part;
      if (part === "joy-lock") d.textContent = "LOCK"; // shown while sprint lock is active
      joy.append(d);
    }
    el.append(joy);
  }
  return el;
}

/**
 * Replace the stage contents with the layout's controls.
 * @returns {Map<string, HTMLElement>} control id -> element
 */
export function renderLayout(stage, layout) {
  stage.replaceChildren();
  const map = new Map();
  const { width, height } = stage.getBoundingClientRect();
  for (const c of layout.controls) {
    const el = createControlEl(c, width, height);
    stage.append(el);
    map.set(c.id, el);
  }
  return map;
}
