param(
  [string]$SdkPath = ".\workflows\sdk\autonomous-agent.workflow.js",
  [string]$OutputPath = ".\workflows\generated\autonomous-agent.json",
  [int]$MinimumNodes = 6,
  [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$compiler = Join-Path $repoRoot "scripts\lib\compile-sdk.mjs"

if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
  [Console]::Error.WriteLine("ERROR: Compiler not found: $compiler"); exit 2
}
$resolvedSdk = if ([System.IO.Path]::IsPathRooted($SdkPath)) { $SdkPath } else { Join-Path $repoRoot ($SdkPath -replace '^\.[\\/]', '') }
if (-not (Test-Path -LiteralPath $resolvedSdk -PathType Leaf)) {
  [Console]::Error.WriteLine("ERROR: SDK source not found: $resolvedSdk"); exit 2
}
$resolvedOut = if ([System.IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } else { Join-Path $repoRoot ($OutputPath -replace '^\.[\\/]', '') }

$nodeArgs = @($compiler, $resolvedSdk, "--out", $resolvedOut, "--min", [string]$MinimumNodes)
if ($Quiet) { $nodeArgs += "--quiet" }

Push-Location $repoRoot
try { & node @nodeArgs; $exit = $LASTEXITCODE } finally { Pop-Location }

if ($exit -ne 0) { [Console]::Error.WriteLine("ERROR: compile-sdk.mjs exited with code $exit"); exit $exit }
if (-not (Test-Path -LiteralPath $resolvedOut -PathType Leaf)) { [Console]::Error.WriteLine("ERROR: output missing: $resolvedOut"); exit 4 }
Write-Host "Compiled SDK -> $resolvedOut"
exit 0
