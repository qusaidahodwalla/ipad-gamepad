// Top bar: connection status, ping stats over the last 10 s, touch event rate, output mode.

const WINDOW_MS = 10000;

export class Hud {
  constructor() {
    this.statusEl = document.getElementById("status");
    this.pingEl = document.getElementById("ping");
    this.rateEl = document.getElementById("rate");
    this.samples = []; // [timestamp, rtt]
    this.moveEvents = 0;

    setInterval(() => this.#render(), 250);
    setInterval(() => {
      this.rateEl.textContent = `${this.moveEvents} ev/s`;
      this.moveEvents = 0;
    }, 1000);
  }

  /** Wire the joystick output mode chip (WASD / XBOX) to the settings store. */
  bindSettings(settings) {
    const modeBtn = document.getElementById("mode-btn");
    this.modeBtn = modeBtn;
    const show = () => { modeBtn.textContent = settings.get("mode").toUpperCase(); };
    settings.on("mode", show);
    show();
    modeBtn.addEventListener("click", () => {
      if (this.role === "controller" || this.kbm) return; // a controller has Xbox output only; KB/M only mode is WASD
      settings.set("mode", settings.get("mode") === "wasd" ? "xbox" : "wasd");
    });
  }

  /** A controller can't use keyboard output, so its WASD/XBOX switch is locked on XBOX. */
  setRole(role) {
    this.role = role;
    if (this.modeBtn) {
      this.modeBtn.disabled = role === "controller" || !!this.kbm;
      this.modeBtn.title = role === "controller" ? "Controllers send Xbox output only" : this.kbm ? "KB/M only mode: WASD" : "Joystick output";
    }
  }

  /** KB/M only mode on the PC: show the badge and lock the output switch on WASD. */
  setKbm(on) {
    this.kbm = on;
    document.getElementById("kbm").hidden = !on;
    if (this.modeBtn && on) {
      this.modeBtn.disabled = true;
      this.modeBtn.title = "KB/M only mode: WASD";
    } else if (this.modeBtn) {
      this.setRole(this.role); // back to the role's own rule
    }
  }

  /** "P2" when this device has a virtual pad (Windows' player number), hidden otherwise. */
  setPlayer(n, extra = false) {
    const el = document.getElementById("player");
    el.hidden = !n && !extra;
    el.textContent = n ? `P${n}` : extra ? "EXT" : "";
    el.title = n ? `You are Player ${n}` : extra ? "Extra controller: outside XInput slots 1-4" : "";
  }

  toast(text) {
    const el = document.getElementById("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove("show"), 5000);
  }

  setOnline(online) {
    this.statusEl.title = online ? "online" : "offline";
    this.statusEl.className = `status ${online ? "on" : "off"}`; // a dot, coloured by state
    if (!online) this.samples = [];
  }

  addRtt(ms) {
    this.samples.push([performance.now(), ms]);
  }

  /** Count of raw touch samples (coalesced) handled, to see the real delivery rate. */
  noteMoves(n) {
    this.moveEvents += n;
  }

  /** Ping numbers over the last 10 s for the PC dashboard's report-only `stats` message. */
  pingStats() {
    const cutoff = performance.now() - WINDOW_MS;
    const vals = this.samples.filter((x) => x[0] >= cutoff).map((x) => x[1]);
    if (!vals.length) return {};
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const jitter = Math.sqrt(vals.reduce((a, v) => a + (v - avg) ** 2, 0) / vals.length);
    return { ping: vals[vals.length - 1], avg, jitter };
  }

  #render() {
    const cutoff = performance.now() - WINDOW_MS;
    while (this.samples.length && this.samples[0][0] < cutoff) this.samples.shift();
    if (!this.samples.length) {
      this.pingEl.textContent = "-- ms";
      return;
    }
    const vals = this.samples.map((s) => s[1]);
    const cur = vals[vals.length - 1];
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const max = Math.max(...vals);
    // Jitter = standard deviation of the ping over the window.
    const jitter = Math.sqrt(vals.reduce((a, v) => a + (v - avg) ** 2, 0) / vals.length);
    const parts = [`${cur.toFixed(0)} ms`, `avg ${avg.toFixed(1)}`, `max ${max.toFixed(0)}`, `jit ${jitter.toFixed(1)}`];
    const vertical = document.getElementById("topbar").classList.contains("vertical");
    this.pingEl.textContent = parts.join(vertical ? "\n" : " · ");
  }
}
