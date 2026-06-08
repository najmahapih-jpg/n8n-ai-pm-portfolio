param(
  [string]$WorkflowId = "",
  [string]$MetaPath = ".\workflows\sdk\interaction-gateway.meta.json",
  [string]$ApiUrl = $env:N8N_API_URL,
  [string]$ApiKey = $env:N8N_API_KEY,
  [int]$PollSeconds = 15
)

# Re-register an active workflow's production webhook after an API/MCP update.
#
# WHY: updating a workflow definition via the public REST API or the n8n MCP does NOT
# re-register its production webhook. The definition is updated and `active` stays true,
# but the running webhook keeps serving the PREVIOUS flow until the workflow is toggled.
# This script forces a deactivate -> activate cycle (which re-registers the webhook),
# then confirms the workflow is active again.
#
# GOTCHA: the /activate endpoint requires a Content-Type and a body, otherwise it returns
# HTTP 415 and the workflow is left DEACTIVATED (production URL -> 404). We always send
# `-ContentType application/json -Body '{}'`.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  [Console]::Error.WriteLine("ERROR: N8N_API_KEY is not set.")
  exit 1
}
$base = if ([string]::IsNullOrWhiteSpace($ApiUrl)) { "http://localhost:5678" } else { $ApiUrl }
$base = $base.TrimEnd("/")

# Resolve workflow id from meta.json when not supplied explicitly.
if ([string]::IsNullOrWhiteSpace($WorkflowId)) {
  $repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
  $resolvedMeta = if ([System.IO.Path]::IsPathRooted($MetaPath)) { $MetaPath } else { Join-Path $repoRoot ($MetaPath -replace '^\.[\\/]', '') }
  if (-not (Test-Path -LiteralPath $resolvedMeta -PathType Leaf)) {
    [Console]::Error.WriteLine("ERROR: meta file not found: $resolvedMeta (pass -WorkflowId instead).")
    exit 2
  }
  $WorkflowId = (Get-Content -LiteralPath $resolvedMeta -Raw | ConvertFrom-Json).n8nWorkflowId
}
if ([string]::IsNullOrWhiteSpace($WorkflowId)) {
  [Console]::Error.WriteLine("ERROR: could not resolve a workflow id.")
  exit 2
}

$headers = @{ "X-N8N-API-KEY" = $ApiKey }

Write-Host "Reactivating workflow $WorkflowId to re-register its production webhook..."

# 1. Deactivate (idempotent if already inactive).
try {
  Invoke-RestMethod -Uri "$base/api/v1/workflows/$WorkflowId/deactivate" -Method Post -Headers $headers -TimeoutSec 15 | Out-Null
} catch {
  # A 400 "already deactivated" is fine; anything else is surfaced after the activate attempt.
  Write-Host "  (deactivate returned a non-2xx; continuing to activate)"
}

# 2. Activate WITH Content-Type + body (a bare activate 415s and leaves the workflow DOWN).
$activated = $false
for ($attempt = 1; $attempt -le 3 -and -not $activated; $attempt++) {
  try {
    $resp = Invoke-RestMethod -Uri "$base/api/v1/workflows/$WorkflowId/activate" -Method Post -Headers $headers -ContentType "application/json" -Body "{}" -TimeoutSec 15
    if ($resp.active -eq $true) { $activated = $true }
  } catch {
    Start-Sleep -Seconds 2
  }
}

# 3. Confirm active via a fresh GET (do not trust the activate response alone).
$deadline = (Get-Date).AddSeconds($PollSeconds)
$isActive = $false
while ((Get-Date) -lt $deadline) {
  try {
    $wf = Invoke-RestMethod -Uri "$base/api/v1/workflows/$WorkflowId" -Headers $headers -TimeoutSec 10
    if ($wf.active -eq $true) { $isActive = $true; break }
  } catch { }
  Start-Sleep -Seconds 1
}

if (-not $isActive) {
  [Console]::Error.WriteLine("ERROR: workflow $WorkflowId is NOT active after reactivation. The production webhook may be DOWN — activate it manually (POST /activate with Content-Type application/json and body '{}').")
  exit 1
}

Write-Host "Workflow $WorkflowId reactivated and confirmed active; production webhook re-registered."
exit 0
