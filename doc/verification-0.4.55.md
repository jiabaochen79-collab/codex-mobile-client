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

## Delivery Results

- Client source commit: `d134b83`; server protocol commit: `a07a2aa`; local
  contract source commit: `2f48918`. No Git remote was pushed.
- EXE: `release/ChatGPT-Remote-Assistant-Setup-0.4.55.exe`, 43,018,104 bytes.
  SHA-256: `2c1e51fd619a917068f067c25a12f2b59f46b5d58b68bdef2e0692b3e5458018`.
- ZIP SHA-256: `e6816659704aeeebf02d41753cb0c408d550ba5f9ca59d02f5cdfb3c8f36c32a`.
  Its 9,094 entries passed public boundary validation and match the installer
  source. Native, agent and installer metadata are 0.4.55; Authenticode unsigned.
- Server release: `20261013-native-goals-0.4.55`, following a consistent MySQL
  snapshot, protected-data backup and isolated MySQL 8.4 startup check. Relay
  and MySQL are healthy. Protected records, secrets and other services matched.
- Public HTML and goal module digests match the imported client artifact.
- The real authenticated updater resumed from 65,536 bytes, reached `ready` in
  22.527 seconds and verified the complete digest. Only the new package downloaded.
- Installer formally published as release sequence 52. Older clients select
  0.4.55; 0.4.55 receives no further update. Stored digest verified independently.
- Local installation completed from 0.4.53 to 0.4.55 after the queue and upload
  gates passed. Program/data backups retained. Device identity and password
  matched; the one unexpired remembered authorization remained. A previously
  expired authorization was pruned on restart. All 14 existing Codex processes
  remained, and the new helper and agent started. Installation result reported.
- The native adapter using the installed helper discovered `goal-mode` and
  read the completed test goal. Latest disconnected continuation turn IDs were
  `01a13116-cfd3-7d32-aafd-70cd953403fe` and
  `01a13117-1a1c-7e61-8e61-7fde29620b63`.

Physical-phone acceptance remains open. Local ignored evidence directories:
`goal55-artifacts`, `local-upgrade-20261013-0.4.55`,
`production-update-0.4.55.json`, `production-release-0.4.55.json`, and the private
server's `20261013-native-goals-0.4.55` deployment evidence.
