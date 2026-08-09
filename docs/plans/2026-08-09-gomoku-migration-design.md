# 五子棋迁移到新加坡服务器设计

日期：2026-08-09
状态：已确认（用户批准）

## 目标

把 C:\Users\王巢三\gomoku 项目从广州服务器迁移到新加坡服务器（47.82.0.187），并接入新域名 game.hty888.site。

## 决策

| 项 | 选择 |
|---|---|
| 旧棋局数据 | **不迁**（全新开始） |
| 旧域名 game.htyiybb.top | **只看新地址**（老地址之后会从 CF 隧道 + Caddy 中移除） |
| AI 激活链路 | **保持原样**（?claim=key_xxx 机制不变） |

## 现状

### 当前部署（广州 114.132.229.58）
- systemd 服务 gomoku，端口 8080
- 域名：game.htyiybb.top（CF 隧道 → 8080）
- Caddyfile 中 `game.htyiybb.top { reverse_proxy 127.0.0.1:8080 }`
- 28+ 个真实棋局存 /opt/gomoku/data/rooms.json

### 项目代码
- C:\Users\王巢三\gomoku
- 已上传 GitHub：BaylenJack/gomoku（main/master 分支）
- Node 20+、依赖只有 `ws`
- 文件结构：src/{server,room,game,store}.js，public/{app,hint,worker}.js + index.html + style.css + sw.js + manifest.json

### 新加坡服务器（47.82.0.187）
- 已有 lovechat 部署
- 已有自动更新定时器（lovechat-update）
- 需要新增 gomoku 部署（端口 8080）
- Caddyfile 需加 `game.hty888.site { reverse_proxy 127.0.0.1:8080 }`

## 迁移步骤

### 1. 代码拉取（无需新数据）
- 新加坡服务器：`git clone https://github.com/BaylenJack/gomoku.git /opt/gomoku`
- `cd /opt/gomoku && npm install --omit=dev`
- **data/ 目录留空**（不迁移旧棋局）

### 2. systemd 服务
新建 `/etc/systemd/system/gomoku.service`：
```ini
[Unit]
Description=Gomoku server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/gomoku
ExecStart=/usr/bin/env node src/server.js
Restart=always
RestartSec=3
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
```
启动：`sudo systemctl enable --now gomoku`

### 3. Caddyfile 加 game.hty888.site
在 Caddyfile 末尾追加：
```
game.hty888.site {
    reverse_proxy 127.0.0.1:8080
}
```
重载：`sudo systemctl reload caddy`

### 4. AI 激活机制保留
- 不需要服务器端额外配置
- `?claim=key_xxx` 写在 localStorage，浏览器本地生效
- 五子棋的 AI 引擎全在客户端（worker.js），服务端不参与

### 5. DNS 配置（用户操作）
CF 后台 chat.hty888.site → DNS → Records → Add record：
- Type: `A`
- Name: `game`
- IPv4: `47.82.0.187`
- Proxy status: **DNS only（灰色云朵）**

### 6. 防火墙放行（如果没放过）
新加坡服务器需放行 TCP 8080 给公网：
- ufw: `sudo ufw allow 8080/tcp`
- 阿里云控制台防火墙：检查是否有 TCP 8080 规则

## 自动更新

复用 lovechat 的 auto-update 思路，新建 gomoku 自动更新：
- `/opt/gomoku/update.sh`：pull → restart
- `gomoku-update.service` + `gomoku-update.timer`（每 3 分钟）

## 老地址处理（之后做）

迁移成功后，从 CF 后台和 Caddyfile 中移除 game.htyiybb.top 的所有配置：
- CF 隧道 ingress 删除 game.htyiybb.top 路由
- 广州 Caddyfile 删除 `game.htyiybb.top` 块
- 广州服务可停止（gomoku.service 移除）

**这一步放在迁移上线并稳定后做**，避免双地址并行造成混乱。

## 验证

- [ ] git clone 成功
- [ ] npm install 无错
- [ ] lovechat.service + gomoku.service 都 active
- [ ] Caddy 重新申请 game.hty888.site 证书（Let's Encrypt 自动）
- [ ] HTTPS 200 + healthz ok
- [ ] WebSocket 连接 + 落子测试
- [ ] AI 提示激活链接测试
- [ ] 跨设备开两个浏览器对弈

## 文件清单

- /opt/gomoku/ （新加坡新建）
- /etc/systemd/system/gomoku.service
- /etc/caddy/Caddyfile（追加 game.hty888.site）
- /opt/gomoku/update.sh（自动同步脚本）
- /etc/systemd/system/gomoku-update.{service,timer}（定时器）