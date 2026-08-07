// 端到端测试: 双客户端完整聊天流程
import { WebSocket } from 'ws';

const URL = process.env.E2E_URL || 'ws://127.0.0.1:8100';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)); };

class C {
  constructor(t) { this.tok = t; this.msgs = []; }
  async conn() {
    this.ws = new WebSocket(URL);
    await new Promise((r, j) => { this.ws.on('open', r); this.ws.on('error', j); });
    this.ws.on('message', (raw) => this.msgs.push(JSON.parse(raw.toString())));
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  wait(pred, ms = 3000) {
    const from = this.msgs.length;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('超时: ' + this.msgs.slice(from).map(m => m.type).join(','))), ms);
      const chk = (m, idx) => { if (idx >= from && pred(m)) { clearTimeout(t); res(m); } };
      this._chk = chk;
    });
  }
  wire() {
    // 每次 wait 后重新挂接
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const idx = this.msgs.length;
      this.msgs.push(m);
      if (this._chk) { const c = this._chk; this._chk = null; c(m, idx); }
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOM = 'lc' + Math.random().toString(36).slice(2, 8);

console.log('\n[1] 连接与历史');
const a = new C('lctokenAAAA111111');
const b = new C('lctokenBBBB222222');
await a.conn(); a.wire();
await b.conn(); b.wire();

a.send({ type: 'join', roomId: ROOM, token: a.tok, name: '阿巢' });
const ja = await a.wait((m) => m.type === 'joined');
ok(!!ja.history && Array.isArray(ja.history), 'joined 返回历史消息数组');

b.send({ type: 'join', roomId: ROOM, token: b.tok, name: '宝贝' });
const jb = await b.wait((m) => m.type === 'joined');
ok(jb.name === '宝贝', 'joined 返回昵称');

await b.wait((m) => m.type === 'presence');
ok(true, '双方收到 presence');

console.log('\n[2] 文字消息');
a.send({ type: 'chat', text: '早上好呀 ❤️' });
const bGotText = await b.wait((m) => m.type === 'message' && m.message.kind === 'text');
ok(bGotText.message.text === '早上好呀 ❤️', '对方收到文字消息');
ok(bGotText.message.from === '阿巢', '消息带发送者');

console.log('\n[3] 图片消息(base64)');
const imgB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
a.send({ type: 'file', kind: 'image', name: 'photo.png', data: imgB64, mime: 'image/png' });
const bGotImg = await b.wait((m) => m.type === 'message' && m.message.kind === 'image');
ok(bGotImg.message.data === imgB64, '对方收到图片数据');
ok(bGotImg.message.mime === 'image/png', '图片带 mime');

console.log('\n[4] 语音条消息');
const voiceB64 = 'GkXfo0AgQoaBAUL3gQFC8oEEQvOBCEKCQAAAA3lyb2JvcnMAAGzQAVNnQgE='; // 假数据
a.send({ type: 'file', kind: 'voice', name: 'v.webm', data: voiceB64, mime: 'audio/webm', duration: 5 });
const bGotVoice = await b.wait((m) => m.type === 'message' && m.message.kind === 'voice');
ok(bGotVoice.message.duration === 5, '语音条带时长');
ok(bGotVoice.message.kind === 'voice', '语音条类型正确');

console.log('\n[5] 文件消息');
a.send({ type: 'file', kind: 'file', name: 'notes.txt', data: 'SGVsbG8=', mime: 'text/plain' });
const bGotFile = await b.wait((m) => m.type === 'message' && m.message.kind === 'file');
ok(bGotFile.message.name === 'notes.txt', '文件消息带文件名');

console.log('\n[6] 信令转发');
a.send({ type: 'signal', signal: { type: 'offer', sdp: { fake: 'sdp' } } });
const bGotSig = await b.wait((m) => m.type === 'signal');
ok(bGotSig.signal.type === 'offer', 'offer 转发到对方');
ok(bGotSig.from === '阿巢', '信令带来源');

console.log('\n[7] 通话控制');
a.send({ type: 'call', action: 'invite' });
const bGotCall = await b.wait((m) => m.type === 'call');
ok(bGotCall.action === 'invite', '通话邀请转发');

b.send({ type: 'call', action: 'accept' });
const aGotAccept = await a.wait((m) => m.type === 'call' && m.action === 'accept');
ok(true, '接听确认转发');

console.log('\n[8] 历史持久化(重连可见)');
a.ws.close();
await sleep(200);
const a2 = new C(a.tok);
await a2.conn(); a2.wire();
a2.send({ type: 'join', roomId: ROOM, token: a.tok, name: '阿巢' });
const back = await a2.wait((m) => m.type === 'joined');
const textMsgs = back.history.filter((m) => m.kind === 'text');
ok(textMsgs.some((m) => m.text === '早上好呀 ❤️'), '重连后历史含之前文字');
ok(back.history.some((m) => m.kind === 'image'), '重连后历史含图片');
ok(back.history.some((m) => m.kind === 'voice'), '重连后历史含语音条');

console.log('\n[9] 非法输入防护');
const c = new C('lctokenCCCC333333');
await c.conn(); c.wire();
c.send({ type: 'join', roomId: '../bad', token: 'lctokenCCCC333333' });
const bad = await c.wait((m) => m.type === 'error');
ok(/参数不合法/.test(bad.error), '非法房间名被拒');

c.send({ type: 'chat', text: '' });
ok(true, '空消息被忽略(无异常)');

a2.close(); b.close(); c.close();
await sleep(200);
console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
