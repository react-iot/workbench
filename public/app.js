import { DeviceSession, tplRoot } from "./session.js";

export const APP_VERSION = globalThis.__APP_VERSION__ || "dev";

const portsEl = document.getElementById("ports");
const panelsEl = document.getElementById("panels");
const offlineBanner = document.getElementById("offline-banner");
const refreshBtn = document.getElementById("refresh");
const aboutBtn = document.getElementById("about-btn");
const aboutDialog = document.getElementById("about-dialog");
const appVersionEl = document.getElementById("app-version");
const aboutVersionEl = document.getElementById("about-version");

appVersionEl.textContent = `v${APP_VERSION}`;
aboutVersionEl.textContent = APP_VERSION;

aboutBtn.addEventListener("click", () => {
  if (typeof aboutDialog.showModal === "function") aboutDialog.showModal();
  else aboutDialog.setAttribute("open", "");
});
aboutDialog.addEventListener("click", (e) => {
  if (e.target === aboutDialog) aboutDialog.close();
});

let currentPorts = [];
let selectedPath = null;
const sessions = new Map(); // path -> DeviceSession

function setStatus(connected) {
  offlineBanner.hidden = connected;
  document.body.classList.toggle("has-offline-banner", !connected);
}

function renderPorts() {
  portsEl.innerHTML = "";

  // Merge: discovered ports + any open-session paths that aren't in the list
  const merged = [...currentPorts];
  const seen = new Set(merged.map((p) => p.path));
  for (const [path, s] of sessions) {
    if (!seen.has(path)) merged.push(s.portInfo ?? { path });
  }

  if (merged.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No serial devices detected";
    portsEl.appendChild(li);
    return;
  }

  for (const p of merged) {
    const session = sessions.get(p.path);
    const identified = session
      ? Boolean(session.firmwareBanner || session.deviceInfo?.chip || p.serialNumber)
      : false;

    // Clone the sidebar <li> from #tpl-port-li. The template includes every
    // optional sub-element (port-dot, port-close, port-meta, port-path.sub,
    // port-state, port-tcp). We remove the ones that don't apply for this row
    // so the DOM ends up identical to the previous createElement-based path.
    const li = tplRoot("tpl-port-li");
    li.dataset.path = p.path;
    li.classList.toggle("open", Boolean(session));
    li.classList.toggle("selected", Boolean(session) && p.path === selectedPath);
    li.classList.toggle("identified", Boolean(session) && identified);
    if (session?.stateKind === "ok") li.classList.add("connected");
    else if (session?.stateKind === "error") li.classList.add("error");

    const header = li.querySelector(".port-header");
    const dotEl = li.querySelector(".port-dot");
    const closeBtn = li.querySelector(".port-close");
    const titleEl = li.querySelector(".port-title");
    const metaEl = li.querySelector(".port-meta");
    const pathEl = li.querySelector(".port-path");
    const stateEl = li.querySelector(".port-state");
    const tcpEl = li.querySelector(".port-tcp");

    titleEl.textContent = session ? session.getDisplayTitle() : p.path;

    if (!session) {
      dotEl.remove();
      closeBtn.remove();
    } else {
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeSession(p.path);
      });
    }

    if (session?.logPath) {
      // Logging indication is carried by the port-dot pulse; hover title
      // still surfaces the log file path for users.
      header.title = `Logging to ${session.logPath}`;
    }

    // --- meta line -----------------------------------------------------------
    if (session) {
      const { id, hwFw } = session.getDisplayMetaParts();
      if (id) {
        const idEl = document.createElement("span");
        idEl.className = "port-id";
        idEl.textContent = id;
        metaEl.appendChild(idEl);
      }
      if (hwFw) {
        if (id) metaEl.appendChild(document.createTextNode(" - "));
        metaEl.appendChild(document.createTextNode(hwFw));
      }
      if (!id && !hwFw) {
        const parts = [];
        if (p.manufacturer) parts.push(p.manufacturer);
        if (p.serialNumber) parts.push(`SN ${p.serialNumber}`);
        metaEl.textContent = parts.join(" · ");
      }
    } else {
      const parts = [];
      if (p.manufacturer) parts.push(p.manufacturer);
      if (p.vendorId) parts.push(`${p.vendorId}:${p.productId ?? "?"}`);
      if (p.serialNumber) parts.push(`SN ${p.serialNumber}`);
      metaEl.textContent = parts.join(" · ") || p.friendlyName || "";
    }
    if (!metaEl.childNodes.length) metaEl.remove();

    // --- path sub-line -------------------------------------------------------
    if (session && session.getDisplayTitle() !== p.path) {
      pathEl.textContent = p.path;
    } else {
      pathEl.remove();
    }

    // --- state ---------------------------------------------------------------
    if (session?.stateText && session.stateText !== "idle") {
      stateEl.textContent = session.stateText;
    } else {
      stateEl.remove();
    }

    // --- RFC2217 TCP line ----------------------------------------------------
    if (p.tcpPort) {
      tcpEl.querySelector(".addr").textContent = `tcp :${p.tcpPort}`;
      tcpEl.title = `Connect with: socat - TCP:${location.hostname}:${p.tcpPort}`;
      tcpEl.addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(`${location.hostname}:${p.tcpPort}`);
      });
    } else {
      tcpEl.remove();
    }

    li.addEventListener("click", () => {
      if (sessions.has(p.path)) activate(p.path);
      else openSession(p.path);
    });
    portsEl.appendChild(li);
  }
}

