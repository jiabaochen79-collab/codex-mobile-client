# 0.4.54 Background Question Window Recovery

Date: 2026-10-12.

## Change

The native question adapter previously waited for the exact task document but
could not recover a minimized ChatGPT window. Read-only task access could still
work while native question submission failed at the window stage.

Before matching a question, the adapter now checks the process owner, session,
executable path and process start time, then restores its minimized native window
without requesting foreground activation. It selects either the unique matching
task window or the sole verified process window while task navigation is pending.
Ambiguous windows remain rejected. Exact task and question matching, the explicit
submission handshake, draft protection and canonical-answer verification remain.

Cleanup minimizes the window again only if it was originally minimized, is still
owned by the original live process and remains in the background. A window the
user is now using in the foreground stays open. UI Automation providers may
activate their window while filling or invoking controls; this release does not
promise that providers never affect focus.

No plain-message fallback, renderer injection, ChatGPT restart, mobile UI,
server implementation or protocol change is included.

## Verification Before Delivery

- Type checks, native compilation and production build passed.
- 552 unit/native tests and 105 component tests passed.
- Focused native/question tests: 27 passed.
- A real minimized WPF fixture exercises production recovery, exact card
  matching and restoration, and checks that recovery does not change foreground.
  This fixture does not fill or submit a minimized card.
- A real isolated ChatGPT task accepted the mobile-format answer through the
  candidate native adapter, closed the question and acknowledged it once.
- Public history audit passed: 44 commits and 776 unique blobs checked before
  this source commit; no server paths or known credential patterns found.
- Installer and native metadata are 0.4.54; ZIP matches the installer source.
  The 9,094 ZIP entries passed public artifact boundary validation.

Computer Use text/window access recovered after rebinding its session. Frame
capture still fails with `FrameArrived timed out` or `window capture timed out`,
and coordinate input reports unavailable geometry. Real minimized end-to-end
submission and iPhone/Android acceptance therefore remain unverified. Background
submission is evidence for the background case only.

## Artifacts

- `release/ChatGPT-Remote-Assistant-Setup-0.4.54.exe`: 43,019,088 bytes.
- EXE SHA-256: `034c88f5fef95785dd079e186d2bef1a2959455ddede80b42c48e643c85e8d79`.
- ZIP SHA-256: `9870cd771c356019f9ae42f16f038b907dc9994851695170d651e15414b19c28`.
- The installer is not Windows Authenticode signed.

Production publication and installed-helper verification are recorded after
delivery. Server source is unchanged; publication only adds the Windows EXE.
