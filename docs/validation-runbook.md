# Validation Runbook

## Preflight

```powershell
pwsh -NoProfile -File .\scripts\Test-N8nConnection.ps1
```

Expected result: Docker, local n8n, API key presence, and MCP token presence are all verified without printing secret values.

## Workflow Build Validation

1. Use community n8n-mcp for `tools_documentation`.
2. Search templates before building from scratch.
3. Inspect required node schemas.
4. Validate non-trivial node configs.
5. Validate full workflow structure with community n8n-mcp.
6. Maintain workflow source in `workflows/sdk/portfolio-support-triage-api.workflow.js`.
7. Validate SDK code with official n8n MCP.
8. Create/update only through official n8n MCP.
9. Test with pin data before publishing.

For the portfolio workflow, use the reproducible source-to-artifact chain:

```powershell
npm run verify:static
pwsh -NoProfile -File .\scripts\Build-WorkflowIndex.ps1
pwsh -NoProfile -File .\scripts\Sync-N8nWorkflowFromSdk.ps1
pwsh -NoProfile -File .\scripts\Test-SupportTriageWorkflow.ps1
```

Expected result: official MCP validates the SDK source, updates the draft, API export captures the current draft, scrubbed canonical and release files match, generated registry files are current, both workflow JSON outputs satisfy the 27-node floor, all 8 pin-data regression cases pass, and Feishu static validation passes.

## Smoke Test

Run the smoke test before touching Feishu configuration:

```powershell
npm run smoke
```

Expected result: offline static validation passes, local n8n connection passes, and the `enterprise-incident` case returns `feishuDelivery.status=skipped`.

## Export and Git Validation

```powershell
pwsh -NoProfile -File .\scripts\Export-N8nWorkflows.ps1 -OutputDirectory .\workflows\generated
pwsh -NoProfile -File .\scripts\Export-N8nWorkflowApi.ps1 -WorkflowId RPkw9jGJ93lqs7jO -OutputDirectory .\workflows\generated
pwsh -NoProfile -File .\scripts\Scrub-N8nWorkflow.ps1 -InputPath .\workflows\generated\<timestamp> -OutputDirectory .\workflows\canonical
pwsh -NoProfile -File .\scripts\Test-N8nWorkflowJson.ps1 -Path .\workflows\canonical\portfolio-support-triage-api.canonical.json -MinimumNodes 27
pwsh -NoProfile -File .\scripts\Test-FeishuWorkflowJson.ps1
pwsh -NoProfile -File .\scripts\Test-RepositorySecrets.ps1
```

Expected result: only scrubbed canonical JSON is tracked, volatile n8n instance fields are removed, and no real secret values are present.

## Final Feishu Send Check

Only after all non-Feishu checks pass, configure a real Feishu custom bot webhook in the local Docker environment and run a one-case live send smoke test:

```powershell
pwsh -NoProfile -File .\scripts\Test-SupportTriageWorkflow.ps1 -CaseName enterprise-incident -FeishuMode sent
```

Expected result: the case passes, `feishuDelivery.status` is `sent`, and one card appears in the private Feishu test group.
