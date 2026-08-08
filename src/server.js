// 服务端 — 双人微信风格聊天
// 功能: 文字/图片/文件/语音条消息、WebRTC 音频信令、通话控制、消息持久化
// 稳定性: 消息服务端中转(不依赖 P2P 直连), 断线重连凭 token 认领身份

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 8100;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'messages.json');
const MAX_MSG = 5 * 1024 * 1024; // 单条消息 5MB 上限
const MAX_HISTORY = 500; // 保留最近 500 条消息

// ---------- 持久化 ----------
const store = { rooms: {} }; // roomId -> { messages: [], users: {} }

try {
  if (fs.existsSync(DATA_FILE)) {
    Object.assign(store, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    console.log(`[store] 已恢复 ${Object.keys(store.rooms).length} 个房间`);
  }
} catch (e) {
  console.error('[store] 存档损坏, 从空白开始:', e.message);
}

let saveTimer = null;
function markDirty() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
      console.error('[store] 写盘失败:', e.message);
    }
  }, 400);
}

function flushSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(store), 'utf8');
  } catch (e) { console.error('[store] 保存失败:', e.message); }
}

// ---------- HTTP 服务 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer();

// 文件上传(图片/文件走 HTTP, 不走 WS 消息) ----------
const FILES_DIR = path.join(__dirname, '..', 'data', 'files');
const MAX_UPLOAD = 10 * 1024 * 1024; // 上传上限 10MB

function saveFile(buf, ext) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const name = `${uuidv4()}${ext}`;
  fs.writeFileSync(path.join(FILES_DIR, name), buf);
  return name;
}

// 在静态服务之前插入上传/下载路由
server.on('request', (req, res) => {
  if (req.method === 'POST' && req.url === '/api/upload') {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) { tooBig = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) { res.writeHead(413); return res.end('too large'); }
      const ext = (req.headers['x-file-ext'] || '').slice(0, 10).replace(/[^\w.]/g, '');
      const id = saveFile(Buffer.concat(chunks), ext);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: '/api/file/' + id }));
    });
    req.on('error', () => { try { res.writeHead(400); res.end(); } catch {} });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/file/')) {
    const id = req.url.slice('/api/file/'.length).replace(/[^\w.-]/g, '');
    const file = path.join(FILES_DIR, id);
    if (!file.startsWith(FILES_DIR) || !fs.existsSync(file)) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'max-age=86400' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  // 继续默认处理
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (pathname === '/') pathname = '/index.html';
    const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUBLIC_DIR, safe);
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404);
        return res.end('not found');
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=3600',
      });
      res.end(buf);
    });
  } catch {
    res.writeHead(500);
    res.end('server error');
  }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });
const rooms = new Map(); // roomId -> Set<ws>
const clients = new Map(); // ws -> { roomId, token, name }

function roomClients(roomId) {
  let s = rooms.get(roomId);
  if (!s) { s = new Set(); rooms.set(roomId, s); }
  return s;
}

function send(ws, type, payload = {}) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify({ type, ...payload })); } catch {}
}

function broadcast(roomId, type, payload, exceptWs = null) {
  for (const ws of roomClients(roomId)) {
    if (ws === exceptWs || ws.readyState !== ws.OPEN) continue;
    send(ws, type, payload);
  }
}

function broadcastPresence(roomId) {
  const online = [...roomClients(roomId)].filter((w) => w.readyState === WebSocket.OPEN).map((w) => clients.get(w)?.name).filter(Boolean);
  broadcast(roomId, 'presence', { online });
}

function persistMessage(roomId, msg) {
  const room = store.rooms[roomId] || (store.rooms[roomId] = { messages: [] });
  room.messages.push(msg);
  if (room.messages.length > MAX_HISTORY) room.messages.splice(0, room.messages.length - MAX_HISTORY);
  markDirty();
}

const validToken = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(t);
const validRoom = (r) => typeof r === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(r);

// 密码哈希 — 只存哈希不存明文 (sha256(password + roomId))
const hashPass = (pw, roomId) => createHash('sha256').update(pw + '@' + roomId).digest('hex');

wss.on('connection', (ws) => {
  ws.isAlive = true;
  clients.set(ws, {});
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, 'error', { error: '消息格式错误' }); }
    if (!msg || typeof msg.type !== 'string') return;
    try { handle(ws, msg); } catch (e) { console.error('[ws] 处理出错:', e); send(ws, 'error', { error: '服务器处理出错' }); }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info.roomId) {
      roomClients(info.roomId).delete(ws);
      if (roomClients(info.roomId).size === 0) rooms.delete(info.roomId);
      broadcastPresence(info.roomId);
    }
    clients.delete(ws);
  });

  ws.on('error', () => {});
});

