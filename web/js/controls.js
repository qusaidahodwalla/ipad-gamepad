// Pointer routing and control classes, built from a layout.
// Every finger is owned by the control it started on until it lifts; other controls never see it.

import { Joystick } from "./joystick.js";
import { SMOOTHING } from "./layout.js";
import { renderLayout } from "./render.js";

/**
 * Turns pointer movement into relative mouse deltas, one message per pointermove.
 * `smoothing` = { ms(): window in ms, start(): make the PC use this control's window }.
 */
class Aimer {
  constructor(send, getSensitivity, onSamples, smoothing) {
    this.send = send;
    this.getSensitivity = getSensitivity;
    this.onSamples = onSamples;
    this.smoothing = smoothing;
    this.last = new Map(); // pointerId -> [x, y]
  }

  start(e) {
    this.smoothing.start();
    this.last.set(e.pointerId, [e.clientX, e.clientY]);
  }

  move(e) {
    const prev = this.last.get(e.pointerId);
    if (!prev) return;
    // Coalesced events carry the intermediate 120 Hz samples that pointermove would drop.
    let samples = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    if (!samples.length) samples = [e];
    let x = prev[0];
    let y = prev[1];
    for (const s of samples) {
      x = s.clientX;
      y = s.clientY;
    }
    const sens = this.getSensitivity();
    const dx = (x - prev[0]) * sens;
    const dy = (y - prev[1]) * sens;
    prev[0] = x;
    prev[1] = y;
    this.onSamples(samples.length);
    if (dx !== 0 || dy !== 0) this.send({ t: "m", x: +dx.toFixed(2), y: +dy.toFixed(2) });
  }

  end(e) {
    const aiming = this.last.delete(e.pointerId);
    // Finger lifted: tell the PC to emit whatever smoothing still has buffered, right now.
    if (aiming && this.smoothing.ms() > 0) this.send({ t: "mu" });
  }

  reset() {
    this.last.clear();
  }
}

/**
 * Floating right stick. The touch point is the stick's centre; dragging away deflects it.
 * deadzone and curve apply, `stickRadius` px of drag is full deflection. y is up-positive.
 */
export function stickVector(dx, dy, cfg) {
  const r = Math.hypot(dx, dy);
  if (r === 0) return { x: 0, y: 0 };
  const mag = Math.min(r / cfg.stickRadius, 1);
  const dz = cfg.stickDeadzone / 100;
  let out = mag <= dz ? 0 : (mag - dz) / (1 - dz);
  if (cfg.stickCurve === "exponential") out *= out; // gentle near the centre, fast at the edge
  return { x: (dx / r) * out, y: (-dy / r) * out };
}

/** One right stick for the whole screen: the finger that moved last decides its value. */
class RightStickHub {
  constructor(send) {
    this.send = send;
    this.points = new Map(); // finger key -> {x, y}, oldest first
    this.sent = { x: 0, y: 0 };
  }
  set(key, x, y) {
    this.points.delete(key); // re-insert so the most recent finger is last
    this.points.set(key, { x, y });
    this.#emit();
  }
  clear(key) {
    this.points.delete(key);
    this.#emit();
  }
  /** Forget everything without sending (the PC resets the pad on release_all). */
  reset() {
    this.points.clear();
    this.sent = { x: 0, y: 0 };
  }
  #emit() {
    let v = { x: 0, y: 0 };
    for (const p of this.points.values()) v = p;
    const x = Math.round(v.x * 1000) / 1000;
    const y = Math.round(v.y * 1000) / 1000;
    if (x !== this.sent.x || y !== this.sent.y) {
      this.sent = { x, y };
      this.send({ t: "s2", x, y });
    }
  }
}

