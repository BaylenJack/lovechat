# LoveChat v2 设计 — 密码 / 头像 / 背景 / 动态

日期：2026-08-08
状态：已确认（用户批准）

## 目标

在现有双人聊天（文字/图片/文件/语音条/语音通话）基础上新增：

1. **房间密码** — 首个进入者设密码，之后进房间需验证
2. **头像** — 上传图片，双方可见（消息、顶栏、通话、动态）
3. **聊天背景** — 上传图片，仅自己可见（localStorage）
4. **动态** — 图文动态 + 点赞（存服务端，双人可见）

## 设计约束

- 零新依赖（密码哈希用 Node 内置 `crypto`）
- 图片全部复用现有 `/api/upload` + 客户端压缩通道
- 保持"两个人"的极简定位，不引入登录体系

## 1. 房间密码

### 进入流程（服务端自适应）

| 房间状态 | 用户填密码 | 结果 |
|---|---|---|
| 无密码 | 留空 | 直接进入 |
| 无密码 | 填了 | 设为房间密码（哈希存储） |
| 有密码 | 正确 | 进入 |
| 有密码 | 错误 | `error: '密码错误'`，前端留在大厅 |

### 存储

- `store.rooms[roomId].passhash`：sha256(password + roomId) 十六进制
- 只存哈希，不存明文；密码为空字符串或只有空格的视为未设

### 协议

- `join` 消息新增字段 `password`（可省略）
- 验证失败回 `{ type: 'error', error: '密码错误' }`

## 2. 头像（双方可见）

### 存储

- `store.rooms[roomId].users`：`{ [name]: avatarUrl }`
- 头像 URL 复用 `/api/file/xxx.ext`

### 协议

- `joined` 响应新增 `avatars: { name → url }`
- `setAvatar` 消息：`{ type:'setAvatar', url }` → 服务端记录并向房间广播 `{ type:'avatar', name, url }`
- 历史消息的渲染用"名字 → 当前头像"映射（换头像后历史消息显示新头像）

### 前端

- 设置面板里选择图片 → 压缩（复用 compressImage，320px 正方形）→ 上传 → 发 `setAvatar`
- 所有头像显示点（消息行、顶栏、通话、动态）统一走 `avatarUrl(name)` 函数，无头像回退首字母

## 3. 聊天背景（仅自己可见）

- 设置面板选择图片 → 压缩 → 上传 → URL 存 `localStorage['lovechat.bg']` → 应用到 `.app` 背景
- 不发消息，对方不可见；不涉及服务端状态

## 4. 动态（图文 + 点赞）

### 存储

- `store.rooms[roomId].moments`：最多 200 条，`[{ id, author, text, images: [url...], at, likes: [name...] }]`
- `text` ≤ 1000 字，`images` ≤ 4 张

### 协议

- `joined` 响应新增 `moments`（最近 50 条）
- `moment` 消息：`{ type:'moment', text, images:[url...] }` → 服务端生成记录、存储、广播 `{ type:'moment', moment }`
- `momentLike` 消息：`{ type:'momentLike', id }` → 切换点赞（自己在 likes 里就取消，不在就加入），广播 `{ type:'momentUpdate', id, likes }`

### 前端

- 顶栏"动态"按钮 ↔ 聊天视图切换
- 发布框：文字 + 最多 4 张图（压缩后上传）
- 列表：作者头像/名字、时间、文字、图片九宫格（点开预览）、❤️ 点赞数、自己赞过高亮

## 兼容性

- 旧存档（无 passhash/users/moments 字段）自动按默认处理
- 前端 `avatars` 字段缺省时空对象
- 不破坏现有 e2e 测试的 join 格式（password 可省略）

## 测试

扩展 `test/e2e.mjs`：
- 无密码房间正常进入；设密码后错误密码被拒；正确密码进入
- 动态发布广播、点赞切换与广播
- 头像 setAvatar 广播
