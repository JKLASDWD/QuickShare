# 使用已有 Nginx 部署 QuickShare

服务器已经运行 Nginx 时，可以复用它作为 HTTPS 入口。**Caddy 不需要装在宿主机上；原方案里的 Caddy 本身就是容器。** 本方案直接不启动 Caddy，新增的 Compose 文件只运行 LiveKit 和 Token 服务，80/443 继续由现有 Nginx 使用。

本文默认 Nginx 安装在同一台 Linux 宿主机上。若 Nginx 是 Docker 容器，先阅读最后的网络说明；容器中的 `127.0.0.1` 指向该容器自身，不能直接照搬宿主机配置。

## 1. 文件和连接关系

新增文件：

- `deploy/docker-compose.nginx.yml`：仅启动 LiveKit 和 Token。
- `deploy/nginx/quickshare.conf.example`：Nginx 站点模板。

```text
客户端 HTTPS /api/* → 现有 Nginx :443 → 127.0.0.1:8080 Token
客户端 WSS 信令    → 现有 Nginx :443 → 127.0.0.1:7880 LiveKit
客户端 WebRTC 媒体 → LiveKit 的 UDP / TCP / TURN 端口
```

两个容器都采用 Linux host 网络，因此 Nginx 可直接访问宿主机回环端口。Token 只监听 `127.0.0.1:8080`，不会开放公网 8080；LiveKit 7880 仍需通过防火墙限制公网直接访问。

现有其他网站可继续使用 80/443，以不同 `server_name` 区分。建议给 QuickShare 分配独立子域名，例如 `share.example.com`，不要把整套 LiveKit 挂到已有网站的随意子路径。

## 2. 准备服务器和域名

Docker、代码上传和基础防火墙步骤见 [服务端部署指南](服务端部署指南.md) 第 2、3 节。保留如下目录结构：

```text
/opt/quickshare/
├── deploy/
│   ├── docker-compose.nginx.yml
│   ├── livekit.yaml
│   └── nginx/quickshare.conf.example
└── server/token-service/
    ├── Dockerfile
    ├── server.mjs
    └── config.example.json
```

把 `share.example.com` 的 A 记录指向这台服务器。已有 Nginx 应保持运行；不需要为了本方案停止它。

防火墙和云安全组放行：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 80 | TCP | HTTP 跳转及证书验证 |
| 443 | TCP | Nginx HTTPS/WSS |
| 7881 | TCP | 媒体 TCP 回退 |
| 3478 | UDP | TURN/UDP |
| 50000–60000 | UDP | WebRTC 媒体 |

7880、8080 不需要向公网放行。HTTPS 能访问并不代表媒体端口已通，最终要从另一条网络观看动态画面。

## 3. 配置环境变量和 LiveKit 密钥

在部署目录首次生成配置：

```bash
cd /opt/quickshare/deploy
umask 077
printf 'SHARE_DOMAIN=share.example.com\nLIVEKIT_API_SECRET=%s\nAUTH_TOKEN=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
chmod 600 .env
nano .env
nano livekit.yaml
```

将域名换成真实域名；已有 `.env` 时只追加或修改 `SHARE_DOMAIN`，不要覆盖原密钥。`SHARE_DOMAIN` 只填域名，不加协议、端口和路径。

把 `.env` 中 `LIVEKIT_API_SECRET` 的实际值填入 `livekit.yaml`：

```yaml
keys:
  devkey: "实际的 LIVEKIT_API_SECRET"
```

挂载的 YAML 不会展开 `.env` 变量，所以不能在这里直接写 `${LIVEKIT_API_SECRET}`。公网 VPS 保留 `rtc.use_external_ip: true`；当前模板启用 TURN/UDP，不需要配置 TURN/TLS 证书。

确认宿主机 7880、7881、8080 没有其他服务占用：

```bash
sudo ss -lntup
```

若宿主机 8080 已被占用，同时修改 Compose 中的 `LISTEN: 127.0.0.1:18080` 和 Nginx API 上游 `127.0.0.1:18080`；不要只改一处。

## 4. 启动后台服务

