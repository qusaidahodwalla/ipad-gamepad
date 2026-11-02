// WebSocket with auto-reconnect, a ping loop that doubles as the server heartbeat, and the
// pairing handshake. Until the server answers "welcome" the socket is unpaired: only hello, pair
// and ping go out (the server ignores anything else too).

const PING_INTERVAL_MS = 250;
const PONG_TIMEOUT_MS = 2000;
const RECONNECT_MS = 500;
const BEFORE_WELCOME = new Set(["p", "hello", "pair"]);

export class Net {
  /**
   * @param {{
   *   hello: () => object,                         the hello message (device id, token, name)
   *   onStatus: (online:boolean) => void,          socket open/closed
   *   onRtt: (ms:number) => void,
   *   onClose: () => void,
   *   onAuth?: () => void,                         the server doesn't know this device: pair it
   *   onPaired?: (msg:object) => void,             pairing worked; msg.token is the saved token
   *   onPairFailed?: (msg:object) => void,
   *   onWelcome?: (msg:object) => void,            authenticated: role, host id, ...
   *   onForgotten?: () => void,                    the host revoked this device
   *   onMessage?: (msg:object) => void,            everything else (notices, pad, rumble, role)
   * }} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.ws = null;
    this.pingId = 0;
    this.pending = new Map();
    this.lastPong = 0;
    this.timer = null;
    this.authed = false;
  }

  connect() {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.lastPong = performance.now();
      this.authed = false;
      this.hooks.onStatus(true);
      this.send(this.hooks.hello());
      this.timer = setInterval(() => this.#tick(), PING_INTERVAL_MS);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      switch (msg.t) {
        case "o": {
          const sent = this.pending.get(msg.id);
          if (sent === undefined) return;
          this.pending.delete(msg.id);
          this.lastPong = performance.now();
          this.hooks.onRtt(this.lastPong - sent);
          return;
        }
        case "auth": return this.hooks.onAuth?.();
        case "paired": return this.hooks.onPaired?.(msg);
        case "pair_failed": return this.hooks.onPairFailed?.(msg);
        case "welcome":
          this.authed = true;
          return this.hooks.onWelcome?.(msg);
        case "forgotten": return this.hooks.onForgotten?.();
        default: this.hooks.onMessage?.(msg);
      }
    };
    ws.onclose = () => {
      clearInterval(this.timer);
      this.pending.clear();
      this.authed = false;
      if (this.ws === ws) this.ws = null;
      this.hooks.onStatus(false);
      this.hooks.onClose();
      setTimeout(() => this.connect(), RECONNECT_MS);
    };
    ws.onerror = () => ws.close();
  }

  #tick() {
    // Silent link (e.g. Wi-Fi dropped but socket not yet closed): force a reconnect.
    if (performance.now() - this.lastPong > PONG_TIMEOUT_MS) {
      this.ws?.close();
      return;
    }
    const id = ++this.pingId;
    this.pending.set(id, performance.now());
    this.send({ t: "p", id });
  }

  send(obj) {
    if (!this.authed && !BEFORE_WELCOME.has(obj.t)) return; // an unpaired device sends no input
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}
