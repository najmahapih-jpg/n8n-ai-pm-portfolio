param(
  [string]$CanonicalPath = ".\workflows\canonical\portfolio-support-triage-api.canonical.json",
  [string]$ReleasePath = ".\workflows\releases\support-triage-v0.3.0.json",
  [int]$MinimumNodes = 27
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
  $nodeNames = @($workflow.nodes | ForEach-Object { [string]$_.name })
  $requiredNodes = @(
    "Load Feishu Runtime Config",
    "Build Feishu Alert Card",
    "Feishu Enabled?",
    "Send Feishu Alert",
    "Record Feishu Skipped"
  )

  if (@($workflow.nodes).Count -lt $MinimumNodes) {
    Add-Failure -Failures $Failures -Message "$Label expected at least $MinimumNodes nodes, found $(@($workflow.nodes).Count)"
  }

  foreach ($nodeName in $requiredNodes) {
    if ($nodeNames -notcontains $nodeName) {
      Add-Failure -Failures $Failures -Message "$Label missing node '$nodeName'"
    }
  }

  if ($raw -notmatch "v0\.3\.0-local-feishu") {
    Add-Failure -Failures $Failures -Message "$Label missing v0.3.0-local-feishu marker"
  }
  if ($raw -notmatch "FEISHU_BOT_WEBHOOK_URL") {
    Add-Failure -Failures $Failures -Message "$Label missing FEISHU_BOT_WEBHOOK_URL environment reference"
  }
  if ($raw -notmatch "FEISHU_BOT_SIGNING_SECRET") {
    Add-Failure -Failures $Failures -Message "$Label missing FEISHU_BOT_SIGNING_SECRET environment reference"
  }
  if ($raw -match "https://open\.feishu\.cn/open-apis/bot/v2/hook/[A-Za-z0-9-]{8,}") {
    Add-Failure -Failures $Failures -Message "$Label contains a literal Feishu webhook URL"
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

Write-Host "Feishu workflow JSON validation passed."
exit 0
