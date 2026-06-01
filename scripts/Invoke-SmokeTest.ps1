param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$WebhookPath = "webhook/portfolio/scheduled-drift-monitor"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  $BaseUrl = "http://localhost:5678"
}
$base = $BaseUrl.TrimEnd("/")
$webhookUrl = "$base/$($WebhookPath.TrimStart('/'))"

# Three smoke cases proving the headline behaviours offline (stub collectors), via D's on-demand webhook:
#   all-clear         -> no drift (drift.any:false), report-only (reembedded 0)
#   quality-regressed -> a flagged quality regression (quality.regressed:true, drift.any:true)
#   source-changed    -> a flagged changed source (freshness.changed>=1, drift.any:true), no live write
$cases = @(
  @{ Name = "all-clear";         Body = '{"mode":"stub","runId":"smoke-all-clear","asOf":"2026-05-31"}' }
  @{ Name = "quality-regressed"; Body = '{"mode":"stub","runId":"smoke-regressed","asOf":"2026-05-31","stubQuality":{"passRate":0.8}}' }
  @{ Name = "source-changed";    Body = '{"mode":"stub","runId":"smoke-source-changed","asOf":"2026-05-31","stubSources":{"institutepm-2026":{"fingerprintNow":"deadbeef"}}}' }
)

Write-Host "Smoke test against $webhookUrl (D's on-demand webhook, OFFLINE stub)"
Write-Host ""

foreach ($case in $cases) {
  Write-Host "=== $($case.Name) ==="
  $response = Invoke-WebRequest -Uri $webhookUrl -Method Post -ContentType "application/json" -Body $case.Body -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck
  Write-Host "HTTP $($response.StatusCode)"
  try {
    $j = $response.Content | ConvertFrom-Json -Depth 100
    Write-Host ("driftAny={0} regressed={1} changed={2} stale={3} unreachable={4} reembedded={5} digestIntegrity={6} passed={7}" -f `
      $j.drift.any, $j.quality.regressed, $j.freshness.changed, $j.freshness.stale, $j.freshness.unreachable, $j.freshness.reembedded, $j.digestIntegrity.passed, $j.passed)
  } catch { Write-Host $response.Content }
  Write-Host ""
}

Write-Host "Smoke test complete."
exit 0
