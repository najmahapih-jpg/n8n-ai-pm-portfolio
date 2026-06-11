param(
  [Parameter(Mandatory = $true)]
  [string]$WorkflowId,
  [string]$OutputDirectory = ".\workflows\generated",
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$ApiKey = $env:N8N_API_KEY,
  [string]$FileName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  $BaseUrl = "http://localhost:5678"
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  Exit-WithCode -Code 2 -Message "N8N_API_KEY is required. Pass -ApiKey or set the environment variable."
}

if ([string]::IsNullOrWhiteSpace($FileName)) {
  $FileName = "$WorkflowId.json"
}

if (-not $FileName.EndsWith(".json", [System.StringComparison]::OrdinalIgnoreCase)) {
  $FileName = "$FileName.json"
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$hostOutput = Resolve-Path -LiteralPath $OutputDirectory
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$destination = Join-Path $hostOutput.Path $stamp
New-Item -ItemType Directory -Force -Path $destination | Out-Null

$base = $BaseUrl.TrimEnd("/")
$workflowUrl = "$base/api/v1/workflows/$WorkflowId"
$headers = @{
  "X-N8N-API-KEY" = $ApiKey
  "Accept" = "application/json"
}

try {
  $response = Invoke-WebRequest -Uri $workflowUrl -Headers $headers -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
  $workflow = $response.Content | ConvertFrom-Json -Depth 100
  $outputPath = Join-Path $destination $FileName
  $workflow | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $outputPath -Encoding utf8

  $nodeCount = 0
  if ($workflow.PSObject.Properties["nodes"] -and $null -ne $workflow.nodes) {
    $nodeCount = @($workflow.nodes).Count
  }

  Write-Host "Exported workflow '$WorkflowId' to $outputPath ($nodeCount nodes)"
  exit 0
} catch {
  Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue
  Exit-WithCode -Code 4 -Message "API workflow export failed. $($_.Exception.Message)"
}
