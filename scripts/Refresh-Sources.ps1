<#
.SYNOPSIS
  The EVAL-GATED corpus-refresh loop for Project D (host-side; npm run refresh:sources).

.DESCRIPTION
  Closes the loop ADR-0001 describes: a source drifts -> re-embed -> re-run the eval -> did quality drift?
  This is the REVIEWED action the detect-only n8n workflow deliberately does NOT perform (the workflow
  never writes B's live KB; refresh-gating holds by construction). It runs HOST-SIDE because it needs
  what the n8n container lacks: outbound internet (to fetch the source URLs) plus Supabase write access
  (to re-embed). Steps:

    1. EVAL BEFORE  — POST a connected-eval slice to Project A's webhook; A grades B's abstention as a
                      black-box SUT (sutExtract:"abstained") and returns passRate (the quality baseline).
    2. DETECT       — fetch each allowlisted source URL (non-browser UA), SHA-256 fingerprint the body,
                      compare to fixtures/sources/manifest.json -> new | unchanged | changed | unreachable,
                      plus stale (retrievedAt age > -StaleAfterDays).
    3. RE-EMBED     — (only with -Apply, and only if any source is changed/new) delegate to B's
                      Ingest-Corpus.ps1, which re-embeds B's current .md corpus into Supabase (idempotent).
                      DEFAULT is report-only: detect + recommend, NO write to B's live KB.
    4. EVAL AFTER   — (only if a re-embed ran) POST the slice to A again -> passRateAfter. GATE:
                      passRateAfter >= passRateBefore - DriftThreshold. A refresh that LOWERS B's answer
                      quality fails loudly (exit 1) — the eval gate.
    5. PIN          — (with -Apply or -Pin) write the freshly-fetched fingerprints + retrievedAt back to
                      the manifest, so the next run does real cross-run change detection.

  SAFETY: the DEFAULT (no -Apply) writes NOTHING (no Supabase, no manifest) — it only fetches (read-only)
  and calls A's eval (read-only). -Apply mutates B's live Supabase via Ingest-Corpus.ps1 and re-pins the
  manifest. -Pin re-pins the manifest only (no Supabase write).

.NOTES
  Requires N8N_API_KEY (to activate A + B). Supabase/Ollama config is read by Ingest-Corpus.ps1 from B's
  .env. Not part of CI / any verify gate.
#>
param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$ApiKey = $env:N8N_API_KEY,
  [string]$ManifestPath = "",
  [string]$EvalWebhookPath = "webhook/portfolio/llm-eval-harness",
  [string]$SutWebhookUrl = "http://localhost:5678/webhook/portfolio/rag-knowledge-assistant",
  [string]$EvalHarnessId = "IhmmthDFMKdDbgvp",
  [string]$RagAssistantId = "jZ5Xfml8jbKexYqf",
  [string]$IngestScript = "",
  [int]$StaleAfterDays = 90,
  [double]$DriftThreshold = 0.05,
  [string]$AsOf = "",
  [string]$UserAgent = "n8n-drift-monitor",
  [switch]$Apply,
  [switch]$Pin
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl = "http://localhost:5678" }
$base = $BaseUrl.TrimEnd("/")
$evalUrl = "$base/$($EvalWebhookPath.TrimStart('/'))"
if ([string]::IsNullOrWhiteSpace($ManifestPath)) { $ManifestPath = Join-Path $repoRoot "fixtures\sources\manifest.json" }
if ([string]::IsNullOrWhiteSpace($IngestScript)) { $IngestScript = Join-Path $repoRoot "..\n8n-rag-knowledge-assistant\scripts\Ingest-Corpus.ps1" }
$asOfDate = if (-not [string]::IsNullOrWhiteSpace($AsOf)) { [datetime]::Parse($AsOf) } else { (Get-Date) }

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  [Console]::Error.WriteLine("ERROR: N8N_API_KEY is required (pass -ApiKey or set the env var) to activate A + B for the eval gate.")
  exit 2
}
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  [Console]::Error.WriteLine("ERROR: source manifest not found: $ManifestPath")
  exit 2
}

function Write-Section { param([string]$T) Write-Host ""; Write-Host ("=" * 78); Write-Host $T; Write-Host ("=" * 78) }
$apiHeaders = @{ "X-N8N-API-KEY" = $ApiKey; "Accept" = "application/json"; "Content-Type" = "application/json" }

function Get-Sha16 {
  param([string]$Text)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$Text)
    return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 16)
  } finally { $sha.Dispose() }
}

