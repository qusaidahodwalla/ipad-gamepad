// Movement joystick. Fixed or floating base, WASD or XBOX output, configurable sprint.
// Outputs are sent only when they change. Per-control options come from the layout (saved in the
// profile); the output mode (WASD/XBOX) comes from the profile via the global settings.
//
// Sprint: beyond `sprintStart` % of the radius (and, if "forward only", within the forward cone)
// sprint turns on; it turns off below `sprintStop` %. "hold" holds the sprint key/button, "tap"
// sends one short press. "sprint lock" keeps running forward + sprinting after a lift.

const SECTOR_HYSTERESIS_DEG = 7; // extra angle needed to leave the current 45 degree sector
const DEADZONE_EXIT = 0.85; // once engaged, stay engaged down to this fraction of the deadzone
const FIXED_GRAB = 1.8; // fixed mode: a touch must start within this many radii of the base
const CONE_DEG = 45; // forward cone: within this angle of straight up to start sprinting
const CONE_STAY_DEG = 50; // and it only ends beyond this (hysteresis)
const TAP_MS = 40; // length of a sprint tap

// Sector i is centred on i*45 degrees (0 = right, counter-clockwise, y up).
const SECTOR_KEYS = [["d"], ["w", "d"], ["w"], ["w", "a"], ["a"], ["s", "a"], ["s"], ["s", "d"]];

const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

export class Joystick {
  /**
   * @param {HTMLElement} zone the joystick control element
   * @param {(msg:object)=>void} send
   * @param {object} cfg the control's settings (see layout.js defaultSettingsFor("joystick"))
   * @param {import("./settings.js").Settings} settings global settings (output mode)
   * @param {{set:(key:string,x:number,y:number)=>void, clear:(key:string)=>void}} [hub] right-stick hub
   */
  constructor(zone, send, cfg, settings, hub) {
    this.el = zone;
    this.send = send;
    this.cfg = cfg;
    this.settings = settings;
    // A "right" joystick is the Xbox right stick: always analog output through the shared hub (in any
    // output mode), never sprint. A "left" one is WASD keys, or the left stick in XBOX mode.
    this.right = cfg.stick === "right";
    this.hub = hub;
    this.hubKey = `joystick:${zone.dataset.id}`;
    this.sprintEnabled = cfg.sprint && !this.right;
    this.R = cfg.radius;
    this.pointers = new Set();
    this.pointerId = null;

    this.joy = zone.querySelector(".joy");
    this.knob = zone.querySelector(".joy-knob");

    this.center = null; // client coordinates of the base centre while touched
    this.tapTimer = null;
    this.tapDown = null;
    this.#clearOutputState();
    this.el.dataset.style = cfg.style;

    this.offMode = settings.on("mode", () => this.#onModeChange());
    this.onResize = () => this.#render(0, 0);
    window.addEventListener("resize", this.onResize);
    this.#render(0, 0);
  }

  destroy() {
    this.offMode();
    clearTimeout(this.tapTimer);
    window.removeEventListener("resize", this.onResize);
  }

  // ---- Control interface used by Controls ----

  accepts(e) {
    if (this.pointerId !== null) return false; // one finger owns the stick
    if (this.cfg.style === "floating") return true;
    const c = this.#defaultCenter();
    return Math.hypot(e.clientX - c.x, e.clientY - c.y) <= this.R * FIXED_GRAB;
  }

  down(e) {
    this.pointerId = e.pointerId;
    this.pointers.add(e.pointerId);
    this.center =
      this.cfg.style === "floating" ? { x: e.clientX, y: e.clientY } : this.#defaultCenter();
    this.last = { x: e.clientX, y: e.clientY };
    this.joy.classList.add("touched");
    this.#update(e.clientX, e.clientY); // while sprint-locked this also ends the lock if the thumb starts below stop
  }

  move(e) {
    if (e.pointerId !== this.pointerId) return;
    this.last = { x: e.clientX, y: e.clientY };
    this.#update(e.clientX, e.clientY);
  }

  up(e) {
    if (e.pointerId !== this.pointerId) return;
    // Sprint lock: lifted beyond the start distance and moving forward -> keep running and sprinting.
    if (this.sprintEnabled && this.cfg.sprintLock && this.beyond && this.inCone) this.#lockForward();
    else this.#release();
  }

  /** Drop all local state without sending anything (server is released separately). */
  reset() {
    clearTimeout(this.tapTimer);
    this.tapTimer = null;
    this.tapDown = null;
    this.pointers.clear();
    this.pointerId = null;
    this.center = null;
    this.#clearOutputState();
    this.joy.classList.remove("touched");
    this.#classes();
    this.#render(0, 0);
  }

  // ---- Internals ----

  #clearOutputState() {
    this.engaged = false;
    this.sector = -1;
    this.heldKeys = new Set(); // WASD output currently held on the PC
    this.stick = { x: 0, y: 0 }; // XBOX output currently sent
    this.padHeld = false; // XBOX sprint button held
    this.beyond = false; // thumb is past the sprint start distance (until it drops below stop)
    this.inCone = false; // thumb is within the forward cone
    this.sprintActive = false; // sprint is on (logical state, also for tap style)
    this.locked = false; // sprint lock: running forward + sprinting with no finger down
  }

