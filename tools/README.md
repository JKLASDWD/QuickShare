# 本地 LiveKit 开发工具

此目录只维护说明与第三方许可证，不提交 `livekit-server.exe`。

从 [LiveKit 官方 Releases](https://github.com/livekit/livekit/releases) 下载所需版本的 Windows x64 服务端，解压后将程序放到 `tools/livekit-server.exe`。本项目此前本地媒体联调用的是 1.13.7；使用其他版本需要重新运行端到端测试。

```powershell
.\tools\livekit-server.exe --version
.\tools\livekit-server.exe --dev
```

`--dev` 仅用于本地测试。服务器正式部署使用 `deploy/` 的容器配置，不上传 Windows 工具到 VPS。`LICENSE` 保留本地第三方工具的许可证文本；重新分发第三方程序时应随附对应版本的许可材料。
