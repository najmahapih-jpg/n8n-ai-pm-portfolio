# Workflow Registry

Generated from canonical workflow JSON and per-workflow metadata. Do not edit table rows by hand; run pwsh -NoProfile -File .\scripts\Build-WorkflowIndex.ps1.

| Workflow | Version | Status | Trigger | Nodes | Complexity | Integrations | Release | Smoke |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| Portfolio - Autonomous Agent | 0.1.0 | live-tested | webhook (POST) + manual (editor demo) | 8 | basic | n8n Webhook Trigger (POST /webhook/portfolio/autonomous-agent, responseMode=responseNode), n8n Manual Trigger (editor demo: a built-in bug task), Agent Loop Code node -- mirrors scripts/lib/agent-core.mjs (bounded tool-use loop + keyword planner + guardrails), Tools = the portfolio workflows via the signed interaction-gateway (support-triage / product-feedback / rag / eval / drift); v0.1.0 STUB tools, live gateway execution opt-in, Redacted audit (stopReason + tool sequence + counts only; never the raw task) | `workflows\releases\autonomous-agent-v0.1.0.json` | `bug-known-issue`, `unsafe-injection`, `no-signal` |
