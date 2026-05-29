# n8n Lead Intelligence Workflow

Workflow-as-Code portfolio project for a local B2B lead intelligence API built with n8n, the official n8n MCP server, `@n8n/workflow-sdk`, PowerShell validation, pin-data regression tests, scrubbed canonical JSON, and release snapshots.

The workflow is `Portfolio - Lead Intelligence API`.

Current local n8n workflow ID: `xhZ0XMNvi4LeVWzk`

You can now open the workflow in n8n and click `Execute Workflow` directly. The manual branch starts at `Run Demo Lead From n8n UI`, builds a demo enterprise lead, and ends at `Show UI Execution Result` instead of waiting for the webhook Test URL.

## What It Does

The workflow receives a lead intake request, normalizes payload aliases, validates required fields, rejects malformed email, detects duplicates, enriches locally with deterministic company and intent rules, scores ICP fit and buyer intent, assigns a lead grade, routes the owner queue, builds a CRM-ready payload, emits a redacted audit event, and returns a structured response.

External CRM and Feishu/Lark delivery are intentionally placed last. The current acceptance path runs without public deployment, external SaaS credentials, or real customer data.

## Project Shape

- Source of truth: `workflows/sdk/lead-intelligence.workflow.js`
- Metadata: `workflows/sdk/lead-intelligence.meta.json`
- Canonical JSON: `workflows/canonical/lead-intelligence.canonical.json`
- Release snapshot: `workflows/releases/lead-intelligence-v0.1.1.json`
- Regression fixtures: `fixtures/pin-data/*.json`
- Request spec: `fixtures/requests/lead-intelligence.md`
- Registry: `docs/registry/workflow-registry.md` and `docs/registry/index.json`

## Node-Level Coverage

- 38 workflow nodes.
- 1 n8n editor manual execution branch for direct `Execute Workflow` demos.
- 11 safe pin-data fixtures.
- Validation branches: missing required field and invalid email.
- Deduplication branches: explicit existing ID and deterministic duplicate domain.
- Lead outcomes: A hot enterprise, B commercial, C high-intent low-fit, D nurture, competitor disqualification, manual override.
- Audit guard: tests assert raw email, full name, and message do not leak into response or audit event.

## Setup

```powershell
cd C:\Dev\Projects\n8n-lead-intelligence-workflow
npm ci
```

Required local environment:

```powershell
$env:N8N_API_URL = "http://localhost:5678"
$env:N8N_API_KEY = "<your local n8n API key>"
$env:N8N_MCP_TOKEN = "<your official n8n MCP token>"
$env:N8N_CONTAINER_NAME = "n8n"
```

Check the local n8n connection:

```powershell
pwsh -NoProfile -File .\scripts\Test-N8nConnection.ps1
```

## Main Workflow Loop

```powershell
# Validate SDK, create/update local n8n draft, export, scrub, and write release.
pwsh -NoProfile -File .\scripts\Sync-N8nWorkflowFromSdk.ps1

# Generate registry files after canonical changes.
pwsh -NoProfile -File .\scripts\Build-WorkflowIndex.ps1

# Run offline checks.
npm run verify:static

# Run one fast live smoke case through official MCP pin data.
npm run smoke

# Run full live regression suite.
npm run verify:live
```

Manual editor execution check:

```powershell
pwsh -NoProfile -File .\scripts\Test-LeadUiExecution.ps1
```

## Useful Cases

```powershell
pwsh -NoProfile -File .\scripts\Test-LeadIntelligenceWorkflow.ps1 -CaseName hot-enterprise-lead
pwsh -NoProfile -File .\scripts\Test-LeadIntelligenceWorkflow.ps1 -CaseName competitor-domain
pwsh -NoProfile -File .\scripts\Test-LeadIntelligenceWorkflow.ps1 -CaseName manual-override
```

## Example Response Shape

```json
{
  "ok": true,
  "duplicate": false,
  "leadId": "lead_...",
  "grade": "A",
  "priorityScore": 97,
  "route": {
    "ownerQueue": "enterprise-ae",
    "ownerTeam": "enterprise-sales"
  },
  "followUp": {
    "slaHours": 2,
    "hotLead": true
  },
  "crmPayload": {
    "externalId": "lead_...",
    "idempotencyKey": "...",
    "ownerQueue": "enterprise-ae",
    "grade": "A"
  },
  "notification": {
    "status": "skipped"
  },
  "policyVersion": "lead-intel-v0.1.0"
}
```

## External Adapters Last

The workflow currently prepares a CRM-ready payload and a hot-lead notification object but does not call external services. Add CRM or Feishu only after:

1. `npm run verify:static` passes.
2. `npm run smoke` passes.
3. `npm run verify:live` passes.
4. Adapter credentials are configured outside Git.

See `docs/external-adapters.md`.
