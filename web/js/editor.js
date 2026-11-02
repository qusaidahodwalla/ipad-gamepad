// Layout editor: drag, resize, snap, side panel, add menu, undo. Active only in edit mode.
// All layout changes go through #commit(), which records an undo step and saves.

import {
  FALLBACK_XBOX, MIN_H, MIN_W, MOUSE_VALUES, SMOOTHING, TYPES, TYPE_NAMES, WHEEL_VALUES,
  adaptForController, fitCircles, makeControl, newId, prettyName,
} from "./layout.js";
import { CLUSTER_ID, applyCluster, clusterRectPct } from "./cluster.js";
import { applyGeometry, isZone, renderLayout } from "./render.js";

const GRID = 2; // snap step, % of screen
const UNDO_LIMIT = 50;
const MIN_CIRCLE_PX = 32;
const FALLBACK_KEYS = [
  ..."wasdqefgrvzxc1234", "space", "lshift", "lctrl", "lalt", "tab", "esc", "enter",
];
const KEY_GROUPS = [
  ["Letters", (k) => /^[a-z]$/.test(k)],
  ["Digits", (k) => /^[0-9]$/.test(k)],
  ["Function", (k) => /^f\d+$/.test(k)],
  ["Modifiers", (k) => /^[lr](shift|ctrl|alt)$/.test(k)],
  ["Other", () => true],
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  n.append(...kids);
  return n;
}

