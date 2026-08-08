# LoveChat v2 (密码/头像/背景/动态) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 给双人聊天加上房间密码、双方可见头像、仅自己可见的聊天背景、图文动态+点赞。

**Architecture:** 服务端继续用纯文件 store（`store.rooms[roomId]` 扩展 `passhash/users/moments` 字段）；密码用 Node 内置 `crypto` 做 sha256 哈希（零新依赖）；头像/动态图片全部复用现有 `/api/upload` HTTP 上传通道；前端加设置面板（换头像/背景）与动态视图。

**Tech Stack:** Node 20+ (`crypto` 内置), `ws`, vanilla JS, 纯文件持久化。

**测试约定**：`npm test` 的 glob 是 `test/*.test.js`，不匹配 `e2e.mjs`。运行方式：先 `npm start`（或后台 `node src/server.js`），再 `node test/e2e.mjs`。

**工作方式**：本地仓库（无远程），直接在主分支按批次提交，每个批次一个 commit。

---

### Task 1: 服务端 — 房间密码

**Files:**
- Modify: `src/server.js`（store 初始化区、join 处理、工具函数）

**Step 1: 加入哈希工具函数**（放在 `validToken` 附近，约 173 行）：

```js
// 密码哈希 — 只存哈希不存明文 (sha256(password + roomId))
import { createHash } from 'node:crypto';
const hashPass = (pw, roomId) => createHash('sha256').update(pw + '@' + roomId).digest('hex');
```

**Step 2: join 处理改为密码校验**（替换 `handle()` 中 join 分支，约 204-217 行）：

```js
if (msg.type === 'join') {
  if (!validRoom(msg.roomId) || !validToken(msg.token)) return send(ws, 'error', { error: '参数不合法' });
  const roomId = msg.roomId;
  const name = typeof msg.name === 'string' ? msg.name.slice(0, 16) || '对方' : '对方';
  const room = store.rooms[roomId] || (store.rooms[roomId] = { messages: [], users: {} });
  const password = typeof msg.password === 'string' ? msg.password.trim() : '';
  if (room.passhash) {
    // 房间已有密码 — 必须验证
    if (!password || hashPass(password, roomId) !== room.passhash) return send(ws, 'error', { error: '密码错误' });
  } else if (password) {
    // 首个进入者设置密码
    room.passhash = hashPass(password, roomId);
    markDirty();
  }
  info.roomId = roomId;
  info.token = msg.token;
  info.name = name;
  roomClients(roomId).add(ws);
  send(ws, 'joined', { name, history: room.messages.slice(-100), avatars: room.users || {}, moments: room.moments || [] });
  broadcastPresence(roomId);
  return;
}
```

**Step 3: 运行服务 + 手工验证**

Run: `node src/server.js` 后另开终端用 `node -e` 脚本或直接跳过（批次结束时统一跑 e2e）

**Step 4: 提交**

```bash
git add src/server.js && git commit -m "feat(server): 房间密码 sha256 哈希验证"
```

---

### Task 2: 服务端 — 头像 + 动态

**Files:**
- Modify: `src/server.js`（handle() switch 中新增 case）

**Step 1: 在 `case 'typing'` 前插入两个 case：**

```js
    case 'setAvatar': {
      // 换头像: url 复用 /api/file/ 上传结果
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
      const images = Array.isArray(msg.images) ? msg.images.filter((u) => typeof u === 'string' && /^\/api\/file\/[\w.-]+$/.test(u)).slice(0, 4) : [];
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
      // 点赞切换: 已赞就取消, 未赞就加
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
```

**Step 2: 提交**

```bash
git add src/server.js && git commit -m "feat(server): 头像存储与广播、图文动态+点赞"
```

---

### Task 3: 前端 — 进入页密码框 + 顶栏入口

**Files:**
- Modify: `public/index.html`（lobby 加密码框；topbar 加动态/设置按钮）

**Step 1: lobby 的 roomInput 后加密码框：**

```html
    <label class="field">
      <span>房间密码 <em class="opt">（新房间可设置，已有密码必须填）</em></span>
      <input id="passInput" maxlength="64" type="password" placeholder="首次进入可设置密码" autocomplete="off">
    </label>
```

**Step 2: topbar 加两个按钮**（callBtn 前）：

```html
    <button id="momentsBtn" class="call-btn" title="动态">🌙</button>
    <button id="settingsBtn" class="call-btn" title="设置">⚙️</button>
```

**Step 3: 提交**

