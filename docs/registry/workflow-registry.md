# Workflow Registry

Generated from canonical workflow JSON and per-workflow metadata. Do not edit table rows by hand; run pwsh -NoProfile -File .\scripts\Build-WorkflowIndex.ps1.

| Workflow | Version | Status | Trigger | Nodes | Complexity | Integrations | Release | Smoke |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| Portfolio - RAG Knowledge Assistant API | 0.3.0 | live-tested | manual + webhook | 27 | advanced | n8n Manual Trigger, n8n Webhook, Deterministic stub retriever over in-repo corpus (DEFAULT), LIVE Supabase pgvector retrieval via match_documents RPC (retrievalSource:supabase, opt-in; header-auth credential), LIVE Ollama query embedding nomic-embed-text-v2-moe 768-dim, 'search_query: ' prefix (retrievalSource:supabase), Deterministic stub generator grounded only on retrieved chunks (DEFAULT), LIVE Ollama grounded generation llama3.2:3b temperature 0 (generationSource:ollama, opt-in; onError -> deterministic fallback), Threshold gate -> grounded-answer-with-citations OR clean-abstain, Deterministic citation-integrity enforcement on BOTH stub + live paths (every cited chunkId in retrieval.topK; corpus-grounded citations), Redacted audit (ids + scores + verdicts + query hash only; no raw query/answer/chunk text) | `workflows\releases\rag-knowledge-assistant-v0.3.0.json` | `in-corpus-direct`, `out-of-corpus`, `citation-must-be-real` |
