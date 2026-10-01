#!/usr/bin/env node
// 用法：node scripts/cdp-probe.mjs ["任意 JS 表达式"]
// 连接 QUICKSHARE_CDP=9222 启动的 QuickShare，默认探查 picker 页健康状态。
const port = process.env.CDP_PORT || '9222';
const expr = process.argv[2] || `(() => ({
  bridge: !!window.bridge,
  openViewer: typeof window.bridge?.openViewer,
  log: typeof window.bridge?.log,
  url: location.pathname,
  hint: document.getElementById('hint')?.textContent ?? null,
  err: document.getElementById('err')?.textContent ?? null,
  cards: document.querySelectorAll('.card').length,
  roomId: document.getElementById('roomId')?.value ?? null,
}))()`;

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const pages = list.filter((t) => t.type === 'page');
console.log(`targets(${pages.length}):`, pages.map((p) => `${p.title} <${p.url.split('/').pop()}>`).join(' | '));
const target = pages.find((p) => p.url.includes('picker.html')) ?? pages[0];
if (!target) { console.log('NO PAGE TARGET'); process.exit(1); }
console.log('probe →', target.title, target.url.split('/').pop());

const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    console.log('[console.' + m.params.type + ']', m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    console.log('[exception]', m.params.exceptionDetails.text, m.params.exceptionDetails.exception?.description?.split('\n')[0] ?? '');
  }
};
await new Promise((r) => { ws.onopen = r; });
await send('Runtime.enable');
const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(res.result?.result?.value ?? res.result, null, 2));
ws.close();
process.exit(0);
