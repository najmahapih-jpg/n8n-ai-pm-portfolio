param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$ApiKey = $env:N8N_API_KEY,
  [string]$WebhookPath = "webhook/portfolio/scheduled-drift-monitor",
  [string]$EvalHarnessId = "IhmmthDFMKdDbgvp",
  [string]$RagAssistantId = "jZ5Xfml8jbKexYqf",
  [switch]$SkipSync
)

# Test-DriftLive.ps1 — the OPT-IN live driver (npm run verify:drift-live). NOT in CI.
#
# Proves D's LIVE path end-to-end against the real backends, mirroring the sibling live drivers:
#   - Monitor 2 (eval-gated quality): D POSTs a connected-eval slice to Project A's webhook; A grades B's
#     abstention as a black-box SUT and returns passRate. evalSource MUST be 'workflow' (the live call
#     fired) and, with a healthy deterministic B, passRate MUST be 1.0 -> no false quality regression.
#   - Monitor 1 (source freshness): D live-fetches the allowlisted URLs (fetchSource 'http'). Source
#     REACHABILITY depends on the n8n container's outbound network, so we assert the live fetch PATH ran
#     and every source resolved to a VALID status (unchanged|changed|stale|unreachable) — not that the
#     public URLs are up (a real unreachable IS valid drift output, reported honestly).
#   - Digest (Ollama): the llama3.2:3b prose path runs (summarySource 'ollama'|'ollama-fallback') and —
#     the headline invariant — DIGEST-INTEGRITY still holds: every number in the digest's METRICS line is
#     recomputed from the run record (the LLM supplies prose; the data supplies the checked facts).

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl = "http://localhost:5678" }
$base = $BaseUrl.TrimEnd("/")
$webhookUrl = "$base/$($WebhookPath.TrimStart('/'))"

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  [Console]::Error.WriteLine("ERROR: N8N_API_KEY is required (pass -ApiKey or set the env var) to activate the A/B siblings D calls.")
  exit 2
}
$apiHeaders = @{ "X-N8N-API-KEY" = $ApiKey; "Accept" = "application/json"; "Content-Type" = "application/json" }

$pass = 0; $fail = 0
function Check {
  param([string]$Label, [bool]$Ok, [string]$Detail)
  $status = if ($Ok) { "PASS" } else { "FAIL" }
  if ($Ok) { $script:pass += 1 } else { $script:fail += 1 }
  $line = "[{0}] {1}" -f $status, $Label
  if ($Detail) { $line += " -> $Detail" }
  Write-Host $line
}
function Activate {
  param([string]$Id, [string]$Name)
  if ([string]::IsNullOrWhiteSpace($Id)) { return }
  try {
    $r = Invoke-WebRequest -Uri "$base/api/v1/workflows/$Id/activate" -Method Post -Headers $apiHeaders -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck
    Write-Host ("  activate {0} ({1}): HTTP {2}" -f $Name, $Id, [int]$r.StatusCode)
  } catch { Write-Host ("  activate {0} ({1}) WARN: {2}" -f $Name, $Id, $_.Exception.Message) }
}

# --- 1. Deploy D (latest SDK) so the live branches are active --------------------------------
if (-not $SkipSync) {
  Write-Host "==> Sync SDK -> live D (deploy the v0.2.0 live path, keep active)"
  & (Join-Path $repoRoot "scripts\Sync-N8nWorkflowFromSdk.ps1")
  if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine("ERROR: sync failed."); exit 1 }
}

# --- 2. Activate the chain D -> A -> B --------------------------------------------------------
Write-Host "==> Activate the live chain D -> A (eval harness) -> B (rag assistant)"
Activate -Id $EvalHarnessId -Name "eval-harness (A)"
Activate -Id $RagAssistantId -Name "rag-assistant (B)"

# --- 3. POST a LIVE run to D ------------------------------------------------------------------
Write-Host ""
Write-Host "==> POST mode:live to D ($webhookUrl)"
$body = '{"mode":"live","runId":"verify-drift-live","asOf":"2026-05-31"}'
try {
  $resp = Invoke-WebRequest -Uri $webhookUrl -Method Post -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 240 -SkipHttpErrorCheck
} catch {
  Check -Label "D live run reachable" -Ok:$false -Detail $_.Exception.Message
  Write-Host ""; [Console]::Error.WriteLine("ERROR: live driver failed (D unreachable)."); exit 1
}
Check -Label "HTTP 200" -Ok:([int]$resp.StatusCode -eq 200) -Detail "status=$([int]$resp.StatusCode)"
$run = $null
try { $run = $resp.Content | ConvertFrom-Json -Depth 100 } catch {}
Check -Label "response is JSON" -Ok:($null -ne $run) -Detail ""
if ($null -eq $run) { Write-Host ""; [Console]::Error.WriteLine("ERROR: non-JSON live response."); exit 1 }

