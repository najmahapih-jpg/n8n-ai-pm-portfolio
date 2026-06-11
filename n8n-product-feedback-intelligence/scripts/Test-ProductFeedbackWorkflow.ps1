param(
  [string]$WorkflowId = "",
  [string]$PinDataDirectory = "",
  [string]$McpUrl = "http://localhost:5678/mcp-server/http",
  [string]$McpToken = $env:N8N_MCP_TOKEN,
  [string[]]$CaseName = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($PinDataDirectory)) {
  $PinDataDirectory = Join-Path $repoRoot "fixtures\pin-data"
}

$metaPath = Join-Path $repoRoot "workflows\sdk\product-feedback-intelligence.meta.json"
if ([string]::IsNullOrWhiteSpace($WorkflowId) -and (Test-Path -LiteralPath $metaPath -PathType Leaf)) {
  $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json -Depth 100
  if ($meta.PSObject.Properties["n8nWorkflowId"]) { $WorkflowId = [string]$meta.n8nWorkflowId }
}

if ([string]::IsNullOrWhiteSpace($McpToken)) {
  [Console]::Error.WriteLine("ERROR: N8N_MCP_TOKEN is required. Pass -McpToken or set the environment variable.")
  exit 2
}
if ([string]::IsNullOrWhiteSpace($WorkflowId)) {
  [Console]::Error.WriteLine("ERROR: WorkflowId is required. Run Sync-N8nWorkflowFromSdk.ps1 first so meta.json has n8nWorkflowId.")
  exit 2
}

function Invoke-N8nMcpTool {
  param([string]$Name, [hashtable]$Arguments)

  $headers = @{
    Authorization = "Bearer $McpToken"
    "Content-Type" = "application/json"
    Accept = "application/json, text/event-stream"
  }
  $body = @{
    jsonrpc = "2.0"
    id = Get-Random
    method = "tools/call"
    params = @{ name = $Name; arguments = $Arguments }
  } | ConvertTo-Json -Depth 100

  $response = Invoke-WebRequest -Uri $McpUrl -Method Post -Headers $headers -Body $body -UseBasicParsing -TimeoutSec 120
  $line = ($response.Content -split "`n" | Where-Object { $_ -like "data: *" } | Select-Object -Last 1)
  if (-not $line) { throw "MCP response did not contain an SSE data line." }

  $json = $line.Substring(6) | ConvertFrom-Json -Depth 100
  if ($json.PSObject.Properties["result"] -and $json.result.PSObject.Properties["isError"] -and $json.result.isError) {
    throw (($json.result.content | ConvertTo-Json -Depth 20))
  }
  if ($json.PSObject.Properties["error"] -and $json.error) {
    throw ($json.error | ConvertTo-Json -Depth 20)
  }
  return $json.result.structuredContent
}

function Assert-Equal {
  param([object]$Actual, [object]$Expected, [string]$Label)
  if (($Actual -is [bool]) -or ($Expected -is [bool])) {
    if ([bool]$Actual -ne [bool]$Expected) { throw "$Label expected '$Expected' but got '$Actual'" }
    return
  }
  if ([string]$Actual -ne [string]$Expected) { throw "$Label expected '$Expected' but got '$Actual'" }
}

function Assert-NumberBetween {
  param([object]$Actual, [double]$Min, [double]$Max, [string]$Label)
  $n = [double]$Actual
  if ($n -lt $Min -or $n -gt $Max) { throw "$Label expected within [$Min,$Max] but got '$Actual'" }
}

function Assert-ParseableDate {
  param([object]$Value, [string]$Label)
  try {
    [datetimeoffset]::Parse([string]$Value, [System.Globalization.CultureInfo]::InvariantCulture) | Out-Null
  } catch {
    throw "$Label expected a parseable date but got '$Value'"
  }
}

