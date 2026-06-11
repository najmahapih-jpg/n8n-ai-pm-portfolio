# Update-Subtrees.ps1 — sync this publish-mirror monorepo from the local per-project repositories.
# The 10 project repos under C:\Dev\Projects remain the day-to-day source of truth (their hooks,
# gates and deploy scripts are untouched); this monorepo is assembled/refreshed from them via
# git subtree so the full per-project history is preserved.
#
# Usage:  pwsh -File scripts/Update-Subtrees.ps1            # pull latest main from every project
#         pwsh -File scripts/Update-Subtrees.ps1 -Only n8n-rag-knowledge-assistant
param(
  [string]$Only = "",
  [string]$SourceRoot = "C:\Dev\Projects",
  [string]$Branch = "main"
)
$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$projects = @(
  "n8n-llm-eval-harness", "n8n-rag-knowledge-assistant", "n8n-scheduled-drift-monitor",
  "n8n-interaction-gateway", "n8n-autonomous-agent", "n8n-feishu-adapter",
  "n8n-product-feedback-intelligence", "n8n-lead-intelligence-workflow",
  "n8n-contract-test-runner", "n8n-workflow-as-code"
)
if ($Only) { $projects = $projects | Where-Object { $_ -eq $Only }; if (-not $projects) { throw "unknown project: $Only" } }

foreach ($p in $projects) {
  $src = Join-Path $SourceRoot $p
  if (-not (Test-Path (Join-Path $src ".git"))) { Write-Warning "skip $p (no git repo at $src)"; continue }
  $dirty = git -C $src status --porcelain
  if ($dirty) { Write-Warning "skip $p (source repo has uncommitted changes)"; continue }
  Write-Host "==> syncing $p"
  # no --squash: keep the full per-project history in the mirror
  git -C $repoRoot subtree pull --prefix=$p $src $Branch -m "sync($p): subtree pull from local repo"
  if ($LASTEXITCODE -ne 0) { throw "subtree pull failed for $p" }
}
Write-Host "done."
