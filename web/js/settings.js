// Live settings that are not part of the layout. The output mode (WASD/XBOX) now belongs to the
// active profile and is saved with it (see profiles.js); this only holds it for listeners.

export class Settings {
  constructor(mode = "wasd") {
    this.values = { mode };
    this.listeners = new Map(); // key -> Set<fn(value)>
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    this.listeners.get(key)?.forEach((fn) => fn(value));
  }

  /** Subscribe to changes of one key. Returns an unsubscribe function. */
  on(key, fn) {
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(fn);
    return () => this.listeners.get(key)?.delete(fn);
  }
}
