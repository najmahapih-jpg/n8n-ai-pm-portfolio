# Demo Script

1. Show the request in `fixtures/requests/support-triage.md`.
2. Explain template-first research through community n8n-mcp.
3. Show the local draft workflow in n8n.
4. Run pin-data test through official n8n MCP.
5. Export workflows with `scripts/Export-N8nWorkflows.ps1`.
6. Scrub exports with `scripts/Scrub-N8nWorkflow.ps1`.
7. Validate canonical JSON with `scripts/Test-N8nWorkflowJson.ps1`.
8. Show the Git diff containing only safe docs, fixtures, scripts, and canonical workflow JSON.

## Demo Status

The demo workflow has been created as a local n8n draft through official n8n MCP.

Evidence:

- Workflow name: `Portfolio - Support Triage API`
- Workflow ID: `RPkw9jGJ93lqs7jO`
- Workflow URL: `http://localhost:5678/workflow/RPkw9jGJ93lqs7jO`
- Official MCP validation: pass
- Official MCP test execution: `1`, status `success`
- Expected triage output observed: `urgency=urgent`, `routingTeam=platform-support`, `slaHours=2`
- Canonical JSON: `workflows/canonical/portfolio-support-triage-api.canonical.json`
- Release snapshot: `workflows/releases/support-triage-v0.1.0.json`
