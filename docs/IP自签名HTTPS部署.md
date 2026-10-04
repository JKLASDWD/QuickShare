# IP 自签名 HTTPS

[首页](../README.md) · [服务器部署](服务端部署指南.md)

适合没有域名、通过 `https://服务器IP:端口` 访问的环境。

## 1. 放行端口

服务器安全组和防火墙放行 TCP 8989（或自选 HTTPS 端口）、7881，UDP 3478、50000–60000。不要开放公网 7880、8080。

## 2. 部署

在 Linux 服务器源码根目录运行：

```bash
bash deploy/install.sh
```

选择 **2：IP 自签名 HTTPS**，填写真实公网 IPv4 和 HTTPS 端口，确认启动。脚本生成带 IP 标识的证书、配置与随机令牌；已有配置和有效证书会复用。

<a id="client"></a>
## 3. 连接客户端

1. 服务器地址填 `https://服务器IP:端口`。
2. 访问令牌填服务器 `deploy/.env` 中的 `AUTH_TOKEN`。
3. 若系统未信任证书，勾选“信任不匹配证书”，保存并完整退出、重启客户端。
4. 用两台电脑验证画面、声音、聊天与停止共享。

信任选项会跳过该服务器主机的证书身份校验，只用于确认可信的服务器；也可将 `deploy/caddy/certs/server.crt` 通过可信渠道导入系统信任。私钥 `server.key` 留在服务器。

## 4. 验证与维护

进入 `deploy/`，将 IP 和端口替换为实际值：

```bash
curl --cacert caddy/certs/server.crt https://203.0.113.10:8989/api/health
```

应返回 `{"ok":true}`。证书默认有效期 365 天；过期或更换 IP 时先备份原证书，按新 IP 重新签发包含 `subjectAltName=IP:实际IP` 的证书，再重新创建入口容器：

```bash
sudo docker compose --env-file .env -p quickshare -f docker-compose.selfsigned.yml up -d --force-recreate caddy
```

使用严格校验的客户端同步更新信任证书。[更多排障](服务端部署指南.md#troubleshooting)。
