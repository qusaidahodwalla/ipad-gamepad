// PC dashboard: draws the live state the server sends over /dash (read only).
// The token comes from the page URL (?token=...) and is passed on the WebSocket and with admin actions.

const params = new URLSearchParams(location.search);
const TOKEN = params.get("token") || "";
const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";

// ---- small helpers ----

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function svg(tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

const maps = new WeakMap();
/** Keep a list of cards in sync with data: create new ones, update existing, remove the gone. */
function keyed(box, items, key, create, update) {
  let m = maps.get(box);
  if (!m) maps.set(box, (m = new Map()));
  const seen = new Set();
  for (const it of items) {
    const k = key(it);
    seen.add(k);
    let c = m.get(k);
    if (!c) {
      c = create(it);
      m.set(k, c);
      box.append(c.el);
    }
    update(c, it);
  }
  for (const [k, c] of m) {
    if (!seen.has(k)) {
      c.el.remove();
      m.delete(k);
    }
  }
}

const GLYPH = { Cross: "✕", Circle: "○", Square: "□", Triangle: "△" };
const short = (label) => GLYPH[label] ?? label;
const fmt = (v, d = 0) => (v == null ? "--" : Number(v).toFixed(d));

// ---- gamepad diagram ----

const FACE = { a: [240, 114], b: [264, 90], x: [216, 90], y: [240, 66] };
const DPAD = { dpad_up: [115, 110], dpad_down: [115, 150], dpad_left: [95, 130], dpad_right: [135, 130] };
const STICKS = { l: [90, 95], r: [200, 140] };
const STICK_R = 26;
const DEFAULT_LABELS = { a: "A", b: "B", x: "X", y: "Y", lb: "LB", rb: "RB", lt: "LT", rt: "RT", back: "Back", start: "Start", guide: "Guide", l3: "L3", r3: "R3" };

function makePad() {
  const root = svg("svg", { viewBox: "0 0 320 200", class: "pad" });
  root.append(svg("rect", { x: 20, y: 40, width: 280, height: 150, rx: 55, class: "shape" }));
  const btns = {}; // name -> shape element that lights up
  const texts = {}; // name -> text element (label)

  const add = (name, shape, label, tx, ty) => {
    root.append(shape);
    btns[name] = shape;
    if (label !== null) {
      const t = svg("text", { x: tx, y: ty + 3.5 }, label);
      root.append(t);
      texts[name] = t;
    }
  };
  const circle = (name, cx, cy, r) => add(name, svg("circle", { cx, cy, r, class: "btn" }), "", cx, cy);
  const rect = (name, x, y, w, hgt, rx = 4) => add(name, svg("rect", { x, y, width: w, height: hgt, rx, class: "btn" }), "", x + w / 2, y + hgt / 2);

  // Triggers (analog bars) and bumpers
  const bars = {};
  for (const [name, x] of [["lt", 40], ["rt", 210]]) {
    root.append(svg("rect", { x, y: 4, width: 70, height: 10, rx: 3, class: "bar-bg" }));
    bars[name] = svg("rect", { x, y: 4, width: 0, height: 10, rx: 3, class: "bar" });
    root.append(bars[name]);
    texts[name] = svg("text", { x: x + 35, y: 12 }, "");
    root.append(texts[name]);
  }
  rect("lb", 40, 20, 70, 16, 5);
  rect("rb", 210, 20, 70, 16, 5);

  for (const [name, [x, y]] of Object.entries(DPAD)) rect(name, x, y, 20, 20, 3);
  for (const [name, [cx, cy]] of Object.entries(FACE)) circle(name, cx, cy, 11);
  circle("back", 140, 75, 7);
  circle("start", 180, 75, 7);
  circle("guide", 160, 58, 8);

  // Sticks: the ring lights on a stick click (L3/R3); the dot follows the deflection.
  const dots = {};
  for (const [side, [cx, cy]] of Object.entries(STICKS)) {
    const ring = svg("circle", { cx, cy, r: STICK_R, class: "stick-bg" });
    root.append(ring);
    btns[`${side}3`] = ring;
    dots[side] = svg("circle", { cx, cy, r: 8, class: "dot" });
    root.append(dots[side]);
  }

  let labelKey = "";
  const setLabels = (labels) => {
    const key = JSON.stringify(labels);
    if (key === labelKey) return;
    labelKey = key;
    const L = { ...DEFAULT_LABELS, ...labels };
    for (const n of ["a", "b", "x", "y", "lb", "rb", "back", "start", "guide"]) {
      if (texts[n]) texts[n].textContent = short(L[n]);
      btns[n].setAttribute("data-name", L[n]);
    }
    texts.lt.textContent = L.lt;
    texts.rt.textContent = L.rt;
    for (const n of ["back", "start", "guide"]) texts[n].textContent = ""; // too small for text; shown in the caption
  };

  return {
    el: root,
    update(state, labels) {
      setLabels(labels || {});
      const pressed = new Set(state.pressed || []);
      for (const [name, el] of Object.entries(btns)) el.classList.toggle("lit", pressed.has(name));
      for (const [name, el] of Object.entries(bars)) el.setAttribute("width", String(70 * Math.max(0, Math.min(1, state[name] || 0))));
      const move = (side, x, y) => {
        const [cx, cy] = STICKS[side];
        const mag = Math.hypot(x, y);
        const k = mag > 1 ? 1 / mag : 1;
        dots[side].setAttribute("cx", String(cx + x * k * (STICK_R - 4)));
        dots[side].setAttribute("cy", String(cy - y * k * (STICK_R - 4)));
        dots[side].classList.toggle("lit", mag > 0.05);
      };
      move("l", state.lx || 0, state.ly || 0);
      move("r", state.rx || 0, state.ry || 0);
    },
  };
}

/** A caption listing what is pressed, using the controller's own names. */
function pressedText(state, labels) {
  const L = { ...DEFAULT_LABELS, ...labels };
  const names = (state.pressed || []).map((n) => L[n] ?? n.replace("dpad_", "D-pad "));
  if ((state.lt || 0) > 0.05) names.push(`${L.lt} ${Math.round(state.lt * 100)}%`);
  if ((state.rt || 0) > 0.05) names.push(`${L.rt} ${Math.round(state.rt * 100)}%`);
  return names.length ? names.join(", ") : "";
}

// ---- keyboard and mouse panel (host) ----

const KEY_ROWS = [
  ["esc", "1", "2", "3", "4", "5"],
  ["tab", "q", "w", "e", "r", "t"],
  ["caps", "a", "s", "d", "f", "g"],
  ["lshift", "z", "x", "c", "v"],
  ["lctrl", "lalt", "space"],
];
const KEY_TEXT = { lshift: "Shift", lctrl: "Ctrl", lalt: "Alt", space: "Space", caps: "Caps", esc: "Esc", tab: "Tab" };

function makeKeyMouse() {
  const el = h("div", "km");
  const kb = h("div", "kb");
  const keys = {};
  for (const row of KEY_ROWS) {
    const r = h("div");
    for (const k of row) {
      const key = h("div", `key${k === "space" ? " wide" : ""}`, KEY_TEXT[k] ?? k);
      keys[k] = key;
      r.append(key);
    }
    kb.append(r);
  }
  const other = h("div", "state-line");
  kb.append(other);
  const mouse = h("div", "mouse");
  const mb = h("div", "mouse-btns");
  const mbtn = { l: h("div", "key", "L"), m: h("div", "key", "M"), r: h("div", "key", "R") };
  mb.append(mbtn.l, mbtn.m, mbtn.r);
  const meter = h("div", "meter");
  const fill = h("i");
  meter.append(fill);
  const rate = h("div", "state-line");
  mouse.append(h("div", "state-line", "Mouse"), mb, meter, rate);
  el.append(kb, mouse);
  return {
    el,
    update(d) {
      const held = new Set(d.keys);
      for (const [k, node] of Object.entries(keys)) node.classList.toggle("lit", held.has(k));
      const extra = d.keys.filter((k) => !(k in keys));
      other.textContent = extra.length ? `Also held: ${extra.join(", ")}` : "";
      const b = new Set(d.buttons);
      for (const [k, node] of Object.entries(mbtn)) node.classList.toggle("lit", b.has(k));
      fill.style.width = `${Math.min(100, (d.mouse / 4000) * 100)}%`;
      rate.textContent = `${d.mouse} counts/s`;
    },
  };
}

// ---- cards ----

function tag(text, cls = "") {
  return h("span", `tag ${cls}`, text);
}

function deviceCard(d) {
  const el = h("div", "card");
  const head = h("div", "card-head");
  const name = h("b");
  const role = tag("");
  const status = tag("");
  const player = tag("", "player");
  const actions = h("div", "actions");
  const hostBtn = h("button", "", "Make host");
  const forgetBtn = h("button", "danger", "Forget");
  hostBtn.onclick = () => admin("makehost", d.id);
  forgetBtn.onclick = () => {
    if (confirm(`Forget ${d.name}? It will have to pair again.`)) admin("forget", d.id);
  };
  actions.append(hostBtn, forgetBtn);
  head.append(name, role, status, player, h("span", "spacer"), actions);

  const facts = h("div", "facts");
  const f = {};
  for (const [k, label] of [["ping", "Ping"], ["jitter", "Jitter"], ["profile", "Profile"], ["mode", "Joystick mode"], ["sprint", "Sprint"]]) {
    const cell = h("div");
    cell.append(h("span", "", label));
    f[k] = h("div");
    cell.append(f[k]);
    facts.append(cell);
  }
  const km = makeKeyMouse();
  const pad = makePad();
  const cap = h("div", "pressed-line");
  const body = h("div");
  body.append(pad.el, cap);
  el.append(head, facts, km.el, body);
  return { el, name, role, status, player, hostBtn, forgetBtn, f, km, pad, body, cap };
}

function updateDevice(c, d) {
  c.el.classList.toggle("offline", !d.online && d.grace == null);
  c.name.textContent = d.name;
  c.role.textContent = d.role === "host" ? "Host" : "Controller";
  c.role.className = `tag ${d.role === "host" ? "host" : ""}`;
  c.status.textContent = d.online ? "Connected" : d.grace != null ? `Reconnect window ${Math.ceil(d.grace)}s` : "Offline";
  c.status.className = `tag ${d.online ? "on" : d.grace != null ? "grace" : ""}`;
  c.player.hidden = !d.player && !d.extra;
  c.player.textContent = d.player ? `Player ${d.player}` : d.extra ? "Extra controller" : "";
  c.hostBtn.hidden = d.role === "host";
  c.forgetBtn.hidden = d.role === "host";
  const s = d.stats || {};
  c.f.ping.textContent = d.online && s.ping != null ? `${fmt(s.ping)} ms (avg ${fmt(s.avg, 1)})` : "--";
  c.f.jitter.textContent = d.online && s.jitter != null ? `${fmt(s.jitter, 1)} ms` : "--";
  c.f.profile.textContent = d.online && s.profile ? s.profile : "--";
  c.f.mode.textContent = d.online && s.mode ? s.mode.toUpperCase() : "--";
  c.f.sprint.textContent = !d.online ? "--" : s.lock ? "Locked" : s.sprint ? "On" : "Off";
  c.km.el.hidden = d.role !== "host";
  if (d.role === "host") c.km.update(d);
  c.body.hidden = !d.pad;
  if (d.pad) {
    c.pad.update(d.pad, {});
    c.cap.textContent = pressedText(d.pad, {});
  }
}

function padCard(p) {
  const el = h("div", "card");
  const head = h("div", "card-head");
  const title = h("b");
  const slot = tag("", "player");
  const owner = tag("");
  const grace = tag("", "grace");
  head.append(title, slot, owner, grace);
  const pad = makePad();
  const cap = h("div", "pressed-line");
  el.append(head, pad.el, cap);
  return { el, title, slot, owner, grace, pad, cap };
}

function updatePad(c, p) {
  c.title.textContent = `Virtual Xbox 360 pad`;
  c.slot.textContent = p.slot == null ? "Extra controller" : `Slot ${p.slot + 1} · Player ${p.player}`;
  c.slot.title = p.slot == null ? "Outside XInput slots 1-4: XInput-only games may not see it" : "";
  c.owner.textContent = `Owner: ${p.ownerName}`;
  c.grace.hidden = p.grace == null;
  c.grace.textContent = p.grace == null ? "" : `Removed in ${Math.ceil(p.grace)}s unless the device reconnects`;
  c.pad.update(p.state, {});
  c.cap.textContent = pressedText(p.state, {});
}

function realCard(r) {
  const el = h("div", "card");
  const head = h("div", "card-head");
  const title = h("b");
  const family = tag("");
  const conn = tag("");
  const dup = tag("possible duplicate", "dup");
  head.append(title, family, conn, dup);
  const meta = h("div", "state-line");
  let view;
  if (r.mapped) {
    view = makePad();
  } else {
    view = { el: h("div", "raw") };
    view.axes = h("div", "raw-axes");
    view.btns = h("div", "raw-btns");
    view.hats = h("div", "state-line");
    view.el.append(h("div", "state-line", "No standard mapping for this device: raw numbers"), view.axes, view.btns, view.hats);
  }
  const cap = h("div", "pressed-line");
  el.append(head, meta, view.el, cap);
  return { el, title, family, conn, dup, meta, view, cap };
}

function updateReal(c, r) {
  c.title.textContent = r.name;
  c.family.textContent = r.familyName + (r.api === "XInput" ? " (XInput)" : "");
  c.conn.textContent = `Connection: ${r.connection}`;
  c.dup.hidden = !r.duplicate;
  if (r.duplicate) c.dup.title = r.duplicate;
  c.meta.textContent = (r.vidpid ? `ID ${r.vidpid}` : r.player ? `XInput slot ${r.slot + 1} · Player ${r.player}` : "")
    + (r.outsideXInput ? " · outside XInput slots" : "") + (r.ambiguous ? ` · ${r.ambiguous}` : "");
  if (r.mapped) {
    c.view.update(r, r.labels);
    c.cap.textContent = pressedText(r, r.labels);
  } else {
    const v = c.view;
    v.axes.replaceChildren(...r.rawAxes.map((a, i) => h("div", "", `Axis ${i}: ${a.toFixed(2)}`)));
    const pressed = new Set(r.rawButtons);
    v.btns.replaceChildren(...Array.from({ length: r.rawButtonCount }, (_, i) => h("div", `key${pressed.has(i) ? " lit" : ""}`, String(i))));
    v.hats.textContent = r.rawHats.length ? `Hat: ${r.rawHats.map((x) => `(${x[0]}, ${x[1]})`).join(" ")}` : "";
    c.cap.textContent = r.rawButtons.length ? `Buttons: ${r.rawButtons.join(", ")}` : "";
  }
}

// ---- connection ----

let ws = null;
let codeAt = 0;
let codeTtl = 0;
let toastTimer = 0;

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
}

