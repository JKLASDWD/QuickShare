'use strict';
// ScreenShare 客户端主进程：托盘 / 全局热键 / 窗口管理 / 冒烟模式
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  desktopCapturer,
  session,
  Notification,
  nativeImage,
  screen,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { validateTlsSettings, installCertificatePolicy } = require('./certificate-policy');
const { normalizeRoomId } = require('./room-id');
const { createProcessAudio, resolveAudioExecutable } = require('./process-audio');
const { createDiagnostics } = require('./diagnostics');
const audioModule = () => resolveAudioExecutable({resourcesPath:process.resourcesPath,appPath:__dirname,isPackaged:app.isPackaged,existsSync:fs.existsSync});
const processAudio = createProcessAudio({
  executable: () => {
    const result=audioModule();log('app-audio-module',result);
    if(!result.executable) throw new Error('缺少应用声音模块，请重新安装或完整解压客户端；可点击“日志”查看模块检查结果');
    return result.executable;
  },
  onData: (owner, data) => { if (!owner.isDestroyed()) owner.send('app-audio-data', data); else processAudio.stop(owner); },
  onError: (owner, data) => { log('app-audio-error',data);if (!owner.isDestroyed()) owner.send('app-audio-error', data); },
});
// 联调使用隔离配置，避免测试读写用户的日常配置。
if (process.argv.includes('--smoke') && process.env.QUICKSHARE_SMOKE_DATA) {
  app.setPath('userData', process.env.QUICKSHARE_SMOKE_DATA);
}
// 线上排查：QUICKSHARE_CDP=9222 启动时开放本机回环调试口；日志落盘 userData/main.log
if (process.env.QUICKSHARE_CDP) app.commandLine.appendSwitch('remote-debugging-port', process.env.QUICKSHARE_CDP);
const diagnostics = createDiagnostics({directory:app.getPath('userData'),getSecrets:()=>[config?.authToken],filesystem:fs});
const log = diagnostics.log;
process.on('uncaughtException', (e) => log('uncaughtException', e.stack || String(e)));
process.on('unhandledRejection', (e) => log('unhandledRejection', (e && e.stack) || String(e)));

// ---------- 冒烟模式：electron . --smoke publish|watch <roomId> [server] [durationMs] ----------
const smokeArgv = parseSmokeArgs(process.argv);
function parseSmokeArgs(argv) {
  const i = argv.indexOf('--smoke');
  if (i === -1) return null;
  const [mode, roomId, server, durationMs] = argv.slice(i + 1);
  if ((mode === 'publish' || mode === 'watch') && roomId) {
    return { mode, roomId, server: server || 'http://localhost:8080', durationMs: Number(durationMs) || 20000 };
  }
  console.error('usage: electron . --smoke publish|watch <roomId> [serverUrl] [durationMs]');
  app.exit(2);
  return null;
}

// ---------- 配置：exe 旁 config.json（便携）优先，否则 userData ----------
const CONFIG_DEFAULTS = {
  server: 'http://localhost:8080',
  hotkey: 'Control+Alt+S',
  displayName: '',
  defaultRoomId: '',
  authToken: '', // 服务端可选 Bearer（IP 直连公网部署时开启）
  trustInvalidServerCertificate: false, // 勾选后仅对配置的服务器主机跳过证书错误
  videoQuality: '1080p',
  frameRate: 30,
  audioMode: 'off',
  notificationsEnabled: false,
  showChatOverlay: true,
  chatOverlayWidth: 400,
  chatOverlayHeight: 340,
};

function resolveConfigPath() {
  if (app.isPackaged) {
    const portable = path.join(path.dirname(process.execPath), 'config.json');
    if (fs.existsSync(portable)) return portable;
  }
  return path.join(app.getPath('userData'), 'config.json');
}

