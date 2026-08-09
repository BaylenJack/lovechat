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
let autoPlayVoice = true; // 刚发出去的语音条自动播放一次(像微信)

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
      console.warn('[ws error]', m.error, m); // 定位服务器错误来源
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
  // DocumentFragment 批量插入, 100 条消息只触发 1 次重排
  const frag = document.createDocumentFragment();
  for (const m of msgs) renderMessage(m, true, frag);
  $('msgList').appendChild(frag);
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
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    el.appendChild(img);
  } else {
    el.textContent = '?';
  }
  // 通话界面同步头像
  $('callAvatar').innerHTML = '';
  if (url) {
    const callImg = document.createElement('img');
    callImg.src = url;
    callImg.alt = '';
    $('callAvatar').appendChild(callImg);
  }
  // 设置面板里的我的头像预览
  const my = avatarUrl(myName);
  $('myAvatarPrev').style.backgroundImage = my ? `url('${my}')` : '';
  $('myAvatarPrev').style.backgroundSize = 'cover';
}

function renderMessage(m, isHistory = false, container = null) {
  const mine = m.from === myName;
  const parent = container || $('msgList');
  const row = document.createElement('div');
  row.className = 'msg ' + (mine ? 'mine' : 'peer');

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.dataset.name = m.from;
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
    bubble.onclick = () => {
      const a = playVoice(m, true);
      if (a) {
        bubble.classList.add('playing');
        a.onended = () => bubble.classList.remove('playing');
        a.onerror = () => { bubble.classList.remove('playing'); toast('语音播放失败'); };
      }
    };
    // 我的新语音(刚发出去的)自动播放 — 本地播放不依赖对端
    if (!isHistory && mine && m.url && autoPlayVoice) {
      autoPlayVoice = false;
      const a = playVoice(m, true);
      if (a) { bubble.classList.add('playing'); a.onended = () => bubble.classList.remove('playing'); }
    }
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
  parent.appendChild(row);
  // 已有头像直接显示图, 没头像时回退到首字(避免空白)
  const url = avatarUrl(m.from);
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    avatar.appendChild(img);
  } else {
    avatar.textContent = avatarOf(m.from);
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
// 播放走 /api/file/ 流式(HTTP 直接播放, 不整包进内存); 兼容旧消息的 base64 data
let audioEl = null;
function playVoice(m, auto = false) {
  if (audioEl) { audioEl.pause(); audioEl = null; }
  const src = m.url ? m.url : ('data:' + (m.mime || 'audio/webm') + ';base64,' + (m.data || ''));
  if (!src) return;
  audioEl = new Audio(src);
  if (auto) audioEl.play();
  return audioEl;
}

// ================= 录音 =================
let isRecording = false;
function startRecording() {
  if (isRecording) return;
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
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
      isRecording = true; // start 成功后才标记, 避免异常时 UI 卡死
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
    // 语音走 HTTP 上传(服务端流式播放), 不再整包 base64 走 WS
    toast('上传语音…');
    uploadFile(new File([blob], 'voice.webm', { type: blob.type }))
      .then((url) => {
        send({ type: 'file', kind: 'voice', name: 'voice.webm', url, mime: blob.type || 'audio/webm', duration: dur });
        if (autoPlayVoice) playVoice({ url, mime: blob.type || 'audio/webm' }, true);
      })
      .catch(() => toast('语音上传失败'));
  };
  mediaRecorder.stop();
}

