# Windows Helper 0.4.32

- Recover complete attachments after a file-finalization/database interruption.
- Keep verified downloaded updates ready; retry readiness reporting after reconnection.
- Bound update checks separately from package downloads and keep installation dialogs synchronized.
- Protect desktop settings, notification badges and payment views from late responses.
- Preserve password input on backdrop taps; show accurate unchecked-update and disabled-trial states.
- Prioritize recent task images and support Unicode case-insensitive search.
- Use optional task-list snapshot cursors to avoid missing tasks when their ordering changes during pagination.
- Refresh feedback unread state for the native help menu.

Windows local data remains SQLite. No server, administration, payment implementation or production database code is part of this client build. Existing task execution, device identity, permissions and pricing are unchanged.

The installer is not Windows Authenticode-signed. Package verification uses SHA-256 and release signatures for the online-update chain; it does not remove SmartScreen warnings.
