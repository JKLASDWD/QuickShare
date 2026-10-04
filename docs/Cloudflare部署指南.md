# Cloudflare 部署

[首页](../README.md) · [服务器部署](服务端部署指南.md)

使用专用子域名，例如 `share.example.com`。橙云代理 HTTPS/WSS 的 API 和信令，画面与声音仍通过媒体端口直连服务器。[Cloudflare 代理端口说明](https://developers.cloudflare.com/fundamentals/reference/network-ports/)

## 1. 添加 DNS，先保持灰云

1. 在 Cloudflare 添加域名，将注册商的 NS 改为 Cloudflare 提供的地址。
2. 等待域名状态为 **Active**，打开 **DNS → Records → Add record**。
3. 填写下表并保存；已有记录直接编辑。

| 字段 | 值 |
| --- | --- |
| Type | A |
| Name | share |
| IPv4 address | 服务器公网 IPv4 |
| Proxy status | DNS only，灰云 |
| TTL | Auto |

没有可用 IPv6 时，不添加同名 AAAA；移除错误记录前先确认原用途。[DNS 代理状态](https://developers.cloudflare.com/dns/proxy-status/)

## 2. 部署并验证服务器

在 Linux 源码根目录运行：

```bash
bash deploy/install.sh
```

选择 **1：域名 HTTPS**，或 **4：已有 Nginx**；域名填 `share.example.com`。完成[端口放行](服务端部署指南.md#2-放行端口)，保留服务器证书及续期机制。

从服务器外的电脑测试，Windows 使用 `curl.exe`：

```bash
curl -i https://share.example.com/api/health
```

应返回 **200** 和 `{"ok":true}`，没有证书错误。先用两台客户端验证共享正常，再开启橙云。

## 3. 设置 HTTPS

在 Cloudflare 选择该域名：

1. **SSL/TLS → Overview**：设为 **Full (strict)**，保存。
2. **SSL/TLS → Edge Certificates**：确认覆盖该子域名的证书为 **Active**；未生效先保持灰云。

服务器仍需有效、匹配域名的证书；可继续使用 Caddy/Certbot 的证书。此加密设置可能影响其他子域名，先确认其他站点也有有效证书。[严格模式](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)

## 4. 设置 WebSocket 和缓存

1. 打开 **Network → WebSockets**，确认 **On**。[官方说明](https://developers.cloudflare.com/network/websockets/)
2. 打开 **Caching → Cache Rules → Create rule**。
3. 名称填 `QuickShare bypass cache`；匹配 **Hostname / equals / share.example.com**。表达式也可写：

   ```text
   (http.host eq "share.example.com")
   ```

4. 在 **Cache eligibility** 选择 **Bypass cache**，保存并部署。
5. 如有其他通用缓存规则，把本规则放在与它匹配的通用规则之后，避免被后续规则覆盖。[规则优先级](https://developers.cloudflare.com/cache/how-to/cache-rules/order/)

该子域名使用客户端令牌鉴权，不套用浏览器登录或交互式验证码。发生拦截时，查 **Security Analytics → Events**，仅调整命中该主机的规则。

## 5. 开启橙云

1. 回到 **DNS → Records**，编辑 `share` 的 A 记录。
2. 将 **Proxy status** 改为 **Proxied，橙云**，保存。
3. 等待 DNS 缓存刷新。客户端继续使用 `https://share.example.com`，令牌保持不变。

服务器继续开放 **TCP 80、443、7881；UDP 3478、50000–60000**。媒体端口不能限制为仅 Cloudflare 来源；不要开放内部端口 7880、8080。普通橙云不会隐藏媒体服务器 IP，也不能代替媒体端口。

## 6. 验证橙云

从外部电脑执行：

```bash
nslookup share.example.com
curl -i https://share.example.com/api/health
curl -i https://share.example.com/api/rooms
```

应看到 DNS 返回 Cloudflare 代理地址；健康接口 **200**，响应头通常含 `cf-ray`；无令牌房间接口 **401**，不应出现 HTML 验证页。

最后用两台不同网络的客户端测试画面、声音、聊天及停止共享；接口正常不代表媒体端口已打通。

## 常见问题

| 现象 | 检查 |
| --- | --- |
| 521 / 522 | 服务运行、443、防火墙与回源连通性 |
| 525 / 526 | 服务器证书域名、有效期和完整证书链 |
| 403 / HTML 验证页 | Security Events、Access 与验证码规则 |
| 进房失败 | WebSockets 开关、Nginx 升级头 |
| 进房后无画面 | 服务器媒体端口、安全组及公网 IP |
| 列表更新不及时 | 缓存绕过规则和后续覆盖规则 |

对比回源时，将下面域名和 IP 替换为自己的值：

```bash
curl -i --resolve share.example.com:443:203.0.113.10 https://share.example.com/api/health
```

直连正常、橙云异常时，可临时改回 **DNS only，灰云**，等待缓存刷新后重试。保留服务器证书续期；普通公开网站 Tunnel 不能代替本项目的 UDP 媒体通道。
