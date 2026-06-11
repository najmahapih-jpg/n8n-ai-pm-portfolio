# Contributing

This repository is an n8n Workflow-as-Code project. Contributions should keep the workflow reproducible, reviewable, and safe to import into a local n8n instance.

## Ground Rules

- Keep secrets out of Git. Never commit `.env`, n8n API keys, webhook URLs, signing secrets, Feishu/Slack/Telegram tokens, Supabase keys, or live customer data.
- Prefer deterministic offline fixtures for tests. Live integrations must be opt-in and documented.
- Keep workflow changes reviewable: update SDK source, canonical exports, release snapshots, docs, and registry files together when the workflow contract changes.
- Preserve stub-default behavior unless a change is explicitly about live-mode behavior.
- Do not add dependencies unless they are necessary and documented in the pull request.

## Local Setup

1. Install Node.js 20 or newer and PowerShell 7.
2. Run `npm install`.
3. Copy `.env.example` to `.env` for local-only values. Do not commit `.env`.
4. Optional: run `npm run hooks:install` to install local Git hooks.
5. Build or refresh registry artifacts with `npm run registry:build` after workflow metadata changes.

## Verification

Run the offline gates before opening a pull request:

```powershell
npm run verify:static
npm run verify:json
npm run smoke
```

Run live gates only when the required local n8n instance and credentials are configured:

```powershell
npm run verify:live
```

If a live gate is not applicable, state that in the pull request with the reason.

## Workflow Change Checklist

- Update the SDK workflow source before generated JSON.
- Rebuild canonical and release workflow snapshots when node graph behavior changes.
- Update fixtures when the input or output contract changes.
- Update docs and README examples when public behavior changes.
- Update `docs/workflow-contract.md` when request fields, response fields, status behavior, entrypoints, modes, or external integrations change.
- Review `docs/security-boundaries.md` when any interface, credential, AI node, external adapter, persistence surface, or generated artifact changes.
- Run the static, JSON, and smoke gates.
- Redact credentials, webhook URLs, test emails, and any customer-like payloads from snapshots and fixtures.

## Pull Requests

Use the pull request template and include:

- What changed and why.
- Which workflow contract, node graph, or fixture changed.
- Which verification commands passed.
- Which live paths were not tested.
- Any security, credential, or data-handling implications.

## Issues

Use the issue templates for bugs or workflow improvements. Include sanitized payloads and reproduction steps when possible.
