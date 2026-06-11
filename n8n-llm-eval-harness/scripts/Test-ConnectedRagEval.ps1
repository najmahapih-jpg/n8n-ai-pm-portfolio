param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$ApiKey = $env:N8N_API_KEY,
  [string]$WebhookPath = "webhook/portfolio/llm-eval-harness",
  [string]$SutWebhookPath = "webhook/portfolio/rag-knowledge-assistant",
  [string]$GoldenFile = "",
  [string]$RagAssistantId = "jZ5Xfml8jbKexYqf",
  [switch]$SkipSync
)

# Test-ConnectedRagEval.ps1 — the LIVE connected-eval driver for the RAG assistant (npm run verify:connected-rag).
#
# This is the v0.6.0 proof that the eval harness (A) grades a SECOND, differently-shaped sibling — the
# RAG knowledge assistant (B, jZ5Xfml8jbKexYqf) — as a black-box subject-under-test, using the new
# CONFIGURABLE sutExtract dot-path (ADR-0005). B returns { ok, abstained, answer, citations, ... } with
# NO 'theme'; A reads B's top-level 'abstained' flag via sutExtract:"abstained", coerces the boolean to
# a comparable string, and exact-matches it against the golden 'expected'. Because B's DEFAULT (stub)
# retrieval+generation path is fully deterministic (it answers in-corpus, abstains out-of-corpus), this
# is REPRODUCIBLE: A's passRate MUST be 1.0. Like verify:connected, it is intentionally NOT in CI (it
# needs both A and B active) and only fails on infrastructure errors — PLUS, here, a passRate below 1.0,
# which would mean the configurable extraction regressed (the whole point of this driver).
#
# Steps:
#   1. (optional) sync the SDK -> live eval-harness so the v0.6.0 sutExtract path is deployed + active.
#   2. Activate the RAG assistant sibling so its webhook is callable.
#   3. Call the RAG assistant DIRECTLY for ONE case and print the RAW response (evidence of abstained).
#   4. POST the connected-rag slice to the eval-harness webhook with sutMode:"workflow",
#      sutExtract:"abstained"; the harness grades B live (extracts abstained, exact-matches vs expected).
#   5. Print the per-case abstained(actual from B) vs expected table + the pass-rate; assert passRate 1.0.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

if ([string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl = "http://localhost:5678" }
$base = $BaseUrl.TrimEnd("/")
$webhookUrl = "$base/$($WebhookPath.TrimStart('/'))"
$sutWebhookUrl = "$base/$($SutWebhookPath.TrimStart('/'))"

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  [Console]::Error.WriteLine("ERROR: N8N_API_KEY is required (pass -ApiKey or set the environment variable) to activate the RAG assistant sibling.")
  exit 2
}

if ([string]::IsNullOrWhiteSpace($GoldenFile)) {
  $GoldenFile = Join-Path $repoRoot "fixtures\golden\connected-rag.json"
}
if (-not (Test-Path -LiteralPath $GoldenFile -PathType Leaf)) {
  [Console]::Error.WriteLine("ERROR: connected-rag golden file not found: $GoldenFile")
  exit 2
}

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host ("=" * 78)
  Write-Host $Title
  Write-Host ("=" * 78)
}

$apiHeaders = @{ "X-N8N-API-KEY" = $ApiKey; "Accept" = "application/json"; "Content-Type" = "application/json" }

# --- 1. Ensure the live eval-harness is deployed (v0.6.0 sutExtract path active) ---------------
if (-not $SkipSync) {
  Write-Section "Step 1/5: Sync SDK -> live eval-harness (deploy configurable sutExtract path, keep active)"
  & (Join-Path $repoRoot "scripts\Sync-N8nWorkflowFromSdk.ps1")
  if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine("ERROR: sync failed; cannot exercise the connected-rag eval.")
    exit 1
  }
}

