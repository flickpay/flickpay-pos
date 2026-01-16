const { app, BrowserWindow, BrowserView, screen, globalShortcut, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

// ✅ AUTO UPDATE (electron-updater)
const { autoUpdater } = require("electron-updater");
const log = require("electron-log");
let updateReadyToInstall = false;

// ✅ AUTO UPDATE LOGGING (persistent to disk)
try {
  log.transports.file.level = "info";
  autoUpdater.logger = log;
  autoUpdater.logger.transports.file.level = "info";
  log.info("[boot] FlickpayPOS starting…", { version: app.getVersion?.() });
} catch {}

// ✅ ADDED: helper to locate the electron-log file path (for Settings > Logs)
function getAppLogPath() {
  try {
    const p = log?.transports?.file?.getFile?.()?.path;
    if (p && typeof p === "string") return p;
  } catch {}
  // fallback (best effort)
  try {
    return path.join(app.getPath("userData"), "logs", "main.log");
  } catch {
    return "";
  }
}

app.setName("FlickpayPOS");

/**
 * ==========================================================
 * TLS / CERT FIX (dev / misconfigured cert situations)
 * ==========================================================
 */
app.commandLine.appendSwitch("ignore-certificate-errors");
app.commandLine.appendSwitch("allow-insecure-localhost");

app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
  try {
    const u = new URL(url);
    const host = (u.hostname || "").toLowerCase();

    const allowed = host === "devtests.flickpay.co.uk" || host.endsWith(".flickpay.co.uk");

    if (allowed) {
      event.preventDefault();
      return callback(true);
    }
  } catch {
    // ignore
  }
  callback(false);
});

// HARDCODED COMPANY PIN (4 digits)
const SETTINGS_PIN = "2809";

let mainWindows = [];
let settingsWindow = null;
let pinWindow = null;
let overlayWindow = null;
let overlayMode = null;
let isQuitting = false;

// ✅ Used only for rebuilds on DISPLAY CHANGE (not save)
let isRebuilding = false;

// Explicit window refs
let operatorWin = null;
let customerWin = null;

// Session partitions (helps avoid mixed kiosk/operator state)
const PARTITION_OPERATOR = "persist:flickpay_operator";
const PARTITION_KIOSK = "persist:flickpay_kiosk";
// kept for future (unused now)
const PARTITION_CUSTOMER = "persist:flickpay_customer";

// ============================================================
// STARTUP LOADER (NO EXTRA WINDOWS) ✅
// ============================================================

const LOADER_DURATION_MS = 5000;   // total time the loader stays visible
const LOADER_FADE_MS = 150;        // fade duration
const LOADER_FADE_START_MS = Math.max(0, LOADER_DURATION_MS - LOADER_FADE_MS);

// Track per-window timers so rebuild/close can clear them safely
const startupNavTimers = new WeakMap();

function getLoaderHtmlPath() {
  // loader.html in the same folder as main.js
  return path.join(__dirname, "assets/loader.html");
}

function clearStartupTimers(win) {
  const t = startupNavTimers.get(win);
  if (!t) return;
  try { clearTimeout(t.fadeTimer); } catch {}
  try { clearTimeout(t.navTimer); } catch {}
  startupNavTimers.delete(win);
}

/**
 * Loads loader.html into the given window first, then after 4 seconds
 * fades out loader content and navigates to targetUrl.
 *
 * ✅ No extra BrowserWindow used.
 * ✅ Uses same main operator/customer window.
 */
