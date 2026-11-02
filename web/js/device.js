// This device's identity: a random id made once, the token the PC gave it when it paired, and a
// name the user can edit. Stored in localStorage (every access guarded; it still works for the
// current session if storage is blocked, but the device would have to pair again next time).

const KEY = "padDevice";

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a); // available on plain http, unlike crypto.randomUUID
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  return "Browser";
}

export class DeviceIdentity {
  constructor() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY)); } catch {}
    this.id = typeof saved?.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(saved.id) ? saved.id : randomHex(16);
    this.token = typeof saved?.token === "string" ? saved.token : null;
    this.name = typeof saved?.name === "string" && saved.name ? saved.name : guessDeviceName();
    this.#save();
  }

  #save() {
    try { localStorage.setItem(KEY, JSON.stringify({ id: this.id, token: this.token, name: this.name })); } catch {}
  }

  setToken(token) { this.token = token; this.#save(); }
  setName(name) { this.name = name; this.#save(); }
  forgetToken() { this.token = null; this.#save(); }

  /** Headers that authenticate an API request. */
  headers() {
    return this.token ? { "X-Device-Id": this.id, "X-Device-Token": this.token } : {};
  }
}
