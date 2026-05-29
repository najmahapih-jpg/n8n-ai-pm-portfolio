param(
  [string]$WorkflowId = "",
  [string]$SdkPath = ".\workflows\sdk\lead-intelligence.workflow.js",
  [string]$MetaPath = ".\workflows\sdk\lead-intelligence.meta.json",
  [string]$ArtifactName = "lead-intelligence",
  [string]$GeneratedOutputDirectory = ".\workflows\generated",
  [string]$CanonicalOutputDirectory = ".\workflows\canonical",
  [string]$ReleasePath = ".\workflows\releases\lead-intelligence-v0.1.0.json",
  [int]$MinimumNodes = 31,
  [string]$Description = "Local B2B lead intelligence: validate intake, dedupe, enrich with deterministic rules, score ICP and intent, route sales ownership, build CRM-ready payload, redact audit, respond.",
  [string]$McpUrl = "http://localhost:5678/mcp-server/http",
  [string]$McpToken = $env:N8N_MCP_TOKEN,
  [string]$ApiUrl = $env:N8N_API_URL,
  [string]$ApiKey = $env:N8N_API_KEY,
  [switch]$SkipUpdate
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

function Invoke-ProjectScript {
  param([string[]]$Arguments)

  & pwsh -NoProfile @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: pwsh -NoProfile $($Arguments -join ' ')"
  }
}

function Get-ResultWorkflowId {
  param([object]$Result)

  if ($null -eq $Result) {
    return ""
  }
  if ($Result.PSObject.Properties["workflowId"]) {
    return [string]$Result.workflowId
  }
  if ($Result.PSObject.Properties["id"]) {
    return [string]$Result.id
  }
  if ($Result.PSObject.Properties["workflow"] -and $Result.workflow.PSObject.Properties["id"]) {
    return [string]$Result.workflow.id
  }
  return ""
}

function Set-JsonProperty {
  param(
    [object]$Object,
    [string]$Name,
    [object]$Value
  )

  if ($Object.PSObject.Properties[$Name]) {
    $Object.PSObject.Properties[$Name].Value = $Value
  } else {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  }
}