function loadLoaderThenNavigate(win, targetUrl) {
  if (!win || win.isDestroyed()) return;

  // If loader.html doesn't exist, just go straight to target
  const loaderPath = getLoaderHtmlPath();
  if (!fs.existsSync(loaderPath)) {
    try { win.loadURL(targetUrl); } catch {}
    return;
  }

  clearStartupTimers(win);

  // Load loader.html first
  try {
    win.loadFile(loaderPath);
  } catch {
    // Fallback: direct load
    try { win.loadURL(targetUrl); } catch {}
    return;
  }

  // Once loader is finished loading, schedule fade + navigation
  const wc = win.webContents;

  const schedule = () => {
    if (!win || win.isDestroyed() || wc.isDestroyed()) return;

    // Fade the loader by fading the document root (works even with "random" HTML)
    const fadeTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || wc.isDestroyed()) return;

      const fadeJs = `
        (function(){
          try {
            const el = document.documentElement;
            el.style.transition = 'opacity ${LOADER_FADE_MS}ms ease';
            el.style.opacity = '0';
            // keep background stable
            (document.body || el).style.background = (document.body && getComputedStyle(document.body).background) || '#000';
          } catch(e) {}
        })();
      `;
      try { wc.executeJavaScript(fadeJs, true); } catch {}
    }, LOADER_FADE_START_MS);

    // Navigate to the real URL at the end of the loader duration
    const navTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;

      // IMPORTANT: clear timers before navigating
      clearStartupTimers(win);

      try {
        win.loadURL(targetUrl);
      } catch {}
    }, LOADER_DURATION_MS);

    startupNavTimers.set(win, { fadeTimer, navTimer });
  };

  // If it already finished, schedule immediately; otherwise wait
  try {
    if (wc.isLoading()) {
      wc.once("did-finish-load", schedule);
    } else {
      schedule();
    }
  } catch {
    // Fallback: schedule anyway
    schedule();
  }
}

// ============================================================
// MODAL-IN-SAME-WINDOW (NO NEW WINDOWS) ✅
// ============================================================

let modalView = null;
let modalMode = null; // "pin" | "settings" | "support"
let modalBackdropInjected = false;

// ✅ ESC + focus fixes
let escShortcutArmed = false;

function armEscShortcut() {
  if (escShortcutArmed) return;
  try {
    escShortcutArmed = globalShortcut.register("Escape", () => {
      if (modalView) closeModal();
    });
  } catch {
    escShortcutArmed = false;
  }
}

function disarmEscShortcut() {
  if (!escShortcutArmed) return;
  try {
    globalShortcut.unregister("Escape");
  } catch {}
  escShortcutArmed = false;
}

async function focusModalForMode(mode) {
  if (!modalView || modalView.webContents.isDestroyed()) return;

  try { modalView.webContents.focus(); } catch {}

  const js =
    mode === "pin"
      ? `
        (function(){
          const el = document.getElementById('hidden')
                 || document.querySelector('input, textarea, [tabindex]');
          if (el && el.focus) { el.focus(); return; }
          try { document.body && document.body.focus && document.body.focus(); } catch(e){}
        })();
      `
      : `
        (function(){
          const el = document.querySelector('input, select, textarea, button, [tabindex]');
          if (el && el.focus) { el.focus(); return; }
          try { document.body && document.body.focus && document.body.focus(); } catch(e){}
        })();
      `;

  try {
    await modalView.webContents.executeJavaScript(js, true);
  } catch {}
}

function isWinOpen(win) {
  return !!(win && !win.isDestroyed());
}

/**
 * ✅ MODIFIED (per request #1):
 * Modal bounds are now 80% width/height of the operator window and centered.
 */
function getModalBounds() {
  if (!isWinOpen(operatorWin)) return { x: 0, y: 0, width: 800, height: 600 };

  const b = operatorWin.getBounds();

  const MODAL_W = Math.round(b.width * 0.85);
  const MODAL_H = Math.round(b.height * 0.85);

  const x = Math.round((b.width - MODAL_W) / 2);
  const y = Math.round((b.height - MODAL_H) / 2);

  return { x, y, width: MODAL_W, height: MODAL_H };
}

async function injectModalBackdrop() {
  if (!isWinOpen(operatorWin)) return;

  const js = `
    (function() {
      if (document.getElementById('__flick_modal_backdrop')) return;

      const s = document.createElement('style');
      s.id = '__flick_modal_style';
      s.textContent = \`
        #__flick_modal_backdrop{
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.40);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          z-index: 2147483646;
          pointer-events: auto;
        }
      \`;
      document.documentElement.appendChild(s);

      const d = document.createElement('div');
      d.id = '__flick_modal_backdrop';
      d.addEventListener('click', () => {
        try { window.flickpayConfig?.closeSettings?.(); } catch(e){}
        try { window.flickpayConfig?.closePin?.(); } catch(e){}
        try { window.flickpayConfig?.closeSupport?.(); } catch(e){}
      });
      document.body.appendChild(d);

      // ✅ ESC closes modal (best-effort; globalShortcut guarantees it)
      window.__flick_modal_keydown = (e) => {
        if (e.key === 'Escape') {
          try { window.flickpayConfig?.closeSettings?.(); } catch(e){}
          try { window.flickpayConfig?.closePin?.(); } catch(e){}
          try { window.flickpayConfig?.closeSupport?.(); } catch(e){}
        }
      };
      window.addEventListener('keydown', window.__flick_modal_keydown, true);
    })();
  `;

  try {
    await operatorWin.webContents.executeJavaScript(js, true);
    modalBackdropInjected = true;
  } catch {
    // ignore
  }
}