let config;
function loadConfig() {
  const cfg = { ...CONFIG_DEFAULTS };
  try {
    Object.assign(cfg, JSON.parse(fs.readFileSync(resolveConfigPath(), 'utf8')));
  } catch {
    // 首次运行：落盘默认配置，便于用户直接改文件
    try {
      fs.mkdirSync(path.dirname(resolveConfigPath()), { recursive: true });
      fs.writeFileSync(resolveConfigPath(), JSON.stringify(cfg, null, 2));
    } catch {}
  }
  if (!cfg.displayName) cfg.displayName = os.userInfo().username || '用户';
  normalizeMediaConfig(cfg);
  delete cfg.serverCertificateSha256; // 旧指纹不自动启用信任例外。
  return cfg;
}
function normalizeMediaConfig(cfg) {
  cfg.defaultRoomId = normalizeRoomId(cfg.defaultRoomId);
  if (!['720p','1080p','1440p','2160p','original'].includes(cfg.videoQuality)) cfg.videoQuality = '1080p';
  if (![15,30,60].includes(Number(cfg.frameRate))) cfg.frameRate = 30;
  cfg.frameRate = Number(cfg.frameRate);
  if (!['off','application','system','microphone'].includes(cfg.audioMode)) cfg.audioMode = 'off';
  cfg.notificationsEnabled = cfg.notificationsEnabled === true;
  cfg.showChatOverlay = cfg.showChatOverlay !== false;
  for (const [key,min,max,fallback] of [['chatOverlayWidth',240,1000,400],['chatOverlayHeight',160,900,340]]) {
    const value = Number(cfg[key]);cfg[key] = Number.isFinite(value) && value > 0 ? Math.max(min,Math.min(max,Math.round(value))) : fallback;
  }
  delete cfg.maxBitrateKbps;
}
const persistConfig = () => fs.writeFileSync(resolveConfigPath(), JSON.stringify(config, null, 2));

