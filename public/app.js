/* 我们的客厅 — 前端逻辑
 * 消息收发 / 语音条 / 图片文件 / WebRTC 语音通话
 */
'use strict';

const $ = (id) => document.getElementById(id);

// ---------- 身份 ----------
function getToken() {
  let t = localStorage.getItem('lovechat.token');
  if (!t || !/^[A-Za-z0-9_-]{8,64}$/.test(t)) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    t = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('lovechat.token', t);
  }
  return t;
}
const TOKEN = getToken();

// ---------- 状态 ----------
let ws = null;
let myName = '';
let roomId = '';
let peerName = '对方';
let online = [];
let avatars = {}; // name -> avatar url
let moments = []; // 动态列表
let momentImages = []; // 发布框待发图片 url
let reconnectAttempt = 0;
let reconnectTimer = null;
let manualClose = false;

// 通话状态
let callState = 'idle'; // idle | calling | ringing | talking | reconnecting
let pc = null;
let localStream = null;
let callStartTime = 0;
let callTimerRaf = null;
let pendingOffer = null;
let pendingIce = []; // 远端描述设置前暂存 ICE 候选
let iceRestartCount = 0; // ICE 重试次数 (最多 1 次)

// 录音状态
let mediaRecorder = null;
let recChunks = [];
let recStart = 0;
let recTimerRaf = null;
let recStream = null;

// ================= 提示 =================
let toastTimer = null;
function toast(msg, ms = 2000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ================= WebSocket =================
function wsURL() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

function connect() {
  clearTimeout(reconnectTimer);
  manualClose = false;
  setStatus('连接中…');

  try { ws = new WebSocket(wsURL()); }
  catch { return scheduleReconnect(); }

  ws.onopen = () => {
    reconnectAttempt = 0;
    ws.send(JSON.stringify({
      type: 'join',
      roomId,
      token: TOKEN,
      name: myName,
      password: localStorage.getItem('lovechat.pass') || '',
    }));
  };

  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  };

  ws.onclose = () => {
    if (manualClose) return;
    setStatus('连接断开，重连中…');
    scheduleReconnect();
  };
  ws.onerror = () => {};
}

function scheduleReconnect() {
  reconnectAttempt++;
  const delay = Math.min(600 * Math.pow(1.6, reconnectAttempt - 1), 8000);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return toast('还没连上');
  try { ws.send(JSON.stringify(obj)); } catch { toast('发送失败'); }
}

function setStatus(text) {
  $('peerStatus').textContent = text;
  $('peerStatus').classList.toggle('online', text.includes('在线'));
}

// ================= 消息处理 =================
function handle(m) {
  switch (m.type) {
    case 'joined':
      avatars = m.avatars || {};
      moments = m.moments || [];
      appendHistory(m.history || []);
      if (m.name) peerName = m.name;
      $('peerName').textContent = peerName;
      updatePeerAvatar();
      setStatus('在线');
      break;

    case 'message':
      renderMessage(m.message);
      scrollToBottom();
      break;

    case 'presence': {
      const hadOnline = online.length > 0;
      online = m.online || [];
      const meOnline = online.includes(myName);
      setStatus(meOnline && online.length >= 2 ? '在线' : '离线');
      if (hadOnline && online.length < 2) toast('对方已离线');
      break;
    }

    case 'typing':
      if (m.from !== myName) { setStatus(`${m.from} 正在输入…`); setTimeout(() => setStatus('在线'), 1500); }
      break;

    case 'avatar':
      avatars[m.name] = m.url;
      refreshAllAvatars();
      break;

    case 'moment':
      moments.unshift(m.moment);
      renderMoments();
      break;

    case 'momentUpdate': {
      const mo = moments.find((x) => x.id === m.id);
      if (mo) { mo.likes = m.likes || []; renderMoments(); }
      break;
    }

    case 'signal':
      handleSignal(m.from, m.signal);
      break;

    case 'call':
      handleCall(m.from, m.action);
      break;

    case 'error':
      toast(m.error || '出错了');
      if (m.error === '密码错误') {
        // 密码不对, 关掉连接回大厅重试(避免僵尸连接)
        manualClose = true;
        if (ws) { try { ws.close(); } catch {} }
        ws = null;
        $('app').classList.add('hidden');
        $('lobby').classList.remove('hidden');
      }
      break;
  }
}

