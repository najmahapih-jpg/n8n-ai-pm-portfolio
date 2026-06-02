param(
  [string]$RepoPath = "",
  [switch]$SelfTest,
  [switch]$Live,
  [string]$BaseUrl = $env:N8N_API_URL
)

# Test-Contract.ps1 — the portfolio's contract-conformance gate (see ../fixtures/requests/contract-test-runner.md).
# OFFLINE (default): parse a target repo's `## Machine-readable contract` block and assert it is well-formed,
#   its version + webhook path match the deployed workflow JSON, its fixtures use only declared request
#   fields, and its documented limits are labeled gateway-delegated. No running n8n required.
# -SelfTest: run the same offline assertions over synthetic good/bad contracts in fixtures/self/ and confirm
#   each negative flips exactly the assertion it targets (the gate cannot silently no-op).
# -Live: re-POST golden requests and assert the real response conforms, behind a connection-check SKIP gate.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$runnerRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

$results = New-Object System.Collections.Generic.List[object]
$anyFail = $false
function Add-Result {
  param([string]$Type, [string]$Label, [bool]$Ok, [string]$Detail)
  if (-not $Ok) { $script:anyFail = $true }
  $results.Add([pscustomobject]@{ Type = $Type; Label = $Label; Result = $(if ($Ok) { "PASS" } else { "FAIL" }); Detail = $Detail }) | Out-Null
  Write-Host ("[{0}] {1} :: {2}{3}" -f $(if ($Ok) { "PASS" } else { "FAIL" }), $Type, $Label, $(if ($Detail) { " -> $Detail" } else { "" }))
}

# ---- offline assertion primitives (pure: operate on a parsed contract + a target context) ---------------
# A "context" is @{ workflowText = <string>; requestKeySets = @(@{ name; keys = @(...) }) }.
function Test-ContractParse {
  param($Contract)
  $ok = ($null -ne $Contract) -and ($Contract.PSObject.Properties["contractVersion"]) -and ($Contract.PSObject.Properties["webhookPath"]) -and ($Contract.PSObject.Properties["request"]) -and ($Contract.PSObject.Properties["response"])
  return @{ name = "contract-parses"; type = "contract-parse"; ok = [bool]$ok; detail = $(if ($ok) { "block present + required keys" } else { "missing block or required keys (contractVersion/webhookPath/request/response)" }) }
}
function Test-VersionMatch {
  param($Contract, [string]$WorkflowText)
  if ($null -eq $Contract) { return @{ name = "version-matches"; type = "version-match"; ok = $false; detail = "no contract block" } }
  $v = [string]$Contract.contractVersion
  $ok = (-not [string]::IsNullOrWhiteSpace($v)) -and $WorkflowText.Contains($v)
  return @{ name = "version-matches"; type = "version-match"; ok = [bool]$ok; detail = "contractVersion '$v' present in deployed workflow JSON = $ok" }
}
function Test-WebhookMatch {
  param($Contract, [string]$WorkflowText)
  if ($null -eq $Contract) { return @{ name = "webhookPath-matches"; type = "version-match"; ok = $false; detail = "no contract block" } }
  $w = [string]$Contract.webhookPath
  # n8n stores the webhook node's `path` WITHOUT the runtime 'webhook/' prefix, so match either form
  # (the contract keeps the full caller-facing path so the live POST target is correct).
  $suffix = $w -replace '^webhook/', ''
  $ok = (-not [string]::IsNullOrWhiteSpace($w)) -and ($WorkflowText.Contains($w) -or $WorkflowText.Contains($suffix))
  return @{ name = "webhookPath-matches"; type = "version-match"; ok = [bool]$ok; detail = "webhookPath '$w' (or suffix '$suffix') present in deployed workflow JSON = $ok" }
}
function Test-FixtureFields {
  param($Contract, $RequestKeySets)
  if ($null -eq $Contract -or $null -eq $Contract.request) { return @{ name = "fixtures-use-declared-request-fields"; type = "shape-conform"; ok = $false; detail = "no contract block" } }
  $accepted = New-Object System.Collections.Generic.HashSet[string]
  if ($Contract.request.PSObject.Properties["accepted"]) { foreach ($k in @($Contract.request.accepted)) { [void]$accepted.Add([string]$k) } }
  $offenders = @()
  foreach ($set in @($RequestKeySets)) {
    foreach ($k in @($set.keys)) { if (-not $accepted.Contains([string]$k)) { $offenders += "$($set.name):$k" } }
  }
  $ok = ($offenders.Count -eq 0)
  return @{ name = "fixtures-use-declared-request-fields"; type = "shape-conform"; ok = [bool]$ok; detail = $(if ($ok) { "all fixture request keys are declared in request.accepted" } else { "undeclared: $($offenders -join ', ')" }) }
}
function Test-LimitsLabeled {
  param($Contract)
  if ($null -eq $Contract -or $null -eq $Contract.request) { return @{ name = "limits-are-labeled"; type = "shape-conform"; ok = $false; detail = "no contract block" } }
  $hasLimits = $false
  if ($Contract.request.PSObject.Properties["limits"] -and $null -ne $Contract.request.limits) {
    $hasLimits = (@($Contract.request.limits.PSObject.Properties).Count -gt 0)
  }
  $labeled = $Contract.request.PSObject.Properties["limitsEnforcedBy"] -and -not [string]::IsNullOrWhiteSpace([string]$Contract.request.limitsEnforcedBy)
  $ok = (-not $hasLimits) -or $labeled
  return @{ name = "limits-are-labeled"; type = "shape-conform"; ok = [bool]$ok; detail = $(if ($ok) { "limits absent or labeled '$([string]$Contract.request.limitsEnforcedBy)'" } else { "request.limits present but limitsEnforcedBy missing (silent enforced-claim)" }) }
}

