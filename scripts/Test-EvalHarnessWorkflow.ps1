param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$WebhookPath = "webhook/portfolio/llm-eval-harness",
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

$expectedPolicyVersion = "eval-harness-v0.4.0"

# Each assertion records a PASS/FAIL line; any failure flips the suite to a non-zero exit.
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

function Assert-Condition {
  param(
    [string]$Case,
    [string]$Type,
    [string]$Label,
    [bool]$Condition,
    [string]$Detail = ""
  )
  Add-Assertion -Case $Case -Type $Type -Label $Label -Ok:$Condition -Detail $Detail
}

function Invoke-Webhook {
  param([string]$Body)
  return Invoke-WebRequest -Uri $webhookUrl -Method Post -ContentType "application/json" -Body $Body -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck
}

function Test-NoSecretLeak {
  param([string]$Raw)
  foreach ($pattern in $rawSecretPatterns) {
    if ($Raw -match $pattern) { return $pattern }
  }
  return $null
}

# --- Case table ----------------------------------------------------------------------------
# echo-pass / echo-fail are read from the golden fixtures; empty-golden is an inline negative.
$passFixture = Join-Path $GoldenDirectory "echo-pass.json"
$failFixture = Join-Path $GoldenDirectory "echo-fail.json"

$cases = @(
  @{ Name = "echo-pass"; Kind = "pass"; BodyFile = $passFixture }
  @{ Name = "echo-fail"; Kind = "fail"; BodyFile = $failFixture }
  @{ Name = "empty-golden"; Kind = "empty"; BodyLiteral = '{"runId":"empty-golden","golden":[]}' }
)

if ($CaseName.Count -gt 0) {
  $requested = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($n in $CaseName) { $requested.Add($n) | Out-Null }
  $cases = @($cases | Where-Object { $requested.Contains([string]$_.Name) })
  if ($cases.Count -eq 0) { [Console]::Error.WriteLine("ERROR: No matching cases for -CaseName."); exit 2 }
}

Write-Host "Behavioral suite against $webhookUrl"
Write-Host ""

