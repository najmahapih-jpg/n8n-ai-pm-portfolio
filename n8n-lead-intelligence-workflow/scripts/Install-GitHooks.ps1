Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (& git rev-parse --show-toplevel).Trim()
if ([string]::IsNullOrWhiteSpace($repoRoot)) {
  Write-Error "Unable to resolve Git repository root."
  exit 2
}

$hookDirectory = Join-Path $repoRoot ".githooks"
if (-not (Test-Path -LiteralPath $hookDirectory -PathType Container)) {
  Write-Error "Hook directory not found: $hookDirectory"
  exit 2
}

Push-Location $repoRoot
try {
  & git config core.hooksPath .githooks
} finally {
  Pop-Location
}

Write-Host "Git hooks installed: core.hooksPath=.githooks"
exit 0
