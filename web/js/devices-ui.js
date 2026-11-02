// The Devices dialog: every paired device, its role and player number, and what this device may do.
//
//   rename   this device, or any device if this one is the host
//   make host   host only: moves the host role (the old host becomes a controller)
//   forget   host forgets any other device; any device may forget itself, except the host.
//            Forgetting revokes the token and removes the device's virtual pad.

import { askText, confirmBox } from "./dialog.js";

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  n.append(...kids);
  return n;
}

async function call(identity, method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", ...identity.headers() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Can't reach the PC");
  }
  let payload = null;
  try { payload = await res.json(); } catch {}
  if (!res.ok) throw new Error(typeof payload?.detail === "string" ? payload.detail : `PC error ${res.status}`);
  return payload;
}

/** @param {{identity: import("./device.js").DeviceIdentity, toast:(m:string)=>void, getRole:()=>string|null}} opts */
export function showDevices({ identity, toast, getRole }) {
  const backdrop = el("div", { className: "dialog-backdrop" });
  const card = el("div", { className: "dialog wide", role: "dialog" });
  const list = el("div", { className: "dlist" });
  const closeBtn = el("button", { type: "button", className: "pbtn", textContent: "Close" });
  closeBtn.addEventListener("click", () => backdrop.remove());
  backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) backdrop.remove(); });
  card.append(
    el("h3", { textContent: "Devices" }),
    el("p", { textContent: "Only the host can use the keyboard and mouse. Controllers send Xbox output to their own virtual pad." }),
    list,
    el("div", { className: "dialog-actions" }, closeBtn),
  );
  backdrop.append(card);
  document.body.append(backdrop);

  const act = async (fn, failure) => {
    try {
      await fn();
    } catch (err) {
      toast(`${failure}: ${err.message}`);
    }
    await refresh();
  };

  async function refresh() {
    let info;
    try {
      info = await call(identity, "GET", "/api/devices");
    } catch (err) {
      list.replaceChildren(el("p", { className: "pairnote error", textContent: err.message }));
      return;
    }
    const iAmHost = info.hostId === info.you;
    list.replaceChildren(
      ...info.devices.map((d) => {
        const row = el("div", { className: "drow" });
        const badges = el("span", { className: "dbadges" },
          el("span", { className: `rolebadge ${d.role}`, textContent: d.role === "host" ? "HOST" : "CONTROLLER" }),
          el("span", { className: `dot ${d.online ? "on" : "off"}`, title: d.online ? "online" : "offline" }),
          ...(d.player ? [el("span", { className: "badge", textContent: `P${d.player}` })] : []),
        );
        const title = el("div", { className: "dname" }, el("span", { textContent: d.name }), ...(d.you ? [el("small", { textContent: " (this device)" })] : []), badges);
        const buttons = el("div", { className: "dactions" });
        const add = (label, fn, danger = false) => {
          const b = el("button", { type: "button", className: `pact${danger ? " danger" : ""}`, textContent: label });
          b.addEventListener("click", fn);
          buttons.append(b);
        };
        if (d.you || iAmHost) {
          add("Rename", async () => {
            const name = await askText({ title: `Rename ${d.name}`, value: d.name, ok: "Rename", max: 24 });
            if (!name || name === d.name) return;
            if (d.you) identity.setName(name);
            await act(() => call(identity, "POST", `/api/devices/${d.id}/rename`, { name }), "Couldn't rename");
          });
        }
        if (iAmHost && d.role !== "host") {
          add("Make host", async () => {
            const ok = await confirmBox({
              title: `Make "${d.name}" the host?`,
              message: "It will get keyboard and mouse control. This device (the current host) becomes a controller and everything it holds is released.",
              ok: "Make host",
            });
            if (ok) await act(() => call(identity, "POST", `/api/devices/${d.id}/role`, { role: "host" }), "Couldn't change host");
          });
        }
        if ((iAmHost && !d.you) || (d.you && !iAmHost)) {
          add("Forget", async () => {
            const ok = await confirmBox({
              title: `Forget "${d.name}"?`,
              message: d.you
                ? "This device is signed out and its virtual controller is removed. To use it again it must pair with a new code."
                : "Its access is revoked and its virtual controller is removed. It must pair with a new code to come back.",
              ok: "Forget",
              danger: true,
            });
            if (ok) await act(() => call(identity, "POST", `/api/devices/${d.id}/forget`), "Couldn't forget device");
          }, true);
        }
        row.append(title, buttons);
        return row;
      }),
    );
  }
  refresh();
  return { close: () => backdrop.remove(), refresh };
}
