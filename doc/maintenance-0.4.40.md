# Client Maintenance 0.4.40

This release fixes ten confirmed client defects. It does not change task
execution, permissions, payment settings or the device identity.

| Regression | Change |
| --- | --- |
| B01 | Retain newer unread notifications while loading an older page. |
| B02 | Reject an order-history page from a previous owner or revision. |
| B07 | Restore the installation lock after helper restart; release it only after the installer has confirmed exit. |
| B08 | Detect a large terminal JSONL record even when smaller records follow it. |
| B13 | Restore task-list continuation when a previously exhausted list grows. |
| B14 | Reject message history from an old helper epoch. |
| B15 | Ignore notification pagination after the panel unmounts. |
| B18 | Apply a corrected server clock offset on the first rejected-time retry. |
| B19 | Bound retained image sources to 64 MiB, independently of the encoded cache. Evicted images remain retryable after refreshing the task. |
| B20 | Rotate explicitly watched archived tasks beyond the first 200 watches. |

Regression tests: `tests/maintenance-040.test.ts`,
`tests/maintenance-040-ui.test.ts`, `tests/maintenance-040.spec.ts`.
Existing installation, queue, notification and mobile suites remain part of
acceptance. Browser emulation does not replace physical iPhone/Android testing.

Use `ChatGPT-Remote-Assistant-Setup-0.4.40.exe` for installation or upgrade.
The helper is restarted, not Codex. Device data is retained. The package is
not Windows Authenticode signed; system security prompts may still appear.
