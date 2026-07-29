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
  // OTA updates (§5.2). The renderer only ever sees updater STATES — never the network or the FS.
  updates: {
    status: () => ipcRenderer.invoke("fa:update:status"),
    check: () => ipcRenderer.invoke("fa:update:check"),
    download: () => ipcRenderer.invoke("fa:update:download"),
    install: () => ipcRenderer.invoke("fa:update:install"),
    whatsNew: (version) => ipcRenderer.invoke("fa:update:whatsNew", version),
    showLog: () => ipcRenderer.invoke("fa:update:showLog"),
    onState: (cb) => {
      const h = (_e, snap) => cb(snap);
      ipcRenderer.on("fa:update:state", h);
      return () => ipcRenderer.removeListener("fa:update:state", h);
    },
  },
  version: () => ipcRenderer.invoke("fa:version"),
});

// ── UI chrome bridge (shell-level, bot-agnostic): the dark/light theme. getThemeSync is
// intentionally sendSync — the inline <head> script must know the theme BEFORE first paint (no FOUC).
contextBridge.exposeInMainWorld("ui", {
  getThemeSync: () => ipcRenderer.sendSync("ui:getTheme"),
  setTheme: (t) => ipcRenderer.invoke("ui:setTheme", t),
});

// ── Bot 2 «BTC-опционы» (Strategy One) — a PARALLEL bridge, fully isolated from `fa` above ──
// Live Deribit public data + paper execution (no keys, no orders). The `fa` block is untouched.
contextBridge.exposeInMainWorld("s1", {
  getState: () => ipcRenderer.invoke("s1:getState"),
  setSettings: (s) => ipcRenderer.invoke("s1:setSettings", s),
  previewStructure: (params) => ipcRenderer.invoke("s1:previewStructure", params), // hypothesis: debit/payoff/gate, no open
  openStructure: (params) => ipcRenderer.invoke("s1:openStructure", params),
  closeStructure: () => ipcRenderer.invoke("s1:closeStructure"),
  start: () => ipcRenderer.invoke("s1:start"),
  stop: () => ipcRenderer.invoke("s1:stop"),
  refreshNow: () => ipcRenderer.invoke("s1:refreshNow"),
  reset: () => ipcRenderer.invoke("s1:reset"),
  getChain: (req) => ipcRenderer.invoke("s1:getChain", req), // instrument picker for manual entry
  runSweep: () => ipcRenderer.invoke("s1:runSweep"), // Phase 3b: parameter sweep over the captured history
  getLedger: (req) => ipcRenderer.invoke("s1:getLedger", req),
  exportLedger: (req) => ipcRenderer.invoke("s1:exportLedger", req),
  // main -> renderer live pushes (reprice ticks: greeks, hedge decision, P&L)
  onPush: (cb) => {
    const h = (_e, ds) => cb(ds);
    ipcRenderer.on("s1:push", h);
    return () => ipcRenderer.removeListener("s1:push", h);
  },
});

// ── OTM-сканер (S2) — ПАРАЛЛЕЛЬНЫЙ мост, полностью изолирован от `fa` и `s1` выше ──
// Только чтение публичных данных Deribit и сигналы; исполнения нет вообще (S4 добавит handoff).
// Источник опроса живёт строго между start() и stop() — в простое ноль трафика.
contextBridge.exposeInMainWorld("scn", {
  getState: () => ipcRenderer.invoke("scn:getState"),
  start: () => ipcRenderer.invoke("scn:start"),
  stop: () => ipcRenderer.invoke("scn:stop"),
  refreshNow: () => ipcRenderer.invoke("scn:refreshNow"), // «⟳ Оценить сейчас»: внеочередной опрос
  setSettings: (s) => ipcRenderer.invoke("scn:setSettings", s), // невалидное отклоняется с причиной
  setPreset: (id) => ipcRenderer.invoke("scn:setPreset", id),
  eventFlag: (p) => ipcRenderer.invoke("scn:eventFlag", p), // { flagged, note, horizonH: 24|48 }
  exportSignals: (req) => ipcRenderer.invoke("scn:exportSignals", req), // журнал сигналов (csv|json)
  exportTelemetry: (req) => ipcRenderer.invoke("scn:exportTelemetry", req), // pass-rate (csv|json)
  // main -> renderer live pushes (тики оценки: чеклист, кандидаты, сигнал, здоровье)
  onPush: (cb) => {
    const h = (_e, ds) => cb(ds);
    ipcRenderer.on("scn:push", h);
    return () => ipcRenderer.removeListener("scn:push", h);
  },
});
