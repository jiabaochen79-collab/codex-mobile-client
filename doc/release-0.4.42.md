# 0.4.42

## English

- Completion events appended after the capture baseline are no longer discarded when the computer clock moves backwards. Empty-file baselines are persisted and survive helper restarts.
- The helper retries a temporarily unavailable computer identity without requiring a reconnect.
- Notification HTTP read receipts protect against delayed unread rows. Outdated Push status responses no longer overwrite a successful registration, and foreground recovery preserves loaded notification history.
- Feedback conflicts preserve editable drafts instead of locking the form. Older unread queries cannot restore a cleared feedback badge.
- Background subscription reads preserve explicit activation and trial-claim errors. Changed purchase details require renewed confirmation.

Install the full Windows installer to update the background monitor. Device identity, passwords and user data are retained. Only the helper restarts; existing Codex processes and tasks are not stopped. The installer is not Windows Authenticode-signed.

## 中文

- 修复电脑时间回拨后漏报任务完成通知；保存空文件监测基线，支持助手重启恢复。
- 电脑标识临时读取失败后自动重试，无需断开连接。
- 修复通知已读状态及系统推送注册状态被旧响应覆盖；从后台返回时保留已加载的通知历史。
- 反馈提交冲突后保留可编辑草稿，修复反馈未读点错误恢复。
- 后台刷新不再清除授权激活或试用领取失败原因；套餐信息变化后需要重新确认购买。

请使用完整 Windows 安装包更新后台监测能力。升级保留设备身份、密码与用户数据，只重启助手，不停止 Codex 进程或正在执行的任务。安装包未进行 Windows Authenticode 签名。