  #defaultCenter() {
    const r = this.el.getBoundingClientRect();
    // Base position (fixed) or idle hint (floating), as fractions of the zone from the layout.
    return { x: r.left + r.width * this.cfg.baseX, y: r.top + r.height * this.cfg.baseY };
  }

  #update(px, py) {
    const R = this.R;
    const cfg = this.cfg;
    const c = this.center;
    const dx = px - c.x;
    const dy = py - c.y;
    const dist = Math.hypot(dx, dy);
    const ux = dist > 0 ? dx / dist : 0;
    const uy = dist > 0 ? -dy / dist : 0; // y up

    // Sprint distance (with its own stop distance, so it cannot flicker) and forward cone.
    const startPx = (R * cfg.sprintStart) / 100;
    const stopPx = (R * cfg.sprintStop) / 100;
    if (!this.sprintEnabled) this.beyond = false;
    else this.beyond = this.beyond ? dist >= stopPx : dist >= startPx;
    const fromUp = dist > 0 ? (Math.acos(Math.min(1, Math.max(-1, uy))) * 180) / Math.PI : 180;
    this.inCone = this.inCone ? fromUp <= CONE_STAY_DEG : fromUp <= CONE_DEG;

    const lim = R * (this.sprintEnabled ? 1.3 : 1);
    const k = dist > lim ? lim / dist : 1;

    if (this.locked) {
      if (dist >= stopPx) {
        // Still held forward: stays locked until the thumb is pulled back below the stop distance.
        this.engaged = true;
        this.#output(0, 1, 1, this.#holdsSprint());
        this.#render(dx * k, dy * k);
        this.#classes();
        return;
      }
      this.locked = false; // pulled back: normal control resumes below
    }

    // Deadzone with a little hysteresis, then rescale so output starts at 0 at the edge.
    const mag = Math.min(dist / R, 1);
    const dz = cfg.deadzone / 100;
    this.engaged = this.engaged ? mag > dz * DEADZONE_EXIT : mag > 0 && mag >= dz;
    const scaled = this.engaged ? Math.max(0, (mag - dz) / (1 - dz)) : 0;

    this.#setSprint(this.sprintEnabled && this.beyond && (!cfg.sprintForwardOnly || this.inCone));
    this.#output(ux, uy, scaled, this.#holdsSprint());
    this.#render(dx * k, dy * k);
    this.#classes();
  }

  #reevaluate() {
    if (this.pointerId !== null && this.last) this.#update(this.last.x, this.last.y);
  }

  /** Hold style keeps the sprint key/button down while sprinting. */
  #holdsSprint() {
    return this.cfg.sprintStyle === "hold" && this.sprintActive;
  }

  #setSprint(next) {
    if (next === this.sprintActive) return;
    this.sprintActive = next;
    // Tap style: one press when sprint starts, and another when it stops if that is enabled.
    if (this.cfg.sprintStyle === "tap" && (next || this.cfg.sprintTapStop)) this.#tap();
  }

  #output(ux, uy, scaled, sprintHeld) {
    // Response curve for analog output: exponential is gentle near the centre and fast at the edge.
    const out = this.cfg.stickCurve === "exponential" ? scaled * scaled : scaled;
    if (this.right) {
      this.hub.set(this.hubKey, ux * out, uy * out); // the hub rounds and only sends changes
      return;
    }
    if (this.settings.get("mode") === "xbox") {
      const x = Math.round(ux * out * 1000) / 1000;
      const y = Math.round(uy * out * 1000) / 1000;
      if (x !== this.stick.x || y !== this.stick.y) {
        this.stick = { x, y };
        this.send({ t: "s", x, y });
      }
      this.#setPad(sprintHeld);
      return;
    }

    const desired = new Set();
    if (this.engaged) {
      const deg = (Math.atan2(uy, ux) * 180) / Math.PI;
      const cur = this.sector;
      if (cur < 0 || angleDiff(deg, cur * 45) > 22.5 + SECTOR_HYSTERESIS_DEG) {
        this.sector = ((Math.round(deg / 45) % 8) + 8) % 8;
      }
      for (const k of SECTOR_KEYS[this.sector]) desired.add(k);
    } else {
      this.sector = -1;
    }
    if (sprintHeld) desired.add(this.cfg.sprintKey);
    this.#applyKeys(desired);
  }

  #applyKeys(desired) {
    // Releases first so opposite keys are never held together.
    for (const k of this.heldKeys) {
      if (!desired.has(k)) this.send({ t: "k", k, d: 0 });
    }
    for (const k of desired) {
      if (!this.heldKeys.has(k)) this.send({ t: "k", k, d: 1 });
    }
    this.heldKeys = desired;
  }

  #setPad(down) {
    if (down === this.padHeld) return;
    this.padHeld = down;
    this.send({ t: "g", b: this.cfg.sprintPad, d: down ? 1 : 0 });
  }

  /** One short press of the sprint key (WASD) or button (XBOX). */
  #tap() {
    this.#endTap();
    const press = this.settings.get("mode") === "xbox"
      ? { t: "g", b: this.cfg.sprintPad }
      : { t: "k", k: this.cfg.sprintKey };
    this.send({ ...press, d: 1 });
    this.tapDown = press;
    this.tapTimer = setTimeout(() => this.#endTap(), TAP_MS);
  }

  #endTap() {
    clearTimeout(this.tapTimer);
    this.tapTimer = null;
    if (this.tapDown) {
      this.send({ ...this.tapDown, d: 0 });
      this.tapDown = null;
    }
  }

  /** Send neutral for whatever the current mode has pressed, and forget it. No taps are sent. */
  #neutralize() {
    if (this.right) this.hub.clear(this.hubKey); // centres the right stick (unless another finger holds it)
    this.#endTap();
    this.#applyKeys(new Set());
    if (this.stick.x !== 0 || this.stick.y !== 0) this.send({ t: "s", x: 0, y: 0 });
    this.#setPad(false);
    this.#clearOutputState();
    this.#classes();
  }

  #release() {
    const stopTap = this.cfg.sprintStyle === "tap" && this.cfg.sprintTapStop && this.sprintActive;
    this.#neutralize();
    if (stopTap) this.#tap(); // sprint ends with the lift: tap again to switch it off
    this.pointers.clear();
    this.pointerId = null;
    this.center = null;
    this.joy.classList.remove("touched");
    this.#classes();
    this.#render(0, 0);
  }

  /** Finger lifted while sprinting forward: keep moving forward (and sprinting) with no finger. */
  #lockForward() {
    this.locked = true;
    this.pointers.clear();
    this.pointerId = null;
    this.joy.classList.remove("touched");
    this.engaged = true;
    this.#output(0, 1, 1, this.#holdsSprint());
    // The base stays where it was; the knob rests in the sprint zone as a reminder.
    this.#render(0, -Math.min(this.R * 1.3, (this.R * this.cfg.sprintStart) / 100));
    this.#classes();
  }

  #onModeChange() {
    if (this.right) return; // always the Xbox right stick, whatever the output mode
    this.#neutralize(); // old mode's outputs go up before the server switches (also clears the lock)
    this.#reevaluate();
  }

  #classes() {
    this.joy.classList.toggle("sprint", this.sprintActive);
    this.joy.classList.toggle("locked", this.locked);
  }

  #render(kx, ky) {
    const zone = this.el.getBoundingClientRect();
    const c = this.center ?? this.#defaultCenter();
    this.joy.style.left = `${c.x - zone.left}px`;
    this.joy.style.top = `${c.y - zone.top}px`;
    this.knob.style.transform = `translate(-50%, -50%) translate(${kx}px, ${ky}px)`;
  }
}
