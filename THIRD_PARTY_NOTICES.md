# Third-Party Notices

The repository's Apache-2.0 license applies to original project code. It does not relicense dependencies, third-party notices, generated assets derived from other projects, or OpenAI software.

## Direct Runtime Dependencies

The exact resolved versions are in `package-lock.json`; this table is a dependency overview, not a substitute for the license files shipped by each package or its transitive dependencies.

| Component | License | Use |
| --- | --- | --- |
| Vue | MIT | Web interface |
| Fastify and its cookie, static, and WebSocket plugins | MIT | HTTP and WebSocket services |
| ws | MIT | WebSocket transport |
| Zod | MIT | Protocol and configuration validation |
| Immer | MIT | Desktop state updates |
| @electron/asar | MIT | Read-only inspection of installed desktop archives |
| Acorn | MIT | Parse versioned IPC definitions without executing desktop code |
| marked | MIT | Markdown rendering |
| DOMPurify | MPL-2.0 OR Apache-2.0 | Rendered-content sanitization |
| Lucide Vue Next | ISC, with Feather-derived MIT portions | UI icons and generated application assets |
| sharp | Apache-2.0 | Image processing; native libraries have separate notices |
| heic-to | LGPL-3.0-or-later per upstream license | Optional browser HEIC conversion |
| alipay-sdk | MIT | Official Alipay protocol integration |
| csv-stringify | MIT | CSV exports |
| limiter | MIT | Rate limiting |
| otpauth | MIT | TOTP |
| qrcode | MIT | QR-code generation |

## HEIC Conversion

The optional HEIC decoder is loaded as a separate browser module. Its upstream license, GPL/LGPL texts, source links, versions, and build information are preserved in [the HEIC notices](web/public/third-party/heic-to/NOTICE.txt).

The project does not modify that decoder. Distributors must review the LGPL requirements for the exact artifacts they ship, including replacement/relinking and corresponding source availability. Do not assume that an application license or a package-name table satisfies all binary-distribution requirements.

## Icons and Branding

`scripts/assets.ts` generates the application icon and Windows button assets from Lucide icons, including the MessagesSquare symbol. The Lucide/Feather attribution and full license texts are retained in [the icon license](web/public/third-party/lucide/LICENSE.txt). These are not OpenAI logos.

## Binary Distribution

Windows packages include a Node.js runtime. Preserve its license file and the applicable licenses for bundled dependencies and native libraries. The packaging script includes the project license, notice, this document, and public third-party notices; distributors still need to verify the final artifact and provide any required corresponding source materials.

No OpenAI executable, installation archive, model weights, private API credentials, or user task history is part of this repository. Product names are used only to identify the supported integration.
