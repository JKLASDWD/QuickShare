# QuickShare

自托管的 Windows 屏幕共享工具。共享屏幕或窗口，让其他成员通过房间号观看、聊天。

当前版本：**1.0.0**。客户端使用 Electron，服务端使用 LiveKit 和 Node.js。

[下载客户端](https://github.com/JKLASDWD/QuickShare/releases/latest) · [自动构建](https://github.com/JKLASDWD/QuickShare/actions/workflows/build.yml)

## 功能

- 屏幕、窗口共享，支持应用声音、系统声音和麦克风。
- 可选清晰度与帧率，观看端可关闭声音。
- 房间成员、文字聊天、透明弹幕，可调整大小或随时关闭。
- 房间口令、托盘、快捷键和诊断日志。

## 快速开始

1. 在 Linux 服务器下载并解压源码，在项目根目录执行：

   ```bash
   bash deploy/install.sh
   ```

2. 按提示选择部署方式，放行相应端口。已有配置会复用。
3. 在 Windows 运行 `QuickShare-Portable-1.0.0.exe` 或安装 `QuickShare-Setup-1.0.0.exe`。
4. 在客户端设置服务器地址和服务器 `deploy/.env` 中的 `AUTH_TOKEN`。
5. 一台电脑选择屏幕或窗口开始共享，其他电脑选择房间进入观看。

## 文档

| 需要做什么 | 文档 |
| --- | --- |
| 部署、已有 Nginx、内网、更新和排障 | [服务端部署](docs/服务端部署指南.md) |
| 没有域名，使用 IP + HTTPS | [IP 自签名 HTTPS](docs/IP自签名HTTPS部署.md) |
| 使用 Cloudflare 橙云代理 | [Cloudflare 部署](docs/Cloudflare部署指南.md) |
| 声音、弹幕、快捷键和日志 | [使用说明](docs/使用说明.md) |
| 从源码构建和打包 | [开发指南](docs/开发指南.md) |

应用声音需要满足系统支持条件；独占全屏游戏可能遮挡弹幕，建议使用无边框全屏。具体边界见使用说明。

推送 `main` 后 GitHub Actions 自动编译 Windows 客户端；推送与版本一致的 `v*` 标签后自动发布安装包。[构建与发布步骤](docs/开发指南.md#5-github-自动构建与发布)。

## 许可证

本项目采用 [GPL-3.0-or-later](LICENSE)。应用声音采集采用了 OBS Studio 的相关代码，保留其 GPL-2.0-or-later 来源声明；依赖保留各自许可。详细来源见 [第三方说明](THIRD_PARTY_NOTICES.md)。分发客户端及修改版时，须按 GPL 条款同时提供对应源码和许可材料。
