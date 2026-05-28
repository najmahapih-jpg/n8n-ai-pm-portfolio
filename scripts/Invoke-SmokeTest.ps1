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

Invoke-SmokeStep -Name "Workflow smoke case '$CaseName' with FeishuMode=$FeishuMode" -Action {
  & (Join-Path $repoRoot "scripts\Test-SupportTriageWorkflow.ps1") -WorkflowId $WorkflowId -CaseName $CaseName -FeishuMode $FeishuMode
}

Write-Host "Smoke test passed."
exit 0