async function removeModalBackdrop() {
  if (!isWinOpen(operatorWin)) return;

  const js = `
    (function() {
      try {
        if (window.__flick_modal_keydown) {
          window.removeEventListener('keydown', window.__flick_modal_keydown, true);
          window.__flick_modal_keydown = null;
        }
      } catch(e) {}

      try { document.getElementById('__flick_modal_backdrop')?.remove(); } catch(e){}
      try { document.getElementById('__flick_modal_style')?.remove(); } catch(e){}
    })();
  `;

  try {
    await operatorWin.webContents.executeJavaScript(js, true);
  } catch {
    // ignore
  } finally {
    modalBackdropInjected = false;
  }
}

/**
 * ✅ ADDED (per request #2):
 * Allow modal content to navigate to pos://closeModal (X button) to close the modal.
 */
function attachModalUrlHandlers(view) {
  if (!view || !view.webContents || view.webContents.isDestroyed()) return;

  const wc = view.webContents;

  wc.on("will-navigate", (event, url) => {
    const u = String(url || "").toLowerCase();
    if (u.startsWith("pos://closemodal")) {
      event.preventDefault();
      closeModal();
      return;
    }
  });

  wc.setWindowOpenHandler(({ url }) => {
    const u = String(url || "").toLowerCase();
    if (u.startsWith("pos://closemodal")) {
      closeModal();
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

function ensureModalView() {
  if (!isWinOpen(operatorWin)) return null;

  if (modalView && !modalView.webContents.isDestroyed()) return modalView;

  modalView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  // ✅ ADDED: hook pos://closeModal inside modal BrowserView
  attachModalUrlHandlers(modalView);

  return modalView;
}

async function openModal(mode) {
  if (!isWinOpen(operatorWin)) return;

  modalMode = mode;

  // ✅ ESC works even without focus
  armEscShortcut();

  // backdrop first (blur outside area)
  await injectModalBackdrop();

  const view = ensureModalView();
  if (!view) return;

  try {
    operatorWin.setBrowserView(view);

    const vb = getModalBounds();
    operatorWin.setTopBrowserView?.(view);
    view.setBounds(vb);
    view.setAutoResize({ width: false, height: false });

    if (mode === "settings") {
      view.webContents.loadFile(path.join(__dirname, "config.html"));
    } else if (mode === "support") {
      view.webContents.loadURL("https://flickpay.co.uk/get-support");
    } else {
      view.webContents.loadFile(path.join(__dirname, "pin.html"));
    }

    // ✅ Ensure typing/ESC works immediately (no click required)
    focusModalForMode(mode);
    view.webContents.once("did-finish-load", () => focusModalForMode(mode));

    enforceZOrderRules();
  } catch {
    // ignore
  }
}

async function closeModal() {
  if (!isWinOpen(operatorWin)) return;

  // ✅ Stop hijacking ESC after modal closes
  disarmEscShortcut();

  try {
    if (modalView && !modalView.webContents.isDestroyed()) {
      operatorWin.setBrowserView(null);
      modalView.webContents.stop();
      modalView.destroy();
    }
  } catch {
    // ignore
  } finally {
    modalView = null;
    modalMode = null;
    await removeModalBackdrop();
    enforceZOrderRules();
  }
}

function updateModalBoundsOnResize() {
  if (!isWinOpen(operatorWin)) return;
  if (!modalView || modalView.webContents.isDestroyed()) return;

  try {
    const vb = getModalBounds();
    modalView.setBounds(vb);
  } catch {}
}

// ✅ If the operator page reloads while modal is open, re-inject blur
async function reapplyBackdropIfNeeded() {
  if (!isWinOpen(operatorWin)) return;
  if (!modalView || (modalView.webContents && modalView.webContents.isDestroyed())) return;

  // After a reload/navigation, the injected DOM is gone — force reinject
  modalBackdropInjected = false;
  await injectModalBackdrop();
}

// ---------- TOPMOST / WINDOW LAYERING ----------
function setPosWindowsAlwaysOnTop(enabled) {
  for (const w of mainWindows) {
    if (w && !w.isDestroyed()) {
      try {
        if (enabled) {
          // ✅ MODIFIED (per request #3): reinforce always-on-top level
          w.setAlwaysOnTop(true, "screen-saver", 1);
        } else {
          w.setAlwaysOnTop(false);
        }
      } catch {
        // ignore
      }
    }
  }
}

function enforceZOrderRules() {
  setPosWindowsAlwaysOnTop(true);
}
// ---------------------------------------------

// ---------- CONFIG ----------
function getConfigPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function getDefaultPageUrl() {
  const p = path.join(__dirname, "assets", "default.html").replace(/\\/g, "/");
  return `file://${p}`;
}

/**
 * URL rules:
 * - Operator POS:
 *     https://<account>.flickpay.co.uk/pos/ui/<POS_ID>
 * - Self-service kiosk:
 *     https://<account>.flickpay.co.uk/pos-self/<POS_ID>/products?access_token=<TOKEN>
 * - Customer display:
 *     https://<account>.flickpay.co.uk/pos_customer_display/<POS_ID>/customer-display
 */
function buildUrlsFromParts(account, posId, screen1Mode, accessToken) {
  const a = (account || "").trim();
  const p = (posId || "").trim();
  const mode = (screen1Mode || "pos").trim();
  const token = (accessToken || "").trim();

  if (!a || !p) return { screen1Url: "", screen2Url: "" };

  const base = `https://${a}.flickpay.co.uk`;

  const screen1Url =
    mode === "self"
      ? (() => {
          const baseKiosk = `${base}/pos-self/${encodeURIComponent(p)}/products`;
          return token ? `${baseKiosk}?access_token=${encodeURIComponent(token)}` : baseKiosk;
        })()
      : `${base}/pos/ui/${encodeURIComponent(p)}`;

  const screen2Url = `${base}/pos_customer_display/${encodeURIComponent(p)}/customer-display`;

  return { screen1Url, screen2Url };
}

function ensureConfig() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    const defaultConfig = {
      account: "",
      posId: "",
      accessToken: "",
      screen1Mode: "pos",
      screen1Url: "",
      screen2Url: ""
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
  }
  return configPath;
}

function loadUiConfig() {
  ensureConfig();
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf-8");
    const cfg = JSON.parse(raw) || {};
    return {
      account: (cfg.account || "").trim(),
      posId: (cfg.posId || "").trim(),
      accessToken: (cfg.accessToken || "").trim(),
      screen1Mode: cfg.screen1Mode === "self" ? "self" : "pos",
      hasPin: true
    };
  } catch {
    return {
      account: "",
      posId: "",
      accessToken: "",
      screen1Mode: "pos",
      hasPin: true
    };
  }
}

function loadRuntimeConfig() {
  const defaultPage = getDefaultPageUrl();

  try {
    const raw = fs.readFileSync(ensureConfig(), "utf-8");
    const cfg = JSON.parse(raw) || {};

    const account = (cfg.account || "").trim();
    const posId = (cfg.posId || "").trim();
    const accessToken = (cfg.accessToken || "").trim();
    const screen1Mode = cfg.screen1Mode === "self" ? "self" : "pos";

    const built = buildUrlsFromParts(account, posId, screen1Mode, accessToken);

    const s1 = (built.screen1Url || cfg.screen1Url || "").trim();
    const s2 = (built.screen2Url || cfg.screen2Url || "").trim();

    return {
      screen1Url: s1 ? s1 : defaultPage,
      screen2Url: s2 ? s2 : defaultPage,
      screen1Mode
    };
  } catch {
    return { screen1Url: defaultPage, screen2Url: defaultPage, screen1Mode: "pos" };
  }
}

function saveConfig(newConfig) {
  const configPath = getConfigPath();

  const account = (newConfig?.account ? String(newConfig.account) : "").trim();
  const posId = (newConfig?.posId ? String(newConfig.posId) : "").trim();
  const accessToken = (newConfig?.accessToken ? String(newConfig.accessToken) : "").trim();

  const screen1ModeRaw = (newConfig?.screen1Mode ? String(newConfig.screen1Mode) : "pos").trim();
  const screen1Mode = screen1ModeRaw === "self" ? "self" : "pos";

  const built = buildUrlsFromParts(account, posId, screen1Mode, accessToken);

  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(ensureConfig(), "utf-8")) || {};
  } catch {}

  const toWrite = {
    ...existing,
    account,
    posId,
    accessToken,
    screen1Mode,
    screen1Url: (built.screen1Url || "").trim(),
    screen2Url: (built.screen2Url || "").trim()
  };

  delete toWrite.displayKey;
  delete toWrite.pinHash;
  delete toWrite.pin;

  fs.writeFileSync(configPath, JSON.stringify(toWrite, null, 2), "utf-8");
  return toWrite;
}