# --- 2. Activate the RAG assistant sibling (its webhook must be callable) -----------------------
Write-Section "Step 2/5: Activate RAG assistant sibling ($RagAssistantId) so its webhook is live"
try {
  $activate = Invoke-WebRequest -Uri "$base/api/v1/workflows/$RagAssistantId/activate" -Method Post -Headers $apiHeaders -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck
} catch {
  [Console]::Error.WriteLine("ERROR: RAG assistant activation request failed: $($_.Exception.Message)")
  exit 1
}
if ([int]$activate.StatusCode -lt 200 -or [int]$activate.StatusCode -ge 300) {
  [Console]::Error.WriteLine("ERROR: RAG assistant activation returned HTTP $($activate.StatusCode): $($activate.Content)")
  exit 1
}
$activated = $activate.Content | ConvertFrom-Json -Depth 100
$ragActive = if ($activated.PSObject.Properties["active"]) { [bool]$activated.active } else { $true }
Write-Host ("RAG assistant active: {0}" -f $ragActive)

$goldenDoc = Get-Content -LiteralPath $GoldenFile -Raw | ConvertFrom-Json -Depth 100
$cases = @($goldenDoc.golden)
if ($cases.Count -eq 0) {
  [Console]::Error.WriteLine("ERROR: connected-rag golden slice has no cases.")
  exit 2
}

# Helper: call the RAG assistant directly with a case's query object and return the bare response.
function Invoke-RagAssistant {
  param([object]$QueryBody)
  $json = $QueryBody | ConvertTo-Json -Depth 20
  $resp = Invoke-WebRequest -Uri $sutWebhookUrl -Method Post -ContentType "application/json" -Body $json -UseBasicParsing -TimeoutSec 60 -SkipHttpErrorCheck
  if ([int]$resp.StatusCode -ne 200) { return $null }
  return $resp.Content | ConvertFrom-Json -Depth 100
}

# Helper: read the top-level 'abstained' flag from a RAG response (tolerate a { response: {...} } wrapper).
function Get-Abstained {
  param([object]$RagResp)
  if ($null -eq $RagResp) { return $null }
  $r = if ($RagResp.PSObject.Properties["response"] -and $null -ne $RagResp.response) { $RagResp.response } else { $RagResp }
  if ($r.PSObject.Properties["abstained"]) { return [bool]$r.abstained }
  return $null
}

# --- 3. Raw RAG assistant response for ONE case (evidence) -------------------------------------
Write-Section "Step 3/5: Raw RAG assistant response for one case (direct black-box call)"
$sampleCase = $cases[0]
Write-Host ("Case: {0}   (expected abstained: {1})" -f $sampleCase.id, $sampleCase.expected)
Write-Host ("SUT webhook: {0}" -f $sutWebhookUrl)
try {
  $sampleJson = $sampleCase.input | ConvertTo-Json -Depth 20
  $sampleResp = Invoke-WebRequest -Uri $sutWebhookUrl -Method Post -ContentType "application/json" -Body $sampleJson -UseBasicParsing -TimeoutSec 60 -SkipHttpErrorCheck
  Write-Host ("HTTP status: {0}" -f [int]$sampleResp.StatusCode)
  Write-Host "Raw RAG assistant response (verbatim):"
  Write-Host $sampleResp.Content
} catch {
  Write-Host ("WARN: direct RAG assistant call failed ({0}); the harness may still reach it container-internally." -f $_.Exception.Message)
}

# --- 4. POST the connected-rag slice to the eval-harness webhook (harness grades B live) -------
Write-Section "Step 4/5: POST connected-rag slice to eval-harness webhook (sutMode:workflow, sutExtract:abstained)"
Write-Host ("Webhook: {0}" -f $webhookUrl)
$body = Get-Content -LiteralPath $GoldenFile -Raw
try {
  $resp = Invoke-WebRequest -Uri $webhookUrl -Method Post -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 300 -SkipHttpErrorCheck
} catch {
  [Console]::Error.WriteLine("ERROR: eval-harness webhook call failed: $($_.Exception.Message)")
  exit 1
}
$status = [int]$resp.StatusCode
Write-Host ("HTTP status: {0}" -f $status)
if ($status -ne 200) {
  [Console]::Error.WriteLine("ERROR: expected HTTP 200 from connected-rag eval run, got $status. Body: $($resp.Content)")
  exit 1
}
$result = $resp.Content | ConvertFrom-Json -Depth 100