// ---------- 窗口 ----------
/** @type {BrowserWindow|null} */ let pickerWin = null;
/** @type {BrowserWindow|null} */ let viewerWin = null;
/** @type {BrowserWindow|null} */ let settingsWin = null;
/** @type {Tray|null} */ let tray = null;
let logsWin = null;
function createLogsWindow() {
  if(logsWin&&!logsWin.isDestroyed()){logsWin.show();return;}
  const win=logsWin=new BrowserWindow({width:920,height:640,title:'诊断日志',icon:ICON,webPreferences:baseWebPrefs});
  win.on('closed',()=>{if(logsWin===win)logsWin=null;});win.loadFile(path.join(__dirname,'renderer','logs.html'));
}
function instrumentWindow(win,name) {
  win.webContents.on('render-process-gone',(_event,details)=>log('renderer-crash',{window:name,...details}));
  win.webContents.on('preload-error',(_event,preload,error)=>log('preload-error',{window:name,preload,error:String(error)}));
  win.webContents.on('did-fail-load',(_event,code,description)=>log('page-load-error',{window:name,code,description}));
}
let chatOverlay = null, hostChat = null, overlayDismissed = false;
let overlayTimer = null, overlayEditing = false, overlayBounds = null;
function raiseChatOverlay() {
  if (!chatOverlay || chatOverlay.isDestroyed()) return;
  try { chatOverlay.setAlwaysOnTop(true, 'screen-saver');chatOverlay.moveTop(); } catch {}
}
function editChatOverlay(editing) {
  if (!chatOverlay || chatOverlay.isDestroyed()) return;
  overlayEditing = editing === true;
  chatOverlay.setIgnoreMouseEvents(!overlayEditing);
  chatOverlay.setFocusable(overlayEditing);
  chatOverlay.webContents.send('chat-overlay-mode', { editing: overlayEditing });
  raiseChatOverlay();
}
function closeChatOverlay() {
  clearInterval(overlayTimer);overlayTimer = null;overlayEditing = false;
  const old = chatOverlay; chatOverlay = null;
  if (old && !old.isDestroyed()) { overlayBounds = old.getBounds();old.destroy(); }
}
function syncChatOverlay() {
  if (!sharing || !hostChat || hostChat.roomId !== sharing.roomId || !config.showChatOverlay || overlayDismissed) { closeChatOverlay(); return; }
  if (!chatOverlay || chatOverlay.isDestroyed()) {
    const area = (overlayBounds ? screen.getDisplayMatching(overlayBounds) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea;
    const width = Math.min(config.chatOverlayWidth, area.width), height = Math.min(config.chatOverlayHeight, area.height);
    const bounds = {width,height,x:area.x+Math.max(0,area.width-width-16),y:area.y+Math.min(16,area.height-height)};
    if (overlayBounds) { bounds.x = Math.max(area.x,Math.min(overlayBounds.x,area.x+area.width-width));bounds.y = Math.max(area.y,Math.min(overlayBounds.y,area.y+area.height-height)); }
    const win = chatOverlay = new BrowserWindow({...bounds,show:false,frame:false,transparent:true,backgroundColor:'#00000000',thickFrame:false,hasShadow:false,resizable:false,maximizable:false,minimizable:false,fullscreenable:false,focusable:false,alwaysOnTop:true,skipTaskbar:true,title:'共享弹幕',icon:ICON,webPreferences:baseWebPrefs});
    instrumentWindow(win,'overlay');log('overlay-created',{width,height});
    overlayEditing = false;
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(true);
    win.on('closed', () => { if (chatOverlay === win) { clearInterval(overlayTimer);overlayTimer = null;chatOverlay = null;overlayEditing = false;overlayDismissed = true; } });
    win.on('moved', () => { if (!win.isDestroyed()) overlayBounds = win.getBounds(); });
    win.on('blur', () => { if (chatOverlay === win && overlayEditing) editChatOverlay(false); });
    win.webContents.on('did-finish-load', () => { if (chatOverlay === win) {win.webContents.send('host-chat',hostChat);win.webContents.send('chat-overlay-mode',{editing:overlayEditing});} });
    win.loadFile(path.join(__dirname,'renderer','chat-overlay.html'));
    win.once('ready-to-show', () => { if (chatOverlay === win && !win.isDestroyed()) {win.showInactive();raiseChatOverlay();} });
    overlayTimer = setInterval(raiseChatOverlay,1000);
    overlayTimer.unref?.();
  }
  const current = chatOverlay.getBounds(), area = screen.getDisplayMatching(current).workArea;
  const width = Math.min(config.chatOverlayWidth,area.width), height = Math.min(config.chatOverlayHeight,area.height);
  if (current.width !== width || current.height !== height) {
    chatOverlay.setBounds({width,height,x:Math.max(area.x,Math.min(current.x,area.x+area.width-width)),y:Math.max(area.y,Math.min(current.y,area.y+area.height-height))});
    overlayBounds = chatOverlay.getBounds();
  }
  chatOverlay.webContents.send('host-chat',hostChat);
  raiseChatOverlay();
}
let quitting = false, quitReady = false, quitTimer = null;
function completeQuit() {
  if (!quitting || quitReady) return;
  quitReady = true;
  clearTimeout(quitTimer);
  app.quit();
}

const PRELOAD = path.join(__dirname, 'preload.js');
const baseWebPrefs = { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false };

const ICON = (() => {
  const p = path.join(__dirname, 'assets', 'icon.png');
  return fs.existsSync(p) ? p : undefined;
})();

function createPickerWindow() {
  if (pickerWin && !pickerWin.isDestroyed()) return;
  pickerWin = new BrowserWindow({
    width: 860,
    height: 640,
    show: false,
    icon: ICON,
    title: '共享屏幕',
    webPreferences: baseWebPrefs,
  });
  pickerWin.on('close', (e) => {
    // 共享进行中最小化到托盘而不是退出（推流在渲染进程，关窗即断流）
    if (sharing && !quitReady) {
      e.preventDefault();
      pickerWin.hide();
    }
  });
  const window = pickerWin;
  instrumentWindow(window,'publisher');
  window.on('closed', () => { if (pickerWin === window) pickerWin = null; });
  pickerWin.webContents.on('render-process-gone', () => {
    processAudio.stop(window.webContents);
    sharing = null;
    hostChat = null;closeChatOverlay();
    buildTrayMenu();
    if (quitting) completeQuit();
  });
  window.webContents.on('destroyed', () => { audioRequests.delete(window.webContents); processAudio.stop(window.webContents); });
  pickerWin.loadFile(path.join(__dirname, 'renderer', 'picker.html'));
  // 启动即前台显示（首次与每次重建都生效）
  pickerWin.once('ready-to-show', () => showPicker());
}

function createViewerWindow() {
  if (viewerWin && !viewerWin.isDestroyed()) return;
  viewerWin = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    icon: ICON,
    title: '查看共享',
    webPreferences: baseWebPrefs,
  });
  const window = viewerWin;
  instrumentWindow(window,'viewer');
  window.on('closed', () => { if (viewerWin === window) viewerWin = null; });
  viewerWin.webContents.on('did-fail-load', (_e, code, desc, url) => log('viewer-load-fail', { code, desc, url }));
  viewerWin.webContents.on('render-process-gone', (_e, details) => log('viewer-render-gone', details));
  viewerWin.loadFile(path.join(__dirname, 'renderer', 'viewer.html'));
}

