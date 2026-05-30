param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$OllamaUrl = $env:OLLAMA_URL,
  [string]$WebhookPath = "webhook/portfolio/llm-eval-harness",
  [string]$GoldenFile = "",
  [string]$Model = "llama3.2:3b",
  [switch]$SkipSync
)

# Test-Bench.ps1 — the LIVE multi-model bench driver (npm run verify:bench).
#
# This is intentionally NOT part of verify:live / CI (like verify:judge): it runs the LIVE
# sutMode:"model" fan-out against local Ollama, so it needs a running Ollama + a pulled model and is
# non-deterministic on the live lane. It mirrors ADR-0004 d.3/d.6: the bench ALWAYS runs TWO lanes —
# the deterministic 'stub' lane (the reproducible comparison baseline) + the live 'llama3.2:3b' lane —
# and to avoid confounding the SUT-model comparison with JUDGE variance it pins the STUB JUDGE (a
# FIXED judge, varying SUT model). It prints the per-model cost-quality-latency triangle + the ranked
# bench + the RAW response JSON verbatim (evidence the models really ran), honestly — a lane that
# fails or is unreachable is a real result (sutSource:"error", passed=false), not a hidden failure.
#
# Steps:
#   1. (optional) sync the SDK -> live eval-harness so the sutMode:"model" gate is deployed + active.
#   2. Call Ollama directly for ONE bench case and print the RAW model text (evidence the model runs).
#   3. POST the bench slice to the live webhook with sutMode:"model" (stub + llama3.2:3b lanes, stub judge).
#   4. Print the per-model triangle (passRate / meanLatencyMs / totalTokens / estCostUsd / costBasis),
#      the ranked bench, and the RAW response JSON verbatim.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

if ([string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl = "http://localhost:5678" }
$base = $BaseUrl.TrimEnd("/")
$webhookUrl = "$base/$($WebhookPath.TrimStart('/'))"

# The workflow itself reaches Ollama at host.docker.internal (it is containerized); this script runs
# on the HOST, so it talks to Ollama at localhost by default.
if ([string]::IsNullOrWhiteSpace($OllamaUrl)) { $OllamaUrl = "http://localhost:11434" }
$ollamaBase = $OllamaUrl.TrimEnd("/")

if ([string]::IsNullOrWhiteSpace($GoldenFile)) {
  $GoldenFile = Join-Path $repoRoot "fixtures\golden\bench-model-slice.json"
}
if (-not (Test-Path -LiteralPath $GoldenFile -PathType Leaf)) {
  [Console]::Error.WriteLine("ERROR: bench golden file not found: $GoldenFile")
  exit 2
}

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host ("=" * 78)
  Write-Host $Title
  Write-Host ("=" * 78)
}

# --- 1. Ensure the live eval-harness is deployed (sutMode:"model" gate active) -----------------
if (-not $SkipSync) {
  Write-Section "Step 1/4: Sync SDK -> live eval-harness (deploy sutMode:model gate, keep active)"
  & (Join-Path $repoRoot "scripts\Sync-N8nWorkflowFromSdk.ps1")
  if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine("ERROR: sync failed; cannot exercise the live bench.")
    exit 1
  }
}

$goldenDoc = Get-Content -LiteralPath $GoldenFile -Raw | ConvertFrom-Json -Depth 100
$cases = @($goldenDoc.golden)
if ($cases.Count -eq 0) {
  [Console]::Error.WriteLine("ERROR: bench slice has no golden cases.")
  exit 2
}

# --- 2. Raw Ollama response for ONE bench case (evidence the live SUT model really runs) --------
Write-Section "Step 2/4: Raw Ollama SUT response for one bench case (direct model call)"
$sampleCase = $cases[0]
$ollamaBody = @{
  model = $Model
  stream = $false
  options = @{ temperature = 0 }
  messages = @(
    @{ role = "user"; content = [string]$sampleCase.input }
  )
} | ConvertTo-Json -Depth 10

Write-Host ("Case: {0}   (expected: {1})" -f $sampleCase.id, $sampleCase.expected)
Write-Host ("Model: {0}  @ {1}/api/chat" -f $Model, $ollamaBase)
try {
  $ollamaResp = Invoke-WebRequest -Uri "$ollamaBase/api/chat" -Method Post -ContentType "application/json" -Body $ollamaBody -UseBasicParsing -TimeoutSec 120 -SkipHttpErrorCheck
  $ollamaJson = $ollamaResp.Content | ConvertFrom-Json -Depth 50
  $rawContent = [string]$ollamaJson.message.content
  Write-Host "Raw Ollama SUT text (verbatim):"
  Write-Host $rawContent
  $tok = 0
  if ($ollamaJson.PSObject.Properties["eval_count"]) { $tok += [int]$ollamaJson.eval_count }
  if ($ollamaJson.PSObject.Properties["prompt_eval_count"]) { $tok += [int]$ollamaJson.prompt_eval_count }
  $ms = if ($ollamaJson.PSObject.Properties["total_duration"]) { [math]::Round([double]$ollamaJson.total_duration / 1e6) } else { 0 }
  Write-Host ("tokens (eval+prompt_eval): {0}   latency: {1} ms" -f $tok, $ms)
} catch {
  Write-Host ("WARN: direct Ollama call failed ({0}); the workflow may still reach it via host.docker.internal." -f $_.Exception.Message)
}

