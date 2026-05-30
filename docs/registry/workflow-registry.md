# Workflow Registry

Generated from canonical workflow JSON and per-workflow metadata. Do not edit table rows by hand; run pwsh -NoProfile -File .\scripts\Build-WorkflowIndex.ps1.

| Workflow | Version | Status | Trigger | Nodes | Complexity | Integrations | Release | Smoke |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| Portfolio - Product Feedback Intelligence API | 0.2.0 | draft-tested | manual + webhook | 28 | advanced | n8n Manual Trigger, n8n Webhook, Deterministic stub classifier (default), Live Ollama classifier (llama3.2:3b, per-request), Redacted audit | `workflows\releases\product-feedback-intelligence-v0.2.0.json` | `feedback-bug-negative` |
