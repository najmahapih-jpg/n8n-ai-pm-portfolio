param(
  [string]$WorkflowId = "RPkw9jGJ93lqs7jO",
  [string]$CaseName = "enterprise-incident",
  [ValidateSet("skipped", "sent", "any")]
  [string]$FeishuMode = "skipped",
  [switch]$SkipConnectionCheck,
  [switch]$SkipStaticValidation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

# Run a smoke step and PROPAGATE its exit code. A child `exit N` MUST fail the whole smoke — the pre-fix
# wrapper ran `& $Action` and then unconditionally printed "passed" + exit 0, swallowing child failures
# (so a step that errored on missing keys still reported green). This restores honest pass/fail.
function Invoke-SmokeStep {
  param(
    [string]$Name,
    [scriptblock]$Action
  )

  Write-Host "==> $Name"
  & $Action
  if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine("ERROR: smoke step '$Name' failed (exit $LASTEXITCODE).")
    exit $LASTEXITCODE
  }
}

# Step 1 — offline static validation (no live infra needed; must pass).
if (-not $SkipStaticValidation) {
  Invoke-SmokeStep -Name "Offline static validation" -Action {
    & (Join-Path $repoRoot "scripts\Invoke-StaticValidation.ps1")
  }
}

# Step 2 — live availability gate. smoke is a LIVE-LOCAL-n8n tier check (it POSTs to a running n8n), NOT an
# offline gate. If the live infra (running n8n + N8N_API_KEY/N8N_MCP_TOKEN) is unavailable, SKIP honestly
# (exit 0, clearly labeled) instead of falsely reporting "passed". The connection check exits non-zero with
# reasons when anything is missing.
if (-not $SkipConnectionCheck) {
  Write-Host "==> Local n8n connection check"
  & (Join-Path $repoRoot "scripts\Test-N8nConnection.ps1")
  if ($LASTEXITCODE -ne 0) {
    Write-Host "SKIPPED: live smoke needs a running local n8n + N8N_API_KEY/N8N_MCP_TOKEN (see errors above). Offline static validation passed; the live behavioral case did not run."
    exit 0
  }
}

# Step 3 — live workflow smoke case (infra is available; must pass).
Invoke-SmokeStep -Name "Workflow smoke case '$CaseName' with FeishuMode=$FeishuMode" -Action {
  & (Join-Path $repoRoot "scripts\Test-SupportTriageWorkflow.ps1") -WorkflowId $WorkflowId -CaseName $CaseName -FeishuMode $FeishuMode
}

Write-Host "Smoke test passed."
exit 0
