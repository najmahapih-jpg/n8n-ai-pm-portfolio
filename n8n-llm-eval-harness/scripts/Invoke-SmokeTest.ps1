param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$WebhookPath = "webhook/portfolio/llm-eval-harness",
  [string]$FixturePath = ".\fixtures\golden\echo-pass.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  $BaseUrl = "http://localhost:5678"
}
$base = $BaseUrl.TrimEnd("/")
$webhookUrl = "$base/$($WebhookPath.TrimStart('/'))"

$resolvedFixture = if ([System.IO.Path]::IsPathRooted($FixturePath)) { $FixturePath } else { Join-Path $repoRoot ($FixturePath -replace '^\.[\\/]', '') }
if (-not (Test-Path -LiteralPath $resolvedFixture -PathType Leaf)) {
  [Console]::Error.WriteLine("ERROR: Fixture not found: $resolvedFixture")
  exit 2
}

$body = Get-Content -LiteralPath $resolvedFixture -Raw

Write-Host "==> POST $webhookUrl ($([System.IO.Path]::GetFileName($resolvedFixture)))"
try {
  $response = Invoke-WebRequest -Uri $webhookUrl -Method Post -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck
} catch {
  [Console]::Error.WriteLine("ERROR: Webhook request failed. $($_.Exception.Message)")
  exit 1
}

Write-Host "HTTP $($response.StatusCode)"
Write-Host $response.Content

if ([int]$response.StatusCode -ne 200) {
  [Console]::Error.WriteLine("ERROR: Smoke test expected HTTP 200 but got $($response.StatusCode).")
  exit 1
}

Write-Host "Smoke test passed."
exit 0
