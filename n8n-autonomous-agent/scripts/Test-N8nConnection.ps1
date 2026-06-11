param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [switch]$SkipApiCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  $BaseUrl = "http://localhost:5678"
}
$base = $BaseUrl.TrimEnd("/")

$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
  param([string]$Message)
  $script:failures.Add($Message) | Out-Null
}

# 1. Liveness: GET /healthz must return 200.
try {
  $health = Invoke-WebRequest -Uri "$base/healthz" -UseBasicParsing -TimeoutSec 5 -SkipHttpErrorCheck
  if ([int]$health.StatusCode -ne 200) {
    Add-Failure "n8n health endpoint returned $($health.StatusCode)."
  }
} catch {
  Add-Failure "n8n health endpoint is not reachable at $base/healthz."
}

# 2. Public REST API reachability: GET /api/v1/workflows with the API key must return 200.
if (-not $SkipApiCheck) {
  if ([string]::IsNullOrWhiteSpace($env:N8N_API_KEY)) {
    Add-Failure "N8N_API_KEY is not set."
  } else {
    try {
      $headers = @{ "X-N8N-API-KEY" = $env:N8N_API_KEY }
      $response = Invoke-WebRequest -Uri "$base/api/v1/workflows" -Headers $headers -UseBasicParsing -TimeoutSec 10 -SkipHttpErrorCheck
      if ([int]$response.StatusCode -ne 200) {
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

if ($failures.Count -gt 0) {
  foreach ($failure in $failures) {
    [Console]::Error.WriteLine("ERROR: $failure")
  }
  exit 1
}

Write-Host "n8n local connection checks passed."
exit 0