function verifyPin(pinAttempt) {
  const attempt = String(pinAttempt || "").trim();
  return /^\d{4}$/.test(attempt) && attempt === SETTINGS_PIN;
}

// ---------- DISPLAY SELECTION ----------
function getDisplayPair() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  if (!displays || displays.length === 0) {
    return { op: primary, customer: null };
  }

  const customer = displays.find((d) => d.id !== primary.id) || null;
  return { op: primary, customer };
}

// ✅ apply URLs without destroying windows
function applyUrlsToWindows(screen1Url, screen2Url) {
  const defaultPage = getDefaultPageUrl();
  const url1 = (screen1Url || "").trim() || defaultPage;
  const url2 = (screen2Url || "").trim() || defaultPage;

  if (operatorWin && !operatorWin.isDestroyed()) {
    try {
      const cur = operatorWin.webContents.getURL();
      if (cur !== url1) operatorWin.loadURL(url1);
      else operatorWin.webContents.reloadIgnoringCache();
    } catch {}
  }

  if (customerWin && !customerWin.isDestroyed()) {
    try {
      const cur = customerWin.webContents.getURL();
      if (cur !== url2) customerWin.loadURL(url2);
      else customerWin.webContents.reloadIgnoringCache();
    } catch {}
  }
}

// ---------- POS URL HANDLERS ----------
function attachPosUrlHandlers(win) {
  if (!win || win.isDestroyed()) return;

  const wc = win.webContents;

  wc.on("will-navigate", (event, url) => {
    if (!url) return;

    const u = String(url).toLowerCase();

    if (u.startsWith("pos://exit")) {
      event.preventDefault();
      closeAll();
      return;
    }

    if (u.startsWith("pos://settings")) {
      event.preventDefault();
      openModal("pin");
      return;
    }

    // ✅ NEW: Support modal
    if (u.startsWith("pos://getsupport")) {
      event.preventDefault();
      openModal("support");
      return;
    }

    if (u.startsWith("http://") || u.startsWith("https://")) {
      try {
        const host = new URL(url).hostname.toLowerCase();
        const isFlickpay = host === "flickpay.co.uk" || host.endsWith(".flickpay.co.uk");
        if (!isFlickpay) {
          event.preventDefault();
          shell.openExternal(url);
        }
      } catch {}
    }
  });

  wc.setWindowOpenHandler(({ url }) => {
    const u = String(url || "").toLowerCase();

    if (u.startsWith("pos://exit")) {
      closeAll();
      return { action: "deny" };
    }

    if (u.startsWith("pos://settings")) {
      openModal("pin");
      return { action: "deny" };
    }

    // ✅ NEW: Support modal
    if (u.startsWith("pos://getsupport")) {
      openModal("support");
      return { action: "deny" };
    }

    if (u.startsWith("http://") || u.startsWith("https://")) {
      try {
        const host = new URL(url).hostname.toLowerCase();
        const isFlickpay = host === "flickpay.co.uk" || host.endsWith(".flickpay.co.uk");
        if (!isFlickpay) {
          shell.openExternal(url);
          return { action: "deny" };
        }
      } catch {}
    }

    return { action: "allow" };
  });
}

