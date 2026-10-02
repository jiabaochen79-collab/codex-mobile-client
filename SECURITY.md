# Security Policy

## Support Scope

Security fixes target the latest maintained `0.4.x` baseline. Older builds are not separately maintained. Desktop compatibility follows the explicit checks described in [Desktop Compatibility](doc/desktop-compatibility.md); a successful build alone does not certify a new Codex version.

This pre-release project has not undergone an independent security audit. It does not claim end-to-end encryption or production payment certification.

## Reporting a Vulnerability

Do not post credentials, personal data, or exploit details in public issues or pull requests.

Use GitHub private vulnerability reporting when the repository's Security tab offers it. Otherwise, open an issue requesting a private contact without including exploit details or sensitive data. Do not assume that private reporting is enabled merely because this file exists.

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

## Client Requirements

- Use valid HTTPS certificates and exact allowed origins. Never disable certificate validation to bypass a connection error.
- Keep the helper's management interface on loopback. Do not expose desktop IPC, databases, or debug ports.
- Use strong, unique passwords and revoke grants after suspected disclosure. A device ID is not an authentication secret.
- Keep server source, production configuration, databases, credentials and private signing keys outside this repository and its release packages.
- Do not log request bodies or collect user conversations as telemetry or support data.
- Run `npm run audit:public` before publishing source. It scans the working tree and Git history for disallowed paths and known credential patterns; it does not replace a manual review.

## Known Release Gates

Windows packages are unsigned. Verify the published SHA-256 before installation. Phone-specific behavior and native task mutations need explicit real-device acceptance. Server operations and payment acceptance are outside this client repository's scope.
