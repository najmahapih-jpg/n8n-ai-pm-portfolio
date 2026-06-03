# n8n-interaction-gateway

A generic, **signed-webhook interaction gateway** for the n8n Workflow-as-Code portfolio — one
authenticated entry point that verifies → normalizes → routes a request to the right business workflow(s),
so each business workflow keeps its clean JSON contract and the gateway owns the production-edge controls
(HMAC signature, body-size cap, secret-stripping, intent allowlist, trace propagation).

> **Status: design phase (2026-06-02).** The spec, ADR, and eval plan are authored; the workflow + pure
> security functions are **not yet implemented**, per the portfolio's eval-first rule
> (spec → eval-plan → ADR → build).

## Why generic-signed-webhook first (not Feishu)

Feishu inbound is net-new crypto/protocol (`X-Lark-Signature` + AES-256-CBC decrypt + verification-token +
URL-challenge handshake + async reply) with no existing code to reuse. A generic HMAC-signed JSON webhook
is offline-testable and low-maintenance; Feishu/Slack/Teams become thin later adapters **onto** it. This
gateway also absorbs the standalone "orchestrator" — intent-routed **fan-out** composition lives here.

## How it will work

`POST /webhook/portfolio/interaction-gateway` with `X-Timestamp` + `X-Signature: sha256=<hmac>` over
`timestamp + "." + rawBody`. The gateway:

1. **verifySignature** (timing-safe HMAC-SHA256 + replay window) → else 401.
2. **enforceBodySize** → else 413.
3. **stripSecrets** from the payload (never forwarded/echoed/logged).
4. **resolveRoute(intent → allowlist)** — callers never name a URL (SSRF-closed) → else 422.
5. **Execute Workflow** the sibling(s) in-process (no secret forwarding over HTTP), stamp a `traceId`,
   return the wrapped result synchronously.

The four security functions are **pure** so the offline gate asserts them without a running n8n. CI is
**stub-default** (assert functions + routing decision, no sibling execution); live routing is opt-in.

## Hard acceptance criteria (asserted negatives — see `docs/eval-plan.md`)

signature-reject · oversized-body-reject · secret-strip · non-allowlisted-intent-reject · traceId-present.

## Design docs

- Spec: [`fixtures/requests/interaction-gateway.md`](fixtures/requests/interaction-gateway.md)
- Architecture decision: [`docs/adr/0001-generic-signed-webhook-gateway.md`](docs/adr/0001-generic-signed-webhook-gateway.md)
- Eval plan: [`docs/eval-plan.md`](docs/eval-plan.md)

## Next step (implementation)

1. The four pure functions (`scripts/lib/`) + their offline self-test (the hard-acceptance negatives).
2. The SDK workflow (verify → size → strip → resolve-route → Execute-Workflow(s) → respond) + `traceId`.
3. `verify:static` / `verify:gateway` gates + opt-in `verify:live` routing to a deployed sibling.
4. Later: thin Feishu/Slack inbound adapters onto this generic signed core.

License: Apache-2.0.
