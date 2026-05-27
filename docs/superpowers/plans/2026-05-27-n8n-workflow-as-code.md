# n8n Workflow-as-Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, portfolio-grade n8n Workflow-as-Code project that lets Codex or Claude turn requirements into validated local n8n workflows, export them, scrub secrets, version them in Git, and document the delivery process.

**Architecture:** Git is the source of truth for scrubbed workflow JSON, docs, prompts, fixtures, and scripts. The local n8n Docker instance is the runtime for create/update/test/publish. The official n8n MCP is the authoritative writer for the local instance; `czlonkowski/n8n-mcp` is the design-time assistant for templates, node docs, node validation, and workflow pre-validation.

**Tech Stack:** Windows, PowerShell 7, Docker Desktop, n8n Docker, Postgres-backed n8n, n8n official MCP, `czlonkowski/n8n-mcp`, Git, Markdown, JSON.

---

## Requirements Summary

- Project path: `C:\Dev\Projects\n8n-workflow-as-code`.
- Keep n8n credentials, API keys, MCP tokens, raw exports, execution logs, and decrypted credential exports out of Git.
- Support both Codex and Claude as workflow-building agents through clear prompt rules.
- Use both MCP servers without conflict:
  - Official n8n MCP: create, update, validate, test, execute, publish, unpublish local workflows.
  - Community `n8n-mcp`: search templates, inspect node schemas, validate node config, validate workflow JSON before deployment.
- Preferred community `n8n-mcp` profile: run without `N8N_API_URL` and `N8N_API_KEY` for normal design sessions so instance-management tools are not physically available. Use a separate maintenance profile only when community management tools are intentionally needed.
- Use local scripts for repeatable operations:
  - Connection checks.
  - Export from Docker without assuming a host volume mount.
  - Scrub exported workflow JSON.
  - Static validation for JSON shape and secret leaks.
- First demonstrable workflow: `Portfolio - Support Triage API`, a webhook-driven support triage workflow with deterministic test data, explicit node configuration, and no real third-party credential dependency in the first pass.
- Docker Desktop must be running before runtime verification. During plan creation, `docker ps` failed because the Docker daemon was not available.

## Source Notes

- n8n Docker hosting: persist `/home/node/.n8n`; use Postgres for serious local/runtime work.
- n8n CLI export: use the server CLI inside the same Docker image, with `--separate` and `--pretty` for versionable JSON.
- n8n export/import warning: exported JSON can reveal credential names, credential IDs, and HTTP headers.
- n8n official MCP: use `validate_workflow` before create/update; use `test_workflow` with pin data; publish only after validation.
- n8n official MCP access: MCP access is not isolated per client, so use a dedicated low-permission account/project and expose only required workflows.
- n8n security: block high-risk nodes such as Execute Command and local file read/write nodes through `NODES_EXCLUDE`.
- `czlonkowski/n8n-mcp`: templates first, validate nodes at multiple levels, explicitly configure behavior-controlling parameters, never edit production workflows directly with AI.

## File Structure

Create this structure during implementation:

```text
C:\Dev\Projects\n8n-workflow-as-code\
  .gitignore
  README.md
  docs\
    architecture.md
    demo-script.md
    mcp-policy.md
    workflow-lifecycle.md
    superpowers\
      plans\
        2026-05-27-n8n-workflow-as-code.md
  fixtures\
    pin-data\
      support-triage-input.json
    requests\
      support-triage.md
  prompts\
    codex-n8n-rules.md
    workflow-request-template.md
  scripts\
    Export-N8nWorkflows.ps1
    Scrub-N8nWorkflow.ps1
    Test-N8nConnection.ps1
    Test-N8nWorkflowJson.ps1
  workflows\
    canonical\
      .gitkeep
    generated\
      .gitkeep
    releases\
      .gitkeep
```

## Acceptance Criteria

- `C:\Dev\Projects\n8n-workflow-as-code` is a Git repository with the planned structure.
- `README.md` explains setup, MCP roles, build lifecycle, demo workflow, security posture, and resume value.
- `docs\mcp-policy.md` states one-writer rules: official MCP writes local instance; community MCP is read/design/pre-validation unless official MCP is unavailable and the user explicitly chooses failover.
- `scripts\Test-N8nConnection.ps1` detects Docker daemon status, n8n health endpoint status, API key access, and MCP config prerequisites without printing secrets.
- `scripts\Export-N8nWorkflows.ps1` exports workflows from the n8n Docker container by writing to a temporary container path and copying to the host with `docker cp`; it does not require a mounted `/files` directory.
- `scripts\Scrub-N8nWorkflow.ps1` removes workflow IDs, version IDs, credential references, pin data when requested, and risky HTTP auth/header values from exported JSON.
- `scripts\Test-N8nWorkflowJson.ps1` fails on invalid JSON, credential references, known secret-like strings, raw Authorization headers, and absolute local file paths.
- The first workflow is created in the local n8n instance as a draft, validated with official MCP, tested with pin data, exported, scrubbed, and saved to `workflows\canonical`.
- Raw exports stay untracked; scrubbed canonical workflows are tracked.
- Final verification includes script runs, `git status`, and at least one successful local n8n workflow test.

## Implementation Tasks

### Task 1: Initialize Project Repository

**Files:**
- Create: `C:\Dev\Projects\n8n-workflow-as-code\.gitignore`
- Keep: `C:\Dev\Projects\n8n-workflow-as-code\docs\superpowers\plans\2026-05-27-n8n-workflow-as-code.md`

- [ ] **Step 1: Create the directory structure**

Run:

```powershell
New-Item -ItemType Directory -Force -Path `
  'C:\Dev\Projects\n8n-workflow-as-code\docs', `
  'C:\Dev\Projects\n8n-workflow-as-code\fixtures\pin-data', `
  'C:\Dev\Projects\n8n-workflow-as-code\fixtures\requests', `
  'C:\Dev\Projects\n8n-workflow-as-code\prompts', `
  'C:\Dev\Projects\n8n-workflow-as-code\scripts', `
  'C:\Dev\Projects\n8n-workflow-as-code\workflows\canonical', `
  'C:\Dev\Projects\n8n-workflow-as-code\workflows\generated', `
  'C:\Dev\Projects\n8n-workflow-as-code\workflows\releases' | Out-Null
```

Expected: command exits with code `0`.

- [ ] **Step 2: Initialize Git**

Run:

```powershell
Set-Location 'C:\Dev\Projects\n8n-workflow-as-code'
git init
```

Expected: `.git` exists under `C:\Dev\Projects\n8n-workflow-as-code`.

- [ ] **Step 3: Create `.gitignore`**

Write this exact file:

```gitignore
# Local secrets
.env
.env.*
!.env.example

# n8n sensitive exports and runtime data
workflows\raw\
workflows\exports\
workflows\generated\*.raw.json
workflows\generated\20*
workflows\raw\
credentials\
executions\
logs\
artifacts\validation\

# PowerShell and local scratch
*.log
*.tmp
*.bak

# OS/editor
Thumbs.db
.DS_Store
.vscode\
.idea\
```

- [ ] **Step 4: Add directory placeholders**

Create empty placeholder files:

```text
C:\Dev\Projects\n8n-workflow-as-code\workflows\canonical\.gitkeep
C:\Dev\Projects\n8n-workflow-as-code\workflows\generated\.gitkeep
C:\Dev\Projects\n8n-workflow-as-code\workflows\releases\.gitkeep
```

- [ ] **Step 5: Commit scaffold**

Run:

```powershell
git add .gitignore docs workflows
git commit -m "Establish local n8n workflow-as-code workspace

The repository separates generated, canonical, and release workflow assets so agents can operate with a clear source-of-truth boundary.

Constraint: Raw n8n exports and credentials must never be tracked.
Confidence: high
Scope-risk: narrow
Tested: Directory structure created locally
Not-tested: n8n runtime unavailable until Docker Desktop starts"
```

Expected: one commit exists in `git log --oneline -1`.

### Task 2: Document Architecture and MCP Policy

**Files:**
- Create: `C:\Dev\Projects\n8n-workflow-as-code\docs\architecture.md`
- Create: `C:\Dev\Projects\n8n-workflow-as-code\docs\mcp-policy.md`
- Create: `C:\Dev\Projects\n8n-workflow-as-code\docs\workflow-lifecycle.md`

- [ ] **Step 1: Write `docs\architecture.md`**

Include these sections:

```markdown
# Architecture

## System Roles

- Git repository: source of truth for scrubbed workflows, fixtures, prompts, scripts, and docs.
- Local n8n Docker instance: runtime for draft creation, workflow validation, test execution, and publish checks.
- Official n8n MCP: authoritative writer for local workflow create, update, validate, test, execute, publish, and unpublish operations.
- Community n8n-mcp: design-time assistant for templates, node documentation, node configuration examples, node validation, and workflow pre-validation.
- PowerShell scripts: repeatable local export, scrub, and static validation path.

## Data Flow

Requirement markdown -> template/node research -> workflow draft -> community validation -> official MCP validation -> local n8n draft -> pin-data test -> CLI export -> scrub -> canonical JSON -> release snapshot.

## Runtime Boundary

The n8n instance can contain live credentials and execution history. The Git repository cannot contain live credentials, raw execution data, decrypted credentials, or raw exported workflows.
```

- [ ] **Step 2: Write `docs\mcp-policy.md`**

Include this policy:

```markdown
# MCP Policy

## One-Writer Rule

Only the official n8n MCP writes to the local n8n instance during normal work.

For normal Codex or Claude design sessions, community n8n-mcp should be configured without `N8N_API_URL` and `N8N_API_KEY`. This keeps its workflow-management tools unavailable and leaves only documentation, template, node discovery, and validation tools.

Allowed official MCP operations:
- `validate_workflow`
- `create_workflow_from_code`
- `update_workflow`
- `prepare_test_pin_data`
- `test_workflow`
- `execute_workflow`
- `publish_workflow`
- `unpublish_workflow`
- workflow search/list/read operations

Allowed community n8n-mcp operations:
- `tools_documentation`
- `search_templates`
- `get_template`
- `search_nodes`
- `get_node`
- `validate_node`
- `validate_workflow`
- documentation and schema lookup operations

Disallowed by default:
- Using community `n8n_create_workflow`, `n8n_update_full_workflow`, `n8n_update_partial_workflow`, or `n8n_delete_workflow` when official MCP is available.
- Running official MCP and community n8n-mcp as simultaneous writable management surfaces in the same agent session.
- Publishing a workflow before validation and pin-data testing.
- Editing production workflows directly with AI.

## Failover Rule

If official MCP is unavailable, community n8n-mcp management tools may be used only in a separate maintenance profile after the operator records the reason in `docs\workflow-lifecycle.md` under a dated decision note.

## Secret Rule

No agent may print or commit `N8N_API_KEY`, `N8N_MCP_TOKEN`, credential payloads, decrypted credential exports, Authorization headers, cookies, or private webhook URLs.

## Concurrency Rule

Codex and Claude must not modify the same workflow at the same time. Prefer a staging project or folder named `MCP Staging` or `AI Drafts`, and record workflow IDs in a registry before publishing.
```