function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 480,
    height: 760,
    show: false,
    icon: ICON,
    title: '设置',
    skipTaskbar: true,
    resizable: true,
    minWidth: 450,
    minHeight: 500,
    parent: pickerWin ?? undefined,
    webPreferences: baseWebPrefs,
  });
  settingsWin.on('closed', () => (settingsWin = null));
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
}

function showPicker() {
  try {
    app.focus({ steal: true });
    if (!pickerWin || pickerWin.isDestroyed()) {
      createPickerWindow();
      pickerWin.once('ready-to-show', () => {
        pickerWin?.show();
        pickerWin?.focus();
      });
      return;
    }
    pickerWin.show();
    pickerWin.focus();
    pickerWin.moveTop();
    pickerWin.webContents.send('picker-shown');
  } catch (e) {
    log('showPicker-fail', String(e));
    if (!pickerWin || pickerWin.isDestroyed()) createPickerWindow();
  }
}

function showViewer() {
  try {
    log('showViewer', { hasWin: !!viewerWin, destroyed: viewerWin?.isDestroyed() });
    app.focus({ steal: true });
    if (!viewerWin || viewerWin.isDestroyed()) {
      createViewerWindow();
      viewerWin.once('ready-to-show', () => {
        log('viewer-ready-to-show');
        viewerWin?.show();
        viewerWin?.focus();
        viewerWin?.moveTop();
      });
      return;
    }
    viewerWin.show();
    viewerWin.focus();
    viewerWin.moveTop();
    viewerWin.webContents.send('viewer-shown');
  } catch (e) {
    log('showViewer-fail', String(e));
    if (!viewerWin || viewerWin.isDestroyed()) {
      createViewerWindow();
      viewerWin.once('ready-to-show', () => viewerWin?.show());
    }
  }
}

// ---------- 托盘 ----------
let sharing = null; // { roomId, presenter }