# A connected-eval slice with retrievalSource:"supabase", so A grades B's LIVE Supabase retrieval — the
# exact path the re-embed mutates. This makes the before/after gate MEANINGFUL: a corrupted re-embed
# (bad vectors, dropped chunks) lowers supabase retrieval quality -> passRate drops -> the gate fails.
# (A passes the input object verbatim as B's request body; B reads body.query + body.retrievalSource.)
function Invoke-EvalPassRate {
  $slice = [ordered]@{
    runId = "refresh-gate"
    sutMode = "workflow"
    sutExtract = "abstained"
    sutWebhookUrl = $SutWebhookUrl
    golden = @(
      [ordered]@{ id = "rag-in-corpus"; input = @{ query = "写好 eval 对 AI 产品经理有多重要?"; retrievalSource = "supabase" }; expected = "false"; assertions = @{ equals = "false"; maxLength = 8 } },
      [ordered]@{ id = "rag-out-of-corpus"; input = @{ query = "法国的首都是哪里?"; retrievalSource = "supabase" }; expected = "true"; assertions = @{ equals = "true"; maxLength = 8 } }
    )
  } | ConvertTo-Json -Depth 20
  $resp = Invoke-WebRequest -Uri $evalUrl -Method Post -ContentType "application/json" -Body $slice -UseBasicParsing -TimeoutSec 180 -SkipHttpErrorCheck
  if ([int]$resp.StatusCode -ne 200) { return $null }
  $j = $resp.Content | ConvertFrom-Json -Depth 100
  if ($j.PSObject.Properties["passRate"]) { return [double]$j.passRate }
  return $null
}

# --- Activate the eval chain A -> B ----------------------------------------------------------
Write-Section "Activate A (eval harness) + B (rag assistant) for the eval gate"
foreach ($pair in @(@{ id = $EvalHarnessId; n = "A" }, @{ id = $RagAssistantId; n = "B" })) {
  try {
    $r = Invoke-WebRequest -Uri "$base/api/v1/workflows/$($pair.id)/activate" -Method Post -Headers $apiHeaders -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck
    Write-Host ("  activate {0} ({1}): HTTP {2}" -f $pair.n, $pair.id, [int]$r.StatusCode)
  } catch { Write-Host ("  activate {0} WARN: {1}" -f $pair.n, $_.Exception.Message) }
}

# --- 1. EVAL BEFORE --------------------------------------------------------------------------
Write-Section "Step 1/5: EVAL BEFORE (A grades B's abstention -> passRate baseline)"
$passBefore = Invoke-EvalPassRate
if ($null -eq $passBefore) { [Console]::Error.WriteLine("ERROR: eval-before failed (A unreachable or non-200)."); exit 1 }
Write-Host ("passRate BEFORE: {0}" -f $passBefore)

# --- 2. DETECT source drift (host-side fetch + fingerprint) ----------------------------------
Write-Section "Step 2/5: DETECT source drift (fetch + SHA-256 fingerprint vs pinned manifest)"
$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json -Depth 100
if ($manifest.PSObject.Properties["staleAfterDays"] -and -not $PSBoundParameters.ContainsKey('StaleAfterDays')) { $StaleAfterDays = [int]$manifest.staleAfterDays }
Write-Host ("{0,-20} {1,-12} {2,8}  {3,-10} {4}" -f "sourceId", "status", "ageDays", "bytes", "url")
Write-Host ("-" * 96)
$results = New-Object System.Collections.Generic.List[object]
$changed = 0; $stale = 0; $unreachable = 0; $newCount = 0
foreach ($s in @($manifest.sources)) {
  $fingerprintNow = $null; $bytes = 0; $status = "unchanged"
  try {
    $r = Invoke-WebRequest -Uri $s.url -Method Get -Headers @{ "User-Agent" = $UserAgent; "Accept" = "text/html,application/xhtml+xml" } -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck
    if ([int]$r.StatusCode -ge 200 -and [int]$r.StatusCode -lt 400) {
      $bodyText = [string]$r.Content; $bytes = $bodyText.Length; $fingerprintNow = Get-Sha16 -Text $bodyText
    } else { $status = "unreachable" }
  } catch { $status = "unreachable" }

  $prev = [string]$s.fingerprint
  $ageDays = ""
  if (-not [string]::IsNullOrWhiteSpace([string]$s.retrievedAt)) { $ageDays = [int][math]::Floor(($asOfDate - [datetime]::Parse([string]$s.retrievedAt)).TotalDays) }
  if ($status -ne "unreachable") {
    if ([string]::IsNullOrWhiteSpace($prev)) { $status = "new" }
    elseif ($prev -ne $fingerprintNow) { $status = "changed" }
    elseif ($ageDays -ne "" -and [int]$ageDays -gt $StaleAfterDays) { $status = "stale" }
    else { $status = "unchanged" }
  }
  switch ($status) { "changed" { $changed++ } "stale" { $stale++ } "unreachable" { $unreachable++ } "new" { $newCount++ } }
  Write-Host ("{0,-20} {1,-12} {2,8}  {3,-10} {4}" -f $s.sourceId, $status, $ageDays, $bytes, $s.url)
  $results.Add([pscustomobject]@{ sourceId = $s.sourceId; status = $status; fingerprintNow = $fingerprintNow; retrievedAt = $s.retrievedAt }) | Out-Null
}
Write-Host ("-" * 96)
Write-Host ("sources: {0}   new: {1}   changed: {2}   stale: {3}   unreachable: {4}" -f @($manifest.sources).Count, $newCount, $changed, $stale, $unreachable)
$needsReembed = ($changed + $newCount) -gt 0