- [ ] **Step 3: Write `docs\workflow-lifecycle.md`**

Include this lifecycle:

```markdown
# Workflow Lifecycle

1. Capture the requirement in `fixtures\requests`.
2. Search templates first with community n8n-mcp.
3. Search node schemas and examples with community n8n-mcp.
4. Configure every behavior-controlling node parameter explicitly.
5. Validate each non-trivial node configuration.
6. Validate the complete workflow JSON before deployment.
7. Validate the workflow through official n8n MCP before create/update.
8. Create or update the local n8n draft through official n8n MCP.
9. Prepare pin data and run `test_workflow`.
10. Export workflows through the n8n Docker server CLI into an ignored raw/generated timestamp directory.
11. Scrub exported JSON into `workflows\canonical`.
12. Run static JSON validation.
13. Commit only scrubbed canonical JSON, fixtures, prompts, scripts, and docs.
14. Create a release snapshot after successful demo verification.
```

- [ ] **Step 4: Commit docs**

Run:

```powershell
git add docs\architecture.md docs\mcp-policy.md docs\workflow-lifecycle.md
git commit -m "Define MCP ownership and workflow lifecycle

The docs make official n8n MCP the only normal writer to the local instance while using community n8n-mcp for research and validation support.

Constraint: Both MCP servers can manage n8n, so conflicting writers must be avoided.
Rejected: Let both MCP servers create and update workflows | increases drift and debugging ambiguity
Confidence: high
Scope-risk: narrow
Tested: Policy docs reviewed for one-writer coverage"
```

### Task 3: Create Agent Prompts and Request Fixture

**Files:**
- Create: `C:\Dev\Projects\n8n-workflow-as-code\prompts\workflow-request-template.md`
- Create: `C:\Dev\Projects\n8n-workflow-as-code\prompts\codex-n8n-rules.md`
- Create: `C:\Dev\Projects\n8n-workflow-as-code\fixtures\requests\support-triage.md`
- Create: `C:\Dev\Projects\n8n-workflow-as-code\fixtures\pin-data\support-triage-input.json`

- [ ] **Step 1: Write `prompts\workflow-request-template.md`**

Use this template:

```markdown
# Workflow Request

## Name

## Business Outcome

## Trigger

## Inputs

## Outputs

## External Services

## Credentials Required

## Test Data

## Error Handling

## Privacy and Security Notes

## Done Criteria
```

- [ ] **Step 2: Write `prompts\codex-n8n-rules.md`**

Use these agent rules:

```markdown
# Codex n8n Build Rules

1. Start with template discovery through community n8n-mcp.
2. Use official n8n MCP for local instance writes.
3. Validate before create or update.
4. Configure every behavior-controlling parameter explicitly.
5. Prefer standard n8n nodes over Code nodes.
6. Use Code nodes only when the transformation cannot be expressed clearly with standard nodes.
7. Never commit credentials, raw exports, execution data, Authorization headers, cookies, or decrypted credential exports.
8. Use pin data for repeatable tests.
9. Keep workflow names stable and portfolio-friendly.
10. Add a short sticky note or documentation node inside each meaningful workflow when supported by the build path.
```

- [ ] **Step 3: Write `fixtures\requests\support-triage.md`**

Use this request:

```markdown
# Workflow Request

## Name
Portfolio - Support Triage API

## Business Outcome
Receive support tickets through a webhook, classify urgency, normalize fields, return a structured response, and record enough metadata for later storage integration.

## Trigger
HTTP POST webhook at `/portfolio/support-triage`.

## Inputs
- `customerEmail`
- `subject`
- `message`
- `plan`
- `receivedAt`

## Outputs
- `ticketId`
- `urgency`
- `summary`
- `routingTeam`
- `slaHours`

## External Services
None in MVP. Use deterministic logic first. Add LLM classification in a later workflow version after credential handling is documented.

## Credentials Required
None in MVP.

## Test Data
Use `fixtures\pin-data\support-triage-input.json`.

## Error Handling
Return HTTP 400 when `customerEmail`, `subject`, or `message` is missing. Return HTTP 200 with triage output for valid requests.

## Privacy and Security Notes
Do not store full customer messages in Git fixtures beyond synthetic examples.

## Done Criteria
- Draft workflow exists in local n8n.
- Official MCP validation passes.
- Pin-data test passes.
- Exported workflow is scrubbed and saved in `workflows\canonical`.
```

- [ ] **Step 4: Write `fixtures\pin-data\support-triage-input.json`**

Use this JSON:

```json
{
  "customerEmail": "casey@example.test",
  "subject": "Production checkout failures",
  "message": "Customers on our enterprise plan cannot complete checkout. The error started after today's deployment and affects all regions.",
  "plan": "enterprise",
  "receivedAt": "2026-05-27T10:00:00-04:00"
}
```

- [ ] **Step 5: Commit prompts and fixtures**

Run:

```powershell
git add prompts fixtures
git commit -m "Capture first portfolio workflow request

The initial workflow avoids third-party credentials so local validation can prove the workflow lifecycle before LLM or SaaS integrations are added.

Constraint: First demo must be reproducible without paid external services.
Confidence: high
Scope-risk: narrow
Tested: Fixture JSON parses with ConvertFrom-Json"
```

### Task 4: Build Connection Preflight Script

**Files:**
- Create: `C:\Dev\Projects\n8n-workflow-as-code\scripts\Test-N8nConnection.ps1`

- [ ] **Step 1: Write `scripts\Test-N8nConnection.ps1`**

The script must:

- Check whether Docker responds.
- Check whether a container named `n8n` exists.
- Check `http://localhost:5678/healthz`.
- Check `N8N_API_KEY` exists without printing it.
- Call `/api/v1/workflows` with the API key and report status code.
- Check `N8N_MCP_TOKEN` exists without printing it.
- Exit `0` only when all checks pass.

Core implementation:

```powershell
param(
  [string]$BaseUrl = "http://localhost:5678",
  [string]$ContainerName = "n8n"
)

$ErrorActionPreference = "Stop"
$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure([string]$Message) {
  $script:failures.Add($Message) | Out-Null
}

try {
  docker version --format '{{.Server.Version}}' | Out-Null
} catch {
  Add-Failure "Docker daemon is not available."
}

try {
  $container = docker ps --format '{{.Names}}' | Where-Object { $_ -eq $ContainerName }
  if (-not $container) { Add-Failure "Container '$ContainerName' is not running." }
} catch {
  Add-Failure "Could not list Docker containers."
}

try {
  $health = Invoke-WebRequest -Uri "$BaseUrl/healthz" -UseBasicParsing -TimeoutSec 5
  if ($health.StatusCode -ne 200) { Add-Failure "n8n health endpoint returned $($health.StatusCode)." }
} catch {
  Add-Failure "n8n health endpoint is not reachable at $BaseUrl."
}

if ([string]::IsNullOrWhiteSpace($env:N8N_API_KEY)) {
  Add-Failure "N8N_API_KEY is not set."
} else {
  try {
    $headers = @{ "X-N8N-API-KEY" = $env:N8N_API_KEY }
    $response = Invoke-WebRequest -Uri "$BaseUrl/api/v1/workflows" -Headers $headers -UseBasicParsing -TimeoutSec 10
    if ($response.StatusCode -ne 200) { Add-Failure "n8n API returned $($response.StatusCode)." }
  } catch {
    Add-Failure "n8n API key check failed."
  }
}

if ([string]::IsNullOrWhiteSpace($env:N8N_MCP_TOKEN)) {
  Add-Failure "N8N_MCP_TOKEN is not set."
}

if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Error $_ }
  exit 1
}

Write-Host "n8n local connection checks passed."
exit 0
```

- [ ] **Step 2: Run script with Docker stopped or unavailable**

Run:

```powershell
pwsh -NoProfile -File .\scripts\Test-N8nConnection.ps1
```

Expected when Docker is not running: exit code `1` and a clear Docker daemon failure. The script must not print any secret value.

- [ ] **Step 3: Run script after Docker Desktop starts**

Run:

```powershell
pwsh -NoProfile -File .\scripts\Test-N8nConnection.ps1
```

Expected when n8n is running and env vars are set: exit code `0` and `n8n local connection checks passed.`

- [ ] **Step 4: Commit connection script**

Run:

```powershell
git add scripts\Test-N8nConnection.ps1
git commit -m "Add n8n local connection preflight

The preflight checks Docker, the n8n health endpoint, API access, and MCP token presence without exposing secret values.

Constraint: Docker Desktop may be stopped in local development sessions.
Confidence: high
Scope-risk: narrow
Tested: Failure path with Docker unavailable; success path after Docker starts"
```

### Task 5: Build Docker-Aware Export Script

**Files:**
- Create: `C:\Dev\Projects\n8n-workflow-as-code\scripts\Export-N8nWorkflows.ps1`

- [ ] **Step 1: Write `scripts\Export-N8nWorkflows.ps1`**

The script must:

- Run `n8n export:workflow` inside the `n8n` Docker container.
- Use a unique temporary path inside the container.
- Copy exported files to the host with `docker cp`.
- Avoid any assumption that `/files` is mounted.
- Support `-PublishedOnly`.
- Exit non-zero on Docker/export/copy failure.
- Never export credentials and never support decrypted credential export.
- Never print raw workflow JSON to stdout.

Core implementation:

```powershell
param(
  [string]$ContainerName = "n8n",
  [string]$OutputDirectory = ".\workflows\generated",
  [switch]$PublishedOnly
)

$ErrorActionPreference = "Stop"
$hostOutput = Resolve-Path -LiteralPath $OutputDirectory -ErrorAction SilentlyContinue
if (-not $hostOutput) {
  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  $hostOutput = Resolve-Path -LiteralPath $OutputDirectory
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$containerExportDir = "/tmp/n8n-workflow-export-$stamp"
$publishedArg = if ($PublishedOnly) { "--published" } else { "" }

docker exec $ContainerName sh -lc "rm -rf '$containerExportDir' && mkdir -p '$containerExportDir'"
if ($LASTEXITCODE -ne 0) { throw "Failed to create container export directory." }

$exportCommand = "n8n export:workflow --all --separate --pretty --output='$containerExportDir' $publishedArg"
docker exec -u node $ContainerName sh -lc $exportCommand
if ($LASTEXITCODE -ne 0) { throw "n8n workflow export failed." }

$destination = Join-Path $hostOutput.Path $stamp
New-Item -ItemType Directory -Force -Path $destination | Out-Null

docker cp "${ContainerName}:$containerExportDir/." $destination
if ($LASTEXITCODE -ne 0) { throw "docker cp failed." }

docker exec $ContainerName sh -lc "rm -rf '$containerExportDir'" | Out-Null

Write-Host "Exported workflows to $destination"
exit 0
```

- [ ] **Step 2: Verify failure mode**

Run with Docker stopped:

```powershell
pwsh -NoProfile -File .\scripts\Export-N8nWorkflows.ps1
```

Expected: non-zero exit and no partial canonical workflow files.

- [ ] **Step 3: Verify success mode after n8n starts**

Run:

```powershell
pwsh -NoProfile -File .\scripts\Export-N8nWorkflows.ps1 -OutputDirectory .\workflows\generated
```

