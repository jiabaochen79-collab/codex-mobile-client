# Changelog

Dates describe development baselines, not a guarantee that a public binary release exists.

## Unreleased

### Fixed

- Remove the desktop attachment envelope from the mobile presentation while preserving attached images and the user's actual request.
- Keep reasoning summaries and execution stages visible; render each long tool command as a compact, independently expandable row.
- Preserve the full Windows device state when a manual update check returns only update status, preventing the helper from crashing with a missing dictionary key.
- Migrate the Tencent deployment and Windows public package to `remote.chatgptvip.asia` on `43.133.82.43`, using standard HTTPS/WSS on port 443 with Caddy-managed automatic certificate renewal.
- Identify connection resets during helper registration separately from generic network failures; avoid attributing them to local firewall or proxy settings without evidence.
- Correct a displaced mobile fixed-position origin independently of viewport height and document scroll, release the correction after recovery, and keep keyboard and pinch-zoom behavior intact.
- Set root-page scroll restoration before the app bundle and remembered authentication load; remove the redundant fixed-position body layer.
- Verified after migration by public HTTPS health checks, certificate inspection, WSS handshake, Origin isolation, database integrity and migration-digest comparison; the full local suite passes 297/297 tests. Real iPhone suspension and cellular-network acceptance remain separate checks.

## 0.4.19 - 2026-09-23

### Fixed

- Read the Windows model menu from the installed Codex catalog so the mobile model list matches the computer, including native visibility and priority ordering.
- Fall back to the local model cache when an older Codex build does not support the catalog command, while keeping hidden models out of the mobile list.

## 0.4.18 - 2026-09-23

### Fixed

- Persist follow-up messages in the Windows helper before acknowledging queued sends, so closing the mobile browser does not remove accepted work.
- Retry temporary relay and helper authorization transport failures without converting a durable queue item into a false pause.
- Rebuild the Windows installer and runtime from one package version.

## 0.4.17 - 2026-09-22

### Fixed

- Distinguish failed update checks from download, verification, and rollback-package failures; retry failed checks after the server reconnects.
- Clear stale update details and pending retries after a successful check, record the check time, and restore the retry budget.
- Shorten the Windows Help and tray feedback entry to "问题反馈", retaining the unread-reply indicator.

## 0.4.11 - 2026-09-16

### Fixed

- Forward feedback responses through the Windows helper without reparsing them, preventing a completed state change from being reported as failed.
- Reconcile feedback state after an uncertain response so resolved, closed, and reopened tickets display the server-confirmed result.
- Show and enforce the five-character audit-record minimum before an administrator submits a ticket status change.

### Verification

- Added device-scoped state transition, Windows proxy, uncertain-response UI, and administrator validation coverage; all 304 unit and integration tests pass.

## 0.4.10 - 2026-09-16

### Fixed

- Complete the operations UI for feedback tickets: show user messages and private attachments, reply, add internal notes, close, reopen, and refresh ticket details.
- Add signed Windows installer upload with resumable chunks, SHA-256 verification, and explicit rollback-package support for online updates.
- Register the Windows computer fingerprint before trial eligibility checks and enforce one-time trial use across paid, invited, and self-service entitlements.

### Verification

- Added regression coverage for feedback visibility and state transitions, release rollback/candidate selection, and trial reuse and identity-conflict boundaries.

## 0.4.7 - 2026-09-14

- Show actionable server connection errors in the Windows helper and local web panel, distinguishing registration, DNS, timeout, TLS, and Windows credential storage failures.
- Preserve WebSocket handshake HTTP errors and record only failure stages and fixed error codes in the local helper log; clear the error after a successful reconnect.
- Retain certificate validation, device identities, remote authorization defaults, and automatic reconnect behavior.

## 0.4.6 - 2026-09-12

- Discover the separate app-tool pipe used by Codex 26.908 without relying on inherited environment variables or CLI arguments.
- Verify the pipe server belongs to the current user's selected Codex process and probe only the read-only tool catalog; reject unrelated, ambiguous, malformed, or unresponsive endpoints.
- Support verified v1/v2 next-turn model and plan-mode settings, checking the v2 applied acknowledgement without changing active-turn permissions.
- Preserve the existing installer confirmation flow, helper identity, remembered grants, and subscriptions. No server update is required.

## 0.4.5 - 2026-09-12

- Fix mobile browser resume recovery for Android and iOS lifecycle event ordering and stale viewport measurements.
- Restart a crashed Windows Agent with bounded backoff and record redacted local recovery events.
- Preserve a historical Codex thread as the project context when no active thread remains, and sort mixed timestamp indexes correctly.
- Report unknown command outcomes after relay or computer disconnects instead of silently dropping them.
- Stream attachment hashing and validate the live TLS certificate after certificate reload.
- Pin the patched `urllib` dependency and add redacted relay event observability.

## 0.4.4 - 2026-09-10

### Added

- Put photo library, camera, files, and plan mode in the composer's + menu. Enable plan mode in one tap and close it from the inline plan tag; remove the duplicate header selector.
- Keep plan mode discoverable on legacy, offline, incompatible, and view-only helpers with explicit unavailable states.
- Show the helper version separately from Codex in Windows and mobile connection details, using an optional helperVersion status field for backward compatibility.
- Derive native metadata, helper runtime, and installer versions from package.json and reject mixed-version Windows packages.

### Safety

