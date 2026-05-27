# n8n Workflow-as-Code

Local Workflow-as-Code project for building n8n automations with Codex or Claude through MCP.

## What This Demonstrates

- AI-assisted workflow design with template-first research.
- Official n8n MCP workflow creation, validation, and test execution.
- Safe Git versioning for scrubbed workflow JSON.
- Local Docker-based export that does not depend on host mounts.
- Secret scanning and credential scrubbing before commit.

## Repository Layout

```text
docs/                     Architecture, MCP policy, lifecycle, demo notes
fixtures/                 Synthetic requests and pin data
prompts/                  Codex/Claude workflow-building prompts
scripts/                  PowerShell automation for checks, export, scrub, validation
workflows/raw/            Raw exports, ignored by Git
workflows/generated/      Timestamped export batches, ignored except .gitkeep
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
pwsh -NoProfile -File .\scripts\Export-N8nWorkflows.ps1 -OutputDirectory .\workflows\generated
pwsh -NoProfile -File .\scripts\Scrub-N8nWorkflow.ps1 -InputPath .\workflows\generated\<timestamp> -OutputDirectory .\workflows\canonical
pwsh -NoProfile -File .\scripts\Test-N8nWorkflowJson.ps1 -Path .\workflows\canonical
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

## First Demo Workflow

The first portfolio workflow is `Portfolio - Support Triage API`.

It receives a support ticket through a webhook, validates required fields, classifies urgency with deterministic logic, and returns a structured response. The MVP avoids third-party credentials so the MCP build and export/scrub lifecycle can be demonstrated reliably before adding LLM or SaaS integrations.

## Lifecycle

1. Capture the requirement under `fixtures/requests`.
2. Use community n8n-mcp for template and node research.
3. Use official n8n MCP to validate, create/update, and test the local draft.
4. Export with `Export-N8nWorkflows.ps1`.
5. Scrub with `Scrub-N8nWorkflow.ps1`.
6. Validate canonical JSON with `Test-N8nWorkflowJson.ps1`.
7. Commit only docs, fixtures, scripts, canonical JSON, and release snapshots.

## Resume Bullet

Built a local n8n Workflow-as-Code platform using Codex/Claude, official n8n MCP, community n8n-mcp, Docker, and PowerShell to generate, validate, test, export, scrub, and version automation workflows with a Git-backed release process.

## Current Status

- Planning complete.
- Project skeleton created.
- Local n8n runtime verified.
- Official MCP created `Portfolio - Support Triage API` as a draft workflow.
- Official MCP pin-data test passed with `urgency=urgent`, `routingTeam=platform-support`, and `slaHours=2`.
- Canonical workflow JSON exported, scrubbed, validated, and saved under `workflows/canonical`.

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
- export script: pass.
- canonical JSON validation: pass.
- release JSON validation: pass.