function handle(ws, msg) {
  const info = clients.get(ws);

  if (msg.type === 'join') {
    if (!validRoom(msg.roomId) || !validToken(msg.token)) return send(ws, 'error', { error: '参数不合法' });
    const roomId = msg.roomId;
    const name = typeof msg.name === 'string' ? msg.name.slice(0, 16) || '对方' : '对方';
    const room = store.rooms[roomId] || (store.rooms[roomId] = { messages: [], users: {} });
    // 房间密码: 首个进入者设置, 之后进入需验证
    const password = typeof msg.password === 'string' ? msg.password.trim() : '';
    if (room.passhash) {
      if (!password || hashPass(password, roomId) !== room.passhash) return send(ws, 'error', { error: '密码错误' });
    } else if (password) {
      room.passhash = hashPass(password, roomId);
      markDirty();
    }
    info.roomId = roomId;
    info.token = msg.token;
    info.name = name;
    roomClients(roomId).add(ws);

    send(ws, 'joined', {
      name,
      history: room.messages.slice(-100),
      avatars: room.users || {},
      moments: room.moments || [],
    });
    broadcastPresence(roomId);
    return;
  }

  if (!info.roomId) return send(ws, 'error', { error: '尚未加入房间' });
  const roomId = info.roomId;

  switch (msg.type) {
    case 'chat': {
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 2000) : '';
      if (!text) return;
      const m = { id: uuidv4(), kind: 'text', text, from: info.name, at: Date.now() };
      persistMessage(roomId, m);
      broadcast(roomId, 'message', { message: m });
      break;
    }

    case 'file': {
      // msg: { kind: 'image'|'file'|'voice', name, url?, data?(base64, voice用), mime, duration? }
      const kind = ['image', 'file', 'voice'].includes(msg.kind) ? msg.kind : 'file';
      if (typeof msg.url === 'string') {
        if (!/^\/api\/file\/[\w.-]+$/.test(msg.url)) return send(ws, 'error', { error: '文件地址不合法' });
        const m = {
          id: uuidv4(), kind,
          name: typeof msg.name === 'string' ? msg.name.slice(0, 128) : 'file',
          url: msg.url,
          mime: typeof msg.mime === 'string' ? msg.mime.slice(0, 64) : '',
          from: info.name, at: Date.now(),
        };
        persistMessage(roomId, m);
        broadcast(roomId, 'message', { message: m });
        break;
      }
      // 旧格式/语音条: base64 data
      if (typeof msg.data !== 'string' || msg.data.length > 2 * 1024 * 1024) return send(ws, 'error', { error: '文件过大' });
      const m = {
        id: uuidv4(), kind,
        name: typeof msg.name === 'string' ? msg.name.slice(0, 128) : 'file',
        data: msg.data, // base64
        mime: typeof msg.mime === 'string' ? msg.mime.slice(0, 64) : '',
        duration: msg.duration ? Math.min(parseInt(msg.duration, 10) || 0, 600) : 0,
        from: info.name, at: Date.now(),
      };
      persistMessage(roomId, m);
      broadcast(roomId, 'message', { message: m });
      break;
    }

    // ---- WebRTC 音频信令 ----
    case 'signal': {
      // msg: { target, signal: {type:'offer'|'answer'|'ice', sdp/ice} }
      broadcast(roomId, 'signal', { from: info.name, signal: msg.signal }, ws);
      break;
    }

    case 'call': {
      // 通话控制: invite | accept | reject | hangup
      broadcast(roomId, 'call', { from: info.name, action: msg.action }, ws);
      break;
    }

    case 'setAvatar': {
      // 换头像: url 复用 /api/file/ 上传结果, 房间内广播
      const url = typeof msg.url === 'string' ? msg.url : '';
      if (!/^\/api\/file\/[\w.-]+$/.test(url)) return send(ws, 'error', { error: '文件地址不合法' });
      const room = store.rooms[roomId] || (store.rooms[roomId] = { messages: [], users: {} });
      room.users[info.name] = url;
      markDirty();
      broadcast(roomId, 'avatar', { name: info.name, url });
      break;
    }

    case 'moment': {
      // 图文动态: text ≤ 1000, images ≤ 4 张
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 1000) : '';
      const images = Array.isArray(msg.images)
        ? msg.images.filter((u) => typeof u === 'string' && /^\/api\/file\/[\w.-]+$/.test(u)).slice(0, 4)
        : [];
      if (!text && images.length === 0) return;
      const m = { id: uuidv4(), author: info.name, text, images, at: Date.now(), likes: [] };
      const room = store.rooms[roomId] || (store.rooms[roomId] = { messages: [], users: {} });
      room.moments = room.moments || [];
      room.moments.push(m);
      if (room.moments.length > 200) room.moments.splice(0, room.moments.length - 200);
      markDirty();
      broadcast(roomId, 'moment', { moment: m });
      break;
    }

    case 'momentLike': {
      // 点赞切换: 已赞就取消, 未赞就加入
      const id = typeof msg.id === 'string' ? msg.id : '';
      const room = store.rooms[roomId];
      const moment = room && room.moments && room.moments.find((x) => x.id === id);
      if (!moment) return;
      const i = moment.likes.indexOf(info.name);
      if (i >= 0) moment.likes.splice(i, 1); else moment.likes.push(info.name);
      markDirty();
      broadcast(roomId, 'momentUpdate', { id, likes: moment.likes });
      break;
    }

    case 'typing':
      broadcast(roomId, 'typing', { from: info.name }, ws);
      break;

    case 'ping':
      send(ws, 'pong', {});
      break;

    default:
      send(ws, 'error', { error: '未知指令' });
  }
}

// 心跳
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

// 优雅退出
function shutdown(sig) {
  console.log(`[server] ${sig}, 保存退出...`);
  clearInterval(heartbeat);
  flushSync();
  for (const ws of wss.clients) { try { ws.close(1001, 'restart'); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => { console.error(e); try { flushSync(); } catch {} process.exit(1); });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] lovechat 已启动 http://0.0.0.0:${PORT}`);
  console.log(`[server] 存档: ${DATA_FILE}`);
});