# --- 3. RE-EMBED (gated: -Apply only) --------------------------------------------------------
$reembedRan = $false
$passAfter = $null
Write-Section "Step 3/5: RE-EMBED (gated)"
if (-not $Apply) {
  Write-Host "report-only (default): NO Supabase write. Re-run with -Apply to re-embed the changed/new sources."
  Write-Host "  recommended re-embed: $([bool]$needsReembed) ($($changed) changed + $($newCount) new)"
} elseif (-not $needsReembed) {
  Write-Host "-Apply set, but no changed/new sources -> nothing to re-embed (live KB already fresh)."
} else {
  if (-not (Test-Path -LiteralPath $IngestScript -PathType Leaf)) {
    [Console]::Error.WriteLine("ERROR: -Apply requires B's Ingest-Corpus.ps1, not found at: $IngestScript")
    exit 2
  }
  Write-Host "==> Re-embedding B's corpus into Supabase via $IngestScript"
  & $IngestScript
  if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine("ERROR: Ingest-Corpus.ps1 failed with exit $LASTEXITCODE."); exit 1 }
  $reembedRan = $true

  # --- 4. EVAL AFTER + GATE ------------------------------------------------------------------
  Write-Section "Step 4/5: EVAL AFTER (re-run A) + DRIFT GATE"
  $passAfter = Invoke-EvalPassRate
  if ($null -eq $passAfter) { [Console]::Error.WriteLine("ERROR: eval-after failed (A unreachable or non-200)."); exit 1 }
  Write-Host ("passRate AFTER : {0}   (before {1}, delta {2})" -f $passAfter, $passBefore, ([math]::Round($passAfter - $passBefore, 4)))
  if ($passAfter -lt ($passBefore - $DriftThreshold)) {
    [Console]::Error.WriteLine("DRIFT GATE FAILED: the re-embed LOWERED answer quality ($passBefore -> $passAfter, beyond -$DriftThreshold). The refresh degraded B; investigate before trusting it.")
    exit 1
  }
  Write-Host "DRIFT GATE PASSED: the re-embed did not degrade B's answer quality."
}

# --- 5. PIN the freshly-fetched fingerprints (with -Apply or -Pin) ---------------------------
Write-Section "Step 5/5: PIN manifest"
if ($Apply -or $Pin) {
  $asOfStr = $asOfDate.ToString('yyyy-MM-dd')
  foreach ($s in @($manifest.sources)) {
    $res = $results | Where-Object { $_.sourceId -eq $s.sourceId } | Select-Object -First 1
    if ($null -ne $res -and $null -ne $res.fingerprintNow) { $s.fingerprint = $res.fingerprintNow; $s.retrievedAt = $asOfStr }
  }
  ($manifest | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath $ManifestPath -Encoding UTF8
  Write-Host "Pinned fetched fingerprints + retrievedAt=$asOfStr into $ManifestPath."
} else {
  Write-Host "manifest unchanged (pass -Pin to pin fetched fingerprints, or -Apply which also pins)."
}

# --- Digest ----------------------------------------------------------------------------------
Write-Section "Eval-gated refresh digest"
Write-Host ("changed={0} new={1} stale={2} unreachable={3} | reembedRan={4} | passRate {5}{6}" -f `
  $changed, $newCount, $stale, $unreachable, $reembedRan, $passBefore, $(if ($null -ne $passAfter) { " -> $passAfter" } else { " (eval-before only)" }))
Write-Host ""
Write-Host "refresh:sources complete."
exit 0
