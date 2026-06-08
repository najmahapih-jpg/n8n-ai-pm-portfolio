# Workflow Contract

## Workflow

- Name: `Portfolio - RAG Knowledge Assistant API`
- Version: `0.3.0`
- Primary entry point: `POST /webhook/portfolio/rag-knowledge-assistant`
- Editor entry point: manual trigger demo
- Default mode: deterministic stub retriever and deterministic stub generator
- Source of truth: `workflows/sdk/rag-knowledge-assistant.workflow.js`
- Release snapshot: `workflows/releases/rag-knowledge-assistant-v0.3.0.json`

## Purpose

Answer questions grounded in a fixed Chinese AI product-management corpus, cite retrieved chunks for every answer, abstain cleanly when retrieval misses, enforce citation integrity, emit a redacted audit event, and return a structured JSON response.

## Input Contract

Accepted content type: JSON.

Required logical field:

- `query` or `question` or `q`

Optional fields:

- `requestId`
- `requestedAt`
- `traceId`: optional caller/gateway-supplied correlation id. Captured and echoed only (never generated). Falls back to `requestId` when `traceId` is absent, and is `null` when neither is supplied. Echoed onto `runtime.traceId`, the redacted audit event, and the response — on **both** the grounded answer and the clean-abstain paths. It is **not** surfaced on the missing-query error response, and it feeds no id/hash seed and does not affect retrieval, citations, or the abstain decision (purely additive).
- `topK`: integer, clamped to `1..8`, default `3`
- `threshold`: optional similarity threshold override, clamped to `0..1`
- `retrievalSource`: `stub` (default) or `supabase`
- `generationSource`: `stub` (default) or `ollama`
- `embedModel`
- `genModel`

Operator-only runtime overrides:

- `ollamaEmbedUrl`
- `ollamaChatUrl`
- `supabaseRpcUrl`

Public deployments must strip or reject caller-supplied URL overrides unless an allowlist explicitly permits the exact local Ollama endpoint or Supabase RPC endpoint.

Example:

```json
{
  "requestId": "req_demo",
  "query": "转型 AI 产品经理要补齐哪三大技能簇?",
  "topK": 3,
  "retrievalSource": "stub",
  "generationSource": "stub"
}
```

## Operational Limits

- NOTE: the size/string/item limits in this section are **not enforced in-workflow** (the workflow only coerces and trims inputs); they are the caps a deployment gateway should enforce in front of the public webhook.
- Supported public JSON body size: 32 KB maximum.
- String limits: query 2,000 characters, request id 128 characters, model names 128 characters, and URL override fields 512 characters in trusted operator mode only.
- Item count: one query per request. Batch question answering is outside the current public contract.
- `topK` is clamped to `1..8`; the default is 3. `threshold` is clamped to `0..1`.
- Idempotency: `requestId` is a caller correlation key only. The workflow performs no writes and does not deduplicate repeated questions.
- Live retrieval timeout: 60,000 ms for query embedding and 60,000 ms for Supabase RPC. Live generation timeout: 120,000 ms for Ollama chat.
- Retry behavior: no automatic retry is part of the public contract. Live failures degrade as follows: live Supabase retrieval that returns no rows (unreachable store, empty table, or a failed query embedding) **falls back to the deterministic in-corpus TF-IDF stub retriever** over the committed corpus (labelled `supabase-fallback-stub`) so the run yields a grounded, cited answer instead of a false abstain; live generation that returns no text degrades to the deterministic stub grounded extract (`ollama-fallback`). A true retrieval miss (no chunk clears the threshold on the chosen retriever) is still a clean abstain.
- URL override boundary: only trusted operator/test drivers may set `ollamaEmbedUrl`, `ollamaChatUrl`, or `supabaseRpcUrl`; public callers may select `retrievalSource`/`generationSource` but must not choose arbitrary hosts.
- Rate limiting is not implemented inside the workflow. Public deployment must enforce authentication, request size, rate limits, and replay controls at the gateway/platform layer.

## Output Contract

Successful responses return HTTP 200:

