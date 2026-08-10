#!/bin/bash
# =====================================================================
# 客户端: 从你电脑通过 TLS 隧道直连 47.82.0.187:443
# 前提: 服务端 stunnel 已部署,阿里云安全组已放行 443
# 执行: bash <(curl -sL https://raw.githubusercontent.com/BaylenJack/lovechat/ssh-tls-tunnel/ssh-tls-tunnel/client-connect.sh)
# =====================================================================

SERVER="47.82.0.187"
PORT="443"

echo "正在通过 TLS 隧道连接 ${SERVER}:${PORT} ..."

ssh -o "ProxyCommand=openssl s_client -quiet -connect ${SERVER}:${PORT}" \
    -o "StrictHostKeyChecking=accept-new" \
    admin@_