export class Editor {
  /**
   * @param {{stage:HTMLElement, store:import("./profiles.js").ProfileStore, onDone:()=>void}} opts
   */
  constructor({ stage, store, onDone }) {
    this.stage = stage;
    this.store = store;
    this.onDone = onDone;
    this.panel = document.getElementById("panel");
    this.cluster = document.getElementById("topbar"); // the status cluster, draggable while editing
    this.undoBtn = document.getElementById("undo-btn");
    this.snapBtn = document.getElementById("snap-btn");
    this.addBtn = document.getElementById("add-btn");
    this.addMenu = document.getElementById("add-menu");
    this.opts = { keys: FALLBACK_KEYS, xbox: FALLBACK_XBOX };
    this.optsLoaded = false;
    this.role = "host"; // a controller can only choose Xbox bindings and right-stick look
    this.selectedId = null;
    this.undoStack = [];
    this.committed = "";
    this.drag = null;
    this.ac = null;
    this.snap = true;
    try { this.snap = localStorage.getItem("padSnap") !== "0"; } catch {}

    this.undoBtn.addEventListener("click", () => this.#undo());
    this.snapBtn.addEventListener("click", () => {
      this.snap = !this.snap;
      try { localStorage.setItem("padSnap", this.snap ? "1" : "0"); } catch {}
      this.#syncToolbar();
    });
    this.addBtn.addEventListener("click", () => this.#toggleAddMenu());
    // Reset restores the preset this layout is based on (undoable). Profiles are managed from the
    // profile menu in the edit bar (profile-ui.js); switching one calls reload().
    document.getElementById("reset-btn").addEventListener("click", () => {
      this.store.reset();
      this.#fit();
      this.selectedId = null;
      this.#commit();
      this.#render();
      this.#renderPanel();
    });
    document.getElementById("done-btn").addEventListener("click", () => this.onDone());
  }

  get layout() {
    return this.store.layout;
  }

  /** "host" or "controller" (set by the PC). A controller's choices are limited to Xbox output. */
  setRole(role) {
    this.role = role ?? "host";
    if (this.selectedId) this.#renderPanel();
  }

  /** Keep stored circle widths consistent with this screen so the editor's percent maths is exact. */
  #fit() {
    const r = this.stage.getBoundingClientRect();
    fitCircles(this.layout, r.width, r.height);
  }

  /** The active profile changed while editing: show its layout and start a fresh undo history. */
  reload() {
    this.#fit();
    this.committed = JSON.stringify(this.layout);
    this.undoStack = [];
    this.selectedId = null;
    this.drag = null;
    this.#syncToolbar();
    this.#render();
    this.#renderPanel();
  }

  start() {
    this.#fit();
    this.committed = JSON.stringify(this.layout);
    this.undoStack = [];
    this.selectedId = null;
    this.drag = null;
    document.body.classList.add("editing");
    this.stage.classList.add("editing");
    this.#syncToolbar();
    this.#render();
    this.#renderPanel();
    this.#loadOptions();

    this.ac = new AbortController();
    const opt = { signal: this.ac.signal };
    this.stage.addEventListener("pointerdown", (e) => this.#onDown(e), opt);
    this.stage.addEventListener("pointermove", (e) => this.#onMove(e), opt);
    this.stage.addEventListener("pointerup", (e) => this.#onUp(e), opt);
    this.stage.addEventListener("pointercancel", (e) => this.#onUp(e), opt);
    // The status cluster is dragged like a control (but not resized or deleted).
    this.cluster.addEventListener("pointerdown", (e) => this.#onClusterDown(e), opt);
    this.cluster.addEventListener("pointermove", (e) => this.#onClusterMove(e), opt);
    this.cluster.addEventListener("pointerup", (e) => this.#onClusterUp(e), opt);
    this.cluster.addEventListener("pointercancel", (e) => this.#onClusterUp(e), opt);
  }

  stop() {
    this.ac?.abort();
    this.ac = null;
    this.drag = null;
    this.store.save();
    this.cluster.classList.remove("sel", "overlap");
    document.body.classList.remove("editing");
    this.stage.classList.remove("editing", "grid");
    this.panel.hidden = true;
    this.addMenu.hidden = true;
  }

  // ---- State helpers ----

  #sel() {
    return this.layout.controls.find((c) => c.id === this.selectedId) ?? null;
  }

  #commit() {
    const now = JSON.stringify(this.layout);
    if (now === this.committed) return;
    this.undoStack.push(this.committed);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.committed = now;
    this.store.save();
    this.#syncToolbar();
  }

  #undo() {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.committed = prev;
    this.store.replace(JSON.parse(prev));
    if (!this.#sel()) this.selectedId = null;
    this.#syncToolbar();
    this.#render();
    this.#renderPanel();
  }

  #syncToolbar() {
    this.undoBtn.disabled = !this.undoStack.length;
    this.snapBtn.textContent = `GRID ${this.snap ? "ON" : "OFF"}`;
    this.snapBtn.classList.toggle("on", this.snap);
    this.stage.classList.toggle("grid", this.snap);
  }

  #snap(v) {
    return this.snap ? Math.round(v / GRID) * GRID : v;
  }

  #clampInside(c) {
    c.w = clamp(c.w, MIN_W, 100);
    c.h = clamp(c.h, MIN_H, 100);
    c.x = clamp(c.x, 0, 100 - c.w);
    c.y = clamp(c.y, 0, 100 - c.h);
  }

  async #loadOptions() {
    if (this.optsLoaded) return;
    try {
      const data = await (await fetch("/api/keys")).json();
      if (Array.isArray(data.keys) && Array.isArray(data.xbox)) {
        this.opts = { keys: data.keys, xbox: data.xbox };
        this.optsLoaded = true;
        this.#renderPanel();
      }
    } catch {}
  }

  // ---- Stage rendering ----

  #render() {
    const els = renderLayout(this.stage, this.layout);
    this.els = els;
    if (this.selectedId && this.selectedId !== CLUSTER_ID && !els.has(this.selectedId)) this.selectedId = null;
    for (const [id, node] of els) node.classList.toggle("sel", id === this.selectedId);
    if (this.selectedId && this.selectedId !== CLUSTER_ID) els.get(this.selectedId).append(el("div", { className: "handle" }));
    this.cluster.classList.toggle("sel", this.selectedId === CLUSTER_ID);
    applyCluster(this.layout.cluster); // also after undo, reset and profile switches
    this.#markOverlaps();
  }

  /** Warn when two controls of the same kind overlap (zone under a button is by design). */
  #markOverlaps() {
    const cs = this.layout.controls;
    const hit = new Set();
    const sep = 0.2; // ignore hairline contact
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i];
        const b = cs[j];
        if (isZone(a) !== isZone(b)) continue;
        if (a.x < b.x + b.w - sep && b.x < a.x + a.w - sep && a.y < b.y + b.h - sep && b.y < a.y + a.h - sep) {
          hit.add(a.id);
          hit.add(b.id);
        }
      }
    }
    // A button under the status cluster is hidden and can't be pressed (the cluster takes the touch).
    // Zones under it are by design, like buttons over zones, so they are not flagged.
    const sr = this.stage.getBoundingClientRect();
    const r = this.cluster.getBoundingClientRect();
    const cl = {
      x: ((r.left - sr.left) / sr.width) * 100, y: ((r.top - sr.top) / sr.height) * 100,
      w: (r.width / sr.width) * 100, h: (r.height / sr.height) * 100,
    };
    let clusterHit = false;
    for (const c of cs) {
      if (isZone(c)) continue;
      if (c.x < cl.x + cl.w - sep && cl.x < c.x + c.w - sep && c.y < cl.y + cl.h - sep && cl.y < c.y + c.h - sep) {
        hit.add(c.id);
        clusterHit = true;
      }
    }
    this.cluster.classList.toggle("overlap", clusterHit);
    for (const [id, node] of this.els) node.classList.toggle("overlap", hit.has(id));
  }

  #select(id) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.#render();
    this.#renderPanel();
  }

  // ---- Pointer gestures (one finger at a time) ----

  #onDown(e) {
    this.addMenu.hidden = true;
    if (this.drag) return;
    const node = e.target.closest(".ctl");
    if (!node) {
      this.#select(null);
      return;
    }
    e.preventDefault();
    try { this.stage.setPointerCapture(e.pointerId); } catch {}
    const isHandle = !!e.target.closest(".handle");
    const id = node.dataset.id;
    this.#select(id);
    const c = this.#sel();
    this.drag = {
      id,
      pid: e.pointerId,
      mode: isHandle && node.classList.contains("sel") ? "resize" : "move",
      sx: e.clientX,
      sy: e.clientY,
      start: { x: c.x, y: c.y, w: c.w, h: c.h },
      rect: this.stage.getBoundingClientRect(),
      moved: false,
    };
  }

  #onMove(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pid) return;
    const c = this.layout.controls.find((x) => x.id === d.id);
    if (!c) return;
    const { width: W, height: H } = d.rect;
    const dxpx = e.clientX - d.sx;
    const dypx = e.clientY - d.sy;
    if (Math.abs(dxpx) + Math.abs(dypx) > 3) d.moved = true;
    if (!d.moved) return;

    if (d.mode === "move") {
      c.x = round2(clamp(this.#snap(d.start.x + (dxpx / W) * 100), 0, 100 - c.w));
      c.y = round2(clamp(this.#snap(d.start.y + (dypx / H) * 100), 0, 100 - c.h));
    } else if (c.shape === "circle") {
      // Keep circles round in pixels, not in percent.
      const maxPx = Math.min(((100 - c.x) * W) / 100, ((100 - c.y) * H) / 100);
      let px = clamp((d.start.h * H) / 100 + (dxpx + dypx) / 2, MIN_CIRCLE_PX, maxPx);
      px = Math.min(maxPx, (this.#snap((px / W) * 100) * W) / 100);
      px = Math.max(MIN_CIRCLE_PX, px);
      c.w = round2((px / W) * 100);
      c.h = round2((px / H) * 100);
    } else {
      c.w = round2(clamp(this.#snap(d.start.w + (dxpx / W) * 100), MIN_W, 100 - c.x));
      c.h = round2(clamp(this.#snap(d.start.h + (dypx / H) * 100), MIN_H, 100 - c.y));
    }
    applyGeometry(this.els.get(c.id), c);
    this.#markOverlaps();
  }

  #onUp(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pid) return;
    this.drag = null;
    if (d.moved) {
      this.#commit();
      this.#renderPanel(); // refresh size sliders and panel side
    }
  }

  // ---- Status cluster: drag, snap, stay on screen ----

  #onClusterDown(e) {
    if (this.drag) return;
    e.preventDefault();
    try { this.cluster.setPointerCapture(e.pointerId); } catch {}
    this.addMenu.hidden = true;
    this.#select(CLUSTER_ID);
    const r = clusterRectPct();
    this.drag = { kind: "cluster", pid: e.pointerId, sx: e.clientX, sy: e.clientY, start: { x: r.x, y: r.y }, rect: this.stage.getBoundingClientRect(), moved: false };
  }

  #onClusterMove(e) {
    const d = this.drag;
    if (!d || d.kind !== "cluster" || e.pointerId !== d.pid) return;
    const dxpx = e.clientX - d.sx;
    const dypx = e.clientY - d.sy;
    if (Math.abs(dxpx) + Math.abs(dypx) > 3) d.moved = true;
    if (!d.moved) return;
    const size = clusterRectPct();
    const cl = this.layout.cluster;
    cl.x = round2(clamp(this.#snap(d.start.x + (dxpx / d.rect.width) * 100), 0, Math.max(0, 100 - size.w)));
    cl.y = round2(clamp(this.#snap(d.start.y + (dypx / d.rect.height) * 100), 0, Math.max(0, 100 - size.h)));
    applyCluster(cl);
    this.#markOverlaps();
  }

  #onClusterUp(e) {
    const d = this.drag;
    if (!d || d.kind !== "cluster" || e.pointerId !== d.pid) return;
    this.drag = null;
    if (d.moved) {
      this.#commit();
      this.#renderPanel(); // the panel moves to the far side
    }
  }

  /** Panel for the status cluster: orientation and opacity only (it can't be resized or deleted). */
  #renderClusterPanel() {
    const cl = this.layout.cluster;
    const { row, seg, range } = this.#ui();
    const size = clusterRectPct();
    this.panel.hidden = false;
    this.panel.classList.toggle("left", size.x + size.w / 2 > 50);

    const setOrientation = (v) => {
      cl.orientation = v;
      applyCluster(cl);
      if (cl.x !== null) { // its size changed: keep it fully on screen
        const s = clusterRectPct();
        cl.x = round2(clamp(cl.x, 0, Math.max(0, 100 - s.w)));
        cl.y = round2(clamp(cl.y, 0, Math.max(0, 100 - s.h)));
        applyCluster(cl);
      }
      this.#commit();
      this.#markOverlaps();
      this.#renderPanel();
    };
    this.panel.replaceChildren(
      el("h3", { textContent: "Status bar" }),
      row("Orientation", seg([["horizontal", "Horizontal"], ["vertical", "Vertical"]], cl.orientation, setOrientation)),
      row("Opacity", range(30, 100, 5, Math.round(cl.opacity * 100), (v) => `${v}%`, (v) => {
        cl.opacity = v / 100;
        applyCluster(cl);
      })),
      el("p", { className: "pnote2", textContent: "Drag the bar to move it. It snaps to the grid and stays on screen. A button under it can't be pressed; the bar takes the touch." }),
    );
  }

  // ---- Add menu ----

  #toggleAddMenu() {
    if (!this.addMenu.hidden) {
      this.addMenu.hidden = true;
      return;
    }
    this.addMenu.replaceChildren();
    this.addMenu.style.left = `${Math.round(this.addBtn.getBoundingClientRect().left)}px`;
    // One left and one right joystick are allowed; the look zone stays available as the other way to aim.
    const taken = (stick) => this.layout.controls.some((c) => c.type === "joystick" && c.settings.stick === stick);
    const entries = [
      ...TYPES.filter((t) => t !== "joystick").map((t) => ({ type: t, label: TYPE_NAMES[t], disabled: false })),
      { type: "joystick", stick: "left", label: "Joystick (left)", disabled: taken("left") },
      { type: "joystick", stick: "right", label: "Right joystick", disabled: taken("right") },
    ];
    for (const e of entries) {
      const item = el("button", {
        type: "button",
        className: "menu-item",
        textContent: e.disabled ? `${e.label} (only one)` : e.label,
        disabled: e.disabled,
      });
      item.addEventListener("click", () => this.#add(e.type, e.stick));
      this.addMenu.append(item);
    }
    this.addMenu.hidden = false;
  }

  #add(type, stick) {
    this.addMenu.hidden = true;
    const c = makeControl(type);
    if (type === "joystick" && stick === "right") {
      // The Xbox right stick: sits on the right half, no sprint.
      c.label = "RIGHT STICK";
      c.x = 58;
      c.y = 40;
      c.settings = { ...c.settings, stick: "right", sprint: false, deadzone: 10 };
    }
    if (this.role === "controller") adaptForController(c);
    this.layout.controls.push(c);
    this.selectedId = c.id;
    this.#commit();
    this.#render();
    this.#renderPanel();
  }

  // ---- Side panel ----

  #renderPanel() {
    if (this.selectedId === CLUSTER_ID) {
      this.#renderClusterPanel();
      return;
    }
    const c = this.#sel();
    const panel = this.panel;
    if (!c) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    panel.classList.toggle("left", c.x + c.w / 2 > 50);

    // Apply a change to the selected control. `live` = slider drag (commit on release).
    const apply = (fn, { live = false, rebuild = false } = {}) => {
      fn(c);
      this.#clampInside(c);
      this.#render();
      if (!live) this.#commit();
      if (rebuild) this.#renderPanel();
    };
    const { row, seg, range } = this.#ui();

    const body = [];
    body.push(el("h3", { textContent: c.type === "joystick" && c.settings.stick === "right" ? "Right joystick" : TYPE_NAMES[c.type] }));

    const label = el("input", { type: "text", value: c.label, maxLength: 24 });
    label.addEventListener("input", () => apply((x) => { x.label = label.value; }, { live: true }));
    label.addEventListener("change", () => this.#commit());
    body.push(row("Label", label));

    const hasBinding = c.type === "button" || c.type === "fire";
    if (hasBinding) {
      body.push(row("Shape", seg([["circle", "Circle"], ["rounded", "Rounded"]], c.shape, (v) => {
        apply((x) => {
          if (v === "circle") {
            const r = this.stage.getBoundingClientRect();
            const px = Math.min((x.w * r.width) / 100, (x.h * r.height) / 100);
            x.w = round2((px / r.width) * 100);
            x.h = round2((px / r.height) * 100);
          }
          x.shape = v;
        }, { rebuild: true });
      })));
    }

    body.push(row("Opacity", range(20, 100, 5, Math.round(c.opacity * 100), (v) => `${v}%`, (v) =>
      apply((x) => { x.opacity = v / 100; }, { live: true }))));

    const r = this.stage.getBoundingClientRect();
    if (hasBinding && c.shape === "circle") {
      const maxPx = Math.max(MIN_CIRCLE_PX + 1, Math.min(300, ((100 - c.x) * r.width) / 100, ((100 - c.y) * r.height) / 100));
      body.push(row("Size", range(MIN_CIRCLE_PX, Math.round(maxPx), 1, Math.round((c.h * r.height) / 100), (v) => `${v}px`, (v) =>
        apply((x) => { x.w = round2((v / r.width) * 100); x.h = round2((v / r.height) * 100); }, { live: true }))));
    } else {
      body.push(row("Width", range(MIN_W, 100 - c.x, 0.5, c.w, (v) => `${v.toFixed(1)}%`, (v) =>
        apply((x) => { x.w = v; }, { live: true }))));
      body.push(row("Height", range(MIN_H, 100 - c.y, 0.5, c.h, (v) => `${v.toFixed(1)}%`, (v) =>
        apply((x) => { x.h = v; }, { live: true }))));
    }

    if (hasBinding) body.push(...this.#bindingRows(c, apply, row, seg));

    if (c.type === "button") {
      body.push(row("Show binding", seg([[true, "On"], [false, "Off"]], c.settings.showBinding, (v) =>
        apply((x) => { x.settings.showBinding = v; }, { rebuild: true }))));
    }
    if (c.type === "lookZone" || c.type === "fire") {
      const controller = this.role === "controller";
      const outputs = controller ? [["stick", "Right stick"]] : [["mouse", "Mouse"], ["stick", "Right stick"]];
      body.push(row("Aim output", seg(outputs, c.settings.output, (v) =>
        apply((x) => { x.settings.output = v; }, { rebuild: true }))));
      if (c.settings.output === "stick") {
        // Floating right stick: the touch point is the centre, the drag distance is the deflection.
        body.push(row("Stick deadzone", range(0, 40, 1, c.settings.stickDeadzone, (v) => `${v}%`, (v) =>
          apply((x) => { x.settings.stickDeadzone = v; }, { live: true }))));
        body.push(row("Max radius (full deflection)", range(30, 200, 1, c.settings.stickRadius, (v) => `${v}px`, (v) =>
          apply((x) => { x.settings.stickRadius = v; }, { live: true }))));
        body.push(row("Response curve", seg([["linear", "Linear"], ["exponential", "Exponential"]], c.settings.stickCurve, (v) =>
          apply((x) => { x.settings.stickCurve = v; }, { rebuild: true }))));
      } else {
        body.push(row("Sensitivity", range(0.2, 4, 0.05, c.settings.sensitivity, (v) => v.toFixed(2), (v) =>
          apply((x) => { x.settings.sensitivity = v; }, { live: true }))));
        body.push(row("Aim smoothing (8/16/24 ms)", seg(
          Object.entries(SMOOTHING).map(([name, ms]) => [name, ms ? name[0].toUpperCase() + name.slice(1) : "Off"]),
          c.settings.smoothing,
          (v) => apply((x) => { x.settings.smoothing = v; }, { rebuild: true }),
        )));
      }
    }
    if (c.type === "joystick") {
      const rightStick = c.settings.stick === "right";
      // A profile can have one left and one right joystick: a stick that is already used can't be picked.
      const other = this.layout.controls.find((x) => x !== c && x.type === "joystick");
      const taken = other ? [other.settings.stick] : [];
      body.push(row("Stick", seg([["left", "Left"], ["right", "Right"]], c.settings.stick, (v) =>
        apply((x) => { x.settings.stick = v; if (v === "right") x.settings.sprint = false; }, { rebuild: true }), taken)));
      body.push(row("Style", seg([["fixed", "Fixed"], ["floating", "Floating"]], c.settings.style, (v) =>
        apply((x) => { x.settings.style = v; }, { rebuild: true }))));
      body.push(row("Deadzone", range(0, 40, 1, c.settings.deadzone, (v) => `${v}%`, (v) =>
        apply((x) => { x.settings.deadzone = v; }, { live: true }))));
      body.push(row("Response curve", seg([["linear", "Linear"], ["exponential", "Exponential"]], c.settings.stickCurve, (v) =>
        apply((x) => { x.settings.stickCurve = v; }, { rebuild: true }))));
      if (!rightStick) { // the right stick has no sprint
        body.push(row("Sprint", seg([[true, "On"], [false, "Off"]], c.settings.sprint, (v) =>
          apply((x) => { x.settings.sprint = v; }, { rebuild: true }))));
        if (c.settings.sprint) body.push(...this.#sprintRows(c, apply, row, seg, range));
      }
      body.push(row("Stick radius", range(40, 110, 1, c.settings.radius, (v) => `${v}px`, (v) =>
        apply((x) => { x.settings.radius = v; }, { live: true }))));
    }

    const dup = el("button", { type: "button", className: "pbtn", textContent: "Duplicate", disabled: c.type === "joystick" });
    dup.addEventListener("click", () => this.#duplicate());
    const del = el("button", { type: "button", className: "pbtn danger", textContent: "Delete" });
    del.addEventListener("click", () => this.#delete());
    body.push(el("div", { className: "pactions" }, dup, del));

    panel.replaceChildren(...body);
  }

  /** Small panel building blocks shared by the control and status-bar panels. */
  #ui() {
    const row = (label, ...kids) => el("div", { className: "prow" }, el("span", { className: "plabel", textContent: label }), ...kids);
    const seg = (options, current, onPick, disabledValues = []) => {
      const wrap = el("div", { className: "seg" });
      for (const [value, text] of options) {
        const b = el("button", {
          type: "button", textContent: text, className: value === current ? "on" : "",
          disabled: value !== current && disabledValues.includes(value),
        });
        b.addEventListener("click", () => onPick(value));
        wrap.append(b);
      }
      return wrap;
    };
    const range = (min, max, step, value, fmt, onInput, onChange) => {
      const out = el("output", { textContent: fmt(value) });
      const input = el("input", { type: "range", min, max, step, value });
      input.addEventListener("input", () => {
        const v = parseFloat(input.value);
        out.textContent = fmt(v);
        onInput(v);
      });
      input.addEventListener("change", () => {
        this.#commit();
        onChange?.();
      });
      return el("div", { className: "prange" }, input, out);
    };
    return { row, seg, range };
  }

  /** Key names grouped like the binding picker. */
  #keySelect(current, onPick) {
    const select = el("select", {});
    const add = (parent, v) => parent.append(el("option", { value: v, textContent: prettyName(v), selected: v === current }));
    const left = new Set(this.opts.keys);
    for (const [name, test] of KEY_GROUPS) {
      const group = el("optgroup", { label: name });
      for (const k of this.opts.keys) if (left.has(k) && test(k)) { add(group, k); left.delete(k); }
      if (group.children.length) select.append(group);
    }
    if (!this.opts.keys.includes(current)) add(select, current);
    select.addEventListener("change", () => onPick(select.value));
    return select;
  }

  #padSelect(current, onPick) {
    const select = el("select", {});
    const names = this.opts.xbox.includes(current) ? this.opts.xbox : [...this.opts.xbox, current];
    for (const v of names) select.append(el("option", { value: v, textContent: prettyName(v), selected: v === current }));
    select.addEventListener("change", () => onPick(select.value));
    return select;
  }

  /** Joystick sprint options (shown when sprint is on). */
  #sprintRows(c, apply, row, seg, range) {
    const s = c.settings;
    const rows = [];
    // Stop must stay below start, so start's slider drags stop down with it and the panel is rebuilt on release.
    rows.push(row("Sprint start distance", range(50, 130, 1, s.sprintStart, (v) => `${v}%`, (v) =>
      apply((x) => { x.settings.sprintStart = v; x.settings.sprintStop = Math.min(x.settings.sprintStop, v - 1); }, { live: true }),
      () => this.#renderPanel())));
    rows.push(row("Sprint stop distance (below start)", range(10, s.sprintStart - 1, 1, s.sprintStop, (v) => `${v}%`, (v) =>
      apply((x) => { x.settings.sprintStop = Math.min(v, x.settings.sprintStart - 1); }, { live: true }))));
    rows.push(row("Forward only (within 45° of up)", seg([[true, "On"], [false, "Off"]], s.sprintForwardOnly, (v) =>
      apply((x) => { x.settings.sprintForwardOnly = v; }, { rebuild: true }))));
    rows.push(row("Output", seg([["hold", "Hold"], ["tap", "Tap"]], s.sprintStyle, (v) =>
      apply((x) => { x.settings.sprintStyle = v; }, { rebuild: true }))));
    if (s.sprintStyle === "tap") {
      rows.push(row("Tap again on stop", seg([[true, "On"], [false, "Off"]], s.sprintTapStop, (v) =>
        apply((x) => { x.settings.sprintTapStop = v; }, { rebuild: true }))));
    }
    rows.push(row("Sprint key (WASD mode)", this.#keySelect(s.sprintKey, (v) => apply((x) => { x.settings.sprintKey = v; }))));
    rows.push(row("Sprint button (XBOX mode)", this.#padSelect(s.sprintPad, (v) => apply((x) => { x.settings.sprintPad = v; }))));
    rows.push(row("Sprint lock", seg([[true, "On"], [false, "Off"]], s.sprintLock, (v) =>
      apply((x) => { x.settings.sprintLock = v; }, { rebuild: true }))));
    return rows;
  }

  #bindingRows(c, apply, row, seg) {
    const rows = [];
    const defaults = { key: "space", mouse: "left", wheel: "up", xbox: "a" };
    const kind = el("select", {});
    const kinds = [["key", "Keyboard key"], ["mouse", "Mouse button"], ["wheel", "Mouse wheel"], ["xbox", "Xbox button"]];
    for (const [value, text] of this.role === "controller" ? kinds.filter(([v]) => v === "xbox") : kinds) {
      kind.append(el("option", { value, textContent: text, selected: value === c.binding.kind }));
    }
    kind.addEventListener("change", () =>
      apply((x) => { x.binding = { kind: kind.value, value: defaults[kind.value] }; }, { rebuild: true }));
    rows.push(row("Binding", kind));

    let value;
    if (c.binding.kind === "key") {
      value = this.#keySelect(c.binding.value, (v) => apply((x) => { x.binding.value = v; }));
    } else {
      value = el("select", {});
      const add = (v, text) => value.append(el("option", { value: v, textContent: text, selected: v === c.binding.value }));
      if (c.binding.kind === "mouse") {
        for (const v of MOUSE_VALUES) add(v, v[0].toUpperCase() + v.slice(1));
      } else if (c.binding.kind === "wheel") {
        for (const v of WHEEL_VALUES) add(v, v === "up" ? "Up" : "Down");
      } else {
        for (const v of this.opts.xbox) add(v, prettyName(v));
        if (!this.opts.xbox.includes(c.binding.value)) add(c.binding.value, prettyName(c.binding.value));
      }
      value.addEventListener("change", () => apply((x) => { x.binding.value = value.value; }));
    }
    rows.push(row("Input", value));

    if (c.binding.kind !== "wheel") {
      rows.push(row("Behaviour", seg([["hold", "Hold"], ["toggle", "Toggle"]], c.mode, (v) =>
        apply((x) => { x.mode = v; }, { rebuild: true }))));
    }
    return rows;
  }

  #duplicate() {
    const c = this.#sel();
    if (!c || c.type === "joystick") return; // one joystick only
    const copy = JSON.parse(JSON.stringify(c));
    copy.id = newId(c.type);
    copy.x = round2(clamp(c.x + 3, 0, 100 - c.w));
    copy.y = round2(clamp(c.y + 3, 0, 100 - c.h));
    const i = this.layout.controls.indexOf(c);
    this.layout.controls.splice(i + 1, 0, copy);
    this.selectedId = copy.id;
    this.#commit();
    this.#render();
    this.#renderPanel();
  }

  #delete() {
    const c = this.#sel();
    if (!c) return;
    this.layout.controls.splice(this.layout.controls.indexOf(c), 1);
    this.selectedId = null;
    this.#commit();
    this.#render();
    this.#renderPanel();
  }
}
