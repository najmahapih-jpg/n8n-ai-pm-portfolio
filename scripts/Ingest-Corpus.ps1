<#
.SYNOPSIS
  Ingest the fixed in-repo corpus into the live Supabase pgvector `documents` table.

.DESCRIPTION
  Live-path bootstrap (v0.3.0 zh "AI 时代产品经理" corpus). For each `### chunk:<id>` chunk in
  fixtures/corpus/*.md:
    1) embed the chunk text via local Ollama /api/embeddings (model nomic-embed-text-v2-moe, 768-dim,
       with the "search_document: " task prefix the v2 model expects on the corpus side), then
    2) upsert it into Supabase `documents` (content = chunk text, metadata =
       {chunkId, source, url, retrievedAt}, embedding = the 768 vector) via the Supabase REST API.
       source/url/retrievedAt are PROVENANCE parsed from each chunk's `> 来源:` line (citation title +
       https URL + 检索 date), so the LIVE citation can name the real authoritative source + link — the
       SAME provenance the in-workflow stub CORPUS constant carries. This is the contract the
       'Map Supabase Retrieval' node reads (metadata.{chunkId,source,url}).

  This is a LOCAL, opt-in, one-time bootstrap (NOT part of CI / verify:live). The stub-default core
  needs none of this. Embeddings are local + free; Supabase Free tier is free.

  GOTCHA (verified): Supabase `sb_secret_` keys are rejected with HTTP 401
  "Forbidden use of secret API key in browser" when the request carries a browser-like User-Agent.
  Every Supabase call here therefore sends `User-Agent: n8n`.

  Idempotent: existing rows for the corpus chunkIds are DELETEd first, then re-inserted, so re-running
  converges on exactly one row per chunk (the table has no unique constraint on metadata->>chunkId).

.NOTES
  Secrets: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are read from .env (gitignored) or the environment.
  The service_role/secret key bypasses RLS; it lives in .env only and is never committed.
#>
param(
  [string]$CorpusDirectory = "",
  [string]$SupabaseUrl = $env:SUPABASE_URL,
  [string]$SupabaseKey = $env:SUPABASE_SERVICE_ROLE_KEY,
  [string]$OllamaUrl = $env:OLLAMA_URL,
  [string]$EmbedModel = $env:OLLAMA_EMBED_MODEL,
  [string]$Table = "documents",
  [int]$ExpectedDimensions = 768
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

# --- Resolve config (param > env > .env file > default) ---------------------------------------
function Get-DotEnvValue {
  param([string]$Name)
  $envFile = Join-Path $repoRoot ".env"
  if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { return "" }
  $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } | Select-Object -First 1
  if ($null -eq $line) { return "" }
  return ($line -replace "^\s*$([regex]::Escape($Name))\s*=\s*", "").Trim()
}

if ([string]::IsNullOrWhiteSpace($SupabaseUrl)) { $SupabaseUrl = Get-DotEnvValue -Name "SUPABASE_URL" }
if ([string]::IsNullOrWhiteSpace($SupabaseKey)) { $SupabaseKey = Get-DotEnvValue -Name "SUPABASE_SERVICE_ROLE_KEY" }
if ([string]::IsNullOrWhiteSpace($OllamaUrl)) {
  $OllamaUrl = Get-DotEnvValue -Name "OLLAMA_URL"
  if ([string]::IsNullOrWhiteSpace($OllamaUrl)) { $OllamaUrl = "http://localhost:11434" }
}
if ([string]::IsNullOrWhiteSpace($EmbedModel)) {
  $EmbedModel = Get-DotEnvValue -Name "OLLAMA_EMBED_MODEL"
  if ([string]::IsNullOrWhiteSpace($EmbedModel)) { $EmbedModel = "nomic-embed-text-v2-moe" }
}
if ([string]::IsNullOrWhiteSpace($CorpusDirectory)) { $CorpusDirectory = Join-Path $repoRoot "fixtures\corpus" }

$SupabaseUrl = $SupabaseUrl.TrimEnd("/")
$OllamaUrl = $OllamaUrl.TrimEnd("/")

if ([string]::IsNullOrWhiteSpace($SupabaseUrl) -or [string]::IsNullOrWhiteSpace($SupabaseKey)) {
  [Console]::Error.WriteLine("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (param, env, or .env).")
  exit 2
}

Write-Host "Corpus dir : $CorpusDirectory"
Write-Host "Supabase   : $SupabaseUrl  (table=$Table)"
Write-Host "Ollama     : $OllamaUrl  (embed=$EmbedModel, expect ${ExpectedDimensions}d)"
Write-Host ""

# --- Parse the corpus into { chunkId, source, url, retrievedAt, text } -------------------------
# Source of truth: each `### chunk:<id>` heading begins a chunk; its body is the following non-blank
# prose up to the next heading. Its `> 来源:` line is the authoritative PROVENANCE (citation title +
# https URL + 检索 date). Mirrors the in-workflow CORPUS constant (which is derived verbatim + carries
# source + url). The file-header blockquote's `retrievedAt: <date>` is the per-file fallback date.
$corpusFiles = @(Get-ChildItem -LiteralPath $CorpusDirectory -Filter *.md -File | Sort-Object Name)
if ($corpusFiles.Count -eq 0) {
  [Console]::Error.WriteLine("ERROR: no corpus .md files in $CorpusDirectory.")
  exit 2
}

# Parse a `> 来源:<title>。<https url> · 检索 <date>` provenance line into { source, url, retrievedAt }.
# Robust to full-width/half-width punctuation: url = the first http(s) token; source = the text before
# it (trailing 。/period + separators trimmed); retrievedAt = the date after 检索 (yyyy-mm-dd), else "".
function Parse-Provenance {
  param([string]$Line, [string]$FallbackDate)
  $body = ($Line -replace '^\s*>\s*', '').Trim()
  $body = ($body -replace '^来源[:：]\s*', '')
  $url = ""
  $um = [regex]::Match($body, 'https?://[^\s·।,，)）]+')
  if ($um.Success) { $url = $um.Value.TrimEnd('.', '。', '·', ',', '，') }
  $retrievedAt = $FallbackDate
  $dm = [regex]::Match($body, '检索\s*(?<d>\d{4}-\d{2}-\d{2})')
  if ($dm.Success) { $retrievedAt = $dm.Groups['d'].Value }
  # source = everything up to the url (or the 检索 marker if no url), trimmed of trailing punctuation.
  $source = $body
  if ($um.Success) { $source = $body.Substring(0, $um.Index) }
  $source = ($source -replace '检索\s*\d{4}-\d{2}-\d{2}.*$', '')
  $source = $source.Trim().TrimEnd('。', '.', '·', ';', '；', ',', '，').Trim()
  return [pscustomobject]@{ source = $source; url = $url; retrievedAt = $retrievedAt }
}

$chunks = New-Object System.Collections.Generic.List[object]
foreach ($file in $corpusFiles) {
  $lines = Get-Content -LiteralPath $file.FullName
  # Per-file fallback retrievedAt from the header blockquote (`retrievedAt: yyyy-mm-dd`).
  $fileDate = ""
  foreach ($l in $lines) {
    $fm = [regex]::Match($l, 'retrievedAt[:：]\s*(?<d>\d{4}-\d{2}-\d{2})')
    if ($fm.Success) { $fileDate = $fm.Groups['d'].Value; break }
  }
  $currentId = $null
  $buffer = New-Object System.Collections.Generic.List[string]
  $currentSourceLine = $null
  function Flush-Chunk {
    param([string]$Id, [System.Collections.Generic.List[string]]$Body, [string]$FileName, [string]$SourceLine, [string]$FileDate)
    if ([string]::IsNullOrWhiteSpace($Id)) { return }
    $text = (($Body | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join " ").Trim()
    if ($text.Length -eq 0) { return }
    $prov = if (-not [string]::IsNullOrWhiteSpace($SourceLine)) { Parse-Provenance -Line $SourceLine -FallbackDate $FileDate } else { [pscustomobject]@{ source = $FileName; url = ""; retrievedAt = $FileDate } }
    $src = if (-not [string]::IsNullOrWhiteSpace($prov.source)) { $prov.source } else { $FileName }
    $script:chunks.Add([pscustomobject]@{ chunkId = $Id; source = $src; url = $prov.url; retrievedAt = $prov.retrievedAt; text = $text }) | Out-Null
  }
  foreach ($line in $lines) {
    $m = [regex]::Match($line, '^\s*###\s+chunk:(?<id>[A-Za-z0-9\-]+)\s*$')
    if ($m.Success) {
      Flush-Chunk -Id $currentId -Body $buffer -FileName $file.Name -SourceLine $currentSourceLine -FileDate $fileDate
      $currentId = $m.Groups['id'].Value
      $buffer = New-Object System.Collections.Generic.List[string]
      $currentSourceLine = $null
    } elseif ($null -ne $currentId) {
      # Capture the chunk's `> 来源:` provenance line; skip all other blockquote notes + headings.
      if ($line -match '^\s*>\s*来源[:：]') {
        $currentSourceLine = $line
      } elseif ($line -notmatch '^\s*>' -and $line -notmatch '^\s*#') {
        $buffer.Add($line) | Out-Null
      }
    }
  }
  Flush-Chunk -Id $currentId -Body $buffer -FileName $file.Name -SourceLine $currentSourceLine -FileDate $fileDate
}

if ($chunks.Count -eq 0) {
  [Console]::Error.WriteLine("ERROR: parsed 0 chunks from corpus.")
  exit 2
}
Write-Host "Parsed $($chunks.Count) chunk(s): $(($chunks | ForEach-Object { $_.chunkId }) -join ', ')"
Write-Host ""

# --- HTTP helpers (HttpClient so we can set the Range header Supabase wants without PS validation) ---
Add-Type -AssemblyName System.Net.Http

function Invoke-Supabase {
  param(
    [string]$Method,
    [string]$PathAndQuery,
    [string]$JsonBody = $null,
    [hashtable]$ExtraHeaders = @{}
  )
  # Use Invoke-WebRequest (PowerShell's web stack) rather than a raw HttpClient: in proxied environments the
  # raw HttpClient POST-with-body can fail where the cmdlet succeeds. -SkipHeaderValidation lets us set the
  # `Range` header Supabase wants for an exact count; -SkipHttpErrorCheck returns 4xx/5xx as a normal response.
  $headers = @{ "User-Agent" = "n8n"; "apikey" = $SupabaseKey; "Authorization" = "Bearer $SupabaseKey" }
  foreach ($k in $ExtraHeaders.Keys) { $headers[$k] = [string]$ExtraHeaders[$k] }
  $params = @{
    Uri = "$SupabaseUrl$PathAndQuery"; Method = $Method; Headers = $headers
    SkipHttpErrorCheck = $true; SkipHeaderValidation = $true; TimeoutSec = 60
  }
  if ($null -ne $JsonBody) { $params["Body"] = $JsonBody; $params["ContentType"] = "application/json" }
  $resp = Invoke-WebRequest @params
  $contentRange = $null
  if ($resp.Headers.ContainsKey("Content-Range")) { $contentRange = (@($resp.Headers["Content-Range"]) -join ",") }
  return [pscustomobject]@{
    StatusCode = [int]$resp.StatusCode
    Body = [string]$resp.Content
    ContentRange = $contentRange
  }
}

function Get-DocumentCount {
  $r = Invoke-Supabase -Method "GET" -PathAndQuery "/rest/v1/${Table}?select=id" -ExtraHeaders @{ "Prefer" = "count=exact"; "Range" = "0-0"; "Range-Unit" = "items" }
  if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300 -and $r.ContentRange) {
    # Content-Range looks like "0-0/8" or "*/0".
    $parts = $r.ContentRange.Split("/")
    if ($parts.Count -eq 2 -and $parts[1] -match '^\d+$') { return [int]$parts[1] }
  }
  return -1
}