// ---------- CLEAR APP DATA ----------
async function clearSessionDataForWindow(win) {
  if (!win || win.isDestroyed()) return;
  const ses = win.webContents.session;

  await ses.clearCache().catch(() => {});
  await ses
    .clearStorageData({
      storages: [
        "appcache",
        "cache_storage",
        "cookies",
        "filesystem",
        "indexeddb",
        "localstorage",
        "serviceworkers",
        "shadercache",
        "websql",
      ],
      quotas: ["temporary", "persistent", "syncable"]
    })
    .catch(() => {});
}

async function clearAppData() {
  await clearSessionDataForWindow(operatorWin);
  await clearSessionDataForWindow(customerWin);
}

// ---------- WINDOWS ----------
function destroyAllWindowsOnly() {
  try {
    if (isWinOpen(operatorWin)) {
      clearStartupTimers(operatorWin);
      operatorWin.setBrowserView(null);
    }
  } catch {}
  try {
    if (isWinOpen(customerWin)) {
      clearStartupTimers(customerWin);
    }
  } catch {}

  try {
    if (modalView && !modalView.webContents.isDestroyed()) modalView.destroy();
  } catch {}
  modalView = null;
  modalMode = null;
  modalBackdropInjected = false;

  // ✅ ensure ESC isn't left registered
  disarmEscShortcut();

  for (const w of mainWindows) {
    if (w && !w.isDestroyed()) w.destroy();
  }
  mainWindows = [];
  operatorWin = null;
  customerWin = null;
}

