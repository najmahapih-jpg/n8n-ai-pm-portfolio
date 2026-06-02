# Workflow Contract

## Workflow

- Name: `Portfolio - LLM Eval Harness API`
- Version: `0.6.0`
- Primary entry point: `POST /webhook/portfolio/llm-eval-harness`
- Editor entry point: manual trigger demo
- Default mode: deterministic stub SUT and deterministic stub judge
- Source of truth: `workflows/sdk/llm-eval-harness.workflow.js`
- Release snapshot: `workflows/releases/llm-eval-harness-v0.6.0.json`

## Purpose

Evaluate AI systems against golden cases, score deterministic assertions first, optionally use an LLM judge for subjective rubric dimensions, aggregate pass rate/cost/latency/regression metrics, calibrate judge trust, and return a redacted structured report.

## Input Contract

Accepted content type: JSON.

Required logical input:

- At least one golden case under `golden`, `cases`, or `dataset`.
- Each valid case must include:
  - `input`
  - `expected`

Common case fields:

```json
{
  "id": "echo-pass",
  "input": "ping",
  "expected": "ping",
  "assertions": [],
  "humanLabel": {
    "groundednessBand": "high"
  }
}
```

Run-level fields:

- `runId`
- `requestedAt`
- `sutMode` or `mode`: `stub` (default), `workflow`, or `model`
- `sutExtract`: dot-path for extracting the workflow SUT output; default `response.theme`
- `sutModels`: model list for `sutMode:"model"`; the `stub` lane is always included
- `judgeSource`: `stub` (default) or `ollama`
- `judgeModel`: default `llama3.2:3b`
- `baseline`: optional regression baseline
- `baselineSource`: `request` or `fixture`
- `regressionTolerance`
- `priceTable`: optional known model cost table

Operator-only runtime overrides:

- `sutWebhookUrl`: only used when `sutMode:"workflow"` and only for allowlisted sibling portfolio webhooks on the trusted n8n runtime.
- `sutModelUrl`: local Ollama chat endpoint for model SUT mode.

Public deployments must strip or reject caller-supplied URL overrides unless an allowlist explicitly permits the exact scheme, host, port, and path.

## Operational Limits

- NOTE: the size/string/item limits in this section are **not enforced in-workflow** (the workflow only coerces and trims inputs); they are the caps a deployment gateway should enforce in front of the public webhook.
- Supported public JSON body size: 256 KB maximum. Larger datasets should be split into separate runs.
- Item count: up to 25 golden cases per request, up to 5 non-stub `sutModels`, and at most 100 evaluated `(case, model)` rows after fan-out.
- String limits: `input` and `expected` 8,000 characters each; case ids and model ids 128 characters; assertion lists up to 20 checks per case.
- Idempotency: the workflow is read-only and does not deduplicate runs. `runId` is the caller-provided correlation key and must be stable for replay analysis.
- Connected workflow SUT timeout: 60,000 ms per case. Ollama model SUT timeout: 60,000 ms per row. Ollama judge timeout: 60,000 ms per row.
- Retry behavior: no automatic retry is part of the public contract. Live SUT/model/judge failures become failed rows or fallback judge rows instead of crashing the run.
- Allowed connected SUTs: sibling portfolio webhooks such as product feedback and RAG on the same trusted n8n host. Auth-bearing URLs, private infrastructure URLs, and arbitrary caller-provided hosts are outside the contract.
- Rate limiting is not implemented inside the workflow. Public deployment must enforce authentication, request size, rate limits, and replay controls at the gateway/platform layer.

## Output Contract

Successful responses return HTTP 200:

```json
{
  "ok": true,
  "runId": "run_...",
  "sutMode": "stub|workflow|model",
  "sutModels": ["stub"],
  "judgeSource": "stub|ollama|fallback",
  "judgeTrust": "high|low",
  "passed": true,
  "total": 1,
  "passedCount": 1,
  "passRate": 1,
  "perRubricMean": {
    "groundedness": 5,
    "relevance": 5,
    "helpfulness": 5,
    "safety": 5
  },
  "perModel": [
    {
      "modelId": "stub",
      "total": 1,
      "passRate": 1,
      "meanLatencyMs": 1,
      "totalTokens": null,
      "estCostUsd": 0,
      "costBasis": "local-free"
    }
  ],
  "bench": [],
  "regressionDelta": null,
  "calibration": {
    "labelledCount": 0,
    "agreeCount": 0,
    "agreement": null,
    "threshold": 0.8,
    "basis": "stub-perfect-agreement-by-construction"
  },
  "results": [
    {
      "caseId": "echo-pass",
      "modelId": "stub",
      "passed": true,
      "deterministicPassed": true,
      "judgeSource": "stub|ollama|fallback",
      "judgeMean": 5,
      "scores": {
        "groundedness": 5,
        "relevance": 5,
        "helpfulness": 5,
        "safety": 5
      },
      "latencyMs": 1,
      "totalTokens": null,
      "estCostUsd": 0,
      "costBasis": "local-free",
      "sutSource": "stub|workflow|model|error"
    }
  ],
  "auditEventId": "audit_...",
  "processedAt": "2026-06-02T00:00:00.000Z",
  "latencyMs": 1,
  "policyVersion": "eval-harness-v0.6.0"
}
```

`results` is the per-case, per-model proof surface. It intentionally omits raw prompts, raw expected answers, raw SUT outputs, and judge rationale text; those values may be sensitive and should stay in redacted test artifacts only.

## Error Contract

Missing or invalid golden cases return an error response with:

```json
{
  "ok": false,
  "error": "Missing golden case with {input, expected}",
  "policyVersion": "eval-harness-v0.6.0"
}
```

Live SUT or live judge failures are non-fatal. They are represented as failed rows with `sutSource:"error"` or `judgeSource:"fallback"` rather than crashing the whole run.

## External Integrations

- `sutMode:"workflow"` posts each case to an allowlisted sibling workflow webhook.
- `sutMode:"model"` calls local Ollama by default.
- `judgeSource:"ollama"` calls local Ollama by default.
- Cloud model keys in `.env.example` are placeholders and not built into the default hot path.

## Security and Privacy Boundary

- Golden datasets must be synthetic or redacted.
- Audit events must omit raw prompts when they contain sensitive content.
- URL overrides are operator-only. They must not contain private tokens or credentials and must resolve only to allowlisted sibling or local model endpoints.
- External SUT calls must have timeouts and must not receive n8n management credentials.
- LLM judge output is not ground truth; `judgeTrust` and calibration must be surfaced.

See `docs/security-boundaries.md` for full interface rules.

## Contract Tests

Primary fixtures:

- `fixtures/golden/echo-pass.json`
- `fixtures/golden/echo-fail.json`
- `fixtures/golden/connected-product-feedback.json`
- `fixtures/golden/connected-rag.json`
- `fixtures/golden/bench-model-slice.json`
- `fixtures/calibration/calibration-slice.json`
- `fixtures/baseline/regression-baseline.json`

Required gates:

```powershell
npm run verify:static
npm run verify:json
npm run smoke
```

Live gates are opt-in: `verify:judge`, `verify:connected`, `verify:connected-rag`, and `verify:bench`.
