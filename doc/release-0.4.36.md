# 0.4.36 Maintenance Release

## Changes

- Report native plan rejections accurately and allow a safe explicit retry.
- Restore older-message pagination when opening a task from a notification.
- Fill missing history pages after a long disconnect without losing the
  reading position or merging another task's response.
- Preserve historical image references beyond 500 images and IPC reconnects.
- Load recent tasks before scanning all projects; rotate activity reads and
  always include the selected task.
- Discover models asynchronously with a short-lived cache, leaving control
  requests and local health checks responsive.
- Keep newer subscription state when an older HTTP response arrives.
- Keep pending approvals tracked when checking whether installation is safe.
- Refresh already-loaded service records, preserving another refund draft
  when an earlier request completes late.
- Require a successful notification-settings read before edits; reconcile
  concurrent settings changes and cross-terminal read receipts.
- Allow correction of rejected screenshot uploads without discarding text.
- Refresh trial eligibility after reconnecting and include only whitelisted
  Codex version and connection error codes in feedback diagnostics.

## Upgrade

Install `ChatGPT-Remote-Assistant-Setup-0.4.36.exe` over the existing helper.
The upgrade retains device credentials, remembered authorizations and data;
it restarts the helper, not Codex. Pending uploads, queued messages and
approvals must be resolved before installation.

This installer is not Windows Authenticode signed. Browser-engine tests do
not replace physical iPhone/Android or real background-push acceptance.
