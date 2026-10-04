// 渲染进程桥：contextIsolation 开启，仅暴露显式接口
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  // 采集源（types: ['screen'] | ['window']，主进程串行枚举）
  prepareCapture: (sourceId) => ipcRenderer.invoke('prepare-capture', sourceId),
  getAppAudioSupport: () => ipcRenderer.invoke('get-app-audio-support'),
  startAppAudio: (sourceId) => ipcRenderer.invoke('start-app-audio', sourceId),
  stopAppAudio: (id) => ipcRenderer.invoke('stop-app-audio', id),
  onAppAudioData: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('app-audio-data', listener);
    return () => ipcRenderer.removeListener('app-audio-data', listener);
  },
  onAppAudioError: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('app-audio-error', listener);
    return () => ipcRenderer.removeListener('app-audio-error', listener);
  },
  listSources: (types) => ipcRenderer.invoke('list-sources', types),
  log: (event,data) => ipcRenderer.send('renderer-log', data===undefined?String(event):{event,data}),
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
  openPicker: () => ipcRenderer.send('open-picker'),
  openSettings: () => ipcRenderer.send('open-settings'),
  openLogs: () => ipcRenderer.send('open-logs'),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  openLogFolder: () => ipcRenderer.send('open-log-folder'),
  updateHostChat: (state) => ipcRenderer.send('host-chat-state', state),
  getHostChat: () => ipcRenderer.invoke('get-host-chat'),
  showChatOverlay: () => ipcRenderer.send('show-chat-overlay'),
  editChatOverlay: () => ipcRenderer.send('edit-chat-overlay'),
  lockChatOverlay: () => ipcRenderer.send('lock-chat-overlay'),
  getChatOverlayMode: () => ipcRenderer.invoke('get-chat-overlay-mode'),
  onChatOverlayMode: (cb) => ipcRenderer.on('chat-overlay-mode', (_event,state) => cb(state)),
  onHostChat: (cb) => ipcRenderer.on('host-chat', (_event,state) => cb(state)),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  // 冒烟模式日志（engine.html）
  smokeLog: (obj) => ipcRenderer.send('smoke-log', obj),
  smokeExit: (code, summary) => ipcRenderer.send('smoke-exit', { code, summary }),
});
