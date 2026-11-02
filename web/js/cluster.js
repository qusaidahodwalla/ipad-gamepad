// The status cluster (ping, profile, mode, fullscreen, lock): where it sits and how it looks.
// Its settings live in the layout (layout.cluster), so they are saved per profile.
//
// x/y = null keeps the default top-right spot (set by CSS). Otherwise x/y are the cluster's
// top-left corner as % of the play area, like controls. The cluster is kept fully on screen even
// when its size changes (live ping text, orientation).

export const CLUSTER_ID = "__status";

const bar = () => document.getElementById("topbar");
const layer = () => document.getElementById("hud-layer");

let current = null;

/** Apply layout.cluster to the DOM. */
export function applyCluster(cluster) {
  current = cluster;
  const el = bar();
  el.classList.toggle("vertical", cluster.orientation === "vertical");
  el.style.opacity = String(cluster.opacity);
  if (cluster.x === null || cluster.y === null) {
    delete el.dataset.pos;
    el.style.removeProperty("--cx");
    el.style.removeProperty("--cy");
  } else {
    el.dataset.pos = "custom";
    el.style.setProperty("--cx", String(cluster.x));
    el.style.setProperty("--cy", String(cluster.y));
  }
  fitCluster();
}

/** Pull the drawn position back on screen without touching the saved value. */
export function fitCluster() {
  if (!current || current.x === null || current.y === null) return;
  const { width: lw, height: lh } = layer().getBoundingClientRect();
  const { width: w, height: h } = bar().getBoundingClientRect();
  if (!lw || !lh) return;
  const el = bar();
  el.style.setProperty("--cx", String(Math.min(current.x, Math.max(0, ((lw - w) / lw) * 100))));
  el.style.setProperty("--cy", String(Math.min(current.y, Math.max(0, ((lh - h) / lh) * 100))));
}

/** The cluster's rectangle as % of the play area (what a control's x, y, w, h mean). */
export function clusterRectPct() {
  const l = layer().getBoundingClientRect();
  const r = bar().getBoundingClientRect();
  return {
    x: ((r.left - l.left) / l.width) * 100,
    y: ((r.top - l.top) / l.height) * 100,
    w: (r.width / l.width) * 100,
    h: (r.height / l.height) * 100,
  };
}

// Keep it on screen when the window or the cluster's own size changes.
new ResizeObserver(() => fitCluster()).observe(bar());
window.addEventListener("resize", () => fitCluster());
