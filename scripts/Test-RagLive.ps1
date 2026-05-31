<#
.SYNOPSIS
  LIVE-path verification (NON-CI) for the RAG Knowledge Assistant v0.2.0.

.DESCRIPTION
  Exercises the REAL live backend end-to-end through the deployed webhook: retrievalSource:"supabase"
  (Ollama nomic-embed-text-v2-moe query embedding, "search_query: " prefix -> Supabase match_documents
  pgvector RPC) and
  generationSource:"ollama" (llama3.2:3b grounded generation). This is the Layer-1 live activity that
  the offline Layer-2 suite (verify:live) deliberately does NOT cover — it is opt-in, requires the live
  Supabase + Ollama backends, and is NEVER part of CI (CI stays on the stub default, offline).

  Asserts the trust invariants on the LIVE path:
    - in-corpus  -> abstained:false, retrievalSource:"supabase", a real grounded answer, >=1 citation,
                    and every citation.chunkId is in retrieval.topK (citation-integrity holds live too).
    - out-of-corpus -> a clean live abstain (retrieval below threshold -> abstained:true, answer null,
                    citations []), retrievalSource reflecting the live store ("supabase"/"supabase-fallback").

  Pre-flight: confirms Ollama has both models, Supabase is reachable (User-Agent n8n), and the
  documents table is populated (run scripts/Ingest-Corpus.ps1 first). A non-green pre-flight is a
  hard fail with a clear message — this script is meant to prove the live wiring, not to degrade.

.NOTES
  No secrets are printed. The Supabase key is read from .env only for the pre-flight count check.
#>
param(
  [string]$BaseUrl = $env:N8N_API_URL,
  [string]$WebhookPath = "webhook/portfolio/rag-knowledge-assistant",
  [string]$SupabaseUrl = $env:SUPABASE_URL,
  [string]$SupabaseKey = $env:SUPABASE_SERVICE_ROLE_KEY,
  [string]$OllamaUrl = $env:OLLAMA_URL,
  [string]$EmbedModel = "nomic-embed-text-v2-moe",
  [string]$GenModel = "llama3.2:3b",
  [string]$InCorpusQuery = "How does pumped-storage hydropower work?",
  [string]$OutOfCorpusQuery = "What is the capital of France and who painted the Mona Lisa?"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

function Get-DotEnvValue {
  param([string]$Name)
  $envFile = Join-Path $repoRoot ".env"
  if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { return "" }
  $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } | Select-Object -First 1
  if ($null -eq $line) { return "" }
  return ($line -replace "^\s*$([regex]::Escape($Name))\s*=\s*", "").Trim()
}

