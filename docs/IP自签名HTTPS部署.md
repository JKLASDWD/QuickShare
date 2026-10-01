# IP、非标准端口与自签名 HTTPS

此方案使用客户端直连 `https://IP:端口`，由项目自带的 Caddy 容器提供 TLS。无需域名、Cloudflare 或外部 Nginx。本文示例为 `47.110.238.15:8989`，换服务器时替换真实 IP。

客户端使用预先核对的服务器证书 SHA-256 指纹验证身份：指纹、IP SAN、有效期和 serverAuth 用途均匹配才允许连接。其他主机仍走系统正常验证；不会全局忽略证书错误。此功能需要使用包含 `certificate-policy.js` 的新版客户端，旧 exe 不会自动获得这个功能。

本方案处理连接加密和证书信任，不保证消除云厂商的网络拦截。若 IP 直连仍被阻断，需与云厂商确认该服务的开放方式；自签名证书不能解决 TCP/TLS 连接被关闭的问题。

## 1. 配置后端

在服务器的 `deploy` 目录，编辑现有 `.env`，保留或填写安全随机值：

```dotenv
SERVER_IP=47.110.238.15
TLS_PORT=8989
LIVEKIT_API_SECRET=你的LiveKit签名密钥
AUTH_TOKEN=你的客户端访问令牌
```

没有密钥时，可分别执行 `openssl rand -hex 32` 生成两个不同的随机值。将同一个 `LIVEKIT_API_SECRET` 填入 `livekit.yaml`：

```yaml
keys:
  devkey: 你的LiveKit签名密钥
```

保留 `rtc.use_external_ip: true`。`AUTH_TOKEN` 是客户端访问令牌，与 LiveKit 签名密钥用途不同。不要覆盖已有 `.env` 后丢失原来的密钥。

## 2. 生成 IP 证书

以下命令在服务器 Bash 中执行。先确认 `.env` 属于你自己维护的配置文件，再加载变量：

```bash
cd /opt/quickshare/deploy
set -a
source .env
set +a
umask 077
mkdir -p caddy/certs
```

创建 OpenSSL 配置，兼容不支持 `-addext` 的较旧 OpenSSL：

```bash
cat > caddy/certs/openssl-ip.cnf <<EOF
[req]
prompt = no
distinguished_name = dn
x509_extensions = server_cert
[dn]
CN = QuickShare Server
[server_cert]
subjectAltName = IP:${SERVER_IP}
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
EOF

openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
  -config caddy/certs/openssl-ip.cnf \
  -keyout caddy/certs/server.key \
  -out caddy/certs/server.crt
chmod 600 caddy/certs/server.key
chmod 644 caddy/certs/server.crt
```

已有同名证书时，先备份后再生成。证书必须包含 `IP:47.110.238.15` 类型的 SAN，仅将 CN 或 DNS SAN 写成 IP 不够。证书到期或服务器换 IP 时，需要重新签发并更新客户端指纹。

查看证书和 SHA-256 指纹：

```bash
openssl x509 -in caddy/certs/server.crt -noout -text
openssl x509 -in caddy/certs/server.crt -noout -fingerprint -sha256
```

把第二条输出中等号后面的指纹发给客户端用户。通过你已信任的通信渠道核对；不要将未知网络连接中看到的指纹直接当作可信值。指纹和证书可以分发，`server.key` 私钥只能留在服务器。

## 3. 验证并启动

本方案文件为 `docker-compose.selfsigned.yml` 和 `caddy/Caddyfile.selfsigned`。Caddy 容器内监听 HTTPS 443，宿主机映射到 8989；Token 不对公网发布 8080。

```bash
chmod 600 .env livekit.yaml
docker-compose -p quickshare -f docker-compose.selfsigned.yml config --quiet
docker-compose -p quickshare -f docker-compose.selfsigned.yml \
  run --rm --no-deps caddy \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

验证成功后启动：

```bash
docker-compose -p quickshare -f docker-compose.selfsigned.yml \
  up -d --build --force-recreate
