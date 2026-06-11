Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = $null
try {
  $repoRoot = (& git rev-parse --show-toplevel 2>$null)
  if ($LASTEXITCODE -ne 0) { $repoRoot = $null }
} catch {
  $repoRoot = $null
}

if ([string]::IsNullOrWhiteSpace($repoRoot)) {
  [Console]::Error.WriteLine("ERROR: Not a Git repository. Run 'git init' first, then 'npm run hooks:install'.")
  exit 2
}
$repoRoot = $repoRoot.Trim()

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
