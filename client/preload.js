// 渲染进程桥：contextIsolation 开启，仅暴露显式接口
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  // 采集源（types: ['screen'] | ['window']，主进程串行枚举）
  listSources: (types) => ipcRenderer.invoke('list-sources', types),
  log: (msg) => ipcRenderer.send('renderer-log', String(msg)),
  onPickerShown: (cb) => ipcRenderer.on('picker-shown', () => cb()),
  // 共享状态回报
  shareStarted: (info) => ipcRenderer.send('share-started', info),
  shareBusy: () => ipcRenderer.send('share-busy'),
  shareStopped: (info) => ipcRenderer.send('share-stopped', info),
  onStopShare: (cb) => ipcRenderer.on('stop-share', () => cb()),
  // 配置
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (patch) => ipcRenderer.invoke('save-config', patch),
  onConfigChanged: (cb) => ipcRenderer.on('config-changed', (_e, cfg) => cb(cfg)),
  // 通知与窗口
  onViewerShown: (cb) => ipcRenderer.on('viewer-shown', () => cb()),
  openViewer: () => ipcRenderer.send('open-viewer'),
  // 冒烟模式日志（engine.html）
  smokeLog: (obj) => ipcRenderer.send('smoke-log', obj),
  smokeExit: (code, summary) => ipcRenderer.send('smoke-exit', { code, summary }),
});
