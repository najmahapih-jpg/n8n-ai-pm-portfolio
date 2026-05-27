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
6. Validate workflow code or payload with official n8n MCP.
7. Create/update only through official n8n MCP.
8. Test with pin data before publishing.

## Export and Git Validation

```powershell
pwsh -NoProfile -File .\scripts\Export-N8nWorkflows.ps1 -OutputDirectory .\workflows\generated
pwsh -NoProfile -File .\scripts\Scrub-N8nWorkflow.ps1 -InputPath .\workflows\generated\<timestamp> -OutputDirectory .\workflows\canonical
pwsh -NoProfile -File .\scripts\Test-N8nWorkflowJson.ps1 -Path .\workflows\canonical
rg -n "N8N_API_KEY|N8N_MCP_TOKEN|Authorization|Bearer |sk-[A-Za-z0-9_-]{20,}|client_secret|credentials\"\\s*:" .
```

Expected result: only scrubbed canonical JSON is tracked, and no real secret values are present.
