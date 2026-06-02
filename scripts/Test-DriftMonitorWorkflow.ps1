param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$WebhookPath = "webhook/portfolio/scheduled-drift-monitor",
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

$expectedPolicyVersion = "scheduled-drift-monitor-v0.3.0"

# Each assertion records a PASS/FAIL line; any failure flips the suite to a non-zero exit. The Type
# column maps to the eval-plan Layer-2 taxonomy:
#   exact-match | numeric-range | drift-flag | drift-union | no-live-write | digest-integrity | masking
$assertions = New-Object System.Collections.Generic.List[object]
$anyFail = $false

function Add-Assertion {
  param([string]$Case, [string]$Type, [string]$Label, [bool]$Ok, [string]$Detail)
  $status = if ($Ok) { "PASS" } else { "FAIL" }
  if (-not $Ok) { $script:anyFail = $true }
  $line = "[{0}] {1} :: {2} :: {3}" -f $status, $Case, $Type, $Label
  if (-not [string]::IsNullOrEmpty($Detail)) { $line += " -> $Detail" }
  Write-Host $line
  $script:assertions.Add([pscustomobject]@{ Case = $Case; Type = $Type; Label = $Label; Result = $status; Detail = $Detail }) | Out-Null
}

function Assert-Equal {
  param([string]$Case, [string]$Label, [object]$Expected, [object]$Actual, [string]$Type = "exact-match")
  $ok = ([string]$Expected -eq [string]$Actual)
  Add-Assertion -Case $Case -Type $Type -Label $Label -Ok:$ok -Detail "expected '$Expected', got '$Actual'"
}
function Assert-NumberBetween {
  param([string]$Case, [string]$Label, [double]$Value, [double]$Min, [double]$Max)
  $ok = ($Value -ge $Min -and $Value -le $Max)
  Add-Assertion -Case $Case -Type "numeric-range" -Label $Label -Ok:$ok -Detail "value=$Value in [$Min,$Max]"
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

# Parse one `key=value` token out of the digest's machine-checkable METRICS line. (?:^|\s) anchors the
# key as a token start so 'passRate' never matches inside 'passRateDelta'.
function Get-Metric {
  param([string]$Md, [string]$Key)
  $rx = '(?:^|\s)' + [regex]::Escape($Key) + '=([^\s]+)'
  if ($Md -match $rx) { return $Matches[1] }
  return $null
}

# DIGEST-INTEGRITY: re-derive every quantitative claim from the digest markdown and require it to EQUAL
# the run record. This is the EXTERNAL check (we do not merely trust the workflow's self-reported
# digestIntegrity.passed) — sibling B's citation-integrity, transposed to a summary. Booleans compared
# case-insensitively (digest uses JS 'true'/'false'; the parsed record uses 'True'/'False').
function Assert-DigestMatchesRecord {
  param([string]$Case, [object]$Run)
  $md = if ($Run.PSObject.Properties["digest"] -and $Run.digest.PSObject.Properties["markdown"]) { [string]$Run.digest.markdown } else { "" }
  $q = $Run.quality; $f = $Run.freshness; $d = $Run.drift
  $pairs = @(
    @{ key = "passRate"; actual = [string]$q.passRate },
    @{ key = "passRateDelta"; actual = [string]$q.passRateDelta },
    @{ key = "regressed"; actual = [string]$q.regressed },
    @{ key = "changed"; actual = [string]$f.changed },
    @{ key = "stale"; actual = [string]$f.stale },
    @{ key = "unreachable"; actual = [string]$f.unreachable },
    @{ key = "driftAny"; actual = [string]$d.any }
  )
  $mismatches = @()
  foreach ($p in $pairs) {
    $parsed = Get-Metric -Md $md -Key $p.key
    if ($null -eq $parsed -or $parsed.ToLower() -ne ([string]$p.actual).ToLower()) {
      $mismatches += "$($p.key): digest='$parsed' record='$($p.actual)'"
    }
  }
  $ok = ($mismatches.Count -eq 0)
  Add-Assertion -Case $Case -Type "digest-integrity" -Label "every digest number matches the run record" -Ok:$ok -Detail $(if ($mismatches.Count) { $mismatches -join '; ' } else { "$($pairs.Count) metrics matched" })
}

function Invoke-Webhook {
  param([string]$Body)
  return Invoke-WebRequest -Uri $webhookUrl -Method Post -ContentType "application/json" -Body $Body -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck
}

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

Write-Host "Behavioral suite (Layer-2, OFFLINE stub collectors + stub digest) against $webhookUrl"
Write-Host ""

foreach ($file in $goldenFiles) {
  $golden = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json -Depth 100
  $name = if ($golden.PSObject.Properties["id"]) { [string]$golden.id } else { [System.IO.Path]::GetFileNameWithoutExtension($file.Name) }
  $request = if ($golden.PSObject.Properties["request"]) { $golden.request } else { [pscustomobject]@{} }
  $expect = if ($golden.PSObject.Properties["expect"]) { $golden.expect } else { [pscustomobject]@{} }

  $body = $request | ConvertTo-Json -Depth 20
  try {
    $response = Invoke-Webhook -Body $body
  } catch {
    Add-Assertion -Case $name -Type "exact-match" -Label "webhook reachable" -Ok:$false -Detail $_.Exception.Message
    continue
  }

  $status = [int]$response.StatusCode
  $raw = [string]$response.Content
  Add-Assertion -Case $name -Type "exact-match" -Label "HTTP 200" -Ok:($status -eq 200) -Detail "status=$status"

  $run = $null
  $parsedOk = $true
  try { $run = $raw | ConvertFrom-Json -Depth 100 } catch { $parsedOk = $false }
  Add-Assertion -Case $name -Type "exact-match" -Label "response is JSON" -Ok:$parsedOk -Detail ""
  if (-not $parsedOk) { continue }

  # exact-match: provenance + policy are byte-stable (stub everywhere CI touches).
  $mode = if ($run.PSObject.Properties["mode"]) { [string]$run.mode } else { "" }
  $reportOnly = if ($run.PSObject.Properties["reportOnly"]) { [bool]$run.reportOnly } else { $false }
  $evalSource = if ($run.PSObject.Properties["quality"] -and $run.quality.PSObject.Properties["evalSource"]) { [string]$run.quality.evalSource } else { "" }
  $summarySource = if ($run.PSObject.Properties["digest"] -and $run.digest.PSObject.Properties["summarySource"]) { [string]$run.digest.summarySource } else { "" }
  $pv = if ($run.PSObject.Properties["policyVersion"]) { [string]$run.policyVersion } else { "" }
  Assert-Equal -Case $name -Label "mode == stub" -Expected "stub" -Actual $mode
  Assert-Equal -Case $name -Label "quality.evalSource == stub" -Expected "stub" -Actual $evalSource
  $expectSummarySource = if ($expect.PSObject.Properties["summarySource"]) { [string]$expect.summarySource } else { "stub" }
  Assert-Equal -Case $name -Label "digest.summarySource == expected" -Expected $expectSummarySource -Actual $summarySource
  Assert-Equal -Case $name -Label "reportOnly == true (default)" -Expected $true -Actual $reportOnly
  Assert-Equal -Case $name -Label "policyVersion == $expectedPolicyVersion" -Expected $expectedPolicyVersion -Actual $pv

  # Pull the run-record drift fields.
  $regressed = if ($run.quality.PSObject.Properties["regressed"]) { [bool]$run.quality.regressed } else { $false }
  $passRateDelta = if ($run.quality.PSObject.Properties["passRateDelta"]) { [double]$run.quality.passRateDelta } else { [double]::NaN }
  $changed = if ($run.freshness.PSObject.Properties["changed"]) { [int]$run.freshness.changed } else { -1 }
  $stale = if ($run.freshness.PSObject.Properties["stale"]) { [int]$run.freshness.stale } else { -1 }
  $unreachable = if ($run.freshness.PSObject.Properties["unreachable"]) { [int]$run.freshness.unreachable } else { -1 }
  $reembedded = if ($run.freshness.PSObject.Properties["reembedded"]) { [int]$run.freshness.reembedded } else { -1 }
  $driftAny = if ($run.drift.PSObject.Properties["any"]) { [bool]$run.drift.any } else { $false }
  $passed = if ($run.PSObject.Properties["passed"]) { [bool]$run.passed } else { $false }

  # drift-flag correctness: every flag matches the golden expectation (missed-drift + false-alarm guards).
  Assert-Equal -Case $name -Type "drift-flag" -Label "quality.regressed == expected" -Expected ([bool]$expect.regressed) -Actual $regressed
  Assert-Equal -Case $name -Type "drift-flag" -Label "freshness.changed == expected" -Expected ([int]$expect.changed) -Actual $changed
  Assert-Equal -Case $name -Type "drift-flag" -Label "freshness.stale == expected" -Expected ([int]$expect.stale) -Actual $stale
  Assert-Equal -Case $name -Type "drift-flag" -Label "freshness.unreachable == expected" -Expected ([int]$expect.unreachable) -Actual $unreachable
  Assert-Equal -Case $name -Type "drift-flag" -Label "drift.any == expected" -Expected ([bool]$expect.driftAny) -Actual $driftAny

  # drift-union: drift.any MUST equal the union of (regressed OR changed>0 OR stale>0 OR unreachable>0).
  $unionExpected = ($regressed -or ($changed -gt 0) -or ($stale -gt 0) -or ($unreachable -gt 0))
  Assert-Equal -Case $name -Type "drift-union" -Label "drift.any == union(regressed, changed, stale, unreachable)" -Expected $unionExpected -Actual $driftAny

  # numeric-range: passRateDelta within [-1,1].
  Assert-NumberBetween -Case $name -Label "quality.passRateDelta within [-1,1]" -Value $passRateDelta -Min -1 -Max 1

  # no-live-write (refresh-gating): report-only/stub => reembedded == 0 (the workflow is detect-only).
  Assert-Equal -Case $name -Type "no-live-write" -Label "freshness.reembedded == 0 (report-only)" -Expected 0 -Actual $reembedded

  # digest-integrity: external re-derivation + the workflow's own verdict + the overall pass.
  Assert-DigestMatchesRecord -Case $name -Run $run
  $diPassed = if ($run.PSObject.Properties["digestIntegrity"] -and $run.digestIntegrity.PSObject.Properties["passed"]) { [bool]$run.digestIntegrity.passed } else { $false }
  $expectDi = if ($expect.PSObject.Properties["digestIntegrity"]) { [bool]$expect.digestIntegrity } else { $true }
  Add-Assertion -Case $name -Type "digest-integrity" -Label "workflow digestIntegrity.passed == expected" -Ok:($diPassed -eq $expectDi) -Detail "expected=$expectDi got=$diPassed"
  # When a scenario injects fabricated prose (expect.digestIntegrity=false), prove the PROSE check is what
  # caught it (not the METRICS line) — the load-bearing negative for the headline invariant.
  if (-not $expectDi) {
    $proseCheck = $null
    if ($run.PSObject.Properties["digestIntegrity"] -and $run.digestIntegrity.PSObject.Properties["checks"]) {
      $proseCheck = @($run.digestIntegrity.checks | Where-Object { $_.name -eq "prose-no-fabricated-rate" })[0]
    }
    $proseCaught = ($null -ne $proseCheck -and ($proseCheck.ok -eq $false))
    Add-Assertion -Case $name -Type "digest-integrity" -Label "prose-no-fabricated-rate CAUGHT the fabricated figure" -Ok:$proseCaught -Detail $(if ($proseCheck) { "fabricated='$($proseCheck.parsed)'" } else { "no prose check present" })
  }
  Assert-Equal -Case $name -Type "exact-match" -Label "run.passed == expected" -Expected ([bool]$expect.passed) -Actual $passed

  # masking: no raw secret/PII anywhere in the response.
  Assert-NoRawPiiLeak -Case $name -Raw $raw
}

# --- DIGEST-INTEGRITY GUARD (harness self-test, no workflow call) -----------------------------
# Prove the integrity check actually CATCHES a fabricated number: a digest claiming passRate=0.99 while
# the record says 0.5 must be detected as a mismatch, so the invariant can't silently no-op.
$guardCase = "digest-integrity-guard"
$tamperedMd = "METRICS passRate=0.99 passRateDelta=-0.01 regressed=false changed=0 stale=0 unreachable=0 driftAny=false"
$guardParsed = Get-Metric -Md $tamperedMd -Key "passRate"
$guardRecord = "0.5"
$guardDetects = ($null -ne $guardParsed -and $guardParsed -ne $guardRecord)
Add-Assertion -Case $guardCase -Type "digest-integrity" -Label "integrity check flags a tampered digest number" -Ok:$guardDetects -Detail "parsed='$guardParsed' record='$guardRecord'"

Write-Host ""
$assertions | Format-Table -AutoSize | Out-String | Write-Host

$passCount = @($assertions | Where-Object { $_.Result -eq "PASS" }).Count
$failCount = @($assertions | Where-Object { $_.Result -eq "FAIL" }).Count

if ($anyFail) {
  [Console]::Error.WriteLine("ERROR: behavioral suite failed ($failCount failing / $($assertions.Count) assertions).")
  exit 1
}

Write-Host "Behavioral suite passed ($passCount assertions across $($goldenFiles.Count) golden scenario(s), OFFLINE stub)."
exit 0