```bash
git add public/index.html && git commit -m "feat(ui): 进入页密码框 + 顶栏动态/设置入口"
```

---

### Task 4: 前端 — 设置面板（头像/背景）

**Files:**
- Modify: `public/index.html`（设置面板 DOM）
- Modify: `public/style.css`（面板样式、消息头像图片样式）
- Modify: `public/app.js`（avatars 映射、avatarUrl()、设置逻辑）

**Step 1: index.html 的 callOverlay 后加设置面板：**

```html
<!-- ===== 设置面板 ===== -->
<div id="settingsOverlay" class="call-overlay hidden">
  <div class="call-card settings-card">
    <div class="call-title">设置</div>
    <div class="setting-row">
      <div>
        <div class="setting-label">我的头像</div>
        <div class="setting-sub">换头像后对方也能看到</div>
      </div>
      <div class="setting-actions">
        <img id="myAvatarPrev" class="avatar-preview" alt="">
        <button id="pickAvatarBtn" class="btn-mini">更换</button>
      </div>
    </div>
    <div class="setting-row">
      <div>
        <div class="setting-label">聊天背景</div>
        <div class="setting-sub">仅自己可见</div>
      </div>
      <div class="setting-actions">
        <button id="pickBgBtn" class="btn-mini">更换</button>
        <button id="resetBgBtn" class="btn-mini ghost">恢复默认</button>
      </div>
    </div>
    <div class="call-actions">
      <button id="settingsClose" class="btn-mini ghost">关闭</button>
    </div>
  </div>
</div>
<input type="file" id="avatarPicker" class="hidden" accept="image/*">
<input type="file" id="bgPicker" class="hidden" accept="image/*">
```

**Step 2: style.css 追加：**

```css
/* ===== 设置面板 ===== */
.settings-card { width: min(92vw, 340px); text-align: left; }
.setting-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 12px 0; border-bottom: 1px solid rgba(216,166,87,.12);
}
.setting-label { font-size: 14px; font-weight: 600; }
.setting-sub { font-size: 11px; color: var(--cream-dim); margin-top: 3px; }
.setting-actions { display: flex; align-items: center; gap: 8px; }
.avatar-preview {
  width: 44px; height: 44px; border-radius: 11px; object-fit: cover;
  background: linear-gradient(160deg, #b07a36, #6a4619);
}
.btn-mini {
  padding: 7px 14px; font-size: 12.5px; font-weight: 600; border-radius: 8px;
  color: #2b1d12; background: linear-gradient(160deg, #e8be7a, #c99a4e);
  border: none; cursor: pointer; font-family: inherit;
}
.btn-mini.ghost {
  color: var(--cream-dim); background: rgba(255,255,255,.06);
  border: 1px solid rgba(216,166,87,.2);
}
/* 消息头像图片 */
.msg .avatar img, .peer-avatar img, .call-avatar img {
  width: 100%; height: 100%; border-radius: inherit; object-fit: cover;
}
/* 聊天背景（消息区） */
.msg-list.bg-custom {
  background-image: linear-gradient(rgba(20,13,8,.55), rgba(20,13,8,.55)), var(--bg-url);
  background-size: cover; background-position: center;
}
```

**Step 3: app.js 增加 avatars 状态与 avatarUrl()：**

- 状态区加 `let avatars = {};`
- `handle()` 的 `joined` case 加 `avatars = m.avatars || {};`（在 appendHistory 之前）；新增 case：

```js
    case 'avatar':
      avatars[m.name] = m.url;
      if (m.name === peerName) updatePeerAvatar();
      refreshAllAvatars();
      break;
```

- 新增函数：

```js
function avatarUrl(name) {
  const url = avatars[name];
  return url && /^\/api\/file\/[\w.-]+$/.test(url) ? url : '';
}
function refreshAllAvatars() {
  document.querySelectorAll('.msg .avatar').forEach((el) => {
    const name = el.dataset.name;
    el.innerHTML = '';
    const url = avatarUrl(name);
    if (url) { const img = document.createElement('img'); img.src = url; el.appendChild(img); }
    else el.textContent = avatarOf(name);
  });
  updatePeerAvatar();
}
function updatePeerAvatar() {
  const url = avatarUrl(peerName);
  const el = $('peerAvatar');
  el.innerHTML = '';
  if (url) { const img = document.createElement('img'); img.src = url; el.appendChild(img); }
  else el.textContent = '?';
  $('myAvatarPrev').style.backgroundImage = avatarUrl(myName) ? `url('${avatarUrl(myName)}')` : '';
}
```

