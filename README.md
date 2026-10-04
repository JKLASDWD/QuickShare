# QuickShare

QuickShare 是一款支持自托管部署的 Windows 屏幕共享应用，提供屏幕与窗口共享、音频传输、房间聊天及弹幕显示功能。用户通过房间号加入共享会话，服务端由部署者自行管理。

当前版本：**1.0.0**。客户端基于 Electron，服务端由 LiveKit 与 Node.js Token 服务组成。

[下载客户端](https://github.com/JKLASDWD/QuickShare/releases/latest) · [构建状态](https://github.com/JKLASDWD/QuickShare/actions/workflows/build.yml) · [许可声明](THIRD_PARTY_NOTICES.md)

## 主要功能

- **屏幕与音频共享**：共享屏幕或单个窗口，可选择应用音频、系统音频或麦克风。
- **画面与播放设置**：配置共享清晰度及帧率，观看端可独立关闭音频播放。
- **房间交互**：查看成员列表、发送文字消息，并通过可调整大小的透明悬浮窗显示聊天记录。
- **客户端管理**：支持房间口令、系统托盘、快捷键及诊断日志。

## 部署与使用

1. 在 Linux 服务器获取源码，执行交互式部署脚本：

   ```bash
   git clone https://github.com/JKLASDWD/QuickShare.git
   cd QuickShare
   bash deploy/install.sh
   ```

2. 按提示选择部署方式并完成配置，根据部署指南放行所需端口。脚本支持域名 HTTPS、IP 自签名 HTTPS、内网 HTTP 及已有 Nginx 环境。
3. 从 [Releases](https://github.com/JKLASDWD/QuickShare/releases/latest) 下载发布说明中推荐的客户端，在 Windows 上运行便携版或安装版。
4. 在客户端设置中填写部署脚本输出的服务地址，以及服务端 `deploy/.env` 中的 `AUTH_TOKEN` 访问令牌。
5. 共享端选择屏幕或窗口并开始共享；观看端使用房间号加入会话。

服务器环境、端口要求及具体配置步骤参见 [服务端部署指南](docs/服务端部署指南.md)。

## 文档索引

| 内容 | 文档 |
| --- | --- |
| 服务端部署、Nginx 集成、更新与故障排查 | [服务端部署](docs/服务端部署指南.md) |
| 基于 IP 地址的自签名 HTTPS 部署 | [IP 自签名 HTTPS](docs/IP自签名HTTPS部署.md) |
| Cloudflare DNS 与橙云代理配置 | [Cloudflare 部署](docs/Cloudflare部署指南.md) |
| 音频、弹幕、快捷键与日志操作 | [使用说明](docs/使用说明.md) |
| 源码运行、客户端构建与版本发布 | [开发指南](docs/开发指南.md) |

应用音频采集受 Windows 系统版本及目标应用支持情况限制；独占全屏模式可能影响弹幕显示，建议采用无边框全屏模式。具体适用条件参见使用说明。

## 构建与发布

GitHub Actions 在 `main` 分支更新后自动构建 Windows 客户端。推送与项目版本一致的 `v*` 标签后，工作流自动发布安装包、对应源码、许可材料及 SHA-256 校验文件。操作步骤参见 [开发指南](docs/开发指南.md#5-github-自动构建与发布)。

## 许可证

QuickShare 采用 [GNU General Public License v3.0 或后续版本（GPL-3.0-or-later）](LICENSE)。应用音频采集组件使用并适配了 OBS Studio 的相关实现；OBS 原有的 GPL-2.0-or-later 许可及第三方组件各自的版权与许可声明予以保留。

再分发本项目或修改版本时，应遵守适用的 GPL 条款，提供对应源码并保留相关许可材料。代码来源与组件许可参见 [第三方组件与许可声明](THIRD_PARTY_NOTICES.md)。
