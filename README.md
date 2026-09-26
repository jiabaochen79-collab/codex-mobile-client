# Codex Mobile Windows Client

**A Windows companion for continuing existing Codex desktop tasks from a mobile browser.**

English | [简体中文](README.zh-CN.md)

This repository contains the Windows helper, its native companion, the mobile web client, shared protocol types, and client-side tests. The remote service that relays authenticated traffic is operated separately and is intentionally **not included** in this repository.

> Independent, unofficial software. It is not affiliated with or endorsed by OpenAI. Codex desktop, its account, model access, and any separately operated service remain outside this repository.

## Scope

- Windows helper for local Codex IPC and authenticated outbound connections.
- Mobile browser UI for projects, conversations, models, attachments, plans, queued messages, feedback, and notifications.
- Native Windows companion for version reporting, desktop discovery, power checks, and installer integration.
- Client-side update packaging and verification helpers.

The helper does not replace Codex, expose a general remote desktop, or contain provider credentials. The local loopback HTTP service is part of the Windows helper and is used only to serve its authenticated local panel.

## Repository Boundary

The following are deliberately excluded:

- Remote relay/server implementation.
- Deployment manifests, production configuration, databases, payment gateway code, and administrator backend code.
- Server credentials, private keys, certificates, and operational secrets.

Keep service credentials and release signing keys outside the repository. Runtime service URLs are supplied through the packaged client configuration or the build environment; they are not server source code.

## Build Requirements

- Windows 10 build 19041 or later, x64.
- .NET Framework 4.8 for the native companion.
- Node.js 22.13 or later.
- Inno Setup for installer generation.

```sh
npm ci
npm run check
npm run native
npm run build
npm test
```

To create a Windows package for an HTTPS service origin:

```powershell
$env:RELAY_URL = 'https://remote.example.com'
npm run package:windows
npm run installer:windows
```

The installer is unsigned unless a separate Windows code-signing step is applied. Verify the published SHA-256 digest before installation. Installing an update preserves the helper's local identity and user data; it does not stop Codex or running desktop tasks.

## Security Notes

Transport encryption protects the network connection but is not end-to-end encryption. The separately operated service can process forwarded content while a session is active. This client does not intentionally persist chat content, and its repository contains no server credentials or payment secrets.

Report security issues privately to the project maintainer. Do not include passwords, cookies, TOTP seeds, model credentials, task content, or private files in an issue.

## License

Original code is licensed under [Apache-2.0](LICENSE). Third-party libraries and generated assets retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
