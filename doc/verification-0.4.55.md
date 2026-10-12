# 0.4.55 Native Goal Mode Verification

Date: 2026-10-13.

## Implementation

- Explicit Goal Mode choice in the mobile Add Content picker and New Task dialog.
- Native `/goal` submission through existing create, send and durable queued send.
- Validated task-bound native goal snapshots and compact collapsible goal details.
- Versioned `goal.pause` through the task-wide native interrupt, without replacing
  the existing turn-scoped stop operation.
- Task-bound goal drafts, uncertain submission retention and logout cleanup.
- Explicit capability discovery from the installed application's literal native
  goal routes and compatible send/interrupt contracts.
- Client/server/contracts protocol snapshots synchronized. No database migration.

## Automated Verification

- Client: 584 unit/native tests and 110 component tests passed.
- Chrome: 47 mobile plan/permission/goal interaction tests passed.
- WebKit: six goal workflow tests passed, including new task, reload, pause,
  actual termination labels, plan-switch rejection and 320/390px layout.
- Server: 462 tests passed; 52 MySQL-specific tests skipped by its default runner.
- Subscription transport: ten focused tests passed after adding goal pause
  after expiry and viewer denial assertions.
- Client/server type checks and client native build passed.

Service Worker registration is blocked only in the intercepted browser fixture,
so mocked HTTP requests are not bypassed by a worker. This does not change product
Service Worker behavior or constitute real-device PWA acceptance.

## Native Runtime Evidence

Installed application: 26.1007.21434. Isolated existing acceptance task:
`01a11ee8-6a17-7cc1-b43e-fc147d69fba2`.

A genuine native goal completed two distinct assistant turns while the adapter
was disconnected for 45 seconds. Automatic continuation belongs to Codex rather
than the mobile browser. The production 0.4.55 adapter branch then paused a
separate active goal and read back the same objective with status `paused`.

The pause receipt used native interrupt version 4 with `mode: user-stop` and
`expectedTurnId: null`. A subsequent explicit message completed the same goal.
This verifies message-based continuation, not a separate native resume API;
no resume/edit/clear controls or arbitrary budget controls are advertised.

## Limits

Physical iPhone/Android acceptance and installed-helper verification are not
established by desktop browser tests. Packaging, deployment and local installation
results must be recorded separately after those operations succeed.
