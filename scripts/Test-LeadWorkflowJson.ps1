param(
  [string]$CanonicalPath = ".\workflows\canonical\lead-intelligence.canonical.json",
  [string]$ReleasePath = ".\workflows\releases\lead-intelligence-v0.1.0.json",
  [int]$MinimumNodes = 31
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Add-Failure {
  param(
    [System.Collections.Generic.List[string]]$Failures,
    [string]$Message
  )
  $Failures.Add($Message) | Out-Null
}

function Test-Workflow {
  param(
    [string]$Path,
    [string]$Label,
    [System.Collections.Generic.List[string]]$Failures
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    Add-Failure -Failures $Failures -Message "$Label missing: $Path"
    return
  }

  $raw = Get-Content -LiteralPath $Path -Raw
  $workflow = $raw | ConvertFrom-Json -Depth 100
  $nodes = @($workflow.nodes)
  $nodeNames = @($nodes | ForEach-Object { [string]$_.name })
  $requiredNodes = @(
    "Receive Lead Intake",
    "Normalize Lead Payload",
    "Required Fields Present?",
    "Email Syntax Valid?",
    "Check Duplicate Candidate",
    "Duplicate Lead?",
    "Mock Company Enrichment",
    "Mock Intent Enrichment",
    "Calculate ICP Fit Score",
    "Calculate Intent Score",
    "Calculate Priority Score",
    "Assign Lead Grade",
    "Route Sales Owner",
    "Build Follow-up Policy",
    "Hot Lead?",
    "Build CRM-ready Payload",
    "Create Redacted Audit Event",
    "Build Lead Intelligence Response",
    "Return Lead Intelligence Response"
  )

  if ($nodes.Count -lt $MinimumNodes) {
    Add-Failure -Failures $Failures -Message "$Label expected at least $MinimumNodes nodes, found $($nodes.Count)"
  }

  foreach ($nodeName in $requiredNodes) {
    if ($nodeNames -notcontains $nodeName) {
      Add-Failure -Failures $Failures -Message "$Label missing node '$nodeName'"
    }
  }

  if ($raw -notmatch "lead-intel-v0\.1\.0") {
    Add-Failure -Failures $Failures -Message "$Label missing lead-intel-v0.1.0 policy marker"
  }
  if ($raw -notmatch "portfolio/lead-intelligence") {
    Add-Failure -Failures $Failures -Message "$Label missing lead intake webhook path"
  }
  if ($raw -notmatch "Lead Intelligence v0\.1\.0") {
    Add-Failure -Failures $Failures -Message "$Label missing sticky-note release marker"
  }
  if ($raw -match "https://open\.(feishu|larksuite)\.com/open-apis/bot/v2/hook/[A-Za-z0-9_\-]+") {
    Add-Failure -Failures $Failures -Message "$Label contains a literal Feishu/Lark webhook URL"
  }
  if ($raw -match "(?i)(hubspot|salesforce|pipedrive).*(api[_-]?key|token|secret)") {
    Add-Failure -Failures $Failures -Message "$Label appears to contain a CRM secret reference"
  }
}

$failures = New-Object System.Collections.Generic.List[string]
Test-Workflow -Path $CanonicalPath -Label "canonical" -Failures $failures
Test-Workflow -Path $ReleasePath -Label "release" -Failures $failures

if ($failures.Count -gt 0) {
  foreach ($failure in $failures) {
    Write-Error $failure
  }
  exit 1
}

Write-Host "Lead workflow JSON validation passed."
exit 0