function notify(title, body) {
  if (config?.notificationsEnabled && Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
}

function buildTrayMenu() {
  const menu = [
    { label: sharing ? `共享中：房间 ${sharing.roomId}` : '共享屏幕…', enabled: true, click: () => (sharing ? pickerWin?.show() : showPicker()) },
    { label: '查看共享（房间列表）', click: () => showViewer() },
    { type: 'separator' },
    ...(sharing ? [{ label: '停止共享', click: () => { pickerWin?.webContents.send('stop-share'); } }] : []), // 乐观清态：渲染端回报 share-stopped 时幂等再清
    ...(sharing && config.showChatOverlay ? [{ label: '调整弹幕位置', click: () => { overlayDismissed=false;syncChatOverlay();editChatOverlay(true); } }] : []),
    { label: '设置', click: () => createSettingsWindow() },
    { label: '查看日志', click: createLogsWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ];
  tray?.setContextMenu(Menu.buildFromTemplate(menu));
  tray?.setToolTip(sharing ? `屏幕共享中 · 房间 ${sharing.roomId}` : '屏幕共享（未共享）');
}

function createTray() {
  tray = new Tray(ICON ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : nativeImage.createEmpty());
  tray.on('double-click', () => (sharing ? pickerWin?.show() : showPicker()));
  buildTrayMenu();
}

// ---------- 热键 ----------
function registerHotkey() {
  globalShortcut.unregisterAll();
  try {
    globalShortcut.register(config.hotkey, () => (sharing ? pickerWin?.show() : showPicker()));
  } catch {
    notify('热键注册失败', `「${config.hotkey}」不可用，请到设置中更换`);
  }
  try { if (!globalShortcut.register('Control+Shift+F10', () => { if (!sharing || !config.showChatOverlay) return;overlayDismissed=false;syncChatOverlay();editChatOverlay(!overlayEditing); })) log('chat-overlay-hotkey-unavailable'); } catch { log('chat-overlay-hotkey-unavailable'); }
}

// ---------- IPC ----------
// desktopCapturer.getSources 在 Windows 上并发调用会互锁挂起：单飞队列串行执行 + 超时降级
let sourcesQueue = Promise.resolve();
function enqueueGetSources(types) {
  const run = () =>
    desktopCapturer.getSources({
      types,
      thumbnailSize: { width: 320, height: 180 },
    });
  const job = sourcesQueue.then(run, run);
  sourcesQueue = job.catch(() => {}); // 队列不因失败中断
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('枚举超时（15 秒），请重试')), 15000); });
  return Promise.race([job, timeout]).finally(() => clearTimeout(timer));
}

ipcMain.handle('list-sources', async (_e, types) => {
  const t0 = Date.now();
  const want = Array.isArray(types) && types.length ? types.filter((t) => t === 'screen' || t === 'window') : ['screen', 'window'];
  log('list-sources-begin', { want });
  try {
    const sources = await enqueueGetSources(want);
    const mapped = sources
      .filter((s) => s.name && s.name.trim())
      .map((s) => ({ id: s.id, kind: s.id.startsWith('screen:') ? 'screen' : 'window', name: s.name, thumbnail: s.thumbnail.toDataURL(), icon: null }));
    log('list-sources-ok', { want, ms: Date.now() - t0, count: mapped.length });
    return mapped;
  } catch (e) {
    log('list-sources-fail', { want, ms: Date.now() - t0, error: String((e && e.message) || e) });
    throw e;
  }
});

