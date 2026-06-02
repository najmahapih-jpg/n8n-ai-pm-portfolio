param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string[]]$CaseName = @("in-corpus-direct", "out-of-corpus"),
  [switch]$SkipConnectionCheck,
  [switch]$SkipStaticValidation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

# Run a smoke step and PROPAGATE its exit code. A child `exit N` MUST fail the whole smoke — the pre-fix
# wrapper printed HTTP/content for each case then unconditionally printed "complete" + exit 0, asserting
# NOTHING (it passed even on HTTP 500 or an abstain-everything regression). This restores honest pass/fail.
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
# (exit 0, clearly labeled) instead of falsely reporting "passed".
if (-not $SkipConnectionCheck) {
  Write-Host "==> Local n8n connection check"
  & (Join-Path $repoRoot "scripts\Test-N8nConnection.ps1")
  if ($LASTEXITCODE -ne 0) {
    Write-Host "SKIPPED: live smoke needs a running local n8n + N8N_API_KEY/N8N_MCP_TOKEN (see errors above). Offline static validation passed; the live behavioral cases did not run."
    exit 0
  }
}

# Step 3 — run the ASSERTION-BEARING Layer-2 behavioral suite over the headline cases (a grounded, cited
# answer + a clean abstain). This REPLACES the prior hardcoded probe whose hydropower queries had gone
# stale vs the current Chinese AI-PM corpus and which asserted nothing. Delegating to the golden-fixture
# suite keeps the smoke queries in sync with the corpus AND actually asserts (abstain / citation-integrity).
Invoke-SmokeStep -Name "RAG behavioral suite (Layer-2 stub) cases: $($CaseName -join ', ')" -Action {
  & (Join-Path $repoRoot "scripts\Test-RagAssistantWorkflow.ps1") -BaseUrl $BaseUrl -CaseName $CaseName
}

Write-Host "Smoke test passed."
exit 0