// ================= 渲染 =================
function scrollToBottom() {
  const list = $('msgList');
  list.scrollTop = list.scrollHeight;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function appendHistory(msgs) {
  for (const m of msgs) renderMessage(m, true);
  scrollToBottom();
}

function avatarOf(name) {
  return (name || '?').charAt(0).toUpperCase();
}

function avatarUrl(name) {
  const url = avatars[name];
  return url && /^\/api\/file\/[\w.-]+$/.test(url) ? url : '';
}

function refreshAllAvatars() {
  document.querySelectorAll('.msg .avatar').forEach((el) => {
    const name = el.dataset.name;
    el.innerHTML = '';
    const url = avatarUrl(name);
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      el.appendChild(img);
    } else {
      el.textContent = avatarOf(name);
    }
  });
  updatePeerAvatar();
}

function updatePeerAvatar() {
  const el = $('peerAvatar');
  el.innerHTML = '';
  const url = avatarUrl(peerName);
  el.innerHTML = '';
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    el.appendChild(img);
  } else {
    el.textContent = '?';
  }
  $('callAvatar').innerHTML = '';
  if (url) $('callAvatar').appendChild(el.firstChild.cloneNode());
  // 设置面板里的我的头像预览
  const my = avatarUrl(myName);
  $('myAvatarPrev').style.backgroundImage = my ? `url('${my}')` : '';
  $('myAvatarPrev').style.backgroundSize = 'cover';
}

function renderMessage(m, isHistory = false) {
  const mine = m.from === myName;
  const list = $('msgList');
  const row = document.createElement('div');
  row.className = 'msg ' + (mine ? 'mine' : 'peer');

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.dataset.name = m.from;
  avatar.textContent = avatarOf(m.from);
  row.appendChild(avatar);

  const body = document.createElement('div');
  body.className = 'body';

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = fmtTime(m.at);
  body.appendChild(meta);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (m.kind === 'text') {
    bubble.textContent = m.text;
  } else if (m.kind === 'image') {
    bubble.classList.add('image');
    const img = document.createElement('img');
    img.src = m.url || ('data:' + (m.mime || 'image/png') + ';base64,' + (m.data || ''));
    img.alt = m.name || '图片';
    img.loading = 'lazy';
    img.onclick = () => showImagePreview(img.src);
    bubble.appendChild(img);
  } else if (m.kind === 'voice') {
    bubble.classList.add('voice-msg');
    const dur = m.duration || 0;
    bubble.innerHTML = `
      <span class="v-icon">▶</span>
      <span class="v-bar">${'<i></i>'.repeat(Math.max(4, Math.min(16, Math.ceil(dur / 2))))}</span>
      <span class="v-dur">${dur}"</span>`;
    bubble.onclick = () => playVoice(m.data, m.mime);
  } else if (m.kind === 'file') {
    bubble.classList.add('file');
    bubble.innerHTML = `<span class="f-icon">📄</span><span class="f-name"></span>`;
    bubble.querySelector('.f-name').textContent = m.name || '文件';
    bubble.onclick = () => {
      if (m.url) { window.open(m.url, '_blank'); return; }
      const a = document.createElement('a');
      a.href = 'data:' + (m.mime || 'application/octet-stream') + ';base64,' + m.data;
      a.download = m.name || 'file';
      a.click();
    };
  }

  body.appendChild(bubble);
  row.appendChild(body);
  list.appendChild(row);
  // 已有头像的话直接显示图片
  const url = avatarUrl(m.from);
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    avatar.appendChild(img);
  }
}