$OfflineChecks = @(
  { param($c, $ctx) Test-ContractParse -Contract $c },
  { param($c, $ctx) Test-VersionMatch -Contract $c -WorkflowText $ctx.workflowText },
  { param($c, $ctx) Test-WebhookMatch -Contract $c -WorkflowText $ctx.workflowText },
  { param($c, $ctx) Test-FixtureFields -Contract $c -RequestKeySets $ctx.requestKeySets },
  { param($c, $ctx) Test-LimitsLabeled -Contract $c }
)

# ---- contract-block parsing -----------------------------------------------------------------------------
function Get-ContractBlock {
  param([string]$ContractMdPath)
  if (-not (Test-Path -LiteralPath $ContractMdPath -PathType Leaf)) { return $null }
  $md = [System.IO.File]::ReadAllText($ContractMdPath)
  $m = [regex]::Match($md, '(?ms)##\s*Machine-readable contract.*?```json\s*(.*?)```')
  if (-not $m.Success) { return $null }
  try { return ($m.Groups[1].Value | ConvertFrom-Json -Depth 100) } catch { return $null }
}

# ---- SELF-TEST mode -------------------------------------------------------------------------------------
if ($SelfTest) {
  Write-Host "contract-test-runner SELF-TEST (offline; synthetic good/bad contracts)"
  Write-Host ""
  $selfDir = Join-Path $runnerRoot "fixtures\self"
  $files = @(Get-ChildItem -LiteralPath $selfDir -Filter *.json -File -ErrorAction SilentlyContinue | Sort-Object Name)
  if ($files.Count -eq 0) { [Console]::Error.WriteLine("ERROR: no self-test fixtures in $selfDir"); exit 2 }
  foreach ($f in $files) {
    $spec = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json -Depth 100
    $ctx = @{
      workflowText   = [string]$spec.fakeWorkflowText
      requestKeySets = @($spec.fakeFixtures | ForEach-Object { @{ name = [string]$_.name; keys = @($_.keys) } })
    }
    $contract = if ($spec.PSObject.Properties["contract"]) { $spec.contract } else { $null }
    $expectFail = if ($spec.PSObject.Properties["expectFailAssertion"]) { [string]$spec.expectFailAssertion } else { "" }
    $expectOnly = if ($spec.PSObject.Properties["expectOnlyTarget"]) { [bool]$spec.expectOnlyTarget } else { $true }
    $failedNames = @()
    foreach ($chk in $OfflineChecks) { $r = & $chk $contract $ctx; if (-not $r.ok) { $failedNames += $r.name } }
    if ([string]::IsNullOrEmpty($expectFail)) {
      Add-Result -Type "self-test" -Label "$($f.BaseName): good contract -> ALL offline checks PASS" -Ok:($failedNames.Count -eq 0) -Detail $(if ($failedNames.Count) { "unexpected FAIL: $($failedNames -join ', ')" } else { "5/5 passed" })
    } else {
      $caught = ($failedNames -contains $expectFail)
      $onlyOk = if ($expectOnly) { ($failedNames.Count -eq 1 -and $caught) } else { $true }
      Add-Result -Type "self-test" -Label "$($f.BaseName): bad contract -> '$expectFail' caught$(if ($expectOnly) { ' (only it)' } else { '' })" -Ok:($caught -and $onlyOk) -Detail "failed: $($failedNames -join ', ')"
    }
  }
  Write-Host ""
  if ($anyFail) { [Console]::Error.WriteLine("ERROR: self-test failed."); exit 1 }
  Write-Host "Self-test passed ($($results.Count) checks): the offline assertions catch every targeted defect."
  exit 0
}

