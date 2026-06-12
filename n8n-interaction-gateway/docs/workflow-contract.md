# Workflow Contract

## Workflow

- Name: `Portfolio - Interaction Gateway`
- n8n workflow id: `YKT4FJmC8Xg2G9hs` (active)
- Version: `interaction-gateway-v0.5.0`
- Primary entry point: `POST /webhook/portfolio/interaction-gateway`
- Content type: `text/plain` (the exact raw bytes that are HMAC-signed)
- Default mode: offline decision-only (no sibling execution without live n8n)
- Source of truth: `workflows/sdk/interaction-gateway.workflow.js`
- Release snapshot: `workflows/releases/interaction-gateway-v0.5.0.json`

## Purpose

Act as the single authenticated entry point for the portfolio. Verify the HMAC-SHA256 signature, enforce the body-size cap, strip secret-bearing fields from the entire request envelope, and route the request by allowlisted intent to one or more sibling workflows (in-process via Execute Workflow, no secret over HTTP). Return a structured response with `ok`, `traceId`, `routedTo`, and per-target results.

## Authentication

Every request must be signed:

- Header `X-Timestamp`: Unix epoch seconds as a string.
- Header `X-Signature`: `sha256=<hex>` where hex is `HMAC-SHA256(secret, "${X-Timestamp}.${rawBody}")`.
- Replay window: 300 seconds.
- Secret: `GATEWAY_SIGNING_SECRET` in the n8n runner environment. An unset or empty secret fails closed (the HMAC with an empty key is a valid construction an attacker could forge; the gateway rejects it explicitly).

## Input Contract

Accepted content type: `text/plain` (the raw signed bytes, parsed as JSON by the gateway).

Request envelope fields:

```json
{
  "intent": "support-triage",
  "payload": {},
  "requestId": "req-abc123"
}
```

- `intent` (required): one of the allowlisted intent names. Non-allowlisted intents are rejected with 422.
- `payload` (optional): the business payload forwarded to the sibling (after secret-stripping).
- `requestId` (optional): caller-provided correlation key; used to derive `traceId` when present.

### Allowlisted intents