function showImagePreview(src) {
  const overlay = document.createElement('div');
  overlay.className = 'img-preview';
  const img = document.createElement('img');
  img.src = src;
  overlay.appendChild(img);
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

// ================= 语音条播放 =================
let audioEl = null;
function playVoice(b64, mime) {
  if (audioEl) audioEl.pause();
  audioEl = new Audio('data:' + (mime || 'audio/webm') + ';base64,' + b64);
  audioEl.play();
}

// ================= 录音 =================
let isRecording = false;
function startRecording() {
  if (isRecording) return;
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
      isRecording = true;
      recStream = stream;
      recChunks = [];
      recStart = Date.now();
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        isRecording = false;
      };
      mediaRecorder.start();
      $('recordingOverlay').classList.remove('hidden');
      $('recTimer').textContent = '0:00';
      recTimerRaf = requestAnimationFrame(tickRecTimer);
    })
    .catch(() => toast('无法访问麦克风'));
}

function tickRecTimer() {
  if (!isRecording) return;
  const sec = Math.floor((Date.now() - recStart) / 1000);
  $('recTimer').textContent = `0:${String(sec).padStart(2, '0')}`;
  if (sec >= 60) { stopRecording(true); return; }
  recTimerRaf = requestAnimationFrame(tickRecTimer);
}

function stopRecording(sendIt = true) {
  if (!isRecording) return;
  cancelAnimationFrame(recTimerRaf);
  $('recordingOverlay').classList.add('hidden');
  const stream = recStream;
  mediaRecorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    recStream = null;
    isRecording = false;
    if (!sendIt) return;
    const dur = Math.max(1, Math.round((Date.now() - recStart) / 1000));
    const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = reader.result.split(',')[1];
      send({ type: 'file', kind: 'voice', name: 'voice.webm', data: b64, mime: mediaRecorder.mimeType || 'audio/webm', duration: dur });
    };
    reader.readAsDataURL(blob);
  };
  mediaRecorder.stop();
}

// ================= WebRTC 语音通话 =================
// ICE: 先 STUN 尝试 P2P 直连, 穿不过时用 TURN 中继(服务器转发, 保证通)
const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: 'turn:47.82.0.187:3478?transport=udp',
    username: 'love',
    credential: '0f46acd18fe61a4a',
  },
  {
    urls: 'turn:47.82.0.187:3478?transport=tcp',
    username: 'love',
    credential: '0f46acd18fe61a4a',
  },
];

const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

async function createPeer() {
  // 只用基础 ICE 配置, 兼容所有浏览器
  pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = (e) => {
    // 包含 null 候选 (end-of-candidates), 让对端知道可以提前协商 media
    send({ type: 'signal', signal: { type: 'ice', ice: e.candidate } });
  };
  pc.ontrack = (e) => {
    if (e.streams[0]) playRemoteAudio(e.streams[0]);
  };
  pc.oniceconnectionstatechange = () => {
    const s = pc && pc.iceConnectionState;
    if (s === 'failed' || s === 'disconnected') {
      // ICE 失败时尝试 ICE restart (最多 1 次)
      if (iceRestartCount < 1 && callState === 'talking') {
        iceRestartCount++;
        showCallUI('reconnecting', peerName);
        restartIce();
      } else if (s === 'failed') {
        endCall('通话中断');
      }
    } else if (s === 'connected' || s === 'completed') {
      iceRestartCount = 0; // 重置重试计数
      if (callState === 'reconnecting') showCallUI('talking', peerName);
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc && ['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      endCall('通话中断');
    }
  };
  return pc;
}

async function restartIce() {
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    send({ type: 'signal', signal: { type: 'offer', sdp: pc.localDescription, restart: true } });
  } catch (e) {
    endCall('重连失败');
  }
}

