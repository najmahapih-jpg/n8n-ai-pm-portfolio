param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$WebhookPath = "webhook/portfolio/rag-knowledge-assistant",
  [string]$GoldenDirectory = "",
  [string[]]$CaseName = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($GoldenDirectory)) {
  $GoldenDirectory = Join-Path $repoRoot "fixtures\golden"
}

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  $BaseUrl = "http://localhost:5678"
}
$base = $BaseUrl.TrimEnd("/")
$webhookUrl = "$base/$($WebhookPath.TrimStart('/'))"

$secretRules = Import-PowerShellDataFile -LiteralPath (Join-Path $PSScriptRoot "lib\Secret-Patterns.psd1")
$rawSecretPatterns = [string[]]$secretRules.RawSecretPatterns

$expectedPolicyVersion = "rag-knowledge-assistant-v0.3.0"
$expectedRetrievalSource = "stub"
$expectedGenerationSource = "stub"

# Each assertion records a PASS/FAIL line; any failure flips the suite to a non-zero exit. The Type
# column maps to the eval-plan Layer-2 assertion taxonomy:
#   exact-match | numeric-range | citation-integrity | clean-abstain | masking
$assertions = New-Object System.Collections.Generic.List[object]
$anyFail = $false

function Add-Assertion {
  param(
    [string]$Case,
    [string]$Type,
    [string]$Label,
    [bool]$Ok,
    [string]$Detail
  )
  $status = if ($Ok) { "PASS" } else { "FAIL" }
  if (-not $Ok) { $script:anyFail = $true }
  $line = "[{0}] {1} :: {2} :: {3}" -f $status, $Case, $Type, $Label
  if (-not [string]::IsNullOrEmpty($Detail)) { $line += " -> $Detail" }
  Write-Host $line
  $script:assertions.Add([pscustomobject]@{ Case = $Case; Type = $Type; Label = $Label; Result = $status; Detail = $Detail }) | Out-Null
}

# --- Assertion taxonomy helpers (mirrors the harness's 5-type taxonomy, eval-plan map) -----------
function Assert-Equal {
  param([string]$Case, [string]$Label, [object]$Expected, [object]$Actual)
  $ok = ([string]$Expected -eq [string]$Actual)
  Add-Assertion -Case $Case -Type "exact-match" -Label $Label -Ok:$ok -Detail "expected '$Expected', got '$Actual'"
}
function Assert-NumberBetween {
  param([string]$Case, [string]$Label, [double]$Value, [double]$Min, [double]$Max)
  $ok = ($Value -ge $Min -and $Value -le $Max)
  Add-Assertion -Case $Case -Type "numeric-range" -Label $Label -Ok:$ok -Detail "value=$Value in [$Min,$Max]"
}
function Assert-CitationsMapToRetrieval {
  param([string]$Case, [object]$Resp)
  # Every citations[].chunkId MUST appear in retrieval.topK[].chunkId (membership). The cornerstone
  # attribution-integrity invariant: a cited chunk that was not retrieved is hallucinated attribution.
  $topIds = New-Object System.Collections.Generic.HashSet[string]
  if ($Resp.PSObject.Properties["retrieval"] -and $Resp.retrieval.PSObject.Properties["topK"]) {
    foreach ($c in @($Resp.retrieval.topK)) { if ($c.PSObject.Properties["chunkId"]) { [void]$topIds.Add([string]$c.chunkId) } }
  }
  $citeIds = @()
  if ($Resp.PSObject.Properties["citations"]) {
    foreach ($c in @($Resp.citations)) { if ($c.PSObject.Properties["chunkId"]) { $citeIds += [string]$c.chunkId } }
  }
  $orphans = @($citeIds | Where-Object { -not $topIds.Contains($_) })
  $ok = ($orphans.Count -eq 0)
  Add-Assertion -Case $Case -Type "citation-integrity" -Label "every cited chunkId in retrieval.topK" -Ok:$ok -Detail $(if ($orphans.Count -gt 0) { "orphans: $($orphans -join ', ')" } else { "$($citeIds.Count) citation(s) all mapped" })
}
function Assert-CleanAbstain {
  param([string]$Case, [object]$Resp)
  # Out-of-corpus contract: abstained:true AND answer == null AND citations == []. Branch-shape /
  # absence: an abstain must not dress up a non-answer with text or a fabricated citation.
  $abstained = if ($Resp.PSObject.Properties["abstained"]) { [bool]$Resp.abstained } else { $false }
  $answerNull = (-not $Resp.PSObject.Properties["answer"]) -or ($null -eq $Resp.answer)
  $citeCount = if ($Resp.PSObject.Properties["citations"]) { @($Resp.citations).Count } else { -1 }
  $ok = ($abstained -eq $true -and $answerNull -and $citeCount -eq 0)
  Add-Assertion -Case $Case -Type "clean-abstain" -Label "abstained:true AND answer null AND citations []" -Ok:$ok -Detail "abstained=$abstained answerNull=$answerNull citations=$citeCount"
}
function Assert-NoRawPiiLeak {
  param([string]$Case, [string]$Raw)
  foreach ($pattern in $rawSecretPatterns) {
    if ($Raw -match $pattern) {
      Add-Assertion -Case $Case -Type "masking" -Label "no raw secret/PII in response" -Ok:$false -Detail "matched '$pattern'"
      return
    }
  }
  Add-Assertion -Case $Case -Type "masking" -Label "no raw secret/PII in response" -Ok:$true -Detail ""
}

