param(
  [string]$WorkflowId = "",
  [string]$CaseName = "bug-negative",
  [switch]$SkipConnectionCheck,
  [switch]$SkipStaticValidation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

function Invoke-SmokeStep {
  param(
    [string]$Name,
    [scriptblock]$Action
  )

  Write-Host "==> $Name"
  & $Action
}

if (-not $SkipStaticValidation) {
  Invoke-SmokeStep -Name "Offline static validation" -Action {
    & (Join-Path $repoRoot "scripts\Invoke-StaticValidation.ps1")
  }
}

if (-not $SkipConnectionCheck) {
  Invoke-SmokeStep -Name "Local n8n connection check" -Action {
    & (Join-Path $repoRoot "scripts\Test-N8nConnection.ps1")
  }
}

Invoke-SmokeStep -Name "Product feedback workflow smoke case '$CaseName'" -Action {
  & (Join-Path $repoRoot "scripts\Test-ProductFeedbackWorkflow.ps1") -WorkflowId $WorkflowId -CaseName $CaseName
}

Write-Host "Smoke test passed."
exit 0
