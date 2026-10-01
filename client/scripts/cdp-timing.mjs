// 真实走一遍：选屏 → 共享 → 停止 → 计时服务端房间消失
const port = process.env.CDP_PORT || '9222';
const ROOM = process.env.TROOM || '888';

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const target = list.find((t) => t.type === 'page' && t.url.includes('picker.html'));
if (!target) { console.log('NO PICKER'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise((r) => { ws.onopen = r; });

const evalJS = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.result.value;

console.log('room =', await evalJS(`(() => { const i=document.getElementById('roomId'); i.value='${ROOM}'; return i.value; })()`));
console.log('select =', await evalJS(`(() => { document.querySelector('#screens .card, .card')?.click(); return document.querySelectorAll('.card.selected').length; })()`));

// 开始共享（真实 getUserMedia + 发布）
console.log('live =', await evalJS(`new Promise((resolve) => {
  const t0 = Date.now();
  document.getElementById('startBtn').click();
  const iv = setInterval(() => {
    if (document.getElementById('liveView').style.display === 'block') { clearInterval(iv); resolve('live ' + (Date.now()-t0) + 'ms'); }
    if (document.getElementById('err').textContent) { clearInterval(iv); resolve('ERR ' + document.getElementById('err').textContent); }
  }, 200);
  setTimeout(() => { clearInterval(iv); resolve('TIMEOUT'); }, 15000);
})`));

const roomsNow = await fetch('http://localhost:8080/api/rooms').then((r) => r.json());
console.log('server rooms while sharing:', JSON.stringify(roomsNow.rooms.map((r) => r.roomId)));

// 停止并计时
const t0 = Date.now();
await evalJS(`document.getElementById('stopBtn').click(); 'clicked'`);
let gone = -1;
for (let i = 0; i < 100; i++) {
  await new Promise((r) => setTimeout(r, 300));
  const j = await fetch('http://localhost:8080/api/rooms').then((r) => r.json());
  if (!j.rooms.some((r) => r.roomId === '${ROOM}')) { gone = Date.now() - t0; break; }
}
console.log('room gone after:', gone < 0 ? 'NOT GONE in 30s' : gone + 'ms');
console.log('ui back =', await evalJS(`({pick: document.getElementById('pickView').style.display, startEnabled: !document.getElementById('startBtn').disabled})`));
ws.close(); process.exit(0);