function admin(action, id, extra = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "admin", token: TOKEN, action, id, ...extra }));
}

// ---- view, filter, size (remembered between launches) ----

const prefs = {
  get(k, d) { try { return localStorage.getItem(`dash.${k}`) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`dash.${k}`, v); } catch {} },
};
let view = ["detailed", "grid", "list"].includes(prefs.get("view")) ? prefs.get("view") : "detailed";
let filter = ["all", "devices", "pads", "real"].includes(prefs.get("filter")) ? prefs.get("filter") : "all";
let scale = Math.min(150, Math.max(50, Number(prefs.get("scale", 100)) || 100));
let last = null; // newest state from the PC

function applyPrefs() {
  document.body.dataset.view = view;
  document.body.dataset.filter = filter;
  document.documentElement.style.setProperty("--scale", String(scale / 100));
  $("size").value = String(scale);
  $("sizev").textContent = `${scale}%`;
  for (const b of $("views").children) b.classList.toggle("on", b.dataset.v === view);
  for (const b of $("filters").children) b.classList.toggle("on", b.dataset.v === filter);
}
for (const b of $("views").children) b.onclick = () => { view = b.dataset.v; prefs.set("view", view); applyPrefs(); render(); };
for (const b of $("filters").children) b.onclick = () => { filter = b.dataset.v; prefs.set("filter", filter); applyPrefs(); render(); };
$("size").oninput = (e) => { scale = Number(e.target.value); prefs.set("scale", scale); applyPrefs(); };

