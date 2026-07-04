// Per-port session with a nested tab strip (Console / Device / Partitions /
// Apps / Files / Flash / NVS / Log). One WebSocket per session; tabs share it
// and communicate with the backend via JSON control frames.
//
// Control frames (client → server, all JSON strings):
//   { type: "write", data }               raw bytes for Console
//   { type: "reset", bootloader? }        toggle DTR/RTS via backend
//   { type: "device-info-request" }       ask backend to identify chip
//   { type: "partitions-request" }
//   { type: "apps-request" }
//   { type: "fs-list", fs }               fs: "spiffs" | "littlefs" | "fatfs"
//   { type: "fs-read", fs, path }
//   { type: "fs-write", fs, path, size }
//   { type: "fs-delete", fs, path }
//   { type: "flash-request", offset, erase, name, size }
//   { type: "flash-cancel" }
//   { type: "nvs-read" }
//
// Control frames (server → client):
//   { type: "open" | "error" | "closed" } existing session lifecycle
//   { type: "device-info", info }
//   { type: "partitions", partitions, flashSize }
//   { type: "apps", slots }
//   { type: "fs-list-result", fs, files, usage }
//   { type: "progress", op, done, total }
//   { type: "nvs-result", namespaces }
//   { type: "log", level, message }
//
// Binary frames are raw serial bytes and flow only to the Console tab.

const BAUDS = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600];

// Clone a <template id=…> from index.html and return a fragment of its
// content. Use tplRoot when you want the single top-level element instead of a
// fragment (e.g. for the panel wrapper <div> or flash dialog <dialog>).
export function tpl(id) {
  const t = document.getElementById(id);
  if (!t || t.tagName !== "TEMPLATE") {
    throw new Error(`template not found: #${id}`);
  }
  return t.content.cloneNode(true);
}

export function tplRoot(id) {
  return tpl(id).firstElementChild;
}

function readTerminalTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  return {
    background: v("--term-bg", "#0b1f3a"),
    foreground: v("--fg-1", "#f2f5fa"),
    cursor: v("--term-cursor", "#7fb0ff"),
    // Bias the ESP-IDF log colors toward the redesign's terminal tokens
    // (green info body, amber warn, muted meta). See design handoff.
    green: v("--term-msg", "#9fd3a4"),
    yellow: v("--term-warn", "#e8a33d"),
    cyan: v("--term-tag", "#d9a86a"),
    brightBlack: v("--term-meta", "#5f7fb0"),
    red: v("--danger", "#ef4444"),
  };
}

// ----- Firmware banner detector -------------------------------------------
//
// Scans the console byte stream for an ASCII block delimited by rows of
// ``#`` characters, with content lines of the form ``## KEY: VALUE ##`` or
// ``## free text ##``. Common layout:
//
//   #################################
//   ## Blynd Data Pty Ltd           ##
//   ## Env. Controller              ##
//   ## ID: 3C:8A:1F:86:85:B7        ##
//   ## HW: blyx-env-r4              ##
//   ## FW: v0.1.450                 ##
//   #################################
//
// Keys are normalized to upper case; the two free-text lines (if present)
// are stored as VENDOR and PRODUCT respectively.

class BannerDetector {
  constructor(onDetect) {
    this.onDetect = onDetect;
    this.buf = "";
    this.inBanner = false;
    this.fields = {};
    this.rawLines = [];
    this.decoder = new TextDecoder("utf-8", { fatal: false });
  }
  feed(chunk) {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    this.buf += text;
    // Guard against runaway buffer if no newlines ever come (binary noise).
    if (this.buf.length > 16384) this.buf = this.buf.slice(-8192);
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "");
      this.buf = this.buf.slice(idx + 1);
      this.#processLine(line);
    }
  }
  #processLine(line) {
    if (/^#{10,}\s*$/.test(line)) {
      if (this.inBanner) {
        this.#emit();
        this.inBanner = false;
      } else {
        this.inBanner = true;
        this.fields = {};
        this.rawLines = [];
      }
      return;
    }
    if (!this.inBanner) return;
    this.rawLines.push(line);
    const m = /^##\s*(.+?)\s*##$/.exec(line);
    if (!m) return;
    const content = m[1].trim();
    const kv = /^([A-Za-z][\w\- ]*?):\s*(.+)$/.exec(content);
    if (kv) {
      this.fields[kv[1].toUpperCase().replace(/\s+/g, "_")] = kv[2].trim();
    } else if (content) {
      if (!this.fields.VENDOR) this.fields.VENDOR = content;
      else if (!this.fields.PRODUCT) this.fields.PRODUCT = content;
    }
  }
  #emit() {
    if (Object.keys(this.fields).length === 0) return;
    this.onDetect({ fields: { ...this.fields }, raw: [...this.rawLines] });
  }
}

export class DeviceSession {
  constructor(path, { panelsEl, portInfo, onActivate, onClose, onChange, defaultBaud = 115200 }) {
    this.path = path;
    this.baudRate = defaultBaud;
    this.panelsEl = panelsEl;
    this.portInfo = portInfo ?? { path };
    this.onActivate = onActivate;
    this.onClose = onClose;
    this.onChange = onChange;
    this.ws = null;
    this.connected = false;
    this.deviceInfo = null;
    this.firmwareBanner = null;
    this.stateText = "idle";
    this.stateKind = null;
    this.logId = null;
    this.logPath = null;
    this.logSize = 0;
    this.cacheId = null;
    this.cachedAt = null;
    this.bannerDetector = new BannerDetector((b) => this.#onBanner(b));

    this.#buildPanel();
    this.tabs = this.#buildTabs();
  }

  #notifyChange() {
    try { this.onChange?.(this); } catch (e) { console.error("onChange:", e); }
  }

  getDisplayTitle() {
    const b = this.firmwareBanner?.fields;
    if (b?.PRODUCT) return b.PRODUCT;
    if (b?.VENDOR) return b.VENDOR;
    if (this.deviceInfo?.chip) return this.deviceInfo.chip;
    return this.path.split("/").pop() || this.path;
  }

  getDisplayMetaParts() {
    const b = this.firmwareBanner?.fields;
    const id = b?.ID ?? (this.portInfo?.serialNumber ? `SN ${this.portInfo.serialNumber}` : null);
    const hwFw = [b?.HW, b?.FW].filter(Boolean).join(" ") || null;
    return { id, hwFw };
  }
  getDisplayMeta() {
    const { id, hwFw } = this.getDisplayMetaParts();
    if (id && hwFw) return `${id} - ${hwFw}`;
    return id || hwFw || "";
  }

