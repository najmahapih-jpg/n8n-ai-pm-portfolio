param(
  [string]$CanonicalDirectory = ".\workflows\canonical",
  [string]$MetaDirectory = ".\workflows\sdk",
  [string]$RegistryPath = ".\docs\registry\workflow-registry.md",
  [string]$IndexPath = ".\docs\registry\index.json",
  [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function ConvertTo-RelativePath {
  param(
    [string]$BasePath,
    [string]$Path
  )

  $baseUri = [System.Uri]((Resolve-Path -LiteralPath $BasePath).Path.TrimEnd("\") + "\")
  $pathUri = [System.Uri]((Resolve-Path -LiteralPath $Path).Path)
  return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($pathUri).ToString()).Replace("/", "\")
}

function Escape-MarkdownCell {
  param([object]$Value)

  if ($null -eq $Value) {
    return ""
  }

  return ([string]$Value).Replace("|", "\|").Replace("`r", " ").Replace("`n", " ")
}

function Get-WorkflowComplexity {
  param([int]$NodeCount)

  if ($NodeCount -ge 25) {
    return "advanced"
  }
  if ($NodeCount -ge 12) {
    return "intermediate"
  }
  return "basic"
}

function Get-ArrayValue {
  param(
    [object]$Object,
    [string]$Name
  )

  if ($null -eq $Object -or -not $Object.PSObject.Properties[$Name] -or $null -eq $Object.PSObject.Properties[$Name].Value) {
    return @()
  }

  return @($Object.PSObject.Properties[$Name].Value)
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$canonicalRoot = Resolve-Path -LiteralPath $CanonicalDirectory
$metaRoot = Resolve-Path -LiteralPath $MetaDirectory

$canonicalFiles = @(Get-ChildItem -LiteralPath $canonicalRoot -Filter *.json -File | Sort-Object Name)
if ($canonicalFiles.Count -eq 0) {
  Write-Error "No canonical workflow JSON files found in $CanonicalDirectory"
  exit 2
}

$entries = foreach ($canonicalFile in $canonicalFiles) {
  $workflow = Get-Content -LiteralPath $canonicalFile.FullName -Raw | ConvertFrom-Json -Depth 100
  $slug = $canonicalFile.BaseName -replace '\.canonical$', ''
  $metaPath = Join-Path $metaRoot "$slug.meta.json"
  $meta = $null
  if (Test-Path -LiteralPath $metaPath -PathType Leaf) {
    $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json -Depth 100
  }

  $nodes = @($workflow.nodes)
  $nodeTypes = @($nodes | ForEach-Object { [string]$_.type } | Sort-Object -Unique)
  $triggerTypes = @($nodeTypes | Where-Object { $_ -match '(?i)(webhook|trigger)' })
  $release = if ($meta -and $meta.PSObject.Properties["release"]) { [string]$meta.release } else { "" }
  $releasePath = if (-not [string]::IsNullOrWhiteSpace($release)) { Join-Path "workflows\releases" $release } else { "" }

  [pscustomobject][ordered]@{
    slug = if ($meta -and $meta.PSObject.Properties["slug"]) { [string]$meta.slug } else { $slug }
    title = if ($meta -and $meta.PSObject.Properties["title"]) { [string]$meta.title } else { [string]$workflow.name }
    description = if ($meta -and $meta.PSObject.Properties["description"]) { [string]$meta.description } else { [string]$workflow.description }
    owner = if ($meta -and $meta.PSObject.Properties["owner"]) { [string]$meta.owner } else { "" }
    department = if ($meta -and $meta.PSObject.Properties["department"]) { [string]$meta.department } else { "" }
    version = if ($meta -and $meta.PSObject.Properties["version"]) { [string]$meta.version } else { "" }
    status = if ($meta -and $meta.PSObject.Properties["status"]) { [string]$meta.status } else { "unknown" }
    project = if ($meta -and $meta.PSObject.Properties["project"]) { [string]$meta.project } else { "" }
    lastWriter = if ($meta -and $meta.PSObject.Properties["lastWriter"]) { [string]$meta.lastWriter } else { "" }
    n8nWorkflowId = if ($meta -and $meta.PSObject.Properties["n8nWorkflowId"]) { [string]$meta.n8nWorkflowId } else { "" }
    source = if ($meta -and $meta.PSObject.Properties["source"]) { Join-Path "workflows\sdk" ([string]$meta.source) } else { "" }
    canonical = ConvertTo-RelativePath -BasePath $repoRoot -Path $canonicalFile.FullName
    release = $releasePath
    request = if ($meta -and $meta.PSObject.Properties["request"]) { Join-Path "fixtures\requests" ([string]$meta.request) } else { "" }
    trigger = if ($meta -and $meta.PSObject.Properties["trigger"]) { [string]$meta.trigger } elseif ($triggerTypes.Count -gt 0) { $triggerTypes -join ", " } else { "" }
    integrations = [string[]]@(Get-ArrayValue -Object $meta -Name "integrations")
    tags = [string[]]@(Get-ArrayValue -Object $meta -Name "tags")
    fixtures = [string[]]@(Get-ArrayValue -Object $meta -Name "fixtures")
    smokeCases = [string[]]@(Get-ArrayValue -Object $meta -Name "smokeCases")
    localOnly = if ($meta -and $meta.PSObject.Properties["localOnly"]) { [bool]$meta.localOnly } else { $true }
    nodeCount = $nodes.Count
    nodeTypes = [string[]]@($nodeTypes)
    complexity = Get-WorkflowComplexity -NodeCount $nodes.Count
    notes = if ($meta -and $meta.PSObject.Properties["notes"]) { [string]$meta.notes } else { "" }
  }
}

$index = [pscustomobject][ordered]@{
  schemaVersion = 1
  generator = "scripts/Build-WorkflowIndex.ps1"
  workflowCount = @($entries).Count
  workflows = @($entries)
}

$markdownLines = New-Object System.Collections.Generic.List[string]
$markdownLines.Add("# Workflow Registry") | Out-Null
$markdownLines.Add("") | Out-Null
$markdownLines.Add("Generated from canonical workflow JSON and per-workflow metadata. Do not edit table rows by hand; run `pwsh -NoProfile -File .\scripts\Build-WorkflowIndex.ps1`.") | Out-Null
$markdownLines.Add("") | Out-Null
$markdownLines.Add("| Workflow | Version | Status | Trigger | Nodes | Complexity | Integrations | Release | Smoke |") | Out-Null
$markdownLines.Add("| --- | --- | --- | --- | ---: | --- | --- | --- | --- |") | Out-Null

foreach ($entry in @($entries | Sort-Object slug)) {
  $releaseCell = if ([string]::IsNullOrWhiteSpace($entry.release)) { "" } else { '`' + $entry.release + '`' }
  $smokeCases = @($entry.smokeCases)
  $integrations = @($entry.integrations)
  $smokeCell = if ($smokeCases.Count -eq 0) { "" } else { ($smokeCases | ForEach-Object { '`' + $_ + '`' }) -join ", " }
  $integrationsCell = if ($integrations.Count -eq 0) { "" } else { $integrations -join ", " }
  $markdownLines.Add("| $(Escape-MarkdownCell $entry.title) | $(Escape-MarkdownCell $entry.version) | $(Escape-MarkdownCell $entry.status) | $(Escape-MarkdownCell $entry.trigger) | $($entry.nodeCount) | $(Escape-MarkdownCell $entry.complexity) | $(Escape-MarkdownCell $integrationsCell) | $(Escape-MarkdownCell $releaseCell) | $(Escape-MarkdownCell $smokeCell) |") | Out-Null
}

$markdown = ($markdownLines -join [Environment]::NewLine) + [Environment]::NewLine
$json = ($index | ConvertTo-Json -Depth 100) + [Environment]::NewLine

if ($Check) {
  $expectedRegistry = if (Test-Path -LiteralPath $RegistryPath -PathType Leaf) { Get-Content -LiteralPath $RegistryPath -Raw } else { "" }
  $expectedIndex = if (Test-Path -LiteralPath $IndexPath -PathType Leaf) { Get-Content -LiteralPath $IndexPath -Raw } else { "" }
  if ($expectedRegistry -ne $markdown -or $expectedIndex -ne $json) {
    Write-Error "Workflow registry is stale. Run scripts/Build-WorkflowIndex.ps1 and commit the generated files."
    exit 1
  }

  Write-Host "Workflow registry is up to date."
  exit 0
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $RegistryPath) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $IndexPath) | Out-Null
[System.IO.File]::WriteAllText((Resolve-Path -LiteralPath (Split-Path -Parent $RegistryPath)).Path + [System.IO.Path]::DirectorySeparatorChar + (Split-Path -Leaf $RegistryPath), $markdown, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText((Resolve-Path -LiteralPath (Split-Path -Parent $IndexPath)).Path + [System.IO.Path]::DirectorySeparatorChar + (Split-Path -Leaf $IndexPath), $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Generated $RegistryPath and $IndexPath for $(@($entries).Count) workflow(s)."
exit 0
