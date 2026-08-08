# LoveChat 语音通话优化 v3.1

日期：2026-08-09
状态：已确认（核心 4 项）

## 目标

提升 WebRTC 通话的连接速度和稳定性，目标：
- 连接建立时间缩短 30-50%
- 偶发失败能自动重试恢复
- 多数通话走 STUN/P2P（节省 TURN 中继带宽）

## 改动范围

只改 `public/app.js`，不影响后端、不影响 UI、不影响数据。

## 改动 1：ICE 配置优化

### 当前
```js
pc = new RTCPeerConnection({ iceServers });
```
没指定任何 ICE 策略、候选池大小、bundle policy。

### 目标
```js
pc = new RTCPeerConnection({
  iceServers,
  iceTransportPolicy: 'all',           // 优先 P2P, TURN 兜底
  iceCandidatePoolSize: 10,            // 预收集候选
  bundlePolicy: 'max-bundle',          // RTP+RTCP 单端口
  rtcpMuxPolicy: 'require',            // 强制 RTP/RTCP 复用
  sdpSemantics: 'unified-plan'
});
```

### 收益
- 连接协商快 30-50%（候选池预填）
- 减少防火墙穿透失败（单端口）
- 现代 Chrome 默认就是 unified-plan，但显式声明保险

## 改动 2：音频约束（getUserMedia）

### 当前
```js
localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
```

### 目标
```js
localStream = await navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: 48000,           // 移动端 48kHz 主流采样率
    channelCount: 1,             // 单声道, 省带宽
    latency: 0,                  // 提示浏览器最低延迟
    voiceIsolation: true         // iOS 15+, 语音增强
  }
});
```

### 收益
- 回声/噪音明显改善
- 延迟降低（最低延迟模式）

## 改动 3：双重 ICE 策略（先 STUN/P2P，失败后 TURN）

### 当前
- 创建 PC 时直接用包含 TURN 的 iceServers
- 失败就 `endCall`

### 目标
第一次协商用 `iceTransportPolicy: 'relay'` 不行——更聪明的做法是：

**实现方案 A（简单）**：保持现在 iceServers，但增加 **ICE 状态检测 + 重新协商**

```js
pc.oniceconnectionstatechange = () => {
  const state = pc.iceConnectionState;
  if (state === 'failed' || state === 'disconnected') {
    // 触发重连
    restartIce();
  }
}

async function restartIce() {
  if (iceRestartCount >= 1) return;  // 只重试 1 次
  iceRestartCount++;
  const offer = await pc.createOffer({ iceRestart: true });
  await pc.setLocalDescription(offer);
  send({ type: 'signal', signal: { type: 'offer', sdp: pc.localDescription, restart: true } });
}
```

### 实现方案 B（更激进）**：根据网络条件动态选
- 先纯 STUN（不配 TURN），失败 → 自动切换到含 TURN
- 代码量更大，先不做

**选 A**。

## 改动 4：ICE 失败自动重试

### 当前
- ICE 失败 → 通话直接挂断
- 用户需重新拨号

### 目标
- ICE 进入 `failed` 状态时，**自动重试 1 次**（ICE restart）
- 重试期间 UI 显示"重新连接中…"
- 重试成功 → 恢复通话
- 重试仍失败 → 才挂断

### UI 反馈
在 `showCallUI` 增加 `mode='reconnecting'`，显示：
- "重新连接中…" 状态文字
- 隐藏接听/拒绝按钮，只保留挂断

## 改动 5（顺手）：处理 end-of-candidates

### 当前
`onicecandidate` 只在 `e.candidate` 非空时转发，但**没有把 `null` candidate 也转发**（end-of-candidates 标记），对方可能以为"还有候选没到"而空等。

### 目标
```js
pc.onicecandidate = (e) => {
  send({ type: 'signal', signal: { type: 'ice', ice: e.candidate || null } });
};
```

让对方知道"候选收集完了"，可以提前开始 media 流协商。

## 改动 6（顺手）：音频 play() 重试机制

### 当前
`remoteAudio.play()` 单次尝试，失败就静默。

### 目标
```js
function tryPlay(audio) {
  audio.play().catch(() => {
    // 移动端可能需要再次手势触发, 监听一次点击重试
    const retry = () => {
      audio.play().catch(() => {});
      document.removeEventListener('click', retry);
    };
    document.addEventListener('click', retry, { once: true });
  });
}
```

### 收益
第一次 unlock 失败的话，下次任意点击会自动恢复播放。

## 不改的事

- ❌ 移除 TURN 凭据（用户没选此项，留作未来工作）
- ❌ 媒体质量统计
- ❌ WS 重连信令缓存

## 验证

### 功能
- 双客户端通话：连接速度提升
- 模拟断网（手机切飞行模式 5 秒再回）：自动恢复
- 跨网络（一方 4G、一方 WiFi）通话正常

### 测试
新增 `test/webrtc-test.mjs`（Node + ws 模拟），验证 ICE restart 信令流程。

### 回归
- 通话 UI、接听/挂断、扬声器切换不受影响
- 房间/动态/头像功能不受影响

## 文件改动清单

- `public/app.js`：~30 行改动，新增 `iceRestartCount`、`restartIce()`、`tryPlay()`，`createPeer` 和 `startCall`/`acceptCall` 微调
- `test/webrtc-test.mjs`：新增（可选）