# Demo Script

1. Show the request in `fixtures/requests/lead-intelligence.md`.
2. Show the source of truth in `workflows/sdk/lead-intelligence.workflow.js`.
3. Open local n8n workflow `xhZ0XMNvi4LeVWzk` and call out the 31-node shape.
4. Explain the main path: intake -> normalization -> validation -> dedupe -> local enrichment -> scoring -> grade -> route -> follow-up policy -> CRM payload -> redacted audit -> response.
5. Run `npm run verify:static`.
6. Run `npm run smoke`.
7. Run `pwsh -NoProfile -File .\scripts\Test-LeadIntelligenceWorkflow.ps1` for the full 11-case regression suite.
8. Show `docs/registry/workflow-registry.md` to prove registry generation from canonical JSON and metadata.

## Expected Smoke Result

- Case: `hot-enterprise-lead`
- Grade: `A`
- Route: `enterprise-ae`
- Follow-up SLA: `2` hours
- Hot lead: `true`
- Notification: `skipped`
- Policy version: `lead-intel-v0.1.0`

## Artifacts To Show

- Canonical JSON: `workflows/canonical/lead-intelligence.canonical.json`
- Release snapshot: `workflows/releases/lead-intelligence-v0.1.0.json`
- Regression script: `scripts/Test-LeadIntelligenceWorkflow.ps1`
- Workflow registry: `docs/registry/workflow-registry.md`
- External adapter notes: `docs/external-adapters.md`