Expected: a timestamped directory under `workflows\generated` containing pretty workflow JSON files.

- [ ] **Step 4: Commit export script**

Run:

```powershell
git add scripts\Export-N8nWorkflows.ps1
git commit -m "Export workflows through the n8n Docker CLI

The script uses a temporary container path and docker cp so local exports work without relying on a host volume mount.

Constraint: Existing n8n container mounts may vary by user machine.
Rejected: Export directly to /files | requires a compose mount that may not exist
Confidence: high
Scope-risk: narrow
Tested: Docker unavailable failure path; local n8n export after Docker starts"
```

### Task 6: Build Scrub and Static Validation Scripts

**Files:**
- Create: `C:\Dev\Projects\n8n-workflow-as-code\scripts\Scrub-N8nWorkflow.ps1`
- Create: `C:\Dev\Projects\n8n-workflow-as-code\scripts\Test-N8nWorkflowJson.ps1`

- [ ] **Step 1: Write `scripts\Scrub-N8nWorkflow.ps1`**

The script must:

- Accept a file or directory.
- Write scrubbed JSON to `workflows\canonical` by default.
- Remove top-level `id`, `versionId`, `shared`, `usedCredentials`, and `pinData` unless `-KeepPinData` is provided.
- Remove `staticData` and environment-specific metadata when present.
- Remove node `credentials`.
- Remove raw `Authorization`, `Cookie`, and `X-API-Key` header values in HTTP Request-like parameter objects.
- Preserve node names, types, positions, parameters, and connections.

Core implementation:

```powershell
param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,
  [string]$OutputDirectory = ".\workflows\canonical",
  [switch]$KeepPinData
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

function Remove-PropertyIfExists($Object, [string]$Name) {
  if ($null -ne $Object.PSObject.Properties[$Name]) {
    $Object.PSObject.Properties.Remove($Name)
  }
}

function Scrub-Object($Value) {
  if ($null -eq $Value) { return }

  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
    foreach ($item in $Value) { Scrub-Object $item }
    return
  }

  if ($Value -is [pscustomobject]) {
    foreach ($property in @($Value.PSObject.Properties)) {
      if ($property.Name -match '^(authorization|cookie|x-api-key|apiKey|accessToken|refreshToken|clientSecret)$') {
        $property.Value = "__SCRUBBED__"
      } else {
        Scrub-Object $property.Value
      }
    }
  }
}

$resolved = Resolve-Path -LiteralPath $InputPath
$files = if ((Get-Item -LiteralPath $resolved).PSIsContainer) {
  Get-ChildItem -LiteralPath $resolved -Filter *.json -File
} else {
  Get-Item -LiteralPath $resolved
}

foreach ($file in $files) {
  $workflow = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json -Depth 100

  foreach ($name in @("id", "versionId", "shared", "usedCredentials", "staticData", "versionMetadata")) {
    Remove-PropertyIfExists $workflow $name
  }

  if (-not $KeepPinData) {
    Remove-PropertyIfExists $workflow "pinData"
  }

  if ($workflow.nodes) {
    foreach ($node in $workflow.nodes) {
      Remove-PropertyIfExists $node "credentials"
      Scrub-Object $node.parameters
    }
  }

  Scrub-Object $workflow

  $outputName = $file.BaseName + ".canonical.json"
  $outputPath = Join-Path $OutputDirectory $outputName
  $workflow | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $outputPath -Encoding utf8
  Write-Host "Scrubbed $($file.Name) -> $outputPath"
}
```

- [ ] **Step 2: Write `scripts\Test-N8nWorkflowJson.ps1`**

The script must:

- Parse all JSON files under a directory or a single file.
- Fail if JSON has `credentials`, `usedCredentials`, raw `Authorization`, `Cookie`, `x-api-key`, `sk-`, `Bearer `, `client_secret`, or Windows absolute user paths.
- Fail if nodes or connections are missing.
- For this MVP, run offline validation only. Do not import into the live n8n container for validation because n8n import preserves workflow IDs and can overwrite existing workflows.

Core implementation:

```powershell
param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = "Stop"
$failures = New-Object System.Collections.Generic.List[string]
$resolved = Resolve-Path -LiteralPath $Path
$files = if ((Get-Item -LiteralPath $resolved).PSIsContainer) {
  Get-ChildItem -LiteralPath $resolved -Filter *.json -File -Recurse
} else {
  Get-Item -LiteralPath $resolved
}

$secretPatterns = @(
  '"credentials"\s*:',
  '"usedCredentials"\s*:',
  'Authorization',
  'Cookie',
  'x-api-key',
  'sk-[A-Za-z0-9_\-]{20,}',
  'Bearer\s+[A-Za-z0-9_\.\-]{20,}',
  'client_secret',
  'C:\\Users\\'
)

foreach ($file in $files) {
  $raw = Get-Content -LiteralPath $file.FullName -Raw
  try {
    $json = $raw | ConvertFrom-Json -Depth 100
  } catch {
    $failures.Add("$($file.FullName): invalid JSON") | Out-Null
    continue
  }

  if (-not $json.nodes) { $failures.Add("$($file.FullName): missing nodes") | Out-Null }
  if (-not $json.connections) { $failures.Add("$($file.FullName): missing connections") | Out-Null }

  foreach ($pattern in $secretPatterns) {
    if ($raw -match $pattern) {
      $failures.Add("$($file.FullName): matched forbidden pattern '$pattern'") | Out-Null
    }
  }
}

if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Error $_ }
  exit 1
}

Write-Host "Workflow JSON validation passed."
exit 0
```

- [ ] **Step 3: Validate scripts against synthetic data**