- Confirm mode changes from fresh desktop snapshots before enabling the next send, including timeout and reconnect recovery without resubmission.
- Preserve normal task creation, running tasks, drafts, attachments, permissions, and per-computer authorization during mode changes and upgrades.

## 0.4.3 - 2026-09-10

### Added

- Add mobile plan mode and direct execution mode switching, with the current task mode synchronized to the desktop client.
- Render desktop plan implementation requests on the phone with explicit implement and revise actions.

### Safety

- Validate plan identity, turn, content revision, control lease, subscription, queue state, and desktop capability before dispatch.
- Keep uncertain plan submissions non-retryable until the desktop result is verified, and pause queued messages while a plan confirmation is pending.

### Verification

- 243 unit/integration tests, 69 Chromium mobile tests, and 34 WebKit mobile tests passed, including multiple computers, photos, real HEIC conversion, models and remembered access.
- Real installed Codex packages 26.901.51231 and 26.903.61454 were inspected read-only; no real task was started, stopped, steered, or approved.

## 0.4.2 - 2026-09-10

### Fixed

- Replace the single desktop-build allowlist with read-only installed-protocol, index, and live-connection checks; disable only the affected write features when their contracts change.
- Reconcile stale mobile `dvh`, window, and visual-viewport measurements after long background suspension, and provide bounded local layout diagnostics without exporting user content.
- Show the detected application version and concrete compatibility failure in both Windows and local web views.
- Reject malformed IPC acknowledgements rather than reporting uncertain writes as successful, and retain phone-side read markers without forging the new v3 desktop identity context.
- Prevent cold mobile reloads and delayed browser history restoration from leaving the entire page scrolled above an empty bottom region. Keep root scrolling locked only while authenticated, while preserving internal scrolling, keyboard handling, and login-page access.

### Added

- Browser-scoped saved computers with independent authorization, names, ordering, removal, and sign-out across all saved computers.
- One-tap switching with per-computer drafts and reading positions, explicit upload cancellation, and independently targeted browser tabs.

### Safety and Compatibility

- Bind mobile HTTP, images, uploads, WebSockets, subscriptions, and orders to an explicitly authorized computer.
- Preserve existing authorization expiry when importing a legacy login; retain legacy client access until its original grant expires or is revoked.
- Migrate the legacy tab controller identity on refresh, so an upgrade does not demote the existing controller to view-only mode.
- Switching releases only that page's control lease, without stopping desktop tasks or revoking queued-message authorization.
- Update Windows helpers to 0.4.2 for adaptive desktop checks, and refresh the mobile web assets. Device identity, authorization, queues, and subscriptions are retained.

### Verification

- Local verification: 222 unit/integration tests, 74 Chromium browser tests, and 31 WebKit checks passed, including actual HEIC conversion, viewport recovery, and isolated payment workflows.
- Inspected actual application packages 26.901.51231 and 26.903.61454. The self-contained Windows package passed a read-only worker startup probe; live task mutations on the other computer remain a separate acceptance check.
- Production verification used temporary authorization and read-only project access. Real phone acceptance remains separate.

## 0.4.1 - 2026-09-09

### Fixed

- Confirm running indicators against the desktop's live state instead of unfinished historical events.
- Treat explicit idle runtime state as authoritative over orphaned in-progress turns, without imposing an age timeout on real long-running tasks.
- Keep projects collapsed when no running task is confirmed, preserve manual expansion, and stop trusting history-derived indicators from older helpers.
- Keep the mobile project list pinned to the usable viewport after browser suspension, including stale root scrolling and search-keyboard transitions.
- Expand projects with running tasks on entry or resume, including tasks beyond the first list page, while preserving manual choices during ordinary refreshes.

### Upgrade

- Update the Windows helper to 0.4.1 and refresh the mobile web page. Existing device identity, authorization, queues, and subscriptions are retained.
- Local verification: 189 unit/integration tests and 54 Chromium browser tests passed.

### Added

- English and Simplified Chinese project documentation.
- Contributor and security policies, issue and pull request templates, and a public-release checklist.
- Apache-2.0 licensing for original code and retained third-party attributions.
- Windows CI for native compilation, type checks, unit/integration tests, and production builds.

## 0.4.0 - 2026-09-09

### Added

- Persistent helper-owned follow-up queues with cancellation and explicit resume.
- Text-only steering of an active native turn without stop-and-restart simulation.
- Composer actions that switch between stopping work and queueing a message.

### Safety and Compatibility

- Pending work pauses after interruption, revoked authorization, desktop instance changes, or uncertain delivery.
- Queued attachments remain available until released; confirmed archived or deleted tasks release queue entries.
- Temporary read failures do not delete queues or make uncertain messages eligible for automatic resend.
- End-to-end encryption was evaluated and deferred. HTTPS/WSS and existing authorization remain in place.

### Verification

- Local baseline: 177 unit/integration tests and 43 browser tests passed.
- Real task mutations, phone-specific behavior, independent security review, code signing, and payment settlement remain separate acceptance gates.

## 0.3.0 - 2026-09-08

- Added administration, TOTP, dynamic pricing, official payment integrations, reconciliation, and refund workflows.
- Kept real payment acceptance disabled pending operational prerequisites.

## 0.2.x - 2026-09-08

- Added invitation-based subscriptions, Windows installation and power-policy warnings, and remembered browser authorization.
- Improved photo selection, HEIC conversion, conversation images, model settings, multi-terminal control, and viewport recovery.

Earlier development and compatibility evidence remains in `doc/`.