docker-compose -p quickshare -f docker-compose.selfsigned.yml ps
docker-compose -p quickshare -f docker-compose.selfsigned.yml logs --tail=80 caddy token
```

如果已有的服务项目名是 `quickshare`，使用相同项目名替换原服务，会中断正在进行的共享。以后维护也使用此文件，不要同时启动其他方案。不要执行 `down -v`，避免删除原有卷。

Caddy 配置包含 `default_sni`：IP HTTPS 客户端可能不发送 SNI，容器本机地址又不同于公网 IP，因此明确选择该 IP 的证书。该方案使用手动证书，不会自动续期，也不发布 HTTP 80。

API 和信令地址分别为：

| 项目 | 地址 |
| --- | --- |
| 客户端服务器地址 | `https://47.110.238.15:8989` |
| API 路径 | `/api/health`、`/api/rooms` 等 |
| 下发的 LiveKit 信令地址 | `wss://47.110.238.15:8989` |
| Token 到 LiveKit 的内部地址 | `http://host.docker.internal:7880` |

不要把旧 `.env` 的 `LIVEKIT_WS_URL=ws://...` 写入此方案的 Compose 环境变量；此文件直接由 `SERVER_IP` 和 `TLS_PORT` 生成 WSS 地址。

## 4. 客户端信任配置

安装或启动新构建的客户端，打开设置：

1. 服务器地址填 `https://47.110.238.15:8989`。
2. 访问令牌填 `.env` 中的 `AUTH_TOKEN`。
3. 服务器证书 SHA-256 指纹填前面核对的 64 位十六进制值，可以保留冒号。
4. 保存，从托盘选择“退出”，重新启动应用，避免 Chromium 仍使用旧的证书验证缓存。

也可以在实际使用的 `config.json` 中填写：

```json
{
  "server": "https://47.110.238.15:8989",
  "authToken": "你的客户端访问令牌",
  "serverCertificateSha256": "填写证书SHA256指纹"
}
```

该 JSON 是字段示例，合并到原有配置中即可。指纹字段需要替换成真实值，否则验证不通过。配置路径以设置窗口显示的路径为准。无需将证书导入所有用户的 Windows 根证书库；此信任配置仅影响 QuickShare。

改错指纹、过期、SAN 不含该 IP、缺少 serverAuth 用途的证书仍然应报错。错误原因可在配置目录旁的 `main.log` 中找到 `certificate-rejected`。这属于有效的安全检查；不要使用 `--ignore-certificate-errors` 或关闭 TLS 校验。

## 5. 防火墙与验收

云安全组和主机防火墙允许 TCP 8989、媒体 TCP 7881、TURN UDP 3478、媒体 UDP 50000–60000。宿主机不需要为本方案开放 TCP 443。公网不要直接开放 7880/8080；7880 需允许可信 Docker bridge 子网访问，具体规则见主部署指南的 bridge 排查步骤。

在服务器使用证书作为信任锚验证 HTTPS，无需 `-k`：

```bash
curl --cacert caddy/certs/server.crt \
  "https://${SERVER_IP}:${TLS_PORT}/api/health"
```

然后从客户端所在电脑，用可信渠道传来的 `server.crt` 测试：

```powershell
curl.exe --cacert .\server.crt https://47.110.238.15:8989/api/health
```

预期返回 `200 {"ok":true}`。通过 API 还需要正确访问令牌；列表只展示有发布者的房间。最后用两个客户端跨网络共享和观看，确认 WSS 和媒体通道都正常。

如果 TCP 连接或 TLS 握手本身被关闭，证书指纹功能无法修复网络拦截。若 curl 成功、客户端仍失败，确认使用新 exe、实际配置路径、指纹、IP、系统时间以及是否完整退出重启。

## 6. 更新证书

到期前重新生成证书，验证新文件后重建 Caddy，再通过可信渠道更新所有客户端指纹并重启。旧指纹会拒绝新证书，这是预期行为。不要在服务器运行中反复覆盖证书而不通知用户。

实现依据：[Electron 证书验证回调](https://www.electronjs.org/docs/latest/api/session#sessetcertificateverifyprocproc)、[Caddy TLS](https://caddyserver.com/docs/caddyfile/directives/tls)、[默认 SNI](https://caddyserver.com/docs/caddyfile/options#default_sni)、[OpenSSL req](https://docs.openssl.org/3.0/man1/openssl-req/)。