if ([string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl = "http://localhost:5678" }
if ([string]::IsNullOrWhiteSpace($SupabaseUrl)) { $SupabaseUrl = Get-DotEnvValue -Name "SUPABASE_URL" }
if ([string]::IsNullOrWhiteSpace($SupabaseKey)) { $SupabaseKey = Get-DotEnvValue -Name "SUPABASE_SERVICE_ROLE_KEY" }
if ([string]::IsNullOrWhiteSpace($OllamaUrl)) { $OllamaUrl = "http://localhost:11434" }
$base = $BaseUrl.TrimEnd("/")
$SupabaseUrl = $SupabaseUrl.TrimEnd("/")
$OllamaUrl = $OllamaUrl.TrimEnd("/")
$webhookUrl = "$base/$($WebhookPath.TrimStart('/'))"

$assertions = New-Object System.Collections.Generic.List[object]
$anyFail = $false
function Add-Assertion {
  param([string]$Case, [string]$Type, [string]$Label, [bool]$Ok, [string]$Detail)
  $status = if ($Ok) { "PASS" } else { "FAIL" }
  if (-not $Ok) { $script:anyFail = $true }
  $line = "[{0}] {1} :: {2} :: {3}" -f $status, $Case, $Type, $Label
  if (-not [string]::IsNullOrEmpty($Detail)) { $line += " -> $Detail" }
  Write-Host $line
  $script:assertions.Add([pscustomobject]@{ Case = $Case; Type = $Type; Label = $Label; Result = $status; Detail = $Detail }) | Out-Null
}

# --- Pre-flight: live backends must be present (this suite proves the live path, not a degrade) -----
Write-Host "=== Pre-flight (live backends) ==="
try {
  $tags = Invoke-RestMethod -Uri "$OllamaUrl/api/tags" -TimeoutSec 15
  $names = @($tags.models | ForEach-Object { $_.name })
  $hasEmbed = @($names | Where-Object { $_ -match [regex]::Escape($EmbedModel) }).Count -gt 0
  $hasGen = @($names | Where-Object { $_ -match [regex]::Escape($GenModel) }).Count -gt 0
  Add-Assertion -Case "preflight" -Type "exact-match" -Label "Ollama has $EmbedModel" -Ok:$hasEmbed -Detail ($names -join ', ')
  Add-Assertion -Case "preflight" -Type "exact-match" -Label "Ollama has $GenModel" -Ok:$hasGen -Detail ($names -join ', ')
} catch {
  Add-Assertion -Case "preflight" -Type "exact-match" -Label "Ollama reachable" -Ok:$false -Detail $_.Exception.Message
}

if (-not [string]::IsNullOrWhiteSpace($SupabaseUrl) -and -not [string]::IsNullOrWhiteSpace($SupabaseKey)) {
  Add-Type -AssemblyName System.Net.Http
  $client = [System.Net.Http.HttpClient]::new()
  try {
    $client.Timeout = [TimeSpan]::FromSeconds(30)
    $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, "$SupabaseUrl/rest/v1/documents?select=id")
    $req.Headers.TryAddWithoutValidation("User-Agent", "n8n") | Out-Null
    $req.Headers.TryAddWithoutValidation("apikey", $SupabaseKey) | Out-Null
    $req.Headers.TryAddWithoutValidation("Authorization", "Bearer $SupabaseKey") | Out-Null
    $req.Headers.TryAddWithoutValidation("Prefer", "count=exact") | Out-Null
    $req.Headers.TryAddWithoutValidation("Range", "0-0") | Out-Null
    $resp = $client.SendAsync($req).Result
    $cr = $null; [void]$resp.Content.Headers.TryGetValues("Content-Range", [ref]$cr)
    $count = -1
    if ($cr) { $parts = ($cr -join ",").Split("/"); if ($parts.Count -eq 2 -and $parts[1] -match '^\d+$') { $count = [int]$parts[1] } }
    Add-Assertion -Case "preflight" -Type "numeric-range" -Label "Supabase documents populated (>=1)" -Ok:($count -ge 1) -Detail "rows=$count (HTTP $([int]$resp.StatusCode))"
  } catch {
    Add-Assertion -Case "preflight" -Type "exact-match" -Label "Supabase reachable" -Ok:$false -Detail $_.Exception.Message
  } finally { $client.Dispose() }
} else {
  Add-Assertion -Case "preflight" -Type "exact-match" -Label "Supabase env present" -Ok:$false -Detail "SUPABASE_URL/KEY missing"
}
Write-Host ""

function Invoke-Live {
  param([string]$Body)
  return Invoke-WebRequest -Uri $webhookUrl -Method Post -ContentType "application/json" -Body $Body -UseBasicParsing -TimeoutSec 180 -SkipHttpErrorCheck
}
function Get-CiteIds { param($Resp) $ids = New-Object System.Collections.Generic.List[string]; if ($Resp.PSObject.Properties["citations"]) { foreach ($c in @($Resp.citations)) { if ($c.PSObject.Properties["chunkId"]) { $ids.Add([string]$c.chunkId) | Out-Null } } } return [string[]]$ids.ToArray() }
function Get-TopKIds { param($Resp) $ids = New-Object System.Collections.Generic.List[string]; if ($Resp.PSObject.Properties["retrieval"] -and $Resp.retrieval.PSObject.Properties["topK"]) { foreach ($c in @($Resp.retrieval.topK)) { if ($c.PSObject.Properties["chunkId"]) { $ids.Add([string]$c.chunkId) | Out-Null } } } return [string[]]$ids.ToArray() }

