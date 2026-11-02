// Profile menus: the edit-mode menu (switch, new, duplicate, rename, delete, export, import)
// and the play-mode quick switcher (long-press the profile name in the status cluster).

import { askText, confirmBox } from "./dialog.js";
import { PRESETS } from "./layout.js";

const LONG_PRESS_MS = 600;

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  n.append(...kids);
  return n;
}

export class ProfileUI {
  /**
   * @param {{store:import("./profiles.js").ProfileStore, toast:(msg:string)=>void,
   *          getRole:()=>string|null, openDevices:()=>void}} opts
   */
  constructor({ store, toast, getRole, openDevices }) {
    this.store = store;
    this.toast = toast;
    this.getRole = getRole;
    this.openDevices = openDevices;
    this.nameBtn = document.getElementById("profile-name");
    this.menuBtn = document.getElementById("profile-btn");
    this.switcher = document.getElementById("switcher");
    this.menu = document.getElementById("profile-menu");
    this.file = document.getElementById("import-file");

    // Long-press the name to open the switcher; a short tap only hints.
    let timer = null;
    this.nameBtn.addEventListener("pointerdown", () => {
      this.nameBtn.classList.add("holding");
      timer = setTimeout(() => {
        timer = null;
        this.nameBtn.classList.remove("holding");
        this.#openSwitcher();
      }, LONG_PRESS_MS);
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
      this.nameBtn.addEventListener(type, (e) => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
        this.nameBtn.classList.remove("holding");
        if (e.type === "pointerup") this.toast("Hold the profile name to switch profiles");
      });
    }

    this.menuBtn.addEventListener("click", () => (this.menu.hidden ? this.#openMenu() : this.close()));
    this.file.addEventListener("change", () => this.#import());
    // Tapping anywhere else closes the popovers.
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!e.target.closest("#switcher, #profile-menu, #profile-btn, .dialog-backdrop")) this.close();
      },
      true,
    );
    this.refresh();
  }

  refresh() {
    this.nameBtn.textContent = this.store.name;
    this.menuBtn.textContent = `${this.store.name} ▾`;
  }

  close() {
    this.switcher.hidden = true;
    this.menu.hidden = true;
  }

  async #run(fn, failure) {
    try {
      await fn();
    } catch (err) {
      this.toast(`${failure}: ${err.message}`);
    }
  }

  /** Fill `box` with one row per profile; tapping a row switches to it. */
  async #fillList(box) {
    let info;
    try {
      info = await this.store.list();
    } catch (err) {
      info = { profiles: [{ id: this.store.id, name: this.store.name, mode: this.store.mode }], problems: [] };
      this.toast(`${err.message}: showing the current profile only`);
    }
    box.replaceChildren();
    for (const p of info.profiles) {
      const active = p.id === this.store.id;
      const row = el("button", { type: "button", className: `pitem${active ? " active" : ""}` },
        el("span", { className: "pname", textContent: p.name }),
        el("small", { textContent: p.mode.toUpperCase() }));
      row.addEventListener("click", () => {
        this.close();
        if (!active) this.#run(() => this.store.activate(p.id), "Couldn't switch profile");
      });
      box.append(row);
    }
    if (info.problems?.length) {
      box.append(el("div", { className: "pnote", textContent: `${info.problems.length} bad profile file(s) ignored` }));
    }
    return info;
  }

  async #openSwitcher() {
    this.menu.hidden = true;
    const r = document.getElementById("topbar").getBoundingClientRect();
    const width = 260;
    const below = r.top < innerHeight / 2; // open downward from a top cluster, upward from a bottom one
    this.switcher.style.right = "auto";
    this.switcher.style.left = `${Math.round(Math.min(Math.max(8, r.right - width), innerWidth - width - 8))}px`;
    this.switcher.style.top = below ? `${Math.round(r.bottom + 6)}px` : "auto";
    this.switcher.style.bottom = below ? "auto" : `${Math.round(innerHeight - r.top + 6)}px`;
    this.switcher.replaceChildren(el("div", { className: "pnote", textContent: "Switch profile" }));
    this.switcher.hidden = false;
    const list = el("div", { className: "plist" });
    this.switcher.append(list);
    await this.#fillList(list);
    const devices = el("button", { type: "button", className: "pitem devices", textContent: "Devices..." });
    devices.addEventListener("click", () => { this.close(); this.openDevices(); });
    list.append(devices);
  }

  async #openMenu() {
    this.switcher.hidden = true;
    const r = this.menuBtn.getBoundingClientRect();
    this.menu.style.top = `${Math.round(r.bottom + 6)}px`;
    this.menu.style.left = `${Math.round(Math.max(8, r.left))}px`;
    this.menu.replaceChildren();
    this.menu.hidden = false;
    const list = el("div", { className: "plist" });
    this.menu.append(list);
    const info = await this.#fillList(list);

    const act = (label, fn, { danger = false, disabled = false } = {}) => {
      const b = el("button", { type: "button", className: `pact${danger ? " danger" : ""}`, textContent: label, disabled });
      b.addEventListener("click", fn);
      return b;
    };
    const newFrom = (preset) => act(`New from ${preset.name}`, async () => {
      this.close();
      const name = await askText({ title: `New profile from ${preset.name}`, value: preset.name, ok: "Create" });
      if (name) await this.#run(() => this.store.newFromPreset(preset.id, name), "Couldn't create profile");
    });
    this.menu.append(
      el("div", { className: "pgrid" },
        ...PRESETS.filter((p) => p.roles.includes(this.getRole() ?? "host")).map(newFrom),
        act("Duplicate", () => { this.close(); this.#run(() => this.store.duplicate(), "Couldn't duplicate"); }),
        act("Rename", async () => {
          this.close();
          const name = await askText({ title: "Rename profile", value: this.store.name, ok: "Rename" });
          if (name && name !== this.store.name) await this.#run(() => this.store.rename(name), "Couldn't rename");
        }),
        act("Devices", () => { this.close(); this.openDevices(); }),
        act("Export", () => this.#export()),
        act("Import", () => { this.close(); this.file.value = ""; this.file.click(); }),
        act("Delete", async () => {
          this.close();
          const ok = await confirmBox({
            title: `Delete "${this.store.name}"?`,
            message: "The profile file is removed from the PC. This can't be undone.",
            ok: "Delete",
            danger: true,
          });
          if (ok) await this.#run(() => this.store.remove(), "Couldn't delete");
        }, { danger: true, disabled: info.profiles.length <= 1 }),
      ),
    );
  }

  async #export() {
    this.close();
    await this.#run(async () => {
      if (!(await this.store.flush())) throw new Error("unsaved changes could not reach the PC");
      // The PC hands out a one-time link to the saved file; a new tab keeps the app itself in place.
      const url = await this.store.exportLink();
      const a = el("a", { href: url, target: "_blank", rel: "noopener", download: `${this.store.id}.json` });
      document.body.append(a);
      a.click();
      a.remove();
    }, "Couldn't export");
  }

  async #import() {
    const file = this.file.files[0];
    if (!file) return;
    await this.#run(async () => {
      await this.store.importText(await file.text());
      this.toast(`Imported "${this.store.name}"`);
    }, "Import failed");
  }
}