# --- 3. POST the bench slice to the live webhook (harness fans out cases x sutModels) -----------
Write-Section "Step 3/4: POST bench slice to eval-harness webhook (sutMode:model, stub judge)"
Write-Host ("Webhook: {0}" -f $webhookUrl)
Write-Host ("sutModels: {0}   judge: stub (fixed judge, varying SUT model)" -f ((@($goldenDoc.sutModels)) -join ", "))
$body = Get-Content -LiteralPath $GoldenFile -Raw
try {
  $resp = Invoke-WebRequest -Uri $webhookUrl -Method Post -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 300 -SkipHttpErrorCheck
} catch {
  [Console]::Error.WriteLine("ERROR: bench webhook call failed: $($_.Exception.Message)")
  exit 1
}
$status = [int]$resp.StatusCode
Write-Host ("HTTP status: {0}" -f $status)
if ($status -ne 200) {
  [Console]::Error.WriteLine("ERROR: expected HTTP 200 from bench run, got $status. Body: $($resp.Content)")
  exit 1
}
$result = $resp.Content | ConvertFrom-Json -Depth 100

if ([string]$result.sutMode -ne "model") {
  [Console]::Error.WriteLine("ERROR: expected sutMode 'model' in response, got '$($result.sutMode)'. The model gate did not route.")
  exit 1
}
$perModel = if ($result.PSObject.Properties["perModel"]) { @($result.perModel) } else { @() }
if ($perModel.Count -lt 2) {
  [Console]::Error.WriteLine("ERROR: expected >=2 perModel entries (stub + live lane), got $($perModel.Count).")
  exit 1
}

# --- 4. Per-model triangle + ranked bench + raw JSON -------------------------------------------
Write-Section "Step 4/4: Per-model cost-quality-latency triangle (HONEST -- real numbers)"
Write-Host ("sutMode: {0}   judgeSource: {1}   judgeTrust: {2}   overall passRate: {3}" -f $result.sutMode, $result.judgeSource, $result.judgeTrust, $result.passRate)
Write-Host ""
Write-Host ("{0,-18} {1,-8} {2,-10} {3,-12} {4,-12} {5,-12} {6}" -f "modelId", "total", "passRate", "meanLatMs", "totalTokens", "estCostUsd", "costBasis")
Write-Host ("-" * 92)
foreach ($m in $perModel) {
  $tokens = if ($null -ne $m.totalTokens) { [string]$m.totalTokens } else { "n/a" }
  $lat = if ($null -ne $m.meanLatencyMs) { [string]$m.meanLatencyMs } else { "n/a" }
  Write-Host ("{0,-18} {1,-8} {2,-10} {3,-12} {4,-12} {5,-12} {6}" -f $m.modelId, $m.total, $m.passRate, $lat, $tokens, $m.estCostUsd, $m.costBasis)
}

Write-Host ""
Write-Host "Ranked bench (best passRate first; ties -> lower latency, then lower cost):"
foreach ($b in @($result.bench)) {
  $lat = if ($null -ne $b.meanLatencyMs) { [string]$b.meanLatencyMs } else { "n/a" }
  Write-Host ("  #{0}  {1,-18} passRate={2}  latMs={3}  costUsd={4} ({5})" -f $b.rank, $b.modelId, $b.passRate, $lat, $b.estCostUsd, $b.costBasis)
}

Write-Section "Raw bench response JSON (verbatim evidence)"
Write-Host $resp.Content

Write-Host ""
Write-Host "NOTE: the 'stub' lane is the deterministic, reproducible comparison baseline; the live lane(s)"
Write-Host "      are real local-model results (local Ollama => estCostUsd 0, costBasis 'local-free' --"
Write-Host "      tokens + latency are the honest cost signal; a local $ figure is never fabricated). A"
Write-Host "      lower live-lane passRate is a REAL result about the model on this golden slice, not a"
Write-Host "      harness failure. regressionDelta is null (the v0.5.0 regression-vs-baseline work)."

# This driver does not fail the build on a low live-lane pass-rate: a low (but real) number is a VALID
# result. It only fails on infrastructure errors (sync/webhook/HTTP) or a missing perModel surface.
Write-Host ""
Write-Host "verify:bench complete (live multi-model SUT fan-out exercised: stub + llama3.2:3b lanes)."
exit 0
