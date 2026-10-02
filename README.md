# Codex Mobile Client

**Continue and supervise your Codex desktop work from a phone, wherever you are.**

[![Latest release](https://img.shields.io/github/v/release/jiabaochen79-collab/codex-mobile-client?display_name=tag)](https://github.com/jiabaochen79-collab/codex-mobile-client/releases)
[![CI](https://github.com/jiabaochen79-collab/codex-mobile-client/actions/workflows/ci.yml/badge.svg)](https://github.com/jiabaochen79-collab/codex-mobile-client/actions)

English | [简体中文](README.zh-CN.md)

Codex Mobile is an independent Windows companion and mobile web client for existing Codex desktop tasks. It keeps the desktop environment as the execution host while giving you a focused way to inspect progress, respond to approvals, send follow-up work, and switch between computers.

> This is independent, unofficial software. It is not affiliated with or endorsed by OpenAI. Codex desktop, its account, model access, and the separately operated relay service remain separate products.

## Why people use it

- **Work from anywhere:** Read task progress and continue conversations from a phone without moving the desktop workspace.
- **Reliable task control:** Queue messages while a task is running, adjust direction, stop safely, and keep work on the original computer.
- **Plan-aware workflow:** Review plans and provide decisions from a small screen before execution continues.
- **Multiple computers:** Keep home, office, and remote computers in one mobile device list and switch with explicit device authorization.
- **Useful mobile input:** Upload photos and files, preview attachments, handle HEIC photos, and retry failed uploads.
- **Quiet completion alerts:** Use in-site notifications and supported Web Push browsers to know when a task finishes or fails.
- **Operational feedback:** Submit a product issue with optional screenshots and sanitized diagnostics without exposing task content by default.

## Product boundary

The Windows helper connects to the local Codex desktop process and establishes an authenticated outbound connection to a separately operated relay service. The mobile page talks to that service using authenticated sessions.

This repository contains only the client:

- Windows helper and native companion.
- Mobile web interface and browser assets.
- Shared protocol snapshot and client-side tests.
- Windows packaging and installer scripts.

It does **not** contain the relay server, administrator console, payment implementation, deployment manifests, production databases, service credentials, certificates, or private signing keys. The server source is maintained separately and is never published with this repository.

## Main capabilities

### Mobile task control

- View projects, conversations, models, task status, approvals, and execution activity.
- Send immediately, queue follow-up messages, or adjust direction while work is running.
- Use plan mode when the task needs a review before execution.
- Retain drafts and attachments when switching computers, refreshing, or recovering from a temporary connection loss.

### Files, photos, and notifications

- Select multiple photos, take a photo, or choose regular files from the phone.
- Preview attachments and retry an upload after a weak-network failure.
- Convert supported HEIC photos locally when required by the browser workflow.
- Receive privacy-conscious completion and failure notifications; notification text does not include prompts, replies, commands, files, passwords, or model keys.

### Windows integration

- Preserve the local device identity and remembered authorization during an upgrade.
- Check and download signed release metadata when the separately operated service provides it.
- Install a prepared update only after the user confirms; Codex and active desktop tasks are not intentionally stopped by an assistant update.
- Report helper version and compatibility capabilities to the mobile interface.

### Service access and support

- View subscription status, redeem an authorization code, and purchase service access when enabled by the relay operator.
- Claim a one-time seven-day trial on an eligible computer when the operator has enabled trials; eligibility and expiry are determined by the service.
- Submit feedback, attach optional screenshots, follow replies, and track resolution from either device.
- Service expiry does not stop Codex tasks already running on the computer.

## Download

Windows installers and portable archives are distributed through [GitHub Releases](https://github.com/jiabaochen79-collab/codex-mobile-client/releases). The Gitee mirror will be linked here after its account and release assets have been verified.

For each release, download the installer or archive together with its `.sha256` file and verify the digest before opening it. The current public package is an unsigned Windows installer; Windows may show a SmartScreen warning until an Authenticode certificate is added.

## Quick start

1. Install the Windows package on the computer that runs Codex desktop.
2. Start the assistant and keep its device ID and connection password private.
3. Open the separately operated HTTPS relay address in a phone browser.
4. Pair the phone with the displayed device credentials.
5. Open a task and use the mobile controls without closing Codex desktop.

The relay service address, subscription status, and account policy are deployment-specific. They are not hard-coded server credentials in this repository.

## Build the client

Requirements:

- Windows 10 build 19041 or later, x64.
- Node.js 22.13 or later.
- .NET Framework 4.8 for the native companion.
- Inno Setup for the Windows installer.

```powershell
npm ci
npm run audit:public
npm run check
npm run native
npm run build
npm test

$env:RELAY_URL = 'https://remote.example.com'
npm run package:windows
npm run installer:windows
```

The build records the client Web artifact version and SHA-256 manifest in `dist/client-web-manifest.json`. The separately maintained server imports that artifact after validation; it does not need the client source tree.

## Privacy and security

- HTTPS protects the network connection when the service is configured with a valid certificate.
- Authentication uses the device identity, connection password, session controls, and server-side authorization.
- The client does not intentionally persist chat history in the public repository or upload provider credentials.
- Web Push metadata is not end-to-end encrypted; the relay can see notification metadata. Notification payloads intentionally omit task content and files.
- Do not place passwords, cookies, TOTP seeds, model credentials, private files, or production logs in Issues or feedback attachments.
- Transport encryption is not a claim that the independently operated relay cannot process forwarded task content.

## Troubleshooting

- **Computer offline:** Confirm Codex desktop and the Windows assistant are running, then check the assistant connection state.
- **Compatibility warning:** Upgrade the Windows helper; capabilities are checked explicitly and are not inferred only from the version number.
- **No Web Push:** Keep using the in-site notification center. iPhone notifications require the supported Web App installation flow; Android Chrome and desktop Chromium browsers can use Web Push when permission is granted.
- **Installer warning:** Verify the published SHA-256. The current installer is unsigned and may require an explicit Windows confirmation.
- **Connection errors:** Check the HTTPS origin, DNS, certificate, and company-network policy. Do not disable certificate validation.

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the client boundary rules before opening a change. Server code and production configuration must remain outside this repository.

## License

Original code is licensed under [Apache-2.0](LICENSE). Third-party libraries and generated assets retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

