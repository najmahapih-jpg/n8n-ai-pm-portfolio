# Change Log

## 2026-05-29

- Added `v0.1.1` manual UI execution support so n8n editor `Execute Workflow` can run a built-in demo lead without waiting for the webhook Test URL.
- Added a final branch that sends webhook executions to `Respond to Webhook` and sends manual editor executions to `Show UI Execution Result`.
- Created `Portfolio - Lead Intelligence API` as a 31-node local n8n workflow through official MCP.
- Added SDK source, metadata, canonical JSON, and release snapshot for `lead-intelligence-v0.1.0`.
- Added 11 pin-data fixtures covering validation, dedupe, scoring, routing, competitor disqualification, manual override, hot-lead notification skipping, and audit redaction.
- Added `Test-LeadIntelligenceWorkflow.ps1` for official MCP live regression tests.
- Added `Test-LeadWorkflowJson.ps1` for workflow-specific JSON guards.
- Updated npm scripts for static validation, smoke, and full live verification.
- Kept CRM and Feishu/Lark adapters out of v0.1 runtime; both are documented as final optional integrations.