Create a temporary JSON file with a fake `credentials` property, run scrub, then validate the scrubbed output:

```powershell
$tmp = Join-Path $env:TEMP "n8n-scrub-test.json"
@'
{
  "id": "123",
  "name": "Scrub Test",
  "nodes": [
    {
      "name": "HTTP",
      "type": "n8n-nodes-base.httpRequest",
      "parameters": {
        "headers": {
          "Authorization": "__SCRUBBED__"
        }
      },
      "credentials": {
        "httpHeaderAuth": {
          "id": "abc",
          "name": "Private Header"
        }
      }
    }
  ],
  "connections": {}
}
'@ | Set-Content -LiteralPath $tmp -Encoding utf8

pwsh -NoProfile -File .\scripts\Scrub-N8nWorkflow.ps1 -InputPath $tmp -OutputDirectory .\workflows\canonical
pwsh -NoProfile -File .\scripts\Test-N8nWorkflowJson.ps1 -Path .\workflows\canonical
```

Expected: validation passes after scrubbing.

- [ ] **Step 4: Commit scrub and validation scripts**

Run:

```powershell
git add scripts\Scrub-N8nWorkflow.ps1 scripts\Test-N8nWorkflowJson.ps1
git commit -m "Add workflow JSON scrub and validation scripts

The scripts remove n8n credential references and catch common secret leaks before canonical workflow JSON enters Git.

Constraint: n8n exports can contain credential metadata and HTTP header values.
Confidence: medium
Scope-risk: moderate
Tested: Synthetic credential and Authorization header scrub test"
```

### Task 7: Verify Local n8n Runtime Hardening

**Files:**
- Modify: `C:\Dev\Projects\n8n-workflow-as-code\docs\architecture.md`
- Modify: `C:\Dev\Projects\n8n-workflow-as-code\README.md`

- [ ] **Step 1: Start Docker Desktop and inspect n8n containers**

Run:

```powershell
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
```

Expected:

```text
n8n
n8n-postgres
n8n-runners
```

Container names may include project prefixes if compose created them. Record actual names in `README.md`.

- [ ] **Step 2: Inspect mounts and environment safely**

Run:

```powershell
docker inspect n8n --format '{{json .Mounts}}'
docker inspect n8n --format '{{range .Config.Env}}{{println .}}{{end}}' | Select-String -Pattern 'N8N_ENCRYPTION_KEY|DB_TYPE|NODES_EXCLUDE|N8N_RUNNERS|OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS'
```

Expected:

- `/home/node/.n8n` is backed by a persistent Docker volume or host bind mount.
- Postgres-related environment is present.
- A fixed `N8N_ENCRYPTION_KEY` exists without printing the full secret into docs.
- Dangerous nodes are excluded through `NODES_EXCLUDE`.
- Task runner settings exist when the runner sidecar is used.

- [ ] **Step 3: Record hardening status**

Add this table to `README.md`:

```markdown
## Local n8n Runtime Checklist

| Check | Status | Evidence |
| --- | --- | --- |
| `/home/node/.n8n` persisted | pass/fail | Docker volume or bind mount name |
| Postgres configured | pass/fail | `DB_TYPE=postgresdb` |
| Fixed encryption key configured | pass/fail | env var present, value not recorded |
| Task runner sidecar present | pass/fail | runner container name |
| Dangerous nodes excluded | pass/fail | `NODES_EXCLUDE` present |
| API key works | pass/fail | `Test-N8nConnection.ps1` result |
| Official MCP works | pass/fail | official MCP tool list or validation call |
| Community n8n-mcp works | pass/fail | `tools_documentation` or node search result |
```

- [ ] **Step 4: Commit runtime notes**

Run:

```powershell
git add README.md docs\architecture.md
git commit -m "Record local n8n runtime hardening checks

The runtime checklist documents the local instance assumptions needed before agents can safely create and test workflows.

Constraint: Workflow automation tests can execute local nodes and must run against a hardened local instance.
Confidence: medium
Scope-risk: narrow
Tested: Docker inspection commands after Docker Desktop starts"
```

### Task 8: Build the First Workflow Through MCP

**Files:**
- Create after export/scrub: `C:\Dev\Projects\n8n-workflow-as-code\workflows\canonical\portfolio-support-triage-api.canonical.json`
- Modify: `C:\Dev\Projects\n8n-workflow-as-code\docs\demo-script.md`

- [ ] **Step 1: Research templates and nodes with community n8n-mcp**

Use community n8n-mcp in this order:

```text
tools_documentation()
search_templates({ searchMode: "by_task", task: "webhook_processing" })
search_nodes({ query: "webhook", includeExamples: true })
search_nodes({ query: "set", includeExamples: true })
search_nodes({ query: "if", includeExamples: true })
search_nodes({ query: "respond webhook", includeExamples: true })
get_node({ nodeType: "n8n-nodes-base.webhook", detail: "standard", includeExamples: true })
get_node({ nodeType: "n8n-nodes-base.set", detail: "standard", includeExamples: true })
get_node({ nodeType: "n8n-nodes-base.if", detail: "standard", includeExamples: true })
get_node({ nodeType: "n8n-nodes-base.respondToWebhook", detail: "standard", includeExamples: true })
```

Expected: node schemas confirm required parameters for Webhook, Set, IF, and Respond to Webhook.

- [ ] **Step 2: Define workflow behavior**

The workflow must implement:

```text
Webhook POST /portfolio/support-triage
  -> Validate Required Fields
    -> false branch: Respond 400 with missing field details
    -> true branch: Normalize Ticket
      -> Classify Urgency
        -> enterprise or checkout/payment outage: urgent, route platform-support, slaHours 2
        -> billing keywords: high, route billing-support, slaHours 8
        -> default: normal, route general-support, slaHours 24
      -> Respond 200 with ticketId, urgency, routingTeam, slaHours, summary
```