// ---- summary bar ----

function summarize(s) {
  const oursSlot = s.pads.filter((p) => p.slot != null).length;
  const oursExtra = s.pads.length - oursSlot;
  const realX = s.real.filter((r) => r.api === "XInput").length;
  const used = oursSlot + realX;
  const other = s.real.length - realX + oursExtra;
  const total = s.pads.length + s.real.length;
  $("sumtext").textContent = `Controllers: ${total} total \u00b7 XInput slots ${used}/4 used (real ${realX} \u00b7 virtual ${oursSlot}) \u00b7 Other ${other}`;
  const full = used >= 4;
  $("summary").classList.toggle("full", full);
  $("sumnote").textContent = full ? "Extra controllers only work in games that don't use XInput (e.g. Steam Input games)" : "";
}

// ---- list view ----

const MINI_BUTTONS = ["a", "b", "x", "y", "lb", "rb", "back", "start", "l3", "r3", "dpad_up", "dpad_down", "dpad_left", "dpad_right"];
const ARROWS = { dpad_up: "\u2191", dpad_down: "\u2193", dpad_left: "\u2190", dpad_right: "\u2192" };

function rowCard() {
  const el = h("div", "row");
  const name = h("div", "r-name");
  const title = h("b");
  const kind = tag("");
  name.append(title, kind);
  const slot = h("div", "r-slot");
  const ping = h("div", "r-ping");
  const sticks = h("div", "r-sticks");
  const dots = [0, 1].map(() => {
    const box = h("div", "mini-stick");
    const dot = h("i");
    box.append(dot);
    sticks.append(box);
    return dot;
  });
  const trig = h("div", "r-trig");
  const bars = [0, 1].map(() => {
    const box = h("div", "mini-bar");
    const fill = h("i");
    box.append(fill);
    trig.append(box);
    return fill;
  });
  const btns = h("div", "r-btns");
  const chips = {};
  for (const n of MINI_BUTTONS) {
    chips[n] = h("div", "key", ARROWS[n] ?? n);
    btns.append(chips[n]);
  }
  const text = h("div", "txt");
  text.hidden = true;
  btns.append(text);
  el.append(name, slot, ping, sticks, trig, btns);
  return { el, title, kind, slot, ping, dots, bars, chips, text };
}