# --- 4. Assert the LIVE path -----------------------------------------------------------------
Write-Host ""
Write-Host "== Monitor 2 (eval-gated quality, live A call) =="
$evalSource = [string]$run.quality.evalSource
$passRate = [double]$run.quality.passRate
$regressed = [bool]$run.quality.regressed
Check -Label "quality.evalSource == workflow (live A call fired)" -Ok:($evalSource -eq "workflow") -Detail "evalSource=$evalSource"
Check -Label "quality.passRate within [0,1]" -Ok:($passRate -ge 0 -and $passRate -le 1) -Detail "passRate=$passRate"
Check -Label "no false quality regression on healthy B (passRate 1.0, regressed false)" -Ok:(($passRate -ge 1) -and (-not $regressed)) -Detail "passRate=$passRate regressed=$regressed"

Write-Host ""
Write-Host "== Monitor 1 (source freshness, live fetch) =="
$fetchSource = [string]$run.freshness.fetchSource
Check -Label "freshness.fetchSource == http (live fetch path ran)" -Ok:($fetchSource -eq "http") -Detail "fetchSource=$fetchSource"
$validStatuses = @("unchanged", "changed", "stale", "unreachable")
$allValid = $true
$statusSummary = @()
foreach ($s in @($run.freshness.sources)) {
  $st = [string]$s.status
  if ($validStatuses -notcontains $st) { $allValid = $false }
  $statusSummary += "$($s.sourceId)=$st"
}
Check -Label "every source resolved to a valid status (reachability is environment-dependent)" -Ok:$allValid -Detail ($statusSummary -join ", ")

Write-Host ""
Write-Host "== Digest (live Ollama prose) + DIGEST-INTEGRITY =="
$summarySource = [string]$run.digest.summarySource
Check -Label "digest.summarySource is an ollama path (ollama | ollama-fallback)" -Ok:($summarySource -like "ollama*") -Detail "summarySource=$summarySource"
$diPassed = [bool]$run.digestIntegrity.passed
Check -Label "workflow digestIntegrity.passed == true (integrity holds under a live LLM)" -Ok:$diPassed -Detail "passed=$diPassed"

# Independent re-derivation: parse the METRICS line out of the live digest and require it to match the record.
$md = [string]$run.digest.markdown
function Get-Metric { param([string]$M, [string]$K) $rx = '(?:^|\s)' + [regex]::Escape($K) + '=([^\s]+)'; if ($M -match $rx) { return $Matches[1] } return $null }
$q = $run.quality; $f = $run.freshness; $d = $run.drift
$pairs = @(
  @{ k = "passRate"; a = [string]$q.passRate }, @{ k = "passRateDelta"; a = [string]$q.passRateDelta },
  @{ k = "regressed"; a = [string]$q.regressed }, @{ k = "changed"; a = [string]$f.changed },
  @{ k = "stale"; a = [string]$f.stale }, @{ k = "unreachable"; a = [string]$f.unreachable }, @{ k = "driftAny"; a = [string]$d.any }
)
$mismatch = @()
foreach ($p in $pairs) { $parsed = Get-Metric -M $md -K $p.k; if ($null -eq $parsed -or $parsed.ToLower() -ne ([string]$p.a).ToLower()) { $mismatch += "$($p.k): digest='$parsed' record='$($p.a)'" } }
Check -Label "live digest METRICS recompute matches the run record" -Ok:($mismatch.Count -eq 0) -Detail $(if ($mismatch.Count) { $mismatch -join '; ' } else { "$($pairs.Count) metrics matched" })

Check -Label "run.passed == true" -Ok:([bool]$run.passed -eq $true) -Detail "passed=$($run.passed)"

Write-Host ""
Write-Host ("verify:drift-live: {0} pass / {1} fail" -f $pass, $fail)
if ($fail -gt 0) { [Console]::Error.WriteLine("ERROR: live drift driver failed ($fail check(s))."); exit 1 }
Write-Host "PASS: D's live path works end-to-end (live A-eval + live source-fetch + live Ollama digest), and"
Write-Host "      digest-integrity holds under a real LLM. (Source reachability is container-network dependent.)"
exit 0