// ================= WebRTC 语音通话 =================
// ICE: 先 STUN 尝试 P2P 直连(自建 STUN 优先, 国内可达), 穿不过时用 TURN 中继
const iceServers = [
  { urls: 'stun:47.82.0.187:3478' },
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
// 安卓 Chrome 需要激活 AudioContext 才会输出媒体轨(否则 addTrack 是静音轨)
let audioCtx = null;
function ensureAudioContext() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* 激活失败不阻塞通话 */ }
}
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
    ensureAudioContext(); // 安卓 Chrome 必须, 否则发出的轨道无声
    localStream.getAudioTracks().forEach((t) => { t.enabled = true; });
  } catch {
    return toast('无法访问麦克风');
  }
  callState = 'calling';
  iceRestartCount = 0;
  callStartTime = 0; // 新通话从 0 开始计时
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
  // 通知对方挂断(ICE 断开等场景之前漏发, 对方会卡在通话 UI)
  send({ type: 'call', action: 'hangup' });
  callState = 'idle';
  callStartTime = 0; // 挂断后重置, 下次通话从 0 开始
  if (callTimerRaf) cancelAnimationFrame(callTimerRaf);
  callTimerRaf = null;
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  if (remoteAudio) { remoteAudio.srcObject = null; remoteAudio = null; }
  if (pendingIce) pendingIce.length = 0; // 清空旧候选, 避免泄漏到下次通话
  $('callOverlay').classList.add('hidden');
  $('callBtn').classList.remove('ringing');
  if (reason) toast(reason);
}

async function acceptCall() {
  if (callState !== 'ringing') return;
  if (!pendingOffer) { toast('连接未就绪，请重试'); return; }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
    ensureAudioContext(); // 安卓 Chrome 必须, 否则发出的轨道无声
    localStream.getAudioTracks().forEach((t) => { t.enabled = true; });
  } catch {
    return toast('无法访问麦克风');
  }
  callState = 'talking';
  iceRestartCount = 0;
  callStartTime = 0; // 新通话从 0 开始计时
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
      // 补放暂存的 ICE 候选(响铃/呼叫阶段收到但 pc 未就绪)
      for (const c of pendingIce) { try { await pc.addIceCandidate(c); } catch {} }
      pendingIce = [];
    }
  } else if (signal.type === 'ice') {
    if (signal.ice === undefined) return;
    if (pc && pc.remoteDescription) {
      try { await pc.addIceCandidate(signal.ice); } catch {}
    } else {
      pendingIce.push(signal.ice); // pc 未创建或远端描述未就绪都暂存, 稍后补放
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
// typing 提示 2s debounce, 避免高频广播(首次按键立即发, 之后 2s 窗口内合并)
let typingDebounce = null;
$('textInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(typingDebounce); sendText(); return; }
  if (!typingDebounce) send({ type: 'typing' });
  clearTimeout(typingDebounce);
  typingDebounce = setTimeout(() => { typingDebounce = null; }, 2000);
});

// 图片 / 文件(走 HTTP 上传, 聊天只传 URL)
$('imgBtn').onclick = () => $('imgPicker').click();
$('fileBtn').onclick = () => $('filePicker').click();

async function uploadFile(file) {
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
const EMOJIS = ['❤️', '😊', '😘', '🥰', '😭', '😮', '🤔', '👏', '🌙', '☀️',
  '😂', '🤣', '😍', '😜', '🤗', '😇', '😴', '🥺', '😳', '🔥',
  '💔', '💖', '💝', '💕', '✨', '🌟', '🎉', '🍀', '🌹', '🐱',
  '🍰', '☕', '🎵', '💤', '🙏', '👍', '💪', '👋', '🫶', '🥹'];
function toggleEmojiPanel() {
  const panel = $('emojiPanel');
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  if (!panel.dataset.built) {
    panel.dataset.built = '1';
    for (const e of EMOJIS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'emoji-cell';
      b.textContent = e;
      b.onclick = () => {
        $('textInput').value += e;
        $('textInput').focus();
        panel.classList.add('hidden');
      };
      panel.appendChild(b);
    }
  }
  panel.classList.remove('hidden');
}
$('emojiBtn').onclick = (e) => { e.stopPropagation(); toggleEmojiPanel(); };
// 点击面板外部/发送后收起
document.addEventListener('click', (e) => {
  const panel = $('emojiPanel');
  if (!panel.classList.contains('hidden') && !panel.contains(e.target)) panel.classList.add('hidden');
});
$('sendBtn').onclick = () => $('emojiPanel').classList.add('hidden');

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
$('callHangup').onclick = () => endCall();

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
  if (!f.type.startsWith('image/')) return toast('请选择图片');
  try {
    // 裁剪器: 微信式正方形选区, 可拖动/缩放
    const cropped = await openCropper(f);
    if (!cropped) return; // 用户取消
    const small = await compressToSquare(cropped, 320);
    const url = await uploadFile(small);
    send({ type: 'setAvatar', url });
    toast('头像已更新');
  } catch {
    toast('头像上传失败');
  }
});

