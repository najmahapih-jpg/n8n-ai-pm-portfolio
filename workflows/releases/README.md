# Releases

Release snapshots are scrubbed canonical workflow JSON files copied after `scripts/Sync-N8nWorkflowFromSdk.ps1` succeeds.

- `lead-intelligence-v0.1.0.json`: 31-node local B2B lead intelligence workflow with intake normalization, validation, email syntax guard, deduplication, deterministic company and intent enrichment, ICP/intent/priority scoring, A-D grading, sales routing, follow-up SLA policy, CRM-ready payload construction, hot-lead notification skip handling, redacted audit event creation, and structured webhook response handling.

Do not edit release JSON by hand. Edit the SDK source, sync through official MCP, then regenerate registry files.
