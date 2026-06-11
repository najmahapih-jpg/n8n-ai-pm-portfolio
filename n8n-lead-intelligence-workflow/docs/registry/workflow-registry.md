# Workflow Registry

Generated from canonical workflow JSON and per-workflow metadata. Do not edit table rows by hand; run pwsh -NoProfile -File .\scripts\Build-WorkflowIndex.ps1.

| Workflow | Version | Status | Trigger | Nodes | Complexity | Integrations | Release | Smoke |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| Portfolio - Lead Intelligence API | 0.1.2 | draft-tested | manual + webhook + executeWorkflow (agent/MCP tool) | 39 | advanced | n8n Manual Trigger, n8n Webhook, Local scoring rules, CRM-ready payload, Execute Workflow Trigger (agent/MCP tool entry) | `workflows\releases\lead-intelligence-v0.1.2.json` | `hot-enterprise-lead` |
