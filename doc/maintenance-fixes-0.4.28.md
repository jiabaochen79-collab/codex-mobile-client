# 0.4.28 Maintenance Fixes

- Keep explicit task selection and drafts when a delayed notification or send refresh returns.
- Preserve notifications received during the first list read; avoid duplicate unread counts.
- Serialize update polls and discard reads started before installation or another update action.
- Clear recovered update read failures without hiding failed installation actions.
- Commit feedback page numbers only after the matching page succeeds; prevent repeated paging while loading.
- Synchronize trial eligibility after license redemption.
- Display subscription prices with exact cents.
- Remove superseded updater-owned packages and partial downloads, retaining candidate, rollback and unfinished installer packages. Unrelated files are not removed.

The installer remains unsigned by Windows Authenticode. Updating restarts only the helper, not Codex. Server configuration, subscription policy and pricing are unchanged.
