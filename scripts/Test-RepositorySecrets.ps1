param(
  [string[]]$Path = @(".")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$secretRules = Import-PowerShellDataFile -LiteralPath (Join-Path $PSScriptRoot "lib\Secret-Patterns.psd1")
$repositorySecretPatterns = [string[]]$secretRules.RepositorySecretPatterns

# Prefer git's tracked-file list when this is a Git repository; otherwise fall back to a
# filesystem walk that skips the same paths .gitignore excludes. The project is initialised as a
# Git repo only after the toolchain lands, so the offline gate must not depend on `git`.
$gitRoot = $null
try {
  $gitRoot = (& git rev-parse --show-toplevel 2>$null)
  if ($LASTEXITCODE -ne 0) { $gitRoot = $null }
} catch {
  $gitRoot = $null
}

$repoRoot = if (-not [string]::IsNullOrWhiteSpace($gitRoot)) {
  $gitRoot.Trim()
} else {
  (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$failures = New-Object System.Collections.Generic.List[string]

$excludedDirNames = @(".git", "node_modules", ".omc")
function Test-IsExcluded {
  param([string]$RelativePath)
  $normalized = $RelativePath -replace '\\', '/'
  foreach ($dir in $excludedDirNames) {
    if ($normalized -eq $dir -or $normalized -like "$dir/*" -or $normalized -like "*/$dir/*") {
      return $true
    }
  }
  $leaf = Split-Path -Leaf $normalized
  if ($leaf -eq ".env" -or ($leaf -like ".env.*" -and $leaf -ne ".env.example")) {
    return $true
  }
  if ($leaf -like "*.log") {
    return $true
  }
  if ($normalized -like "artifacts/validation/*" -and $leaf -ne ".gitkeep") {
    return $true
  }
  if ($normalized -like "workflows/raw/*" -and $leaf -ne ".gitkeep") {
    return $true
  }
  return $false
}

Push-Location $repoRoot
try {
  if (-not [string]::IsNullOrWhiteSpace($gitRoot)) {
    $files = @(& git ls-files -- $Path)
  } else {
    $files = @(
      Get-ChildItem -LiteralPath $repoRoot -File -Recurse -Force |
        ForEach-Object {
          $rel = [System.IO.Path]::GetRelativePath($repoRoot, $_.FullName)
          if (-not (Test-IsExcluded -RelativePath $rel)) { $rel }
        }
    )
  }

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
