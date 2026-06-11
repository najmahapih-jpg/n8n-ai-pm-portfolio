param(
  [string]$WorkflowId = "",
  [string]$PinDataDirectory = ".\fixtures\pin-data",
  [string]$MetaPath = ".\workflows\sdk\lead-intelligence.meta.json",
  [string]$McpUrl = "http://localhost:5678/mcp-server/http",
  [string]$McpToken = $env:N8N_MCP_TOKEN,
  [string[]]$CaseName = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

function Exit-WithCode {
  param(
    [int]$Code,
    [string]$Message
  )
  if ($Code -eq 0) {
    Write-Host $Message
  } else {
    [Console]::Error.WriteLine("ERROR: $Message")
  }
  exit $Code
}

function Resolve-ProjectPath {
  param([string]$Path)

  if ([System.IO.Path]::IsPathRooted($Path)) {
    return $Path
  }

  return (Join-Path $repoRoot $Path)
}

function Invoke-N8nMcpTool {
  param(
    [string]$Name,
    [hashtable]$Arguments
  )

  $headers = @{
    Authorization = "Bearer $McpToken"
    "Content-Type" = "application/json"
    Accept = "application/json, text/event-stream"
  }
  $body = @{
    jsonrpc = "2.0"
    id = Get-Random
    method = "tools/call"
    params = @{
      name = $Name
      arguments = $Arguments
    }
  } | ConvertTo-Json -Depth 100

  $response = Invoke-WebRequest -Uri $McpUrl -Method Post -Headers $headers -Body $body -UseBasicParsing -TimeoutSec 120
  $line = ($response.Content -split "`n" | Where-Object { $_ -like "data: *" } | Select-Object -Last 1)
  if (-not $line) {
    throw "MCP response did not contain an SSE data line."
  }

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
  param(
    [object]$Actual,
    [object]$Expected,
    [string]$Label
  )

  if (($Actual -is [bool]) -or ($Expected -is [bool])) {
    if ([bool]$Actual -ne [bool]$Expected) {
      throw "$Label expected '$Expected' but got '$Actual'"
    }
    return
  }

  if ([string]$Actual -ne [string]$Expected) {
    throw "$Label expected '$Expected' but got '$Actual'"
  }
}

function Assert-NumberBetween {
  param(
    [object]$Actual,
    [int]$Minimum,
    [int]$Maximum,
    [string]$Label
  )

  $number = [int]$Actual
  if ($number -lt $Minimum -or $number -gt $Maximum) {
    throw "$Label expected between $Minimum and $Maximum but got $number"
  }
}

function Assert-ParseableDate {
  param(
    [object]$Value,
    [string]$Label
  )

  try {
    [datetimeoffset]::Parse([string]$Value, [System.Globalization.CultureInfo]::InvariantCulture) | Out-Null
  } catch {
    throw "$Label expected a parseable date but got '$Value'"
  }
}

function Assert-HasNoProperty {
  param(
    [object]$Object,
    [string]$Name,
    [string]$Label
  )

  if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) {
    throw "$Label should not contain property '$Name'"
  }
}

function Get-RawField {
  param(
    [object]$Fixture,
    [string[]]$Names
  )

  $source = $Fixture
  if ($Fixture.PSObject.Properties["body"]) {
    $source = $Fixture.body
  }

  foreach ($name in $Names) {
    if ($source.PSObject.Properties[$name]) {
      return [string]$source.PSObject.Properties[$name].Value
    }
  }

  return ""
}

function Get-OptionalProperty {
  param(
    [object]$Object,
    [string]$Name
  )

  if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) {
    return $Object.PSObject.Properties[$Name].Value
  }

  return $null
}

function Get-FixtureCompanyName {
  param([object]$Fixture)

  return Get-RawField -Fixture $Fixture -Names @("companyName", "company", "accountName")
}