```bash
cd /opt/quickshare/deploy
chmod 600 livekit.yaml
sudo docker-compose -p quickshare-nginx -f docker-compose.nginx.yml config --quiet
sudo docker-compose -p quickshare-nginx -f docker-compose.nginx.yml pull livekit
sudo docker-compose -p quickshare-nginx -f docker-compose.nginx.yml build token
sudo docker-compose -p quickshare-nginx -f docker-compose.nginx.yml up -d
sudo docker-compose -p quickshare-nginx -f docker-compose.nginx.yml ps
sudo docker-compose -p quickshare-nginx -f docker-compose.nginx.yml logs --tail=100 token livekit
curl -i http://127.0.0.1:8080/api/health
```

预期只有 `livekit`、`token` 两个服务，没有 Caddy，也没有容器发布 80/443。内部健康接口应返回 `200` 和 `{"ok":true}`。

如果之前已启动原 Caddy 方案，需要在维护窗口先停止原项目，避免旧 LiveKit 占用相同端口，再启动本方案。旧项目停止会中断正在共享的会话；不要同时运行两套 Compose，也不要执行 `down -v` 删除证书卷。

## 5. 配置 Nginx HTTPS 站点

### 5.1 已经有匹配该域名的证书

先备份当前 Nginx 配置，在服务器上复制模板：

```bash
sudo cp -a /etc/nginx "/etc/nginx.backup-$(date +%Y%m%d-%H%M%S)"
sudo cp nginx/quickshare.conf.example /etc/nginx/conf.d/quickshare.conf
sudo nano /etc/nginx/conf.d/quickshare.conf
```

替换模板中所有 `share.example.com`，并设置证书和私钥的实际路径。如果证书由已有面板或证书工具管理，沿用其有效路径和续期机制。

模板中的 `map` 和 `server` 必须位于 Nginx 的 `http` 上下文。常见发行版的 `/etc/nginx/conf.d/*.conf` 已在 `http` 中 include；如果你的服务采用其他目录结构，放入其实际加载的目录。不要给同一个域名重复增加相互冲突的 server 块。

关键路由已经在模板中配置：

```nginx
location ^~ /api/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Authorization $http_authorization;
}

location / {
    proxy_pass http://127.0.0.1:7880;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $quickshare_connection_upgrade;
    proxy_read_timeout 3600s;
    proxy_buffering off;
}
```

