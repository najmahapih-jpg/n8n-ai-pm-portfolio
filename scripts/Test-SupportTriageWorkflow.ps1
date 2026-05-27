param(
  [string]$WorkflowId = "RPkw9jGJ93lqs7jO",
  [string]$PinDataDirectory = ".\fixtures\pin-data",
  [string]$McpUrl = "http://localhost:5678/mcp-server/http",
  [string]$McpToken = $env:N8N_MCP_TOKEN
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

function Assert-AuditRedacted {
  param(
    [object]$NodeJson,
    [object]$Fixture,
    [string]$CaseName
  )

  if (-not $NodeJson.PSObject.Properties["auditEvent"]) {
    throw "$CaseName expected auditEvent on response-building node"
  }

  $audit = $NodeJson.auditEvent
  $rawEmail = Get-RawField -Fixture $Fixture -Names @("customerEmail", "email")
  $rawMessage = Get-RawField -Fixture $Fixture -Names @("message", "description")
  $auditText = $audit | ConvertTo-Json -Depth 20 -Compress

  if (-not [string]::IsNullOrWhiteSpace($rawEmail) -and $auditText.Contains($rawEmail)) {
    throw "$CaseName audit event leaked the raw customer email"
  }
  if (-not [string]::IsNullOrWhiteSpace($rawMessage) -and $rawMessage.Length -gt 20) {
    $messageProbe = $rawMessage.Substring(0, [Math]::Min(60, $rawMessage.Length))
    if ($auditText.Contains($messageProbe)) {
      throw "$CaseName audit event leaked the raw customer message"
    }
  }
  if ($audit.PSObject.Properties["customerEmail"] -or $audit.PSObject.Properties["message"]) {
    throw "$CaseName audit event contains unsafe raw payload fields"
  }
  if (-not ([string]$audit.redactedEmail).Contains("***")) {
    throw "$CaseName audit event redactedEmail did not contain a mask"
  }
}

if ([string]::IsNullOrWhiteSpace($McpToken)) {
  Exit-WithCode -Code 2 -Message "N8N_MCP_TOKEN is required. Pass -McpToken or set the environment variable."
}

if (-not (Test-Path -LiteralPath $PinDataDirectory)) {
  Exit-WithCode -Code 2 -Message "Pin data directory does not exist: $PinDataDirectory"
}

$cases = @(
  @{
    Name = "enterprise-incident"
    File = "support-triage-enterprise-incident.json"
    Node = "Build Escalation Customer Response"
    Expected = @{ StatusCode = 200; Ok = $true; Category = "incident"; Urgency = "critical"; RoutingTeam = "platform-support"; SlaHours = 1; HandlingPath = "escalated"; EscalationRequired = $true; PolicyVersion = "supportops-triage-v0.2.0"; AuditRedacted = $true; DueAtParseable = $true }
  },
  @{
    Name = "urgent-incident"
    File = "support-triage-urgent-incident.json"
    Node = "Build Escalation Customer Response"
    Expected = @{ StatusCode = 200; Ok = $true; Category = "incident"; Urgency = "urgent"; RoutingTeam = "platform-support"; SlaHours = 2; HandlingPath = "escalated"; EscalationRequired = $true; PolicyVersion = "supportops-triage-v0.2.0"; AuditRedacted = $true; DueAtParseable = $true }
  },
  @{
    Name = "billing"
    File = "support-triage-billing.json"
    Node = "Build Standard Customer Response"
    Expected = @{ StatusCode = 200; Ok = $true; Category = "billing"; Urgency = "high"; RoutingTeam = "billing-support"; SlaHours = 8; HandlingPath = "standard"; EscalationRequired = $false; PolicyVersion = "supportops-triage-v0.2.0"; AuditRedacted = $true; DueAtParseable = $true }
  },
  @{
    Name = "account-alias"
    File = "support-triage-account-alias.json"
    Node = "Build Standard Customer Response"
    Expected = @{ StatusCode = 200; Ok = $true; Category = "account"; Urgency = "normal"; RoutingTeam = "account-success"; SlaHours = 24; HandlingPath = "standard"; EscalationRequired = $false; PolicyVersion = "supportops-triage-v0.2.0"; AuditRedacted = $true; DueAtParseable = $true }
  },
  @{
    Name = "bug"
    File = "support-triage-bug.json"
    Node = "Build Standard Customer Response"
    Expected = @{ StatusCode = 200; Ok = $true; Category = "bug"; Urgency = "normal"; RoutingTeam = "product-engineering"; SlaHours = 24; HandlingPath = "standard"; EscalationRequired = $false; PolicyVersion = "supportops-triage-v0.2.0"; AuditRedacted = $true; DueAtParseable = $true }
  },
  @{
    Name = "general"
    File = "support-triage-general.json"
    Node = "Build Standard Customer Response"
    Expected = @{ StatusCode = 200; Ok = $true; Category = "general"; Urgency = "normal"; RoutingTeam = "general-support"; SlaHours = 24; HandlingPath = "standard"; EscalationRequired = $false; PolicyVersion = "supportops-triage-v0.2.0"; AuditRedacted = $true; DueAtParseable = $true }
  },
  @{
    Name = "invalid-date"
    File = "support-triage-invalid-date.json"
    Node = "Build Standard Customer Response"
    Expected = @{ StatusCode = 200; Ok = $true; Category = "general"; Urgency = "normal"; RoutingTeam = "general-support"; SlaHours = 24; HandlingPath = "standard"; EscalationRequired = $false; PolicyVersion = "supportops-triage-v0.2.0"; AuditRedacted = $true; DueAtParseable = $true }
  },
  @{
    Name = "missing-field"
    File = "support-triage-missing-field.json"
    Node = "Build Validation Error"
    Expected = @{ StatusCode = 400; Ok = $false; Error = "Missing required fields"; MissingField = "message" }
  }
)

$rows = foreach ($case in $cases) {
  $fixturePath = Join-Path $PinDataDirectory $case.File
  if (-not (Test-Path -LiteralPath $fixturePath)) {
    throw "Missing fixture for $($case.Name): $fixturePath"
  }

  $fixture = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json -Depth 100
  $pinData = @{ "Receive Support Ticket" = @(@{ json = $fixture }) }
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
  $nodeJson = $runs[$runs.Count - 1].data.main[0][0].json
  $response = $nodeJson.response
  $expected = $case.Expected

  Assert-Equal -Actual $nodeJson.statusCode -Expected $expected.StatusCode -Label "$($case.Name) statusCode"
  Assert-Equal -Actual $response.ok -Expected $expected.Ok -Label "$($case.Name) ok"

  if ($expected.ContainsKey("Category")) {
    Assert-Equal -Actual $response.category -Expected $expected.Category -Label "$($case.Name) category"
    Assert-Equal -Actual $response.urgency -Expected $expected.Urgency -Label "$($case.Name) urgency"
    Assert-Equal -Actual $response.routingTeam -Expected $expected.RoutingTeam -Label "$($case.Name) routingTeam"
    Assert-Equal -Actual $response.slaHours -Expected $expected.SlaHours -Label "$($case.Name) slaHours"
    Assert-Equal -Actual $response.handlingPath -Expected $expected.HandlingPath -Label "$($case.Name) handlingPath"
    Assert-Equal -Actual $response.escalationRequired -Expected $expected.EscalationRequired -Label "$($case.Name) escalationRequired"
    Assert-Equal -Actual $response.policyVersion -Expected $expected.PolicyVersion -Label "$($case.Name) policyVersion"

    if ($expected.DueAtParseable) {
      Assert-ParseableDate -Value $response.dueAt -Label "$($case.Name) dueAt"
    }
    if ($expected.AuditRedacted) {
      Assert-AuditRedacted -NodeJson $nodeJson -Fixture $fixture -CaseName $case.Name
    }
  } else {
    Assert-Equal -Actual $response.error -Expected $expected.Error -Label "$($case.Name) error"
    if (@($response.missingFields) -notcontains $expected.MissingField) {
      throw "$($case.Name) missingFields did not include '$($expected.MissingField)'"
    }
  }

  [pscustomobject]@{
    Case = $case.Name
    ExecutionId = $test.executionId
    StatusCode = $nodeJson.statusCode
    Ok = $response.ok
    Category = Get-OptionalProperty -Object $response -Name "category"
    Urgency = Get-OptionalProperty -Object $response -Name "urgency"
    RoutingTeam = Get-OptionalProperty -Object $response -Name "routingTeam"
    SlaHours = Get-OptionalProperty -Object $response -Name "slaHours"
    HandlingPath = Get-OptionalProperty -Object $response -Name "handlingPath"
  }
}

$rows | Format-Table -AutoSize
Write-Host "Support triage MCP regression tests passed for $($cases.Count) cases."
exit 0
