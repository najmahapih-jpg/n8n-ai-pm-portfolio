param(
  [string[]]$Path = @(".")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$secretRules = Import-PowerShellDataFile -LiteralPath (Join-Path $PSScriptRoot "lib\Secret-Patterns.psd1")
$repositorySecretPatterns = [string[]]$secretRules.RepositorySecretPatterns

$repoRoot = (& git rev-parse --show-toplevel).Trim()
if ([string]::IsNullOrWhiteSpace($repoRoot)) {
  Write-Error "Unable to resolve Git repository root."
  exit 2
}

$failures = New-Object System.Collections.Generic.List[string]

Push-Location $repoRoot
try {
  $files = @(& git ls-files -- $Path)

  foreach ($file in $files) {
    if ([string]::IsNullOrWhiteSpace($file)) {
      continue
    }

    $fullPath = Join-Path $repoRoot $file
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      continue
    }

    try {
      $raw = Get-Content -LiteralPath $fullPath -Raw -ErrorAction Stop
    } catch {
      continue
    }

    foreach ($pattern in $repositorySecretPatterns) {
      if ($raw -match $pattern) {
        $failures.Add("${file}: matched forbidden pattern '$pattern'") | Out-Null
      }
    }
  }
} finally {
  Pop-Location
}

if ($failures.Count -gt 0) {
  foreach ($failure in $failures) {
    Write-Error $failure
  }
  exit 1
}

Write-Host "Repository secret scan passed."
exit 0
