# Codex Mobile 客户端

**让你在手机上继续查看和管理电脑上的 Codex 任务。**

[![最新版本](https://img.shields.io/github/v/release/jiabaochen79-collab/codex-mobile-client?display_name=tag)](https://github.com/jiabaochen79-collab/codex-mobile-client/releases)
[![持续集成](https://github.com/jiabaochen79-collab/codex-mobile-client/actions/workflows/ci.yml/badge.svg)](https://github.com/jiabaochen79-collab/codex-mobile-client/actions)

[English](README.md) | 简体中文

Codex Mobile 是一套独立的 Windows 助手和手机网页客户端，用于继续操作已经在电脑上运行的 Codex 任务。电脑仍然是实际执行任务的环境，手机负责查看进度、处理审批、发送后续需求以及切换不同电脑。

> 本项目是独立的非官方软件，与 OpenAI 没有隶属关系，也未获得其背书。Codex 桌面客户端、账号、模型权限以及独立运营的 relay 服务均属于独立系统。

## 为什么适合日常使用

- **随时处理任务：**无需搬动电脑上的工作环境，即可用手机查看进度并继续对话。
- **可靠的任务控制：**任务执行中可以排队发送、调整方向、停止任务，并保持任务在原电脑上执行。
- **适合计划工作流：**需要确认计划时，可以先在手机上查看并选择后再继续执行。
- **多电脑切换：**把家里、公司和远程电脑加入同一手机设备列表，通过明确授权快速切换。
- **适合手机输入：**支持照片、拍照和普通文件，支持预览、失败重试及 HEIC 照片处理。
- **安静的完成提醒：**通过站内通知以及兼容浏览器的 Web Push 了解任务完成或失败状态。
- **客户端异常恢复：**确认 Codex 异常退出后有限次数自动重开，也可手动恢复或暂停；中断任务及结果不明的消息不会自动重发。[使用说明](doc/client-recovery.md)
- **便于反馈问题：**可以提交问题、截图和经过筛选的诊断信息，默认不会上传任务正文。

## 产品边界

Windows 助手连接本机 Codex 桌面进程，并向独立运营的 relay 服务建立认证后的出站连接。手机网页通过认证会话访问该服务。

本仓库只包含客户端：

- Windows 助手和原生辅助组件。
- 手机网页界面及浏览器资源。
- 共享协议快照和客户端测试。
- Windows 打包及安装器脚本。

本仓库不包含 relay 服务器、运营后台、支付实现、部署清单、生产数据库、服务器凭据、证书或私有签名密钥。服务器源码独立维护，不会随本仓库公开。

## 主要功能

### 手机任务控制

- 查看项目、会话、模型、任务状态、审批请求和执行过程。
- 任务执行中可以立即发送、排队发送后续需求或调整当前方向。
- 需要人工确认时使用计划模式，确认后再继续执行。
- 切换电脑、刷新页面或短暂断线恢复时，保留草稿和附件。

### 文件、照片和通知

- 手机可多选照片、直接拍照或选择普通文件。
- 支持附件预览，弱网上传失败后可以重试。
- 在浏览器流程需要时，本地处理兼容的 HEIC 照片。
- 支持隐私克制的完成和失败提醒，通知文字不包含提示词、回复、命令、文件、密码或模型密钥。

### Windows 集成

- 覆盖升级时保留本地设备身份和记住的授权。
- 当独立服务提供更新清单时，检查并下载经过验证的版本信息。
- 下载完成后由用户确认安装；助手更新不会主动停止 Codex 或正在执行的桌面任务。
- 向手机端报告助手版本和兼容能力。

### 服务权益和问题反馈

- 查看订阅状态、兑换授权码，并在运营者开放购买后在线购买服务权益。
- 运营者开放试用后，符合条件的电脑可领取一次七天试用；资格和到期时间以服务端为准。
- 手机和电脑均可提交问题反馈、选择截图、查看回复及跟进处理结果。
- 服务到期不会停止电脑上已经执行中的 Codex 任务。

## 下载

Windows 安装包和便携压缩包通过 [GitHub Releases](https://github.com/jiabaochen79-collab/codex-mobile-client/releases) 分发。Gitee 镜像入口将在账号及发布资产完成核验后补充。

每个版本都应同时下载 `.sha256` 校验文件，在启动安装包前核对摘要。当前公开安装包未进行 Windows Authenticode 代码签名，Windows 可能显示 SmartScreen 提示，直到后续配置正式签名证书。

## 快速开始

1. 在运行 Codex 桌面客户端的电脑上安装 Windows 助手。
2. 启动助手，并妥善保管设备 ID 和连接密码。
3. 用手机浏览器打开独立运营的 HTTPS relay 地址。
4. 使用电脑上显示的设备凭据完成手机配对。
5. 打开任务后即可使用手机端控制，不要关闭电脑上的 Codex 桌面客户端。

relay 地址、订阅状态和账号策略由具体部署决定，不是本仓库中的服务器凭据，也不会写入公开源码。

## 构建客户端

环境要求：

- Windows 10 build 19041 或更新版本，x64。
- Node.js 22.13 或更新版本。
- 构建原生组件需要 .NET Framework 4.8。
- 生成 Windows 安装包需要 Inno Setup。

```powershell
npm ci
npm run audit:public
npm run check
npm run native
npm run build
npm test

$env:RELAY_URL = 'https://remote.example.com'
npm run package:windows
npm run installer:windows
```

构建会在 `dist/client-web-manifest.json` 中记录客户端网页产物的版本和 SHA-256。独立维护的服务器会先校验该产物再导入，不需要读取客户端源码。

## 隐私与安全

- 服务配置有效证书后，HTTPS 可以保护网络传输链路。
- 认证使用设备身份、连接密码、会话控制和服务器授权。
- 客户端不会主动把聊天记录写入公开仓库，也不会把模型供应商凭据上传到仓库。
- Web Push 不是端到端加密，relay 仍可看到通知元数据；通知内容不会包含任务正文和文件。
- 不要在 Issue 或反馈附件中提交密码、Cookie、TOTP 种子、模型凭据、私人文件或生产日志。
- 传输加密不等于独立运营的 relay 无法处理会话中的转发内容。

## 常见问题

- **电脑离线：**确认 Codex 桌面客户端和 Windows 助手都在运行，再查看助手连接状态。
- **兼容性提示：**升级 Windows 助手。系统会检查实际能力，不会只根据版本号判断兼容性。
- **收不到 Web Push：**继续使用站内通知中心。iPhone 通知需要先完成支持的 Web App 添加流程；Android Chrome 和桌面 Chromium 浏览器在用户授权后可以使用 Web Push。
- **安装器提示：**先核对发布页的 SHA-256。当前安装包未签名，Windows 可能需要用户明确确认。
- **无法连接：**检查 HTTPS 地址、DNS、证书及公司网络策略，不要关闭证书校验。

## 参与贡献

提交修改前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md) 以及客户端仓库边界规则。服务器代码和生产配置必须留在本仓库之外。

## 许可证

原创代码采用 [Apache-2.0](LICENSE)。第三方库和生成资源保留各自许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

