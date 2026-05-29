param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9]+(?:-[a-z0-9]+)*$')]
  [string]$Slug,
  [Parameter(Mandatory = $true)]
  [string]$Title,
  [string]$Description = "New local n8n workflow.",
  [string]$Owner = "portfolio",
  [string]$Department = "WorkflowOps",
  [string]$Version = "0.1.0",
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

function Write-NewFile {
  param(
    [string]$Path,
    [string]$Content
  )

  if ((Test-Path -LiteralPath $Path) -and -not $Force) {
    throw "Refusing to overwrite existing file without -Force: $Path"
  }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $Content | Set-Content -LiteralPath $Path -Encoding utf8
}

$sdkPath = Join-Path $repoRoot "workflows\sdk\$Slug.workflow.js"
$metaPath = Join-Path $repoRoot "workflows\sdk\$Slug.meta.json"
$requestPath = Join-Path $repoRoot "fixtures\requests\$Slug.md"
$fixturePath = Join-Path $repoRoot "fixtures\pin-data\$Slug-smoke.json"

$sdkTemplate = @"
import { workflow, node, trigger, sticky } from '@n8n/workflow-sdk';

const receiveRequest = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Receive Request',
    position: [0, 0],
    parameters: {
      httpMethod: 'POST',
      path: '$Slug',
      responseMode: 'responseNode',
      options: {
        allowedOrigins: '*'
      }
    }
  }
});

const buildResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Response',
    position: [320, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: ``const input = items[0]?.json ?? {};
return [{
  json: {
    statusCode: 200,
    response: {
      ok: true,
      workflow: '$Slug',
      receivedKeys: Object.keys(input)
    }
  }
}];``
    }
  },
  output: [{
    statusCode: 200,
    response: {
      ok: true,
      workflow: '$Slug'
    }
  }]
});

const returnResponse = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Return Response',
    position: [640, 0],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ `$json.response }}',
      options: {
        responseCode: '={{ `$json.statusCode }}'
      }
    }
  }
});

const overview = sticky(
  '## $Title\n$Description',
  [receiveRequest, buildResponse],
  { color: 4 }
);

export default workflow('$Slug', '$Title')
  .add(overview)
  .add(receiveRequest)
  .to(buildResponse)
  .to(returnResponse);
"@

$meta = [pscustomobject][ordered]@{
  slug = $Slug
  title = $Title
  description = $Description
  owner = $Owner
  department = $Department
  version = $Version
  status = "scaffolded"
  project = "Personal project / local draft"
  lastWriter = "not-created"
  n8nWorkflowId = ""
  release = "$Slug-v$Version.json"
  canonical = "$Slug.canonical.json"
  source = "$Slug.workflow.js"
  request = "$Slug.md"
  trigger = "webhook"
  integrations = @("n8n Webhook")
  tags = @("workflow-as-code", "scaffold")
  fixtures = @("$Slug-smoke.json")
  smokeCases = @("smoke")
  localOnly = $true
  notes = "Generated scaffold. Replace placeholder logic before release."
}

$requestTemplate = @"
# $Title

## Business Outcome

$Description

## Input Contract

- Method: POST
- Trigger path: `$Slug`
- Initial smoke fixture: `fixtures/pin-data/$Slug-smoke.json`

## Acceptance Criteria

- The workflow validates through official n8n MCP.
- The smoke fixture returns `ok=true`.
- Canonical and release JSON are scrubbed before commit.
"@

$fixtureTemplate = @"
{
  "source": "scaffold",
  "message": "smoke test"
}
"@

Write-NewFile -Path $sdkPath -Content $sdkTemplate
Write-NewFile -Path $metaPath -Content (($meta | ConvertTo-Json -Depth 20) + [Environment]::NewLine)
Write-NewFile -Path $requestPath -Content $requestTemplate
Write-NewFile -Path $fixturePath -Content $fixtureTemplate

Write-Host "Created workflow scaffold:"
Write-Host "  $sdkPath"
Write-Host "  $metaPath"
Write-Host "  $requestPath"
Write-Host "  $fixturePath"
exit 0
