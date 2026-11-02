// Profiles: name + layout + output mode. The PC (profiles folder) is the source of truth; the
// active profile is also cached in localStorage so the app loads instantly and works if the PC
// is briefly unreachable. Edits are saved to the PC shortly after they happen.
//
// Exposes the same surface the editor used on the old layout store:
// layout, save(), replace(), applyPreset(), reset().

import { buildPreset, loadLegacyLayout, readLegacy, defaultLayout, sanitizeLayout } from "./layout.js";
import { validateProfile } from "./schema.js";

const CACHE_KEY = "padProfile";
const SAVE_DELAY_MS = 400;
const NAG_MS = 15000; // don't repeat the "can't reach PC" toast more often than this

const clone = (o) => JSON.parse(JSON.stringify(o));

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

/** The part of a profile that is stored and compared. */
const body = (p) => ({ version: 1, name: p.name, mode: p.mode, layout: p.layout });

function errorText(payload) {
  const d = payload?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d) && d[0]?.msg) return d[0].msg;
  return null;
}

// Every API call proves which paired device it comes from (see device.js).
let authHeaders = () => ({});
export function setApiAuth(fn) {
  authHeaders = fn;
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...authHeaders(), ...(options.headers ?? {}) } });
  } catch {
    throw new Error("Can't reach the PC");
  }
  let payload = null;
  try { payload = await res.json(); } catch {}
  if (!res.ok) throw new Error(errorText(payload) ?? `PC error ${res.status}`);
  return payload;
}

const post = (path, data = {}) => api(path, { method: "POST", body: JSON.stringify(data) });

export class ProfileStore {
  /** @param {{toast:(msg:string)=>void}} opts */
  constructor({ toast }) {
    this.toast = toast;
    this.onBeforeSwitch = null; // called before the active profile changes (release inputs)
    this.onActivated = null; // called after a different profile became active
    this.onRenamed = null;
    this.saveTimer = null;
    this.chain = Promise.resolve(); // serialises pushes to the PC
    this.lastNag = 0;

    const cached = this.#readCache();
    if (cached) {
      this.active = cached.profile;
      this.dirty = cached.dirty;
    } else {
      // First run with profiles: migrate whatever layout and mode this iPad had saved.
      this.active = this.#seedFromLegacy();
      this.dirty = true; // not on the PC yet
      this.#writeCache();
    }
  }

  get id() { return this.active.id; }
  get name() { return this.active.name; }
  get mode() { return this.active.mode; }
  get layout() { return this.active.layout; }

  // ---- local cache ----