# --- (a) IN-CORPUS live: supabase retrieval + ollama generation --------------------------------
Write-Host "=== (a) IN-CORPUS  retrievalSource:supabase generationSource:ollama ==="
$inBody = @{ requestId = "rag-live-in-corpus"; query = $InCorpusQuery; retrievalSource = "supabase"; generationSource = "ollama" } | ConvertTo-Json -Depth 6
$inResp = Invoke-Live -Body $inBody
$inStatus = [int]$inResp.StatusCode
$inRaw = [string]$inResp.Content
Write-Host "HTTP $inStatus"
Write-Host $inRaw
Write-Host ""
Add-Assertion -Case "in-corpus-live" -Type "exact-match" -Label "HTTP 200" -Ok:($inStatus -eq 200) -Detail "status=$inStatus"
$inJson = $null; try { $inJson = $inRaw | ConvertFrom-Json -Depth 100 } catch {}
if ($null -ne $inJson) {
  $rs = [string]$inJson.retrievalSource
  $gs = [string]$inJson.generationSource
  $abst = [bool]$inJson.abstained
  Add-Assertion -Case "in-corpus-live" -Type "exact-match" -Label "retrievalSource == supabase (live store ran)" -Ok:($rs -eq "supabase") -Detail "got '$rs'"
  Add-Assertion -Case "in-corpus-live" -Type "exact-match" -Label "generationSource is ollama or ollama-fallback" -Ok:($gs -eq "ollama" -or $gs -eq "ollama-fallback") -Detail "got '$gs'"
  Add-Assertion -Case "in-corpus-live" -Type "exact-match" -Label "abstained == false (in-corpus answers)" -Ok:($abst -eq $false) -Detail "abstained=$abst"
  $ans = if ($inJson.PSObject.Properties["answer"] -and $null -ne $inJson.answer) { [string]$inJson.answer } else { "" }
  Add-Assertion -Case "in-corpus-live" -Type "exact-match" -Label "answer is non-empty" -Ok:($ans.Trim().Length -gt 0) -Detail "len=$($ans.Length)"
  $citeIds = @(Get-CiteIds -Resp $inJson)
  $topIds = @(Get-TopKIds -Resp $inJson)
  Add-Assertion -Case "in-corpus-live" -Type "citation-integrity" -Label ">= 1 citation" -Ok:($citeIds.Count -ge 1) -Detail "citations=$($citeIds.Count)"
  $orphans = @($citeIds | Where-Object { $topIds -notcontains $_ })
  Add-Assertion -Case "in-corpus-live" -Type "citation-integrity" -Label "every citation.chunkId in retrieval.topK (LIVE)" -Ok:($orphans.Count -eq 0) -Detail $(if ($orphans.Count -gt 0) { "orphans: $($orphans -join ', ')" } else { "topK=[$($topIds -join ', ')] cites=[$($citeIds -join ', ')]" })
  Add-Assertion -Case "in-corpus-live" -Type "exact-match" -Label "passed == true" -Ok:([bool]$inJson.passed -eq $true) -Detail "passed=$([bool]$inJson.passed)"
}

# --- (b) OUT-OF-CORPUS live: supabase retrieval below threshold -> clean abstain -----------------
Write-Host "=== (b) OUT-OF-CORPUS  retrievalSource:supabase generationSource:ollama ==="
$outBody = @{ requestId = "rag-live-out-of-corpus"; query = $OutOfCorpusQuery; retrievalSource = "supabase"; generationSource = "ollama"; threshold = 0.6 } | ConvertTo-Json -Depth 6
$outResp = Invoke-Live -Body $outBody
$outStatus = [int]$outResp.StatusCode
$outRaw = [string]$outResp.Content
Write-Host "HTTP $outStatus"
Write-Host $outRaw
Write-Host ""
Add-Assertion -Case "out-of-corpus-live" -Type "exact-match" -Label "HTTP 200" -Ok:($outStatus -eq 200) -Detail "status=$outStatus"
$outJson = $null; try { $outJson = $outRaw | ConvertFrom-Json -Depth 100 } catch {}
if ($null -ne $outJson) {
  $abst = [bool]$outJson.abstained
  $rs = [string]$outJson.retrievalSource
  $ansNull = (-not $outJson.PSObject.Properties["answer"]) -or ($null -eq $outJson.answer)
  $citeCount = if ($outJson.PSObject.Properties["citations"]) { @($outJson.citations).Count } else { -1 }
  Add-Assertion -Case "out-of-corpus-live" -Type "clean-abstain" -Label "abstained:true AND answer null AND citations []" -Ok:($abst -eq $true -and $ansNull -and $citeCount -eq 0) -Detail "abstained=$abst answerNull=$ansNull citations=$citeCount"
  Add-Assertion -Case "out-of-corpus-live" -Type "exact-match" -Label "retrievalSource reflects live store (supabase/supabase-fallback)" -Ok:($rs -eq "supabase" -or $rs -eq "supabase-fallback") -Detail "got '$rs'"
  Add-Assertion -Case "out-of-corpus-live" -Type "exact-match" -Label "passed == true (clean abstain is a pass)" -Ok:([bool]$outJson.passed -eq $true) -Detail "passed=$([bool]$outJson.passed)"
}

Write-Host ""
$assertions | Format-Table -AutoSize | Out-String | Write-Host
$passCount = @($assertions | Where-Object { $_.Result -eq "PASS" }).Count
$failCount = @($assertions | Where-Object { $_.Result -eq "FAIL" }).Count

if ($anyFail) {
  [Console]::Error.WriteLine("ERROR: LIVE RAG verification failed ($failCount failing / $($assertions.Count) assertions).")
  exit 1
}
Write-Host "LIVE RAG verification passed ($passCount assertions; real Supabase pgvector + Ollama)."
exit 0