function updateRow(c, it) {
  c.el.classList.toggle("offline", !!it.offline);
  c.title.textContent = it.name;
  c.title.title = it.name;
  c.kind.textContent = it.type;
  c.slot.textContent = it.slot;
  c.ping.textContent = it.ping;
  const st = it.state;
  const L = { ...DEFAULT_LABELS, ...(it.labels || {}) };
  [[st?.lx || 0, st?.ly || 0], [st?.rx || 0, st?.ry || 0]].forEach(([x, y], i) => {
    const mag = Math.hypot(x, y);
    const k = mag > 1 ? 1 / mag : 1;
    c.dots[i].style.transform = `translate(${x * k * 9}px, ${-y * k * 9}px)`;
    c.dots[i].classList.toggle("lit", mag > 0.05);
  });
  c.bars[0].style.width = `${Math.round((st?.lt || 0) * 100)}%`;
  c.bars[1].style.width = `${Math.round((st?.rt || 0) * 100)}%`;
  const pressed = new Set(st?.pressed || []);
  for (const n of MINI_BUTTONS) {
    const chip = c.chips[n];
    chip.classList.toggle("lit", pressed.has(n));
    const label = ARROWS[n] ?? short(L[n] ?? n);
    if (chip.textContent !== label) chip.textContent = label;
    chip.hidden = !st;
  }
  c.text.hidden = !!st;
  c.text.textContent = it.note || "";
}

