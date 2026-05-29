# Validation Runbook

## Quick Smoke

```powershell
cd C:\Dev\Projects\n8n-lead-intelligence-workflow
npm run smoke
```

Expected result: offline static validation passes, local n8n connection passes, and `hot-enterprise-lead` returns grade `A`, `enterprise-ae`, `slaHours=2`, and `notification.status=skipped`.

## Full Local Verification

```powershell
cd C:\Dev\Projects\n8n-lead-intelligence-workflow
npm ci
pwsh -NoProfile -File .\scripts\Test-N8nConnection.ps1
pwsh -NoProfile -File .\scripts\Sync-N8nWorkflowFromSdk.ps1
pwsh -NoProfile -File .\scripts\Build-WorkflowIndex.ps1
npm run verify:static
npm run verify:live
```

Expected result: official MCP validates the SDK, creates or updates the local draft, API export captures the current draft, scrubbed canonical and release files match, registry files are current, JSON guards pass the 31-node floor, and all pin-data cases pass.

## Manual Case Runs

```powershell
pwsh -NoProfile -File .\scripts\Test-LeadIntelligenceWorkflow.ps1 -CaseName hot-enterprise-lead
pwsh -NoProfile -File .\scripts\Test-LeadIntelligenceWorkflow.ps1 -CaseName midmarket-qualified
pwsh -NoProfile -File .\scripts\Test-LeadIntelligenceWorkflow.ps1 -CaseName high-intent-low-fit
pwsh -NoProfile -File .\scripts\Test-LeadIntelligenceWorkflow.ps1 -CaseName competitor-domain
pwsh -NoProfile -File .\scripts\Test-LeadIntelligenceWorkflow.ps1 -CaseName manual-override
```

## Adapter Gating

Do not configure CRM or Feishu/Lark delivery until the full local verification passes. Adapter checks belong after the current no-external-services workflow is green.
