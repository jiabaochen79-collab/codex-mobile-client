# Mobile plan mode

## Behavior

The phone UI exposes the same two next-turn modes as the desktop client:

- `计划模式` asks Codex to produce a plan and pauses at the implementation confirmation.
- `直接执行` uses the normal task flow for the next turn.

Create a task normally, enter its chat, and open the composer **+** menu, then select **计划模式**. The menu also retains **照片图库**, **拍照**, and **文件**. There is no additional mode dialog or Apply step. The active mode appears as a compact lightbulb / 计划 tag beside +; its close button returns to direct execution. The former header mode button is removed.

The + menu and plan entry remain visible on older, offline, incompatible, view-only, expired, or not-yet-synchronized connections. Unavailable actions show their reason and do not dispatch a command. Availability depends on verified desktop capabilities, not the reported version number.

Changing mode updates only the next-turn collaboration mode and does not interrupt a running turn. The phone sends the task ID, connection epoch, and settings revision through the existing mode.update command. It displays only desktop-confirmed snapshots; toggling, sending, steering, plan submission, and paused-queue resumption remain blocked until a fresh snapshot is read. Rejection, timeout, or disconnection triggers state reconciliation without automatically retrying the write. Drafts, attachments, and reading position are retained. Modes are synchronized separately for each task and computer.

Direct execution does not enable full access or bypass approvals. Both modes retain the task's existing permission policy. New tasks still start with the desktop defaults; this release changes the mode of an opened task, not the initial mode of task creation.

When Codex produces `item/plan/requestImplementation`, the phone shows the plan content and requires an explicit action:

- `实施计划` submits the desktop-compatible `PLEASE IMPLEMENT THIS PLAN:` follow-up in `default` mode.
- `提出修改` submits the entered feedback in `plan` mode so Codex can revise the plan.

The phone does not accept a client-supplied plan as authoritative. The helper reads the current plan, checks its turn and content revision, and rejects stale or already-resolved requests. Viewers, expired subscriptions, pending queues, and incompatible desktop clients cannot dispatch either action.

Pending helper messages wait for plan confirmation and must be removed or handled before submitting the plan. The plan shown on the phone is the pending desktop request, not any unsaved edits in a desktop editor tab. Confirm the displayed content before implementation. Plans above 64,000 characters are left for desktop confirmation rather than silently truncated for execution.

Submission receipts contain only command digests and results, not the plan body. They are retained by plan identity across helper restarts and later settings changes. A timeout is not proof of failure; uncertain submissions are not retried. Resolve those plans on the desktop. The helper does not remove the desktop request or alter its original history to force a retry.

## Compatibility

The feature requires the verified `thread-follower-start-turn` v2 and `thread-follower-update-thread-settings` v1 or v2 interfaces. Older helpers continue to show the plan as unavailable and do not send a fallback approval request. Upgrade to **0.4.6** for Codex 26.908 tool discovery and settings v2 support. Existing device identity, password, remembered access, and subscription data are retained.

The helper subtitle shows **助手 v0.4.6**, independently of the Codex status row. The window title remains unchanged for single-instance activation. The helper runtime, native executable metadata, and installer derive their version from package.json; packaging rejects mismatched builds. The optional helperVersion field in /local/state and remote status is distinct from client.version (Codex). Open the phone chat's **更多操作** menu to inspect both versions. Missing helperVersion is shown as **版本未知**, never inferred from capabilities.

### Upgrade

1. Exit only the remote helper from its Windows tray menu. Leave Codex and its tasks running.
2. Run ChatGPT-Remote-Assistant-Setup-0.4.6.exe over the existing installation, without uninstalling or removing the user data directory.
3. Start the helper and check **助手 v0.4.6** and **服务器已连接**. Reload the phone webpage.
4. Use **新建并进入任务 → + → 计划模式**. Close the plan tag to return to direct execution; this does not approve a pending plan.

## 0.4.4 Verification

246 unit/integration tests passed (including the corrected remembered-session restart case), alongside 85 Chromium and 49 WebKit browser checks. Coverage includes helper-version transport, legacy status frames, rejected/conflicting/uncertain mode changes, fresh-snapshot gating for sends, plan implementation and queue resumption, expired and view-only access, multiple-computer mode/attachment isolation, photo library/camera/files, real HEIC conversion, models, queues, remembered login, and viewport recovery. Composer/menu screenshots were inspected at 320, 390 and 1280 pixels and a keyboard-sized viewport. Native metadata and version labels passed minimum-window and 150% scaling checks.

An isolated real task on Codex 26.901.51231 passed entering chat, enabling plan mode, sending a test requirement, receiving implementation confirmation, and closing the plan tag. The only writes were mode.update, send, mode.update. The plan remained unapproved, and no existing work task was mutated. This desktop browser acceptance is not an iPhone/Android device test; real-phone acceptance remains outstanding.

The final installer was also checked against the subsequently installed Codex 26.903.71938 using an isolated, remote-disabled helper. A temporary public pairing confirmed helper 0.4.4, both plan capabilities, and the free subscription state without reading or writing tasks. The final local installation retained device/password settings and remembered grants, matched the packaged agent and webpage, passed a second-launch single-instance check, and preserved the then-running Codex process.

## 0.4.3 Baseline Verification

243 unit/integration tests, 69 Chromium checks and 34 WebKit checks passed. Tests cover the original request projection, exact native request payloads, stale plans and settings, viewer and subscription restrictions, duplicate and uncertain submissions across restart, queue waiting, Markdown sanitization, drafts, and 320/390/1280-pixel layouts. Additional published-asset checks passed with synthetic authentication and task responses, without remote access to real tasks.

Installed application packages 26.901.51231 and 26.903.61454 were inspected without executing their bundled code. The current 26.901.51231 desktop passed the helper's read-only connection checks. No implementation or mode change was submitted to a real user task; those mutations and iPhone/Android device behavior remain separate user acceptance checks.