let stickAimerCount = 0;
class StickAimer {
  constructor(hub, getCfg, onSamples) {
    this.hub = hub;
    this.getCfg = getCfg;
    this.onSamples = onSamples;
    this.id = ++stickAimerCount;
    this.centers = new Map(); // pointerId -> [x, y]
  }
  start(e) {
    this.centers.set(e.pointerId, [e.clientX, e.clientY]);
  }
  move(e) {
    const c = this.centers.get(e.pointerId);
    if (!c) return;
    let samples = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    if (!samples.length) samples = [e];
    this.onSamples(samples.length);
    const last = samples[samples.length - 1];
    const v = stickVector(last.clientX - c[0], last.clientY - c[1], this.getCfg());
    this.hub.set(`${this.id}:${e.pointerId}`, v.x, v.y);
  }
  end(e) {
    this.centers.delete(e.pointerId);
    this.hub.clear(`${this.id}:${e.pointerId}`);
  }
  reset() {
    this.centers.clear();
  }
}

/** Mouse look or right-stick look, as the control's `output` setting says. */
function makeAimer(control, send, hud, smoothing, hub) {
  return control.settings.output === "stick"
    ? new StickAimer(hub, () => control.settings, (n) => hud.noteMoves(n))
    : new Aimer(send, () => control.settings.sensitivity, (n) => hud.noteMoves(n), smoothing);
}

class Control {
  constructor(el) {
    this.el = el;
    this.pointers = new Set();
  }
  down(e) {}
  move(e) {}
  up(e) {}
  destroy() {}
  /** Drop local state without sending anything (caller handles release_all). */
  reset() {
    this.pointers.clear();
    this.el.classList.remove("active", "toggled");
  }
}

class LookZone extends Control {
  constructor(el, send, control, hud, smoothing, hub) {
    super(el);
    this.aimer = makeAimer(control, send, hud, smoothing, hub);
  }
  down(e) { this.pointers.add(e.pointerId); this.aimer.start(e); this.el.classList.add("active"); }
  move(e) { this.aimer.move(e); }
  up(e) {
    this.pointers.delete(e.pointerId);
    this.aimer.end(e);
    if (!this.pointers.size) this.el.classList.remove("active");
  }
  reset() { super.reset(); this.aimer.reset(); }
}

const MOUSE_CODE = { left: "l", right: "r", middle: "m" };

/** Send one press or release for a binding. Wheel only acts on press (one notch). */
function emitBinding(send, b, down) {
  const d = down ? 1 : 0;
  if (b.kind === "key") send({ t: "k", k: b.value, d });
  else if (b.kind === "mouse") send({ t: "b", b: MOUSE_CODE[b.value], d });
  else if (b.kind === "wheel") { if (down) send({ t: "w", d: b.value === "up" ? 1 : -1 }); }
  else if (b.kind === "xbox") send({ t: "g", b: b.value, d });
}

/**
 * Binding button. Hold: down while at least one finger is on it.
 * Toggle: each press flips it; it stays down until pressed again (or release_all).
 * Wheel is a pulse: one notch per press, no held state.
 */
class ButtonControl extends Control {
  constructor(el, send, control) {
    super(el);
    this.send = send;
    this.binding = control.binding;
    this.toggle = control.mode === "toggle" && control.binding.kind !== "wheel";
    this.on = false;
  }

  down(e) {
    const first = this.pointers.size === 0;
    this.pointers.add(e.pointerId);
    if (this.toggle) {
      this.on = !this.on;
      emitBinding(this.send, this.binding, this.on);
      this.el.classList.toggle("active", this.on);
      this.el.classList.toggle("toggled", this.on);
    } else if (first) {
      this.el.classList.add("active");
      emitBinding(this.send, this.binding, true);
    }
  }

  up(e) {
    this.pointers.delete(e.pointerId);
    if (this.toggle || this.pointers.size) return;
    this.el.classList.remove("active");
    emitBinding(this.send, this.binding, false);
  }

  reset() {
    super.reset();
    this.on = false;
  }
}

/** A binding button (default: left mouse) whose finger also aims, same as the look zone. */
class FireControl extends ButtonControl {
  constructor(el, send, control, hud, smoothing, hub) {
    super(el, send, control);
    this.aimer = makeAimer(control, send, hud, smoothing, hub);
  }
  down(e) { super.down(e); this.aimer.start(e); }
  move(e) { this.aimer.move(e); }
  up(e) { this.aimer.end(e); super.up(e); }
  reset() { super.reset(); this.aimer.reset(); }
}

