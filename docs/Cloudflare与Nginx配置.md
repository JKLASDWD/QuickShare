# Cloudflare A 记录与已有 Nginx

适用于 Linux 主机已有 Nginx，使用 `docker-compose.nginx.yml` 启动 QuickShare 的场景。Nginx 在宿主机运行，Token 服务和 LiveKit 使用 host 网络。

## 1. Cloudflare 设置

| A 记录状态 | HTTPS 配置 |
| --- | --- |
| 灰云：仅 DNS | 客户端直接访问服务器，Nginx 使用浏览器信任的证书，例如 Let's Encrypt |
| 橙云：已代理 | Cloudflare SSL/TLS 设置为 Full (strict)，Nginx 使用匹配域名的有效公共证书或 Cloudflare Origin CA 证书 |

建议先用灰云和公共证书验证服务，再按需开启橙云。已有证书可以直接复用。

Origin CA 证书仅供 Cloudflare 连接源站使用；关闭代理后直接访问，客户端会提示证书不受信任。Flexible 模式回源使用 HTTP，与本配置的 HTTPS 跳转组合可能产生循环。

官方说明：[代理状态](https://developers.cloudflare.com/dns/proxy-status/)、[Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)、[Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)、[Flexible](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/flexible/)。

## 2. 按域名生成配置

先确保域名 A 记录指向服务器，证书已经签发。没有证书时，按 [已有 Nginx 部署指南](已有Nginx部署指南.md) 的证书申请步骤操作，然后执行下面命令。

脚本仅使用 Python 3 标准库，无须安装依赖。替换下面的 `share.example.com`：

```bash
cd /opt/quickshare/deploy
python3 nginx/render-config.py --domain share.example.com > /tmp/quickshare.conf
```

默认读取以下证书路径：

```text
/etc/letsencrypt/live/你的域名/fullchain.pem
/etc/letsencrypt/live/你的域名/privkey.pem
```

如果使用已有证书或 Origin CA，可同时指定两个路径：

```bash
python3 nginx/render-config.py --domain share.example.com \
  --cert /etc/nginx/ssl/quickshare.pem \
  --key /etc/nginx/ssl/quickshare.key > /tmp/quickshare.conf
```

检查输出，备份已有同名配置后安装：

```bash
sudo install -m 0644 /tmp/quickshare.conf /etc/nginx/conf.d/quickshare.conf
sudo nginx -t
# 仅在 nginx -t 成功后执行
sudo systemctl reload nginx
```

确认主配置在 `http` 块中包含 `conf.d/*.conf`。同一域名已有其他 server 块时，合并配置，避免重复配置同一域名。证书文件必须存在，且 Nginx 有读取权限。

生成的配置包含：

- HTTP 跳转 HTTPS，并保留 ACME HTTP 验证路径 `/var/www/quickshare-acme`。
- `/api/` 转发到 `127.0.0.1:8080`，保留 `/api/` 前缀和 Authorization 请求头。
- 其他路径转发到 `127.0.0.1:7880`，支持 WebSocket，关闭响应缓冲，并设置一小时读写超时。

完整模板见 [quickshare.conf.example](../deploy/nginx/quickshare.conf.example)。本配置不会自动签发或续期证书，续期设置见已有 Nginx 部署指南。

## 3. 启动后端

在 `deploy/.env` 中设置相同的 `SHARE_DOMAIN`，并填写之前生成的 `LIVEKIT_API_SECRET` 和 `AUTH_TOKEN`。真实密钥不能提交到 GitHub。

同时将 `deploy/livekit.yaml` 的 `keys.devkey` 改为同一个 `LIVEKIT_API_SECRET`；保留示例值 `secret` 会导致 Token 服务签发的令牌无法通过 LiveKit 验证。完整初始化步骤见已有 Nginx 部署指南。

```bash
cd /opt/quickshare/deploy
docker-compose -f docker-compose.nginx.yml up -d --build
docker-compose -f docker-compose.nginx.yml ps
```

客户端服务器地址填写 `https://你的域名`，访问令牌填写 `.env` 中的 `AUTH_TOKEN`。如果 Nginx 自身运行在 bridge 网络容器内，不能直接使用本模板的 `127.0.0.1`；请按已有 Nginx 部署指南调整网络。

## 4. 橙云与屏幕共享端口

Cloudflare 支持代理 WebSocket；启用橙云时检查 Network 中 WebSockets 开关，并确保 `/api/` 和 LiveKit 连接不受交互式验证规则影响。若自行配置了缓存所有内容的规则，应将 `/api/` 排除缓存。

依据 [Cloudflare 代理端口说明](https://developers.cloudflare.com/fundamentals/reference/network-ports/) 与本项目 LiveKit 配置，普通橙云代理不能承载这里的媒体 UDP 和 TCP 7881 连接。域名主要用于 HTTPS API 和 WebSocket，媒体仍直连服务器公网 IP。服务器及云安全组需要按实际 LiveKit 配置开放：

- `80/tcp`、`443/tcp`：Nginx HTTP/HTTPS。
- `7881/tcp`：WebRTC TCP 回退。
- `3478/udp`：本项目 TURN UDP。
- `50000:60000/udp`：本项目媒体端口范围。

公网禁止直接访问 Token 的 8080 和 LiveKit HTTP 的 7880；允许 Nginx 在本机访问。媒体端口不能仅允许 Cloudflare IP，因为真实客户端需要直连。`livekit.yaml` 中公网地址设置必须与服务器一致。橙云不会隐藏本架构中媒体服务器的公网 IP。

WebSocket 官方说明：[Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets/)。

## 5. 验证

```bash
curl -i https://share.example.com/api/health
curl -i https://share.example.com/api/list
```

健康检查应返回 200；启用认证时，未带令牌的列表请求应返回 401。之后用两个客户端完成共享和观看，确认媒体通道正常。

如果使用公共受信任证书，可以绕过 Cloudflare 检查源站 HTTPS：

```bash
curl --resolve share.example.com:443:203.0.113.10 https://share.example.com/api/health
```

将域名和 IP 替换为真实值。Origin CA 场景直接访问源站可能因证书信任失败，这不代表 Cloudflare 回源失败。

配置生成脚本可在本地验证；证书、Nginx 模块、端口与 Cloudflare 设置须在实际服务器上验证，以 `nginx -t` 和真实客户端连接结果为准。
