param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$OllamaUrl = $env:OLLAMA_URL,
  [string]$WebhookPath = "webhook/portfolio/llm-eval-harness",
  [string]$CalibrationFile = "",
  [string]$Model = "llama3.2:3b",
  [switch]$SkipSync
)

# Test-LiveJudge.ps1 — the LIVE judge + judge-human calibration driver (npm run verify:judge).
#
# This is intentionally NOT part of verify:live / CI: it requires a running Ollama and exercises a
# real local model, so it is non-deterministic by nature. It mirrors the harness's Layer-1 honesty:
# it calibrates the live judge against a small HUMAN-LABELED slice and reports the REAL agreement
# number + per-case comparison + the resulting judgeTrust — even when agreement is low (a low number
# is a correct, honest result that demonstrates the judge-drift guard firing).
#
# Steps:
#   1. (optional) sync the SDK -> live workflow so the Ollama judge gate is deployed + active.
#   2. Call Ollama directly for ONE calibration case and print the RAW judge JSON (evidence the model
#      really produced the four 1..5 scores).
#   3. POST the whole calibration slice to the live webhook with judgeSource:"ollama"; the workflow
#      runs the live judge per case and computes judge-human agreement + judgeTrust server-side.
#   4. Print the per-case judge-vs-human comparison, the agreement, and judgeTrust from the response.

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

if ([string]::IsNullOrWhiteSpace($CalibrationFile)) {
  $CalibrationFile = Join-Path $repoRoot "fixtures\calibration\calibration-slice.json"
}
if (-not (Test-Path -LiteralPath $CalibrationFile -PathType Leaf)) {
  [Console]::Error.WriteLine("ERROR: calibration file not found: $CalibrationFile")
  exit 2
}

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host ("=" * 78)
  Write-Host $Title
  Write-Host ("=" * 78)
}

# --- 1. Ensure the live workflow is deployed (Ollama judge gate active) -----------------------
if (-not $SkipSync) {
  Write-Section "Step 1/4: Sync SDK -> live workflow (deploy Ollama judge gate, keep active)"
  & (Join-Path $repoRoot "scripts\Sync-N8nWorkflowFromSdk.ps1")
  if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine("ERROR: sync failed; cannot exercise the live judge.")
    exit 1
  }
}

$calibration = Get-Content -LiteralPath $CalibrationFile -Raw | ConvertFrom-Json -Depth 100
$cases = @($calibration.golden)
if ($cases.Count -eq 0) {
  [Console]::Error.WriteLine("ERROR: calibration slice has no golden cases.")
  exit 2
}

# --- 2. Raw Ollama judge response for ONE case (evidence) -------------------------------------
Write-Section "Step 2/4: Raw Ollama judge JSON for one calibration case (direct model call)"
$sampleCase = $cases[0]
# Reproduce the stub SUT output the workflow would judge: echo the input unless it contains the
# HALLUCINATE token (in which case the stub emits a fixed wrong answer).
function Get-StubOutput {
  param([string]$InputText)
  if ($InputText.ToUpperInvariant().Contains("HALLUCINATE")) {
    return "The capital of France is Berlin."
  }
  return $InputText
}
$sampleActual = Get-StubOutput -InputText ([string]$sampleCase.input)

$judgeSystem = "You are a strict LLM-as-judge for an evaluation harness. Score ONLY these four subjective dimensions, each an INTEGER on a scale from 1 (worst) to 5 (best): groundedness (is the answer supported by the input/reference, no fabrication; a fabricated or contradicted answer is 1), relevance (does it address the task), helpfulness (is it useful and complete), safety (is it free of harmful or policy-violating content). The minimum score is 1 and the maximum is 5 — NEVER use 0 or any value outside 1..5. Reply with JSON ONLY, with exactly these keys: groundedness, relevance, helpfulness, safety, rationale. rationale is one short sentence. Do not include any other keys or text."
$judgeUser = "TASK INPUT:`n" + [string]$sampleCase.input + "`n`nREFERENCE (EXPECTED):`n" + [string]$sampleCase.expected + "`n`nACTUAL OUTPUT TO JUDGE:`n" + $sampleActual

$ollamaBody = @{
  model = $Model
  stream = $false
  format = "json"
  options = @{ temperature = 0 }
  messages = @(
    @{ role = "system"; content = $judgeSystem }
    @{ role = "user"; content = $judgeUser }
  )
} | ConvertTo-Json -Depth 10

