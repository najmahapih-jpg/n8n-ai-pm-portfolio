param(
  [int]$MinimumNodes = 6,
  [string]$ReleaseFile = "autonomous-agent-v0.1.0.json",
  [switch]$SkipRepositorySecretScan
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

function Invoke-ValidationStep { param([string]$Name, [scriptblock]$Action) Write-Host "==> $Name"; & $Action }

Invoke-ValidationStep -Name "PowerShell parse check" -Action {
  $parseFailures = New-Object System.Collections.Generic.List[string]
  Get-ChildItem -LiteralPath (Join-Path $repoRoot "scripts") -Filter *.ps1 -File -Recurse | ForEach-Object {
    $tokens = $null; $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) { foreach ($e in $errors) { $parseFailures.Add("$($_.FullName): $($e.Message)") | Out-Null } }
  }
  if ($parseFailures.Count -gt 0) { foreach ($f in $parseFailures) { Write-Error $f }; exit 1 }
  Write-Host "PowerShell parse check passed."
}

Invoke-ValidationStep -Name "Tracked JSON parse check" -Action {
  $roots = @((Join-Path $repoRoot "workflows\generated"), (Join-Path $repoRoot "workflows\canonical"), (Join-Path $repoRoot "workflows\releases"), (Join-Path $repoRoot "fixtures")) | Where-Object { Test-Path -LiteralPath $_ -PathType Container }
  $parsed = 0
  foreach ($r in $roots) { Get-ChildItem -LiteralPath $r -Filter *.json -File -Recurse | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json -Depth 100 | Out-Null; $parsed += 1 } }
  Write-Host "Tracked JSON parse check passed ($parsed file(s))."
}

if (-not $SkipRepositorySecretScan) {
  Invoke-ValidationStep -Name "Repository secret scan" -Action { & (Join-Path $repoRoot "scripts\Test-RepositorySecrets.ps1") }
}

Invoke-ValidationStep -Name "Workflow registry freshness" -Action { & (Join-Path $repoRoot "scripts\Build-WorkflowIndex.ps1") -Check }

Invoke-ValidationStep -Name "Canonical workflow JSON validation (shape)" -Action {
  & (Join-Path $repoRoot "scripts\Test-N8nWorkflowJson.ps1") -Path (Join-Path $repoRoot "workflows\canonical") -MinimumNodes 0
}

Invoke-ValidationStep -Name "Agent canonical node floor" -Action {
  & (Join-Path $repoRoot "scripts\Test-N8nWorkflowJson.ps1") -Path (Join-Path $repoRoot "workflows\canonical\autonomous-agent.canonical.json") -MinimumNodes $MinimumNodes
}

Invoke-ValidationStep -Name "Release workflow JSON validation" -Action {
  & (Join-Path $repoRoot "scripts\Test-N8nWorkflowJson.ps1") -Path (Join-Path $repoRoot "workflows\releases") -MinimumNodes 0
}

Invoke-ValidationStep -Name "Current release node floor" -Action {
  & (Join-Path $repoRoot "scripts\Test-N8nWorkflowJson.ps1") -Path (Join-Path $repoRoot "workflows\releases\$ReleaseFile") -MinimumNodes $MinimumNodes
}

Invoke-ValidationStep -Name "Agent-core trajectory self-test (verify:agent)" -Action {
  & node (Join-Path $repoRoot "scripts\test-agent-core.mjs"); if ($LASTEXITCODE -ne 0) { exit 1 }
}

Invoke-ValidationStep -Name "Compiled-workflow differential self-test (verify:workflow)" -Action {
  & node (Join-Path $repoRoot "scripts\test-agent-workflow.mjs"); if ($LASTEXITCODE -ne 0) { exit 1 }
}

Write-Host "Static validation passed."
exit 0