- `renderMessage()` 中 avatar 创建处加 `avatar.dataset.name = m.from;`，并调用 `refreshAllAvatars()`（在消息渲染后）或直接给该行设置内容。简单做法：在 `renderMessage` 结尾调 `refreshAllAvatars()`。

**Step 4: 设置交互逻辑**（app.js 事件区）：

```js
// 设置面板
$('settingsBtn').onclick = () => $('settingsOverlay').classList.remove('hidden');
$('settingsClose').onclick = () => $('settingsOverlay').classList.add('hidden');
$('pickAvatarBtn').onclick = () => $('avatarPicker').click();
$('pickBgBtn').onclick = () => $('bgPicker').click();
$('avatarPicker').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  toast('上传头像中…');
  try {
    const small = await compressToSquare(f, 320);
    const url = await uploadFile(small);
    send({ type: 'setAvatar', url });
  } catch { toast('头像上传失败'); }
});
$('bgPicker').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  toast('上传背景中…');
  try {
    const small = await compressImage(f);
    const url = await uploadFile(small);
    localStorage.setItem('lovechat.bg', url);
    applyBg();
  } catch { toast('背景上传失败'); }
});
$('resetBgBtn').onclick = () => { localStorage.removeItem('lovechat.bg'); applyBg(); };

function applyBg() {
  const url = localStorage.getItem('lovechat.bg');
  const list = $('msgList');
  list.classList.toggle('bg-custom', !!url);
  if (url) list.style.setProperty('--bg-url', `url('${url}')`);
}
applyBg();
```

- 新增 `compressToSquare(f, size)`（基于 compressImage 逻辑）：

```js
function compressToSquare(file, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const side = Math.min(size, Math.min(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = side; canvas.height = side;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, side, side);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error('compress failed'));
        resolve(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load failed')); };
    img.src = url;
  });
}
```

- `enter()` 中 join 前把密码存入 localStorage 并随 join 发送：`localStorage.setItem('lovechat.pass', pass);`，`connect()` 的 onopen join 对象加 `password: localStorage.getItem('lovechat.pass') || ''`。`handle()` 的 `error` case 中，若错误为"密码错误"，回到 lobby：

```js
    case 'error':
      toast(m.error || '出错了');
      if (m.error === '密码错误') {
        $('app').classList.add('hidden');
        $('lobby').classList.remove('hidden');
      }
      break;
```

**Step 5: 提交**

```bash
git add public/ && git commit -m "feat(ui): 设置面板 — 上传头像(双方可见)/聊天背景(仅自己)"
```

---

### Task 5: 前端 — 动态视图

**Files:**
- Modify: `public/index.html`（动态视图 DOM）
- Modify: `public/style.css`（动态样式）
- Modify: `public/app.js`（动态发布/列表/点赞）

**Step 1: index.html 的 app div 内、msgList 后加动态视图：**

```html
  <div id="momentsView" class="moments hidden">
    <div class="moment-compose">
      <textarea id="momentText" class="moment-text" maxlength="1000" rows="2" placeholder="想分享点什么…"></textarea>
      <div id="momentPics" class="moment-pics"></div>
      <div class="moment-actions">
        <button id="momentPicBtn" class="btn-mini ghost">📷 加图</button>
        <button id="momentSend" class="btn-mini">发布</button>
      </div>
    </div>
    <div id="momentList" class="moment-list"></div>
  </div>
  <input type="file" id="momentPicker" class="hidden" accept="image/*" multiple>
```

**Step 2: style.css 追加：**

