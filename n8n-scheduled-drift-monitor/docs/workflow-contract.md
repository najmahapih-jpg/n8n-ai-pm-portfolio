# Workflow Contract

## Workflow

- Name: `Portfolio - Scheduled Drift Monitor`
- Version: `0.3.0`
- Primary entry point: schedule trigger, weekly default
- On-demand entry point: `POST /webhook/portfolio/scheduled-drift-monitor`
- Editor entry point: manual trigger demo
- Default mode: deterministic stub collectors and stub digest
- Source of truth: `workflows/sdk/scheduled-drift-monitor.workflow.js`
- Release snapshot: `workflows/releases/scheduled-drift-monitor-v0.3.0.json`

## Purpose

Run a standing health monitor for the workflow suite: check RAG corpus freshness, check answer-quality drift through the eval harness, aggregate drift signals, generate an integrity-checked digest, and return the run record for on-demand webhook calls.

## Input Contract

Schedule runs use workflow defaults. Webhook/manual runs accept JSON.

Optional fields:

- `runId`
- `requestedAt`
- `mode`: `stub` (default) or `live`
- `reportOnly`: defaults to `true`
- `monitors`: defaults to `["freshness", "quality"]`
- `driftThreshold`: defaults to `0.05`
- `staleAfterDays`: defaults to `90`
- `asOf`: deterministic date override
- `stubSources`: deterministic freshness scenario injection
- `stubQuality`: deterministic quality scenario injection
- `priorBaseline`: deterministic baseline override
- `summarySource`: `stub` or `ollama`
- `genModel`
- `userAgent`
- `traceId`: optional caller/gateway-supplied correlation id. Captured-and-echoed only — it is **never generated** by the workflow. Falls back to `requestId` when `traceId` is absent, and is `null` when neither is supplied (a bare schedule run carries none, so it is `null` on schedule runs). It is echoed onto `runtime.traceId`, into the redacted audit event, and onto the top-level run record. It is **additive** (feeds no id/hash/digest seed; the run record is otherwise byte-identical with or without it), is kept **out of the digest prose** (so it never reaches the digest-integrity prose scan), and is **not** surfaced on any error path.
- `requestId`: the documented fallback source for `traceId` when `traceId` is absent.

Operator/test-driver fields:

- `stubSources`, `stubQuality`, and `priorBaseline` are fixture controls for deterministic scenarios.
- `aEvalUrl`: eval harness webhook URL for live mode.
- `ragSutUrl`: RAG assistant webhook URL for live mode.
- `ollamaChatUrl`: local Ollama chat endpoint.

Public deployments must strip or reject caller-supplied URL overrides unless an allowlist explicitly permits the exact sibling workflow or local Ollama endpoint.

Example:

```json
{
  "runId": "run_demo",
  "mode": "stub",
  "reportOnly": true,
  "monitors": ["freshness", "quality"],
  "driftThreshold": 0.05,
  "staleAfterDays": 90,
  "asOf": "2026-05-31"
}
```

## Operational Limits

- NOTE: these operational limits are **not enforced in-workflow** (`normalizeRunConfig` only coerces and trims inputs); they are the RECOMMENDED caps a deployment gateway should enforce in front of the public webhook.
- Supported public JSON body size: 256 KB maximum (gateway-enforced).
- Item count: `monitors` up to 4 monitor names; `stubSources` up to 20 source ids in trusted test mode; `stubQuality` one current reading; live corpus sources come only from the fixed allowlisted source manifest.
- String limits (gateway-recommended): run id 128 characters, monitor names 64 characters, user agent 256 characters, URL override fields 512 characters. Caller-supplied URL overrides are honored only from the trusted manual/schedule entrypoints; the public webhook ignores them (SSRF guard).
- Idempotency: `runId` is the correlation key. The workflow response does not mutate run history; separate drivers may persist outputs under `artifacts/runs/` or compare against `fixtures/history/`.
- Live source fetch timeout: 20,000 ms per allowlisted source. Live eval harness timeout: 120,000 ms. Ollama digest timeout: 120,000 ms.
- Retry behavior: no automatic retry is part of the public contract. Source/eval/digest failures degrade to `unreachable`, baseline quality, or `ollama-fallback` labels rather than aborting the run.
- Live write behavior: detect-only. `reembedded` remains `0`; any future refresh/write path must be a separate reviewed adapter with idempotency, retention, and rollback documented.
- Rate limiting is not implemented inside the workflow. Public deployment must enforce authentication, request size, rate limits, and replay controls at the gateway/platform layer.

## Output Contract

Webhook runs return the structured run record:

```json
{
  "ok": true,
  "runId": "run_demo",
  "traceId": "trace-drift-123",
  "asOf": "2026-05-31",
  "mode": "stub|live",
  "reportOnly": true,
  "monitors": ["freshness", "quality"],
  "freshness": {
    "sources": [
      {
        "sourceId": "svpg-ai-pm",
        "url": "https://www.svpg.com/ai-product-management/",
        "chunkIds": ["pm-more-essential", "genuine-value"],
        "status": "unchanged|changed|stale|unreachable",
        "ageDays": 0,
        "fingerprintPrev": "a1b2c3d4",
        "fingerprintNow": "a1b2c3d4"
      }
    ],
    "changed": 0,
    "stale": 0,
    "unreachable": 0,
    "reembedRecommended": [],
    "reembedded": 0
  },
  "quality": {
    "passRate": 1,
    "passRatePrev": 1,
    "passRateDelta": 0,
    "regressed": false,
    "perRubric": {},
    "perRubricDelta": {},
    "evalSource": "stub|workflow"
  },
  "drift": {
    "any": false,
    "reasons": [
      "quality regressed: passRate 1 -> 0.8 (delta -0.2)",
      "1 source(s) changed"
    ]
  },
  "digest": {
    "title": "Drift all clear",
    "markdown": "# ...",
    "summarySource": "stub|ollama|ollama-fallback"
  },
  "history": {
    "priorRunId": "run_baseline",
    "priorAsOf": "2026-05-24",
    "baselineUpdated": false
  },
  "notified": false,
  "auditEventId": "audit_...",
  "policyVersion": "scheduled-drift-monitor-v0.3.0"
}
```

`history` is comparison metadata, not proof that the workflow wrote a new baseline. `baselineUpdated:false` is the current contract; persistence is handled by external drivers and gitignored artifacts, not by the webhook response path.

Schedule/manual paths emit the same run record and digest through their terminal branch; on-demand webhook path responds with it.

## Error Contract

The default stub path should not fail on missing optional fields. Live source fetch, eval call, or Ollama digest failures must degrade to a safe stub/fallback outcome and label the actual source in the run record.

## External Integrations

Live mode can call:

- Fixed allowlisted corpus source URLs for freshness checks.
- Project A eval harness at allowlisted `aEvalUrl`.
- Project B RAG assistant at allowlisted `ragSutUrl`.
- Local Ollama for digest prose through an allowlisted local endpoint.

Defaults keep all of these external calls off.

## Security and Privacy Boundary

- `mode:"stub"` and `reportOnly:true` are the safe defaults.
- `reportOnly:false` must never be enabled in CI.
- Caller-supplied URLs are not public API inputs; treating them as public would create SSRF and secret-forwarding risk.
- Live eval calls must not forward secrets to sibling workflow webhooks.
- Digest prose must be derived from the run record; every numeric claim must pass integrity checks.
- Future notification adapters must send only digest, counts, trace IDs, and audit IDs.
- Public on-demand trigger deployment must add authentication, request size limits, and rate limits.

## Contract Tests

Primary fixtures:

- `fixtures/golden/all-clear.json`
- `fixtures/golden/quality-regressed.json`
- `fixtures/golden/source-changed.json`
- `fixtures/golden/source-stale.json`
- `fixtures/golden/source-unreachable.json`
- `fixtures/golden/digest-must-be-real.json`
- `fixtures/golden/traceid-correlation.json`

Required gates (offline — no running n8n needed):

```powershell
npm run verify:static
npm run verify:json
```

Opt-in live gates (require a running, imported, ACTIVE n8n):

```powershell
npm run smoke             # stub PAYLOAD, but POSTs to the live webhook — needs n8n up + workflow active
npm run verify:live       # sync + Layer-2 behavioral suite
npm run verify:drift-live # also needs live A / B / Ollama paths
```

## Machine-readable contract

Parsed by `n8n-contract-test-runner` (`Test-Contract.ps1`). `request.limits` are **gateway-delegated**
(declared, not workflow-enforced; see Operational Limits above).

```json
{
  "contractVersion": "scheduled-drift-monitor-v0.3.0",
  "webhookPath": "webhook/portfolio/scheduled-drift-monitor",
  "request": {
    "accepted": ["mode", "reportOnly", "monitors", "driftThreshold", "staleAfterDays", "asOf", "runId", "requestedAt", "traceId", "requestId", "summarySource", "stubSources", "stubQuality", "priorBaseline", "stubDigestProse", "aEvalUrl", "ragSutUrl", "ollamaChatUrl", "genModel", "userAgent", "manualExecution"],
    "limits": { "bodyBytes": 262144 },
    "limitsEnforcedBy": "gateway"
  },
  "response": {
    "required": ["runId", "entrypoint", "traceId", "asOf", "mode", "requestedMode", "reportOnly", "monitors", "freshness", "quality", "drift", "digest", "digestIntegrity", "history", "passed", "auditEvent", "policyVersion", "processedAt"],
    "types": { "mode": "string", "reportOnly": "boolean", "passed": "boolean", "policyVersion": "string" }
  },
  "errors": [],
  "fixtures": {
    "dir": "fixtures/golden",
    "requestPath": "request",
    "valid": ["all-clear.json", "quality-regressed.json", "source-changed.json", "source-stale.json", "source-unreachable.json", "digest-must-be-real.json", "traceid-correlation.json"],
    "errorCases": []
  }
}
```
