param(
  [string]$SdkPath = ".\workflows\sdk\llm-eval-harness.workflow.js",
  [string]$OutputPath = ".\workflows\generated\llm-eval-harness.json",
  [int]$MinimumNodes = 26,
  [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$compiler = Join-Path $repoRoot "scripts\lib\compile-sdk.mjs"

function Exit-WithCode {
  param(
    [int]$Code,
    [string]$Message
  )
  if ($Code -eq 0) {
    Write-Host $Message
  } else {
    [Console]::Error.WriteLine("ERROR: $Message")
  }
  exit $Code
}

if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
  Exit-WithCode -Code 2 -Message "Compiler not found: $compiler"
}

$resolvedSdk = if ([System.IO.Path]::IsPathRooted($SdkPath)) { $SdkPath } else { Join-Path $repoRoot ($SdkPath -replace '^\.[\\/]', '') }
if (-not (Test-Path -LiteralPath $resolvedSdk -PathType Leaf)) {
  Exit-WithCode -Code 2 -Message "SDK source not found: $resolvedSdk"
}

$resolvedOut = if ([System.IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } else { Join-Path $repoRoot ($OutputPath -replace '^\.[\\/]', '') }

$nodeArgs = @($compiler, $resolvedSdk, "--out", $resolvedOut, "--min", [string]$MinimumNodes)
if ($Quiet) { $nodeArgs += "--quiet" }

Push-Location $repoRoot
try {
  & node @nodeArgs
  $exit = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($exit -ne 0) {
  Exit-WithCode -Code $exit -Message "compile-sdk.mjs exited with code $exit"
}

if (-not (Test-Path -LiteralPath $resolvedOut -PathType Leaf)) {
  Exit-WithCode -Code 4 -Message "Compiler reported success but output is missing: $resolvedOut"
}

Write-Host "Compiled SDK -> $resolvedOut"
exit 0