function closeAll() {
  if (isQuitting) return;
  isQuitting = true;

  try { closeModal(); } catch {}

  if (pinWindow && !pinWindow.isDestroyed()) pinWindow.destroy();
  pinWindow = null;

  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
  settingsWindow = null;

  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  overlayWindow = null;
  overlayMode = null;

  destroyAllWindowsOnly();

  // ✅ AUTO UPDATE: install downloaded update on next quit (silent)
  try {
    if (updateReadyToInstall) {
      try { log.info("[updater] quitAndInstall now"); } catch {}
      autoUpdater.quitAndInstall(false, true);
      return;
    }
  } catch {}

  app.quit();
}

function createMainWindows() {
  const { screen1Url, screen2Url, screen1Mode } = loadRuntimeConfig();
  const pair = getDisplayPair();

  mainWindows = [];

  const operatorPartition = screen1Mode === "self" ? PARTITION_KIOSK : PARTITION_OPERATOR;

  // ---- Operator window ----
  operatorWin = new BrowserWindow({
    x: pair.op.bounds.x,
    y: pair.op.bounds.y,
    width: pair.op.bounds.width,
    height: pair.op.bounds.height,
    frame: false,
    autoHideMenuBar: true,
    fullscreen: false,
    show: false,
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      partition: operatorPartition
    }
  });

  // ✅ MODIFIED (per request #3): reinforce always-on-top level
  operatorWin.setAlwaysOnTop(true, "screen-saver", 1);

  operatorWin.once("ready-to-show", () => {
    operatorWin.setBounds(pair.op.bounds, false);

    // ✅ MODIFIED (per request #3): strongest mode on Windows to stay above taskbar
    if (process.platform === "win32") {
      operatorWin.setKiosk(true);
    } else {
      operatorWin.setFullScreen(true);
    }

    operatorWin.show();
    operatorWin.focus();
  });

  operatorWin.on("resize", () => updateModalBoundsOnResize());
  operatorWin.on("moved", () => updateModalBoundsOnResize());

  // ✅ If operator reloads (e.g. after Save), re-inject blur if modal is open
  operatorWin.webContents.on("did-finish-load", () => {
    reapplyBackdropIfNeeded();
  });

  // ✅ Navigation blows away injected DOM; mark it dirty so did-finish-load reinjects
  operatorWin.webContents.on("did-start-navigation", () => {
    if (modalView) modalBackdropInjected = false;
  });

  operatorWin.on("close", (e) => {
    if (!isQuitting && !isRebuilding) {
      e.preventDefault();
      closeAll();
    }
  });

  attachPosUrlHandlers(operatorWin);

  // ✅ CHANGED: start with loader.html then navigate
  loadLoaderThenNavigate(operatorWin, screen1Url || getDefaultPageUrl());
  mainWindows.push(operatorWin);

  // ---- Customer window ----
  if (pair.customer) {
    customerWin = new BrowserWindow({
      x: pair.customer.bounds.x,
      y: pair.customer.bounds.y,
      width: pair.customer.bounds.width,
      height: pair.customer.bounds.height,
      frame: false,
      autoHideMenuBar: true,
      fullscreen: false,
      show: false,
      backgroundColor: "#000000",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        partition: operatorPartition
      }
    });

    customerWin.setSkipTaskbar(true);
    customerWin.setAlwaysOnTop(true, "screen-saver", 1);

    let customerShown = false;
    const forceShowCustomer = () => {
      if (customerShown) return;
      customerShown = true;
      if (!customerWin || customerWin.isDestroyed()) return;

      try {
        customerWin.setBounds(pair.customer.bounds, false);
        customerWin.setFullScreen(true);
        customerWin.show();
      } catch {}
    };

    customerWin.once("ready-to-show", forceShowCustomer);
    setTimeout(forceShowCustomer, 1500);

    customerWin.on("close", (e) => {
      if (!isQuitting && !isRebuilding) {
        e.preventDefault();
        closeAll();
      }
    });

    attachPosUrlHandlers(customerWin);

    // ✅ CHANGED: start with loader.html then navigate
    loadLoaderThenNavigate(customerWin, screen2Url || getDefaultPageUrl());
    mainWindows.push(customerWin);
  }

  enforceZOrderRules();
}

