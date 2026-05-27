param(
  [string]$WorkflowId = "RPkw9jGJ93lqs7jO",
  [string]$SdkPath = ".\workflows\sdk\portfolio-support-triage-api.workflow.js",
  [string]$ArtifactName = "portfolio-support-triage-api",
  [string]$GeneratedOutputDirectory = ".\workflows\generated",
  [string]$CanonicalOutputDirectory = ".\workflows\canonical",
  [string]$ReleasePath = ".\workflows\releases\support-triage-v0.2.0.json",
  [int]$MinimumNodes = 21,
  [string]$Description = "21-node SupportOps triage: normalize/validate tickets, classify category, score urgency, route owner, compute SLA, branch escalation, create redacted audit event, respond.",
  [string]$McpUrl = "http://localhost:5678/mcp-server/http",
  [string]$McpToken = $env:N8N_MCP_TOKEN,
  [string]$ApiUrl = $env:N8N_API_URL,
  [string]$ApiKey = $env:N8N_API_KEY,
  [switch]$SkipUpdate
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

function Invoke-N8nMcpTool {
  param(
    [string]$Name,
    [hashtable]$Arguments
  )

  $headers = @{
    Authorization = "Bearer $McpToken"
    "Content-Type" = "application/json"
    Accept = "application/json, text/event-stream"
  }
  $body = @{
    jsonrpc = "2.0"
    id = Get-Random
    method = "tools/call"
    params = @{
      name = $Name
      arguments = $Arguments
    }
  } | ConvertTo-Json -Depth 100

  $response = Invoke-WebRequest -Uri $McpUrl -Method Post -Headers $headers -Body $body -UseBasicParsing -TimeoutSec 120
  $line = ($response.Content -split "`n" | Where-Object { $_ -like "data: *" } | Select-Object -Last 1)
  if (-not $line) {
    throw "MCP response did not contain an SSE data line."
  }

  $json = $line.Substring(6) | ConvertFrom-Json -Depth 100
  if ($json.PSObject.Properties["result"] -and $json.result.PSObject.Properties["isError"] -and $json.result.isError) {
    throw (($json.result.content | ConvertTo-Json -Depth 20))
  }
  if ($json.PSObject.Properties["error"] -and $json.error) {
    throw ($json.error | ConvertTo-Json -Depth 20)
  }

  return $json.result.structuredContent
}

function Invoke-ProjectScript {
  param([string[]]$Arguments)

  & pwsh -NoProfile @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: pwsh -NoProfile $($Arguments -join ' ')"
  }
}

if ([string]::IsNullOrWhiteSpace($McpToken)) {
  Exit-WithCode -Code 2 -Message "N8N_MCP_TOKEN is required. Pass -McpToken or set the environment variable."
}
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  Exit-WithCode -Code 2 -Message "N8N_API_KEY is required. Pass -ApiKey or set the environment variable."
}
if ([string]::IsNullOrWhiteSpace($ApiUrl)) {
  $ApiUrl = "http://localhost:5678"
}
if (-not (Test-Path -LiteralPath $SdkPath)) {
  Exit-WithCode -Code 2 -Message "SDK source does not exist: $SdkPath"
}

$code = Get-Content -LiteralPath $SdkPath -Raw
$validation = Invoke-N8nMcpTool -Name "validate_workflow" -Arguments @{ code = $code }
if (-not $validation.valid) {
  Exit-WithCode -Code 3 -Message "Official MCP SDK validation failed."
}
if ([int]$validation.nodeCount -lt $MinimumNodes) {
  Exit-WithCode -Code 3 -Message "SDK produced $($validation.nodeCount) nodes, below the required floor of $MinimumNodes."
}
Write-Host "Official MCP SDK validation passed ($($validation.nodeCount) nodes)."

if (-not $SkipUpdate) {
  $updated = Invoke-N8nMcpTool -Name "update_workflow" -Arguments @{ workflowId = $WorkflowId; code = $code; description = $Description }
  if ($updated.workflowId -ne $WorkflowId) {
    Exit-WithCode -Code 4 -Message "Official MCP update returned unexpected workflow ID '$($updated.workflowId)'."
  }
  Write-Host "Official MCP updated workflow '$WorkflowId' ($($updated.nodeCount) nodes)."
}

New-Item -ItemType Directory -Force -Path $GeneratedOutputDirectory | Out-Null
$generatedRoot = Resolve-Path -LiteralPath $GeneratedOutputDirectory
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$batchDirectory = Join-Path $generatedRoot.Path $stamp
New-Item -ItemType Directory -Force -Path $batchDirectory | Out-Null

$workflowUrl = "$($ApiUrl.TrimEnd('/'))/api/v1/workflows/$WorkflowId"
$headers = @{
  "X-N8N-API-KEY" = $ApiKey
  Accept = "application/json"
}
$response = Invoke-WebRequest -Uri $workflowUrl -Headers $headers -UseBasicParsing -TimeoutSec 30
$workflow = $response.Content | ConvertFrom-Json -Depth 100
$rawPath = Join-Path $batchDirectory "$ArtifactName.json"
$workflow | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $rawPath -Encoding utf8
$exportedNodeCount = @($workflow.nodes).Count
if ($exportedNodeCount -lt $MinimumNodes) {
  Exit-WithCode -Code 5 -Message "API export produced $exportedNodeCount nodes, below the required floor of $MinimumNodes."
}
Write-Host "API exported current draft to $rawPath ($exportedNodeCount nodes)."

Invoke-ProjectScript -Arguments @("-File", ".\scripts\Scrub-N8nWorkflow.ps1", "-InputPath", $batchDirectory, "-OutputDirectory", $CanonicalOutputDirectory)

$canonicalPath = Join-Path $CanonicalOutputDirectory "$ArtifactName.canonical.json"
if (-not (Test-Path -LiteralPath $canonicalPath)) {
  Exit-WithCode -Code 6 -Message "Expected canonical output was not created: $canonicalPath"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReleasePath) | Out-Null
Copy-Item -LiteralPath $canonicalPath -Destination $ReleasePath -Force

Invoke-ProjectScript -Arguments @("-File", ".\scripts\Test-N8nWorkflowJson.ps1", "-Path", $canonicalPath, "-MinimumNodes", [string]$MinimumNodes)
Invoke-ProjectScript -Arguments @("-File", ".\scripts\Test-N8nWorkflowJson.ps1", "-Path", $ReleasePath, "-MinimumNodes", [string]$MinimumNodes)

$canonicalHash = (Get-FileHash -LiteralPath $canonicalPath -Algorithm SHA256).Hash
$releaseHash = (Get-FileHash -LiteralPath $ReleasePath -Algorithm SHA256).Hash
if ($canonicalHash -ne $releaseHash) {
  Exit-WithCode -Code 7 -Message "Canonical and release hashes differ after sync."
}

Write-Host "SDK -> official MCP -> API export -> canonical -> release sync passed."
exit 0
