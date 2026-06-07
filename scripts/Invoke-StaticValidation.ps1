param(
  [int]$MinimumNodes = -1,
  [string]$ReleaseFile = "scheduled-drift-monitor-v0.3.0.json",
  [switch]$SkipRepositorySecretScan
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

# Derive the canonical node floor from the actual canonical JSON so the guard
# stays accurate as the workflow grows rather than silently going stale.
$canonicalJsonPath = Join-Path $repoRoot "workflows\canonical\scheduled-drift-monitor.canonical.json"
$canonicalNodeCount = @((Get-Content -LiteralPath $canonicalJsonPath -Raw | ConvertFrom-Json -Depth 100).nodes).Count
if ($MinimumNodes -lt 0) {
  $MinimumNodes = $canonicalNodeCount
}

function Invoke-ValidationStep {
  param(
    [string]$Name,
    [scriptblock]$Action
  )

  Write-Host "==> $Name"
  & $Action
}

Invoke-ValidationStep -Name "PowerShell parse check" -Action {
  $parseFailures = New-Object System.Collections.Generic.List[string]
  Get-ChildItem -LiteralPath (Join-Path $repoRoot "scripts") -Filter *.ps1 -File -Recurse | ForEach-Object {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
      foreach ($parseError in $errors) {
        $parseFailures.Add("$($_.FullName): $($parseError.Message)") | Out-Null
      }
    }
  }

  if ($parseFailures.Count -gt 0) {
    foreach ($failure in $parseFailures) {
      Write-Error $failure
    }
    exit 1
  }

  Write-Host "PowerShell parse check passed."
}

Invoke-ValidationStep -Name "Tracked JSON parse check" -Action {
  $jsonRoots = @(
    (Join-Path $repoRoot "workflows\generated"),
    (Join-Path $repoRoot "workflows\canonical"),
    (Join-Path $repoRoot "workflows\releases"),
    (Join-Path $repoRoot "fixtures")
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Container }

  $parsed = 0
  foreach ($root in $jsonRoots) {
    Get-ChildItem -LiteralPath $root -Filter *.json -File -Recurse | ForEach-Object {
      Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json -Depth 100 | Out-Null
      $parsed += 1
    }
  }
  Write-Host "Tracked JSON parse check passed ($parsed file(s))."
}

if (-not $SkipRepositorySecretScan) {
  Invoke-ValidationStep -Name "Repository secret scan" -Action {
    & (Join-Path $repoRoot "scripts\Test-RepositorySecrets.ps1")
  }
}

Invoke-ValidationStep -Name "Workflow registry freshness" -Action {
  & (Join-Path $repoRoot "scripts\Build-WorkflowIndex.ps1") -Check
}

Invoke-ValidationStep -Name "Canonical workflow JSON validation" -Action {
  & (Join-Path $repoRoot "scripts\Test-N8nWorkflowJson.ps1") -Path (Join-Path $repoRoot "workflows\canonical") -MinimumNodes $MinimumNodes
}

Invoke-ValidationStep -Name "Release workflow JSON validation" -Action {
  & (Join-Path $repoRoot "scripts\Test-N8nWorkflowJson.ps1") -Path (Join-Path $repoRoot "workflows\releases") -MinimumNodes 0
}

Invoke-ValidationStep -Name "Current release node floor" -Action {
  # Derive the floor from the release file's own node count (== canonical after finding #13 was closed).
  # Catches a dropped node; the release-matches-canonical gate (below) further ensures no structural drift.
  $releaseJsonPath = Join-Path $repoRoot "workflows\releases\$ReleaseFile"
  $releaseNodeCount = @((Get-Content -LiteralPath $releaseJsonPath -Raw | ConvertFrom-Json -Depth 100).nodes).Count
  & (Join-Path $repoRoot "scripts\Test-N8nWorkflowJson.ps1") -Path $releaseJsonPath -MinimumNodes $releaseNodeCount
}

Invoke-ValidationStep -Name "Release matches canonical (finding #13 closed)" -Action {
  & node (Join-Path $repoRoot "scripts\test-release-matches-canonical.mjs")
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

Invoke-ValidationStep -Name "Canonical-matches-SDK self-test" -Action {
  & node (Join-Path $repoRoot "scripts\test-canonical-matches-sdk.mjs")
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

Invoke-ValidationStep -Name "Drift-workflow behavioral differential (compiled jsCode == core)" -Action {
  & node (Join-Path $repoRoot "scripts\test-drift-workflow.mjs")
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

Write-Host "Static validation passed."
exit 0
