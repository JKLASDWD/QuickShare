'use strict';
// Optional real Chromium HTTPS/WSS check. Supply an IP-SAN certificate and its test-only key.
const path = require('node:path');
const fs = require('node:fs');
const { X509Certificate, createHash } = require('node:crypto');
const { installCertificatePolicy } = require('../client/certificate-policy');

if (process.versions.electron) {
  const { app, BrowserWindow, session } = require('electron');
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const timeout = setTimeout(() => app.exit(2), 20000);
  app.whenReady().then(async () => {
    const base = process.env.QUICKSHARE_TLS_TEST_URL;
    for (const mode of ['default', 'match', 'mismatch']) {
      const partition = `tls-smoke-${mode}`;
      const ses = session.fromPartition(partition);
      const pin = mode === 'match' ? process.env.QUICKSHARE_TLS_TEST_PIN : mode === 'mismatch' ? 'A'.repeat(64) : '';
      installCertificatePolicy(ses, () => ({ server: base, serverCertificateSha256: pin }));
      const win = new BrowserWindow({ show: false, webPreferences: { partition, contextIsolation: true, nodeIntegration: false } });
      await win.loadFile(path.join(__dirname, '../client/renderer/settings.html'));
      const result = await win.webContents.executeJavaScript(`(async () => {
        const result = { https: false, wss: false };
        try { const r = await fetch(${JSON.stringify(base)} + '/api/health'); result.https = r.ok && (await r.json()).ok; } catch {}
        result.wss = await new Promise(resolve => {
          const socket = new WebSocket(${JSON.stringify(base.replace('https:', 'wss:'))} + '/ws');
          const timer = setTimeout(() => { socket.close(); resolve(false); }, 5000);
          socket.onmessage = event => { clearTimeout(timer); socket.close(); resolve(event.data === 'ok'); };
          socket.onerror = () => { clearTimeout(timer); resolve(false); };
        });
        return result;
      })()`);
      win.destroy();
      const expected = mode === 'match';
      if (result.https !== expected || result.wss !== expected) throw new Error(`${mode}: ${JSON.stringify(result)}`);
      console.log(`PASS ${mode}: HTTPS=${result.https}, WSS=${result.wss}`);
    }
    clearTimeout(timeout);
    app.exit(0);
  }).catch(error => { console.error(error.stack); app.exit(1); });
} else {
  const https = require('node:https');
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  async function run() {
    const [certPath, keyPath] = process.argv.slice(2);
    if (!certPath || !keyPath) throw new Error('Usage: node tests/tls-electron-smoke.cjs <test-IP-SAN-cert> <test-key>');
    const cert = fs.readFileSync(certPath), key = fs.readFileSync(keyPath);
    const server = https.createServer({ cert, key }, (req, res) => {
      res.writeHead(req.method === 'OPTIONS' ? 204 : 200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,OPTIONS' });
      res.end(req.method === 'OPTIONS' ? '' : JSON.stringify({ ok: true }));
    });
    const sockets = new Set();
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('upgrade', (req, socket) => {
      const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.write(Buffer.from([0x81, 2, 0x6f, 0x6b]));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const env = { ...process.env, QUICKSHARE_TLS_TEST_URL: `https://127.0.0.1:${server.address().port}`, QUICKSHARE_TLS_TEST_PIN: new X509Certificate(cert).fingerprint256 };
      delete env.ELECTRON_RUN_AS_NODE;
      const electron = require('../client/node_modules/electron');
      const child = spawn(electron, [__filename, '--no-sandbox'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', b => { output += b; process.stdout.write(b); });
      child.stderr.on('data', b => process.stderr.write(b));
      const timer = setTimeout(() => child.kill(), 25000);
      const [code, signal] = await once(child, 'exit');
      clearTimeout(timer);
      if (code !== 0) throw new Error(`Electron TLS smoke failed: exit=${code}, signal=${signal}`);
      if (['default', 'match', 'mismatch'].some(mode => !output.includes(`PASS ${mode}:`))) {
        throw new Error('Electron exited without completing all HTTPS/WSS cases');
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  }
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
