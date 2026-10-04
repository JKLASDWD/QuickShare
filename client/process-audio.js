'use strict';
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
function resolveAudioExecutable({resourcesPath,appPath,isPackaged,existsSync}) {
  const candidates = [path.join(resourcesPath || '', 'native', 'process-audio.exe'), path.join(resourcesPath || '', 'app.asar.unpacked', 'native', 'bin', 'process-audio.exe')];
  if (!isPackaged) candidates.unshift(path.join(appPath,'native','bin','process-audio.exe'));
  return {executable:candidates.find(file=>existsSync(file)) || null,candidates};
}

function windowHandle(sourceId) {
  const match = /^window:([1-9]\d*):\d+$/.exec(String(sourceId));
  if (!match) throw new Error('所选应用声音仅支持单个窗口，请先选择窗口');
  return match[1];
}
function createProcessAudio({ executable, launch = spawn, onData, onError }) {
  const sessions = new Map();
  function start(owner, sourceId) {
    const handle = windowHandle(sourceId);
    if (sessions.has(owner)) throw new Error('应用声音正在采集，请先停止共享');
    const helper = typeof executable === 'function' ? executable() : executable;
    const child = launch(helper, ['--window', handle], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    const state = { id: randomUUID(), child, stopping: false, ready: false, pending: Buffer.alloc(0), error: null };
    sessions.set(owner, state);
    child.stdin.on('error', () => {});
    let resolveStart, rejectStart;
    const started = new Promise((resolve,reject) => { resolveStart=resolve;rejectStart=reject; });
    function failure(message) {
      state.error = new Error(message);
      rejectStart(state.error);
      if (state.ready && !state.stopping) onError(owner, { id: state.id, message });
      stop(owner, state.id);
    }
    const timeout = setTimeout(() => failure('应用声音启动超时，请检查 Windows 更新或改为关闭声音'), 10000);
    let diagnostic = '';
    child.stderr.on('data', chunk => {
      diagnostic += chunk.toString();
      if (diagnostic.length > 65536) return failure('应用声音返回异常');
      let end;
      while ((end = diagnostic.indexOf('\n')) >= 0) {
        const line = diagnostic.slice(0,end);diagnostic=diagnostic.slice(end+1);
        let event;try { event=JSON.parse(line); } catch { continue; }
        if (event.event === 'ready' && !state.stopping) {
          clearTimeout(timeout);state.ready=true;
          resolveStart({ id: state.id, sampleRate: event.sampleRate, channels: event.channels });
        } else if (event.event === 'error' && !state.stopping) {
          failure(event.stage === 'window-closed' ? '所选窗口已关闭，应用声音采集已停止' : event.stage === 'window' ? '所选窗口已不可用，请刷新列表并重新选择' : `当前系统无法采集所选应用声音（${event.stage} ${event.hresult}），请安装 Windows 更新或选择关闭声音`);
        }
      }
    });
    child.stdout.on('data', chunk => {
      if (state.stopping) return;
      state.pending = Buffer.concat([state.pending, chunk]);
      // Fixed 10 ms, float32 stereo frames; pipe chunks may split a sample.
      while (state.pending.length >= 3840) {
        const packet = Uint8Array.from(state.pending.subarray(0,3840));
        state.pending = state.pending.subarray(3840);
        onData(owner, { id: state.id, pcm: packet });
      }
    });
    child.on('error', () => failure('应用声音模块无法启动，请重新安装完整客户端'));
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (sessions.get(owner) === state) sessions.delete(owner);
      state.pending=Buffer.alloc(0);
      if (!state.ready) rejectStart(state.error || new Error(state.stopping ? '应用声音采集已取消' : `应用声音启动失败（${code}）`));
      else if (!state.stopping && !state.error) onError(owner, { id: state.id, message: '应用声音采集已中断，请重新共享' });
      state.resolveStop?.();
    });
    state.rejectStart = rejectStart;
    state.timeout = timeout;
    return started;
  }
  function stop(owner, id) {
    const state = sessions.get(owner);
    if (!state || (id && id !== state.id)) return Promise.resolve();
    if (state.stopTask) return state.stopTask;
    state.stopping=true;clearTimeout(state.timeout);state.pending=Buffer.alloc(0);
    state.rejectStart?.(new Error('应用声音采集已取消'));
    state.stopTask = new Promise(resolve => {
      const force = setTimeout(() => { state.child.kill(); }, 1500);
      const finish = setTimeout(() => { if (sessions.get(owner) === state) sessions.delete(owner); resolve(); }, 3000);
      state.resolveStop = () => { clearTimeout(force);clearTimeout(finish);resolve(); };
      try { state.child.stdin.end(); } catch { state.child.kill(); }
    });
    return state.stopTask;
  }
  function stopAll() { return Promise.all([...sessions.keys()].map(owner => stop(owner))); }
  return { start, stop, stopAll };
}
module.exports = { createProcessAudio, windowHandle, resolveAudioExecutable };