let remoteAudio = null;
// 移动端(尤其 iOS)要求音频播放由用户手势触发, 需在接听/拨号时预解锁
function unlockAudio() {
  if (!remoteAudio) {
    remoteAudio = new Audio();
    remoteAudio.style.display = 'none';
    document.body.appendChild(remoteAudio);
  }
  remoteAudio.muted = true;
  tryPlay(remoteAudio);
}
// play() 失败兜底: 下次任意点击再试一次(移动端常见)
function tryPlay(audio) {
  audio.play().then(() => {
    audio.muted = false;
    if (audio.srcObject) audio.play().catch(() => {});
  }).catch(() => {
    const retry = () => { try { audio.play(); } catch {} };
    document.addEventListener('click', retry, { once: true });
    document.addEventListener('touchstart', retry, { once: true });
  });
}
function playRemoteAudio(stream) {
  if (!remoteAudio) {
    remoteAudio = new Audio();
    remoteAudio.style.display = 'none';
    document.body.appendChild(remoteAudio);
  }
  remoteAudio.srcObject = stream;
  tryPlay(remoteAudio);
}

async function startCall() {
  if (callState !== 'idle') return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
  } catch {
    return toast('无法访问麦克风');
  }
  callState = 'calling';
  iceRestartCount = 0;
  pc = await createPeer();
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: 'call', action: 'invite' });
  send({ type: 'signal', signal: { type: 'offer', sdp: pc.localDescription } });
  showCallUI('calling', peerName);
}

async function handleCall(from, action) {
  if (action === 'invite') {
    if (callState !== 'idle') {
      // 忙线
      send({ type: 'call', action: 'busy' });
      return;
    }
    callState = 'ringing';
    pendingOffer = null;
    peerName = from;
    $('peerName').textContent = from;
    $('callAvatar').textContent = avatarOf(from);
    $('callTitle').textContent = from;
    showCallUI('ringing', from);
    $('callBtn').classList.add('ringing');
  } else if (action === 'busy') {
    endCall(from + ' 忙线中');
  } else if (action === 'accept') {
    if (callState === 'calling') {
      callState = 'talking';
      showCallUI('talking', peerName);
    }
  } else if (action === 'reject') {
    endCall('对方拒绝了通话');
  } else if (action === 'hangup') {
    endCall('通话已结束');
  }
}

function showCallUI(mode, name) {
  $('callOverlay').classList.remove('hidden');
  $('callTitle').textContent = mode === 'talking' ? `${name} 通话中` : name;
  $('callStatus').textContent =
    mode === 'calling' ? '等待对方接听…' :
    mode === 'ringing' ? '邀请你语音通话…' :
    mode === 'talking' ? '通话时长 0:00' :
    mode === 'reconnecting' ? '重新连接中…' : '';
  $('callReject').classList.toggle('hidden', mode === 'talking' || mode === 'reconnecting');
  $('callAccept').classList.toggle('hidden', mode !== 'ringing');
  $('callHangup').classList.toggle('hidden', mode === 'ringing' || mode === 'idle');
  $('callBtn').classList.remove('ringing');
  if (mode === 'talking' || mode === 'reconnecting') {
    callStartTime = callStartTime || Date.now();
    if (!callTimerRaf) callTimerRaf = requestAnimationFrame(tickCallTimer);
  }
}