```json
{
  "ok": true,
  "requestId": "req_demo",
  "traceId": "trace-rag-123",
  "abstained": false,
  "answer": "简体中文答案",
  "note": null,
  "citations": [
    {
      "chunkId": "three-skill-clusters",
      "source": "source title",
      "url": "https://example.com",
      "quote": "quoted corpus span"
    }
  ],
  "retrieval": {
    "topK": [
      {
        "chunkId": "three-skill-clusters",
        "source": "source title",
        "score": 0.42
      }
    ],
    "maxScore": 0.42,
    "threshold": 0.08
  },
  "retrievalSource": "stub|supabase|supabase-fallback-stub",
  "generationSource": "stub|ollama|ollama-fallback",
  "passed": true,
  "integrity": {
    "checks": [],
    "passed": true
  },
  "auditEventId": "audit_...",
  "processedAt": "2026-06-02T00:00:00.000Z",
  "policyVersion": "rag-knowledge-assistant-v0.3.0"
}
```

Clean abstain shape:

```json
{
  "ok": true,
  "traceId": "trace-rag-123",
  "abstained": true,
  "answer": null,
  "note": "信息不足,无法回答",
  "citations": []
}
```

`traceId` is `null` when neither `traceId` nor `requestId` was supplied. The missing-query error response does **not** carry `traceId`.

## Error Contract

Missing or empty `query` returns a validation response:

```json
{
  "ok": false,
  "error": "Missing required 'query' (non-empty string)",
  "policyVersion": "rag-knowledge-assistant-v0.3.0"
}
```

Live Supabase or Ollama failure must degrade to a deterministic fallback and label the actual source truthfully. Live Supabase returning no rows degrades to the deterministic in-corpus TF-IDF stub retriever over the committed corpus, labelled `supabase-fallback-stub`, which produces real `topK`/citations so the run routes to a grounded answer (the portfolio rule: degrade to a deterministic stub, **never to a false abstain**). Live Ollama returning no text degrades to the deterministic stub grounded extract, labelled `ollama-fallback`. A clean abstain occurs only on a genuine retrieval miss (no chunk clears the threshold).

## External Integrations

- `retrievalSource:"supabase"`: live Supabase pgvector RPC, backed by runtime credentials and an allowlisted RPC URL.
- `generationSource:"ollama"`: local Ollama chat generation through an allowlisted local endpoint.
- Stub retrieval/generation remains the default for CI and repeatable tests.

## Security and Privacy Boundary

- Query text may contain user data; audit events store query length/hash, not raw query text.
- Supabase service-role key is runtime-only and must never appear in workflow JSON, docs, fixtures, screenshots, or logs.
- Caller-supplied URLs are not public API inputs; treating them as public would create SSRF and secret-forwarding risk.
- Citations are generated from retrieved corpus chunks, never from model-provided attribution.
- LLM generation must not introduce facts outside retrieved context; failure falls back or abstains.

## Contract Tests

Primary fixtures:

- `fixtures/golden/in-corpus-direct.json`
- `fixtures/golden/in-corpus-paraphrased.json`
- `fixtures/golden/out-of-corpus.json`
- `fixtures/golden/partial-corpus.json`
- `fixtures/golden/citation-must-be-real.json`
- `fixtures/golden/adversarial-injection.json`

Required gates:

```powershell
npm run verify:static
npm run verify:json
npm run smoke
```

`npm run verify:rag-live` is opt-in and requires Supabase/Ollama runtime configuration.

## Machine-readable contract

Parsed by `n8n-contract-test-runner` (`Test-Contract.ps1`). `request.limits` are **gateway-delegated**.
The golden fixtures carry test metadata (`id`, `expect*`) alongside the request, declared via `ignoreKeys`.

```json
{
  "contractVersion": "rag-knowledge-assistant-v0.3.0",
  "webhookPath": "webhook/portfolio/rag-knowledge-assistant",
  "request": {
    "accepted": ["query", "requestId", "traceId"],
    "limits": { "bodyBytes": 32768, "queryChars": 2000 },
    "limitsEnforcedBy": "gateway"
  },
  "response": {
    "required": ["abstained", "citations", "retrieval", "retrievalSource", "generationSource", "passed", "policyVersion"],
    "types": { "abstained": "boolean", "passed": "boolean", "policyVersion": "string" }
  },
  "errors": [],
  "fixtures": {
    "dir": "fixtures/golden",
    "ignoreKeys": ["id", "description", "expectAbstain", "expectAnswerContains", "expectCiteChunkIds", "exercises", "_note"],
    "valid": ["adversarial-injection.json", "citation-must-be-real.json", "in-corpus-direct.json", "in-corpus-paraphrased.json", "out-of-corpus.json", "partial-corpus.json"],
    "errorCases": []
  }
}
```
