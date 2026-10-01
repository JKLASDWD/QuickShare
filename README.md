# QuickShare — Windows 快捷屏幕共享（自研）

一个 Electron 客户端双角色（共享 / 观看）+ LiveKit SFU 服务端的屏幕共享系统。
设计文档见 `docs/技术方案调研-屏幕共享.md`（v1.3 定稿）。
GitHub 维护范围与忽略规则见 [GitHub 维护说明](docs/GitHub维护说明.md)。

```
共享端（Electron 客户端）──┐
                          ├── LiveKit SFU（docker，公网 VPS）── 观看端（同一个 Electron 客户端）
房间号自设 · 房间列表一键观看 · 全程无浏览器
```

## 目录结构

```
client/                 # Electron 客户端（共享 + 观看双角色）
  main.js               # 托盘 / 全局热键 / 窗口 / 冒烟模式
  preload.js            # 渲染进程桥（contextIsolation）
  renderer/picker.html  # 共享：屏幕/窗口缩略图一键选择 + 自设房间号
  renderer/viewer.html  # 观看：房间列表 + 一键观看 + 宫格多路
  renderer/settings.html# 设置：服务器地址 / 显示名 / 热键 / 码率
  renderer/engine.html  # 冒烟引擎（画布推流 / 订阅校验，亦可在浏览器跑）
  config.example.json   # 客户端配置样例（实际读 exe 旁或 userData 的 config.json）
server/token-service/   # Token 服务（零依赖 Node）：建房/列表/进房/停止 + JWT HS256
deploy/                 # 服务端一键部署（docker-compose + livekit.yaml + Caddyfile）
tools/                  # 本地开发用 livekit-server.exe（.gitignore）
docs/                   # 方案文档
```

## 本地开发冒烟（免 VPS）

1. `tools/livekit-server.exe --dev`（监听 7880，devkey/secret）
2. `cd server/token-service && node server.mjs`（监听 8080）
3. 发布端：`cd client && npm start -- --smoke publish smoke1 http://localhost:8080 15000`
4. 观看端（另一终端，趁上一步推流中）：`npm start -- --smoke watch smoke1 http://localhost:8080`
   - 观察输出：`published` → `first-frame` → `framesIn3s>0` → `SMOKE-EXIT 0`
   - 也可在普通浏览器直接开 `renderer/engine.html?mode=...&room=...&server=...`（无 preload 时自动降级）
5. 图形界面：`npm start`（启动即前台显示共享窗口；托盘 + 热键 Ctrl+Alt+S）

## 打包 exe（分发给他人在 Windows 直接运行）

```bash
cd client
npm install && npm run dist
# 产物：
#   dist/QuickShare-Portable-0.2.8.exe  单文件绿色版，双击即用（无需安装）
#   dist/QuickShare-Setup-0.2.8.exe     NSIS 一键安装版（开始菜单快捷方式）
```

- 便携版配置存于 `%APPDATA%/QuickShare/config.json`（或界面内「设置」直接改）。
- 打包机只需 Node；`assets/icon.png`（256px）由 `npm install` 时脚本自动生成。

## 使用流程（v0.2.8）

- **共享**：启动即前台显示 → 屏幕列表先出（窗口随后补齐）→ 单击选中（自动预填房间号，可改）→ 双击缩略图或点「开始共享」。头部「查看共享 →」直达房间列表。
- **枚举卡住/失败时**：点「**系统选择器共享…**」走 Windows 原生选择框，不依赖内置列表。
- **观看**：房间列表单击观看；也可在顶部「房间号直进」输入房间号回车进入（列表未刷新也能进）。口令房会弹口令框。

### v0.2.3 修复（桌面版全部症状的真正根因）

