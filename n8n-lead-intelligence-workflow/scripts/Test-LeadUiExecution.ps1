param(
  [string]$WorkflowId = "",
  [string]$MetaPath = ".\workflows\sdk\lead-intelligence.meta.json",
  [string]$McpUrl = "http://localhost:5678/mcp-server/http",
  [string]$McpToken = $env:N8N_MCP_TOKEN
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

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

function Resolve-ProjectPath {
  param([string]$Path)

  if ([System.IO.Path]::IsPathRooted($Path)) {
    return $Path
  }

  return (Join-Path $repoRoot $Path)
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

function Assert-Equal {
  param(
    [object]$Actual,
    [object]$Expected,
    [string]$Label
  )

  if (($Actual -is [bool]) -or ($Expected -is [bool])) {
    if ([bool]$Actual -ne [bool]$Expected) {
      throw "$Label expected '$Expected' but got '$Actual'"
    }
    return
  }

  if ([string]$Actual -ne [string]$Expected) {
    throw "$Label expected '$Expected' but got '$Actual'"
  }
}

if ([string]::IsNullOrWhiteSpace($McpToken)) {
  Exit-WithCode -Code 2 -Message "N8N_MCP_TOKEN is required. Pass -McpToken or set the environment variable."
}

$resolvedMetaPath = Resolve-ProjectPath -Path $MetaPath
if ([string]::IsNullOrWhiteSpace($WorkflowId) -and (Test-Path -LiteralPath $resolvedMetaPath -PathType Leaf)) {
  $meta = Get-Content -LiteralPath $resolvedMetaPath -Raw | ConvertFrom-Json -Depth 100
  if ($meta.PSObject.Properties["n8nWorkflowId"]) {
    $WorkflowId = [string]$meta.n8nWorkflowId
  }
}
if ([string]::IsNullOrWhiteSpace($WorkflowId)) {
  Exit-WithCode -Code 2 -Message "WorkflowId is required. Run scripts/Sync-N8nWorkflowFromSdk.ps1 first or pass -WorkflowId."
}

$pinData = @{
  "Run Demo Lead From n8n UI" = @(@{ json = @{} })
}
$test = Invoke-N8nMcpTool -Name "test_workflow" -Arguments @{ workflowId = $WorkflowId; pinData = $pinData }
Assert-Equal -Actual $test.status -Expected "success" -Label "manual UI execution status"

$exec = Invoke-N8nMcpTool -Name "get_execution" -Arguments @{
  workflowId = $WorkflowId
  executionId = [string]$test.executionId
  includeData = $true
  nodeNames = @("Show UI Execution Result")
  truncateData = 1
}
Assert-Equal -Actual $exec.execution.status -Expected "success" -Label "manual UI persisted execution status"

$runProperty = $exec.data.resultData.runData.PSObject.Properties["Show UI Execution Result"]
if (-not $runProperty) {
  throw "Manual UI execution did not reach 'Show UI Execution Result'"
}

$runs = @($runProperty.Value)
$nodeJson = $runs[$runs.Count - 1].data.main[0][0].json

Assert-Equal -Actual $nodeJson.ok -Expected $true -Label "manual UI result ok"
Assert-Equal -Actual $nodeJson.executionMode -Expected "manual-ui" -Label "manual UI executionMode"
Assert-Equal -Actual $nodeJson.response.grade -Expected "A" -Label "manual UI grade"
Assert-Equal -Actual $nodeJson.response.route.ownerQueue -Expected "enterprise-ae" -Label "manual UI ownerQueue"
Assert-Equal -Actual $nodeJson.response.notification.status -Expected "skipped" -Label "manual UI notification.status"

[pscustomobject]@{
  ExecutionId = $test.executionId
  Status = $test.status
  Mode = $nodeJson.executionMode
  Grade = $nodeJson.response.grade
  OwnerQueue = $nodeJson.response.route.ownerQueue
  NotificationStatus = $nodeJson.response.notification.status
} | Format-Table -AutoSize

Write-Host "Lead intelligence manual UI execution test passed."
exit 0
