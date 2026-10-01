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
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
// 联调使用隔离配置，避免测试读写用户的日常配置。
if (process.argv.includes('--smoke') && process.env.QUICKSHARE_SMOKE_DATA) {
  app.setPath('userData', process.env.QUICKSHARE_SMOKE_DATA);
}
// 线上排查：QUICKSHARE_CDP=9222 启动时开放本机回环调试口；日志落盘 userData/main.log
if (process.env.QUICKSHARE_CDP) app.commandLine.appendSwitch('remote-debugging-port', process.env.QUICKSHARE_CDP);
const LOG_PATH = path.join(app.getPath('userData'), 'main.log');
function log(event, data) {
  try { fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${event} ${typeof data === 'string' ? data : JSON.stringify(data ?? '')}\n`); } catch {}
}
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
  authToken: '', // 服务端可选 Bearer（IP 直连公网部署时开启）
  maxBitrateKbps: 8000, // 1080p 屏幕文字内容 4M 偏紧易糊；新装机默认 8M（已落盘配置可在设置里改）
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
  return cfg;
}
const persistConfig = () => fs.writeFileSync(resolveConfigPath(), JSON.stringify(config, null, 2));

// ---------- 窗口 ----------
/** @type {BrowserWindow|null} */ let pickerWin = null;
/** @type {BrowserWindow|null} */ let viewerWin = null;
/** @type {BrowserWindow|null} */ let settingsWin = null;
/** @type {Tray|null} */ let tray = null;
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
  pickerWin.on('closed', () => (pickerWin = null));
  pickerWin.webContents.on('render-process-gone', () => {
    sharing = null;
    buildTrayMenu();
    if (quitting) completeQuit();
  });
  pickerWin.loadFile(path.join(__dirname, 'renderer', 'picker.html'));
  // 启动即前台显示（首次与每次重建都生效）
  pickerWin.once('ready-to-show', () => showPicker());
}

function createViewerWindow() {
  viewerWin = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    icon: ICON,
    title: '查看共享',
    webPreferences: baseWebPrefs,
  });
  viewerWin.on('closed', () => (viewerWin = null));
  viewerWin.webContents.on('did-fail-load', (_e, code, desc, url) => log('viewer-load-fail', { code, desc, url }));
  viewerWin.webContents.on('render-process-gone', (_e, details) => log('viewer-render-gone', details));
  viewerWin.loadFile(path.join(__dirname, 'renderer', 'viewer.html'));
}

function createSettingsWindow() {
  if (settingsWin) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 480,
    height: 560,
    show: false,
    icon: ICON,
    title: '设置',
    resizable: false,
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
  } catch {
    createPickerWindow();
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
    createViewerWindow();
    viewerWin.once('ready-to-show', () => viewerWin?.show());
  }
}

// ---------- 托盘 ----------
let sharing = null; // { roomId, presenter }

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
}

function buildTrayMenu() {
  const menu = [
    { label: sharing ? `共享中：房间 ${sharing.roomId}` : '共享屏幕…', enabled: true, click: () => (sharing ? pickerWin?.show() : showPicker()) },
    { label: '查看共享（房间列表）', click: () => showViewer() },
    { type: 'separator' },
    ...(sharing ? [{ label: '停止共享', click: () => { pickerWin?.webContents.send('stop-share'); sharing = null; buildTrayMenu(); } }] : []), // 乐观清态：渲染端回报 share-stopped 时幂等再清
    { label: '设置', click: () => createSettingsWindow() },
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
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('枚举超时（15 秒），可改用「系统选择器共享」')), 15000));
  return Promise.race([job, timeout]);
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

ipcMain.handle('get-config', () => { log('get-config'); return { ...config, configPath: resolveConfigPath() }; });
ipcMain.handle('save-config', (_e, patch) => {
  config = { ...config, ...patch };
  persistConfig();
  registerHotkey();
  buildTrayMenu();
  for (const win of [pickerWin, viewerWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('config-changed', { ...config });
  }
  return { ...config, configPath: resolveConfigPath() };
});

ipcMain.on('share-started', (_e, info) => {
  log('share-started', info);
  sharing = info;
  buildTrayMenu();
  notify('已开始共享', `房间「${info.roomId}」共享中，同事在客户端房间列表点击即可观看`);
});
ipcMain.on('share-busy', () => { sharing = { roomId: '正在连接…' }; buildTrayMenu(); });
ipcMain.on('share-stopped', (_e, info) => {
  log('share-stopped', info);
  sharing = null;
  buildTrayMenu();
  if (info?.error) notify('共享已中断', info.error);
  if (quitting) completeQuit();
});
ipcMain.on('notify', (_e, { title, body }) => notify(title, body));
ipcMain.on('open-viewer', () => { log('open-viewer'); showViewer(); });
ipcMain.on('renderer-log', (_e, msg) => log('renderer', msg));

// ---------- 冒烟模式 ----------
function runSmoke(smoke) {
  const engine = new BrowserWindow({ show: false, webPreferences: baseWebPrefs });
  engine.webContents.on('console-message', (_e, _lvl, msg) => console.log(`[engine-console] ${msg}`));
  const q = new URLSearchParams({ mode: smoke.mode, room: smoke.roomId, server: smoke.server, duration: String(smoke.durationMs) });
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
      log('app-ready', { version: app.getVersion(), electron: process.versions.electron, cdp: process.env.QUICKSHARE_CDP || null });
      config = loadConfig();
      log('config-loaded', { path: resolveConfigPath(), server: config.server });
      if (smokeArgv) return runSmoke(smokeArgv);
      // getDisplayMedia（系统选择器共享）：Windows 优先系统原生选择器；不可用时按官方文档回退 desktopCapturer
      try {
        session.defaultSession.setDisplayMediaRequestHandler(
          (_request, callback) => {
            log('display-media-request');
            desktopCapturer
              .getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } })
              .then((sources) => callback(sources.length ? { video: sources[0] } : {}))
              .catch((e) => { log('display-media-error', String(e)); callback({}); });
          },
          { useSystemPicker: true }
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
}