| Intent | Routed to |
| --- | --- |
| `support-triage` | `support-triage` |
| `product-feedback` | `product-feedback` |
| `rag` | `rag` |
| `eval` | `eval-harness` |
| `drift` | `scheduled-drift-monitor` |
| `feedback-then-grade` | `product-feedback`, `eval-harness` (fan-out) |
| `gateway-selftest` | `gateway-selftest-sibling` |
| `feedback-multi` | `product-feedback`, `gateway-selftest-sibling` (fan-out) |
| `notify` | `feishu-notify` (the portfolio's unified notification outlet -> Feishu group card) |

Callers name an intent, never a URL. The allowlist is the only routing surface. SSRF is closed by construction.

## Operational Limits

- Body size: 64 KB maximum. Requests over the cap are rejected with 413 before signature verification.
- Idempotency: the gateway does not deduplicate requests. `requestId` is the caller-provided correlation key.
- Replay window: 300 seconds. Requests with an `X-Timestamp` older than 300 seconds relative to server time are rejected with 401.
- Sibling execution timeout: governed by the n8n Execute Workflow node timeout.
- Rate limiting is not implemented inside the workflow. Production deployment must enforce rate limits at the proxy or platform layer.

## Output Contract

Successful authenticated responses return HTTP 200:

```json
{
  "ok": true,
  "traceId": "gw-<hex>",
  "intent": "support-triage",
  "routedTo": ["support-triage"],
  "result": {
    "mode": "decision",
    "executed": false,
    "fanout": false,
    "perTarget": []
  },
  "policyVersion": "interaction-gateway-v0.5.0"
}
```

When a callable sibling executes in-process (`executed: true`):

```json
{
  "ok": true,
  "traceId": "gw-<hex>",
  "intent": "product-feedback",
  "routedTo": ["product-feedback"],
  "result": {
    "mode": "execute",
    "executed": true,
    "fanout": false,
    "perTarget": [
      {
        "target": "product-feedback",
        "result": {}
      }
    ]
  },
  "policyVersion": "interaction-gateway-v0.5.0"
}
```

`traceId` is always present. `routedTo` lists the sibling target names (never URLs). `policyVersion` is always present.

## Error Contract

| HTTP status | Condition |
| --- | --- |
| 401 | Missing, tampered, or expired signature; unset gateway secret |
| 413 | Body exceeds size cap |
| 422 | Non-allowlisted or missing intent |

Error responses always include `ok: false` and `traceId`.

## External Integrations

- Callable siblings are reached via n8n Execute Workflow (in-process). Each sibling must expose an `executeWorkflowTrigger` node to be callable.
- The gateway **forwards its own `traceId` into the in-process sibling payload** (as `payload.traceId`, with `payload.requestId` set to the same value for the `traceId ?? requestId` fallback, and also at the item top level). A routed sibling that captures `body.traceId ?? body.requestId` therefore echoes back the SAME gateway `traceId`, making the gateway→sibling chain end-to-end correlatable. The gateway reuses its existing `traceId` (never generates a second id), and the forward is additive — the cleaned payload fields are preserved.
- No external HTTP calls to sibling workflows (no credentials over the wire).
- The `feishu-notify` sibling (the `notify` intent's target) makes ONE outbound HTTP call — to the Feishu custom-bot webhook (`FEISHU_BOT_WEBHOOK_URL` + optional `FEISHU_BOT_SIGNING_SECRET`, runner env only). Unconfigured -> honest `skipped`; a send error -> `failed` (degrade, never crash, never a fabricated `sent`).
- `verify:live` (`scripts/Test-GatewayLive.ps1`) signs a real request to the deployed gateway and asserts `valid→200+traceId` and `tampered→401`. It skips honestly when n8n, the secret, or the webhook is absent.

## Security and Privacy Boundary

- Secret-bearing fields are stripped from the entire request envelope (key names, value strings, array elements) before any forwarding, echo, or logging.
- `traceId` is always present and safe to log. It is derived from `requestId` when provided or generated fresh.
- Audit events must omit raw caller payloads when they contain sensitive content.
- The gateway secret must stay in the runner environment. It must never appear in source, fixtures, snapshots, or logs.

See `docs/security-boundaries.md` for full interface rules.

## Contract Tests

Primary offline gates:

```powershell
npm run verify:static
npm run verify:json
npm run verify:gateway
npm run verify:workflow
```

`verify:gateway` (28 assertions) pins the pure security-core functions. `verify:workflow` (189 assertions across 17 golden scenarios plus a live-branch traceId-forward check and a feishu-notify-sibling differential) runs the compiled pipeline and differentially pins every security decision against the core so the deployed logic cannot silently drift. The traceId-forward check drives an accepted, callable request through the compiled `Prepare Sibling Input` node and asserts the gateway's `traceId` is forwarded into the sibling payload (the live branch is otherwise uncovered by the offline differential pipeline).

Live gate is opt-in: `npm run verify:live`.

## Machine-readable contract

Parsed by `n8n-contract-test-runner` (`Test-Contract.ps1`). `request.limits` are **gateway-enforced** (unlike portfolio siblings where limits are gateway-delegated).

```json
{
  "contractVersion": "interaction-gateway-v0.5.0",
  "webhookPath": "webhook/portfolio/interaction-gateway",
  "request": {
    "contentType": "text/plain",
    "accepted": ["intent", "payload", "requestId"],
    "required": ["intent"],
    "authHeaders": ["X-Timestamp", "X-Signature"],
    "authScheme": "HMAC-SHA256 over ${X-Timestamp}.${rawBody}, header sha256=<hex>, replay window 300s",
    "limits": { "bodyBytes": 65536, "replayWindowSeconds": 300 },
    "limitsEnforcedBy": "gateway"
  },
  "response": {
    "required": ["ok", "traceId", "intent", "routedTo", "result", "policyVersion"],
    "types": { "ok": "boolean", "routedTo": "array", "traceId": "string" }
  },
  "errors": [
    { "status": 401, "condition": "missing, tampered, or expired signature; unset secret" },
    { "status": 413, "condition": "body exceeds size cap" },
    { "status": 422, "condition": "non-allowlisted or missing intent" }
  ],
  "intents": {
    "support-triage": ["support-triage"],
    "product-feedback": ["product-feedback"],
    "rag": ["rag"],
    "eval": ["eval-harness"],
    "drift": ["scheduled-drift-monitor"],
    "feedback-then-grade": ["product-feedback", "eval-harness"],
    "gateway-selftest": ["gateway-selftest-sibling"],
    "feedback-multi": ["product-feedback", "gateway-selftest-sibling"],
    "notify": ["feishu-notify"]
  }
}
```