- **根因**：preload 以 contextBridge 注入的 `window.bridge` 是不可配置全局属性，页面顶层 `const bridge = window.bridge || {…}` 与之冲突 → **脚本解析期 SyntaxError，整页脚本从未执行**——枚举永远停在初始文案、所有按钮（开始共享/系统选择器/查看共享/回车）全部无反应，v0.2.0 起即如此。浏览器测试因走 shim 兜底而无法暴露。
- 修复：四个页面脚本整体包进 IIFE（函数作用域内 const 合法遮蔽全局）。
- 附带修复：`setDisplayMediaRequestHandler` 回调按官方 API（系统选择器优先，回退 desktopCapturer 首屏）；preload `listSources` 透传 types；渲染端错误横幅 + 系统选择器 8 秒看门狗；主进程日志 `%APPDATA%\QuickShare\main.log`；`QUICKSHARE_CDP=9222` 启动开本机调试口（scripts/cdp-probe.mjs 可远程体检）。
- 实测（真实 Electron 主进程）：枚举 1 屏 2.0s + 11 窗 3.5s 分步出全；「查看共享」懒创建窗口正常弹出；「系统选择器共享」建房→发布→服务端在线全闭环。

### v0.2.4 修复

- 停止共享后房间残留：改为**停止时主动删房**（DELETE，口令房带口令），不等 LiveKit empty_timeout(60s)——观看列表即刻消失、同房间号立即可以再次共享（E2E 实测：停止→服务端房间数 0→同号重建成功）。
- 停止共享后「开始共享」按钮未恢复：finish 补 updateStartBtn()。
- 409 提示优化：同号被占时提示"稍候几秒重试或换个号"。

### v0.2.6：设置保存修复 + IP 部署强制安全

- **设置码率保存后变回旧值**：保存请求里码率字段被丢（回填空、配置未更新，重开显示旧值）已修复；输入改为数字框并对全角数字（中文输入法）容错，兜底 8000。
- **IP 直连部署强制鉴权**：`docker-compose.ip.yml` 置 `REQUIRE_AUTH=1`——未配置 `AUTH_TOKEN` 时服务**拒绝启动**；令牌为全员共享的对等密钥，列表/建房/进房/删房全部需 `Authorization: Bearer`（客户端「设置→访问令牌」填入，观看列表同样携带）；令牌比对用常量时间比较。媒体流恒为 SRTP 加密；公网长期使用建议域名+TLS 主线方案。

### v0.2.7：修复停止共享后托盘卡「共享中」

- **根因**：渲染端停止流程漏发 `share-stopped` 上报（前次编辑事故），主进程 `sharing` 永不清除 → 托盘一直显示共享中；此时托盘「停止共享」发到渲染端又被防重入守卫拦下，状态永远卡死。已补回上报并以主进程日志实测：停止后 `share-stopped` 送达（Disconnected 重入会双报，幂等无害）。
- 托盘「停止共享」改为乐观清态：点击即清主进程共享态并刷新菜单，渲染端回报到达时幂等再清——即使渲染端异常也永远能退出共享态。
- finish 全程打点入 main.log（enter/cleanup-done/shareStopped-sent），此类状态问题今后可直接看日志。

### v0.2.8

- 解除最大码率 15000 Kbps 软上限（4K/内网可设 20000+；保留 500 下限防呆），实测 30000 可保存生效。

### v0.2.5：清晰度稳定 + IP 直连部署

- **偶发模糊根治（两端三处）**：发布端 `degradationPreference: 'maintain-resolution'`（带宽/CPU 紧张时保分辨率降帧率，屏幕文字不再被压糊）+ 默认码率 4M→8M（设置可调）；观看端关闭 `adaptiveStream` 并锁定高清 simulcast 层（宫格小窗不再因元素尺寸被喂低清层）。E2E 实测观看端收满 **1920×1080**。
- 观看列表轮询 10s→3s：停止共享后房间从观看列表消失的观感即时（服务端删房本身是即时的，0.2.4 CDP 实测 366ms）。
- **IP 直连部署**：`deploy/docker-compose.ip.yml`（无域名/无 TLS）：livekit + token 均 host 网络，`SERVER_IP`/`AUTH_TOKEN` 环境变量即起。安全：Token 服务支持可选 API 鉴权（`AUTH_TOKEN`，建房/进房/删房需 `Authorization: Bearer`，客户端「设置→访问令牌」填入）；房间口令照常可用；媒体流 SRTP 加密；信令/API 为明文（无 TLS 的固有代价），公网正式使用建议域名+TLS 方案。