function Assert-NoRawPiiLeak {
  param([object]$NodeJson, [object]$Fixture, [string]$CaseName)

  if (-not $NodeJson.PSObject.Properties["auditEvent"] -or $null -eq $NodeJson.auditEvent) {
    throw "$CaseName expected an auditEvent on the response node"
  }
  $audit = $NodeJson.auditEvent
  if (-not ([string]$audit.redactedEmail).Contains("***") -and -not [string]::IsNullOrEmpty([string]$audit.redactedEmail)) {
    throw "$CaseName redactedEmail present but not masked"
  }
  $fullText = $NodeJson | ConvertTo-Json -Depth 30 -Compress
  $rawText = [string]$Fixture.feedbackText

  $emailMatch = [regex]::Match($rawText, '[^\s@]+@[^\s@]+\.[^\s@]+')
  if ($emailMatch.Success) {
    if ($fullText.Contains($emailMatch.Value)) { throw "$CaseName leaked the raw email address" }
    if (-not ([string]$audit.redactedEmail).Contains("***")) { throw "$CaseName audit redactedEmail did not contain a mask" }
  }
  if ($rawText.Length -gt 70) {
    $probe = $rawText.Substring(60, [Math]::Min(40, $rawText.Length - 60))
    if ($fullText.Contains($probe)) { throw "$CaseName leaked raw feedback text beyond the safe excerpt" }
  }
}

$cases = @(
  @{ Name = "bug-negative"; File = "feedback-bug-negative.json"; Node = "Build Classified Response";
     Expected = @{ StatusCode = 200; Ok = $true; Theme = "bug"; Sentiment = "negative"; Urgency = "high"; Status = "classified"; NeedsHumanReview = $false; ClassifierSource = "stub"; PriorityScore = 24 } },
  @{ Name = "feature-request"; File = "feedback-feature-request.json"; Node = "Build Classified Response";
     Expected = @{ StatusCode = 200; Ok = $true; Theme = "feature_request"; Sentiment = "neutral"; Urgency = "normal"; Status = "classified"; NeedsHumanReview = $false; ClassifierSource = "stub"; PriorityScore = 27 } },
  @{ Name = "praise"; File = "feedback-praise.json"; Node = "Build Classified Response";
     Expected = @{ StatusCode = 200; Ok = $true; Theme = "praise"; Sentiment = "positive"; Urgency = "low"; Status = "classified"; NeedsHumanReview = $false; ClassifierSource = "stub"; PriorityScore = 1 } },
  @{ Name = "churn-risk"; File = "feedback-churn-risk.json"; Node = "Build Approval-Gated Response";
     Expected = @{ StatusCode = 200; Ok = $true; Theme = "churn_risk"; Sentiment = "negative"; Urgency = "critical"; Status = "awaiting_approval"; NeedsHumanReview = $true; ClassifierSource = "stub"; PriorityScore = 20 } },
  @{ Name = "performance"; File = "feedback-performance.json"; Node = "Build Classified Response";
     Expected = @{ StatusCode = 200; Ok = $true; Theme = "performance"; Sentiment = "negative"; Urgency = "high"; Status = "classified"; NeedsHumanReview = $false; ClassifierSource = "stub"; PriorityScore = 36 } },
  @{ Name = "pricing"; File = "feedback-pricing.json"; Node = "Build Classified Response";
     Expected = @{ StatusCode = 200; Ok = $true; Theme = "pricing"; Sentiment = "negative"; Urgency = "normal"; Status = "classified"; NeedsHumanReview = $false; ClassifierSource = "stub"; PriorityScore = 9 } },
  @{ Name = "usability"; File = "feedback-usability.json"; Node = "Build Classified Response";
     Expected = @{ StatusCode = 200; Ok = $true; Theme = "usability"; Sentiment = "negative"; Urgency = "normal"; Status = "classified"; NeedsHumanReview = $false; ClassifierSource = "stub"; PriorityScore = 15 } },
  @{ Name = "low-confidence-fallback"; File = "feedback-low-confidence-fallback.json"; Node = "Build Classified Response";
     Expected = @{ StatusCode = 200; Ok = $true; Theme = "other"; Sentiment = "neutral"; Urgency = "normal"; Status = "classified"; NeedsHumanReview = $false; ClassifierSource = "fallback"; PriorityScore = 3 } },
  @{ Name = "prompt-injection"; File = "feedback-prompt-injection.json"; Node = "Build Classified Response";
     Expected = @{ StatusCode = 200; Ok = $true; Theme = "other"; Sentiment = "neutral"; Urgency = "normal"; Status = "classified"; NeedsHumanReview = $false; ClassifierSource = "fallback"; PriorityScore = 3 } },
  @{ Name = "missing-text"; File = "feedback-missing-text.json"; Node = "Build Required Field Error";
     Expected = @{ StatusCode = 400; Ok = $false; Error = "Missing required feedback field"; MissingField = "feedbackText" } }
)