// ---------- 头像裁剪器 ----------
function openCropper(file) {
  return new Promise((resolve) => {
    const objUrl = URL.createObjectURL(file);
    const stage = $('cropStage');
    const img = $('cropImg'); // 直接加载到 DOM 元素, 否则界面不显示图
    const box = $('cropBox');
    const overlay = $('cropOverlay');
    let state = { x: 0, y: 0, side: 0, imgW: 0, imgH: 0, dispW: 0, dispH: 0 };
    let drag = null; // { mode: 'move'|'grip', startX, startY, orig }
    let resolveFn = null;

    const fit = () => {
      // 长宽比 > 2 时 cover(铺满, 有裁剪); 否则 contain(留白, 完整可见)
      const sr = stage.clientWidth / stage.clientHeight;
      const ir = img.naturalWidth / img.naturalHeight;
      let dispW, dispH;
      const useCover = ir > 2 || ir < 0.5;
      if (useCover) {
        if (ir > 1) { dispH = stage.clientHeight; dispW = dispH * ir; }
        else { dispW = stage.clientWidth; dispH = dispW / ir; }
      } else if (ir > sr) { dispW = stage.clientWidth; dispH = dispW / ir; }
      else { dispH = stage.clientHeight; dispW = dispH * ir; }
      state = { ...state, imgW: img.naturalWidth, imgH: img.naturalHeight, dispW, dispH, cover: useCover };
      img.style.width = dispW + 'px';
      img.style.height = dispH + 'px';
      img.style.left = (stage.clientWidth - dispW) / 2 + 'px';
      img.style.top = (stage.clientHeight - dispH) / 2 + 'px';
      const side = Math.max(48, Math.min(dispW, dispH) - 4);
      state.side = side;
      state.x = (dispW - side) / 2;
      state.y = (dispH - side) / 2;
      applyBox();
    };

    const applyBox = () => {
      const left = (stage.clientWidth - state.dispW) / 2 + state.x;
      const top = (stage.clientHeight - state.dispH) / 2 + state.y;
      box.style.left = left + 'px';
      box.style.top = top + 'px';
      box.style.width = state.side + 'px';
      box.style.height = state.side + 'px';
    };

    // 取裁剪框在原始图片里的坐标
    const cropRect = () => {
      const scale = state.imgW / state.dispW;
      return {
        sx: Math.max(0, state.x * scale),
        sy: Math.max(0, state.y * scale),
        s: Math.min(state.side * scale, state.imgW - Math.max(0, state.x * scale), state.imgH - Math.max(0, state.y * scale)),
      };
    };

    const inBounds = (x, y) => x >= 0 && y >= 0 && x + state.side <= state.dispW && y + state.side <= state.dispH;

    const onMove = (cx, cy) => {
      if (!drag) return;
      const dx = cx - drag.startX, dy = cy - drag.startY;
      if (drag.mode === 'move') {
        const nx = Math.min(Math.max(drag.orig.x + dx, 0), state.dispW - state.side);
        const ny = Math.min(Math.max(drag.orig.y + dy, 0), state.dispH - state.side);
        state.x = nx; state.y = ny;
      } else { // 右下角手柄缩放(保持正方形)
        const side = Math.min(
          Math.max(drag.orig.side + Math.max(dx, dy), 48),
          Math.min(state.dispW - drag.orig.x, state.dispH - drag.orig.y),
        );
        state.side = side;
      }
      applyBox();
    };

    const onUp = () => { drag = null; };

    const bind = (el, onDown) => {
      el.addEventListener('touchstart', onDownTouch, { passive: false });
      el.addEventListener('mousedown', onDownMouse);
      function onDownTouch(e) { e.preventDefault(); const t = e.touches[0]; onDown(t.clientX, t.clientY); }
      function onDownMouse(e) { e.preventDefault(); onDown(e.clientX, e.clientY); }
      return [el, onDownTouch, onDownMouse];
    };
    // move/up 绑 document: 拖动中指针离开选框也不断
    function onTouchMove(e) {
      if (!drag) return;
      e.preventDefault();
      const t = e.touches[0];
      onMove(t.clientX, t.clientY);
    }
    function onMouseMove(e) { if (drag) onMove(e.clientX, e.clientY); }
    const bound = [];
    bound.push(bind(box, (cx, cy) => {
      if (cx > box.offsetLeft + box.offsetWidth - 24 && cy > box.offsetTop + box.offsetHeight - 24) {
        drag = { mode: 'grip', startX: cx, startY: cy, orig: { ...state } };
      } else {
        drag = { mode: 'move', startX: cx, startY: cy, orig: { ...state } };
      }
    }));
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onUp);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onUp);

    const cleanup = () => {
      URL.revokeObjectURL(objUrl);
      overlay.classList.add('hidden');
      for (const entry of bound) {
        const [el, t, m] = entry;
        el.removeEventListener('touchstart', t);
        el.removeEventListener('mousedown', m);
      }
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onUp);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onUp);
      drag = null;
    };

    overlay.classList.remove('hidden');
    resolveFn = resolve;
    const confirmBtn = $('cropConfirm');
    confirmBtn.disabled = true; // 图片加载完成前不可确认
    let downgraded = false; // 是否已做过大图降级
    img.onload = () => {
      // 大图降级: iOS 原图(4800万像素)会超出 canvas 上限, 先等比缩到 2000px 内
      if (!downgraded && (img.naturalWidth > 2000 || img.naturalHeight > 2000)) {
        downgraded = true;
        const scale = 2000 / Math.max(img.naturalWidth, img.naturalHeight);
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        try {
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        } catch {
          toast('图片过大，处理失败');
          cleanup();
          resolveFn(false);
          return;
        }
        c.toBlob((blob) => {
          if (!blob) { toast('图片处理失败'); cleanup(); resolveFn(false); return; }
          img.src = URL.createObjectURL(blob); // 重新触发 onload, 走正常 fit()
        }, 'image/jpeg', 0.9);
        return;
      }
      fit();
      confirmBtn.disabled = false;
    };
    img.onerror = () => {
      toast('图片加载失败，请换一张');
      cleanup();
      resolveFn(false);
    };
    img.src = objUrl;

    $('cropCancel').onclick = () => { cleanup(); resolveFn(false); };
    $('cropConfirm').onclick = () => {
      const { sx, sy, s } = cropRect();
      if (s < 8) return toast('选区太小');
      let canvas;
      try {
        canvas = document.createElement('canvas');
        canvas.width = s; canvas.height = s;
        canvas.getContext('2d').drawImage(img, sx, sy, s, s, 0, 0, s, s);
      } catch {
        cleanup();
        resolveFn(false);
        return toast('图片处理失败');
      }
      canvas.toBlob((blob) => {
        if (!blob) { cleanup(); resolveFn(false); return toast('裁剪失败'); }
        cleanup();
        resolveFn(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.9);
    };
  });
}

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
        <div class="avatar"></div>
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
    // 作者头像: 有 URL 用图, 没 URL 用首字
    const av = card.querySelector('.moment-head .avatar');
    const url = avatarUrl(mo.author);
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      av.appendChild(img);
    } else {
      av.textContent = avatarOf(mo.author);
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