- 早前诊断（0.2.1/0.2.2，仍有效保留）：desktopCapturer 单飞队列串行 + 15s 超时 + 屏/窗分步加载；表单禁默认 submit；showViewer 销毁守卫/懒创建/置顶抢焦点；「系统选择器共享…」兜底按钮。

## 服务端部署（公网 VPS）

完整步骤见 [服务端部署指南](docs/服务端部署指南.md)，包含 HTTPS/IP 两种方案、鉴权与防火墙配置、验收、升级回滚及故障排查。
如果已有 Nginx，使用 [已有 Nginx 部署指南](docs/已有Nginx部署指南.md) 和 `deploy/docker-compose.nginx.yml`；只启动 LiveKit 与 Token，复用现有 Nginx 的 HTTPS 入口。
使用 IP、非标准端口和自签名证书时，见 [IP 自签名 HTTPS 部署](docs/IP自签名HTTPS部署.md)，新版客户端支持预先核对证书指纹。

```bash
cd deploy
# 1. 改 caddy/Caddyfile 域名；DNS A 记录指向 VPS
# 2. 改 livekit.yaml 的 keys（openssl rand -hex 32）
# 3. 改 docker-compose.yml 中 token 服务 LIVEKIT_WS_URL / API_KEY / API_SECRET 与之同步
docker-compose up -d
# 防火墙放行：80,443/tcp  7881/tcp  3478/udp  50000-60000/udp
```

客户端「设置 → 服务器地址」填 `https://你的域名` 即可。

## 客户端 API 合同（Token 服务）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/rooms | 建房（roomId/presenter/password?）→ 发布 token + 独立 ownerToken；房间号重复 → 409 |
| GET | /api/rooms | 活跃房间列表（只展示仍有发布者的房间） |
| POST | /api/rooms/:id/join | 进房（口令校验）→ 仅订阅 token |
| DELETE | /api/rooms/:id | 结束房间（请求体必须包含建房时返回的 ownerToken；房间口令不授予删除权限） |

## 回归验证与运行约束

- `cd client && npm test`：HTTP API 集成测试及客户端生命周期回归，覆盖并发建房、删除权限、服务重启、异常房间清理、采集资源释放、连接竞争和退出流程。
- `cd client && npm run test:e2e`：启动隔离的本地 LiveKit、Token 服务及两个 Electron 冒烟客户端，验证实际推流、连续解码帧、删除权限、停止删房和同号重建。需要已有 `tools/livekit-server.exe` 与客户端依赖。
- Electron 无法启动的无桌面环境可运行 `node tests/livekit-e2e.cjs --browser`，使用本机 Chrome/Edge 的无头模式；可通过 `QUICKSHARE_CHROME` 指定浏览器路径。受限测试环境若必须关闭浏览器沙箱，可仅对本地测试加 `--no-sandbox`，常规客户端不关闭沙箱。
- 测试使用临时目录及随机本机端口，不读取或修改日常客户端配置。
- Token 服务目前按**单实例**部署，房间号的串行锁在进程内；横向扩容前需要共享的原子房间占用机制。
- 房主管理凭证只在建房响应中返回；房间元数据保存管理凭证摘要和以服务端密钥生成的口令摘要。Token 服务重启后仍可校验，服务端密钥必须保持一致。升级前创建的旧房间应由发布者重新创建。
- 发布者异常退出后，列表隐藏无发布者房间；后台每 15 秒检查一次，持续无发布者达到 `emptyTimeoutSeconds`（默认 60 秒）后主动删房，即使观众仍在房间中。
- 设置保存会广播到已有窗口；新共享和新观看使用最新设置，已有共享清理时使用建房时的服务器地址和访问令牌。

## 已知边界

- 升级前的房间缺少权限摘要：旧口令房拒绝校验，旧房间拒绝无凭证删除，共享者需要重新建房。
- 房间列表在线人数来自 LiveKit `num_participants`，发布者刚加入时可能短暂显示 0（M2 校准项）。
- 音频共享（系统声音）未实现（M3 可选）。
- Windows 沙箱/无桌面会话下 Electron 无法启动 GUI（本仓库 CI 冒烟走浏览器引擎页路径）。
