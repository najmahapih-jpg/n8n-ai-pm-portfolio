## Summary

<!-- What changed and why? -->

## Change Type

- [ ] Documentation only
- [ ] Assertion logic (Test-Contract.ps1)
- [ ] Self-test fixtures (fixtures/self/)
- [ ] Portfolio gate (Test-PortfolioContracts.ps1)
- [ ] CI, scripts, or tooling
- [ ] Security or credential-handling change

## Verification

- [ ] `npm run verify:self`
- [ ] `npm run verify:portfolio`
- [ ] `npm run contract -- -RepoPath <path> -Live` or explained below

Live verification notes:

## Security and Data Handling

- [ ] No secrets, webhook URLs, tokens, or live customer data were committed
- [ ] Fixture files are synthetic or redacted
- [ ] New file reads or network calls are documented and opt-in

## Interface and Boundary Review

- [ ] No new environment variables, file reads, or network calls were added
- [ ] New or changed behaviors were reviewed against `docs/security-boundaries.md`
- [ ] Script output does not print secrets, tokens, or raw response bodies

## Notes for Reviewers

<!-- Known risks, deferred work, or files that deserve careful review. -->
