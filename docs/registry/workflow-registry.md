# Workflow Registry

Generated from canonical workflow JSON and per-workflow metadata. Do not edit table rows by hand; run pwsh -NoProfile -File .\scripts\Build-WorkflowIndex.ps1.

| Workflow | Version | Status | Trigger | Nodes | Complexity | Integrations | Release | Smoke |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| Portfolio - Support Triage API | 0.3.0 | draft-tested | webhook + executeWorkflowTrigger (callable by the interaction-gateway; 2026-06-03 -- ADDITIVE, feeds the same Normalize Payload node; standalone-compiled + REST-deployed since this repo is MCP-toolchain and no MCP was connected; webhook regression-tested unchanged: urgency/routingTeam/feishuDelivery intact; canonical 28 nodes. NOTE: currently INACTIVE -- activated only to prove the gateway route live (executed:true), then restored to inactive; the gateway route works only while it is active/published) | 28 | advanced | n8n Webhook, Feishu custom bot | `workflows\releases\support-triage-v0.3.0.json` | `enterprise-incident` |