```css
/* ===== 动态 ===== */
.moments { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.moment-compose {
  background: linear-gradient(165deg, rgba(88,62,40,.6), rgba(40,27,17,.8));
  border: 1px solid rgba(216,166,87,.2); border-radius: 14px; padding: 12px;
}
.moment-text {
  width: 100%; resize: none; font-family: inherit; font-size: 14px; color: var(--cream);
  background: rgba(20,13,8,.55); border: 1px solid rgba(216,166,87,.2);
  border-radius: 10px; padding: 10px; outline: none;
}
.moment-pics { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.moment-pics img { width: 72px; height: 72px; object-fit: cover; border-radius: 8px; }
.moment-pics .pic-x {
  position: relative; cursor: pointer;
}
.moment-pics .pic-x::after {
  content: '✕'; position: absolute; top: -6px; right: -6px; width: 18px; height: 18px;
  border-radius: 50%; background: rgba(0,0,0,.7); color: #fff; font-size: 11px;
  display: grid; place-items: center;
}
.moment-actions { display: flex; justify-content: space-between; margin-top: 10px; }
.moment-card {
  background: linear-gradient(165deg, rgba(88,62,40,.6), rgba(40,27,17,.8));
  border: 1px solid rgba(216,166,87,.18); border-radius: 14px; padding: 12px;
}
.moment-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.moment-head .avatar { width: 36px; height: 36px; border-radius: 9px; flex: 0 0 auto; display: grid; place-items: center; font-weight: 700; color: #f3dca6; background: linear-gradient(160deg, #b07a36, #6a4619); }
.moment-author { font-size: 14px; font-weight: 600; }
.moment-time { font-size: 11px; color: var(--cream-dim); }
.moment-text-body { font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; margin-bottom: 8px; }
.moment-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 8px; }
.moment-grid img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; cursor: pointer; }
.moment-like { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--cream-dim); cursor: pointer; user-select: none; }
.moment-like.on { color: var(--gold); }
.moment-like.on .heart { animation: heartBeat .3s ease; }
@keyframes heartBeat { 0%,100% { transform: scale(1);} 50% { transform: scale(1.4);} }
```

**Step 3: app.js 动态逻辑：**

- 状态区加 `let moments = []; let momentFiles = []; let momentImages = [];`
- `handle()` 的 joined case 加 `moments = m.moments || [];`
- 新增 case：

```js
    case 'moment':
      moments.unshift(m.moment);
      renderMoments();
      break;

    case 'momentUpdate': {
      const mo = moments.find((x) => x.id === m.id);
      if (mo) { mo.likes = m.likes || []; renderMoments(); }
      break;
    }
```

- 视图切换：

```js
function showMoments(show) {
  $('momentsView').classList.toggle('hidden', !show);
  $('msgList').classList.toggle('hidden', show);
  $('inputbar') && ($('inputbar').classList.toggle('hidden', show));
  if (show) renderMoments();
}
$('momentsBtn').onclick = () => showMoments($('momentsView').classList.contains('hidden'));
```

- 发布逻辑：

```js
function renderMoments() {
  const list = $('momentList');
  list.innerHTML = '';
  for (const mo of moments) {
    const card = document.createElement('div');
    card.className = 'moment-card';
    card.innerHTML = `
      <div class="moment-head">
        <div class="avatar">${avatarOf(mo.author)}</div>
        <div>
          <div class="moment-author">${mo.author}</div>
          <div class="moment-time">${fmtTime(mo.at)}</div>
        </div>
      </div>
      ${mo.text ? `<div class="moment-text-body"></div>` : ''}
      ${mo.images.length ? `<div class="moment-grid"></div>` : ''}
      <div class="moment-like${mo.likes.includes(myName) ? ' on' : ''}">
        <span class="heart">❤️</span><span>${mo.likes.length || '点赞'}</span>
      </div>`;
    if (mo.text) card.querySelector('.moment-text-body').textContent = mo.text;
    if (mo.images.length) {
      const grid = card.querySelector('.moment-grid');
      for (const u of mo.images) {
        const img = document.createElement('img');
        img.src = u; img.loading = 'lazy';
        img.onclick = () => showImagePreview(u);
        grid.appendChild(img);
      }
    }
    card.querySelector('.moment-like').onclick = () => send({ type: 'momentLike', id: mo.id });
    list.appendChild(card);
  }
}
```

- 发布框图片选择（压缩后上传，最多 4 张）：

```js
$('momentPicBtn').onclick = () => $('momentPicker').click();
$('momentPicker').addEventListener('change', async (e) => {
  const files = [...e.target.files].slice(0, 4 - momentImages.length);
  e.target.value = '';
  toast('上传图片中…');
  for (const f of files) {
    try {
      const small = await compressImage(f);
      const url = await uploadFile(small);
      momentImages.push(url);
      renderMomentPics();
    } catch { toast('图片上传失败'); }
  }
});
function renderMomentPics() {
  const box = $('momentPics');
  box.innerHTML = '';
  momentImages.forEach((u, i) => {
    const w = document.createElement('div');
    w.className = 'pic-x';
    const img = document.createElement('img');
    img.src = u;
    w.appendChild(img);
    w.onclick = () => { momentImages.splice(i, 1); renderMomentPics(); };
    box.appendChild(w);
  });
}
$('momentSend').onclick = () => {
  const text = $('momentText').value.trim();
  if (!text && !momentImages.length) return toast('写点内容或加张图吧');
  send({ type: 'moment', text, images: momentImages });
  $('momentText').value = '';
  momentImages = [];
  renderMomentPics();
};
```