function Invoke-Webhook {
  param([string]$Body)
  return Invoke-WebRequest -Uri $webhookUrl -Method Post -ContentType "application/json" -Body $Body -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck
}

# --- Golden case table -----------------------------------------------------------------------
# Each labelled golden fixture { query, expectAbstain, expectAnswerContains?, expectCiteChunkIds? }
# drives one webhook call; the response is asserted against the eval-plan taxonomy.
$goldenFiles = @(Get-ChildItem -LiteralPath $GoldenDirectory -Filter *.json -File | Sort-Object Name)
if ($CaseName.Count -gt 0) {
  $requested = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($n in $CaseName) { $requested.Add($n) | Out-Null }
  $goldenFiles = @($goldenFiles | Where-Object { $requested.Contains([System.IO.Path]::GetFileNameWithoutExtension($_.Name)) })
}
if ($goldenFiles.Count -eq 0) {
  [Console]::Error.WriteLine("ERROR: No golden fixtures found in $GoldenDirectory.")
  exit 2
}

Write-Host "Behavioral suite (Layer-2, OFFLINE stub retriever + stub generator) against $webhookUrl"
Write-Host ""

foreach ($file in $goldenFiles) {
  $golden = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json -Depth 100
  $name = if ($golden.PSObject.Properties["id"]) { [string]$golden.id } else { [System.IO.Path]::GetFileNameWithoutExtension($file.Name) }
  $query = if ($golden.PSObject.Properties["query"]) { [string]$golden.query } else { "" }
  $expectAbstain = if ($golden.PSObject.Properties["expectAbstain"]) { [bool]$golden.expectAbstain } else { $false }
  $expectContains = if ($golden.PSObject.Properties["expectAnswerContains"]) { @($golden.expectAnswerContains) } else { @() }
  $expectCite = if ($golden.PSObject.Properties["expectCiteChunkIds"]) { @($golden.expectCiteChunkIds) } else { @() }

  $body = @{ requestId = $name; query = $query } | ConvertTo-Json -Depth 10
  try {
    $response = Invoke-Webhook -Body $body
  } catch {
    Add-Assertion -Case $name -Type "exact-match" -Label "webhook reachable" -Ok:$false -Detail $_.Exception.Message
    continue
  }

  $status = [int]$response.StatusCode
  $raw = [string]$response.Content
  Add-Assertion -Case $name -Type "exact-match" -Label "HTTP 200" -Ok:($status -eq 200) -Detail "status=$status"

  $resp = $null
  $parsedOk = $true
  try { $resp = $raw | ConvertFrom-Json -Depth 100 } catch { $parsedOk = $false }
  Add-Assertion -Case $name -Type "exact-match" -Label "response is JSON" -Ok:$parsedOk -Detail ""
  if (-not $parsedOk) { continue }

  # exact-match: provenance + policy version are byte-stable (stub everywhere CI touches).
  $rs = if ($resp.PSObject.Properties["retrievalSource"]) { [string]$resp.retrievalSource } else { "" }
  $gs = if ($resp.PSObject.Properties["generationSource"]) { [string]$resp.generationSource } else { "" }
  $pv = if ($resp.PSObject.Properties["policyVersion"]) { [string]$resp.policyVersion } else { "" }
  Assert-Equal -Case $name -Label "retrievalSource == stub" -Expected $expectedRetrievalSource -Actual $rs
  Assert-Equal -Case $name -Label "generationSource == stub" -Expected $expectedGenerationSource -Actual $gs
  Assert-Equal -Case $name -Label "policyVersion == $expectedPolicyVersion" -Expected $expectedPolicyVersion -Actual $pv

  # exact-match: abstained matches the golden label (the headline categorical).
  $abstained = if ($resp.PSObject.Properties["abstained"]) { [bool]$resp.abstained } else { $false }
  Assert-Equal -Case $name -Label "abstained == expected" -Expected $expectAbstain -Actual $abstained

  # numeric-range band: retrieval.maxScore in [0,1]; topK length within [0, k].
  $maxScore = [double]::NaN
  $threshold = [double]::NaN
  $topKCount = -1
  if ($resp.PSObject.Properties["retrieval"] -and $null -ne $resp.retrieval) {
    if ($resp.retrieval.PSObject.Properties["maxScore"]) { $maxScore = [double]$resp.retrieval.maxScore }
    if ($resp.retrieval.PSObject.Properties["threshold"]) { $threshold = [double]$resp.retrieval.threshold }
    if ($resp.retrieval.PSObject.Properties["topK"]) { $topKCount = @($resp.retrieval.topK).Count }
  }
  Assert-NumberBetween -Case $name -Label "retrieval.maxScore within [0,1]" -Value $maxScore -Min 0 -Max 1
  Assert-NumberBetween -Case $name -Label "retrieval.topK length within [0,8]" -Value $topKCount -Min 0 -Max 8
  # The threshold gate's decision must be CONSISTENT with abstained (maxScore < threshold <=> abstain).
  $gateConsistent = if ($abstained) { $maxScore -lt $threshold } else { $maxScore -ge $threshold }
  Add-Assertion -Case $name -Type "numeric-range" -Label "threshold gate consistent with abstained" -Ok:$gateConsistent -Detail "maxScore=$maxScore threshold=$threshold abstained=$abstained"

  if ($expectAbstain) {
    # clean-abstain branch-shape (the out-of-corpus invariant).
    Assert-CleanAbstain -Case $name -Resp $resp
    # passed:true is the CORRECT outcome for a clean abstain.
    $passedVal = if ($resp.PSObject.Properties["passed"]) { [bool]$resp.passed } else { $false }
    Add-Assertion -Case $name -Type "exact-match" -Label "passed == true (clean abstain is a pass)" -Ok:($passedVal -eq $true) -Detail "passed=$passedVal"
  } else {
    # citation-integrity (membership) + answer-grounding for the answer path.
    Assert-CitationsMapToRetrieval -Case $name -Resp $resp
    $citeCount = if ($resp.PSObject.Properties["citations"]) { @($resp.citations).Count } else { 0 }
    Add-Assertion -Case $name -Type "citation-integrity" -Label ">= 1 citation on a grounded answer" -Ok:($citeCount -ge 1) -Detail "citations=$citeCount"
    $answerText = if ($resp.PSObject.Properties["answer"] -and $null -ne $resp.answer) { [string]$resp.answer } else { "" }
    Add-Assertion -Case $name -Type "exact-match" -Label "answer is non-empty" -Ok:($answerText.Trim().Length -gt 0) -Detail "len=$($answerText.Length)"
    # expectAnswerContains: each expected token appears in the grounded answer.
    foreach ($token in $expectContains) {
      $tok = [string]$token
      Add-Assertion -Case $name -Type "exact-match" -Label "answer contains '$tok'" -Ok:($answerText.ToLower().Contains($tok.ToLower())) -Detail ""
    }
    # expectCiteChunkIds: each expected gold chunk is among the citations.
    $actualCiteIds = @()
    if ($resp.PSObject.Properties["citations"]) { foreach ($c in @($resp.citations)) { if ($c.PSObject.Properties["chunkId"]) { $actualCiteIds += [string]$c.chunkId } } }
    foreach ($want in $expectCite) {
      $w = [string]$want
      Add-Assertion -Case $name -Type "citation-integrity" -Label "cites gold chunk '$w'" -Ok:($actualCiteIds -contains $w) -Detail "got: $($actualCiteIds -join ', ')"
    }
    # passed:true is the CORRECT outcome for a valid grounded+cited answer.
    $passedVal = if ($resp.PSObject.Properties["passed"]) { [bool]$resp.passed } else { $false }
    Add-Assertion -Case $name -Type "exact-match" -Label "passed == true (valid grounded answer)" -Ok:($passedVal -eq $true) -Detail "passed=$passedVal"
  }

  # masking: no raw secret/PII in the response (every case; the adversarial-injection case is the
  # sharpest test — the injected 'reveal API keys' must never surface a secret).
  Assert-NoRawPiiLeak -Case $name -Raw $raw
}