  #readCache() {
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_KEY));
      const p = raw?.profile;
      if (!p || (p.id !== null && typeof p.id !== "string") || validateProfile(body(p))) return null;
      const layout = sanitizeLayout(p.layout);
      if (!layout) return null;
      return { profile: { id: p.id, name: p.name, mode: p.mode, layout }, dirty: !!raw.dirty };
    } catch {
      return null;
    }
  }

  #writeCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ profile: this.active, dirty: this.dirty })); } catch {}
  }

  #seedFromLegacy() {
    const legacyLayout = loadLegacyLayout();
    let mode = "wasd";
    try {
      const s = JSON.parse(localStorage.getItem("padSettings") || "{}");
      if (s.mode === "xbox") mode = "xbox";
    } catch {}
    return {
      id: null,
      name: legacyLayout ? "My layout" : "Default",
      mode,
      layout: legacyLayout ?? defaultLayout(readLegacy()),
    };
  }

  #warn(err) {
    const now = Date.now();
    if (now - this.lastNag < NAG_MS) return;
    this.lastNag = now;
    this.toast(`Couldn't save to the PC (${err.message}). Kept on this iPad.`);
  }

  // ---- editing the active profile ----

  /** Persist the active profile: cache now, PC shortly after. */
  save() {
    this.dirty = true;
    this.#writeCache();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  replace(layout) {
    this.active.layout = layout;
    this.save();
  }

  applyPreset(id) {
    this.replace(buildPreset(id));
  }

  /** Restore the preset this layout is based on. */
  reset() {
    this.applyPreset(this.layout.preset);
  }

  setMode(mode) {
    if (this.active.mode === mode) return;
    this.active.mode = mode;
    this.save();
  }

  /** Push unsaved changes to the PC now. Resolves true when nothing is left unsaved. */
  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.chain = this.chain.then(() => this.#push());
    return this.chain;
  }

  async #push() {
    if (!this.dirty) return true;
    const snapshot = clone(this.active);
    try {
      if (snapshot.id) {
        await api(`/api/profiles/${snapshot.id}`, { method: "PUT", body: JSON.stringify(body(snapshot)) });
      } else {
        const created = await post("/api/profiles", body(snapshot));
        if (this.active.id === null) {
          this.active.id = created.id;
          this.active.name = created.name; // the PC may have made the name unique
        }
        api("/api/last-profile", { method: "PUT", body: JSON.stringify({ id: created.id }) }).catch(() => {});
      }
      if (deepEqual(body(this.active), body(snapshot))) this.dirty = false; // unchanged while saving
      this.#writeCache();
      return !this.dirty;
    } catch (err) {
      this.#warn(err);
      return false;
    }
  }

  // ---- talking to the PC ----

  list() {
    return api("/api/profiles"); // { profiles: [{id,name,mode}], last, problems: [{file,error}] }
  }

  async #fetch(id) {
    const remote = await api(`/api/profiles/${id}`);
    const err = validateProfile(body(remote));
    if (err) throw new Error(`PC sent a bad profile: ${err}`);
    return remote;
  }

  #adopt(remote, reason) {
    this.active = {
      id: remote.id,
      name: remote.name,
      mode: remote.mode,
      layout: sanitizeLayout(remote.layout),
    };
    this.dirty = false;
    this.#writeCache();
    this.onActivated?.(reason);
  }

  /** Reconcile with the PC (on every connect). The PC wins unless this iPad has unsent edits. */
  async sync() {
    let info;
    try {
      info = await this.list();
    } catch {
      return; // PC unreachable: keep working from the cache
    }
    if (info.problems?.length) {
      const p = info.problems[0];
      this.toast(`Ignored a bad profile file: ${p.file}: ${p.error}`);
    }
    const known = (id) => info.profiles.some((p) => p.id === id);

    if (this.dirty) {
      if (this.active.id && known(this.active.id)) {
        await this.flush();
      } else if (this.active.id || info.profiles.length === 0) {
        this.active.id = null; // first run, or the PC's folder was cleared: (re)create it
        await this.flush();
      } else {
        // A fresh iPad seed while the PC already has profiles: the PC's copy wins.
        await this.#adoptLast(info);
      }
      return;
    }
    if (info.profiles.length === 0) {
      this.active.id = null;
      this.dirty = true;
      await this.flush();
      return;
    }
    const target = info.last ?? info.profiles[0].id;
    const remote = await this.#fetch(target).catch((e) => { this.toast(e.message); return null; });
    if (remote && (target !== this.active.id || !this.#sameAs(remote))) this.#adopt(remote, "sync");
  }

  /** Same name, mode and (sanitized) layout as the PC's copy. */
  #sameAs(remote) {
    return (
      remote.name === this.active.name &&
      remote.mode === this.active.mode &&
      deepEqual(sanitizeLayout(remote.layout), sanitizeLayout(this.active.layout))
    );
  }

  async #adoptLast(info) {
    const target = info.last ?? info.profiles[0].id;
    this.#adopt(await this.#fetch(target), "sync");
  }

  async #setLast(id) {
    api("/api/last-profile", { method: "PUT", body: JSON.stringify({ id }) }).catch(() => {});
  }

  /** Make the profile with this id active. */
  async activate(id) {
    if (id === this.active.id) return;
    this.onBeforeSwitch?.();
    await this.flush(); // keep the edits of the profile we are leaving
    const remote = await this.#fetch(id);
    this.#adopt(remote, "switch");
    this.#setLast(id);
  }

  async #create(profile) {
    this.onBeforeSwitch?.();
    await this.flush();
    const created = await post("/api/profiles", body(profile));
    this.#adopt(created, "new");
    this.#setLast(created.id);
  }

  /** New profile from a built-in preset (templates are read-only; this makes a copy to edit). */
  newFromPreset(presetId, name) {
    return this.#create({ name, mode: this.mode, layout: buildPreset(presetId) });
  }

  async duplicate() {
    this.onBeforeSwitch?.();
    await this.flush();
    const copy = await post(`/api/profiles/${this.id}/duplicate`);
    this.#adopt(copy, "new");
    this.#setLast(copy.id);
  }

  async rename(name) {
    await this.flush();
    const renamed = await post(`/api/profiles/${this.id}/rename`, { name });
    this.active.name = renamed.name;
    this.#writeCache();
    this.onRenamed?.();
  }

  async remove() {
    await api(`/api/profiles/${this.id}`, { method: "DELETE" }); // the PC refuses to delete the last one
    this.dirty = false;
    this.onBeforeSwitch?.();
    await this.#adoptLast(await this.list());
  }

  /** Import a profile file's text as a new profile. Throws a readable error if it is not valid. */
  async importText(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("That file is not valid JSON");
    }
    const err = validateProfile(data);
    if (err) throw new Error(err);
    await this.#create({ name: data.name.trim(), mode: data.mode, layout: data.layout });
  }

  /** A one-time download link for the saved profile file (a browser download can't send headers). */
  async exportLink() {
    await this.flush();
    return (await post(`/api/profiles/${this.id}/export-link`)).url;
  }

  /**
   * A new controller device starts on the Phone Controller preset. Any seeded local layout is dropped
   * first: it has keyboard bindings, which a controller may not use.
   */
  async createControllerDefault(name) {
    this.dirty = false;
    await this.newFromPreset("phone", name);
  }
}
