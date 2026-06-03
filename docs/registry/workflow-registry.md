# Workflow Registry

Generated from canonical workflow JSON and per-workflow metadata. Do not edit table rows by hand; run pwsh -NoProfile -File .\scripts\Build-WorkflowIndex.ps1.

| Workflow | Version | Status | Trigger | Nodes | Complexity | Integrations | Release | Smoke |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| Portfolio - Interaction Gateway | 0.1.0 | live-tested | webhook (signed POST) + manual (editor demo) | 12 | intermediate | n8n Webhook Trigger (POST /webhook/portfolio/interaction-gateway, responseMode=responseNode, rawBody enabled for exact-bytes HMAC; authentication=none at the n8n layer, authenticated by the in-workflow HMAC check), n8n Manual Trigger (editor demo: builds a validly-signed request so a manual run shows a full accepted round-trip), Security core mirrored from scripts/lib/gateway-core.mjs (verifySignature / enforceBodySize / stripSecrets / resolveRoute), Sibling routing by allowlisted intent -> routing DECISION (stub default, offline-proven). Live Execute-Workflow execution is the opt-in next increment (requires each target to expose an executeWorkflowTrigger), Redacted audit event (ids + counts + verdicts only; never the payload or any secret) | `workflows\releases\interaction-gateway-v0.1.0.json` | `sig-valid`, `sig-tampered`, `secret-in-payload`, `intent-fanout` |
