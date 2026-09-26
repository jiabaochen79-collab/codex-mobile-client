# Security Policy

## Support Scope

Security fixes target the latest maintained `0.4.x` baseline. Older builds are not separately maintained. Desktop compatibility is limited to the version in the READMEs; a successful build does not certify a new Codex version.

This pre-release project has not undergone an independent security audit. It does not claim end-to-end encryption or production payment certification.

## Reporting a Vulnerability

Do not post credentials, personal data, or exploit details in public issues or pull requests.

While this repository is private, contact the repository owner through the existing private collaboration channel. If no private channel is available, open an issue containing only a request for a private security contact, without sensitive details. Before public release, maintainers must enable GitHub private vulnerability reporting or publish a verified private reporting address. Do not assume that an endpoint is enabled merely because this file exists.

Include affected versions, a minimal reproduction with synthetic data, impact, and available mitigations. There is no guaranteed response-time SLA or paid bug-bounty program. Reports in English or Chinese are welcome.

## Trust Boundaries

| Component | Access |
| --- | --- |
| Mobile browser | Displayed conversations and attachments, local preferences and drafts |
| Relay and its operator | Forwarded content in memory; persistent device, authorization, billing, audit, and usage metadata |
| Windows helper | Desktop metadata and IPC; local grants, queue, and uploaded files |
| Codex and model provider | Input required by the original task and provider configuration |

HTTPS/WSS protects public transport. The relay terminates TLS and can read forwarded content. Not persisting chat transcripts does not protect against a compromised operator, extra infrastructure logging, or a compromised endpoint.

DPAPI protects Windows credentials and pending queue text at rest. It does not isolate the application from malware running as the same Windows user. Submitted attachments and the original workspace remain readable by the task. Model providers and third-party API gateways are separate trust decisions.

## Deployment Requirements

- Use valid HTTPS certificates and exact allowed origins. Never disable certificate validation to bypass a connection error.
- Keep the helper's management interface on loopback. Do not expose desktop IPC, databases, or debug ports.
- Use strong, unique passwords and revoke grants after suspected disclosure. A device ID is not an authentication secret.
- Keep payment secrets outside the repository and packages, readable only by the service identity. Protect database backups and `commerce.key` together.
- Do not log request bodies or collect user conversations as telemetry or support data.
- Use an independent hostname: cookies are not isolated by TCP port alone.
- Keep sales disabled until merchant setup, dependency review, real-device checks, verified payments, and refunds are accepted.

## Known Release Gates

Windows packages are unsigned. Phone-specific behavior and native task mutations need explicit real-device acceptance. The Alipay SDK dependency chain has a recorded `urllib` advisory, GHSA-hq3h-g68c-hp78; the application avoids the SDK network redirect path, but that is not an upstream fix. Re-run the audit and record its disposition before release.

See [Release Checklist](doc/release-checklist.md) and [payment implementation notes](doc/subscription-admin-and-payments.md).
