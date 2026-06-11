param(
  [string]$ProjectsRoot = "",
  [switch]$Live
)

# Test-PortfolioContracts.ps1 — run the offline contract gate over EVERY sibling n8n-* repo that has a
# docs/workflow-contract.md. Repos that have not yet adopted a `## Machine-readable contract` block are
# SKIPped honestly (not failed). Any ADOPTED repo whose contract fails to conform fails the whole gate.
# This is the portfolio-wide CI gate (offline by default; -Live forwards to per-repo opt-in live mode).

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$runnerRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($ProjectsRoot)) { $ProjectsRoot = (Resolve-Path -LiteralPath (Join-Path $runnerRoot "..")).Path }
$runner = Join-Path $runnerRoot "scripts\Test-Contract.ps1"

$siblings = @(Get-ChildItem -LiteralPath $ProjectsRoot -Directory | Where-Object {
  $_.Name -like "n8n-*" -and $_.Name -ne "n8n-contract-test-runner" -and (Test-Path -LiteralPath (Join-Path $_.FullName "docs\workflow-contract.md"))
} | Sort-Object Name)

Write-Host "Portfolio contract gate over $ProjectsRoot ($($siblings.Count) sibling repo(s))"
Write-Host ""

$adopted = 0; $skipped = 0; $failed = 0
foreach ($s in $siblings) {
  $md = Join-Path $s.FullName "docs\workflow-contract.md"
  if (-not (Select-String -Path $md -Pattern "##\s*Machine-readable contract" -Quiet)) {
    Write-Host ("[SKIP] {0} — no `## Machine-readable contract` block adopted yet" -f $s.Name)
    $skipped++
    continue
  }
  $runParams = @{ RepoPath = $s.FullName }
  if ($Live) { $runParams.Live = $true }
  & $runner @runParams *> $null
  if ($LASTEXITCODE -eq 0) {
    Write-Host ("[PASS] {0}" -f $s.Name)
    $adopted++
  } else {
    Write-Host ("[FAIL] {0} — rerun for detail: npm run contract -- -RepoPath `"{1}`"" -f $s.Name, $s.FullName)
    $failed++
  }
}

Write-Host ""
Write-Host ("Portfolio contracts: {0} passed, {1} not-yet-adopted, {2} failed (of {3})" -f $adopted, $skipped, $failed, $siblings.Count)
if ($failed -gt 0) { [Console]::Error.WriteLine("ERROR: $failed adopted contract(s) failed conformance."); exit 1 }
exit 0
