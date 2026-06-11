param(
  [int]$MinimumNodes = 27,
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

Invoke-ValidationStep -Name "Pin-data JSON parse check" -Action {
  Get-ChildItem -LiteralPath (Join-Path $repoRoot "fixtures\pin-data") -Filter *.json -File | ForEach-Object {
    Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json -Depth 100 | Out-Null
  }
  Write-Host "Pin-data JSON parse check passed."
}

if (-not $SkipRepositorySecretScan) {
Invoke-ValidationStep -Name "Repository secret scan" -Action {
    & (Join-Path $repoRoot "scripts\Test-RepositorySecrets.ps1")
  }
}

Invoke-ValidationStep -Name "Workflow registry freshness" -Action {
  & (Join-Path $repoRoot "scripts\Build-WorkflowIndex.ps1") -Check
}

Invoke-ValidationStep -Name "Feishu workflow JSON guard" -Action {
  & (Join-Path $repoRoot "scripts\Test-FeishuWorkflowJson.ps1")
}

Invoke-ValidationStep -Name "Canonical workflow JSON validation" -Action {
  # Derive the exact expected node count from the canonical JSON so a dropped
  # node is always caught, without relying on a manually-maintained floor.
  $canonicalFile = Join-Path $repoRoot "workflows\canonical\portfolio-support-triage-api.canonical.json"
  $canonicalNodeCount = @((Get-Content -LiteralPath $canonicalFile -Raw | ConvertFrom-Json -Depth 100).nodes).Count
  & (Join-Path $repoRoot "scripts\Test-N8nWorkflowJson.ps1") -Path (Join-Path $repoRoot "workflows\canonical") -MinimumNodes $canonicalNodeCount
}

Invoke-ValidationStep -Name "Offline workflow behavioral differential" -Action {
  # Execute the compiled deterministic Code-node jsCode (extracted from the canonical JSON) over the golden
  # pin-data fixtures and assert it is byte-behaviour-identical to scripts/lib/triage-core.mjs, plus the
  # documented routing/escalation/response-shape expectations. No n8n, no network. Fails the gate on drift.
  & node (Join-Path $repoRoot "scripts\test-triage-workflow.mjs")
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Offline workflow behavioral differential failed (compiled jsCode diverged from triage-core.mjs)."
    exit 1
  }
}

Invoke-ValidationStep -Name "Release workflow JSON validation" -Action {
  & (Join-Path $repoRoot "scripts\Test-N8nWorkflowJson.ps1") -Path (Join-Path $repoRoot "workflows\releases") -MinimumNodes 0
}

Invoke-ValidationStep -Name "Current release node floor" -Action {
  & (Join-Path $repoRoot "scripts\Test-N8nWorkflowJson.ps1") -Path (Join-Path $repoRoot "workflows\releases\support-triage-v0.3.0.json") -MinimumNodes $MinimumNodes
}

Write-Host "Static validation passed."
exit 0
