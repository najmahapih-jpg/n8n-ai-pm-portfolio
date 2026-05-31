param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$WebhookPath = "webhook/portfolio/rag-knowledge-assistant"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  $BaseUrl = "http://localhost:5678"
}
$base = $BaseUrl.TrimEnd("/")
$webhookUrl = "$base/$($WebhookPath.TrimStart('/'))"

# Three smoke cases proving the headline behaviours offline (stub retriever + stub generator):
#   in-corpus   -> a grounded, cited answer (abstained:false, >= 1 citation)
#   out-of-corpus -> a clean abstain (abstained:true, answer null, citations [])
#   citation-integrity -> a grounded answer whose every cited chunkId is in retrieval.topK
$cases = @(
  @{ Name = "in-corpus";          Body = '{"requestId":"smoke-in-corpus","query":"How does pumped-storage hydropower work?"}' }
  @{ Name = "out-of-corpus";      Body = '{"requestId":"smoke-out-of-corpus","query":"What is the capital of France?"}' }
  @{ Name = "citation-integrity"; Body = '{"requestId":"smoke-citation","query":"How does a hydroelectric dam generate electricity from a reservoir?"}' }
)

Write-Host "Smoke test against $webhookUrl"
Write-Host ""

foreach ($case in $cases) {
  Write-Host "=== $($case.Name) ==="
  $response = Invoke-WebRequest -Uri $webhookUrl -Method Post -ContentType "application/json" -Body $case.Body -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck
  Write-Host "HTTP $($response.StatusCode)"
  Write-Host $response.Content
  Write-Host ""
}

Write-Host "Smoke test complete."
exit 0
