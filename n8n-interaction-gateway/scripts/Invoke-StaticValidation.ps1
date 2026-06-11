param(
  [int]$MinimumNodes = 10,
  [string]$ReleaseFile = "interaction-gateway-v0.4.0.json",
  [switch]$SkipRepositorySecretScan
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

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

Invoke-ValidationStep -Name "Canonical workflow JSON validation (shape, all)" -Action {
  & (Join-Path $repoRoot "scripts\Test-N8nWorkflowJson.ps1") -Path (Join-Path $repoRoot "workflows\canonical") -MinimumNodes 0
}

Invoke-ValidationStep -Name "Gateway canonical node floor" -Action {
  # The node floor applies to the GATEWAY workflow; the selftest sibling is intentionally tiny (3 nodes).
  & (Join-Path $repoRoot "scripts\Test-N8nWorkflowJson.ps1") -Path (Join-Path $repoRoot "workflows\canonical\interaction-gateway.canonical.json") -MinimumNodes $MinimumNodes
}

Invoke-ValidationStep -Name "Release workflow JSON validation" -Action {
  & (Join-Path $repoRoot "scripts\Test-N8nWorkflowJson.ps1") -Path (Join-Path $repoRoot "workflows\releases") -MinimumNodes 0
}

Invoke-ValidationStep -Name "Current release node floor" -Action {
  & (Join-Path $repoRoot "scripts\Test-N8nWorkflowJson.ps1") -Path (Join-Path $repoRoot "workflows\releases\$ReleaseFile") -MinimumNodes $MinimumNodes
}

Invoke-ValidationStep -Name "Gateway pure-core self-test" -Action {
  & node (Join-Path $repoRoot "scripts\test-gateway-core.mjs")
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

Invoke-ValidationStep -Name "Compiled-workflow behavioral self-test" -Action {
  & node (Join-Path $repoRoot "scripts\test-gateway-workflow.mjs")
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

Invoke-ValidationStep -Name "Canonical-matches-SDK self-test" -Action {
  & node (Join-Path $repoRoot "scripts\test-canonical-matches-sdk.mjs")
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

Write-Host "Static validation passed."
exit 0