  #resolveLogId() {
    const bannerId = this.firmwareBanner?.fields?.ID;
    if (bannerId && /^[0-9A-Fa-f:]{11,}$/.test(bannerId)) return `mac:${bannerId.toUpperCase()}`;
    const mac = this.deviceInfo?.mac;
    if (mac) return `mac:${String(mac).toUpperCase()}`;
    const sn = this.portInfo?.serialNumber;
    if (sn && !isGenericSerial(sn)) return `sn:${sn}`;
    return null;
  }

  #maybeEnableLog() {
    if (this.logId) return;
    const id = this.#resolveLogId();
    if (!id) return;
    if (!this.connected) return;
    this.logId = id;
    this.send({ type: "log-enable", id });
  }

  #maybeLoadCache() {
    const id = this.#resolveLogId();
    if (!id) return;
    if (this.cacheId === id) return; // already loaded for this id
    const cache = readDeviceCache(id);
    if (!cache) {
      this.cacheId = id;
      return;
    }
    this.cacheId = id;
    this.cachedAt = cache.cachedAt ?? null;
    if (cache.deviceInfo && !this.deviceInfo) {
      this.deviceInfo = cache.deviceInfo;
      for (const t of this.tabs) {
        t.onMessage?.({ type: "device-info", info: cache.deviceInfo, cached: true });
      }
    }
    if (cache.partitions) {
      for (const t of this.tabs) {
        t.onMessage?.({
          type: "partitions",
          partitions: cache.partitions,
          flashSize: cache.flashSize,
          flashSizeLabel: cache.flashSizeLabel,
          cached: true,
        });
      }
    }
    if (cache.apps) {
      for (const t of this.tabs) {
        t.onMessage?.({ type: "apps", slots: cache.apps, cached: true });
      }
    }
    const when = cache.cachedAt ? new Date(cache.cachedAt).toLocaleString() : "unknown";
    this.logEvent("info", `Restored cached device data for ${id} (${when})`);
    this.#notifyChange();
  }

  #cacheDevice(patch) {
    const id = this.#resolveLogId();
    if (!id) return;
    writeDeviceCache(id, patch);
    this.cacheId = id;
    this.cachedAt = Date.now();
  }

  #buildPanel() {
    this.panel = tplRoot("tpl-panel");
    this.panel.querySelector(".path").textContent = this.path;
    const baudSel = this.panel.querySelector(".baud");
    for (const b of BAUDS) {
      const o = document.createElement("option");
      o.value = String(b);
      o.textContent = String(b);
      if (b === this.baudRate) o.selected = true;
      baudSel.appendChild(o);
    }
    baudSel.addEventListener("change", () => {
      this.baudRate = Number(baudSel.value);
      this.reconnect();
    });
    this.panel.querySelector(".reconnect").addEventListener("click", () => this.reconnect());
    this.panel.addEventListener("ui-reset", () => {
      this.send({ type: "reset" });
      this.logEvent("info", "Reset requested");
    });
    this.discoverBtn = this.panel.querySelector(".discover");
    this.discoverBtn.disabled = true;
    this.discoverBtn.addEventListener("click", () => this.#discover());

    this.flashOpenBtn = this.panel.querySelector('[is="ui-button-flash-open"]');
    this.flashOpenBtn.disabled = true;
    this.panel.addEventListener("ui-flash-open", () => this.flashDialog?.show());

    this.flashModeEl = this.panel.querySelector('[is="ui-button-flash-mode"]');
    if (this.flashModeEl) {
      this.flashModeEl.disabled = true;
      this.panel.addEventListener("flashmode", () => this.#enterFlashMode());
    }

    this.subtabsEl = this.panel.querySelector(".subtabs");
    this.subpanelsEl = this.panel.querySelector(".subpanels");
  }

  discover() { return this.#discover(); }
  #discover() {
    if (this.discoverBtn.disabled) return;
    if (!this.connected) {
      this.logEvent("error", "Discover: not connected");
      return;
    }
    this.discoverBtn.disabled = true;
    this.#setDiscoverLabel("Entering bootloader…");
    this.logEvent("info", "Discover: chip + partitions + apps + NVS");
    const ok = this.send({ type: "detect-chip-request" });
    if (!ok) {
      this.discoverBtn.disabled = false;
      this.#setDiscoverLabel("Discover");
      return;
    }
    clearTimeout(this._discoverTimer);
    this._discoverTimer = setTimeout(() => {
      if (!this.discoverBtn.disabled) return;
      this.discoverBtn.disabled = false;
      this.#setDiscoverLabel("Discover");
      this.logEvent("error", "Discover: no progress within 60s");
    }, 60000);
  }

  #setDiscoverLabel(text) {
    this.discoverBtn.textContent = text;
  }

  #onBanner(b) {
    this.firmwareBanner = b;
    const label = b.fields.PRODUCT ?? b.fields.VENDOR ?? "device";
    this.logEvent("info", `Firmware banner detected: ${label}${b.fields.FW ? " " + b.fields.FW : ""}`);
    const msg = { type: "firmware-banner", fields: b.fields, raw: b.raw };
    for (const t of this.tabs) t.onMessage?.(msg);
    this.#maybeEnableLog();
    this.#maybeLoadCache();
    this.#notifyChange();
  }

  #updateDiscoverFromStatus(msg) {
    if (msg.type !== "detect-status") return;
    if (msg.state === "running") {
      this.discoverBtn.disabled = true;
      this.#setDiscoverLabel("Syncing ROM…");
    } else if (msg.state === "scanning") {
      this.discoverBtn.disabled = true;
      this.#setDiscoverLabel("Reading flash…");
    } else if (msg.state === "done") {
      this.discoverBtn.disabled = false;
      this.#setDiscoverLabel("Discover");
      clearTimeout(this._discoverTimer);
      this.logEvent("info", "Discover complete — chip rebooted into user app");
    } else if (msg.state === "error") {
      this.discoverBtn.disabled = false;
      this.#setDiscoverLabel("Discover");
      clearTimeout(this._discoverTimer);
      this.logEvent("error", `Discover failed: ${msg.message}`);
    }
  }

  #enterFlashMode() {
    if (!this.flashModeEl || this.flashModeEl.disabled) return;
    this.flashModeEl.entering();
    this.logEvent("info", "Entering flash mode (IO0 low → EN pulse)…");
    const ok = this.send({ type: "flash-mode" });
    if (!ok) {
      this.flashModeEl.reset();
      return;
    }
    this._flashModeTimer = setTimeout(() => {
      this.flashModeEl?.reset();
      this.logEvent("error", "Flash mode: no response within 3s");
    }, 3000);
  }

  #buildTabs() {
    const tabs = [
      new ConsoleTab(this),
      new DeviceTab(this),
      new PartitionsTab(this),
      new FilesTab(this),
      new NvsTab(this),
      new LogTab(this),
    ];
    this.activeTab = null;
    for (const t of tabs) {
      const btn = document.createElement("button");
      btn.className = "subtab";
      btn.textContent = t.label;
      btn.addEventListener("click", () => {
        if (btn.classList.contains("disabled")) return;
        this.activateTab(t);
      });
      t.button = btn;
      t.setEnabled(!t.requiresDevice);
      this.subtabsEl.appendChild(btn);
    }
    return tabs;
  }

  mount() {
    this.panelsEl.appendChild(this.panel);
    for (const t of this.tabs) {
      t.mount();
      this.subpanelsEl.appendChild(t.el);
    }
    this.flashDialog = new FlashDialog(this);
    this.flashDialog.mount();
    this.panel.appendChild(this.flashDialog.el);
    this.activateTab(this.tabs[0]);
    this.connect();
  }

  activateTab(tab) {
    if (this.activeTab === tab) return;
    for (const t of this.tabs) {
      const isActive = t === tab;
      t.button.classList.toggle("active", isActive);
      t.el.classList.toggle("active", isActive);
    }
    if (this.activeTab) this.activeTab.onHide();
    this.activeTab = tab;
    tab.onShow();
  }

  setActive(active) {
    this.panel.classList.toggle("active", active);
    if (active) this.activeTab?.onShow();
  }

  setState(text, kind) {
    const el = this.panel.querySelector(".state");
    el.textContent = text;
    this.stateText = text;
    this.stateKind = kind ?? null;
    this.#notifyChange();
  }

  connect() {
    this._reconnectDelay = this._reconnectDelay ?? 1000;
    this._disposed = this._disposed ?? false;
    clearTimeout(this._reconnectTimer);

    this.setState("connecting…");
    const url = `ws://${location.host}/ws/serial?path=${encodeURIComponent(this.path)}&baud=${this.baudRate}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          for (const t of this.tabs) t.onData?.(ev.data);
          return;
        }
        try {
          this.#handleControl(msg);
        } catch (err) {
          this.logEvent("error", `handler error for ${msg.type}: ${err?.message ?? err}`);
        }
        return;
      }
      const buf = new Uint8Array(ev.data);
      this.bannerDetector.feed(buf);
      for (const t of this.tabs) t.onData?.(buf);
    };

    this.ws.onopen = () => {
      this._reconnectDelay = 1000;
    };

    this.ws.onclose = () => {
      if (this.connected) this.setState("disconnected", "error");
      this.connected = false;
      this.logId = null;
      this.logPath = null;
      for (const t of this.tabs) if (t.requiresDevice) t.setEnabled(false);
      if (this.discoverBtn) this.discoverBtn.disabled = true;
      if (this.flashOpenBtn) this.flashOpenBtn.disabled = true;
      if (this.flashModeEl) this.flashModeEl.disabled = true;
      if (!this._disposed) this._scheduleReconnect();
    };
    this.ws.onerror = () => this.setState("ws error", "error");
  }

  _scheduleReconnect() {
    const delay = this._reconnectDelay ?? 1000;
    this._reconnectDelay = Math.min(delay * 2, 16000);
    this.setState(`reconnecting in ${(delay / 1000).toFixed(0)}s…`);
    this._reconnectTimer = setTimeout(() => {
      if (!this._disposed) this.connect();
    }, delay);
  }

  #handleControl(msg) {
    switch (msg.type) {
      case "open":
        this.connected = true;
        this.setState(`connected @ ${msg.baudRate}`, "ok");
        this.logEvent("info", `Connected to ${msg.path} @ ${msg.baudRate}`);
        for (const t of this.tabs) if (t.requiresDevice) t.setEnabled(true);
        if (this.discoverBtn) this.discoverBtn.disabled = false;
        if (this.flashOpenBtn) this.flashOpenBtn.disabled = false;
        if (this.flashModeEl) this.flashModeEl.disabled = false;
        this.send({ type: "device-info-request" });
        this.#maybeEnableLog();
        this.#maybeLoadCache();
        break;
      case "error":
        this.setState(`error: ${msg.message}`, "error");
        this.logEvent("error", msg.message);
        break;
      case "closed":
        this.setState(`closed: ${msg.reason}`, "error");
        this.logEvent("warn", `closed: ${msg.reason}`);
        for (const t of this.tabs) if (t.requiresDevice) t.setEnabled(false);
        if (this.discoverBtn) this.discoverBtn.disabled = true;
        if (this.flashOpenBtn) this.flashOpenBtn.disabled = true;
        if (this.flashModeEl) this.flashModeEl.disabled = true;
        break;
      case "device-info":
        this.deviceInfo = msg.info;
        this.logEvent("info", `Detected ${msg.info?.chip ?? "device"}`);
        this.#maybeEnableLog();
        this.#maybeLoadCache();
        if (msg.info?.chip) this.#cacheDevice({ deviceInfo: msg.info });
        this.#notifyChange();
        break;
      case "log-status":
        if (msg.state === "active") {
          this.logPath = msg.path;
          this.logSize = msg.size ?? 0;
          this.logEvent("info", `Logging to ${msg.path}`);
        } else if (msg.state === "disabled") {
          this.logPath = null;
          this.logEvent("info", "Logging disabled");
        } else if (msg.state === "error") {
          this.logId = null;
          this.logPath = null;
          this.logEvent("warn", `Log: ${msg.message}`);
        }
        this.#notifyChange();
        break;
      case "log":
        this.logEvent(msg.level ?? "info", msg.message);
        break;
      case "detect-status":
        this.#updateDiscoverFromStatus(msg);
        break;
      case "cp210x-status":
        this.logEvent(
          msg.state === "error" ? "error" : "info",
          `CP210x: ${msg.state}${msg.message ? ` — ${msg.message}` : ""}${msg.wrote ? ` (wrote ${msg.wrote})` : ""}`,
        );
        if (msg.platformHint) this.logEvent("warn", `CP210x hint: ${msg.platformHint}`);
        break;
      case "partitions":
        if (!msg.cached && Array.isArray(msg.partitions)) {
          this.#cacheDevice({
            partitions: msg.partitions,
            flashSize: msg.flashSize ?? null,
            flashSizeLabel: msg.flashSizeLabel ?? null,
          });
        }
        break;
      case "apps":
        if (!msg.cached && Array.isArray(msg.slots)) {
          this.#cacheDevice({ apps: msg.slots });
        }
        break;
      case "flash-mode-ack":
        clearTimeout(this._flashModeTimer);
        this.flashModeEl?.reset();
        this.logEvent("info", "Device is in flash mode — ready for flashing tool");
        break;
    }
    for (const t of this.tabs) t.onMessage?.(msg);
    this.flashDialog?.onMessage?.(msg);
  }

  send(msg) {
    const state = this.ws?.readyState;
    if (state === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    const label = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"][state ?? 3] ?? "?";
    this.logEvent("error", `send(${msg.type}) dropped — WS state=${label}`);
    console.warn("send dropped:", msg, "state=", label);
    return false;
  }

  logEvent(level, message) {
    for (const t of this.tabs) if (t instanceof LogTab) t.append({ ts: new Date(), level, message });
  }

  reconnect() {
    this._reconnectDelay = 1000;
    clearTimeout(this._reconnectTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.connect();
  }

  dispose() {
    this._disposed = true;
    clearTimeout(this._reconnectTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
    for (const t of this.tabs) t.dispose();
    this.flashDialog?.dispose?.();
    this.panel.remove();
  }
}

// ---- Tab classes ----------------------------------------------------------

class BaseTab {
  constructor(session) {
    this.session = session;
    this.el = document.createElement("div");
    this.el.className = "subpanel";
    this.button = null;
  }
  get label() { return "Tab"; }
  get requiresDevice() { return true; }
  mount() {}
  onShow() {}
  onHide() {}
  onMessage(_msg) {}
  onData(_chunk) {}
  setEnabled(on) {
    if (!this.button) return;
    this.button.classList.toggle("disabled", !on);
    this.button.disabled = !on;
  }
  dispose() {}
}

class ConsoleTab extends BaseTab {
  get label() { return "Console"; }
  get requiresDevice() { return false; }
  #colorize = makeEspIdfColorizer();
  #colorsOn = true;
  mount() {
    this.el.classList.add("console");
    this.el.appendChild(tpl("tpl-console-tab"));
    this.term = new Terminal({
      fontFamily: '"SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: readTerminalTheme(),
      convertEol: true,
      scrollback: 5000,
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.el.querySelector(".terminal-wrap"));
    this.term.onData((data) => this.session.send({ type: "write", data }));

    this.onThemeChange = () => { this.term.options.theme = readTerminalTheme(); };
    window.addEventListener("themechange", this.onThemeChange);

    this.ro = new ResizeObserver(() => this.fit?.fit());
    this.ro.observe(this.el);

    this.el.querySelector(".clear").addEventListener("click", () => this.term.clear());
    this.el.querySelector(".ctrl-c").addEventListener("click", () => {
      this.session.send({ type: "write", data: "\x03" });
    });

    const colorBtn = this.el.querySelector(".color-toggle");
    colorBtn.addEventListener("click", () => {
      this.#colorsOn = !this.#colorsOn;
      colorBtn.classList.toggle("active", this.#colorsOn);
    });

    this.#wireCommandBar();
  }

  #wireCommandBar() {
    const form = this.el.querySelector(".command-bar");
    const input = this.el.querySelector(".cmd-input");
    const eolSel = this.el.querySelector(".cmd-eol");
    this.history = [];
    this.historyIdx = -1;      // -1 = not browsing, points past newest
    this.draft = "";

    const decodeEol = (val) => val.replace(/\\r/g, "\r").replace(/\\n/g, "\n");

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value;
      if (!text && !eolSel.value) return;
      const eol = decodeEol(eolSel.value);
      const payload = text + eol;
      const sent = this.session.send({ type: "write", data: payload });
      if (!sent) {
        this.session.logEvent("error", "Console: send dropped (WS not open)");
        return;
      }
      // Echo what we sent into the terminal so the user sees it alongside
      // incoming output. Dim colour so it's visually separable from device
      // output.
      if (text) this.term?.write(`\x1b[90m> ${text}\x1b[0m\r\n`);
      if (text && this.history[this.history.length - 1] !== text) {
        this.history.push(text);
        if (this.history.length > 200) this.history.shift();
      }
      this.historyIdx = -1;
      this.draft = "";
      input.value = "";
      input.focus();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp") {
        if (!this.history.length) return;
        if (this.historyIdx === -1) {
          this.draft = input.value;
          this.historyIdx = this.history.length - 1;
        } else if (this.historyIdx > 0) {
          this.historyIdx--;
        }
        input.value = this.history[this.historyIdx];
        input.setSelectionRange(input.value.length, input.value.length);
        e.preventDefault();
      } else if (e.key === "ArrowDown") {
        if (this.historyIdx === -1) return;
        if (this.historyIdx < this.history.length - 1) {
          this.historyIdx++;
          input.value = this.history[this.historyIdx];
        } else {
          this.historyIdx = -1;
          input.value = this.draft;
        }
        input.setSelectionRange(input.value.length, input.value.length);
        e.preventDefault();
      } else if (e.key === "Escape") {
        input.value = "";
        this.historyIdx = -1;
        this.draft = "";
      }
    });
  }

  onShow() {
    requestAnimationFrame(() => { this.fit?.fit(); this.term?.focus(); });
  }
  onData(chunk) {
    this.term?.write(this.#colorsOn ? this.#colorize(chunk) : chunk);
  }
  onMessage(_msg) {}
  dispose() {
    this.ro?.disconnect();
    if (this.onThemeChange) window.removeEventListener("themechange", this.onThemeChange);
    this.term?.dispose();
  }
}

class DeviceTab extends BaseTab {
  get label() { return "Device"; }
  mount() {
    this.el.classList.add("device-info");
    this.el.appendChild(tpl("tpl-device-tab"));
    this.#renderTransport();
  }
  #renderTransport() {
    const p = this.session.portInfo || {};
    const set = (k, v) => { const el = this.el.querySelector(`[data-k="${k}"]`); if (el) el.textContent = v || "—"; };
    set("path", p.path);
    set("baud", this.session.baudRate);
    set("tcp", p.tcpPort ? `:${p.tcpPort}` : "");
    set("productName", p.productName);
    set("manufacturer", p.manufacturer);
    set("vendor", p.vendorName);
    set("vidpid", p.vendorId ? `${p.vendorId}:${p.productId ?? "?"}` : "");
    set("serial", p.serialNumber);
    set("location", p.locationId);
    set("pnpId", p.pnpId);
    if (this.session.firmwareBanner) this.#renderFirmwareBanner(this.session.firmwareBanner.fields);
    // Re-evaluate the MAC-match hint using the last-seen chip MAC.
    const chipMacEl = this.el.querySelector('[data-k="mac"]');
    const chipMac = chipMacEl?.textContent;
    if (chipMac && chipMac !== "—") this.#renderMacMatch(chipMac);
  }

  #renderFirmwareBanner(fields) {
    const setFw = (k, v) => {
      const el = this.el.querySelector(`[data-fw="${k}"]`);
      if (el) el.textContent = v || "—";
    };
    setFw("VENDOR", fields.VENDOR);
    setFw("PRODUCT", fields.PRODUCT);
    setFw("ID", fields.ID);
    setFw("HW", fields.HW);
    setFw("FW", fields.FW);

    const hint = this.el.querySelector("[data-fw-hint]");
    hint.className = "hint";
    const stamp = [fields.PRODUCT, fields.FW].filter(Boolean).join(" ");
    hint.textContent = stamp ? `Banner received: ${stamp}.` : "Banner received.";

    this.#renderHwMatch(fields.HW);
  }

  // If the firmware banner has a HW: field, offer to rewrite the CP210x's
  // USB Product string (iProduct) to match. This makes the adapter identifiable
  // in `lsusb -v` / System Information: "Silicon Labs  blyx-env-r4" instead of
  // the generic "Silicon Labs  CP2102 USB to UART Bridge Controller".
  #renderHwMatch(hwName) {
    const container = this.el.querySelector("[data-hw-match]");
    if (!container) return;
    container.innerHTML = "";
    if (!hwName) return;

    const port = this.session.portInfo || {};
    const portManufacturer = (port.manufacturer || "").trim();
    const isCp210x =
      (port.vendorId || "").toLowerCase() === "10c4" &&
      (port.productId || "").toLowerCase() === "ea60";

    // Heuristic: consider it "already set" if the manufacturer string contains
    // the HW name (case-insensitive). node-serialport surfaces iManufacturer
    // here on most platforms; a rewritten iProduct won't show — but if the
    // OS vendor-db lookup or a prior write matches, we skip the nag.
    const alreadySet = portManufacturer
      .toLowerCase()
      .includes(hwName.toLowerCase());

    if (alreadySet) {
      const ok = document.createElement("p");
      ok.className = "hint ok";
      ok.textContent = `✓ USB manufacturer/product already references "${hwName}".`;
      container.appendChild(ok);
      return;
    }

    if (!isCp210x) {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent =
        `USB manufacturer (${portManufacturer || "unset"}) doesn't reference the firmware HW "${hwName}". Adapter is not a CP210x, so the USB product descriptor cannot be rewritten from here.`;
      container.appendChild(note);
      return;
    }

    const warn = document.createElement("div");
    warn.className = "hint warn";
    const msg = document.createElement("div");
    msg.innerHTML =
      `<strong>USB product string isn't branded.</strong> The adapter reports manufacturer <code>${escapeHtml(portManufacturer || "(unset)")}</code>. ` +
      `Rewriting the CP210x's product descriptor (iProduct) to <code>${escapeHtml(hwName)}</code> makes the board identifiable in <code>lsusb -v</code> and system device lists.`;
    warn.appendChild(msg);

    const actions = document.createElement("div");
    actions.className = "cp210x-actions";
    const btn = document.createElement("button");
    btn.className = "primary cp210x-product";
    btn.textContent = `Write "${hwName}" as USB product`;
    btn.addEventListener("click", () => this.#writeCp210xProduct(hwName, port));
    actions.appendChild(btn);
    const status = document.createElement("span");
    status.className = "cp210x-status hint";
    status.dataset.cp210xProduct = "status";
    actions.appendChild(status);
    warn.appendChild(actions);
    container.appendChild(warn);
  }

  #writeCp210xProduct(hwName, port) {
    const btn = this.el.querySelector(".cp210x-product");
    const status = this.el.querySelector('[data-cp210x-product="status"]');
    if (!confirm(`Rewrite USB product descriptor on ${port.path} to "${hwName}"?\n\nThe port will be released during the operation. On most adapters the device re-enumerates under the same path.`)) return;
    btn.disabled = true;
    status.textContent = "releasing port…";
    this.session.logEvent("info", `CP210x: writing product string "${hwName}"`);
    this.session.send({
      type: "cp210x-set-product",
      vid: port.vendorId,
      pid: port.productId,
      currentSerial: port.serialNumber || "",
      newValue: hwName,
    });
  }

  // Compare the chip's EFUSE MAC (set by Discover) against the USB port's
  // serial number. On a CP210x mismatch, offer the rewrite button that
  // targets the chip MAC — not the firmware banner ID. EFUSE is authoritative;
  // banners are firmware-dependent and might say anything.
  #renderMacMatch(chipMac) {
    const container = this.el.querySelector("[data-mac-match]");
    if (!container) return;
    container.innerHTML = "";
    const port = this.session.portInfo || {};
    const chipMacNorm = normalizeMac(chipMac);
    const portSerial = (port.serialNumber || "").trim();
    const portSerialNorm = normalizeMac(portSerial);
    const isCp210x =
      (port.vendorId || "").toLowerCase() === "10c4" &&
      (port.productId || "").toLowerCase() === "ea60";

    if (!chipMacNorm) return; // no MAC yet → draw nothing

    if (portSerialNorm && chipMacNorm === portSerialNorm) {
      const ok = document.createElement("p");
      ok.className = "hint ok";
      ok.textContent = `✓ USB serial matches chip MAC (${chipMac}).`;
      container.appendChild(ok);
      return;
    }

    if (isCp210x) {
      const warn = document.createElement("div");
      warn.className = "hint warn";
      const msg = document.createElement("div");
      msg.innerHTML =
        `<strong>USB serial mismatch.</strong> Port reports <code>${escapeHtml(portSerial || "(unset)")}</code>, chip MAC (EFUSE) is <code>${escapeHtml(chipMac)}</code>. ` +
        `This adapter is a Silicon Labs CP210x — the USB serial can be rewritten to the chip MAC so the port is identifiable across reboots.`;
      warn.appendChild(msg);

      const actions = document.createElement("div");
      actions.className = "cp210x-actions";
      const btn = document.createElement("button");
      btn.className = "primary cp210x-write";
      btn.textContent = `Write ${chipMacNorm} to USB serial`;
      btn.addEventListener("click", () => this.#writeCp210xSerial(chipMacNorm, portSerial, port));
      actions.appendChild(btn);
      const status = document.createElement("span");
      status.className = "cp210x-status hint";
      status.dataset.cp210x = "status";
      actions.appendChild(status);
      warn.appendChild(actions);
      container.appendChild(warn);
    } else {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = `USB serial (${portSerial || "unset"}) does not match chip MAC (${chipMac}). Adapter is not a CP210x, so the USB descriptor cannot be rewritten from here.`;
      container.appendChild(note);
    }
  }

  #writeCp210xSerial(newSerial, currentSerial, port) {
    const btn = this.el.querySelector(".cp210x-write");
    const status = this.el.querySelector('[data-cp210x="status"]');
    if (!confirm(`Rewrite USB serial on ${port.path} from "${currentSerial || "(unset)"}" to "${newSerial}"?\n\nThe port will be released during the operation and the device will re-enumerate with a new path. You'll need to reselect the port from the sidebar.`)) return;
    btn.disabled = true;
    status.textContent = "releasing port…";
    this.session.logEvent("info", `CP210x: writing serial ${newSerial}`);
    this.session.send({
      type: "cp210x-set-serial",
      vid: port.vendorId,
      pid: port.productId,
      currentSerial: currentSerial,
      newValue: newSerial,
    });
  }
  onShow() {
    this.#renderTransport();
  }
  onMessage(msg) {
    if (msg.type === "open") {
      this.#renderTransport();
      return;
    }
    if (msg.type === "firmware-banner") {
      this.#renderFirmwareBanner(msg.fields);
      return;
    }
    if (msg.type === "cp210x-status") {
      const selector = msg.field === "product"
        ? '[data-cp210x-product="status"]'
        : '[data-cp210x="status"]';
      const status = this.el.querySelector(selector);
      if (status) {
        const label = msg.field === "product" ? "product string" : "serial";
        status.textContent = msg.state === "done"
          ? `✓ wrote ${label}: ${msg.wrote}`
          : msg.state === "error"
            ? `✗ ${msg.message}`
            : msg.state;
        status.className = `cp210x-status hint ${msg.state === "done" ? "ok" : msg.state === "error" ? "warn" : ""}`;
      }
      return;
    }
    if (msg.type !== "device-info") return;
    const info = msg.info || {};
    const set = (k, v) => { const el = this.el.querySelector(`[data-k="${k}"]`); if (el) el.textContent = v ?? "—"; };
    set("chip", info.chip);
    set("packageName", info.packageName);
    set("magic", info.magic);
    set("revision", info.revision);
    set("mac", info.mac);
    set("flashSize", info.flashSize);
    set("crystal", info.crystal);
    set("features", Array.isArray(info.features) ? info.features.join(", ") : info.features);
    if (info.transport?.baud) this.el.querySelector('[data-k="baud"]').textContent = info.transport.baud;
    const status = this.el.querySelector('[data-k="status"]');
    if (info.chip) status.textContent = info.status ?? "Detected via backend.";
    else status.textContent = info.status ?? "Not yet detected.";
    if (info.mac) this.#renderMacMatch(info.mac);
  }
}

