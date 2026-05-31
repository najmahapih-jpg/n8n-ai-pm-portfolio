param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$ApiKey = $env:N8N_API_KEY,
  [string]$SdkPath = ".\workflows\sdk\rag-knowledge-assistant.workflow.js",
  [string]$GeneratedPath = ".\workflows\generated\rag-knowledge-assistant.json",
  [string]$MetaPath = ".\workflows\sdk\rag-knowledge-assistant.meta.json",
  [int]$MinimumNodes = 27,
  [switch]$SkipCompile,
  [switch]$NoActivate,
  # --- v0.2.0 live-path deploy-time wiring (NEVER written to any tracked file) -------------------
  # The Supabase project host is a secret-scanned token and the credential binding must not live in
  # the tracked workflow JSON. These are substituted into the PUT payload (in-memory) ONLY:
  #   - the '__SUPABASE_RPC_URL__' placeholder -> $SupabaseUrl/rest/v1/rpc/match_documents
  #   - a credentials block { supabaseApi: { id } } on the 'Match Documents (Supabase RPC)' node.
  # Defaults are read from .env (SUPABASE_URL) and .omc/supabase-cred-id.txt (gitignored). When the
  # url/cred are absent (e.g. CI), the placeholder remains and the live retrieval simply yields no
  # rows -> a clean abstain; the stub default is unaffected.
  [string]$SupabaseUrl = $env:SUPABASE_URL,
  [string]$SupabaseCredentialId = "",
  [string]$SupabaseRpcNodeName = "Match Documents (Supabase RPC)"
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

# 2a. Deploy-time live-path wiring (in-memory PUT payload ONLY; never persisted to a tracked file).
#     Resolve the Supabase URL + credential id (param > env > .env / .omc), then (a) substitute the
#     RPC URL placeholder and (b) attach the predefined Supabase credential to the RPC node, so the
#     deployed workflow can reach the live store while the tracked JSON stays secret-free.
if ([string]::IsNullOrWhiteSpace($SupabaseUrl)) {
  $envFile = Join-Path $repoRoot ".env"
  if (Test-Path -LiteralPath $envFile -PathType Leaf) {
    $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*SUPABASE_URL\s*=' } | Select-Object -First 1
    if ($null -ne $line) { $SupabaseUrl = ($line -replace '^\s*SUPABASE_URL\s*=\s*', '').Trim() }
  }
}
if ([string]::IsNullOrWhiteSpace($SupabaseCredentialId)) {
  # httpHeaderAuth credential carrying the Supabase 'apikey' header (reliable on the HTTP node; the
  # predefined supabaseApi type surfaces ECONNREFUSED in this n8n build). Just the id is injected.
  $credFile = Join-Path $repoRoot ".omc\supabase-header-cred-id.txt"
  if (Test-Path -LiteralPath $credFile -PathType Leaf) { $SupabaseCredentialId = (Get-Content -LiteralPath $credFile -Raw).Trim() }
}

$liveWired = $false
foreach ($node in @($workflow.nodes)) {
  if ([string]$node.name -ne $SupabaseRpcNodeName) { continue }
  # (a) Substitute the RPC URL placeholder with the real PostgREST RPC endpoint.
  if (-not [string]::IsNullOrWhiteSpace($SupabaseUrl) -and $node.PSObject.Properties["parameters"] -and $node.parameters.PSObject.Properties["url"]) {
    $rpcUrl = ($SupabaseUrl.TrimEnd('/')) + "/rest/v1/rpc/match_documents"
    $node.parameters.url = ([string]$node.parameters.url) -replace '__SUPABASE_RPC_URL__', $rpcUrl
  }
  # (b) Attach the httpHeaderAuth credential by id (no secret — just the id n8n resolves to the apikey
  #     header). The node's authentication=genericCredentialType + genericAuthType=httpHeaderAuth.
  if (-not [string]::IsNullOrWhiteSpace($SupabaseCredentialId)) {
    $node | Add-Member -NotePropertyName "credentials" -NotePropertyValue ([pscustomobject]@{ httpHeaderAuth = [pscustomobject]@{ id = $SupabaseCredentialId } }) -Force
    $liveWired = $true
  }
}
# Substitute the placeholder anywhere it appears in the Normalize node's code (the URL default).
if (-not [string]::IsNullOrWhiteSpace($SupabaseUrl)) {
  $rpcUrl = ($SupabaseUrl.TrimEnd('/')) + "/rest/v1/rpc/match_documents"
  foreach ($node in @($workflow.nodes)) {
    if ($node.PSObject.Properties["parameters"] -and $node.parameters.PSObject.Properties["jsCode"]) {
      $node.parameters.jsCode = ([string]$node.parameters.jsCode) -replace '__SUPABASE_RPC_URL__', $rpcUrl
    }
  }
}
if ($liveWired) {
  Write-Host "==> Live-path wiring applied to '$SupabaseRpcNodeName' (RPC URL + httpHeaderAuth credential id; PUT payload only)."
} else {
  Write-Host "==> WARN: Supabase credential id/url not resolved; deploying with placeholder (live retrieval will abstain). Stub default unaffected."
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

# 3. Read the existing workflow id from meta.json so we UPDATE in place when one exists, or CREATE
#    a NEW workflow (and persist its id back) when the id is empty (the Phase 2a first deploy).
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
    # This n8n build requires an (empty) JSON body on the activate POST or it returns HTTP 415.
    $activate = Invoke-WebRequest -Uri "$base/api/v1/workflows/$workflowId/activate" -Method Post -Headers $headers -Body "{}" -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck
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
