# Requirement spec — interaction-gateway

Status: **implemented v0.5.0** — authored eval-first (spec → eval-plan → ADR → build), then built + deployed +
live-verified. Date: 2026-06-03. The security controls are proven OFFLINE (`verify:gateway` 20/20 +
`verify:workflow` 16 scenarios / 166 assertions incl. a differential vs the core, run against the compiled jsCode);
**v0.4.0 adds MULTI-TARGET FAN-OUT** (one intent → N callable siblings in-process via Execute-Workflow, results per-target), proven live. **v0.5.0 adds the UNIFIED NOTIFICATION OUTLET**: intent `notify` → the `feishu-notify` sibling posts a Feishu group card (env-gated send: unconfigured→skipped, error→failed, never a fabricated sent), so no caller ever holds the webhook URL/secret.

## Why this exists

The portfolio's six business workflows each expose a stable JSON webhook contract (now machine-checked by
`n8n-contract-test-runner`). A production chat/bot/partner edge needs **authentication, routing, and
cross-cutting controls** (signature verification, body-size limits, secret-stripping, trace propagation)
that must NOT be duplicated into every business workflow. The interaction-gateway is that separate edge:
**one authenticated, signed entry point** that verifies → normalizes → routes to the right sibling
workflow(s), so each business workflow keeps its clean contract and the gateway owns the production-edge
controls.

**Descoped (per the review):** a **generic SIGNED JSON webhook FIRST** — not Feishu inbound, which is
net-new crypto/protocol (`X-Lark-Signature` + AES-256-CBC decrypt + verification-token + URL-challenge
handshake + async `tenant_access_token` reply) with no existing code to reuse. Feishu/Slack/Teams adapters
are later, thin translators ONTO this generic core.

## Request contract — the signed envelope

`POST /webhook/portfolio/interaction-gateway`

Headers:
- `X-Timestamp: <unix seconds>` — part of the signed material; requests outside the replay window are rejected.
- `X-Signature: sha256=<hex>` — HMAC-SHA256 of `"<X-Timestamp>." + <raw request body>`, keyed by the shared
  gateway secret (runtime env/credential, **never** in the workflow JSON).

Body (JSON):
```jsonc
{
  "intent": "support-triage",   // an ALLOWLISTED intent (see routing); never a caller-supplied URL
  "payload": { /* the target workflow's own request body */ },
  "requestId": "..."            // optional; a traceId is generated if absent
}
```

## Response contract

Synchronous JSON — the routed sibling's result wrapped with gateway metadata:
```jsonc
{
  "ok": true,
  "traceId": "gw-...",               // generated; forwarded to the sibling AND echoed
  "intent": "support-triage",
  "routedTo": ["support-triage"],    // 1+ targets (fan-out composition)
  "result": { /* sibling response, or per-target results on fan-out */ },
  "policyVersion": "interaction-gateway-v0.1.0"
}
```
Errors (all `{ ok:false, error, traceId }`): **401** bad/missing/expired signature · **413** oversized body
· **422** unknown intent / non-allowlisted target.

## The pure functions — the offline-assertable core

The security + routing logic is extracted into PURE functions so they are asserted **in-process without a
running n8n** (the stub-default offline gate). The Code nodes are thin wrappers over these:

- `verifySignature(rawBody, timestamp, signatureHeader, secret, nowSeconds, windowSeconds) -> { ok, reason }`
  — timing-safe HMAC-SHA256 compare over `timestamp + "." + rawBody`; rejects stale timestamps (replay guard).
- `enforceBodySize(rawBody, maxBytes) -> { ok, reason }`.
- `stripSecrets(obj, patterns) -> { clean, stripped[] }` — removes any field whose key or value matches the
  shared secret-pattern set; a secret is NEVER forwarded to a sibling, echoed in the response, or logged.
- `resolveRoute(intent, allowlist) -> { ok, targets[], reason }` — maps an intent to 1+ allowlisted sibling
  targets; rejects unknown / non-allowlisted intents. Callers never supply a URL (SSRF-closed by construction).

## Routing model

- gateway → sibling uses the **Execute Workflow** (in-process sub-workflow) pattern — data passes
  n8n-internally, so **no secret forwarding over HTTP by construction**. **v0.1.0 status:** the routing
  **decision** (intent → allowlisted targets, with the forwarded clean payload + `traceId`) is built and
  offline-proven; live Execute-Workflow **execution** is the opt-in next increment (each target must expose
  an `executeWorkflowTrigger` — none do yet; HTTP-to-webhook routing was rejected to keep the no-HTTP property).
- The allowlist is a fixed `intent → workflow` map (the known sibling ids); a caller can NEVER name an
  arbitrary URL/host.
- **Fan-out:** an intent may map to >1 target (e.g. `feedback-then-grade` → product-feedback → eval-harness);
  results are returned per-target. (This is the composition piece the refined plan folded in from P3.)
- Every routed call carries the generated `traceId`/`requestId` — the cross-workflow trace metadata the
  review noted is absent today (source carries only `runId` + an index key).

## Stub-default

CI touches only the STUB path: the offline gate asserts the four pure functions + the routing DECISION
(intent → targets) deterministically, with NO sibling execution. Live mode (opt-in) actually
Execute-Workflows the sibling on a running n8n.

## Hard acceptance criteria (asserted — see docs/eval-plan.md, not prose bullets)

1. **signature-reject** — bad / missing / expired signature → 401, request NOT routed.
2. **oversized-body-reject** — body over the cap → 413, NOT routed.
3. **secret-strip** — a payload carrying a secret-like field → the routed payload + response + audit contain NO secret.
4. **non-allowlisted-intent-reject** — unknown intent / non-allowlisted target → 422, NOT routed.
5. **traceId-present** — every accepted request routes with, and echoes, a generated traceId.

## Out of scope (v0.1.0)

- Feishu/Slack/Teams inbound adapters (thin translators onto this core — later).
- Async/queued replies (this is synchronous request/response).
- Rate limiting (a gateway/platform-layer responsibility — documented as delegated, not implemented in-workflow).