class PartitionsTab extends BaseTab {
  get label() { return "Partitions"; }
  mount() {
    this.el.classList.add("partitions");
    this.el.appendChild(tpl("tpl-partitions-tab"));
    this.emptyEl = this.el.querySelector(".discover-empty");
    this.contentEl = this.el.querySelector(".partitions-content");
    this.discoverBtn = this.el.querySelector(".run-discover");
    this.statusEl = this.el.querySelector(".discover-status");
    this.discoverBtn.addEventListener("click", () => {
      this.statusEl.textContent = "Running Discover…";
      this.discoverBtn.disabled = true;
      this.session.discover();
    });
  }
  onMessage(msg) {
    if (msg.type === "detect-status") {
      this.statusEl.classList.remove("warn");
      if (msg.state === "running") {
        this.statusEl.textContent = "Syncing with ROM bootloader…";
        this.discoverBtn.disabled = true;
      } else if (msg.state === "scanning") {
        this.statusEl.textContent = "Reading flash…";
        this.discoverBtn.disabled = true;
      } else if (msg.state === "done") {
        this.statusEl.textContent = "";
        this.discoverBtn.disabled = false;
      } else if (msg.state === "error") {
        this.statusEl.textContent = `Discover failed: ${msg.message ?? "unknown"}`;
        this.statusEl.classList.add("warn");
        this.discoverBtn.disabled = false;
      }
      return;
    }
    if (msg.type === "partitions") {
      this.#revealContent(msg.cached);
      this.#renderPartitions(msg.partitions || [], msg.flashSize || 0, msg.flashSizeLabel);
    } else if (msg.type === "apps") {
      this.#revealContent(msg.cached);
      this.#renderSlots(msg.slots || []);
    }
  }
  #revealContent(cached) {
    this.emptyEl.hidden = true;
    this.contentEl.hidden = false;
    const badge = this.el.querySelector(".cached-badge");
    if (cached) badge.hidden = false;
    else badge.hidden = true; // fresh data clears the badge
  }
  #renderPartitions(parts, flashSize, flashSizeLabel) {
    let total = flashSize;
    let totalIsReported = Boolean(flashSize);
    if (!total && parts.length) {
      const maxEnd = Math.max(...parts.map((p) => (p.offset || 0) + (p.size || 0)));
      total = roundUpFlashSize(maxEnd);
    }
    const label = flashSizeLabel || (total ? formatBytes(total) : null);

    this.#renderRuler(total);

    const bar = this.el.querySelector(".partition-bar");
    bar.innerHTML = "";
    let covered = 0;
    for (const p of parts) {
      if (p.offset > covered) {
        const gap = document.createElement("div");
        gap.className = "partition-seg gap";
        gap.style.flexBasis = total ? `${((p.offset - covered) / total) * 100}%` : "0";
        gap.title = `unused: ${p.offset - covered} B`;
        bar.appendChild(gap);
      }
      const seg = document.createElement("div");
      seg.className = `partition-seg type-${(p.type ?? "other").toString().toLowerCase()}`;
      seg.style.flexBasis = total ? `${(p.size / total) * 100}%` : "0";
      seg.title = `${p.name} (${p.size} B @ 0x${p.offset.toString(16)})`;
      seg.textContent = p.name;
      bar.appendChild(seg);
      covered = p.offset + p.size;
    }
    if (total && covered < total) {
      const tail = document.createElement("div");
      tail.className = "partition-seg gap";
      tail.style.flexBasis = `${((total - covered) / total) * 100}%`;
      tail.title = `unused: ${total - covered} B`;
      bar.appendChild(tail);
    }

    const tbody = this.el.querySelector("tbody");
    tbody.innerHTML = "";
    if (!parts.length) {
      tbody.innerHTML = `<tr class="empty"><td colspan="6">Empty table.</td></tr>`;
    } else {
      for (const p of parts) {
        const tr = document.createElement("tr");
        tr.innerHTML =
          `<td>${escapeHtml(p.name)}</td>` +
          `<td>${escapeHtml(String(p.type))}</td>` +
          `<td>${escapeHtml(String(p.subtype ?? ""))}</td>` +
          `<td>0x${p.offset.toString(16)}</td>` +
          `<td>${p.size.toLocaleString()}</td>` +
          `<td>${p.encrypted ? "yes" : "no"}</td>`;
        tbody.appendChild(tr);
      }
    }
    const meta = this.el.querySelector(".meta");
    if (totalIsReported) {
      meta.textContent = `${parts.length} entries · flash ${label}`;
    } else if (total) {
      meta.textContent = `${parts.length} entries · flash ${label} (inferred)`;
    } else {
      meta.textContent = `${parts.length} entries`;
    }
  }
  #renderRuler(flashSize) {
    const ruler = this.el.querySelector(".flash-ruler");
    ruler.innerHTML = "";
    if (!flashSize) return;
    const steps = 5; // 0%, 25%, 50%, 75%, 100%
    for (let i = 0; i < steps; i++) {
      const pct = (i / (steps - 1)) * 100;
      const offset = Math.round((flashSize * i) / (steps - 1));
      const span = document.createElement("span");
      span.style.left = `${pct}%`;
      span.textContent = `0x${offset.toString(16).padStart(5, "0").toUpperCase()}`;
      ruler.appendChild(span);
    }
  }
  #renderSlots(slots) {
    const stack = this.el.querySelector(".ota-stack");
    stack.innerHTML = "";
    if (!slots.length) {
      stack.classList.add("empty");
      stack.textContent = "No app slots detected.";
      return;
    }
    stack.classList.remove("empty");
    for (const slot of slots) stack.appendChild(this.#renderSlotCard(slot));
  }
  #renderSlotCard(slot) {
    const card = tplRoot("tpl-ota-card");
    card.dataset.slot = slot.name;
    card.classList.toggle("active", !!slot.active);
    const used = slot.desc?.imageSize ?? slot.imageSize ?? null;
    const usedPct = used && slot.size ? Math.min(100, (used / slot.size) * 100) : 0;
    const version = slot.desc?.version ?? "—";
    const project = slot.desc?.projectName ?? "";
    const built = slot.desc ? `${slot.desc.date} ${slot.desc.time}` : "";
    const usageLabel = used
      ? `${formatBytes(used)} used · ${formatBytes(slot.size - used)} free`
      : `${formatBytes(slot.size)} capacity`;

    card.querySelector(".ota-name").textContent = `${slot.name} `;

    const stateTag = card.querySelector(".ota-state-tag");
    if (slot.active) {
      stateTag.className = "active-tag";
      stateTag.textContent = "running";
    } else if (slot.valid) {
      stateTag.className = "slot-tag";
      stateTag.textContent = "valid";
    } else {
      stateTag.className = "slot-tag empty-tag";
      stateTag.textContent = "empty";
    }

    card.querySelector(".ota-meta-main").textContent =
      `@ 0x${slot.offset.toString(16)} · ${formatBytes(slot.size)}` +
      `${project ? ` · ${project}` : ""} · v${String(version)}`;

    const builtEl = card.querySelector(".ota-meta-built");
    if (built) builtEl.textContent = `built ${built}`;
    else builtEl.remove();

    card.querySelector(".fill-inner").style.width = `${usedPct}%`;
    card.querySelector(".usage-line").textContent =
      `${usageLabel}${slot.otaSeq != null ? ` · ota seq ${slot.otaSeq}` : ""}`;

    return card;
  }
}

