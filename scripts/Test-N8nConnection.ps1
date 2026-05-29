param(
  [string]$BaseUrl = "http://localhost:5678",
  [string]$ContainerName = $env:N8N_CONTAINER_NAME,
  [switch]$SkipApiCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ContainerName)) {
  $ContainerName = "n8n"
}

$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
  param([string]$Message)
  $script:failures.Add($Message) | Out-Null
}

function Test-CommandAvailable {
  param([string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  return $null -ne $command
}

if (-not (Test-CommandAvailable -Name "docker")) {
  Add-Failure "docker is not available on PATH."
} else {
  try {
    & docker version --format '{{.Server.Version}}' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Add-Failure "Docker daemon is not available."
    }
  } catch {
    Add-Failure "Docker daemon is not available."
  }

  try {
    $runningContainers = & docker ps --format '{{.Names}}' 2>$null
    if ($LASTEXITCODE -ne 0) {
      Add-Failure "Could not list Docker containers."
    } elseif ($runningContainers -notcontains $ContainerName) {
      Add-Failure "Container '$ContainerName' is not running."
    }
  } catch {
    Add-Failure "Could not list Docker containers."
  }
}

try {
  $health = Invoke-WebRequest -Uri "$BaseUrl/healthz" -UseBasicParsing -TimeoutSec 5
  if ($health.StatusCode -ne 200) {
    Add-Failure "n8n health endpoint returned $($health.StatusCode)."
  }
} catch {
  Add-Failure "n8n health endpoint is not reachable at $BaseUrl."
}

if (-not $SkipApiCheck) {
  if ([string]::IsNullOrWhiteSpace($env:N8N_API_KEY)) {
    Add-Failure "N8N_API_KEY is not set."
  } else {
    try {
      $headers = @{ "X-N8N-API-KEY" = $env:N8N_API_KEY }
      $response = Invoke-WebRequest -Uri "$BaseUrl/api/v1/workflows" -Headers $headers -UseBasicParsing -TimeoutSec 10 -SkipHttpErrorCheck
      if ($response.StatusCode -ne 200) {
        Add-Failure "n8n API returned $($response.StatusCode)."
      }
    } catch {
      $statusCode = $null
      if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
        $statusCode = [int]$_.Exception.Response.StatusCode
      }
      if ($statusCode) {
        Add-Failure "n8n API key check failed with HTTP $statusCode."
      } else {
        Add-Failure "n8n API key check failed."
      }
    }
  }
}

if ([string]::IsNullOrWhiteSpace($env:N8N_MCP_TOKEN)) {
  Add-Failure "N8N_MCP_TOKEN is not set."
}

if ($failures.Count -gt 0) {
  foreach ($failure in $failures) {
    [Console]::Error.WriteLine("ERROR: $failure")
  }
  exit 1
}

Write-Host "n8n local connection checks passed."
exit 0