function listItems(s) {
  const owners = new Map(s.devices.map((d) => [d.id, d]));
  const items = [];
  const fmtPing = (d) => (d && d.online && d.stats?.ping != null ? `${fmt(d.stats.ping)} ms` : "--");
  if (filter === "all" || filter === "devices") {
    for (const d of s.devices) {
      const slot = d.player ? `Player ${d.player}` : d.extra ? "Extra controller" : "--";
      const held = [...d.keys, ...d.buttons.map((b) => `mouse ${b}`)];
      items.push({
        key: `d:${d.id}`, name: d.name, type: `App ${d.role}`, slot, ping: fmtPing(d), state: d.pad, offline: !d.online && d.grace == null,
        note: d.online ? (held.length ? `Held: ${held.join(", ")}` : "Idle") : "Offline",
      });
    }
  }
  if (filter === "all" || filter === "pads") {
    for (const p of s.pads) {
      items.push({
        key: `p:${p.owner}`, name: `Virtual pad \u00b7 ${p.ownerName}`, type: "Our pad",
        slot: p.slot == null ? "Extra controller" : `Slot ${p.slot + 1} \u00b7 Player ${p.player}`, ping: fmtPing(owners.get(p.owner)), state: p.state,
      });
    }
  }
  if (filter === "all" || filter === "real") {
    for (const r of s.real) {
      items.push({
        key: `r:${r.id}`, name: r.name,
        type: `${r.familyName}${r.connection !== "unknown" ? ` \u00b7 ${r.connection}` : ""}${r.duplicate ? " \u00b7 possible duplicate" : ""}`,
        slot: r.outsideXInput ? "Outside XInput" : r.player ? `Player ${r.player}` : "--", ping: "--",
        state: r.mapped ? r : null, labels: r.labels,
        note: r.mapped ? "" : r.rawButtons?.length ? `Buttons: ${r.rawButtons.join(", ")}` : "Raw device",
      });
    }
  }
  return items;
}

