param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$ApiKey = $env:N8N_API_KEY,
  [string]$SdkPath = ".\workflows\sdk\llm-eval-harness.workflow.js",
  [string]$GeneratedPath = ".\workflows\generated\llm-eval-harness.json",
  [string]$MetaPath = ".\workflows\sdk\llm-eval-harness.meta.json",
  [int]$MinimumNodes = 30,
  [switch]$SkipCompile,
  [switch]$NoActivate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

function Resolve-RepoPath {
  param([string]$PathValue)
  if ([System.IO.Path]::IsPathRooted($PathValue)) { return $PathValue }
  return Join-Path $repoRoot ($PathValue -replace '^\.[\\/]', '')
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

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  $BaseUrl = "http://localhost:5678"
}
$base = $BaseUrl.TrimEnd("/")

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  Exit-WithCode -Code 2 -Message "N8N_API_KEY is required. Pass -ApiKey or set the environment variable."
}

$resolvedSdk = Resolve-RepoPath $SdkPath
$resolvedGenerated = Resolve-RepoPath $GeneratedPath
$resolvedMeta = Resolve-RepoPath $MetaPath

# 1. Compile the SDK source to deployable workflow JSON (unless explicitly skipped).
if (-not $SkipCompile) {
  Write-Host "==> Compiling SDK -> $resolvedGenerated"
  & (Join-Path $repoRoot "scripts\Compile-WorkflowFromSdk.ps1") -SdkPath $resolvedSdk -OutputPath $resolvedGenerated -MinimumNodes $MinimumNodes
  if ($LASTEXITCODE -ne 0) {
    Exit-WithCode -Code $LASTEXITCODE -Message "Compilation failed; aborting deploy."
  }
}

if (-not (Test-Path -LiteralPath $resolvedGenerated -PathType Leaf)) {
  Exit-WithCode -Code 4 -Message "Generated workflow JSON not found: $resolvedGenerated"
}

$workflow = Get-Content -LiteralPath $resolvedGenerated -Raw | ConvertFrom-Json -Depth 100
$nodeCount = if ($workflow.PSObject.Properties["nodes"] -and $null -ne $workflow.nodes) { @($workflow.nodes).Count } else { 0 }
if ($nodeCount -lt $MinimumNodes) {
  Exit-WithCode -Code 4 -Message "Compiled workflow has $nodeCount nodes, below the required floor of $MinimumNodes."
}

# 2. Build a write-payload containing only the fields the n8n public REST API accepts on
#    create/update. Everything else (id, active, tags, versionId, staticData, shared, meta,
#    timestamps, etc.) is read-only and rejected by the API on write.
$settings = if ($workflow.PSObject.Properties["settings"] -and $null -ne $workflow.settings) { $workflow.settings } else { [pscustomobject]@{} }
if (-not ($settings.PSObject.Properties["executionOrder"])) {
  $settings | Add-Member -NotePropertyName "executionOrder" -NotePropertyValue "v1" -Force
}

$payload = [ordered]@{
  name = [string]$workflow.name
  nodes = $workflow.nodes
  connections = $workflow.connections
  settings = $settings
}
$body = ($payload | ConvertTo-Json -Depth 100)

$headers = @{
  "X-N8N-API-KEY" = $ApiKey
  "Content-Type" = "application/json"
  "Accept" = "application/json"
}

# 3. Read the existing workflow id from meta.json so we UPDATE in place (never create a duplicate).
$meta = $null
$existingId = ""
if (Test-Path -LiteralPath $resolvedMeta -PathType Leaf) {
  $meta = Get-Content -LiteralPath $resolvedMeta -Raw | ConvertFrom-Json -Depth 100
  if ($meta.PSObject.Properties["n8nWorkflowId"]) { $existingId = [string]$meta.n8nWorkflowId }
}

$workflowId = $existingId
if (-not [string]::IsNullOrWhiteSpace($existingId)) {
  Write-Host "==> PUT /api/v1/workflows/$existingId (update in place)"
  try {
    $response = Invoke-WebRequest -Uri "$base/api/v1/workflows/$existingId" -Method Put -Headers $headers -Body $body -UseBasicParsing -TimeoutSec 60 -SkipHttpErrorCheck
  } catch {
    Exit-WithCode -Code 4 -Message "Update request failed. $($_.Exception.Message)"
  }
  if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
    Exit-WithCode -Code 4 -Message "Update returned HTTP $($response.StatusCode): $($response.Content)"
  }
  $result = $response.Content | ConvertFrom-Json -Depth 100
  $workflowId = [string]$result.id
} else {
  Write-Host "==> POST /api/v1/workflows (create new)"
  try {
    $response = Invoke-WebRequest -Uri "$base/api/v1/workflows" -Method Post -Headers $headers -Body $body -UseBasicParsing -TimeoutSec 60 -SkipHttpErrorCheck
  } catch {
    Exit-WithCode -Code 4 -Message "Create request failed. $($_.Exception.Message)"
  }
  if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
    Exit-WithCode -Code 4 -Message "Create returned HTTP $($response.StatusCode): $($response.Content)"
  }
  $result = $response.Content | ConvertFrom-Json -Depth 100
  $workflowId = [string]$result.id

  # Persist the new id back to meta.json so subsequent runs update in place.
  if ($null -ne $meta) {
    if ($meta.PSObject.Properties["n8nWorkflowId"]) {
      $meta.n8nWorkflowId = $workflowId
    } else {
      $meta | Add-Member -NotePropertyName "n8nWorkflowId" -NotePropertyValue $workflowId -Force
    }
    $metaJson = ($meta | ConvertTo-Json -Depth 100) + [Environment]::NewLine
    [System.IO.File]::WriteAllText($resolvedMeta, $metaJson, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Wrote new workflow id '$workflowId' back to $resolvedMeta"
  }
}

if ([string]::IsNullOrWhiteSpace($workflowId)) {
  Exit-WithCode -Code 4 -Message "Deploy did not return a workflow id."
}

# 4. Re-activate so the live workflow keeps serving the webhook.
if (-not $NoActivate) {
  Write-Host "==> POST /api/v1/workflows/$workflowId/activate"
  try {
    $activate = Invoke-WebRequest -Uri "$base/api/v1/workflows/$workflowId/activate" -Method Post -Headers $headers -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck
  } catch {
    Exit-WithCode -Code 4 -Message "Activation request failed. $($_.Exception.Message)"
  }
  if ([int]$activate.StatusCode -lt 200 -or [int]$activate.StatusCode -ge 300) {
    Exit-WithCode -Code 4 -Message "Activation returned HTTP $($activate.StatusCode): $($activate.Content)"
  }
  $activated = $activate.Content | ConvertFrom-Json -Depth 100
  $isActive = if ($activated.PSObject.Properties["active"]) { [bool]$activated.active } else { $true }
  Write-Host "Activated: $isActive"
}

Write-Host "Synced workflow '$workflowId' ($nodeCount nodes)."
exit 0
