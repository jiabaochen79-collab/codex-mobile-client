# Windows Helper 0.4.31

This release fixes the ten confirmed audit findings across the mobile web app, helper and private service. Task execution, permissions, prices and trial rules are unchanged.

- Clarification answers and input IDs are isolated by request, including requests that reuse question IDs.
- Update downloads terminate on asynchronous disk write failures and allow subsequent checks or retries.
- Payment-link exchange failures preserve the ticket until exchange succeeds and offer an explicit retry. No payment is automatically started.
- A rejected fourth browser terminal retries with backoff after another terminal leaves. Revoked and banned sessions do not retry.
- Notification badges preserve events arriving during stale count requests. Read-all uses the server's committed sequence boundary.
- Recovered desktop state reads clear only read errors, preserving rejected-operation errors.
- Tapping outside the add-computer form does not discard entered credentials.

The private service also exposes inherited computer-ban sources and counts only redeemed trials in claim/conversion reports. It is maintained separately and is not included in this repository or installer.

Upgrade using `ChatGPT-Remote-Assistant-Setup-0.4.31.exe`. Only the helper and its owned connection process restart; device identity, passwords and grants are retained. Codex is not stopped. The installer is not Windows Authenticode-signed.

Automated verification includes all client/server unit tests, Chromium and WebKit interaction regressions, and 320/390px layouts. These browser fixtures do not replace physical iPhone/Android acceptance or a real payment.