class FilesTab extends BaseTab {
  get label() { return "Files"; }
  mount() {
    this.el.classList.add("files");
    this.el.appendChild(tpl("tpl-files-tab"));
    this.files = [];
    this.filter = "";
    this.fsSel = this.el.querySelector(".fs-type");
    this.el.querySelector(".refresh").addEventListener("click", () => {
      this.session.send({ type: "fs-list", fs: this.fsSel.value });
    });
    this.el.querySelector(".filter").addEventListener("input", (e) => {
      this.filter = e.target.value.toLowerCase();
      this.#renderList();
    });
    this.el.querySelector(".upload").addEventListener("click", () => {
      this.session.logEvent("warn", "Upload: backend fs-write not implemented yet");
    });
    const dz = this.el.querySelector(".dropzone");
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("drag");
      const n = e.dataTransfer?.files.length ?? 0;
      this.session.logEvent("info", `Drop received (${n} files); backend wiring pending`);
    });
  }
  onMessage(msg) {
    if (msg.type !== "fs-list-result") return;
    this.files = msg.files || [];
    this.#renderList();
    if (msg.usage) this.#renderUsage(msg.usage);
  }
  #renderList() {
    const tbody = this.el.querySelector("tbody");
    tbody.innerHTML = "";
    const show = this.files.filter((f) => !this.filter || f.name.toLowerCase().includes(this.filter));
    if (!show.length) {
      tbody.innerHTML = `<tr class="empty"><td colspan="4">No files.</td></tr>`;
      return;
    }
    for (const f of show) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="mono">${escapeHtml(f.name)}</td>` +
        `<td>${(f.size ?? 0).toLocaleString()}</td>` +
        `<td>${escapeHtml(f.mtime ?? "—")}</td>` +
        `<td class="row-actions"><button class="dl">download</button><button class="del">delete</button></td>`;
      tr.querySelector(".dl").addEventListener("click", () =>
        this.session.send({ type: "fs-read", fs: this.fsSel.value, path: f.name }));
      tr.querySelector(".del").addEventListener("click", () =>
        this.session.send({ type: "fs-delete", fs: this.fsSel.value, path: f.name }));
      tbody.appendChild(tr);
    }
  }
  #renderUsage(u) {
    const fill = this.el.querySelector(".usage-fill");
    const label = this.el.querySelector(".usage-label");
    const pct = u.total ? (u.used / u.total) * 100 : 0;
    fill.style.width = `${pct.toFixed(1)}%`;
    label.textContent = `${(u.used ?? 0).toLocaleString()} / ${(u.total ?? 0).toLocaleString()} B`;
  }
}

class FlashDialog {
  constructor(session) {
    this.session = session;
    // The <dialog> root is cloned from #tpl-flash-dialog in mount(); we can't
    // build it here because the template needs to be in the DOM first.
    this.el = null;
  }
  mount() {
    this.el = tplRoot("tpl-flash-dialog");
    const off = this.el.querySelector(".offset");
    const custom = this.el.querySelector(".custom-offset");
    off.addEventListener("change", () => { custom.hidden = off.value !== "custom"; });

    this.el.querySelector(".flash-btn").addEventListener("click", () => {
      const file = this.el.querySelector(".bin").files[0];
      if (!file) { this.session.logEvent("warn", "Flash: pick a .bin first"); return; }
      const offset = off.value === "custom" ? custom.value : off.value;
      const erase = this.el.querySelector(".erase").checked;
      this.session.logEvent("info", `Flash request: ${file.name} → ${offset} (erase=${erase})`);
      this.session.send({ type: "flash-request", offset, erase, name: file.name, size: file.size });
      this.el.querySelector(".cancel").disabled = false;
    });
    this.el.querySelector(".cancel").addEventListener("click", () => {
      this.session.send({ type: "flash-cancel" });
    });
    this.el.querySelector(".md5-btn").addEventListener("click", () => {
      this.session.send({
        type: "md5-request",
        offset: this.el.querySelector(".md5-offset").value,
        length: this.el.querySelector(".md5-length").value,
      });
    });
    // Clicking the backdrop closes the dialog.
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.hide();
    });
  }
  show() {
    if (typeof this.el.showModal === "function") this.el.showModal();
    else this.el.setAttribute("open", "");
  }
  hide() {
    if (typeof this.el.close === "function") this.el.close();
    else this.el.removeAttribute("open");
  }
  onMessage(msg) {
    if (msg.type === "progress" && msg.op === "flash") {
      const pct = msg.total ? (msg.done / msg.total) * 100 : 0;
      this.el.querySelector(".progress-fill").style.width = `${pct.toFixed(1)}%`;
      this.el.querySelector(".progress-label").textContent =
        msg.total ? `${pct.toFixed(1)}% — ${msg.done}/${msg.total} B` : "working…";
      if (pct >= 100) this.el.querySelector(".cancel").disabled = true;
    } else if (msg.type === "md5-result") {
      this.el.querySelector(".md5-result").textContent = msg.md5 ?? "error";
    }
  }
  dispose() {
    try { this.hide(); } catch { /* ignore */ }
    this.el.remove();
  }
}

class NvsTab extends BaseTab {
  get label() { return "NVS"; }
  mount() {
    this.el.classList.add("nvs");
    this.el.appendChild(tpl("tpl-nvs-tab"));
    this.el.querySelector(".reload").addEventListener("click", () => {
      this.el.querySelector(".reload").disabled = true;
      this.el.querySelector(".reload-status").textContent = "reading flash…";
      this.session.send({ type: "nvs-read" });
    });
  }
  onMessage(msg) {
    if (msg.type === "detect-status") {
      if (msg.state === "done" || msg.state === "error") {
        this.el.querySelector(".reload").disabled = false;
      }
      return;
    }
    if (msg.type !== "nvs-result") return;
    const status = this.el.querySelector(".reload-status");
    if (msg.error) {
      status.textContent = `error: ${msg.error}`;
      return;
    }
    const namespaces = msg.namespaces || [];
    const nsList = this.el.querySelector(".ns-list");
    nsList.innerHTML = "";
    status.textContent = `${namespaces.length} namespace(s) · ${msg.activePages ?? 0}/${msg.totalPages ?? 0} active pages`;
    if (!namespaces.length) {
      nsList.innerHTML = `<li class="empty">No namespaces.</li>`;
      this.el.querySelector(".kv-list tbody").innerHTML =
        `<tr class="empty"><td colspan="3">No data.</td></tr>`;
      return;
    }
    for (const ns of namespaces) {
      const li = document.createElement("li");
      li.textContent = `${ns.name} (${ns.entries.length})`;
      li.addEventListener("click", () => {
        for (const sib of nsList.children) sib.classList.remove("active");
        li.classList.add("active");
        this.#showNs(ns);
      });
      nsList.appendChild(li);
    }
    // Auto-select first namespace on fresh result.
    nsList.firstChild?.click?.();
  }
  #showNs(ns) {
    const tbody = this.el.querySelector(".kv-list tbody");
    tbody.innerHTML = "";
    const entries = ns.entries || [];
    if (!entries.length) {
      tbody.innerHTML = `<tr class="empty"><td colspan="3">Empty namespace.</td></tr>`;
      return;
    }
    for (const e of entries) {
      const tr = document.createElement("tr");
      const valueText = e.size != null && e.type !== "str"
        ? `${e.value} · ${e.size} B`
        : String(e.value);
      tr.innerHTML =
        `<td class="mono">${escapeHtml(e.key)}</td>` +
        `<td>${escapeHtml(e.type)}</td>` +
        `<td class="mono">${escapeHtml(valueText)}</td>`;
      tbody.appendChild(tr);
    }
  }
}

class LogTab extends BaseTab {
  get label() { return "Log"; }
  get requiresDevice() { return false; }
  mount() {
    this.el.classList.add("log");
    this.el.appendChild(tpl("tpl-log-tab"));
    this.listEl = this.el.querySelector(".event-list");
    this.el.querySelector(".clear").addEventListener("click", () => { this.listEl.innerHTML = ""; });
  }
  append({ ts, level, message }) {
    const li = tplRoot("tpl-log-event");
    li.classList.add(`event-${level}`);
    li.querySelector(".ts").textContent = ts.toLocaleTimeString();
    li.querySelector(".lvl").textContent = level;
    li.querySelector(".msg").textContent = message;
    this.listEl.appendChild(li);
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatBytes(n) {
  if (n == null || !isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

// CP210x and some CH340 adapters ship with "0001" as the USB serial number
// from the factory. Using that as an identity key would collide across every
// un-programmed board of the same vendor, so we reject it (and the obvious
// near-equivalents) — logging and cache stay disabled until a real MAC or a
// unique SN is available.
function isGenericSerial(sn) {
  const s = String(sn).trim();
  if (!s) return true;
  if (s === "0001" || s === "0" || s === "1") return true;
  if (/^0+$/.test(s)) return true;
  return false;
}

// Per-device cache of discovered state (keyed by MAC or SN). Rehydrated on
// reconnection of the same device so the UI doesn't need another Discover
// run to show the partition table and OTA slots.
const CACHE_PREFIX = "iot:devcache:";

function readDeviceCache(id) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + id);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn("device cache read failed:", e);
    return null;
  }
}

function writeDeviceCache(id, patch) {
  try {
    const prev = readDeviceCache(id) ?? {};
    const next = { ...prev, ...patch, cachedAt: Date.now() };
    localStorage.setItem(CACHE_PREFIX + id, JSON.stringify(next));
  } catch (e) {
    console.warn("device cache write failed:", e);
  }
}

// Round up an address to the nearest standard ESP32 flash size so an unknown
// flash capacity renders with plausible trailing free space.
function roundUpFlashSize(bytes) {
  const MB = 1024 * 1024;
  const steps = [1 * MB, 2 * MB, 4 * MB, 8 * MB, 16 * MB, 32 * MB, 64 * MB];
  for (const s of steps) if (bytes <= s) return s;
  return Math.pow(2, Math.ceil(Math.log2(bytes)));
}

// Strip colons/whitespace and upper-case. Returns "" if the cleaned string
// is not a 12-char hex MAC. Used to compare firmware banner IDs against
// the USB port serial (CP210x boards often store the MAC there).
function normalizeMac(s) {
  if (!s) return "";
  const clean = String(s).replace(/[\s:.-]/g, "").toUpperCase();
  return /^[0-9A-F]{12}$/.test(clean) ? clean : "";
}

// ─── ESP-IDF log colorizer ───────────────────────────────────────────────────
// Intercepts raw serial bytes from the device, splits on newlines, and wraps
// lines that match the ESP-IDF log prefix (e.g. "I (123) tag: msg") in ANSI
// color codes before handing to xterm. Non-matching lines pass through as-is.
// Partial lines (no trailing newline yet) are buffered across calls.

const _espIdfColors = {
  E: "\x1b[31m",  // red
  W: "\x1b[33m",  // yellow
  I: "\x1b[32m",  // green
  D: "\x1b[36m",  // cyan
  V: "\x1b[90m",  // bright black (grey)
};
const _RESET = "\x1b[0m";
// Captures the full ESP-IDF prefix: "L (timestamp) TAG:" so we can color
// the prefix in the level color and render the message in default (white).
const _ESP_IDF_RE = /^([EWIDV] \(\d+\) [^:]+:)/;

function makeEspIdfColorizer() {
  let buf = "";
  return function colorizeEspIdf(chunk) {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    const combined = buf + text;
    const lines = combined.split("\n");
    buf = lines.pop();

    if (buf.length > 8192) { lines.push(buf); buf = ""; }

    const out = [];
    for (const line of lines) {
      const cr = line.endsWith("\r") ? "\r" : "";
      const bare = cr ? line.slice(0, -1) : line;
      const m = _ESP_IDF_RE.exec(bare);
      if (m) {
        const color = _espIdfColors[bare[0]];
        const prefix = m[1];                  // e.g. "I (1234) BRD:"
        const message = bare.slice(prefix.length); // " rest of message"
        out.push(color + prefix + _RESET + message + cr + "\n");
      } else {
        out.push(line + "\n");
      }
    }
    return out.join("");
  };
}

// ─── <button is="ui-button-flash-mode"> ──────────────────────────────────────
// Dispatches a bubbling `flashmode` CustomEvent when clicked. The session
// listens for that event and calls back via entering() / reset().

class UiButtonFlashMode extends HTMLButtonElement {
  connectedCallback() {
    this.title = "Assert IO0 LOW then pulse EN — chip enters download mode ready for flashing";
    this.addEventListener("click", () => {
      if (!this.disabled) this.dispatchEvent(new CustomEvent("flashmode", { bubbles: true, composed: true }));
    });
  }
  entering() { this.disabled = true; this.textContent = "Entering…"; }
  reset() { this.disabled = false; this.textContent = "Flash Mode"; }
}
customElements.define("ui-button-flash-mode", UiButtonFlashMode, { extends: "button" });

// ─── <button is="ui-button-reset"> ───────────────────────────────────────────

class UiButtonReset extends HTMLButtonElement {
  connectedCallback() {
    this.addEventListener("click", () => {
      if (!this.disabled) this.dispatchEvent(new CustomEvent("ui-reset", { bubbles: true, composed: true }));
    });
  }
}
customElements.define("ui-button-reset", UiButtonReset, { extends: "button" });

// ─── <button is="ui-button-flash-open"> ──────────────────────────────────────

class UiButtonFlashOpen extends HTMLButtonElement {
  connectedCallback() {
    this.addEventListener("click", () => {
      if (!this.disabled) this.dispatchEvent(new CustomEvent("ui-flash-open", { bubbles: true, composed: true }));
    });
  }
}
customElements.define("ui-button-flash-open", UiButtonFlashOpen, { extends: "button" });
