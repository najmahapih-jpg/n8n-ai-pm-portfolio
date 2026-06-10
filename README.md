# n8n Workflow-as-Code

Local Workflow-as-Code project for building n8n automations with Codex or Claude through MCP.

## Quickstart (offline, zero config)

Prereqs: Node ≥ 20 and [PowerShell 7+](https://learn.microsoft.com/powershell/scripting/install/installing-powershell) (`pwsh`, cross-platform — macOS: `brew install powershell`).

```bash
npm ci
npm run verify:static     # offline gate: secret scan, JSON shape, registry freshness
npm run verify:workflow   # pin-data behavioral regression of support-triage (no n8n)
npm run smoke             # fixture smoke pass
npm run verify:feishu     # Feishu notification layer (skips gracefully when unconfigured)
```

Every gate is **stub-default**: a fresh clone runs green with no n8n, no keys, no network. To run it
live (optional), import `workflows/canonical/portfolio-support-triage-api.canonical.json` into your
n8n, copy `.env.example` → `.env`, then `npm run verify:live`. Outbound Feishu alerts are documented
in `docs/feishu-local-setup.md`. Deploying the **whole connected portfolio** (siblings → gateway →
agent, with the ID-rewiring step) is covered in `docs/adopt-on-your-n8n.md`.

## What This Demonstrates

- AI-assisted workflow design with template-first research.
- Official n8n MCP workflow creation, validation, and test execution.
- Safe Git versioning for scrubbed workflow JSON.
- Deterministic canonical/release snapshots without volatile n8n instance IDs.
- Docker CLI export for broad backups plus API export for exact draft workflow snapshots.
- Secret scanning and credential scrubbing before commit.

## Repository Layout

```text
docs/                     Architecture, MCP policy, lifecycle, demo notes
docs/registry/            Generated workflow registry markdown and machine index
fixtures/                 Synthetic requests and pin data
prompts/                  Codex/Claude workflow-building prompts
scripts/                  PowerShell automation for checks, export, scrub, validation
.github/workflows/        CI for offline validation and repository secret checks
.githooks/                Optional local Git hooks backed by the same static checks
workflows/raw/            Raw exports, ignored by Git
workflows/generated/      Timestamped export batches, ignored except .gitkeep
workflows/sdk/            Reviewable n8n Workflow SDK source of truth
workflows/sdk/*.meta.json Per-workflow metadata used to generate the registry
workflows/canonical/      Scrubbed workflow JSON tracked in Git
workflows/releases/       Versioned release snapshots
artifacts/validation/     Local validation reports, ignored by Git
package.json              Locked Workflow SDK dependency and verification scripts
```

## MCP Split

| Server | Role | Writes local n8n? |
| --- | --- | --- |
| Official n8n MCP | Validate, create, update, test, publish local workflows | Yes |
| Community n8n-mcp | Templates, node docs, node validation, workflow pre-validation | No by default |

The normal agent session should configure community `n8n-mcp` without `N8N_API_URL` and `N8N_API_KEY`. Keep official n8n MCP as the only writable surface for the local instance.

## Setup

1. Start Docker Desktop and the local n8n stack.
2. Install the locked JavaScript dependency used by Workflow SDK source files:

```powershell
npm ci
```

3. Set `N8N_API_KEY` and `N8N_MCP_TOKEN` in your shell environment.
4. Keep community `n8n-mcp` in docs/design mode by omitting `N8N_API_URL` and `N8N_API_KEY` from its normal Codex/Claude profile.
5. Install the optional local pre-commit hook:

```powershell
npm run hooks:install
```

6. Run the preflight:

```powershell
pwsh -NoProfile -File .\scripts\Test-N8nConnection.ps1
```

7. Build or update workflows through official n8n MCP, then export and scrub before committing.

## Quick Commands

```powershell
npm run verify:static
npm run smoke
npm run registry:build
npm run verify:live
pwsh -NoProfile -File .\scripts\Test-N8nConnection.ps1
pwsh -NoProfile -File .\scripts\Sync-N8nWorkflowFromSdk.ps1
pwsh -NoProfile -File .\scripts\Test-SupportTriageWorkflow.ps1
pwsh -NoProfile -File .\scripts\Test-FeishuWorkflowJson.ps1
pwsh -NoProfile -File .\scripts\Export-N8nWorkflows.ps1 -OutputDirectory .\workflows\generated
pwsh -NoProfile -File .\scripts\Export-N8nWorkflowApi.ps1 -WorkflowId RPkw9jGJ93lqs7jO -OutputDirectory .\workflows\generated
pwsh -NoProfile -File .\scripts\Scrub-N8nWorkflow.ps1 -InputPath .\workflows\generated\<timestamp> -OutputDirectory .\workflows\canonical
pwsh -NoProfile -File .\scripts\Test-N8nWorkflowJson.ps1 -Path .\workflows\canonical -MinimumNodes 27
```

Create a new workflow skeleton with:

```powershell
pwsh -NoProfile -File .\scripts\New-N8nWorkflowScaffold.ps1 -Slug customer-health-digest -Title "Customer Health Digest" -Description "Summarize account health signals into a local webhook response."
```

## Local n8n Runtime Checklist

| Check | Status | Evidence |
| --- | --- | --- |
| `/home/node/.n8n` persisted | pass | Docker bind mount present, value not recorded here |
| Postgres configured | pass | `DB_TYPE=postgresdb` present |
| Fixed encryption key configured | pass | env var present, value not recorded |
| Task runner sidecar present | pass | `n8n-runners` container running |
| Dangerous nodes excluded | pass | `NODES_EXCLUDE` blocks `executeCommand` and `readWriteFile` |
| Environment-backed Feishu config | pass | `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` for this local stack; dangerous nodes remain excluded |
| API key works | pass | `Test-N8nConnection.ps1` passed |
| Official MCP works | pass | `validate_workflow`, `create_workflow_from_code`, and `test_workflow` passed |
| Community n8n-mcp docs profile works | configured | Codex config no longer passes n8n API credentials to community n8n-mcp; restart Codex to reload |

## Engineering Demo Workflow

The portfolio workflow is `Portfolio - Support Triage API`.

It receives a support ticket through a webhook, normalizes payload variants, validates required fields, classifies category, scores urgency, routes the owning team, computes SLA, branches escalation, creates a redacted audit event, optionally sends a Feishu group bot alert, and returns a structured response.

Current workflow scale:

- 27 n8n nodes.
- 8 official MCP pin-data test paths.
- 5 category outcomes: `incident`, `billing`, `account`, `bug`, `general`.
- 4 urgency tiers: `critical`, `urgent`, `high`, `normal`.
- 2 handling paths: `escalated`, `standard`.
- 1 local-only Feishu custom bot notification path, skipped automatically when no webhook is configured.

## Lifecycle

1. Capture the requirement under `fixtures/requests`.
2. Use community n8n-mcp for template and node research.
3. Treat `workflows/sdk/portfolio-support-triage-api.workflow.js` as the source of truth.
4. Maintain `workflows/sdk/<slug>.meta.json` for registry metadata.
5. Run `Sync-N8nWorkflowFromSdk.ps1` to validate SDK code through official MCP, update the local draft, export via API, scrub canonical JSON, and copy the release snapshot.
6. Run `Build-WorkflowIndex.ps1` after canonical or metadata changes.
7. Run `Test-SupportTriageWorkflow.ps1` to prove all current pin-data branches.
8. Run `Test-FeishuWorkflowJson.ps1` to prove Feishu nodes and secret-free placeholders are present.
9. Use `Export-N8nWorkflows.ps1` for broad Docker backup exports when needed.
10. Commit only docs, fixtures, scripts, SDK source, metadata, canonical JSON, and release snapshots.

## Evaluation & Decision Records

The pin-data suite is documented as a behavioral **eval**, with an explicit
static-vs-behavioral validation split and a decision log for the deterministic-vs-LLM choice:

- [docs/eval-methodology.md](docs/eval-methodology.md) — assertion taxonomy, coverage matrix, regression semantics, and the production metrics this eval stands in for.
- [docs/adr/0001-deterministic-routing-over-llm-classification.md](docs/adr/0001-deterministic-routing-over-llm-classification.md) — why routing is deterministic, and the conditions under which an LLM is the right call.

> Validation is two-tier: CI runs the **offline static gate** only; the **behavioral pin-data
> eval** (`Test-SupportTriageWorkflow.ps1`) is a local step that requires a live n8n instance.

## Resume Bullet

Built a local n8n Workflow-as-Code platform using Codex/Claude, official n8n MCP, community n8n-mcp, Docker, and PowerShell to generate, validate, test, export, scrub, and version automation workflows with a Git-backed release process.

## Current Status

- Planning complete.
- Project skeleton created.
- Package metadata, Apache-2.0 license, CI, and optional local pre-commit checks added.
- Per-workflow metadata, generated registry/index, scaffold script, and smoke-test command added.
- Local n8n runtime verified.
- Official MCP created and upgraded `Portfolio - Support Triage API` as a 27-node local Feishu draft workflow.
- Official MCP multi-path pin-data tests passed for enterprise incident, urgent incident, billing, account alias, bug, general, invalid-date, and missing-field requests.
- Canonical workflow JSON and `v0.3.0` release snapshot contain the enhanced 27-node workflow.

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
- Feishu workflow JSON validation: pass.
- workflow registry freshness check: pass.
- smoke test: pass for `enterprise-incident` in no-send mode.
- SDK sync script: pass.
- export scripts: pass.
- API draft export script: pass.
- canonical JSON validation with 27-node floor: pass.
- release JSON validation with 27-node floor: pass.

## Final Optional Feishu Setup

This project supports one-way local n8n to Feishu group notifications. See `docs/feishu-local-setup.md`.

Best no-deployment path: use Feishu custom bot webhooks for outbound alerts only. n8n stays local and calls Feishu directly. If you later need Feishu to call back into n8n, use a temporary tunnel for validation or deploy a small public webhook endpoint; the current project intentionally avoids that path.

Set these only in your local Docker environment, not in Git:

```text
FEISHU_BOT_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/<your-hook-id>
FEISHU_BOT_SIGNING_SECRET=<optional-signing-secret>
```

Use this one-case Feishu send smoke test only after a real Feishu webhook is configured in the local n8n Docker environment:

```powershell
pwsh -NoProfile -File .\scripts\Test-SupportTriageWorkflow.ps1 -CaseName enterprise-incident -FeishuMode sent
```

## Open Source Health

This repository includes the baseline files needed for public collaboration:

- License: Apache-2.0 (`LICENSE`).
- Contributions: `CONTRIBUTING.md`.
- Security policy: `SECURITY.md`.
- Security and privacy boundaries: `docs/security-boundaries.md`.
- Workflow contract: `docs/workflow-contract.md`.
- Conduct: `CODE_OF_CONDUCT.md`.
- GitHub templates: `.github/ISSUE_TEMPLATE/` and `.github/pull_request_template.md`.

Before publishing or accepting contributions, run `npm run verify:static`, `npm run verify:json`, and `npm run smoke`; run `npm run verify:live` only when local n8n and required credentials are configured.