- `enter()` 时调 `showMoments(false)`；`backBtn` 返回逻辑：若在动态视图先回聊天。

**Step 4: 提交**

```bash
git add public/ && git commit -m "feat(ui): 动态视图 — 图文发布、点赞切换"
```

---

### Task 6: e2e 测试扩展

**Files:**
- Modify: `test/e2e.mjs`

**Step 1: 文件末尾（第 8 组后）追加三组测试：**

```js
console.log('\n[9] 房间密码');
const ROOM_PW = 'lc' + Math.random().toString(36).slice(2, 8);
const p1 = new C('lctokenPWD111111');
await p1.conn(); p1.wire();
p1.send({ type: 'join', roomId: ROOM_PW, token: p1.tok, name: '阿巢', password: 'love123' });
await p1.wait((m) => m.type === 'joined');
ok(true, '首进入者设置密码并进入');

const p2 = new C('lctokenPWD222222');
await p2.conn(); p2.wire();
p2.send({ type: 'join', roomId: ROOM_PW, token: p2.tok, name: '宝贝' });
const p2Bad = await p2.wait((m) => m.type === 'error');
ok(/密码错误/.test(p2Bad.error), '无密码被拒');

p2.send({ type: 'join', roomId: ROOM_PW, token: p2.tok, name: '宝贝', password: 'wrong' });
await p2.wait((m) => m.type === 'error');
ok(true, '错误密码被拒');

p2.send({ type: 'join', roomId: ROOM_PW, token: p2.tok, name: '宝贝', password: 'love123' });
const p2Ok = await p2.wait((m) => m.type === 'joined');
ok(p2Ok.name === '宝贝', '正确密码进入');

console.log('\n[10] 动态发布与点赞');
a.send({ type: 'moment', text: '今天天气真好 🌞', images: [] });
const bGotMoment = await b.wait((m) => m.type === 'moment');
ok(bGotMoment.moment.text === '今天天气真好 🌞', '对方收到动态');
ok(bGotMoment.moment.author === '阿巢', '动态带作者');
ok(Array.isArray(bGotMoment.moment.likes) && bGotMoment.moment.likes.length === 0, '动态初始无点赞');

b.send({ type: 'momentLike', id: bGotMoment.moment.id });
const aGotLike = await a.wait((m) => m.type === 'momentUpdate');
ok(aGotLike.likes.includes('宝贝'), '点赞广播给双方');

b.send({ type: 'momentLike', id: bGotMoment.moment.id });
await a.wait((m) => m.type === 'momentUpdate' && m.likes.length === 0);
ok(true, '再点取消点赞');

console.log('\n[11] 头像广播');
a.send({ type: 'setAvatar', url: '/api/file/abc123.png' });
const bGotAvatar = await b.wait((m) => m.type === 'avatar');
ok(bGotAvatar.name === '阿巢' && bGotAvatar.url === '/api/file/abc123.png', '头像变更广播');

const a3 = new C(a.tok);
await a3.conn(); a3.wire();
a3.send({ type: 'join', roomId: ROOM, token: a.tok, name: '阿巢' });
const j3 = await a3.wait((m) => m.type === 'joined');
ok(j3.avatars && j3.avatars['阿巢'] === '/api/file/abc123.png', '重连后 joined 带头像映射');
ok(Array.isArray(j3.moments), 'joined 带动态列表');
```

**Step 2: 跑全部测试**

Run: 新开终端 `node src/server.js`，再 `node test/e2e.mjs`
Expected: 全部 ✓，`结果: N 通过, 0 失败`

**Step 3: 提交**

```bash
git add test/e2e.mjs && git commit -m "test: 密码/动态/头像 e2e 覆盖"
```

---

### Task 7: README 更新

**Files:**
- Modify: `README.md`

**Step 1: 更新功能列表**（加密码/头像/背景/动态）、**配置表**（无新增环境变量，注明不变）、**项目结构**（无新文件）、**测试覆盖清单**（加密码/动态/头像）。

**Step 2: 提交**

```bash
git add README.md && git commit -m "docs: 更新 v2 功能说明"
```

---

### Task 8: 最终验证（verification-before-completion）

**Step 1:** 启动服务 → 浏览器打开 → 手工走查：设置密码进入、错误密码被拒、换头像、换背景、发动态、点赞
**Step 2:** 重跑 `node test/e2e.mjs` 全绿
**Step 3:** `git status` 干净、`git log` 展示 8 个 commit