foreach ($case in $cases) {
  $name = [string]$case.Name
  $kind = [string]$case.Kind

  if ($case.ContainsKey("BodyLiteral")) {
    $body = [string]$case.BodyLiteral
  } else {
    $bodyFile = [string]$case.BodyFile
    if (-not (Test-Path -LiteralPath $bodyFile -PathType Leaf)) {
      Assert-Condition -Case $name -Type "schema" -Label "fixture exists" -Condition $false -Detail "missing $bodyFile"
      continue
    }
    $body = Get-Content -LiteralPath $bodyFile -Raw
  }

  try {
    $response = Invoke-Webhook -Body $body
  } catch {
    Assert-Condition -Case $name -Type "schema" -Label "webhook reachable" -Condition $false -Detail $_.Exception.Message
    continue
  }

  $status = [int]$response.StatusCode
  $raw = [string]$response.Content

  if ($kind -eq "empty") {
    # absence: missing required golden case -> HTTP 400 + ok:false.
    Assert-Condition -Case $name -Type "absence" -Label "HTTP 400 on missing golden" -Condition ($status -eq 400) -Detail "status=$status"
    $parsedOk = $true
    $resp = $null
    try { $resp = $raw | ConvertFrom-Json -Depth 100 } catch { $parsedOk = $false }
    Assert-Condition -Case $name -Type "schema" -Label "response is JSON" -Condition $parsedOk
    if ($parsedOk) {
      $okVal = if ($resp.PSObject.Properties["ok"]) { [bool]$resp.ok } else { $true }
      Assert-Condition -Case $name -Type "absence" -Label "ok == false" -Condition ($okVal -eq $false) -Detail "ok=$okVal"
    }
    $leak = Test-NoSecretLeak -Raw $raw
    Assert-Condition -Case $name -Type "masking" -Label "no raw secret/PII in response" -Condition ($null -eq $leak) -Detail $leak
    continue
  }

  # pass / fail cases: HTTP 200 + scored response.
  Assert-Condition -Case $name -Type "schema" -Label "HTTP 200" -Condition ($status -eq 200) -Detail "status=$status"

  $parsedOk = $true
  $resp = $null
  try { $resp = $raw | ConvertFrom-Json -Depth 100 } catch { $parsedOk = $false }
  Assert-Condition -Case $name -Type "schema" -Label "response is JSON" -Condition $parsedOk
  if (-not $parsedOk) { continue }

  # schema: required keys present (v0.4.0 adds the multi-model bench surface perModel + bench).
  $requiredKeys = @("ok", "passRate", "passed", "results", "judgeTrust", "perRubricMean", "perModel", "bench", "policyVersion", "processedAt")
  $missingKeys = @($requiredKeys | Where-Object { -not $resp.PSObject.Properties[$_] })
  Assert-Condition -Case $name -Type "schema" -Label "required keys present" -Condition ($missingKeys.Count -eq 0) -Detail $(if ($missingKeys.Count -gt 0) { "missing: $($missingKeys -join ', ')" } else { "" })

  $okVal = if ($resp.PSObject.Properties["ok"]) { [bool]$resp.ok } else { $false }
  Assert-Condition -Case $name -Type "schema" -Label "ok == true" -Condition ($okVal -eq $true) -Detail "ok=$okVal"

  # range: passRate in [0,1].
  $passRate = if ($resp.PSObject.Properties["passRate"]) { [double]$resp.passRate } else { [double]::NaN }
  Assert-Condition -Case $name -Type "range" -Label "passRate within [0,1]" -Condition ($passRate -ge 0 -and $passRate -le 1) -Detail "passRate=$passRate"

  # range: per-rubric means in [1,5].
  $rubricOk = $true
  $rubricDetail = ""
  if ($resp.PSObject.Properties["perRubricMean"] -and $null -ne $resp.perRubricMean) {
    foreach ($prop in @($resp.perRubricMean.PSObject.Properties)) {
      $v = [double]$prop.Value
      if ($v -lt 1 -or $v -gt 5) { $rubricOk = $false; $rubricDetail = "$($prop.Name)=$v" }
    }
  } else {
    $rubricOk = $false; $rubricDetail = "perRubricMean missing"
  }
  Assert-Condition -Case $name -Type "range" -Label "perRubricMean within [1,5]" -Condition $rubricOk -Detail $rubricDetail

  # format: processedAt parseable as a date.
  $dateOk = $false
  if ($resp.PSObject.Properties["processedAt"]) {
    try { [datetimeoffset]::Parse([string]$resp.processedAt, [System.Globalization.CultureInfo]::InvariantCulture) | Out-Null; $dateOk = $true } catch { $dateOk = $false }
  }
  Assert-Condition -Case $name -Type "format" -Label "processedAt is a parseable date" -Condition $dateOk -Detail $(if ($resp.PSObject.Properties["processedAt"]) { [string]$resp.processedAt } else { "(missing)" })

  # shared invariants across both scored cases.
  $judgeTrust = if ($resp.PSObject.Properties["judgeTrust"]) { [string]$resp.judgeTrust } else { "" }
  Assert-Condition -Case $name -Type "schema" -Label 'judgeTrust == "high"' -Condition ($judgeTrust -eq "high") -Detail "judgeTrust=$judgeTrust"

  $policyVersion = if ($resp.PSObject.Properties["policyVersion"]) { [string]$resp.policyVersion } else { "" }
  Assert-Condition -Case $name -Type "schema" -Label "policyVersion == $expectedPolicyVersion" -Condition ($policyVersion -eq $expectedPolicyVersion) -Detail "policyVersion=$policyVersion"

  # schema: v0.4.0 aggregate.perModel exists and is non-empty (the degenerate single-model 'stub'
  # entry for the offline stub suite). Each entry carries the cost-quality-latency fields.
  $perModel = if ($resp.PSObject.Properties["perModel"]) { @($resp.perModel) } else { @() }
  Assert-Condition -Case $name -Type "schema" -Label "perModel present + non-empty" -Condition ($perModel.Count -ge 1) -Detail "perModel count=$($perModel.Count)"
  if ($perModel.Count -ge 1) {
    $firstModel = $perModel[0]
    $modelId = if ($firstModel.PSObject.Properties["modelId"]) { [string]$firstModel.modelId } else { "" }
    # The offline stub suite is the degenerate single-model case: modelId is the mode label 'stub'.
    Assert-Condition -Case $name -Type "schema" -Label "perModel[0].modelId == stub" -Condition ($modelId -eq "stub") -Detail "modelId=$modelId"
    $modelKeys = @("modelId", "total", "passRate", "perRubricMean", "meanLatencyMs", "totalTokens", "estCostUsd", "costBasis")
    $missingModelKeys = @($modelKeys | Where-Object { -not $firstModel.PSObject.Properties[$_] })
    Assert-Condition -Case $name -Type "schema" -Label "perModel[0] has cost/latency/quality keys" -Condition ($missingModelKeys.Count -eq 0) -Detail $(if ($missingModelKeys.Count -gt 0) { "missing: $($missingModelKeys -join ', ')" } else { "" })
    # honest cost: local stub lane is local-free, $0.
    $costBasis = if ($firstModel.PSObject.Properties["costBasis"]) { [string]$firstModel.costBasis } else { "" }
    Assert-Condition -Case $name -Type "schema" -Label "perModel[0].costBasis == local-free" -Condition ($costBasis -eq "local-free") -Detail "costBasis=$costBasis"
  }

  # masking: no raw secret/PII in the response body.
  $leak = Test-NoSecretLeak -Raw $raw
  Assert-Condition -Case $name -Type "masking" -Label "no raw secret/PII in response" -Condition ($null -eq $leak) -Detail $leak

  # first result row.
  $firstPassed = $null
  if ($resp.PSObject.Properties["results"] -and @($resp.results).Count -gt 0) {
    $firstRow = @($resp.results)[0]
    if ($firstRow.PSObject.Properties["passed"]) { $firstPassed = [bool]$firstRow.passed }
  }
  $passedVal = if ($resp.PSObject.Properties["passed"]) { [bool]$resp.passed } else { $null }

  if ($kind -eq "pass") {
    Assert-Condition -Case $name -Type "schema" -Label "passRate == 1" -Condition ($passRate -eq 1) -Detail "passRate=$passRate"
    Assert-Condition -Case $name -Type "schema" -Label "results[0].passed == true" -Condition ($firstPassed -eq $true) -Detail "results[0].passed=$firstPassed"
    Assert-Condition -Case $name -Type "schema" -Label "passed == true" -Condition ($passedVal -eq $true) -Detail "passed=$passedVal"
  } else {
    Assert-Condition -Case $name -Type "schema" -Label "passRate == 0" -Condition ($passRate -eq 0) -Detail "passRate=$passRate"
    Assert-Condition -Case $name -Type "schema" -Label "results[0].passed == false" -Condition ($firstPassed -eq $false) -Detail "results[0].passed=$firstPassed"
    Assert-Condition -Case $name -Type "schema" -Label "passed == false" -Condition ($passedVal -eq $false) -Detail "passed=$passedVal"
  }
}

Write-Host ""
$assertions | Format-Table -AutoSize | Out-String | Write-Host

$passCount = @($assertions | Where-Object { $_.Result -eq "PASS" }).Count
$failCount = @($assertions | Where-Object { $_.Result -eq "FAIL" }).Count

if ($anyFail) {
  [Console]::Error.WriteLine("ERROR: behavioral suite failed ($failCount failing / $($assertions.Count) assertions).")
  exit 1
}

Write-Host "Behavioral suite passed ($passCount assertions across $($cases.Count) cases)."
exit 0