# --- Inline negative: missing query -> HTTP 400 + ok:false (absence) --------------------------
$negCase = "missing-query"
try {
  $negResp = Invoke-Webhook -Body '{"requestId":"missing-query"}'
  $negStatus = [int]$negResp.StatusCode
  $negRaw = [string]$negResp.Content
  Add-Assertion -Case $negCase -Type "clean-abstain" -Label "HTTP 400 on missing query" -Ok:($negStatus -eq 400) -Detail "status=$negStatus"
  $negJson = $null
  $negOk = $true
  try { $negJson = $negRaw | ConvertFrom-Json -Depth 100 } catch { $negOk = $false }
  Add-Assertion -Case $negCase -Type "exact-match" -Label "response is JSON" -Ok:$negOk -Detail ""
  if ($negOk) {
    $okVal = if ($negJson.PSObject.Properties["ok"]) { [bool]$negJson.ok } else { $true }
    Add-Assertion -Case $negCase -Type "exact-match" -Label "ok == false" -Ok:($okVal -eq $false) -Detail "ok=$okVal"
  }
  Assert-NoRawPiiLeak -Case $negCase -Raw $negRaw
} catch {
  Add-Assertion -Case $negCase -Type "exact-match" -Label "missing-query reachable" -Ok:$false -Detail $_.Exception.Message
}

