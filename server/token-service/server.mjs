// Token 服务：建房 / 房间列表 / 进房 / 停止共享
// 零运行时依赖（node:crypto + 全局 fetch），全配置走 config.json + 环境变量
// 房间与权限摘要由 LiveKit 承载；Token 服务部署为单实例，按房间串行修改状态。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 配置：config.json 优先，环境变量覆盖 ----------
const defaults = {
  listen: '0.0.0.0:8080',
  livekit: {
    httpUrl: 'http://localhost:7880', // 服务端内部 Twirp 地址
    apiKey: 'devkey',
    apiSecret: 'secret',
  },
  rooms: {
    tokenTtlMinutes: 240,
    requirePassword: false,
    maxRoomIdLength: 32,
    emptyTimeoutSeconds: 60,
  },
};

function loadConfig() {
  const localConfig = path.join(__dirname, 'config.json');
  const file = process.env.CONFIG_PATH ?? (fs.existsSync(localConfig)
    ? localConfig : path.join(__dirname, 'config.example.json'));
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // 无配置文件时用默认值（容器内靠环境变量）
  }
  const cfg = {
    listen: process.env.LISTEN ?? fromFile.listen ?? defaults.listen,
    livekit: {
      httpUrl: process.env.LIVEKIT_HTTP_URL ?? fromFile.livekit?.httpUrl ?? defaults.livekit.httpUrl,
      wsUrl: process.env.LIVEKIT_WS_URL ?? fromFile.livekit?.wsUrl ?? defaults.livekit.wsUrl,
      apiKey: process.env.LIVEKIT_API_KEY ?? fromFile.livekit?.apiKey ?? defaults.livekit.apiKey,
      apiSecret: process.env.LIVEKIT_API_SECRET ?? fromFile.livekit?.apiSecret ?? defaults.livekit.apiSecret,
    },
    rooms: { ...defaults.rooms, ...(fromFile.rooms ?? {}) },
    authToken: process.env.AUTH_TOKEN ?? fromFile.authToken ?? '',
  };
  return cfg;
}
const cfg = loadConfig();

// ---------- JWT HS256（LiveKit Access Token） ----------
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function signJwt(payload) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', cfg.livekit.apiSecret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

function grantToken({ identity, name, grants, ttlMinutes }) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: cfg.livekit.apiKey,
    sub: identity,
    iat: now,
    exp: now + ttlMinutes * 60,
    ...(name ? { name } : {}),
    video: grants,
  });
}

const serverToken = (video) => grantToken({ identity: 'token-service', grants: video, ttlMinutes: 2 });

// ---------- LiveKit RoomService（Twirp over HTTP） ----------
async function twirp(method, body, video) {
  const res = await fetch(`${cfg.livekit.httpUrl}/twirp/livekit.RoomService/${method}`, {
    signal: AbortSignal.timeout(10000),
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${serverToken(video)}` },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const err = new Error(`livekit ${method}: ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status >= 500 ? 502 : res.status;
    throw err;
  }
  return data;
}

const listLiveRooms = (roomId) =>
  twirp('ListRooms', roomId ? { names: [roomId] } : {}, { roomList: true }).then((r) => (r.rooms ?? []).map((room) => ({
    ...room,
    // Twirp 的 protobuf JSON 可用 camelCase；兼容旧版 snake_case 返回。
    num_participants: Number(room.numParticipants ?? room.num_participants ?? 0),
    num_publishers: Number(room.numPublishers ?? room.num_publishers ?? 0),
  })));

// ---------- 房间元数据：只存摘要，不存房主管理凭证或明文口令 ----------
const roomLocks = new Map();
async function withRoomLock(id, fn) {
  const previous = roomLocks.get(id) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(fn);
  roomLocks.set(id, job);
  try { return await job; }
  finally { if (roomLocks.get(id) === job) roomLocks.delete(id); }
}
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const passwordDigest = (password, nonce) => crypto.createHmac('sha256', cfg.livekit.apiSecret)
  .update(JSON.stringify([nonce, password])).digest('hex');
const roomMetadata = (m) => JSON.stringify(m);
const parseMetadata = (s) => {
  try {
    const o = JSON.parse(s ?? '');
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
};

const randomId = () => crypto.randomBytes(4).toString('hex');

function timingSafeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- HTTP ----------
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
};

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '', bytes = 0, tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      bytes += Buffer.byteLength(c);
      if (bytes > 64 * 1024) {
        tooLarge = true; data = '';
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        return;
      }
      data += c;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        const body = JSON.parse(data);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body');
        resolve(body);
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function validateRoomId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (!id || id.length > cfg.rooms.maxRoomIdLength) return null;
  if (/\p{C}/u.test(id)) return null; // 控制字符
  return id;
}

