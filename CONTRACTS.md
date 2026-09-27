# Shared Contract Snapshot

`src/shared/` is a vendored snapshot from the local-only `codex-mobile-contracts` repository. It contains the wire protocol and validation types required to build the client independently.

客户端可以独立克隆和构建。协议文件的唯一维护来源是本机的 `codex-mobile-contracts` 仓库；只有协议变更需要将经过验证的快照同步到客户端和服务器工作区。客户端界面、Windows 助手和服务器实现不通过此文件自动耦合。

The public client repository does not contain the relay implementation, deployment files, administrator backend, payment secrets, or production configuration.
