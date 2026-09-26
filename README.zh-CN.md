# Codex Mobile Windows 客户端

**用于从手机浏览器继续操作电脑上现有 Codex 任务的 Windows 助手。**

[English](README.md) | 简体中文

本仓库只包含 Windows 助手、原生辅助组件、手机网页、共享协议类型、客户端构建脚本和客户端测试。负责转发已认证连接的远程服务独立运营，**不在本仓库中**。

> 独立的非官方软件，与 OpenAI 无隶属关系，也未获得其背书。Codex 桌面客户端、账号、模型权限及独立运营的远程服务不属于本仓库范围。

## 范围

- 通过本机 IPC 与 Codex 桌面客户端连接，并主动建立认证后的出站连接。
- 手机网页端的项目、会话、模型、附件、计划、排队消息、反馈和通知界面。
- 用于版本显示、桌面发现、电源检查和安装器集成的 Windows 原生辅助组件。
- 客户端更新打包与校验工具。

助手不替代 Codex，不提供通用远程桌面，也不包含模型供应商凭据。本机回环 HTTP 服务属于 Windows 助手的一部分，只用于提供受认证保护的本机页面。

## 仓库边界

以下内容明确排除在仓库之外：

- 远程 relay/服务器实现。
- 部署清单、生产配置、数据库、支付渠道代码和管理员后台代码。
- 服务器密码、私钥、证书及运营秘密。

服务凭据和发布签名私钥必须保存在仓库之外。运行时服务地址通过客户端配置或构建环境注入；它不是服务器源代码。

## 构建要求

- Windows 10 build 19041 或更新版本，x64。
- 构建原生组件需要 .NET Framework 4.8。
- Node.js 22.13 或更新版本。
- 生成安装包需要 Inno Setup。

```sh
npm ci
npm run check
npm run native
npm run build
npm test
```

为 HTTPS 服务地址生成 Windows 安装包：

```powershell
$env:RELAY_URL = 'https://remote.example.com'
npm run package:windows
npm run installer:windows
```

安装包默认未进行 Windows 代码签名，除非另行执行签名步骤。安装前应核对发布方提供的 SHA-256。覆盖升级会保留助手本地身份和用户数据，不会停止 Codex 或电脑上正在执行的任务。

## 安全说明

传输加密保护网络链路，但不等于端到端加密。独立运营的远程服务在会话期间可以处理转发内容。客户端不会主动持久化聊天正文，本仓库不包含服务器凭据或支付密钥。

发现安全问题请私下联系维护者。问题反馈中不要提交密码、Cookie、TOTP 种子、模型凭据、任务正文或私人文件。

## 许可证

原创代码采用 [Apache-2.0](LICENSE)。第三方库和生成的资源保留各自许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
