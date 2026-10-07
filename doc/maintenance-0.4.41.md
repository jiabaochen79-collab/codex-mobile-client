# Client Maintenance 0.4.41

This release closes five confirmed client defects without changing task
execution, permissions, billing, device identity or the communication protocol.

| Area | Change |
| --- | --- |
| Order history | Discard a multi-page refresh if any later page changes owner or history revision; restart pagination from the validated first page. |
| Notifications | Ignore stale unread-count snapshots and delayed read receipts, while retaining newer events. |
| Task directory | Replace the loaded list when an authoritative refresh has no further pages; retain older loaded pages for partial refreshes. |
| Result visibility | Parent device, pairing, subscription and confirmation dialogs block seen receipts and external-push suppression. |
| Trial reminders | Clear a reminder from the previous phase or device before applying a stored reminder receipt. |

Regression coverage extends `tests/maintenance-040-ui.test.ts` and
`tests/maintenance-040.spec.ts`. Client logic/native: 392 passed; compiled
Vue: 91 passed. Browser runs include 320px/390px, keyboard-sized and desktop
viewports. These tests are not physical iPhone/Android acceptance.

Install or upgrade with `ChatGPT-Remote-Assistant-Setup-0.4.41.exe`.
Only the helper is restarted, not Codex. Device data is retained. The package
is not Windows Authenticode signed; system security prompts may still appear.
