# Contributing

This repository is a standalone offline contract-conformance tool for the n8n Workflow-as-Code portfolio. Contributions should keep the runner reproducible, honest about what it asserts, and safe to run in CI without credentials.

## Ground Rules

- Keep secrets out of Git. Never commit `.env`, n8n API keys, webhook URLs, signing secrets, or live customer data.
- Keep offline mode safe and credential-free by default. Live integrations must be opt-in (`-Live` flag) and documented.
- Preserve the self-test gate: `npm run verify:self` must remain green and must catch every synthetic defect in `fixtures/self/`. Do not loosen assertions to make the gate pass.
- Do not add dependencies unless they are necessary and documented in the pull request.

## Local Setup

1. Install Node.js 20 or newer and PowerShell 7.
2. Run `npm install` (no dependencies currently; this is a no-op but keeps the workflow consistent).
3. Optional: install local Git hooks if the repo provides them.

## Verification

Run the offline gates before opening a pull request:

```powershell
npm run verify:self
npm run verify:portfolio
```

`verify:self` runs `Test-Contract.ps1 -SelfTest` over the synthetic good/bad fixtures in `fixtures/self/` and confirms every targeted-defect case is caught (exit 0 = all pass, including the negatives that are supposed to fail). This is the primary CI gate and must always pass.

`verify:portfolio` runs `Test-PortfolioContracts.ps1`, which reports offline contract conformance across all sibling repos (SKIPping repos that have not yet adopted the `## Machine-readable contract` block).

Run the live gate only when a local n8n instance is available:

```powershell
npm run contract -- -RepoPath ..\<sibling-repo> -Live
```

If a live gate is not applicable, state that in the pull request with the reason.

## Change Checklist

- Update `scripts/Test-Contract.ps1` before updating fixtures.
- Add or update synthetic fixtures in `fixtures/self/` when assertion logic changes.
- Update `docs/workflow-contract.md` when the tool's own behavior or scope changes (note: this file explains there is no webhook contract, not a machine-readable block).
- Review `docs/security-boundaries.md` when the trust boundary changes (e.g. new file reads, new network calls, new environment variables).
- Run `npm run verify:self` and `npm run verify:portfolio`.
- Redact any credentials, webhook URLs, test emails, and customer-like payloads from fixtures.

## Pull Requests

Use the pull request template and include:

- What changed and why.
- Which assertion, fixture, or script changed.
- Which verification commands passed.
- Which live paths were not tested.
- Any security or data-handling implications.

## Issues

Use the issue templates for bugs or tool improvements. Include sanitized reproduction steps and relevant script output when possible.

## Commit Discipline

This portfolio uses per-file commits: one commit per changed file, using Conventional Commits style (`feat:`, `fix:`, `docs:`, `chore:`, `test:`). Do not bundle multiple file changes into a single commit.
