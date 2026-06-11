param(
  [string]$ContainerName = $env:N8N_CONTAINER_NAME,
  [string]$OutputDirectory = ".\workflows\generated",
  [switch]$PublishedOnly,
  [switch]$KeepContainerTemp
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ContainerName)) {
  $ContainerName = "n8n"
}

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

function Invoke-Docker {
  param([string[]]$Arguments)
  & docker @Arguments
  return $LASTEXITCODE
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Exit-WithCode -Code 2 -Message "docker is not available on PATH."
}

& docker version --format "{{.Server.Version}}" 2>$null | Out-Null
$versionCode = $LASTEXITCODE
if ($versionCode -ne 0) {
  Exit-WithCode -Code 2 -Message "Docker daemon is not available."
}

$containerNames = & docker ps --format "{{.Names}}" 2>$null
if ($LASTEXITCODE -ne 0) {
  Exit-WithCode -Code 2 -Message "Could not list Docker containers."
}
if ($containerNames -notcontains $ContainerName) {
  Exit-WithCode -Code 3 -Message "Container '$ContainerName' is not running."
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$hostOutput = Resolve-Path -LiteralPath $OutputDirectory
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$containerExportDir = "/tmp/n8n-workflow-export-$stamp-$([guid]::NewGuid().ToString('N'))"
$destination = Join-Path $hostOutput.Path $stamp

$cleanupNeeded = $false
$createdDestination = $false
$success = $false
$failureCode = 0
$failureMessage = $null

try {
  $mkdirCode = Invoke-Docker -Arguments @("exec", $ContainerName, "sh", "-lc", "rm -rf '$containerExportDir' && mkdir -p '$containerExportDir'")
  if ($mkdirCode -ne 0) {
    $failureCode = 3
    throw "Failed to create container export directory."
  }
  $cleanupNeeded = $true

  $publishedArg = if ($PublishedOnly) { " --published" } else { "" }
  $exportCommand = "n8n export:workflow --all --separate --pretty --output='$containerExportDir'$publishedArg"
  $exportOutput = & docker exec -u node $ContainerName sh -lc $exportCommand 2>&1
  $exportCode = $LASTEXITCODE
  $noWorkflowsFound = ($exportOutput -join "`n") -match "No workflows found"
  if ($exportCode -ne 0 -and -not $noWorkflowsFound) {
    $exportOutput | ForEach-Object { [Console]::Error.WriteLine($_.ToString()) }
    $failureCode = 4
    throw "n8n workflow export failed."
  }
  if ($noWorkflowsFound) {
    Write-Host "No workflows matched the export filters; created an empty export batch."
  }

  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  $createdDestination = $true
  $containerCopyPath = "{0}:{1}/." -f $ContainerName, $containerExportDir
  $copyCode = Invoke-Docker -Arguments @("cp", $containerCopyPath, $destination)
  if ($copyCode -ne 0) {
    $failureCode = 5
    throw "docker cp failed."
  }
  $success = $true
} catch {
  $failureMessage = $_.Exception.Message
  if ($failureCode -eq 0) {
    $failureCode = 5
  }
} finally {
  if ($cleanupNeeded -and -not $KeepContainerTemp) {
    & docker exec $ContainerName sh -lc "rm -rf '$containerExportDir'" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Error "Workflow export succeeded, but cleanup of '$containerExportDir' failed."
      exit 7
    }
  }
  if (-not $success -and $createdDestination -and (Test-Path -LiteralPath $destination)) {
    Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if (-not $success) {
  Exit-WithCode -Code $failureCode -Message $failureMessage
}

Write-Host "Exported workflows to $destination"
exit 0
