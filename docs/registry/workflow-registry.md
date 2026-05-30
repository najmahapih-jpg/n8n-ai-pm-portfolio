# Workflow Registry

Generated from canonical workflow JSON and per-workflow metadata. Do not edit table rows by hand; run pwsh -NoProfile -File .\scripts\Build-WorkflowIndex.ps1.

| Workflow | Version | Status | Trigger | Nodes | Complexity | Integrations | Release | Smoke |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| Portfolio - LLM Eval Harness API | 0.5.0 | live-tested | manual + webhook | 30 | advanced | n8n Manual Trigger, n8n Webhook, Deterministic stub subject-under-test (default), Live workflow subject-under-test (sutMode:workflow grades product-feedback 6Gc3wmri0tJre07B as a black box) with graceful non-fatal failure, Live multi-model subject-under-test (sutMode:model fans out cases x sutModels, calls Ollama /api/chat per model: stub lane + llama3.2:3b lane) with token+latency capture and graceful non-fatal failure, Per-model cost-quality-latency bench (aggregate.perModel + ranked bench; honest local-free cost), Deterministic stub LLM-as-judge (default), Live Ollama LLM-as-judge (llama3.2:3b, judgeSource:ollama) with deterministic fallback, Judge-human calibration / judge-drift guard (judgeTrust), Redacted audit | `workflows\releases\llm-eval-harness-v0.5.0.json` | `echo-pass`, `echo-fail` |
