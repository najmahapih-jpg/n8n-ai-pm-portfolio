param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$ApiKey = $env:N8N_API_KEY,
  [string]$WebhookPath = "webhook/portfolio/llm-eval-harness",
  [string]$SutWebhookPath = "webhook/portfolio/product-feedback-intelligence",
  [string]$GoldenFile = "",
  [string]$ProductFeedbackId = "6Gc3wmri0tJre07B",
  [switch]$SkipSync
)

# Test-ConnectedEval.ps1 — the LIVE connected-eval driver (npm run verify:connected).
#
# This is intentionally NOT part of verify:live / CI: it grades a SIBLING deployed workflow
# (product-feedback) as a black-box subject-under-test over its real HTTP endpoint, so it needs the
# live sibling active. It mirrors the harness's honesty: it POSTs a labelled golden slice with
# sutMode:"workflow", prints the REAL product-feedback theme for each case next to the expected theme,
# the pass-rate, and one VERBATIM raw product-feedback response (evidence the deployed system really
# classified). A pass-rate below 1.0 is reported honestly (it is a real result about the sibling's
# live behaviour, not a harness failure); the driver only fails on INFRASTRUCTURE errors.
#
# Steps:
#   1. (optional) sync the SDK -> live eval-harness so the sutMode:"workflow" gate is deployed + active.
#   2. Activate the product-feedback sibling so its webhook is callable.
#   3. Call product-feedback DIRECTLY for ONE case and print the RAW response (evidence).
#   4. POST the whole connected slice to the eval-harness webhook with sutMode:"workflow"; the harness
#      grades product-feedback live (extracts response.theme, exact-matches it against expected).
#   5. Print the per-case theme(actual from product-feedback) vs expected table + the pass-rate.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

if ([string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl = "http://localhost:5678" }
$base = $BaseUrl.TrimEnd("/")
$webhookUrl = "$base/$($WebhookPath.TrimStart('/'))"
$sutWebhookUrl = "$base/$($SutWebhookPath.TrimStart('/'))"

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  [Console]::Error.WriteLine("ERROR: N8N_API_KEY is required (pass -ApiKey or set the environment variable) to activate the product-feedback sibling.")
  exit 2
}

if ([string]::IsNullOrWhiteSpace($GoldenFile)) {
  $GoldenFile = Join-Path $repoRoot "fixtures\golden\connected-product-feedback.json"
}
if (-not (Test-Path -LiteralPath $GoldenFile -PathType Leaf)) {
  [Console]::Error.WriteLine("ERROR: connected golden file not found: $GoldenFile")
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

# --- 1. Ensure the live eval-harness is deployed (sutMode:"workflow" gate active) -------------
if (-not $SkipSync) {
  Write-Section "Step 1/5: Sync SDK -> live eval-harness (deploy sutMode:workflow gate, keep active)"
  & (Join-Path $repoRoot "scripts\Sync-N8nWorkflowFromSdk.ps1")
  if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine("ERROR: sync failed; cannot exercise the connected eval.")
    exit 1
  }
}

# --- 2. Activate the product-feedback sibling (its webhook must be callable) -------------------
Write-Section "Step 2/5: Activate product-feedback sibling ($ProductFeedbackId) so its webhook is live"
try {
  $activate = Invoke-WebRequest -Uri "$base/api/v1/workflows/$ProductFeedbackId/activate" -Method Post -Headers $apiHeaders -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck
} catch {
  [Console]::Error.WriteLine("ERROR: product-feedback activation request failed: $($_.Exception.Message)")
  exit 1
}
if ([int]$activate.StatusCode -lt 200 -or [int]$activate.StatusCode -ge 300) {
  [Console]::Error.WriteLine("ERROR: product-feedback activation returned HTTP $($activate.StatusCode): $($activate.Content)")
  exit 1
}
$activated = $activate.Content | ConvertFrom-Json -Depth 100
$pfActive = if ($activated.PSObject.Properties["active"]) { [bool]$activated.active } else { $true }
Write-Host ("product-feedback active: {0}" -f $pfActive)

$goldenDoc = Get-Content -LiteralPath $GoldenFile -Raw | ConvertFrom-Json -Depth 100
$cases = @($goldenDoc.golden)
if ($cases.Count -eq 0) {
  [Console]::Error.WriteLine("ERROR: connected golden slice has no cases.")
  exit 2
}

# Helper: call product-feedback directly with a case's feedback object and return the bare response.
function Invoke-ProductFeedback {
  param([object]$FeedbackBody)
  $json = $FeedbackBody | ConvertTo-Json -Depth 20
  $resp = Invoke-WebRequest -Uri $sutWebhookUrl -Method Post -ContentType "application/json" -Body $json -UseBasicParsing -TimeoutSec 60 -SkipHttpErrorCheck
  if ([int]$resp.StatusCode -ne 200) { return $null }
  return $resp.Content | ConvertFrom-Json -Depth 100
}