export class Controls {
  /**
   * @param {HTMLElement} stage element that receives all pointer events
   * @param {(msg:object)=>void} send
   * @param {{noteMoves:(n:number)=>void}} hud
   * @param {import("./settings.js").Settings} settings
   */
  constructor(stage, send, hud, settings) {
    this.stage = stage;
    this.send = send;
    this.hud = hud;
    this.settings = settings;
    this.owner = new Map(); // pointerId -> Control
    this.byEl = new Map();
    this.hub = new RightStickHub(send); // shared by every right-stick look/fire control
    this.disabled = null; // (control) => true for controls that must stay visible but inactive (KB/M only mode)
    this.onDisabledTouch = null; // called once, the first time a disabled control is touched
    this.warned = false;

    stage.addEventListener("pointerdown", (e) => {
      const el = e.target.closest(".ctl");
      const control = el && this.byEl.get(el);
      if (el && el.classList.contains("kbm-off") && !this.warned) {
        this.warned = true;
        this.onDisabledTouch?.();
      }
      if (!control) return;
      if (control.accepts && !control.accepts(e)) return;
      e.preventDefault();
      try { stage.setPointerCapture(e.pointerId); } catch {}
      this.owner.set(e.pointerId, control);
      control.down(e);
    });
    stage.addEventListener("pointermove", (e) => {
      this.owner.get(e.pointerId)?.move(e);
    });
    const end = (e) => {
      const control = this.owner.get(e.pointerId);
      if (!control) return;
      this.owner.delete(e.pointerId);
      control.up(e);
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener("lostpointercapture", end);
  }

  #smoothing(control) {
    const ms = () => SMOOTHING[control.settings.smoothing] ?? 0;
    return { ms, start: () => this.#syncSmoothing(ms()) };
  }

  /** The PC keeps one window; tell it only when the value changes. */
  #syncSmoothing(ms) {
    if (ms === this.sentSmoothing) return;
    this.sentSmoothing = ms;
    this.send({ t: "smooth", ms });
  }

  /**
   * Send the smoothing window to the PC (connect, play mode start). Uses the look zone's setting,
   * else the fire button's; an aim finger switches it if its own control differs.
   */
  announceSmoothing() {
    const c = this.layout?.controls.find((x) => x.type === "lookZone")
      ?? this.layout?.controls.find((x) => x.type === "fire");
    this.sentSmoothing = null;
    if (c) this.#syncSmoothing(SMOOTHING[c.settings.smoothing] ?? 0);
  }

  /** (Re)build every control from a layout. */
  load(layout) {
    this.unload();
    this.layout = layout;
    const els = renderLayout(this.stage, layout);
    for (const c of layout.controls) {
      const el = els.get(c.id);
      if (this.disabled?.(c)) {
        el.classList.add("kbm-off"); // visible, greyed, and no Control is attached: it does nothing
        continue;
      }
      let ctl = null;
      if (c.type === "lookZone") ctl = new LookZone(el, this.send, c, this.hud, this.#smoothing(c), this.hub);
      else if (c.type === "fire") ctl = new FireControl(el, this.send, c, this.hud, this.#smoothing(c), this.hub);
      else if (c.type === "button") ctl = new ButtonControl(el, this.send, c);
      else if (c.type === "joystick") ctl = new Joystick(el, this.send, c.settings, this.settings, this.hub);
      if (ctl) this.byEl.set(el, ctl);
    }
  }

  /** Whether any movement joystick is sprinting / sprint-locked (reported to the PC dashboard only). */
  sprintState() {
    let sprint = false, lock = false;
    for (const c of this.byEl.values()) {
      if (c.sprintActive) sprint = true;
      if (c.locked) lock = true;
    }
    return { sprint, lock };
  }

  /** Remove all controls (used while editing). Sends nothing; pair with a release_all message. */
  unload() {
    this.hub.reset();
    this.owner.clear();
    for (const c of this.byEl.values()) c.destroy?.();
    this.byEl.clear();
    this.stage.replaceChildren();
  }

  /** Forget all fingers, toggles and visual state. Does not send; pair with a release_all message. */
  resetAll() {
    this.hub.reset();
    this.owner.clear();
    for (const c of this.byEl.values()) c.reset();
  }
}