// ---- rendering (only what is visible is updated) ----

function renderKbm(k) {
  $("kbmbadge").hidden = !k.running;
  const box = $("kbm");
  box.checked = k.forced || k.saved;
  box.disabled = k.forced;
  $("kbmtoggle").title = k.forced ? "Forced on by KBM_ONLY=1 for this run" : $("kbmtoggle").title;
  $("kbmbar").hidden = !k.restartRequired;
  const want = k.forced || k.saved ? "ON" : "OFF";
  $("kbmtext").textContent = `Restart required to turn KB/M only mode ${want}.${k.canRestart ? "" : " Restart the server yourself (this copy has no restart button)."}`;
  $("restart").hidden = !k.canRestart;
}

function render() {
  const s = last;
  if (!s) return;
  summarize(s);
  if (s.kbm) renderKbm(s.kbm);
  const code = $("code");
  codeAt = performance.now();
  codeTtl = s.pairing.ttl;
  code.textContent = s.pairing.code || "----";
  code.classList.toggle("none", !s.pairing.code);
  const err = $("sdlerr");
  err.hidden = !s.sdlError;
  err.textContent = s.sdlError || "";
  if (view === "list") {
    const items = listItems(s);
    $("nolist").hidden = items.length > 0;
    keyed($("list"), items, (i) => i.key, rowCard, updateRow);
    return;
  }
  if (filter === "all" || filter === "devices") {
    $("nodevices").hidden = s.devices.length > 0;
    keyed($("devices"), s.devices, (d) => d.id, deviceCard, updateDevice);
  }
  if (filter === "all" || filter === "pads") {
    $("nopads").hidden = s.pads.length > 0;
    keyed($("pads"), s.pads, (p) => p.owner, padCard, updatePad);
  }
  if (filter === "all" || filter === "real") {
    $("noreal").hidden = s.real.length > 0;
    keyed($("real"), s.real, (r) => `${r.id}:${r.mapped}`, realCard, updateReal);
  }
}

function onState(s) {
  last = s;
  render();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/dash?token=${encodeURIComponent(TOKEN)}`);
  ws.onopen = () => {
    $("link").textContent = "live";
    $("link").className = "pill on";
    ws.send(JSON.stringify({ t: "active", on: !document.hidden && active }));
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "state") onState(m);
    else if (m.t === "hello") {
      $("url").textContent = m.url;
      $("dry").hidden = !m.dry;
    } else if (m.t === "result") toast(m.msg);
  };
  ws.onclose = () => {
    $("link").textContent = "disconnected";
    $("link").className = "pill off";
    setTimeout(connect, 1000);
  };
}

// The desktop app hides the window to the tray; it tells the page so sampling can stop (saves CPU).
let active = true;
function sendActive() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "active", on: !document.hidden && active }));
}
window.setActive = (on) => {
  active = !!on;
  sendActive();
};
document.addEventListener("visibilitychange", sendActive);
// "Show pairing code" from the tray: make sure a code exists, then scroll to it.
window.showPairing = () => {
  admin("code");
  $("admin").scrollIntoView({ behavior: "smooth" });
};

$("newcode").onclick = () => admin("newcode");
$("kbm").onchange = (e) => admin("setkbm", undefined, { on: e.target.checked });
$("restart").onclick = () => {
  if (confirm("Restart now? Held inputs are released and virtual controllers are removed first.")) admin("restart");
};
setInterval(() => {
  const left = Math.max(0, codeTtl - Math.round((performance.now() - codeAt) / 1000));
  $("codeinfo").textContent = $("code").classList.contains("none")
    ? "No code is active. Devices that need one get it when they connect, or press New code."
    : `Valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}. Single use.`;
}, 500);

applyPrefs();
if (!TOKEN) {
  $("link").textContent = "no access token: open this from the desktop app";
  $("link").className = "pill off";
} else {
  connect();
}
