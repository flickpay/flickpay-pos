const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flickpayConfig", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (config) => ipcRenderer.invoke("save-config", config),

  // clear cache + storage + cookies (operator + customer)
  clearAppData: () => ipcRenderer.invoke("clear-app-data"),

  verifyPin: (pin) => ipcRenderer.invoke("verify-pin", pin),
  pinOkOpenSettings: () => ipcRenderer.send("pin-ok-open-settings"),
  closePin: () => ipcRenderer.send("close-pin-window"),

  closeSettings: () => ipcRenderer.send("close-settings-window"),

  // ✅ NEW: app version
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),

  // ✅ NEW: read app log (electron-log) for Settings > Logs tab
  readAppLog: () => ipcRenderer.invoke("read-app-log"),
});
