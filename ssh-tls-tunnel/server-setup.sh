#!/bin/bash
# =====================================================================
# 服务端: 在 47.82.0.187 (阿里云 ECS) 上部署 stunnel TLS-SSH 隧道
# 原理: 监听 443 端口收 TLS 流量,解密后转给本地 sshd:22
# 运营商看到的是普通 HTTPS —— 无法通过 DPI 识别出 SSH
# 执行: bash <(curl -sL https://raw.githubusercontent.com/BaylenJack/lovechat/ssh-tls-tunnel/ssh-tls-tunnel/server-setup.sh)
# =====================================================================
set -e

echo "=== 1. 安装 stunnel4 ==="
sudo apt update && sudo apt install -y stunnel4

echo ""
echo "=== 2. 生成自签名 TLS 证书 (10年有效) ==="
sudo mkdir -p /etc/stunnel
sudo openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /etc/stunnel/stunnel.key \
  -out /etc/stunnel/stunnel.crt \
  -subj "/CN=47.82.0.187"
sudo chmod 600 /etc/stunnel/stunnel.key

echo ""
echo "=== 3. 写入 stunnel 配置 ==="
sudo tee /etc/stunnel/stunnel.conf << 'EOF'
pid = /run/stunnel.pid
[ssh-tls]
accept  = 0.0.0.0:443
connect = 127.0.0.1:22
cert    = /etc/stunnel/stunnel.crt
key     = /etc/stunnel/stunnel.key
EOF

echo ""
echo "=== 4. 启用 stunnel 自启动 ==="
sudo sed -i 's/^ENABLED=0/ENABLED=1/' /etc/default/stunnel4

echo ""
echo "=== 5. 启动 stunnel ==="
sudo systemctl restart stunnel4

echo ""
echo "=== 6. 验证状态 ==="
sudo systemctl status stunnel4 --no-pager -l
echo ""
sudo ss -tlnp | grep -E ':443 '
echo ""
echo "============================================"
echo "  服务端部署完成"
echo "  请确认已去阿里云安全组放行 443 端口!"
echo "  控制台: https://ecs.console.aliyun.com/#/securityGroup/region/ap-southeast-1"
echo "  实例: i-t4n22z7xk6sn0c1cj1ud"
echo "  入方向: TCP 443, 来源 157.254.20.4/32 (或 0.0.0.0/0)"
echo "============================================"