function Assert-NoRawPiiLeak {
  param(
    [object]$NodeJson,
    [object]$Fixture,
    [string]$CaseName
  )

  if (-not $NodeJson.PSObject.Properties["auditEvent"]) {
    throw "$CaseName expected auditEvent on response-building node"
  }

  $audit = $NodeJson.auditEvent
  $response = $NodeJson.response
  $rawEmail = Get-RawField -Fixture $Fixture -Names @("email", "workEmail", "customerEmail")
  $rawName = Get-RawField -Fixture $Fixture -Names @("fullName", "name")
  $rawMessage = Get-RawField -Fixture $Fixture -Names @("message", "notes", "description", "request")
  $auditText = $audit | ConvertTo-Json -Depth 20 -Compress
  $responseText = $response | ConvertTo-Json -Depth 20 -Compress

  if (-not [string]::IsNullOrWhiteSpace($rawEmail)) {
    if ($auditText.Contains($rawEmail)) {
      throw "$CaseName audit event leaked raw email"
    }
    if ($responseText.Contains($rawEmail)) {
      throw "$CaseName response leaked raw email"
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($rawName) -and $rawName.Length -gt 2) {
    if ($auditText.Contains($rawName) -or $responseText.Contains($rawName)) {
      throw "$CaseName leaked raw full name"
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($rawMessage) -and $rawMessage.Length -gt 20) {
    $messageProbe = $rawMessage.Substring(0, [Math]::Min(60, $rawMessage.Length))
    if ($auditText.Contains($messageProbe) -or $responseText.Contains($messageProbe)) {
      throw "$CaseName leaked raw message text"
    }
  }

  Assert-HasNoProperty -Object $audit -Name "email" -Label "$CaseName auditEvent"
  Assert-HasNoProperty -Object $audit -Name "fullName" -Label "$CaseName auditEvent"
  Assert-HasNoProperty -Object $audit -Name "message" -Label "$CaseName auditEvent"
  if (-not ([string]$audit.redactedEmail).Contains("***")) {
    throw "$CaseName auditEvent.redactedEmail did not contain a mask"
  }
}

if ([string]::IsNullOrWhiteSpace($McpToken)) {
  Exit-WithCode -Code 2 -Message "N8N_MCP_TOKEN is required. Pass -McpToken or set the environment variable."
}

$resolvedMetaPath = Resolve-ProjectPath -Path $MetaPath
if ([string]::IsNullOrWhiteSpace($WorkflowId) -and (Test-Path -LiteralPath $resolvedMetaPath -PathType Leaf)) {
  $meta = Get-Content -LiteralPath $resolvedMetaPath -Raw | ConvertFrom-Json -Depth 100
  if ($meta.PSObject.Properties["n8nWorkflowId"]) {
    $WorkflowId = [string]$meta.n8nWorkflowId
  }
}
if ([string]::IsNullOrWhiteSpace($WorkflowId)) {
  Exit-WithCode -Code 2 -Message "WorkflowId is required. Run scripts/Sync-N8nWorkflowFromSdk.ps1 first or pass -WorkflowId."
}

$resolvedPinDataDirectory = Resolve-ProjectPath -Path $PinDataDirectory
if (-not (Test-Path -LiteralPath $resolvedPinDataDirectory)) {
  Exit-WithCode -Code 2 -Message "Pin data directory does not exist: $resolvedPinDataDirectory"
}

$cases = @(
  @{
    Name = "hot-enterprise-lead"
    File = "lead-hot-enterprise.json"
    Node = "Build Lead Intelligence Response"
    Expected = @{ StatusCode = 200; Ok = $true; Duplicate = $false; Grade = "A"; MinPriority = 80; MaxPriority = 100; OwnerQueue = "enterprise-ae"; OwnerTeam = "enterprise-sales"; SlaHours = 2; HotLead = $true; NotificationStatus = "skipped"; ManuallyOverridden = $false; AuditRedacted = $true }
  },
  @{
    Name = "midmarket-qualified"
    File = "lead-midmarket-qualified.json"
    Node = "Build Lead Intelligence Response"
    Expected = @{ StatusCode = 200; Ok = $true; Duplicate = $false; Grade = "B"; MinPriority = 62; MaxPriority = 79; OwnerQueue = "midmarket-ae"; OwnerTeam = "commercial-sales"; SlaHours = 8; HotLead = $false; NotificationStatus = "not_required"; ManuallyOverridden = $false; AuditRedacted = $true }
  },
  @{
    Name = "high-intent-low-fit"
    File = "lead-high-intent-low-fit.json"
    Node = "Build Lead Intelligence Response"
    Expected = @{ StatusCode = 200; Ok = $true; Duplicate = $false; Grade = "C"; MinPriority = 40; MaxPriority = 61; OwnerQueue = "sdr-qualification"; OwnerTeam = "sales-development"; SlaHours = 48; HotLead = $false; NotificationStatus = "not_required"; ManuallyOverridden = $false; AuditRedacted = $true }
  },
  @{
    Name = "student-low-fit"
    File = "lead-student-low-fit.json"
    Node = "Build Lead Intelligence Response"
    Expected = @{ StatusCode = 200; Ok = $true; Duplicate = $false; Grade = "D"; MinPriority = 0; MaxPriority = 39; OwnerQueue = "nurture"; OwnerTeam = "growth-marketing"; SlaHours = 168; HotLead = $false; NotificationStatus = "not_required"; ManuallyOverridden = $false; AuditRedacted = $true }
  },
  @{
    Name = "newsletter-low-intent"
    File = "lead-low-intent-newsletter.json"
    Node = "Build Lead Intelligence Response"
    Expected = @{ StatusCode = 200; Ok = $true; Duplicate = $false; Grade = "D"; MinPriority = 0; MaxPriority = 39; OwnerQueue = "nurture"; OwnerTeam = "growth-marketing"; SlaHours = 168; HotLead = $false; NotificationStatus = "not_required"; ManuallyOverridden = $false; AuditRedacted = $true }
  },
  @{
    Name = "duplicate-existing-id"
    File = "lead-duplicate-existing-id.json"
    Node = "Build Duplicate Lead Response"
    Expected = @{ StatusCode = 200; Ok = $true; Duplicate = $true; Action = "attach_to_existing_record"; Reason = "existingLeadId supplied"; MatchedLeadId = "lead_existing_20260529"; NoScoring = $true }
  },
  @{
    Name = "duplicate-domain"
    File = "lead-duplicate-domain.json"
    Node = "Build Duplicate Lead Response"
    Expected = @{ StatusCode = 200; Ok = $true; Duplicate = $true; Action = "attach_to_existing_record"; Reason = "domain recently processed"; MatchedLeadPrefix = "lead_existing_"; NoScoring = $true }
  },
  @{
    Name = "competitor-domain"
    File = "lead-competitor-domain.json"
    Node = "Build Lead Intelligence Response"
    Expected = @{ StatusCode = 200; Ok = $true; Duplicate = $false; Grade = "D"; MinPriority = 0; MaxPriority = 25; OwnerQueue = "disqualified-competitor"; OwnerTeam = "revops"; SlaHours = 168; HotLead = $false; NotificationStatus = "not_required"; ManuallyOverridden = $false; EvidenceContains = "competitor_domain"; AuditRedacted = $true }
  },
  @{
    Name = "manual-override"
    File = "lead-manual-override.json"
    Node = "Build Lead Intelligence Response"
    Expected = @{ StatusCode = 200; Ok = $true; Duplicate = $false; Grade = "A"; MinPriority = 85; MaxPriority = 100; OwnerQueue = "enterprise-ae"; OwnerTeam = "enterprise-sales"; SlaHours = 2; HotLead = $true; NotificationStatus = "skipped"; ManuallyOverridden = $true; RedactedEmail = "f***@gmail.com"; AuditRedacted = $true }
  },
  @{
    Name = "bad-email"
    File = "lead-bad-email.json"
    Node = "Build Email Syntax Error"
    Expected = @{ StatusCode = 422; Ok = $false; Error = "Invalid email syntax"; Email = "not-an-email"; NoScoring = $true }
  },
  @{
    Name = "missing-company"
    File = "lead-missing-company.json"
    Node = "Build Required Field Error"
    Expected = @{ StatusCode = 400; Ok = $false; Error = "Missing required lead fields"; MissingField = "companyName"; NoScoring = $true }
  }
)

if ($CaseName.Count -gt 0) {
  $requestedCases = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $CaseName) {
    $requestedCases.Add($name) | Out-Null
  }

  $cases = @($cases | Where-Object { $requestedCases.Contains([string]$_.Name) })
  if ($cases.Count -eq 0) {
    Exit-WithCode -Code 2 -Message "No matching cases found for -CaseName: $($CaseName -join ', ')"
  }
}

$rows = foreach ($case in $cases) {
  $fixturePath = Join-Path $resolvedPinDataDirectory $case.File
  if (-not (Test-Path -LiteralPath $fixturePath)) {
    throw "Missing fixture for $($case.Name): $fixturePath"
  }

  $fixture = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json -Depth 100
  $pinData = @{ "Run Demo Lead From n8n UI" = @(@{ json = $fixture }) }
  $test = Invoke-N8nMcpTool -Name "test_workflow" -Arguments @{ workflowId = $WorkflowId; pinData = $pinData }
  Assert-Equal -Actual $test.status -Expected "success" -Label "$($case.Name) execution status"

  $exec = Invoke-N8nMcpTool -Name "get_execution" -Arguments @{
    workflowId = $WorkflowId
    executionId = [string]$test.executionId
    includeData = $true
    nodeNames = @($case.Node)
    truncateData = 1
  }
  Assert-Equal -Actual $exec.execution.status -Expected "success" -Label "$($case.Name) persisted execution status"

  $runProperty = $exec.data.resultData.runData.PSObject.Properties[$case.Node]
  if (-not $runProperty) {
    throw "$($case.Name) did not execute expected node '$($case.Node)'"
  }

  $runs = @($runProperty.Value)
  $candidateNodeJson = @($runs | ForEach-Object { $_.data.main[0][0].json })
  $fixtureCompanyName = Get-FixtureCompanyName -Fixture $fixture
  $nodeJson = $null
  if (-not [string]::IsNullOrWhiteSpace($fixtureCompanyName)) {
    $nodeJson = @($candidateNodeJson | Where-Object {
      $_.PSObject.Properties["response"] -and
      $_.response.PSObject.Properties["companyName"] -and
      [string]$_.response.companyName -eq $fixtureCompanyName
    } | Select-Object -Last 1)
  }
  if ($null -eq $nodeJson -or @($nodeJson).Count -eq 0) {
    $nodeJson = $candidateNodeJson[$candidateNodeJson.Count - 1]
  } else {
    $nodeJson = @($nodeJson)[0]
  }
  $response = $nodeJson.response
  $expected = $case.Expected

  Assert-Equal -Actual $nodeJson.statusCode -Expected $expected.StatusCode -Label "$($case.Name) statusCode"
  Assert-Equal -Actual $response.ok -Expected $expected.Ok -Label "$($case.Name) ok"
  Assert-Equal -Actual $response.policyVersion -Expected "lead-intel-v0.1.0" -Label "$($case.Name) policyVersion"

  if ($expected.ContainsKey("Error")) {
    Assert-Equal -Actual $response.error -Expected $expected.Error -Label "$($case.Name) error"
    if ($expected.ContainsKey("Email")) {
      Assert-Equal -Actual $response.email -Expected $expected.Email -Label "$($case.Name) email"
    }
    if ($expected.ContainsKey("MissingField") -and @($response.missingFields) -notcontains $expected.MissingField) {
      throw "$($case.Name) missingFields did not include '$($expected.MissingField)'"
    }
  } elseif ($expected.Duplicate) {
    Assert-Equal -Actual $response.duplicate -Expected $true -Label "$($case.Name) duplicate"
    Assert-Equal -Actual $response.action -Expected $expected.Action -Label "$($case.Name) action"
    Assert-Equal -Actual $response.reason -Expected $expected.Reason -Label "$($case.Name) reason"
    if ($expected.ContainsKey("MatchedLeadId")) {
      Assert-Equal -Actual $response.matchedLeadId -Expected $expected.MatchedLeadId -Label "$($case.Name) matchedLeadId"
    }
    if ($expected.ContainsKey("MatchedLeadPrefix") -and -not ([string]$response.matchedLeadId).StartsWith($expected.MatchedLeadPrefix)) {
      throw "$($case.Name) matchedLeadId expected prefix '$($expected.MatchedLeadPrefix)' but got '$($response.matchedLeadId)'"
    }
    Assert-HasNoProperty -Object $response -Name "grade" -Label "$($case.Name) duplicate response"
    Assert-HasNoProperty -Object $response -Name "route" -Label "$($case.Name) duplicate response"
    Assert-HasNoProperty -Object $response -Name "followUp" -Label "$($case.Name) duplicate response"
  } else {
    Assert-Equal -Actual $response.duplicate -Expected $expected.Duplicate -Label "$($case.Name) duplicate"
    Assert-Equal -Actual $response.grade -Expected $expected.Grade -Label "$($case.Name) grade"
    Assert-NumberBetween -Actual $response.priorityScore -Minimum $expected.MinPriority -Maximum $expected.MaxPriority -Label "$($case.Name) priorityScore"
    Assert-NumberBetween -Actual $response.icpFitScore -Minimum 0 -Maximum 100 -Label "$($case.Name) icpFitScore"
    Assert-NumberBetween -Actual $response.intentScore -Minimum 0 -Maximum 100 -Label "$($case.Name) intentScore"
    Assert-Equal -Actual $response.route.ownerQueue -Expected $expected.OwnerQueue -Label "$($case.Name) route.ownerQueue"
    Assert-Equal -Actual $response.route.ownerTeam -Expected $expected.OwnerTeam -Label "$($case.Name) route.ownerTeam"
    Assert-Equal -Actual $response.followUp.slaHours -Expected $expected.SlaHours -Label "$($case.Name) followUp.slaHours"
    Assert-Equal -Actual $response.followUp.hotLead -Expected $expected.HotLead -Label "$($case.Name) followUp.hotLead"
    Assert-ParseableDate -Value $response.followUp.dueAt -Label "$($case.Name) followUp.dueAt"
    Assert-Equal -Actual $response.notification.status -Expected $expected.NotificationStatus -Label "$($case.Name) notification.status"
    Assert-Equal -Actual $response.manuallyOverridden -Expected $expected.ManuallyOverridden -Label "$($case.Name) manuallyOverridden"

    if (-not ([string]$response.leadId).StartsWith("lead_")) {
      throw "$($case.Name) leadId expected prefix lead_ but got '$($response.leadId)'"
    }
    if (-not ([string]$response.auditEventId).StartsWith("audit_")) {
      throw "$($case.Name) auditEventId expected prefix audit_ but got '$($response.auditEventId)'"
    }
    Assert-Equal -Actual $response.crmPayload.externalId -Expected $response.leadId -Label "$($case.Name) crmPayload.externalId"
    if ([string]::IsNullOrWhiteSpace([string]$response.crmPayload.idempotencyKey)) {
      throw "$($case.Name) crmPayload.idempotencyKey was blank"
    }
    Assert-HasNoProperty -Object $response.crmPayload -Name "email" -Label "$($case.Name) response crmPayload"
    Assert-HasNoProperty -Object $response.crmPayload -Name "companyDomain" -Label "$($case.Name) response crmPayload"

    if ($expected.ContainsKey("EvidenceContains") -and @($nodeJson.auditEvent.evidence) -notcontains $expected.EvidenceContains) {
      throw "$($case.Name) audit evidence did not include '$($expected.EvidenceContains)'"
    }
    if ($expected.ContainsKey("RedactedEmail")) {
      Assert-Equal -Actual $response.redactedEmail -Expected $expected.RedactedEmail -Label "$($case.Name) redactedEmail"
    }
    if ($expected.AuditRedacted) {
      Assert-NoRawPiiLeak -NodeJson $nodeJson -Fixture $fixture -CaseName $case.Name
    }
  }

  [pscustomobject]@{
    Case = $case.Name
    ExecutionId = $test.executionId
    StatusCode = $nodeJson.statusCode
    Ok = $response.ok
    Duplicate = Get-OptionalProperty -Object $response -Name "duplicate"
    Grade = Get-OptionalProperty -Object $response -Name "grade"
    PriorityScore = Get-OptionalProperty -Object $response -Name "priorityScore"
    OwnerQueue = Get-OptionalProperty -Object (Get-OptionalProperty -Object $response -Name "route") -Name "ownerQueue"
    SlaHours = Get-OptionalProperty -Object (Get-OptionalProperty -Object $response -Name "followUp") -Name "slaHours"
    NotificationStatus = Get-OptionalProperty -Object (Get-OptionalProperty -Object $response -Name "notification") -Name "status"
  }
}

$rows | Format-Table -AutoSize
Write-Host "Lead intelligence MCP regression tests passed for $($cases.Count) cases."
exit 0
