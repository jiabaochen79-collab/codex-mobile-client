# 0.4.43

## English

- Reconcile abandoned installation markers with process lifetime, without unlocking a live installer.
- Preserve FIFO send order and notification retries across a computer clock rollback. Detect rewritten log cursors and retain discovered tasks through immediate archival.
- Read large activity logs asynchronously so control requests can continue. Reject a snapshot if its task connection changes during the read.
- Keep plan-revision drafts, new activation-code input, image previews and following-scroll state stable during background refreshes.
- Revalidate visible task pages and their filters. Complete snapshots remove withdrawn messages; expired notifications no longer remain in retained history.
- Preserve unsent attachments when a notification cannot be handled by the existing page. Block sending during attachment removal and ignore secondary pointer buttons.
- Contain keyboard focus in mobile dialogs, refresh cached notification task names and distinguish unactivated, scheduled, active and expired licenses.
- Fence polling initialization after component disposal and preserve network retry/uncertain-outcome handling when a response body disconnects.

Use the full Windows installer for the helper changes. Upgrade retains device identity, passwords and user data and restarts only the helper. The installer is not Windows Authenticode-signed. Chromium/WebKit automation is not an iPhone/Android hardware acceptance test.

## 中文

- 核对残留安装状态与实际进程，避免安装器退出后助手永久冻结；仍阻止安装器运行期间再次安装。
- 修复电脑时间回拨后的队列顺序与通知重试，检测日志覆盖重写，保留立即归档任务的完成监测。
- 大日志活动检查改为异步，避免阻塞控制请求；读取过程中任务连接变化时拒绝旧快照。
- 后台刷新保留计划修改意见、新输入的授权码、图片预览与跟随滚动状态。
- 重新核对已显示任务分页与筛选条件；完整快照移除撤回消息，通知历史移除已过期记录。
- 通知点击无法由当前页面安全处理时打开独立页面，保留未发送附件；移除附件期间禁止发送，右键不发送消息。
- 移动端弹窗约束键盘焦点，刷新通知任务名称，区分未激活、待生效、有效与到期权益。
- 组件退出后不再创建轮询；响应正文中断仍按网络重试或结果待核对处理。

请使用完整 Windows 安装包升级助手。升级保留设备身份、密码与用户数据，只重启助手，不停止 Codex 或正在执行的任务。安装包未进行 Windows Authenticode 签名。Chromium/WebKit 自动化不替代 iPhone/Android 真机验收。