# --- Embedding via Ollama ---------------------------------------------------------------------
function Get-Embedding {
  param([string]$Text)
  $body = @{ model = $EmbedModel; prompt = $Text } | ConvertTo-Json -Depth 5
  $resp = Invoke-RestMethod -Uri "$OllamaUrl/api/embeddings" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 120
  if ($null -eq $resp.embedding) { throw "Ollama returned no embedding for a chunk." }
  return @($resp.embedding)
}

# --- Ingest -----------------------------------------------------------------------------------
$before = Get-DocumentCount
Write-Host "documents count BEFORE: $before"

$chunkIds = @($chunks | ForEach-Object { $_.chunkId })
# 1) Idempotency: delete any existing rows whose metadata.chunkId is one we are about to (re)insert.
#    PostgREST filter on a jsonb path: metadata->>chunkId=in.(a,b,c)
$inList = "(" + ($chunkIds -join ",") + ")"
$delResp = Invoke-Supabase -Method "DELETE" -PathAndQuery "/rest/v1/${Table}?metadata->>chunkId=in.$inList" -ExtraHeaders @{ "Prefer" = "return=minimal" }
if ($delResp.StatusCode -ge 200 -and $delResp.StatusCode -lt 300) {
  Write-Host "Pre-delete of existing corpus chunkIds: HTTP $($delResp.StatusCode) (idempotent reset)"
} else {
  Write-Host "WARN pre-delete returned HTTP $($delResp.StatusCode): $($delResp.Body)"
}