async function handleCreateRoom(req, res) {
  const body = await readBody(req);
  const roomId = validateRoomId(body.roomId);
  if (!roomId) return send(res, 400, { error: `房间号无效（1-${cfg.rooms.maxRoomIdLength} 个字符）` });
  const presenter = typeof body.presenter === 'string' && body.presenter.trim() ? body.presenter.trim().slice(0, 64) : '匿名';
  const password = typeof body.password === 'string' ? body.password.slice(0, 64) : '';
  if (cfg.rooms.requirePassword && !password) return send(res, 400, { error: '本服务端要求房间口令' });

  return withRoomLock(roomId, async () => {
    const live = await listLiveRooms(roomId);
    if (live.length > 0) return send(res, 409, { error: `房间号「${roomId}」已被使用` });

    const ownerToken = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(16).toString('hex');
    const meta = { presenter, hasPassword: !!password, nonce, ownerHash: digest(ownerToken),
      ...(password ? { passwordHash: passwordDigest(password, nonce) } : {}), createdAt: Date.now() };
    try {
      await twirp(
        'CreateRoom',
        { name: roomId, empty_timeout: cfg.rooms.emptyTimeoutSeconds, metadata: roomMetadata(meta) },
        { roomCreate: true }
      );
    } catch (err) {
      return send(res, err.status ?? 502, { error: `创建房间失败：${err.message}` });
    }

    const token = grantToken({
      identity: `pub-${randomId()}`,
      name: presenter,
      grants: { roomJoin: true, room: roomId, canPublish: true, canSubscribe: true, canPublishData: true },
      ttlMinutes: cfg.rooms.tokenTtlMinutes,
    });
    send(res, 201, { roomId, presenter, url: cfg.livekit.wsUrl, token, ownerToken });
  });
}

async function handleListRooms(res) {
  let rooms;
  try {
    rooms = await listLiveRooms();
  } catch (err) {
    return send(res, err.status ?? 502, { error: `查询房间列表失败：${err.message}` });
  }
  const list = rooms.filter((r) => Number(r.num_publishers) > 0).map((r) => {
    const meta = parseMetadata(r.metadata);
    return {
      roomId: r.name,
      presenter: meta.presenter ?? '未知',
      hasPassword: !!meta.hasPassword,
      participants: r.num_participants ?? 0,
      publishers: r.num_publishers ?? 0,
    };
  });
  send(res, 200, { rooms: list });
}

async function handleJoin(req, res, roomIdRaw) {
  const roomId = validateRoomId(roomIdRaw);
  if (!roomId) return send(res, 400, { error: '房间号无效' });
  const body = await readBody(req);
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 64) : '观众';

  let live;
  try {
    live = await listLiveRooms(roomId);
  } catch (err) {
    return send(res, err.status ?? 502, { error: `查询房间失败：${err.message}` });
  }
  if (live.length === 0) return send(res, 404, { error: '房间不存在或共享已结束' });

  const meta = parseMetadata(live[0].metadata);
  if (meta.hasPassword) {
    if (!meta.passwordHash || !meta.nonce) return send(res, 503, { error: '口令校验暂不可用，请共享者重新建房' });
    if (typeof body.password !== 'string' || !timingSafeEq(passwordDigest(body.password, meta.nonce), meta.passwordHash)) {
      return send(res, 401, { error: '房间口令错误' });
    }
  }

  const token = grantToken({
    identity: `sub-${randomId()}`,
    name,
    grants: { roomJoin: true, room: roomId, canPublish: false, canSubscribe: true },
    ttlMinutes: cfg.rooms.tokenTtlMinutes,
  });
  send(res, 200, { roomId, url: cfg.livekit.wsUrl, token });
}