let captureSelection = null;
const audioRequests = new Map();
ipcMain.handle('get-app-audio-support', () => ({
  available: process.platform === 'win32' && Number(os.release().split('.')[2]) >= 19041 && !!audioModule().executable,
  reason: !audioModule().executable ? 'module-missing' : Number(os.release().split('.')[2]) < 19041 ? 'windows-version' : '',
}));
ipcMain.handle('start-app-audio', async (event, sourceId) => {
  if (event.sender !== pickerWin?.webContents) throw new Error('无效的采集窗口');
  if (process.platform !== 'win32' || Number(os.release().split('.')[2]) < 19041) throw new Error('所选应用声音需要 Windows 10 2004 或更新版本');
  if (audioRequests.has(event.sender)) throw new Error('应用声音正在启动');
  const request = Symbol('audio-request');
  audioRequests.set(event.sender, request);
  log('app-audio-start',{sourceId,...audioModule()});
  try {
    const sources = await enqueueGetSources(['window']);
    if (audioRequests.get(event.sender) !== request || event.sender.isDestroyed()) throw new Error('应用声音采集已取消');
    if (!sources.some(source => source.id === sourceId)) throw new Error('所选窗口已不可用，请刷新列表');
    const result=await processAudio.start(event.sender, sourceId);log('app-audio-ready',{sampleRate:result.sampleRate,channels:result.channels});return result;
  } catch(error) { log('app-audio-start-failed',{sourceId,error:error.message});throw error;
  } finally { if (audioRequests.get(event.sender) === request) audioRequests.delete(event.sender); }
});
ipcMain.handle('stop-app-audio', (event, id) => { log('app-audio-stop');if (!id) audioRequests.delete(event.sender); return processAudio.stop(event.sender, id); });
ipcMain.handle('prepare-capture', (event, sourceId) => {
  if (event.sender !== pickerWin?.webContents) throw new Error('无效的采集窗口');
  if (sourceId && !/^(screen|window):/.test(sourceId)) throw new Error('无效的采集源');
  captureSelection = { sender: event.sender, sourceId };
});
ipcMain.handle('get-config', () => { log('get-config'); return { ...config, configPath: resolveConfigPath() }; });
ipcMain.handle('save-config', (_e, patch) => {
  const next = { ...config, ...patch };
  normalizeMediaConfig(next);
  next.trustInvalidServerCertificate = validateTlsSettings(next);
  delete next.serverCertificateSha256;
  if (!config.showChatOverlay && next.showChatOverlay) overlayDismissed = false;
  config = next;
  persistConfig();
  registerHotkey();
  buildTrayMenu();
  syncChatOverlay();
  for (const win of [pickerWin, viewerWin, settingsWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('config-changed', { ...config });
  }
  return { ...config, configPath: resolveConfigPath() };
});

ipcMain.on('share-started', (_e, info) => {
  log('share-started', info);
  sharing = info;
  overlayDismissed = false;syncChatOverlay();
  buildTrayMenu();
  notify('已开始共享', `房间「${info.roomId}」共享中，同事在客户端房间列表点击即可观看`);
});
ipcMain.on('share-busy', () => { sharing = { roomId: '正在连接…' }; buildTrayMenu(); });
ipcMain.on('share-stopped', (_e, info) => {
  log('share-stopped', info);
  log('capture-cleanup', { windows: BrowserWindow.getAllWindows?.().map(w => ({ id: w.id, destroyed: w.isDestroyed() })) || [], platform: os.release() });
  sharing = null;
  hostChat = null;overlayDismissed = false;closeChatOverlay();
  buildTrayMenu();
  if (info?.error) notify('共享已中断', info.error);
  if (quitting) completeQuit();
});
ipcMain.on('notify', (_e, { title, body }) => notify(title, body));
ipcMain.on('open-viewer', () => { log('open-viewer'); showViewer(); });
ipcMain.on('open-picker', () => showPicker());
ipcMain.on('open-settings', () => createSettingsWindow());
ipcMain.on('open-logs',createLogsWindow);
ipcMain.handle('get-logs',event=>event.sender===logsWin?.webContents?diagnostics.read():null);
ipcMain.on('open-log-folder',event=>{if(event.sender===logsWin?.webContents)shell.showItemInFolder(diagnostics.read().path);});
ipcMain.on('host-chat-state', (event, state) => {
  if (event.sender !== pickerWin?.webContents || !state || typeof state.roomId !== 'string' || !Array.isArray(state.members) || !Array.isArray(state.messages)) return;
  hostChat = state;syncChatOverlay();
});
ipcMain.handle('get-host-chat', event => event.sender === chatOverlay?.webContents ? hostChat : null);
ipcMain.on('show-chat-overlay', event => {
  if (event.sender !== pickerWin?.webContents) return;
  overlayDismissed = false;syncChatOverlay();
});
ipcMain.on('edit-chat-overlay', event => {
  if (event.sender !== pickerWin?.webContents) return;
  overlayDismissed=false;syncChatOverlay();editChatOverlay(true);
});
ipcMain.handle('get-chat-overlay-mode', event => event.sender === chatOverlay?.webContents ? {editing:overlayEditing} : {editing:false});
ipcMain.on('lock-chat-overlay', event => { if (event.sender === chatOverlay?.webContents) editChatOverlay(false); });
ipcMain.on('renderer-log', (_e, msg) => log('renderer', msg));

// ---------- 冒烟模式 ----------
function runSmoke(smoke) {
  const engine = new BrowserWindow({ show: false, webPreferences: baseWebPrefs });
  engine.webContents.on('console-message', (_e, _lvl, msg) => console.log(`[engine-console] ${msg}`));
  const q = new URLSearchParams({ mode: smoke.mode, room: smoke.roomId, server: smoke.server, duration: String(smoke.durationMs) });
  if (process.env.QUICKSHARE_SMOKE_AUDIO === '1') q.set('audio', '1');
  engine.loadFile(path.join(__dirname, 'renderer', 'engine.html'), { query: q.toString() });
}

ipcMain.on('smoke-log', (_e, obj) => process.stdout.write(`${JSON.stringify(obj)}\n`));
ipcMain.on('smoke-exit', (_e, { code, summary }) => {
  if (summary) process.stdout.write(`${JSON.stringify({ event: 'summary', ...summary })}\n`);
  app.exit(code);
});

// ---------- 生命周期 ----------
// 冒烟发布端和观看端需要在同一台机器同时运行。
const gotLock = smokeArgv || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showPicker());

  app.whenReady().then(() => {
    try {
      // 常用操作由页面工具栏提供，避免默认菜单的整页重载中断共享。
      Menu.setApplicationMenu(null);
      log('app-ready', { version: app.getVersion(), electron: process.versions.electron, cdp: process.env.QUICKSHARE_CDP || null });
      config = loadConfig();
      validateTlsSettings(config);
      installCertificatePolicy(session.defaultSession, () => config, (details) => log('certificate-trust-override', details));
      log('config-loaded', { path: resolveConfigPath(), server: config.server });
      log('audio-environment',{packaged:app.isPackaged,windows:os.release(),...audioModule()});
      if (smokeArgv) return runSmoke(smokeArgv);
      // getDisplayMedia（系统选择器共享）：Windows 优先系统原生选择器；不可用时按官方文档回退 desktopCapturer
      try {
        session.defaultSession.setDisplayMediaRequestHandler(
          (request, callback) => {
            const selection = captureSelection;
            captureSelection = null;
            if (!selection || selection.sender !== pickerWin?.webContents) return callback({});
            const type = selection.sourceId?.startsWith('window:') ? 'window' : 'screen';
            enqueueGetSources([type]).then((sources) => {
              const source = selection.sourceId ? sources.find(s => s.id === selection.sourceId) : sources[0];
              callback(source ? { video: source, ...(request.audioRequested ? { audio: 'loopback' } : {}) } : {});
            }).catch((e) => { log('display-media-error', String(e)); callback({}); });
          },
          { useSystemPicker: false }
        );
        log('display-media-handler-ok');
      } catch (e) { log('display-media-handler-fail', String(e)); }
      createTray();
      log('tray-ok');
      createPickerWindow(); // 启动即前台；viewer 懒创建，点「查看共享」时再开
      log('picker-window-created');
      registerHotkey();
      log('startup-complete');
    } catch (e) {
      log('startup-fail', e.stack || String(e));
    }
  });

  app.on('window-all-closed', () => {
    // 托盘常驻：关闭全部窗口不退出
  });
  app.on('before-quit', (e) => {
    log('before-quit');
    globalShortcut.unregisterAll();
    if (quitReady) return;
    if (!pickerWin || pickerWin.isDestroyed()) { quitReady = true; return; }
    e.preventDefault();
    if (quitting) return;
    quitting = true;
    // 等待轨道停止和删房回报；渲染进程无响应时仍保证可以退出。
    quitTimer = setTimeout(completeQuit, 5000);
    pickerWin.webContents.send('stop-share');
  });
  app.on('will-quit', () => processAudio.stopAll());
}