if ($CaseName.Count -gt 0) {
  $requested = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($n in $CaseName) { $requested.Add($n) | Out-Null }
  $cases = @($cases | Where-Object { $requested.Contains([string]$_.Name) })
  if ($cases.Count -eq 0) { [Console]::Error.WriteLine("ERROR: No matching cases for -CaseName."); exit 2 }
}

$results = New-Object System.Collections.Generic.List[object]
$anyFail = $false

foreach ($case in $cases) {
  $rec = [ordered]@{ Case = $case.Name; Result = "PASS"; Detail = "" }
  try {
    $fixturePath = Join-Path $PinDataDirectory $case.File
    if (-not (Test-Path -LiteralPath $fixturePath)) { throw "missing fixture $fixturePath" }
    $fixture = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json -Depth 100

    $pinData = @{ "Run Demo Feedback From n8n UI" = @(@{ json = $fixture }) }
    $test = Invoke-N8nMcpTool -Name "test_workflow" -Arguments @{ workflowId = $WorkflowId; pinData = $pinData }
    if ([string]$test.status -ne "success") { throw "execution status '$($test.status)'" }

    $exec = Invoke-N8nMcpTool -Name "get_execution" -Arguments @{
      workflowId = $WorkflowId
      executionId = [string]$test.executionId
      includeData = $true
      nodeNames = @($case.Node)
      truncateData = 1
    }
    $runProp = $exec.data.resultData.runData.PSObject.Properties[$case.Node]
    if (-not $runProp) { throw "did not execute expected node '$($case.Node)'" }
    $runs = @($runProp.Value)
    $nodeJson = $runs[$runs.Count - 1].data.main[0][0].json
    $resp = $nodeJson.response
    $exp = $case.Expected

    Assert-Equal -Actual $nodeJson.statusCode -Expected $exp.StatusCode -Label "$($case.Name) statusCode"
    Assert-Equal -Actual $resp.ok -Expected $exp.Ok -Label "$($case.Name) ok"

    if ($exp.ContainsKey("Theme")) {
      Assert-Equal -Actual $resp.theme -Expected $exp.Theme -Label "$($case.Name) theme"
      Assert-Equal -Actual $resp.sentiment -Expected $exp.Sentiment -Label "$($case.Name) sentiment"
      Assert-Equal -Actual $resp.urgency -Expected $exp.Urgency -Label "$($case.Name) urgency"
      Assert-Equal -Actual $resp.status -Expected $exp.Status -Label "$($case.Name) status"
      Assert-Equal -Actual $resp.needsHumanReview -Expected $exp.NeedsHumanReview -Label "$($case.Name) needsHumanReview"
      Assert-Equal -Actual $resp.classifierSource -Expected $exp.ClassifierSource -Label "$($case.Name) classifierSource"
      Assert-Equal -Actual $resp.policyVersion -Expected "feedback-intel-v0.1.0" -Label "$($case.Name) policyVersion"
      Assert-NumberBetween -Actual $resp.confidence -Min 0 -Max 1 -Label "$($case.Name) confidence"
      Assert-Equal -Actual $resp.priorityScore -Expected $exp.PriorityScore -Label "$($case.Name) priorityScore"
      Assert-ParseableDate -Value $nodeJson.auditEvent.createdAt -Label "$($case.Name) audit.createdAt"
      Assert-NoRawPiiLeak -NodeJson $nodeJson -Fixture $fixture -CaseName $case.Name
      $rec.Detail = "$($resp.theme)/$($resp.sentiment)/$($resp.urgency) score=$($resp.priorityScore) src=$($resp.classifierSource) hitl=$($resp.needsHumanReview)"
    } else {
      Assert-Equal -Actual $resp.error -Expected $exp.Error -Label "$($case.Name) error"
      if ($exp.ContainsKey("MissingField")) {
        if (@($resp.missingFields) -notcontains $exp.MissingField) { throw "$($case.Name) missingFields did not include '$($exp.MissingField)'" }
      }
      $rec.Detail = "status=$($nodeJson.statusCode) error=$($resp.error)"
    }
  } catch {
    $rec.Result = "FAIL"
    $rec.Detail = $_.Exception.Message
    $anyFail = $true
  }
  $results.Add([pscustomobject]$rec) | Out-Null
}

$results | Format-Table -AutoSize
if ($anyFail) {
  [Console]::Error.WriteLine("ERROR: one or more product-feedback eval cases failed.")
  exit 1
}
Write-Host "Product feedback eval passed for $($results.Count) cases."
exit 0