- [ ] **Step 3: Validate nodes with community n8n-mcp**

Use:

```text
validate_node({ nodeType: "n8n-nodes-base.webhook", config: <webhook-config>, mode: "minimal" })
validate_node({ nodeType: "n8n-nodes-base.webhook", config: <webhook-config>, mode: "full", profile: "runtime" })
validate_node({ nodeType: "n8n-nodes-base.set", config: <set-config>, mode: "full", profile: "runtime" })
validate_node({ nodeType: "n8n-nodes-base.if", config: <if-config>, mode: "full", profile: "runtime" })
validate_node({ nodeType: "n8n-nodes-base.respondToWebhook", config: <respond-config>, mode: "full", profile: "runtime" })
```

Expected: all node-level validation errors are fixed before workflow creation.

- [ ] **Step 4: Build and validate workflow with official n8n MCP**

Use official n8n MCP:

```text
get_sdk_reference()
validate_workflow(<workflow-sdk-code-or-workflow-json>)
create_workflow_from_code(<validated-workflow-sdk-code>)
prepare_test_pin_data(<created-workflow-id>, <fixtures\pin-data\support-triage-input.json>)
test_workflow(<created-workflow-id>, <pin-data>)
```

Expected:

- Workflow is created as a local draft.
- Validation passes.
- Test response includes:

```json
{
  "urgency": "urgent",
  "routingTeam": "platform-support",
  "slaHours": 2
}
```

- [ ] **Step 5: Write `docs\demo-script.md`**

Include:

```markdown
# Demo Script

1. Show the request in `fixtures\requests\support-triage.md`.
2. Explain template-first research through community n8n-mcp.
3. Show the local draft workflow in n8n.
4. Run pin-data test through official n8n MCP.
5. Export workflows with `scripts\Export-N8nWorkflows.ps1`.
6. Scrub exports with `scripts\Scrub-N8nWorkflow.ps1`.
7. Validate canonical JSON with `scripts\Test-N8nWorkflowJson.ps1`.
8. Show the Git diff containing only safe docs, fixtures, scripts, and canonical workflow JSON.
```

- [ ] **Step 6: Do not publish yet**

Keep the first workflow as a validated draft until export/scrub verification is complete.

### Task 9: Export, Scrub, Validate, and Version the Workflow

**Files:**
- Create: `C:\Dev\Projects\n8n-workflow-as-code\workflows\canonical\portfolio-support-triage-api.canonical.json`
- Create: `C:\Dev\Projects\n8n-workflow-as-code\workflows\releases\support-triage-v0.1.0.json`

- [ ] **Step 1: Export local workflows**

Run:

```powershell
pwsh -NoProfile -File .\scripts\Export-N8nWorkflows.ps1 -OutputDirectory .\workflows\generated
```

Expected: a timestamped folder under `workflows\generated`.

- [ ] **Step 2: Scrub exported workflows**

Run:

```powershell
$latest = Get-ChildItem .\workflows\generated -Directory | Sort-Object Name -Descending | Select-Object -First 1
pwsh -NoProfile -File .\scripts\Scrub-N8nWorkflow.ps1 -InputPath $latest.FullName -OutputDirectory .\workflows\canonical
```

Expected: canonical JSON files under `workflows\canonical`.

- [ ] **Step 3: Rename canonical support workflow**

Run:

```powershell
$support = Get-ChildItem .\workflows\canonical -Filter *.canonical.json |
  Where-Object { (Get-Content $_.FullName -Raw) -match 'Portfolio - Support Triage API' } |
  Select-Object -First 1
Move-Item -LiteralPath $support.FullName -Destination .\workflows\canonical\portfolio-support-triage-api.canonical.json -Force
```

Expected: `workflows\canonical\portfolio-support-triage-api.canonical.json` exists.

- [ ] **Step 4: Validate canonical workflow JSON**

Run:

```powershell
pwsh -NoProfile -File .\scripts\Test-N8nWorkflowJson.ps1 -Path .\workflows\canonical\portfolio-support-triage-api.canonical.json
```

Expected: `Workflow JSON validation passed.`

- [ ] **Step 5: Create release snapshot**

Run:

```powershell
Copy-Item .\workflows\canonical\portfolio-support-triage-api.canonical.json .\workflows\releases\support-triage-v0.1.0.json
```

Expected: release file exists and validates.

- [ ] **Step 6: Commit workflow artifact**

Run:

```powershell
git add workflows\canonical\portfolio-support-triage-api.canonical.json workflows\releases\support-triage-v0.1.0.json docs\demo-script.md
git commit -m "Version the first validated support triage workflow

The first workflow proves the requirement-to-MCP-to-export-to-scrub lifecycle with a deterministic webhook triage example.

Constraint: Canonical workflow JSON must be scrubbed before entering Git.
Confidence: high
Scope-risk: moderate
Tested: Official MCP validation and pin-data workflow test; local JSON secret scan"
```

### Task 10: Finish README and Portfolio Narrative

**Files:**
- Create or modify: `C:\Dev\Projects\n8n-workflow-as-code\README.md`

- [ ] **Step 1: Write README sections**

Include:

```markdown
# n8n Workflow-as-Code

Local Workflow-as-Code project for building n8n automations with Codex or Claude through MCP.

## What This Demonstrates

- AI-assisted workflow design with template-first research.
- Official n8n MCP workflow creation, validation, and test execution.
- Safe Git versioning for scrubbed workflow JSON.
- Local Docker-based export path that does not depend on host mounts.
- Secret scanning and credential scrubbing before commit.

## MCP Split

| Server | Role | Writes local n8n? |
| --- | --- | --- |
| Official n8n MCP | Validate, create, update, test, publish local workflows | Yes |
| Community n8n-mcp | Templates, node docs, node validation, workflow pre-validation | No by default |

## Quick Commands

```powershell
pwsh -NoProfile -File .\scripts\Test-N8nConnection.ps1
pwsh -NoProfile -File .\scripts\Export-N8nWorkflows.ps1 -OutputDirectory .\workflows\generated
pwsh -NoProfile -File .\scripts\Scrub-N8nWorkflow.ps1 -InputPath .\workflows\generated\<timestamp> -OutputDirectory .\workflows\canonical
pwsh -NoProfile -File .\scripts\Test-N8nWorkflowJson.ps1 -Path .\workflows\canonical
```

## Resume Bullet

Built a local n8n Workflow-as-Code platform using Codex/Claude, official n8n MCP, community n8n-mcp, Docker, and PowerShell to generate, validate, test, export, scrub, and version automation workflows with a Git-backed release process.
```

- [ ] **Step 2: Commit README**

Run:

```powershell
git add README.md
git commit -m "Document the n8n workflow-as-code portfolio project

The README turns the local build into a reproducible portfolio narrative with setup, commands, MCP roles, and resume framing.

Confidence: high
Scope-risk: narrow
Tested: README commands match script names and paths"
```

### Task 11: Final Verification

**Files:**
- Read-only verification across `C:\Dev\Projects\n8n-workflow-as-code`

- [ ] **Step 1: Run repository file scan**

Run:

```powershell
Get-ChildItem -Recurse -File | Select-Object FullName
```

Expected: files match the planned file structure.

- [ ] **Step 2: Run script verification**

Run:

```powershell
pwsh -NoProfile -File .\scripts\Test-N8nConnection.ps1
pwsh -NoProfile -File .\scripts\Test-N8nWorkflowJson.ps1 -Path .\workflows\canonical
```

Expected: both commands exit `0`.

- [ ] **Step 3: Run secret-pattern scan**

Run:

```powershell
rg -n "N8N_API_KEY|N8N_MCP_TOKEN|Authorization|Bearer |sk-[A-Za-z0-9_-]{20,}|client_secret|credentials\"\\s*:" .
```

Expected: no matches in tracked files, except documentation references that do not contain real secret values.

- [ ] **Step 4: Check Git status**

Run:

```powershell
git status --short
```

Expected: clean working tree after final commit.

- [ ] **Step 5: Record final evidence**

Add final verification evidence to `README.md` or a short release note:

```markdown
## Verification

- n8n health check: pass
- n8n API key check: pass
- official MCP validation: pass
- official MCP pin-data test: pass
- export script: pass
- scrub script: pass
- canonical JSON secret scan: pass
- Git status: clean
```

## Risks and Mitigations

- **Docker unavailable:** `Test-N8nConnection.ps1` fails early with clear output. Start Docker Desktop before runtime tasks.
- **MCP writer conflict:** `docs\mcp-policy.md` enforces official MCP as the default writer and recommends community n8n-mcp without API credentials for normal sessions.
- **Secret leakage in exported JSON:** raw exports are ignored, scrub script removes credential references, validation script scans canonical JSON.
- **Workflow works only with live services:** first workflow uses no external credentials; later LLM/SaaS workflows must add fixture-based and credential-safe tests.
- **n8n version drift:** export through the Docker container's own `n8n` server CLI, not a separately installed host CLI.
- **Dangerous node execution:** local runtime must set `NODES_EXCLUDE` for command/file nodes before agent-driven tests.

## Recommended Execution Mode

Use subagent-driven execution:

- `executor`: Tasks 1-3, docs, prompts, fixtures.
- `powershell-7-expert`: Tasks 4-6, scripts and Windows/Docker behavior.
- `mcp-developer`: Task 8, MCP workflow creation and validation.
- `reviewer` or `verifier`: Task 11, final review and evidence check.

Keep the parent agent responsible for integration, Git status, and final verification.

## External References

- n8n Docker installation: https://docs.n8n.io/hosting/installation/docker/
- n8n Docker Compose setup: https://docs.n8n.io/hosting/installation/server-setups/docker-compose/
- n8n CLI commands: https://docs.n8n.io/hosting/cli-commands/
- n8n workflow export/import: https://docs.n8n.io/workflows/export-import/
- n8n official MCP tools: https://docs.n8n.io/advanced-ai/mcp/mcp_tools_reference/
- n8n official MCP access: https://docs.n8n.io/advanced-ai/mcp/accessing-n8n-mcp-server/
- n8n blocking nodes: https://docs.n8n.io/hosting/securing/blocking-nodes/
- n8n security overview: https://docs.n8n.io/hosting/securing/overview/
- community n8n-mcp: https://github.com/czlonkowski/n8n-mcp
- n8n-skills: https://github.com/czlonkowski/n8n-skills
- Zie619 workflow corpus: https://github.com/Zie619/n8n-workflows
- awesome n8n templates: https://github.com/enescingoz/awesome-n8n-templates

## Self-Review

- Spec coverage: project path, MCP split, local scripts, first workflow, export/scrub/version lifecycle, and portfolio narrative are all covered by tasks.
- Placeholder scan: the plan contains no `TBD`, `TODO`, or unspecified implementation task.
- Type/path consistency: script names and paths are consistent across file structure, tasks, commands, and README snippets.
- Verification coverage: runtime checks, JSON validation, secret scan, MCP validation, pin-data workflow test, and Git status are included.
