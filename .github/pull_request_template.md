## Summary

Describe the problem and the behavior change. English or Chinese is welcome.

## Related Issue

Link the issue or explain why this change is self-contained.

## Verification

- [ ] Type checks pass (`npm run check`).
- [ ] Relevant unit/integration tests pass (`npm test`).
- [ ] Production build passes (`npm run build`).
- [ ] UI changes include sanitized screenshots and browser checks.
- [ ] Tests use isolated data, not live task mutations or real payments.

## Safety and Compatibility

- [ ] No credentials, user content, databases, or release artifacts are included.
- [ ] Authorization, queue ordering, and payment invariants remain covered.
- [ ] Both READMEs and relevant docs are updated when behavior changes.
- [ ] Migrations, compatibility limits, and remaining checks are documented.

## Remaining Limitations

List skipped checks, required real-device validation, or rollout dependencies. This pull request does not authorize a production deployment or public release.