// ✅ keep rebuild ONLY for actual display changes
function rebuildForCurrentDisplays() {
  if (isQuitting) return;

  isRebuilding = true;
  try {
    try { closeModal(); } catch {}
    destroyAllWindowsOnly();
    createMainWindows();
    enforceZOrderRules();
  } finally {
    isRebuilding = false;
  }
}

// ---------- IPC ----------
ipcMain.handle("get-config", () => loadUiConfig());

ipcMain.handle("save-config", (event, newConfig) => {
  try {
    const saved = saveConfig(newConfig);

    const built = buildUrlsFromParts(
      saved.account,
      saved.posId,
      saved.screen1Mode,
      saved.accessToken
    );

    applyUrlsToWindows(built.screen1Url, built.screen2Url);

    enforceZOrderRules();
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("verify-pin", (event, pin) => ({ ok: verifyPin(pin) }));

ipcMain.handle("clear-app-data", async () => {
  try {
    await clearAppData();
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("get-app-version", () => app.getVersion());

// ✅ ADDED: allow Settings > Logs tab to read the persistent log file
ipcMain.handle("read-app-log", () => {
  try {
    const p = getAppLogPath();
    if (!p) return { ok: false, text: "" };
    if (!fs.existsSync(p)) return { ok: false, text: "" };
    const text = fs.readFileSync(p, "utf-8");
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text: `Error reading log: ${e?.message || String(e)}` };
  }
});

// pin.html (in BrowserView) calls this -> switch modal to settings
ipcMain.on("pin-ok-open-settings", () => {
  openModal("settings");
});

// config.html calls this -> close modal
ipcMain.on("close-settings-window", () => {
  closeModal();
});

// pin.html calls this -> close modal
ipcMain.on("close-pin-window", () => {
  closeModal();
});

// ---------- APP ----------
app.whenReady().then(() => {
  // ✅ AUTO UPDATE: download in background; install on next quit
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on("checking-for-update", () => {
      try { log.info("[updater] checking-for-update"); } catch {}
    });

    autoUpdater.on("update-available", (info) => {
      try { log.info("[updater] update-available", info); } catch {}
    });

    autoUpdater.on("update-not-available", (info) => {
      try { log.info("[updater] update-not-available", info); } catch {}
    });

    autoUpdater.on("download-progress", (p) => {
      try { log.info("[updater] download-progress", p); } catch {}
    });

    autoUpdater.on("update-downloaded", (info) => {
      updateReadyToInstall = true;
      try { log.info("[updater] update-downloaded", info); } catch {}
    });

    autoUpdater.on("error", (err) => {
      try { log.error("[updater] error", err); } catch {}
      try { console.log("Auto update error:", err); } catch {}
    });

    // small delay so app boots first
    setTimeout(() => {
      try {
        log.info("[updater] calling checkForUpdates()");
        autoUpdater.checkForUpdates();
      } catch (e) {
        try { log.error("[updater] checkForUpdates threw", e); } catch {}
      }
    }, 5000);
  } catch {}

  rebuildForCurrentDisplays();

  globalShortcut.register("Control+Alt+S", () => openModal("pin"));
  globalShortcut.register("Control+Alt+R", () => {
    for (const w of mainWindows) {
      if (w && !w.isDestroyed()) w.reload();
    }
  });
  globalShortcut.register("Control+Alt+Q", () => closeAll());
  globalShortcut.register("Control+Alt+O", () => shell.showItemInFolder(ensureConfig()));

  let rebuildTimer = null;
  function scheduleRebuild() {
    if (isQuitting) return;
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => rebuildForCurrentDisplays(), 600);
  }

  screen.on("display-added", scheduleRebuild);
  screen.on("display-removed", scheduleRebuild);
  screen.on("display-metrics-changed", scheduleRebuild);
});

app.on("window-all-closed", () => closeAll());
app.on("will-quit", () => globalShortcut.unregisterAll());