此代码仅解释路由；实际部署使用完整模板，它还包含 TLS、Host/转发头及 `map` 定义。`proxy_pass` 地址末尾不加 `/`，以保留 Token 路由所需的 `/api/` 前缀。WebSocket 需要显式转发 Upgrade 和 Connection，具体要求见 [Nginx 官方 WebSocket 代理说明](https://nginx.org/en/docs/http/websocket.html)。

验证配置后平滑加载：

```bash
sudo nginx -t
# 只有上一条成功时才执行：
sudo systemctl reload nginx
```

如果已有网站已经有同域名的 HTTPS server，可将对应路由合并进去；存在同名 `/api/` 业务时应使用独立子域名，避免路由冲突。

### 5.2 没有证书，现有 Nginx 已占用 80

先只添加这个域名的 HTTP server，暂时不要加载完整 HTTPS 模板，因为不存在的证书文件会让 `nginx -t` 失败：

```nginx
server {
    listen 80;
    server_name share.example.com;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/quickshare-acme;
        try_files $uri =404;
    }
    location / {
        return 404;
    }
}
```

把它保存到 `/etc/nginx/conf.d/quickshare.conf`，域名换成真实域名。然后：

```bash
sudo mkdir -p /var/www/quickshare-acme/.well-known/acme-challenge
sudo nginx -t
sudo systemctl reload nginx
sudo apt-get update
sudo apt-get install -y certbot
sudo certbot certonly --webroot -w /var/www/quickshare-acme -d share.example.com
```

这里使用现有 Web 服务提供验证文件，不需要 Certbot 另绑定 80，也不需要停止其他网站。按提示填写邮箱并接受证书服务条款。原理见 [Certbot Webroot 官方说明](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot)。

申请成功后，按第 5.1 节复制完整模板、确认实际证书路径，再执行 `nginx -t` 与 reload。如果 Certbot 使用了带后缀的证书目录，以 `sudo certbot certificates` 的输出为准。

为续期后的 Nginx 加载配置设置 deploy hook，文件名与已有 hook 区分：

```bash
sudo install -d /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/quickshare-nginx-reload.sh > /dev/null <<'EOF'
#!/bin/sh
nginx -t && systemctl reload nginx
EOF
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/quickshare-nginx-reload.sh
sudo certbot renew --dry-run
systemctl list-timers --all | grep certbot
```

确认实际安装方式已配置自动续期定时任务。已有面板或证书工具在管理同一个证书时，使用它的续期流程，不要再创建相互竞争的证书管理任务。

## 6. 验证服务和配置客户端

从服务器外部检查：

```bash
curl -i https://share.example.com/api/health
curl -i https://share.example.com/api/rooms
```

预期分别为 `200` 和 `401`。服务器 Bash 中加载 `.env` 后检查带鉴权的完整内部链路：

```bash
cd /opt/quickshare/deploy
set -a
source .env
set +a
curl -i "https://$SHARE_DOMAIN/api/rooms" \
  -H "Authorization: Bearer $AUTH_TOKEN"
```

没有共享时应返回 `200` 和 `{"rooms":[]}`。随后按照 [主部署指南的业务验收](服务端部署指南.md#7-api-与业务验收) 用两台客户端跨网络共享。

客户端设置：

- 服务器地址：`https://share.example.com`。
- 访问令牌：`.env` 中的 `AUTH_TOKEN`。

不填写 `127.0.0.1:8080`，不填写 `wss://`，也不填写 LiveKit API Secret。

## 7. 日常维护和故障定位

```bash
cd /opt/quickshare/deploy
sudo docker-compose -p quickshare-nginx -f docker-compose.nginx.yml ps
sudo docker-compose -p quickshare-nginx -f docker-compose.nginx.yml logs --tail=200 token livekit
sudo nginx -t
sudo journalctl -u nginx -n 100 --no-pager
```

常见问题：

| 现象 | 检查 |
| --- | --- |
| 80/443 端口冲突 | 确认没有启动原 Compose 的 Caddy；当前方案不新增这些监听端口 |
| Nginx 返回 502 | 先检查 `curl http://127.0.0.1:8080/api/health`、后台容器状态和上游端口 |
| Token 返回 404 | 检查 API `proxy_pass` 是否错误地添加尾部 `/`，导致 `/api/` 被移除 |
| API 正常但 WSS 失败 | 检查 Upgrade/Connection、TLS 域名和 LIVEKIT_WS_URL |
| 信令正常但无画面 | 检查媒体端口、安全组及 LiveKit 候选 IP；Nginx 不代理 UDP 媒体 |
| 找不到 `$quickshare_connection_upgrade` | 模板 map 未在 http 上下文加载 |
| 证书无法读取 | 检查证书存在、路径与访问权限，尚未申请证书时不能先加载 HTTPS 块 |

本方案的 `.env`、私钥和实际站点配置维护在服务器上，源码仓库只维护示例模板。

## 8. 如果现有 Nginx 也是 Docker 容器

先确认它的网络模式：

```bash
sudo docker inspect <Nginx容器名> --format '{{.HostConfig.NetworkMode}}'
```

- **host 网络**：在 Linux 上，容器共享宿主机网络，可以使用当前模板的 `127.0.0.1:8080` 与 `127.0.0.1:7880`。证书和配置路径需映射到 Nginx 容器中；使用该容器的配置检测与 reload 命令。
- **bridge 网络**：当前 Token 只监听宿主机回环地址，Nginx 容器无法直接访问它。不能仅把地址改成 `host.docker.internal` 就认为已完成。

对 bridge 网络可选择两种网络设计：

1. 将 Nginx 切换为 host 网络。变更影响其现有端口、网络与其他站点，应先核对现有部署。
2. 让 Token 加入 Nginx 的同一个受控 Docker bridge 网络，并通过唯一服务别名（例如 `quickshare-token:8080`）反向代理；Token 在容器内监听 `0.0.0.0:8080` 且不发布公网端口。LiveKit 继续 host 网络，Nginx 与 Token 添加 `host-gateway` 映射访问宿主机 7880，还需按实际子网配置主机防火墙。

第二种设计需要按现有 Nginx 的网络名、Compose 文件和证书挂载情况调整。本文的 `docker-compose.nginx.yml` 是宿主机/host 网络 Nginx 方案，不能直接当作 bridge 网络方案运行。

本文示例已按当前项目与官方代理资料核对；实际服务器需执行 Nginx 配置检测、接口与跨网络媒体验收。
