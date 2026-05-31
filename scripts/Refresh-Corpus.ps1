<#
.SYNOPSIS
  Refresh the LIVE Supabase pgvector corpus from the in-repo source files + print a STALENESS REPORT.

.DESCRIPTION
  Operational refresh for the v0.3.0 zh "AI 时代产品经理" corpus. It (1) re-reads every chunk from
  fixtures/corpus/*.md (parsing each `> 来源:` line into source + url + retrievedAt), (2) prints a
  STALENESS REPORT — each chunk's retrievedAt age in days, FLAGGING any chunk older than -StaleAfterDays
  (default 90) — and (3) (unless -ReportOnly) re-embeds + UPSERTS all chunks to Supabase `documents` by
  delegating to scripts/Ingest-Corpus.ps1 (the single source of truth for the embed/upsert path, which
  DELETEs each chunkId then re-inserts — idempotent). The in-workflow stub CORPUS constant is a PINNED
  snapshot and is deliberately NOT touched here, so CI stays reproducible; only the LIVE store is refreshed.

  SOURCE ALLOWLIST (the authoritative domains the corpus is curated from — provenance for every chunk's
  `> 来源:` url must come from one of these; anything else should be reviewed before it enters the corpus):
    - svpg.com                  (Marty Cagan / Silicon Valley Product Group)
    - lennysnewsletter.com      (Lenny Rachitsky / Aman Khan guest essays)
    - institutepm.com           (InstitutePM knowledge hub)
    - woshipm.com               (人人都是产品经理 — 黄钊 hanniman)
    - time.geekbang.org         (极客时间 — 刘海丰《成为 AI 产品经理》)
    - docs.feishu.cn            (俞军《俞军产品方法论》notes)
    - github.com/mlabonne       (Hugging Face LLM course / Ragas / DeepEval references)

  NOTE: this refresh re-embeds the CURRENT in-repo chunk text (the source of truth is the .md files).
  AUTOMATED web-fetch refresh — re-fetching each source URL, diffing, and updating the .md provenance —
  is DEFERRED to Project D (the scheduled-ingestion project). Today this is a manual, allowlist-curated
  refresh: edit the .md files from the allowlisted sources, then run this to re-embed + report staleness.

.NOTES
  Secrets (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) are read by Ingest-Corpus.ps1 from .env (gitignored)
  or the environment. Non-browser User-Agent + 768-dim nomic-embed-text-v2-moe "search_document: " prefix
  are all handled inside Ingest-Corpus.ps1. This script adds the staleness report + allowlist framing.
#>
param(
  [string]$CorpusDirectory = "",
  [int]$StaleAfterDays = 90,
  [string]$AsOf = "",
  [switch]$ReportOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($CorpusDirectory)) { $CorpusDirectory = Join-Path $repoRoot "fixtures\corpus" }

# "As of" date for the age calculation (default: now). Allows a deterministic report in tests.
$asOfDate = if (-not [string]::IsNullOrWhiteSpace($AsOf)) { [datetime]::Parse($AsOf) } else { (Get-Date) }

$corpusFiles = @(Get-ChildItem -LiteralPath $CorpusDirectory -Filter *.md -File | Sort-Object Name)
if ($corpusFiles.Count -eq 0) {
  [Console]::Error.WriteLine("ERROR: no corpus .md files in $CorpusDirectory.")
  exit 2
}

# Parse a `> 来源:<title>。<https url> · 检索 <date>` provenance line into { source, url, retrievedAt }.
# Identical contract to Ingest-Corpus.ps1's parser (kept in sync); used here only for the report.
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
  $source = $body
  if ($um.Success) { $source = $body.Substring(0, $um.Index) }
  $source = ($source -replace '检索\s*\d{4}-\d{2}-\d{2}.*$', '')
  $source = $source.Trim().TrimEnd('。', '.', '·', ';', '；', ',', '，').Trim()
  return [pscustomobject]@{ source = $source; url = $url; retrievedAt = $retrievedAt }
}

# Collect { chunkId, source, url, retrievedAt } for every chunk (mirrors Ingest-Corpus.ps1's parse).
$rows = New-Object System.Collections.Generic.List[object]
foreach ($file in $corpusFiles) {
  $lines = Get-Content -LiteralPath $file.FullName
  $fileDate = ""
  foreach ($l in $lines) {
    $fm = [regex]::Match($l, 'retrievedAt[:：]\s*(?<d>\d{4}-\d{2}-\d{2})')
    if ($fm.Success) { $fileDate = $fm.Groups['d'].Value; break }
  }
  $currentId = $null
  $srcLine = $null
  foreach ($line in $lines) {
    $m = [regex]::Match($line, '^\s*###\s+chunk:(?<id>[A-Za-z0-9\-]+)\s*$')
    if ($m.Success) {
      if ($null -ne $currentId) {
        $p = if ($srcLine) { Parse-Provenance -Line $srcLine -FallbackDate $fileDate } else { [pscustomobject]@{ source = $file.Name; url = ""; retrievedAt = $fileDate } }
        $rows.Add([pscustomobject]@{ chunkId = $currentId; source = $p.source; url = $p.url; retrievedAt = $p.retrievedAt; file = $file.Name }) | Out-Null
      }
      $currentId = $m.Groups['id'].Value
      $srcLine = $null
    } elseif ($null -ne $currentId -and $line -match '^\s*>\s*来源[:：]') {
      $srcLine = $line
    }
  }
  if ($null -ne $currentId) {
    $p = if ($srcLine) { Parse-Provenance -Line $srcLine -FallbackDate $fileDate } else { [pscustomobject]@{ source = $file.Name; url = ""; retrievedAt = $fileDate } }
    $rows.Add([pscustomobject]@{ chunkId = $currentId; source = $p.source; url = $p.url; retrievedAt = $p.retrievedAt; file = $file.Name }) | Out-Null
  }
}

# --- STALENESS REPORT --------------------------------------------------------------------------
Write-Host "=== Corpus staleness report (as of $($asOfDate.ToString('yyyy-MM-dd')); stale if age > ${StaleAfterDays}d) ==="
Write-Host ("{0,-22} {1,-12} {2,8}  {3,-6} {4}" -f "chunkId", "retrievedAt", "ageDays", "stale", "url")
Write-Host ("-" * 110)
$staleCount = 0
$report = New-Object System.Collections.Generic.List[object]
foreach ($r in $rows) {
  $ageDays = ""
  $stale = $false
  if (-not [string]::IsNullOrWhiteSpace($r.retrievedAt)) {
    [datetime]$d = [datetime]::MinValue
    $parsed = [datetime]::TryParse([string]$r.retrievedAt, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$d)
    if ($parsed) {
      $ageDays = [int]([math]::Floor(($asOfDate - $d).TotalDays))
      $stale = ($ageDays -gt $StaleAfterDays)
    }
  }
  if ($stale) { $staleCount += 1 }
  $flag = if ($stale) { "STALE" } else { "ok" }
  Write-Host ("{0,-22} {1,-12} {2,8}  {3,-6} {4}" -f $r.chunkId, $r.retrievedAt, $ageDays, $flag, $r.url)
  $report.Add([pscustomobject]@{ chunkId = $r.chunkId; retrievedAt = $r.retrievedAt; ageDays = $ageDays; stale = $stale; source = $r.source; url = $r.url }) | Out-Null
}
Write-Host ("-" * 110)
Write-Host ("Chunks: $($rows.Count)   Stale (> ${StaleAfterDays}d): $staleCount")
if ($staleCount -gt 0) {
  Write-Host "NOTE: $staleCount chunk(s) exceed the freshness window. Re-curate them from the allowlisted sources"
  Write-Host "      (see this script's header), update the .md `> 来源:` retrievedAt, then re-run to re-embed."
}
Write-Host ""

if ($ReportOnly) {
  Write-Host "ReportOnly: skipping the Supabase re-embed/upsert. (Run without -ReportOnly to refresh the live store.)"
  exit 0
}

# --- RE-EMBED + UPSERT (delegate to Ingest-Corpus.ps1 — single source of truth for the write path) ---
Write-Host "=== Re-embed + upsert to Supabase (via Ingest-Corpus.ps1) ==="
& (Join-Path $PSScriptRoot "Ingest-Corpus.ps1") -CorpusDirectory $CorpusDirectory
$ingestExit = $LASTEXITCODE
if ($ingestExit -ne 0) {
  [Console]::Error.WriteLine("ERROR: Ingest-Corpus.ps1 (re-embed/upsert) failed with exit $ingestExit.")
  exit $ingestExit
}

Write-Host ""
Write-Host "Refresh complete: live Supabase corpus re-embedded from fixtures/corpus/*.md; staleness reported above."
Write-Host "(The in-workflow stub CORPUS constant is a pinned snapshot and was intentionally left unchanged.)"
exit 0