async function handleStop(res, roomIdRaw, body) {
  const roomId = validateRoomId(roomIdRaw);
  if (!roomId) return send(res, 400, { error: '房间号无效' });
  return withRoomLock(roomId, async () => {
    const live = await listLiveRooms(roomId);
    if (!live.length) return send(res, 404, { error: '房间不存在或共享已结束' });
    const meta = parseMetadata(live[0].metadata);
    if (typeof body.ownerToken !== 'string' || !meta.ownerHash || !timingSafeEq(digest(body.ownerToken), meta.ownerHash)) {
      return send(res, 403, { error: '只有共享者可以结束房间' });
    }
    try {
      await twirp('DeleteRoom', { room: roomId }, { roomCreate: true });
    } catch (err) {
      return send(res, err.status ?? 502, { error: `结束房间失败：${err.message}` });
    }
    send(res, 200, { ok: true });
  });
}

// 发布者异常退出后，观众不会让空画面房间无限存活。给建房/短暂重连留出宽限期。
const noPublisherSince = new Map();
let sweeping = false;
async function sweepRooms() {
  if (sweeping) return;
  sweeping = true;
  try {
    const rooms = await listLiveRooms();
    const names = new Set(rooms.map((r) => r.name));
    for (const id of noPublisherSince.keys()) if (!names.has(id)) noPublisherSince.delete(id);
    for (const r of rooms) {
      if (!parseMetadata(r.metadata).ownerHash) continue;
      if (Number(r.num_publishers) > 0) { noPublisherSince.delete(r.name); continue; }
      const previous = noPublisherSince.get(r.name);
      const since = previous?.sid === r.sid ? previous.since : Date.now();
      noPublisherSince.set(r.name, { sid: r.sid, since });
      if (Date.now() - since < cfg.rooms.emptyTimeoutSeconds * 1000) continue;
      await withRoomLock(r.name, async () => {
        const current = await listLiveRooms(r.name);
        // SID 防止旧清理请求删除刚重建的同号房间。
        if (current[0]?.sid === r.sid && Number(current[0]?.num_publishers ?? 0) === 0) {
          await twirp('DeleteRoom', { room: r.name }, { roomCreate: true });
          noPublisherSince.delete(r.name);
        }
      });
    }
  } catch (err) { console.error('[token-service] sweep:', err.message); }
  finally { sweeping = false; }
}

// API 鉴权：AUTH_TOKEN 设置后需 Authorization: Bearer <token>（常量时间比较；REQUIRE_AUTH=1 时列表也受保护）
function checkAuth(req) {
  if (!cfg.authToken) return true;
  const presented = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  return !!presented && timingSafeEq(presented, cfg.authToken);
}

// REQUIRE_AUTH=1（IP 直连部署）：未配置令牌直接拒绝启动；令牌为客户端与服务端共享的对等密钥
if (process.env.REQUIRE_AUTH === '1' && !cfg.authToken) {
  console.error('[token-service] REQUIRE_AUTH=1 但未设置 AUTH_TOKEN——IP 直连部署必须配置访问令牌（openssl rand -hex 16），拒绝启动');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/rooms') { if (!checkAuth(req)) return send(res, 401, { error: '未授权（缺 Bearer 令牌）' }); return await handleListRooms(res); }
    if (req.method === 'POST' && url.pathname === '/api/rooms') { if (!checkAuth(req)) return send(res, 401, { error: '未授权（缺 Bearer 令牌）' }); return await handleCreateRoom(req, res); }
    const join = url.pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
    if (req.method === 'POST' && join) { if (!checkAuth(req)) return send(res, 401, { error: '未授权（缺 Bearer 令牌）' }); return await handleJoin(req, res, decodeURIComponent(join[1])); }
    const stop = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
    if (req.method === 'DELETE' && stop) { if (!checkAuth(req)) return send(res, 401, { error: '未授权（缺 Bearer 令牌）' }); return await handleStop(res, decodeURIComponent(stop[1]), await readBody(req)); }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, err.status ?? 500, { error: err.message ?? 'internal error' });
  }
});

const [host, port] = cfg.listen.split(':');
server.listen(Number(port), host, () => {
  console.log(`[token-service] listening on ${cfg.listen}`);
  console.log(`[token-service] livekit http=${cfg.livekit.httpUrl} ws=${cfg.livekit.wsUrl}`);
});
const sweepTimer = setInterval(sweepRooms, 15000);
sweepTimer.unref();
server.on('close', () => clearInterval(sweepTimer));
