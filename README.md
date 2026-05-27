# n8n Workflow-as-Code

Local Workflow-as-Code project for building n8n automations with Codex or Claude through MCP.

## What This Demonstrates

- AI-assisted workflow design with template-first research.
- Official n8n MCP workflow creation, validation, and test execution.
- Safe Git versioning for scrubbed workflow JSON.
- Docker CLI export for broad backups plus API export for exact draft workflow snapshots.
- Secret scanning and credential scrubbing before commit.

## Repository Layout

```text
docs/                     Architecture, MCP policy, lifecycle, demo notes
fixtures/                 Synthetic requests and pin data
prompts/                  Codex/Claude workflow-building prompts
scripts/                  PowerShell automation for checks, export, scrub, validation
workflows/raw/            Raw exports, ignored by Git
workflows/generated/      Timestamped export batches, ignored except .gitkeep
workflows/sdk/            Reviewable n8n Workflow SDK source of truth
workflows/canonical/      Scrubbed workflow JSON tracked in Git
workflows/releases/       Versioned release snapshots
artifacts/validation/     Local validation reports, ignored by Git
```

## MCP Split

| Server | Role | Writes local n8n? |
| --- | --- | --- |
| Official n8n MCP | Validate, create, update, test, publish local workflows | Yes |
| Community n8n-mcp | Templates, node docs, node validation, workflow pre-validation | No by default |

The normal agent session should configure community `n8n-mcp` without `N8N_API_URL` and `N8N_API_KEY`. Keep official n8n MCP as the only writable surface for the local instance.

## Setup

1. Start Docker Desktop and the local n8n stack.
2. Set `N8N_API_KEY` and `N8N_MCP_TOKEN` in your shell environment.
3. Keep community `n8n-mcp` in docs/design mode by omitting `N8N_API_URL` and `N8N_API_KEY` from its normal Codex/Claude profile.
4. Run the preflight:

```powershell
pwsh -NoProfile -File .\scripts\Test-N8nConnection.ps1
```

5. Build or update workflows through official n8n MCP, then export and scrub before committing.

## Quick Commands

```powershell
pwsh -NoProfile -File .\scripts\Test-N8nConnection.ps1
pwsh -NoProfile -File .\scripts\Sync-N8nWorkflowFromSdk.ps1
pwsh -NoProfile -File .\scripts\Test-SupportTriageWorkflow.ps1
pwsh -NoProfile -File .\scripts\Export-N8nWorkflows.ps1 -OutputDirectory .\workflows\generated
pwsh -NoProfile -File .\scripts\Export-N8nWorkflowApi.ps1 -WorkflowId RPkw9jGJ93lqs7jO -OutputDirectory .\workflows\generated
pwsh -NoProfile -File .\scripts\Scrub-N8nWorkflow.ps1 -InputPath .\workflows\generated\<timestamp> -OutputDirectory .\workflows\canonical
pwsh -NoProfile -File .\scripts\Test-N8nWorkflowJson.ps1 -Path .\workflows\canonical -MinimumNodes 21
```

## Local n8n Runtime Checklist

| Check | Status | Evidence |
| --- | --- | --- |
| `/home/node/.n8n` persisted | pass | Docker bind mount present, value not recorded here |
| Postgres configured | pass | `DB_TYPE=postgresdb` present |
| Fixed encryption key configured | pass | env var present, value not recorded |
| Task runner sidecar present | pass | `n8n-runners` container running |
| Dangerous nodes excluded | pass | `NODES_EXCLUDE` blocks `executeCommand` and `readWriteFile` |
| API key works | pass | `Test-N8nConnection.ps1` passed |
| Official MCP works | pass | `validate_workflow`, `create_workflow_from_code`, and `test_workflow` passed |
| Community n8n-mcp docs profile works | configured | Codex config no longer passes n8n API credentials to community n8n-mcp; restart Codex to reload |

## Engineering Demo Workflow

The portfolio workflow is `Portfolio - Support Triage API`.

It receives a support ticket through a webhook, normalizes payload variants, validates required fields, classifies category, scores urgency, routes the owning team, computes SLA, branches escalation, creates a redacted audit event, and returns a structured response. The workflow intentionally avoids third-party credentials so the orchestration, testing, export, scrub, and release lifecycle can be demonstrated reliably.

Current workflow scale:

- 21 n8n nodes.
- 8 official MCP pin-data test paths.
- 5 category outcomes: `incident`, `billing`, `account`, `bug`, `general`.
- 4 urgency tiers: `critical`, `urgent`, `high`, `normal`.
- 2 handling paths: `escalated`, `standard`.

## Lifecycle

1. Capture the requirement under `fixtures/requests`.
2. Use community n8n-mcp for template and node research.
3. Treat `workflows/sdk/portfolio-support-triage-api.workflow.js` as the source of truth.
4. Run `Sync-N8nWorkflowFromSdk.ps1` to validate SDK code through official MCP, update the local draft, export via API, scrub canonical JSON, and copy the release snapshot.
5. Run `Test-SupportTriageWorkflow.ps1` to prove all current pin-data branches.
6. Use `Export-N8nWorkflows.ps1` for broad Docker backup exports when needed.
7. Commit only docs, fixtures, scripts, SDK source, canonical JSON, and release snapshots.

## Resume Bullet

Built a local n8n Workflow-as-Code platform using Codex/Claude, official n8n MCP, community n8n-mcp, Docker, and PowerShell to generate, validate, test, export, scrub, and version automation workflows with a Git-backed release process.

## Current Status

- Planning complete.
- Project skeleton created.
- Local n8n runtime verified.
- Official MCP created and upgraded `Portfolio - Support Triage API` as a 21-node draft workflow.
- Official MCP multi-path pin-data tests passed for enterprise incident, urgent incident, billing, account alias, bug, general, invalid-date, and missing-field requests.
- Canonical workflow JSON and `v0.2.0` release snapshot contain the enhanced 21-node workflow.

## Verification

- PowerShell script parse check: pass.
- Pin-data fixture JSON parse: pass.
- Scrub + validation synthetic workflow test: pass.
- n8n health check: pass.
- n8n API key check: pass.
- official MCP initialize: pass.
- official MCP workflow validation: pass.
- official MCP workflow creation: pass.
- official MCP workflow test: pass.
- official MCP multi-path tests: pass for 8 payloads.
- SDK sync script: pass.
- export scripts: pass.
- API draft export script: pass.
- canonical JSON validation with 21-node floor: pass.
- release JSON validation with 21-node floor: pass.