function Update-WorkflowMetadata {
  param(
    [string]$Path,
    [string]$WorkflowId,
    [string]$Status
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }

  $metadata = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 100
  Set-JsonProperty -Object $metadata -Name "n8nWorkflowId" -Value $WorkflowId
  Set-JsonProperty -Object $metadata -Name "lastWriter" -Value "official n8n MCP"
  Set-JsonProperty -Object $metadata -Name "status" -Value $Status
  Set-JsonProperty -Object $metadata -Name "updatedAt" -Value (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

  $json = ($metadata | ConvertTo-Json -Depth 100) + [Environment]::NewLine
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
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

$resolvedSdkPath = Resolve-ProjectPath -Path $SdkPath
$resolvedMetaPath = Resolve-ProjectPath -Path $MetaPath
$resolvedGeneratedOutputDirectory = Resolve-ProjectPath -Path $GeneratedOutputDirectory
$resolvedCanonicalOutputDirectory = Resolve-ProjectPath -Path $CanonicalOutputDirectory
$resolvedReleasePath = Resolve-ProjectPath -Path $ReleasePath

if (-not (Test-Path -LiteralPath $resolvedSdkPath)) {
  Exit-WithCode -Code 2 -Message "SDK source does not exist: $resolvedSdkPath"
}

if ([string]::IsNullOrWhiteSpace($WorkflowId) -and (Test-Path -LiteralPath $resolvedMetaPath -PathType Leaf)) {
  $metadata = Get-Content -LiteralPath $resolvedMetaPath -Raw | ConvertFrom-Json -Depth 100
  if ($metadata.PSObject.Properties["n8nWorkflowId"]) {
    $WorkflowId = [string]$metadata.n8nWorkflowId
  }
}

$code = Get-Content -LiteralPath $resolvedSdkPath -Raw
$validation = Invoke-N8nMcpTool -Name "validate_workflow" -Arguments @{ code = $code }
if (-not $validation.valid) {
  Exit-WithCode -Code 3 -Message "Official MCP SDK validation failed."
}
if ([int]$validation.nodeCount -lt $MinimumNodes) {
  Exit-WithCode -Code 3 -Message "SDK produced $($validation.nodeCount) nodes, below the required floor of $MinimumNodes."
}
Write-Host "Official MCP SDK validation passed ($($validation.nodeCount) nodes)."

if (-not $SkipUpdate) {
  if ([string]::IsNullOrWhiteSpace($WorkflowId)) {
    $created = Invoke-N8nMcpTool -Name "create_workflow_from_code" -Arguments @{ code = $code; description = $Description }
    $WorkflowId = Get-ResultWorkflowId -Result $created
    if ([string]::IsNullOrWhiteSpace($WorkflowId)) {
      Exit-WithCode -Code 4 -Message "Official MCP create did not return a workflow ID."
    }
    Write-Host "Official MCP created workflow '$WorkflowId'."
  } else {
    $updated = Invoke-N8nMcpTool -Name "update_workflow" -Arguments @{ workflowId = $WorkflowId; code = $code; description = $Description }
    $updatedWorkflowId = Get-ResultWorkflowId -Result $updated
    if (-not [string]::IsNullOrWhiteSpace($updatedWorkflowId) -and $updatedWorkflowId -ne $WorkflowId) {
      Exit-WithCode -Code 4 -Message "Official MCP update returned unexpected workflow ID '$updatedWorkflowId'."
    }
    Write-Host "Official MCP updated workflow '$WorkflowId'."
  }

  Update-WorkflowMetadata -Path $resolvedMetaPath -WorkflowId $WorkflowId -Status "draft-tested"
} elseif ([string]::IsNullOrWhiteSpace($WorkflowId)) {
  Exit-WithCode -Code 4 -Message "WorkflowId is required for -SkipUpdate exports. Run without -SkipUpdate once to create the local draft."
}

New-Item -ItemType Directory -Force -Path $resolvedGeneratedOutputDirectory | Out-Null
$generatedRoot = Resolve-Path -LiteralPath $resolvedGeneratedOutputDirectory
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

Invoke-ProjectScript -Arguments @("-File", (Join-Path $repoRoot "scripts\Scrub-N8nWorkflow.ps1"), "-InputPath", $batchDirectory, "-OutputDirectory", $resolvedCanonicalOutputDirectory)

$canonicalPath = Join-Path $resolvedCanonicalOutputDirectory "$ArtifactName.canonical.json"
if (-not (Test-Path -LiteralPath $canonicalPath)) {
  Exit-WithCode -Code 6 -Message "Expected canonical output was not created: $canonicalPath"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedReleasePath) | Out-Null
Copy-Item -LiteralPath $canonicalPath -Destination $resolvedReleasePath -Force

Invoke-ProjectScript -Arguments @("-File", (Join-Path $repoRoot "scripts\Test-N8nWorkflowJson.ps1"), "-Path", $canonicalPath, "-MinimumNodes", [string]$MinimumNodes)
Invoke-ProjectScript -Arguments @("-File", (Join-Path $repoRoot "scripts\Test-N8nWorkflowJson.ps1"), "-Path", $resolvedReleasePath, "-MinimumNodes", [string]$MinimumNodes)

$canonicalHash = (Get-FileHash -LiteralPath $canonicalPath -Algorithm SHA256).Hash
$releaseHash = (Get-FileHash -LiteralPath $resolvedReleasePath -Algorithm SHA256).Hash
if ($canonicalHash -ne $releaseHash) {
  Exit-WithCode -Code 7 -Message "Canonical and release hashes differ after sync."
}

Write-Host "SDK -> official MCP -> API export -> canonical -> release sync passed."
exit 0
