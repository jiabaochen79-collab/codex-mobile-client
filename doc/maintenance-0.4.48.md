# 0.4.48 maintenance

This release fixes the ten defects identified in the 0.4.47 working-tree audit.

- Prefer the highest eligible semantic version; staged-upload sequence numbers no longer block a newer package. Installed-version downgrade checks remain active.
- Restore pending-send text after browser-session loss, preserve newer draft edits and remove only the logged-out device's persistent pending records.
- Replace overlapping authoritative conversation tails after desktop undo and retain earlier paginated history.
- Separate subscription reads from mutations so slow polling does not disable closing or overwrite a successful activation.
- Preserve explicit null/default reasoning effort through plan-mode changes.
- Skip desktop processes that disappear during recovery identity lookup.
- Check backup and installation volumes before an update, and check restoration staging space again before copying.
- Remove owned incomplete copies on copy failures and failed program directories after verified healthy recovery. Keep the verified local backup and current user data.

Validation includes client unit/component suites, Windows native process-race and layout tests, simulated installer failures and restoration, and Chromium/WebKit mobile interaction checks. Simulated rollback tests do not constitute independent-computer fault injection.

Passed before packaging: 490 unit/native tests, 97 component tests, 41 Chromium and 41 WebKit browser tests. Four rejection cases passed ten repetitions each after a transient first-run assertion failure; assertions were not weakened. iPhone/Android physical-device checks and independent-computer installer fault injection have not been performed for this release.

The installer uses EXE-only publishing, HTTPS, allowed download paths, package size, SHA-256 and installed-version checks. No separate signed JSON or old installer download is required. Windows Authenticode signing is not provided.
