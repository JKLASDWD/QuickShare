# 许可与第三方来源

QuickShare 整体以 **GPL-3.0-or-later** 分发，完整条款见 [LICENSE](LICENSE)。第三方组件保留各自的版权和许可证。软件按现状提供，不提供担保。

## OBS Studio 音频采集

- 项目维护者确认应用声音采集采用了 OBS 的相关代码；对应 QuickShare 文件为 `client/native/process-audio.cpp`。
- 上游：[OBS Studio](https://github.com/obsproject/obs-studio)，版权归 OBS Studio 原作者及贡献者所有；上游项目许可为 **GPL-2.0-or-later**，原文保留于 [licenses/OBS-GPL-2.0.txt](licenses/OBS-GPL-2.0.txt)。
- 对照文件：[plugins/win-wasapi/win-wasapi.cpp](https://github.com/obsproject/obs-studio/blob/cffa83ba552f1ef6a0a05851c3aa07b3811d7e58/plugins/win-wasapi/win-wasapi.cpp)。此提交用于 2026-10-04 的核对，**不是已确认的原始引用提交**；仓库尚未记录最初引用的版本及具体片段，获得记录后应补充并保留其原始版权声明。
- QuickShare 的适配包括独立的进程树采集程序、匿名管道 PCM 输出、窗口生命周期检查及停止处理。程序通过 WASAPI 调用 Windows 系统接口，当前构建不链接或附带 OBS 主程序及 `libobs`。
- 上游允许采用后续 GPL 版本，本项目按 GPL 第 3 版或后续版本分发适配代码；原始代码的许可与作者归属仍予保留。2026-10-04 补充许可与来源声明，未改变音频行为。

## 客户端依赖

| 组件 | 许可 | 来源及随附材料 |
| --- | --- | --- |
| LiveKit Client SDK | Apache-2.0 | [上游](https://github.com/livekit/client-sdk-js)；构建时复制 SDK 及其运行依赖的许可、版权文本和版本清单 |
| Protobuf-ES 1.10.1 | Apache-2.0 AND BSD-3-Clause | [上游版本](https://github.com/bufbuild/protobuf-es/tree/v1.10.1)；npm 包遗漏许可文件，补充原文见 `licenses/bufbuild-protobuf-1.10.1/` |
| Electron | MIT | [上游](https://github.com/electron/electron)；随附 `LICENSE.electron.txt` |
| Chromium 及其组件 | 多种第三方许可 | 随 Electron 附带 `LICENSES.chromium.html` |

LiveKit 的运行依赖清单在构建时从锁定的 npm 包生成，包含各组件的版本、许可、来源及原文文件路径。完整材料随客户端位于 `resources/licenses/`，并附于 Release 的许可 ZIP。未修改这些 npm 依赖；LiveKit、Electron 和 Chromium 的原许可继续适用。

选择 GPL-3.0-or-later 是为了兼容 OBS 的 GPL-2.0-or-later 与 Apache-2.0 依赖。Apache-2.0 与 GPL 第 3 版兼容，与 GPL 第 2 版不兼容，参见 [Apache 官方说明](https://www.apache.org/licenses/GPL-compatibility.html)。

## 服务端与构建工具

LiveKit Server、Node.js、Docker、Caddy、Nginx、Windows SDK、MSVC 和 electron-builder 由部署或构建环境另行取得，保留其各自许可。客户端构建工具不会作为 QuickShare 的业务代码重新许可；Electron 运行时包含的组件以其随附许可清单为准。

## 再分发

1. 保留 `LICENSE`、本文件、第三方许可及原作者声明。
2. 分发客户端时，同位置提供该二进制对应的完整源码、锁文件和构建脚本；修改后分发也须按 GPL 条款提供对应源码，并注明修改。
3. GitHub 自动发布将安装包、对应源码 ZIP、许可 ZIP 与校验值放在同一 Release。源码构建步骤见 [开发指南](docs/开发指南.md)。

源码：[QuickShare 仓库](https://github.com/JKLASDWD/QuickShare)；版本发布与对应源码：[Releases](https://github.com/JKLASDWD/QuickShare/releases)。历史 1.0.0 曾将项目元数据标为 MIT，这不能代替 OBS 衍生部分应遵守的 GPL 条款；已发布版本的补充材料见其 Release 说明。本次更新不撤回此前对项目自身原创部分已合法授予的 MIT 权利，第三方代码始终遵守其原许可。