function openSession(path) {
  if (sessions.has(path)) {
    activate(path);
    return;
  }
  const portInfo = currentPorts.find((p) => p.path === path) ?? { path };
  const session = new DeviceSession(path, {
    panelsEl,
    portInfo,
    onActivate: activate,
    onClose: closeSession,
    onChange: () => renderPorts(),
  });
  sessions.set(path, session);
  session.mount();
  activate(path);
  renderPorts();
}

function activate(path) {
  selectedPath = path;
  for (const [p, s] of sessions) s.setActive(p === path);
  renderPorts();
}

function closeSession(path) {
  const s = sessions.get(path);
  if (!s) return;
  s.dispose();
  sessions.delete(path);
  if (selectedPath === path) selectedPath = null;
  const remaining = Array.from(sessions.keys());
  if (remaining.length) activate(remaining[remaining.length - 1]);
  else renderPorts();
}

function connectPortList() {
  const ws = new WebSocket(`ws://${location.host}/ws/ports`);
  ws.onopen = () => setStatus(true);
  ws.onclose = () => {
    setStatus(false);
    setTimeout(connectPortList, 1500);
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "ports") {
        currentPorts = msg.ports;
        renderPorts();
      }
    } catch (e) {
      console.error("ws/ports parse:", e);
    }
  };
}

refreshBtn.addEventListener("click", async () => {
  const r = await fetch("/api/ports");
  const json = await r.json();
  currentPorts = json.ports;
  renderPorts();
});

const themeMql = matchMedia("(prefers-color-scheme: light)");

function applyTheme(pref) {
  const resolved = pref === "system" ? (themeMql.matches ? "light" : "dark") : pref;
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.dataset.themePref = pref;
  for (const btn of document.querySelectorAll(".theme-group [data-theme-choice]")) {
    btn.setAttribute("aria-pressed", btn.dataset.themeChoice === pref ? "true" : "false");
  }
  window.dispatchEvent(new CustomEvent("themechange", { detail: { pref, resolved } }));
}

function getThemePref() {
  return localStorage.getItem("theme") || "system";
}

for (const btn of document.querySelectorAll(".theme-group [data-theme-choice]")) {
  btn.addEventListener("click", () => {
    const pref = btn.dataset.themeChoice;
    localStorage.setItem("theme", pref);
    applyTheme(pref);
  });
}

themeMql.addEventListener("change", () => {
  if (getThemePref() === "system") applyTheme("system");
});

applyTheme(getThemePref());

connectPortList();
