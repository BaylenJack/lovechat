# 部署到 Linux 服务器

```bash
# 1. 上传项目
scp -r . user@server:/tmp/lovechat

# 2. 在服务器上
ssh user@server
sudo mv /tmp/lovechat /opt/
cd /opt/lovechat
npm install --omit=dev

# 3. 装 systemd 服务
sudo cp deploy/systemd.service /etc/systemd/system/lovechat.service
sudo systemctl daemon-reload
sudo systemctl enable --now lovechat
sudo systemctl status lovechat

# 4. 检查健康
curl http://localhost:8080/healthz
```

## Nginx 反向代理 (可选)

```nginx
server {
    listen 80;
    server_name chat.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name chat.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/chat.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400s;  # WebSocket 长连接
    }
}
```

## Cloudflare Tunnel (无需备案)

适合不想备案或 IP 被墙的情况。详见 README.md。