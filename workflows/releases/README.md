# Releases

Release snapshots are scrubbed canonical workflow JSON files copied after `scripts/Sync-N8nWorkflowFromSdk.ps1` succeeds.

- `lead-intelligence-v0.1.1.json`: 38-node local B2B lead intelligence workflow with n8n editor manual execution support, webhook intake normalization, validation, email syntax guard, deduplication, deterministic company and intent enrichment, ICP/intent/priority scoring, A-D grading, sales routing, follow-up SLA policy, CRM-ready payload construction, hot-lead notification skip handling, redacted audit event creation, manual UI result handling, and structured webhook response handling.
- `lead-intelligence-v0.1.0.json`: superseded 31-node release before manual UI execution support.

Do not edit release JSON by hand. Edit the SDK source, sync through official MCP, then regenerate registry files.
