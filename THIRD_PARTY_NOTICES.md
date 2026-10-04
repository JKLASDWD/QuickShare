# 第三方组件与许可声明

本文件记录 QuickShare 使用的第三方组件、来源、版权归属及许可材料。各组件的权利与义务以其完整许可文本为准；本文件不替代或修改相关许可条款。

## 项目许可

QuickShare 整体采用 **GNU General Public License v3.0 或后续版本（GPL-3.0-or-later）** 分发，完整条款见 [LICENSE](LICENSE)。第三方组件保留各自的版权及许可。软件按现状提供，担保与责任限制以适用许可条款为准。

## OBS Studio 音频采集组件

QuickShare 应用音频采集组件使用并适配了 OBS Studio 的相关实现，对应文件为 `client/native/process-audio.cpp`。

| 项目 | 说明 |
| --- | --- |
| 上游项目 | [OBS Studio](https://github.com/obsproject/obs-studio) |
| 版权归属 | OBS Studio 原作者及贡献者 |
| 上游许可 | GPL-2.0-or-later |
| 随附许可文本 | [OBS GPL 第 2 版许可原文](licenses/OBS-GPL-2.0.txt) |
| 本项目适配代码的分发许可 | GPL-3.0-or-later，保留上游来源与版权归属 |
| 上游相关实现 | [plugins/win-wasapi/win-wasapi.cpp](https://github.com/obsproject/obs-studio/blob/master/plugins/win-wasapi/win-wasapi.cpp) |

适配组件通过 Windows WASAPI 采集目标进程树的音频，并通过匿名管道输出 PCM 数据。客户端不链接或附带 OBS 主程序及 `libobs`。

## 客户端第三方依赖

| 组件 | 许可 | 来源与许可材料 |
| --- | --- | --- |
| LiveKit Client SDK | Apache-2.0 | [上游项目](https://github.com/livekit/client-sdk-js)；构建时收集 SDK 及运行依赖的许可、版权文本与版本清单 |
| Protobuf-ES 1.10.1 | Apache-2.0 AND BSD-3-Clause | [上游版本](https://github.com/bufbuild/protobuf-es/tree/v1.10.1)；许可文本见 [版本许可目录](licenses/bufbuild-protobuf-1.10.1/) |
| Electron | MIT | [上游项目](https://github.com/electron/electron)；客户端随附 `LICENSE.electron.txt` |
| Chromium 及其组件 | 各组件适用的第三方许可 | 随 Electron 附带 `LICENSES.chromium.html` |

构建流程依据锁定的 npm 依赖生成运行依赖清单，记录组件名称、版本、许可、来源及许可文件路径。Protobuf-ES 的 Apache 许可文本与 Google BSD 版权及许可声明保留于上述版本许可目录。

项目许可、OBS 来源说明及 npm 依赖许可材料随客户端存放于 `resources/licenses/`；Electron 与 Chromium 的许可文件位于客户端分发目录。发布版本同时提供许可 ZIP。上述 npm 依赖未经本项目修改，其原有许可继续适用。

## 服务端与构建环境

LiveKit Server、Node.js、Docker、Caddy、Nginx、Windows SDK、MSVC 及 electron-builder 由部署或构建环境另行获取，并适用各自的许可条款。本项目的许可声明不改变上述软件及工具的许可；Electron 运行时所含组件的许可信息以随附清单为准。

## 再分发要求

再分发本项目或修改版本时，应遵守适用许可条款：

1. 保留 `LICENSE`、本文件、第三方许可文本及相关版权声明。
2. 按 GPL 条款提供与所分发二进制对应的完整源码，包括锁文件及构建脚本；分发修改版本时，应提供对应的修改后源码并标明修改。

官方 [Releases](https://github.com/JKLASDWD/QuickShare/releases) 提供安装包、对应源码、许可材料及校验文件。构建步骤参见 [开发指南](docs/开发指南.md)。
