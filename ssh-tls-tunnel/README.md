# SSH-over-TLS 隧道方案

## 问题

运营商 DPI 精准识别 `SSH-2.0-` 协议特征并丢弃, TCP 能握手但永远收不到 banner. 换端口无效.

## 解法

把 SSH 流量从第一个字节起伪装成 TLS/HTTPS.

```
客户端 → TLS ClientHello → 服务端 stunnel:443 → localhost:22 (sshd)
客户端 ← TLS 密文(内含 SSH 协议) ←
```

## 分步操作

### 1. 服务端 — 在 47.82.0.187 执行

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/BaylenJack/lovechat/ssh-tls-tunnel/ssh-tls-tunnel/server-setup.sh)
```

### 2. 客户端 — 阿里云安全组放行 443

[控制台](https://ecs.console.aliyun.com/#/securityGroup/region/ap-southeast-1),
实例 `i-t4n22z7xk6sn0c1cj1ud`,
入方向: TCP 443, 来源 `157.254.20.4/32`, 允许.

### 3. 客户端 — 从你电脑连接

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/BaylenJack/lovechat/ssh-tls-tunnel/ssh-tls-tunnel/client-connect.sh)
```

或手动:

```bash
ssh -o 'ProxyCommand=openssl s_client -quiet -connect 47.82.0.187:443' admin@_
```

永久写入 `~/.ssh/config`:

```
Host my-ecs-tls
    HostName 47.82.0.187
    User admin
    ProxyCommand openssl s_client -quiet -connect 47.82.0.187:443
```

之后 `ssh my-ecs-tls`.