# ---- REPO mode ------------------------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($RepoPath)) { [Console]::Error.WriteLine("ERROR: pass -RepoPath <target repo> or -SelfTest."); exit 2 }
$repo = (Resolve-Path -LiteralPath $RepoPath).Path
$contract = Get-ContractBlock -ContractMdPath (Join-Path $repo "docs\workflow-contract.md")
Write-Host "contract-test-runner OFFLINE against $repo"
Write-Host ""

# Build the target context: deployed workflow text (canonical + releases only — NOT generated build noise),
# and the request key set of every declared fixture (request under .body when the contract says so).
$workflowText = ""
foreach ($sub in @("workflows\canonical", "workflows\releases")) {
  $dir = Join-Path $repo $sub
  if (Test-Path -LiteralPath $dir) {
    foreach ($wf in @(Get-ChildItem -LiteralPath $dir -Filter *.json -File)) { $workflowText += [System.IO.File]::ReadAllText($wf.FullName) }
  }
}
$requestKeySets = @()
$validFixtures = @(); $errorFixtures = @(); $requestPath = ""
if ($null -ne $contract -and $contract.PSObject.Properties["fixtures"]) {
  $fx = $contract.fixtures
  $fxDir = Join-Path $repo ([string]$fx.dir)
  $requestPath = if ($fx.PSObject.Properties["requestPath"]) { [string]$fx.requestPath } else { "" }
  $named = @()
  if ($fx.PSObject.Properties["valid"]) { foreach ($n in @($fx.valid)) { $named += @{ name = [string]$n; isError = $false } } }
  if ($fx.PSObject.Properties["errorCases"]) { foreach ($n in @($fx.errorCases)) { $named += @{ name = [string]$n; isError = $true } } }
  foreach ($entry in $named) {
    $fpath = Join-Path $fxDir $entry.name
    if (-not (Test-Path -LiteralPath $fpath -PathType Leaf)) { Add-Result -Type "shape-conform" -Label "fixture exists: $($entry.name)" -Ok:$false -Detail "not found at $fpath"; continue }
    $fj = Get-Content -LiteralPath $fpath -Raw | ConvertFrom-Json -Depth 100
    $reqObj = if ($requestPath -and $fj.PSObject.Properties[$requestPath]) { $fj.$requestPath } else { $fj }
    $keys = @($reqObj.PSObject.Properties | ForEach-Object { $_.Name })
    $requestKeySets += @{ name = $entry.name; keys = $keys }
    if ($entry.isError) { $errorFixtures += @{ name = $entry.name; body = $reqObj } } else { $validFixtures += @{ name = $entry.name; body = $reqObj } }
  }
}
$ctx = @{ workflowText = $workflowText; requestKeySets = $requestKeySets }

