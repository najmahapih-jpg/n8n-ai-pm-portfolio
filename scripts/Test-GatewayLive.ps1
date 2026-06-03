param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$WebhookPath = "webhook/portfolio/interaction-gateway",
  [string]$Secret = $env:GATEWAY_SIGNING_SECRET
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Opt-in LIVE tier (not in CI). Signs a real request and POSTs it to the DEPLOYED gateway webhook, proving
# the deployed jsCode's edge behaviour end-to-end: a valid signature -> 200 + echoed traceId; a tampered
# body -> 401. Routing is decision-only in v0.1.0 (live sibling execution is the opt-in next increment), so
# this asserts the EDGE, not sibling results. SKIPs honestly (exit 0, labeled) when n8n / the secret / the
# deployed webhook is absent -- never a false green (the P1.6 discipline).
#
# Exact-bytes note: the gateway HMACs the EXACT request bytes. n8n parses an application/json body into an
# object (losing the signed bytes), so this client posts the signed JSON as text/plain, which n8n leaves as
# an unparsed string the workflow reads verbatim. See docs/security-boundaries.md.

if ([string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl = "http://localhost:5678" }
$base = $BaseUrl.TrimEnd("/")
$webhookUrl = "$base/$($WebhookPath.TrimStart('/'))"

function Write-Skip {
  param([string]$Reason)
  Write-Host "SKIP: $Reason (opt-in live gateway tier; exit 0, no false green)."
  exit 0
}

# SKIP gate 1 -- n8n reachable?
try {
  $health = Invoke-WebRequest -Uri "$base/healthz" -UseBasicParsing -TimeoutSec 5 -SkipHttpErrorCheck
  if ([int]$health.StatusCode -ne 200) { Write-Skip "n8n health endpoint returned $($health.StatusCode)" }
} catch {
  Write-Skip "n8n not reachable at $base/healthz"
}

# SKIP gate 2 -- signing secret available?
if ([string]::IsNullOrWhiteSpace($Secret)) { Write-Skip "GATEWAY_SIGNING_SECRET not set" }

function Get-Signature {
  param([string]$Ts, [string]$RawBody, [string]$Key)
  $hmac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($Key))
  try {
    $hash = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("$Ts.$RawBody"))
  } finally {
    $hmac.Dispose()
  }
  return "sha256=" + (($hash | ForEach-Object { $_.ToString("x2") }) -join "")
}

function Invoke-Gateway {
  param([string]$RawBody, [hashtable]$Headers)
  return Invoke-WebRequest -Uri $webhookUrl -Method Post -Body $RawBody -ContentType "text/plain" -Headers $Headers -UseBasicParsing -TimeoutSec 20 -SkipHttpErrorCheck
}

$ts = [string]([System.DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
$bodyObj = [ordered]@{ intent = "support-triage"; payload = [ordered]@{ subject = "live smoke"; message = "gateway live check" }; requestId = "live-0001" }
$rawBody = $bodyObj | ConvertTo-Json -Depth 10 -Compress
$sig = Get-Signature -Ts $ts -RawBody $rawBody -Key $Secret

# SKIP gate 3 -- gateway webhook deployed? (404 / connection error -> SKIP, not a false FAIL)
try {
  $resp = Invoke-Gateway -RawBody $rawBody -Headers @{ "X-Timestamp" = $ts; "X-Signature" = $sig }
} catch {
  Write-Skip "gateway webhook not reachable (deploy the workflow first): $($_.Exception.Message)"
}
$status = [int]$resp.StatusCode
if ($status -eq 404) { Write-Skip "gateway webhook not found (404) -- deploy the workflow first" }

$anyFail = $false
function Assert {
  param([string]$Label, [bool]$Ok, [string]$Detail)
  $s = if ($Ok) { "PASS" } else { "FAIL" }
  if (-not $Ok) { $script:anyFail = $true }
  $line = "[$s] $Label"
  if (-not [string]::IsNullOrEmpty($Detail)) { $line += " -> $Detail" }
  Write-Host $line
}

$json = $null
try { $json = $resp.Content | ConvertFrom-Json -Depth 50 } catch { }

Assert "valid signed request -> HTTP 200" ($status -eq 200) "status=$status"
Assert "response ok:true" ($null -ne $json -and $json.ok -eq $true) ""
Assert "traceId present + echoed" ($null -ne $json -and -not [string]::IsNullOrWhiteSpace([string]$json.traceId)) ([string]$json.traceId)
Assert "routedTo present (routing decision)" ($null -ne $json -and $null -ne $json.routedTo) ""

# Tampered body -> the DEPLOYED jsCode must reject with 401 (proven live, not just offline).
$tampered = $rawBody + " "
try {
  $respBad = Invoke-Gateway -RawBody $tampered -Headers @{ "X-Timestamp" = $ts; "X-Signature" = $sig }
  $badStatus = [int]$respBad.StatusCode
} catch {
  $badStatus = 0
}
Assert "tampered body -> HTTP 401" ($badStatus -eq 401) "status=$badStatus"

if ($anyFail) {
  [Console]::Error.WriteLine("ERROR: live gateway tier failed.")
  exit 1
}

Write-Host "Live gateway tier passed (deployed edge: valid->200+traceId, tampered->401; routing is decision-only in v0.1.0)."
exit 0