function tickCallTimer() {
  if (callState !== 'talking') return;
  const sec = Math.floor((Date.now() - callStartTime) / 1000);
  $('callStatus').textContent = `通话时长 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  callTimerRaf = requestAnimationFrame(tickCallTimer);
}

function endCall(reason) {
  if (callState === 'idle') return;
  callState = 'idle';
  if (callTimerRaf) cancelAnimationFrame(callTimerRaf);
  callTimerRaf = null;
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  if (remoteAudio) { remoteAudio.srcObject = null; remoteAudio = null; }
  $('callOverlay').classList.add('hidden');
  $('callBtn').classList.remove('ringing');
  if (reason) toast(reason);
}

async function acceptCall() {
  if (callState !== 'ringing') return;
  if (!pendingOffer) { toast('连接未就绪，请重试'); return; }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
  } catch {
    return toast('无法访问麦克风');
  }
  callState = 'talking';
  iceRestartCount = 0;
  pc = await createPeer();
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  try {
    await pc.setRemoteDescription(pendingOffer.sdp);
  } catch {
    endCall('连接失败');
    return;
  }
  pendingOffer = null;
  // 补放暂存的 ICE 候选
  for (const c of pendingIce) { try { await pc.addIceCandidate(c); } catch {} }
  pendingIce = [];
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: 'signal', signal: { type: 'answer', sdp: pc.localDescription } });
  send({ type: 'call', action: 'accept' });
  showCallUI('talking', peerName);
}

async function handleSignal(from, signal) {
  if (!signal) return;
  if (signal.type === 'offer') {
    if (signal.restart) {
      // ICE restart: 对方重连, 我们生成 answer
      if (pc && (callState === 'talking' || callState === 'reconnecting')) {
        try {
          await pc.setRemoteDescription(signal.sdp);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send({ type: 'signal', signal: { type: 'answer', sdp: pc.localDescription } });
          showCallUI('reconnecting', peerName);
          toast('重新连接中…');
        } catch (e) {
          endCall('重连失败');
        }
      }
    } else if (callState === 'ringing') {
      pendingOffer = signal;
      // 已在响铃, 等用户接听
    } else if (callState === 'idle') {
      // 对方发 offer 但没收到 invite? 视为邀请
      handleCall(from, 'invite');
      pendingOffer = signal;
    }
  } else if (signal.type === 'answer') {
    if (pc && (callState === 'calling' || callState === 'reconnecting')) {
      await pc.setRemoteDescription(signal.sdp);
    }
  } else if (signal.type === 'ice') {
    if (pc && signal.ice !== undefined) {
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(signal.ice); } catch {}
      } else {
        pendingIce.push(signal.ice); // 远端描述未就绪, 暂存
      }
    }
  }
}

// ================= 事件绑定 =================
// 发送文字
function sendText() {
  const input = $('textInput');
  const text = input.value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  input.value = '';
  input.focus();
}
$('sendBtn').onclick = sendText;
$('textInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendText();
  else send({ type: 'typing' });
});

// 图片 / 文件(走 HTTP 上传, 聊天只传 URL)
$('imgBtn').onclick = () => $('imgPicker').click();
$('fileBtn').onclick = () => $('filePicker').click();

async function uploadFile(file) {
  const fd = new FormData();
  const ext = (file.name.match(/\.[^.]+$/) || ['.bin'])[0];
  const resp = await fetch('/api/upload', {
    method: 'POST',
    body: file,
    headers: { 'X-File-Ext': ext },
  });
  if (!resp.ok) throw new Error('upload failed');
  const { url } = await resp.json();
  return url;
}

async function readAndSend(file, kind) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return toast('文件不能超过 8MB');
  toast('上传中…');
  try {
    let toUpload = file;
    if (kind === 'image' && file.type.startsWith('image/')) {
      toUpload = await compressImage(file); // 压缩图片
    }
    const url = await uploadFile(toUpload);
    send({
      type: 'file',
      kind,
      name: file.name,
      url,
      mime: toUpload.type || 'application/octet-stream',
    });
  } catch {
    toast('上传失败');
  }
}

// 图片压缩: 最长边 1200px, JPEG 质量 0.82 — 照片 5MB -> 300KB
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const maxSide = 1200;
      let { width, height } = img;
      if (width > maxSide || height > maxSide) {
        const ratio = maxSide / Math.max(width, height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error('compress failed'));
        const name = file.name.replace(/\.[^.]+$/, '.jpg');
        resolve(new File([blob], name, { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load failed')); };
    img.src = url;
  });
}

// 头像: 居中裁成正方形再压缩
function compressToSquare(file, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const side = Math.min(size, img.width, img.height);
      const canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
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
$('imgPicker').addEventListener('change', (e) => {
  readAndSend(e.target.files[0], 'image');
  e.target.value = '';
});
$('filePicker').addEventListener('change', (e) => {
  readAndSend(e.target.files[0], 'file');
  e.target.value = '';
});

// 表情
$('emojiBtn').onclick = () => {
  const emojis = ['❤️', '😊', '😘', '🥰', '😭', '😮', '🤔', '👏', '🌙', '☀️'];
  const e = emojis[Math.floor(Math.random() * emojis.length)];
  $('textInput').value += e;
  $('textInput').focus();
};

// 录音(按住说话) — 兼容触屏+鼠标, 防止双触发
const micBtn = $('micBtn');
let recPointerActive = false; // 防止 touch 和 mouse 同时触发

function recDown(e) {
  e.preventDefault();
  if (recPointerActive) return;
  recPointerActive = true;
  startRecording();
}
function recUp(e) {
  e.preventDefault();
  if (!recPointerActive) return;
  recPointerActive = false;
  stopRecording(true);
}
function recCancel(e) {
  e.preventDefault();
  if (!recPointerActive) return;
  recPointerActive = false;
  stopRecording(false);
}

micBtn.addEventListener('touchstart', recDown, { passive: false });
micBtn.addEventListener('touchend', recUp, { passive: false });
micBtn.addEventListener('touchcancel', recCancel, { passive: false });
micBtn.addEventListener('mousedown', recDown);
micBtn.addEventListener('mouseup', recUp);
micBtn.addEventListener('mouseleave', recCancel);

// 上滑取消: 触摸结束时在覆盖层上移除 = 取消
$('recordingOverlay').addEventListener('touchmove', (e) => {
  const r = $('recordingOverlay').getBoundingClientRect();
  const t = e.touches[0];
  if (t.clientY < r.top) {
    $('recordingOverlay').classList.add('cancel');
  } else {
    $('recordingOverlay').classList.remove('cancel');
  }
});
$('recordingOverlay').addEventListener('touchend', (e) => {
  const r = $('recordingOverlay').getBoundingClientRect();
  const t = e.changedTouches[0];
  stopRecording(t.clientY >= r.top);
});

// 通话按钮
$('callBtn').onclick = () => {
  unlockAudio(); // 用户手势解锁音频(移动端必须)
  if (callState === 'idle') startCall();
};
$('callAccept').onclick = () => {
  unlockAudio(); // 用户手势解锁音频(移动端必须)
  $('callOverlay').classList.add('hidden');
  acceptCall();
};
$('callReject').onclick = () => {
  send({ type: 'call', action: 'reject' });
  endCall('已拒绝');
};
$('callHangup').onclick = () => {
  send({ type: 'call', action: 'hangup' });
  endCall();
};

// 返回
$('backBtn').onclick = () => {
  manualClose = true;
  if (ws) ws.close();
  location.reload();
};

// ================= 设置: 头像 / 背景 =================
$('settingsBtn').onclick = () => $('settingsOverlay').classList.remove('hidden');
$('settingsClose').onclick = () => $('settingsOverlay').classList.add('hidden');
$('pickAvatarBtn').onclick = () => $('avatarPicker').click();
$('pickBgBtn').onclick = () => $('bgPicker').click();

$('avatarPicker').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  toast('上传头像中…');
  try {
    const small = await compressToSquare(f, 320);
    const url = await uploadFile(small);
    send({ type: 'setAvatar', url });
  } catch {
    toast('头像上传失败');
  }
});

$('bgPicker').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  toast('上传背景中…');
  try {
    const small = await compressImage(f);
    const url = await uploadFile(small);
    localStorage.setItem('lovechat.bg', url);
    applyBg();
  } catch {
    toast('背景上传失败');
  }
});
$('resetBgBtn').onclick = () => {
  localStorage.removeItem('lovechat.bg');
  applyBg();
};

function applyBg() {
  const url = localStorage.getItem('lovechat.bg');
  const list = $('msgList');
  list.classList.toggle('bg-custom', !!url);
  if (url) list.style.setProperty('--bg-url', `url('${url}')`);
}
applyBg();

// ================= 动态 =================
function showMoments(show) {
  $('momentsView').classList.toggle('hidden', !show);
  $('msgList').classList.toggle('hidden', show);
  $('inputbar').classList.toggle('hidden', show);
  if (show) renderMoments();
}
$('momentsBtn').onclick = () => showMoments($('momentsView').classList.contains('hidden'));

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
          <div class="moment-author"></div>
          <div class="moment-time">${fmtTime(mo.at)}</div>
        </div>
      </div>
      ${mo.text ? '<div class="moment-text-body"></div>' : ''}
      ${mo.images && mo.images.length ? '<div class="moment-grid"></div>' : ''}
      <div class="moment-like${mo.likes && mo.likes.includes(myName) ? ' on' : ''}">
        <span class="heart">❤️</span><span class="like-count"></span>
      </div>`;
    card.querySelector('.moment-author').textContent = mo.author;
    // 作者头像
    const av = card.querySelector('.moment-head .avatar');
    const url = avatarUrl(mo.author);
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      av.appendChild(img);
    }
    if (mo.text) card.querySelector('.moment-text-body').textContent = mo.text;
    if (mo.images && mo.images.length) {
      const grid = card.querySelector('.moment-grid');
      for (const u of mo.images) {
        const img = document.createElement('img');
        img.src = u;
        img.loading = 'lazy';
        img.onclick = () => showImagePreview(u);
        grid.appendChild(img);
      }
    }
    card.querySelector('.like-count').textContent = mo.likes && mo.likes.length ? mo.likes.length : '点赞';
    card.querySelector('.moment-like').onclick = () => send({ type: 'momentLike', id: mo.id });
    list.appendChild(card);
  }
}