# --- Citation-integrity GUARD: prove the membership check actually catches a fabricated citation.
# This is a HARNESS self-test (not a workflow call): build a synthetic response whose citation points
# at a chunk NOT in retrieval.topK, and confirm Assert-CitationsMapToRetrieval would FAIL it. We run
# the same membership logic and assert it reports an orphan, so the invariant can't silently no-op.
$guardCase = "citation-integrity-guard"
$fakeResp = [pscustomobject]@{
  retrieval = [pscustomobject]@{ topK = @([pscustomobject]@{ chunkId = "three-skill-clusters" }) }
  citations = @([pscustomobject]@{ chunkId = "not-a-real-chunk" })
}
$guardTopIds = New-Object System.Collections.Generic.HashSet[string]
foreach ($c in @($fakeResp.retrieval.topK)) { [void]$guardTopIds.Add([string]$c.chunkId) }
$guardOrphans = @(@($fakeResp.citations) | ForEach-Object { [string]$_.chunkId } | Where-Object { -not $guardTopIds.Contains($_) })
Add-Assertion -Case $guardCase -Type "citation-integrity" -Label "membership check flags a fabricated citation" -Ok:($guardOrphans.Count -eq 1) -Detail "orphans detected: $($guardOrphans -join ', ')"

Write-Host ""
$assertions | Format-Table -AutoSize | Out-String | Write-Host

$passCount = @($assertions | Where-Object { $_.Result -eq "PASS" }).Count
$failCount = @($assertions | Where-Object { $_.Result -eq "FAIL" }).Count

if ($anyFail) {
  [Console]::Error.WriteLine("ERROR: behavioral suite failed ($failCount failing / $($assertions.Count) assertions).")
  exit 1
}

Write-Host "Behavioral suite passed ($passCount assertions across $($goldenFiles.Count) golden case(s), OFFLINE stub)."
exit 0