if ([string]$result.sutMode -ne "workflow") {
  [Console]::Error.WriteLine("ERROR: expected sutMode 'workflow' in response, got '$($result.sutMode)'. The gate did not route to the live sibling.")
  exit 1
}

# Per-case pass/fail from the harness response (the authoritative verdict), keyed by caseId.
$harnessById = @{}
foreach ($r in @($result.results)) { $harnessById[[string]$r.caseId] = $r }

# --- 5. Per-case abstained(actual) vs expected + pass-rate (asserted 1.0) ----------------------
Write-Section "Step 5/5: Per-case abstained (actual from RAG assistant) vs expected (HONEST)"
Write-Host ("sutMode (run): {0}   judgeSource: {1}   judgeTrust: {2}" -f $result.sutMode, $result.judgeSource, $result.judgeTrust)
Write-Host ("passRate: {0}   passed: {1}   ({2}/{3} cases)" -f $result.passRate, $result.passed, $result.passedCount, $result.total)
Write-Host ""
Write-Host ("{0,-22} {1,-12} {2,-14} {3,-9} {4}" -f "caseId", "expected", "actual(abst.)", "match", "harnessPassed")
Write-Host ("-" * 78)

$liveMatch = 0
$liveTotal = 0
foreach ($c in $cases) {
  $cid = [string]$c.id
  $expected = [string]$c.expected
  # Re-call the RAG assistant directly to capture the ACTUAL abstained flag it returns for this case
  # (the same black-box call the harness makes). This is the honest "what did the deployed sibling do".
  $actualAbstained = "(unreachable)"
  $rag = $null
  try { $rag = Invoke-RagAssistant -QueryBody $c.input } catch { $rag = $null }
  if ($null -ne $rag) {
    $ab = Get-Abstained -RagResp $rag
    if ($null -ne $ab) { $actualAbstained = ([string]$ab).ToLowerInvariant() }
  }
  $match = ($actualAbstained -eq $expected)
  if ($actualAbstained -ne "(unreachable)") { $liveTotal += 1; if ($match) { $liveMatch += 1 } }
  $harnessPassed = if ($harnessById.ContainsKey($cid)) { [string]$harnessById[$cid].passed } else { "(n/a)" }
  Write-Host ("{0,-22} {1,-12} {2,-14} {3,-9} {4}" -f $cid, $expected, $actualAbstained, $match, $harnessPassed)
}

Write-Host ""
Write-Host ("Harness pass-rate (deterministic abstained exact-match): {0}   ({1}/{2})" -f $result.passRate, $result.passedCount, $result.total)
if ($liveTotal -gt 0) {
  $liveRate = [math]::Round($liveMatch / $liveTotal, 3)
  Write-Host ("Direct RAG assistant abstained-match rate              : {0}   ({1}/{2})" -f $liveRate, $liveMatch, $liveTotal)
}
Write-Host ""

# Unlike verify:connected (which tolerates a real low pass-rate against a possibly-live classifier),
# the RAG assistant's DEFAULT path is the deterministic stub (answers in-corpus, abstains out-of-corpus),
# so A grading B's abstention MUST be 1.0. A lower number means the configurable sutExtract extraction
# regressed (wrong field, bad coercion, or the gate not routing) — which is exactly what this driver guards.
if ([double]$result.passRate -ge 1) {
  Write-Host "PASS: the eval harness graded the RAG assistant's abstention correctly on every case (passRate 1.0),"
  Write-Host "      proving the configurable sutExtract dot-path lets A grade a second, differently-shaped SUT."
  Write-Host ""
  Write-Host "verify:connected-rag complete (live RAG assistant graded as a black-box SUT via sutExtract:abstained)."
  exit 0
} else {
  [Console]::Error.WriteLine("ERROR: expected passRate 1.0 grading the RAG assistant's abstention, got $($result.passRate).")
  [Console]::Error.WriteLine("       The configurable sutExtract extraction (sutExtract:'abstained') did not grade B correctly.")
  exit 1
}