# --- 3. Raw product-feedback response for ONE case (evidence) ----------------------------------
Write-Section "Step 3/5: Raw product-feedback response for one case (direct black-box call)"
$sampleCase = $cases[0]
Write-Host ("Case: {0}   (expected theme: {1})" -f $sampleCase.id, $sampleCase.expected)
Write-Host ("SUT webhook: {0}" -f $sutWebhookUrl)
try {
  $sampleJson = $sampleCase.input | ConvertTo-Json -Depth 20
  $sampleResp = Invoke-WebRequest -Uri $sutWebhookUrl -Method Post -ContentType "application/json" -Body $sampleJson -UseBasicParsing -TimeoutSec 60 -SkipHttpErrorCheck
  Write-Host ("HTTP status: {0}" -f [int]$sampleResp.StatusCode)
  Write-Host "Raw product-feedback response (verbatim):"
  Write-Host $sampleResp.Content
} catch {
  Write-Host ("WARN: direct product-feedback call failed ({0}); the harness may still reach it container-internally." -f $_.Exception.Message)
}

# --- 4. POST the connected slice to the eval-harness webhook (harness grades live) -------------
Write-Section "Step 4/5: POST connected slice to eval-harness webhook (sutMode:workflow)"
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
  [Console]::Error.WriteLine("ERROR: expected HTTP 200 from connected eval run, got $status. Body: $($resp.Content)")
  exit 1
}
$result = $resp.Content | ConvertFrom-Json -Depth 100

if ([string]$result.sutMode -ne "workflow") {
  [Console]::Error.WriteLine("ERROR: expected sutMode 'workflow' in response, got '$($result.sutMode)'. The gate did not route to the live sibling.")
  exit 1
}

# Per-case pass/fail from the harness response (the authoritative verdict).
$harnessById = @{}
foreach ($r in @($result.results)) { $harnessById[[string]$r.caseId] = $r }

# --- 5. Per-case theme(actual) vs expected + pass-rate -----------------------------------------
Write-Section "Step 5/5: Per-case theme (actual from product-feedback) vs expected (HONEST)"
Write-Host ("sutMode (run): {0}   judgeSource: {1}   judgeTrust: {2}" -f $result.sutMode, $result.judgeSource, $result.judgeTrust)
Write-Host ("passRate: {0}   passed: {1}   ({2}/{3} cases)" -f $result.passRate, $result.passed, $result.passedCount, $result.total)
Write-Host ""
Write-Host ("{0,-28} {1,-16} {2,-16} {3,-9} {4,-14} {5}" -f "caseId", "expected", "actual(theme)", "match", "classifier", "harnessPassed")
Write-Host ("-" * 100)

$liveMatch = 0
$liveTotal = 0
foreach ($c in $cases) {
  $cid = [string]$c.id
  $expected = [string]$c.expected
  # Re-call product-feedback directly to capture the ACTUAL theme it returns for this case (the same
  # black-box call the harness makes). This is the honest "what did the deployed sibling classify".
  $actualTheme = "(unreachable)"
  $classifier = ""
  $pf = $null
  try { $pf = Invoke-ProductFeedback -FeedbackBody $c.input } catch { $pf = $null }
  if ($null -ne $pf) {
    $pfResp = if ($pf.PSObject.Properties["response"] -and $null -ne $pf.response) { $pf.response } else { $pf }
    if ($pfResp.PSObject.Properties["theme"]) { $actualTheme = [string]$pfResp.theme }
    if ($pfResp.PSObject.Properties["classifierSource"]) { $classifier = [string]$pfResp.classifierSource }
  }
  $match = ($actualTheme -eq $expected)
  if ($actualTheme -ne "(unreachable)") { $liveTotal += 1; if ($match) { $liveMatch += 1 } }
  $harnessPassed = if ($harnessById.ContainsKey($cid)) { [string]$harnessById[$cid].passed } else { "(n/a)" }
  Write-Host ("{0,-28} {1,-16} {2,-16} {3,-9} {4,-14} {5}" -f $cid, $expected, $actualTheme, $match, $classifier, $harnessPassed)
}

Write-Host ""
Write-Host ("Harness pass-rate (deterministic theme exact-match): {0}   ({1}/{2})" -f $result.passRate, $result.passedCount, $result.total)
if ($liveTotal -gt 0) {
  $liveRate = [math]::Round($liveMatch / $liveTotal, 3)
  Write-Host ("Direct product-feedback theme-match rate           : {0}   ({1}/{2})" -f $liveRate, $liveMatch, $liveTotal)
}
Write-Host ""

if ([double]$result.passRate -ge 1) {
  Write-Host "NOTE: product-feedback's LIVE classifications matched ALL expected themes on this slice."
} else {
  Write-Host "NOTE: product-feedback's live classifications did NOT match every expected theme. This is reported"
  Write-Host "      honestly: the pass-rate above is the REAL black-box result of grading the deployed sibling,"
  Write-Host "      not a harness failure. Any deviation is a genuine signal about the sibling's live behaviour."
}

# This driver does not fail the build on a low pass-rate: a low (but real) number is a VALID result.
# It only fails on infrastructure errors (sync/activation/webhook/HTTP), which were handled above.
Write-Host ""
Write-Host "verify:connected complete (live product-feedback graded as a black-box subject-under-test)."
exit 0