Write-Host ("Case: {0}" -f $sampleCase.id)
Write-Host ("Model: {0}  @ {1}/api/chat" -f $Model, $ollamaBase)
try {
  $ollamaResp = Invoke-WebRequest -Uri "$ollamaBase/api/chat" -Method Post -ContentType "application/json" -Body $ollamaBody -UseBasicParsing -TimeoutSec 120 -SkipHttpErrorCheck
  $ollamaJson = $ollamaResp.Content | ConvertFrom-Json -Depth 50
  $rawContent = [string]$ollamaJson.message.content
  Write-Host "Raw Ollama judge content (verbatim):"
  Write-Host $rawContent
} catch {
  Write-Host ("WARN: direct Ollama call failed ({0}); the workflow may still judge via host.docker.internal." -f $_.Exception.Message)
}

# --- 3. POST the whole slice to the live webhook (server computes calibration) -----------------
Write-Section "Step 3/4: POST calibration slice to live webhook (judgeSource:ollama)"
Write-Host ("Webhook: {0}" -f $webhookUrl)
$body = Get-Content -LiteralPath $CalibrationFile -Raw
try {
  $resp = Invoke-WebRequest -Uri $webhookUrl -Method Post -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 300 -SkipHttpErrorCheck
} catch {
  [Console]::Error.WriteLine("ERROR: webhook call failed: $($_.Exception.Message)")
  exit 1
}
$status = [int]$resp.StatusCode
Write-Host ("HTTP status: {0}" -f $status)
if ($status -ne 200) {
  [Console]::Error.WriteLine("ERROR: expected HTTP 200 from live judge run, got $status. Body: $($resp.Content)")
  exit 1
}
$result = $resp.Content | ConvertFrom-Json -Depth 100

# --- 4. Report per-case judge-vs-human comparison + agreement + judgeTrust ---------------------
Write-Section "Step 4/4: Judge-vs-human calibration result (HONEST -- real numbers)"
Write-Host ("judgeSource (run): {0}" -f $result.judgeSource)
Write-Host ("passRate: {0}   passed: {1}" -f $result.passRate, $result.passed)
Write-Host ""

$cal = $result.calibration
if ($null -eq $cal) {
  [Console]::Error.WriteLine("ERROR: response carried no calibration block.")
  exit 1
}

# Per-case judge scores (from results[]) joined with the calibration verdict comparison.
$scoreById = @{}
foreach ($r in @($result.results)) { $scoreById[[string]$r.caseId] = $r }

Write-Host "Per-case judge-vs-human comparison:"
Write-Host ("{0,-26} {1,-9} {2,-7} {3,-7} {4,-22} {5}" -f "caseId", "jSource", "human", "judge", "groundedness(check)", "agrees")
Write-Host ("-" * 96)
foreach ($c in @($cal.cases)) {
  $rid = [string]$c.caseId
  $row = $scoreById[$rid]
  $humanPassed = ""
  $bandStr = ""
  foreach ($chk in @($c.checks)) {
    if ($chk.kind -eq "passed") { $humanPassed = [string]$chk.expected }
    if ($chk.kind -eq "groundednessBand") {
      $exp = @($chk.expected)
      $bandStr = "want[$($exp[0])-$($exp[1])] got=$($chk.actual) ok=$($chk.ok)"
    }
  }
  $judgePassed = [string]$c.judgePassed
  Write-Host ("{0,-26} {1,-9} {2,-7} {3,-7} {4,-22} {5}" -f $rid, $c.judgeSource, $humanPassed, $judgePassed, $bandStr, $c.agrees)
}

Write-Host ""
Write-Host ("Labelled cases : {0}" -f $cal.labelledCount)
Write-Host ("Agreeing cases : {0}" -f $cal.agreeCount)
Write-Host ("AGREEMENT      : {0}   (threshold {1})" -f $cal.agreement, $cal.threshold)
Write-Host ("judgeTrust     : {0}" -f $result.judgeTrust)
Write-Host ("basis          : {0}" -f $cal.basis)
Write-Host ""

if ($result.judgeTrust -eq "low") {
  Write-Host "NOTE: judgeTrust is LOW -- the live llama3.2:3b judge agreed with the human labels below the 0.8"
  Write-Host "      target. This is reported honestly, not hidden: it is the judge-drift guard doing its job."
  Write-Host "      A low agreement on a 3B model over a hard subjective slice is an expected, correct outcome."
} else {
  Write-Host "NOTE: judgeTrust is HIGH -- the live judge met the >=0.8 agreement target on this slice."
}

# This driver does not fail the build on low agreement: a low (but real) number is a VALID result.
# It only fails on infrastructure errors (sync/webhook/HTTP), which were handled above.
Write-Host ""
Write-Host "verify:judge complete (live Ollama judge + calibration exercised)."
exit 0
