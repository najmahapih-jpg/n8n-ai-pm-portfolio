# Workflow Lifecycle

## Lifecycle

1. Capture the workflow requirement in `fixtures/requests/lead-intelligence.md`.
2. Research node behavior and template patterns through community n8n-mcp or official docs.
3. Edit `workflows/sdk/lead-intelligence.workflow.js`; treat this file as source of truth.
4. Run `scripts/Sync-N8nWorkflowFromSdk.ps1` to validate SDK, create/update local n8n draft, export via API, scrub, write canonical JSON, and copy the release snapshot.
5. Run `scripts/Build-WorkflowIndex.ps1`.
6. Run `npm run verify:static`.
7. Run `npm run smoke`.
8. Run `npm run verify:live` before claiming the workflow is ready.

## Decision Notes

### 2026-05-29: Keep v0.1 Fully Local

Lead intelligence can be proven with deterministic enrichment, scoring rules, fixtures, and MCP pin-data tests. External CRM and Feishu delivery are useful but not required to demonstrate the core workflow engineering.

Rejected: call live CRM enrichment APIs in v0.1 | adds credentials, rate limits, and unstable test results before the rule engine is proven.

### 2026-05-29: Use Official MCP As Writer

The official n8n MCP understands `@n8n/workflow-sdk` source and can create/update/test local workflows. Community n8n-mcp remains useful for discovery, but it should not write to the same local instance during normal work.

Rejected: use both MCP servers as writers | creates ambiguous ownership and possible workflow drift.

### 2026-05-29: Keep Feishu As Final Adapter

Outbound Feishu custom bot messages can run from a local n8n container without public deployment, but adapter credentials and message delivery are intentionally outside the v0.1 acceptance path.

Rejected: bidirectional Feishu bot in this project phase | inbound callbacks require public reachability or tunneling and distract from lead scoring, routing, and audit behavior.
