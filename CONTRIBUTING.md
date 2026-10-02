# Contributing

This public repository contains the Windows helper and mobile web client. Server, administrator, payment and deployment code is maintained separately and must not be included in contributions. English and Chinese reports are welcome; keep both READMEs aligned when changing user-facing behavior.

## Before You Start

- Describe a reproducible bug or concrete workflow improvement in an issue.
- Discuss authentication, desktop protocol and licensing changes before implementation.
- Read [Security](SECURITY.md), [Contracts](CONTRACTS.md), and [Desktop Compatibility](doc/desktop-compatibility.md).
- Never include live passwords, tokens, merchant credentials, database copies, or unredacted conversations.

## Development

Use Windows x64, .NET Framework 4.8, and Node.js 22.13 or later. CI uses Node 22 LTS.

```sh
npm ci
npm run audit:public
npm run native
npm run check
npm test
npm run build
```

The native build is required before Windows integration tests because credential tests use DPAPI. Tests use temporary databases and isolated desktop adapters. Do not test against another person's workstation or production account.

## Change Scope

- Prefer existing helper APIs and small, reviewable changes.
- Add a failing regression test before fixing a bug where practical.
- Preserve original Codex configuration, credentials, installation files, and task history.
- Preserve queue, control-lease and protocol idempotency rules.
- Do not silently broaden desktop compatibility or substitute another task engine.
- Preserve device identity and local user data during upgrades.
- Keep dependency upgrades separate from unrelated product changes.

## Commits and Pull Requests

Use English [Conventional Commit](https://www.conventionalcommits.org/) subjects:

```text
feat(mobile): add queued follow-up controls
fix(agent): pause pending messages after a stopped turn
docs: update bilingual setup instructions
test(agent): cover expired-session isolation
```

Describe the problem, behavior change, verification performed, and remaining limitations. Link an issue where one exists. Include sanitized screenshots for UI changes and tests for authorization changes. Do not claim a real-device path passed based only on a simulator.

Run `git diff --check` for your changes. Preserve upstream attribution files verbatim; report pre-existing upstream formatting separately instead of rewriting their legal text.

## Review and Contributions

Maintainers decide compatibility support and release readiness. A contribution does not authorize a production deployment or public release. Contributions are submitted under the repository's Apache-2.0 license, subject to its terms and any explicitly agreed separate arrangement. Do not contribute material you lack permission to share.

Be respectful and keep personal information out of discussions. See [Code of Conduct](CODE_OF_CONDUCT.md).
