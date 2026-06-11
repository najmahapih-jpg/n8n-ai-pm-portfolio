# Demo Script

1. Show the request in `fixtures/requests/support-triage.md`.
2. Explain template-first research through community n8n-mcp.
3. Show `workflows/sdk/portfolio-support-triage-api.workflow.js` as the source of truth.
4. Run `scripts/Sync-N8nWorkflowFromSdk.ps1` to validate SDK, update the official MCP draft, API-export, scrub canonical, and copy the release snapshot.
5. Show the local draft workflow in n8n and call out the 27-node structure.
6. Run `scripts/Test-SupportTriageWorkflow.ps1` for all 8 official MCP pin-data paths.
7. Run `scripts/Test-FeishuWorkflowJson.ps1` to show the Feishu branch is present without committed webhook secrets.
8. Use `scripts/Export-N8nWorkflows.ps1` only as a broad Docker backup export.
9. Show the Git diff containing only safe docs, fixtures, scripts, SDK source, canonical workflow JSON, and release snapshots.

## Demo Status

The demo workflow has been created as a local n8n draft through official n8n MCP.

Evidence:

- Workflow name: `Portfolio - Support Triage API`
- Workflow ID: `RPkw9jGJ93lqs7jO`
- Workflow URL: `http://localhost:5678/workflow/RPkw9jGJ93lqs7jO`
- Official MCP validation: pass
- Official MCP enhanced workflow validation: pass, 27 nodes
- Official MCP regression suite: 8 cases, all status `success`
- Enterprise incident output observed: `category=incident`, `urgency=critical`, `routingTeam=platform-support`, `slaHours=1`, `handlingPath=escalated`
- Urgent incident output observed: `category=incident`, `urgency=urgent`, `routingTeam=platform-support`, `slaHours=2`, `handlingPath=escalated`
- Local Feishu output observed in tests: escalation responses include `feishuDelivery.status=skipped` when no webhook is configured
- Billing output observed: `category=billing`, `urgency=high`, `routingTeam=billing-support`, `slaHours=8`, `handlingPath=standard`
- Account alias output observed: `category=account`, `routingTeam=account-success`, alias fields normalized
- Bug output observed: `category=bug`, `routingTeam=product-engineering`
- General output observed: `category=general`, `urgency=normal`, `routingTeam=general-support`, `slaHours=24`, `handlingPath=standard`
- Invalid-date output observed: `dueAt` remains parseable through SLA fallback
- Missing-field output observed: `statusCode=400`
- Canonical JSON: `workflows/canonical/portfolio-support-triage-api.canonical.json`
- Release snapshot: `workflows/releases/support-triage-v0.3.0.json`
- Draft export guardrail: API export plus `-MinimumNodes 27` validation
