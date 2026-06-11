## Summary

<!-- What changed and why? -->

## Change Type

- [ ] Documentation only
- [ ] Workflow SDK source
- [ ] Generated workflow JSON
- [ ] Fixtures or test data
- [ ] CI, scripts, or tooling
- [ ] Security or credential-handling change

## Workflow Impact

- [ ] Input contract changed
- [ ] Output contract changed
- [ ] Node graph changed
- [ ] Security function changed (signature, body-size, secret-strip, routing)
- [ ] Live-mode behavior changed
- [ ] Stub/offline behavior changed
- [ ] No public workflow behavior changed
- [ ] `docs/workflow-contract.md` was updated or this change does not affect the workflow contract

## Verification

- [ ] `npm run verify:static`
- [ ] `npm run verify:json`
- [ ] `npm run verify:gateway`
- [ ] `npm run verify:workflow`
- [ ] `npm run verify:live` or explained below

Live verification notes:

## Security and Data Handling

- [ ] No secrets, webhook URLs, tokens, or live customer data were committed
- [ ] Generated workflow snapshots were scrubbed
- [ ] New external calls are documented and opt-in
- [ ] Secret-stripping behavior is covered by fixtures or differential pinning

## Interface and Boundary Review

- [ ] No public interface changed
- [ ] New or changed interfaces were reviewed against `docs/security-boundaries.md`
- [ ] Authentication, signature verification, or deployment-side auth expectations are documented
- [ ] Input schema, size limits, replay window, timeout, and failure behavior are documented
- [ ] Intent allowlist and routing changes are reflected in `docs/workflow-contract.md`
- [ ] Data sent to sibling workflows is secret-stripped and minimized

## Notes for Reviewers

<!-- Known risks, deferred work, or files that deserve careful review. -->
