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
- [ ] Live-mode behavior changed
- [ ] Stub/offline behavior changed
- [ ] No public workflow behavior changed
- [ ] `docs/workflow-contract.md` was updated or this change does not affect the workflow contract

## Verification

- [ ] `npm run verify:static`
- [ ] `npm run verify:json`
- [ ] `npm run smoke`
- [ ] `npm run verify:live` or explained below

Live verification notes:

## Security and Data Handling

- [ ] No secrets, webhook URLs, tokens, or live customer data were committed
- [ ] Generated workflow snapshots were scrubbed
- [ ] New external calls are documented and opt-in
- [ ] AI-generated output is validated or has a safe fallback

## Interface and Boundary Review

- [ ] No public interface changed
- [ ] New or changed interfaces were reviewed against `docs/security-boundaries.md`
- [ ] Authentication, signature verification, or deployment-side auth expectations are documented
- [ ] Input schema, size limits, idempotency, timeout, retry, and failure behavior are documented
- [ ] Data sent to LLMs, bots, CRM systems, vector stores, and sibling workflows is minimized and redacted
- [ ] Persistence, retention, deletion, and audit behavior are documented when data storage changed

## Notes for Reviewers

<!-- Known risks, deferred work, or files that deserve careful review. -->