// 发布框选图(压缩后上传, 最多 4 张)
$('momentPicBtn').onclick = () => $('momentPicker').click();
$('momentPicker').addEventListener('change', async (e) => {
  const files = [...e.target.files].slice(0, 4 - momentImages.length);
  e.target.value = '';
  if (!files.length) return;
  toast('上传图片中…');
  for (const f of files) {
    try {
      const small = await compressImage(f);
      const url = await uploadFile(small);
      momentImages.push(url);
      renderMomentPics();
    } catch {
      toast('图片上传失败');
    }
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
    w.onclick = () => {
      momentImages.splice(i, 1);
      renderMomentPics();
    };
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

// ================= 入口 =================
function enter() {
  const name = $('nameInput').value.trim() || '对方';
  const room = $('roomInput').value.trim();
  if (!room) { toast('请填写房间名'); return; }
  if (!/^[A-Za-z0-9_一-龥-]{1,32}$/.test(room)) { toast('房间名不合法'); return; }
  myName = name;
  roomId = /^[A-Za-z0-9_-]+$/.test(room) ? room : hashRoom(room);
  localStorage.setItem('lovechat.name', myName);
  localStorage.setItem('lovechat.room', room);
  localStorage.setItem('lovechat.pass', $('passInput').value.trim());
  moments = [];
  showMoments(false);

  $('lobby').classList.add('hidden');
  $('app').classList.remove('hidden');
  connect();
}

function hashRoom(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return 'r' + h1.toString(36) + h2.toString(36);
}

$('enterBtn').onclick = enter;
$('roomInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('roomInput').focus(); });

$('nameInput').value = localStorage.getItem('lovechat.name') || '';
$('roomInput').value = localStorage.getItem('lovechat.room') || '';

// 断线自动重连 + 后台恢复
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && roomId) {
    if (!ws || ws.readyState === WebSocket.CLOSED) { reconnectAttempt = 0; connect(); }
  }
});
