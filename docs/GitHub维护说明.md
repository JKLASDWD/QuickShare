# QuickShare GitHub 维护范围

目标仓库名称：`QuickShare`，公开。公开仓库只保存可复现项目的源码、配置模板、文档和测试。

## 需要提交维护的文件

| 范围 | 文件 | 原因 |
| --- | --- | --- |
| 客户端源码 | `client/main.js`、`preload.js`、`renderer/*.html` | 应用行为、窗口、采集和观看逻辑 |
| 客户端构建 | `client/package.json`、`package-lock.json`、`scripts/` | 依赖版本与构建脚本；锁文件必须与依赖更新一起提交 |
| 客户端配置模板 | `client/config.example.json` | 共享默认字段，实际访问令牌保留在本地配置 |
| 调试入口 | `client/调试启动.bat` | 维护 Windows 调试方式 |
| 服务端 | `server/token-service/server.mjs`、`Dockerfile` | Token API 与容器构建 |
| 服务端配置模板 | `server/token-service/config.example.json` | 提供本地开发默认配置和容器初始配置 |
| 部署模板 | `deploy/docker-compose*.yml`、`livekit.yaml`、`caddy/Caddyfile`、`nginx/*.example`、`.env.example` | 可复现部署方式，只允许示例域名和开发密钥占位值 |
| 文档 | `README.md`、`docs/`、`tools/README.md` | 使用、部署、架构与维护说明 |
| 测试 | `tests/` | 可重复运行的 API、生命周期与媒体回归 |
| CI 与 Git 规则 | `.github/workflows/ci.yml`、`.gitignore`、`.gitattributes` | 自动验证、排除敏感内容和固定文本换行 |
| 第三方许可材料 | `tools/LICENSE` | 保留第三方许可文本 |

## 不提交到源码仓库的内容

| 内容 | 当前位置或模式 | 处理方式 |
| --- | --- | --- |
| 依赖 | `client/node_modules/` | 从锁文件运行 `npm ci` 安装 |
| 构建产物 | `client/dist/` | 如需分发，上传 GitHub Release，不能直接提交进 Git 历史 |
| LiveKit 可执行文件 | `tools/livekit-server.exe` | 从官方 Releases 获取 |
| 第三方浏览器包 | `client/renderer/vendor/` | `npm ci` 的 postinstall 从依赖复制 |
| 自动生成图标 | `client/assets/icon.png` | postinstall 通过 `scripts/gen-icon.mjs` 生成 |
| 实际客户端配置 | `client/config.json` 或用户配置目录 | 保存真实服务器和访问令牌，仅本地管理 |
| 实际服务端 JSON | `server/token-service/config.json` | 可选本地覆盖配置，不进入 Git |
| 部署秘密 | `.env`、证书和私钥 | 部署服务器管理，避免任何公开提交 |
| 备份和压缩包 | `OBS.rar`、`*.zip`、`*.7z`、`*.tar.gz` | 保留本地或受控备份存储 |
| 日志、缓存 | `*.log`、`coverage/` 等 | 运行生成，不进入 Git |

`.gitignore` 不会阻止对已跟踪文件的修改。例如 `livekit.yaml` 是部署模板，若在源码目录里填入真实密钥，它仍会被 Git 检测到。生产配置建议维护在独立部署目录，每次提交都要检查差异；不要把生产部署目录整体复制回源码仓库。

## 从干净克隆恢复项目

1. 安装 Node.js 24；进入 `client`，运行 `npm ci`。该命令自动生成 vendor 包与图标。
2. 本地 Token 服务默认读取本地 `config.json`；不存在时回退到已维护的 `config.example.json`。
3. 如需本地覆盖配置，复制服务端 `config.example.json` 为 `config.json` 后修改。该文件已被忽略。
4. Docker 镜像复制 `config.example.json` 为容器内 `/app/config.json`，因此干净克隆不依赖未跟踪的本地配置文件。
5. 生产参数通过环境变量或显式的 JSON 挂载传入，具体步骤见 [服务端部署指南](服务端部署指南.md)。

## 自动验证

CI 在 `main` 推送、Pull Request 和手工触发时，分别使用 Linux 与 Windows runner、Node.js 24 执行语法检查和回归测试。它只需要 Node.js 内置模块，不安装 Electron，也不需要部署密钥。

本地执行同一套回归：

```powershell
node --test tests/review-regression.test.cjs
```

真实媒体测试仍在安装了 LiveKit 与客户端依赖的开发电脑运行。CI 通过不能替代实际 Windows 采集、打包以及公网媒体联调。

工作流使用的 Action 来源：[actions/checkout](https://github.com/actions/checkout)、[actions/setup-node](https://github.com/actions/setup-node)。

## 日常提交与发布

```powershell
git status --short
git diff
git add <本次修改的文件>
git diff --cached
git commit -m "描述本次行为变化"
git push
```

提交前确认没有真实令牌、服务器秘密、私钥或带凭证的 URL；`.env.example` 中的秘密字段保持为空，LiveKit 示例只保留明确的开发占位值。

客户端版本发布时，同时维护 `package.json` 与锁文件的版本信息，运行回归和实际媒体测试，再构建安装包。将安装包和发布说明放入 GitHub Releases，注明匹配的服务端版本；当前删除房间协议使用 `ownerToken`，旧客户端需要同步升级。

仓库创建和首次推送需要 GitHub 账号连接与写权限。仓库公开不等于已选择开源许可证；当前客户端 package 声明 MIT，但项目根目录没有许可证正文，首次发布前后应由作者明确整个项目的授权范围，不能用第三方 `tools/LICENSE` 代替项目许可。
