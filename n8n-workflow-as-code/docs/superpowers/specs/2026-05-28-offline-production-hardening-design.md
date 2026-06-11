# Offline Production Hardening Design

## Goal

Raise the repository from a single-workflow engineering demo to a shareable Workflow-as-Code project without requiring public deployment or a live CI n8n instance.

## Scope

This hardening pass focuses on P0 controls that are useful immediately:

- Pin the Workflow SDK dependency through `package.json` and `package-lock.json`.
- Add Apache-2.0 licensing so the repository has explicit reuse terms.
- Add GitHub Actions for offline static validation.
- Add a tracked pre-commit hook path that runs the same offline checks locally.
- Centralize secret and private-path regexes so scrub and validation cannot drift.
- Document the no-deployment Feishu path as outbound-only custom bot alerts.

Out of scope for this pass: TypeScript migration, ESLint/Prettier, multi-workflow scaffolding, generated registry indexes, and bidirectional Feishu callbacks.

## Architecture

`@n8n/workflow-sdk` is pinned as the only JavaScript runtime dependency. Offline checks are owned by `scripts/Invoke-StaticValidation.ps1`, which composes smaller PowerShell validators for script parsing, fixture JSON parsing, repository secret scanning, Feishu workflow guardrails, and workflow JSON structure checks.

Secret patterns live in `scripts/lib/Secret-Patterns.psd1`. Scrub, workflow JSON validation, and repository-level scanning all import that file.

## No-Deployment Validation

The preferred local-only path is outbound Feishu custom bot notification. A real webhook can be placed in the local Docker environment for a private smoke test, while Git and CI continue to run without any webhook configured. Inbound Feishu callbacks remain explicitly out of scope unless a tunnel or deployment is introduced.

## Testing

Required checks:

- `npm ci`
- `npm run verify:static`
- existing live local checks when n8n is available: connection, SDK sync, support triage regression

CI runs only offline checks so external contributors and GitHub runners do not need access to the user's local n8n instance.