# 2) Embed + insert each chunk.
#    nomic-embed-text-v2-moe is trained with TASK PREFIXES: the DOCUMENT/corpus side is embedded with a
#    "search_document: " prefix (the query side uses "search_query: ", set in the workflow). This
#    asymmetry is the intended usage of the v2 model and materially improves retrieval. The prefix is
#    applied ONLY to the embedding INPUT — the stored `content` stays the RAW chunk text so the grounded
#    answer/citation quotes remain verbatim spans of the corpus.
$inserted = 0
foreach ($chunk in $chunks) {
  $embedding = Get-Embedding -Text ("search_document: " + $chunk.text)
  if ($embedding.Count -ne $ExpectedDimensions) {
    [Console]::Error.WriteLine("ERROR: chunk '$($chunk.chunkId)' embedding has $($embedding.Count) dims, expected $ExpectedDimensions.")
    exit 3
  }
  $row = @{
    content = $chunk.text
    # Provenance carried so the LIVE citation names the real source + link (parity with the stub CORPUS).
    metadata = @{ chunkId = $chunk.chunkId; source = $chunk.source; url = $chunk.url; retrievedAt = $chunk.retrievedAt }
    embedding = $embedding
  }
  # Supabase pgvector accepts the embedding as a JSON number array on insert.
  $json = ConvertTo-Json -InputObject @($row) -Depth 6 -Compress
  $insResp = Invoke-Supabase -Method "POST" -PathAndQuery "/rest/v1/$Table" -JsonBody $json -ExtraHeaders @{ "Prefer" = "return=minimal" }
  if ($insResp.StatusCode -ge 200 -and $insResp.StatusCode -lt 300) {
    $inserted += 1
    Write-Host ("  inserted {0,-16} ({1} dims) from {2}" -f $chunk.chunkId, $embedding.Count, $chunk.source)
  } else {
    [Console]::Error.WriteLine("ERROR: insert of '$($chunk.chunkId)' returned HTTP $($insResp.StatusCode): $($insResp.Body)")
    exit 3
  }
}

Write-Host ""
$after = Get-DocumentCount
Write-Host "documents count AFTER: $after  (inserted this run: $inserted)"

if ($after -ne $chunks.Count) {
  [Console]::Error.WriteLine("ERROR: row count ($after) does not match corpus chunk count ($($chunks.Count)).")
  exit 3
}

Write-Host ""
Write-Host "Ingest complete: $after row(s) in '$Table' == $($chunks.Count) corpus chunk(s). 768-dim schema confirmed."
exit 0