foreach ($chk in $OfflineChecks) { $r = & $chk $contract $ctx; Add-Result -Type $r.type -Label $r.name -Ok:$r.ok -Detail $r.detail }

# ---- LIVE mode (opt-in) ---------------------------------------------------------------------------------
if ($Live) {
  Write-Host ""
  Write-Host "== live conformance (opt-in) =="
  $connCheck = Join-Path $repo "scripts\Test-N8nConnection.ps1"
  $liveReady = $true
  if (Test-Path -LiteralPath $connCheck -PathType Leaf) {
    & $connCheck *> $null
    if ($LASTEXITCODE -ne 0) { $liveReady = $false }
  } elseif ([string]::IsNullOrWhiteSpace($env:N8N_API_KEY)) { $liveReady = $false }
  if (-not $liveReady) {
    Write-Host "SKIPPED: live conformance needs a running local n8n + keys (connection check failed). Offline checks above stand."
  } else {
    if ([string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl = "http://localhost:5678" }
    $url = "$($BaseUrl.TrimEnd('/'))/$([string]$contract.webhookPath)"
    $respRequired = @($contract.response.required)
    # Probe: an inactive / unregistered webhook returns 404 — that is "cannot verify live", NOT a contract
    # violation, so SKIP honestly (the P1.6 rule) instead of reporting false conformance FAILs.
    $probeStatus = -1
    if ($validFixtures.Count -gt 0) {
      try { $pr = Invoke-WebRequest -Uri $url -Method Post -ContentType "application/json" -Body ($validFixtures[0].body | ConvertTo-Json -Depth 20) -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck; $probeStatus = [int]$pr.StatusCode } catch {}
    }
    if ($probeStatus -eq 404) {
      Write-Host "SKIPPED: live conformance — target webhook $url returned HTTP 404 (the workflow is likely not active). Activate it to verify live; the offline checks above stand."
    } else {
      foreach ($v in $validFixtures) {
        $body = $v.body | ConvertTo-Json -Depth 20
        try { $resp = Invoke-WebRequest -Uri $url -Method Post -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck } catch { Add-Result -Type "shape-conform" -Label "live POST $($v.name)" -Ok:$false -Detail $_.Exception.Message; continue }
        $j = $null; try { $j = $resp.Content | ConvertFrom-Json -Depth 100 } catch {}
        $missing = @()
        if ($null -ne $j) { foreach ($rk in $respRequired) { if (-not $j.PSObject.Properties[[string]$rk]) { $missing += [string]$rk } } } else { $missing = $respRequired }
        Add-Result -Type "shape-conform" -Label "live response conforms ($($v.name))" -Ok:([int]$resp.StatusCode -eq 200 -and $missing.Count -eq 0) -Detail "HTTP $([int]$resp.StatusCode); missing: $($missing -join ', ')"
      }
      foreach ($e in $contract.errors) {
        $expStatus = [int]$e.status
        $caseBody = if ($errorFixtures.Count -gt 0) { $errorFixtures[0].body | ConvertTo-Json -Depth 20 } else { "{}" }
        try { $resp = Invoke-WebRequest -Uri $url -Method Post -ContentType "application/json" -Body $caseBody -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck } catch { Add-Result -Type "error-conform" -Label "error case '$([string]$e.when)'" -Ok:$false -Detail $_.Exception.Message; continue }
        Add-Result -Type "error-conform" -Label "error case '$([string]$e.when)' -> HTTP $expStatus" -Ok:([int]$resp.StatusCode -eq $expStatus) -Detail "got HTTP $([int]$resp.StatusCode)"
      }
    }
  }
}

Write-Host ""
$results | Format-Table -AutoSize | Out-String | Write-Host
$passCount = @($results | Where-Object { $_.Result -eq "PASS" }).Count
if ($anyFail) { [Console]::Error.WriteLine("ERROR: contract conformance failed."); exit 1 }
Write-Host "Contract conformance passed ($passCount checks)."
exit 0
