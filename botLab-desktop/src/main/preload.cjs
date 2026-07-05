// preload.cjs — the ONLY bridge between the sandboxed renderer and the Node main process.
// Exposes a minimal, explicit API. No Node, no fs, no keys reach the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fa", {
  getState: () => ipcRenderer.invoke("fa:getState"),
  select: (sel) => ipcRenderer.invoke("fa:select", sel),
  startPaper: (cfg) => ipcRenderer.invoke("fa:startPaper", cfg),
  closePaper: (id) => ipcRenderer.invoke("fa:closePaper", id),
  setCosts: (costs) => ipcRenderer.invoke("fa:setCosts", costs),
  setSettings: (s) => ipcRenderer.invoke("fa:setSettings", s),
  refreshNow: () => ipcRenderer.invoke("fa:refreshNow"),
  // transaction ledger (Журнал операций): windowed query, full-file export, delete-with-ledger
  getLedger: (req) => ipcRenderer.invoke("fa:getLedger", req),
  exportLedger: (req) => ipcRenderer.invoke("fa:exportLedger", req),
  deletePaper: (id) => ipcRenderer.invoke("fa:deletePaper", id),
  // main -> renderer live pushes (poll ticks, accrual updates, freshness)
  onPush: (cb) => {
    const h = (_e, ds) => cb(ds);
    ipcRenderer.on("fa:push", h);
    return () => ipcRenderer.removeListener("fa:push", h);
  },
});
