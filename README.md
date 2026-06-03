# n8n-interaction-gateway

A generic, **signed-webhook interaction gateway** for the n8n Workflow-as-Code portfolio — one
authenticated entry point that verifies → normalizes → routes a request to the right business workflow(s),
so each business workflow keeps its clean JSON contract and the gateway owns the production-edge controls
(HMAC signature, body-size cap, secret-stripping, intent allowlist, trace propagation).

> **Status: implemented v0.1.0 (2026-06-03).** The SDK workflow + pure security core are built and proven
> OFFLINE: `verify:gateway` (20/20 pure core) and `verify:workflow` (13 golden scenarios / 133 assertions incl. a differential
> vs the core, run against the COMPILED jsCode), plus `verify:static` / `verify:json`. Live Execute-Workflow
> sibling **execution** is the opt-in next increment; v0.1.0 proves the security controls + the routing decision.

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
5. **Route by decision** — return the resolved target(s) wrapped with a generated `traceId`, synchronously.
   v0.1.0 ships the routing **decision** (offline-proven); live **Execute Workflow** sibling execution
   (in-process, no secret over HTTP) is the opt-in next increment (each target must expose an
   `executeWorkflowTrigger`).

The four security functions are **pure** so the offline gate asserts them without a running n8n. CI is
**stub-default** (assert functions + routing decision, no sibling execution); live routing is opt-in.

## Hard acceptance criteria (asserted negatives — see `docs/eval-plan.md`)

signature-reject · oversized-body-reject · secret-strip · non-allowlisted-intent-reject · traceId-present.

## Design docs

- Spec: [`fixtures/requests/interaction-gateway.md`](fixtures/requests/interaction-gateway.md)
- Architecture decision: [`docs/adr/0001-generic-signed-webhook-gateway.md`](docs/adr/0001-generic-signed-webhook-gateway.md)
- Eval plan: [`docs/eval-plan.md`](docs/eval-plan.md)

## Status & roadmap

**Done (v0.1.0):**
1. ✅ The four pure functions (`scripts/lib/gateway-core.mjs`) + offline self-test (`verify:gateway`, 20/20).
2. ✅ The SDK workflow (`workflows/sdk/interaction-gateway.workflow.js`, 12 nodes): normalize → enforceBodySize
   → verifySignature → stripSecrets → resolveRoute → route-decision → respond, with a generated `traceId`.
3. ✅ `verify:workflow` — runs the **compiled** jsCode against 13 golden scenarios **and** differentially pins
   the four security gates against the core (verdicts, reasons, whole-body strip), so the deployed logic can't
   silently drift. Plus `verify:static` / `verify:json`.
4. ✅ Opt-in `verify:live` (`scripts/Test-GatewayLive.ps1`) — signs a real request to the deployed gateway,
   SKIPping honestly when n8n / the secret / the webhook is absent.

**Deferred (next increments):**
- Live **Execute Workflow** sibling execution (each target must expose an `executeWorkflowTrigger`; the ADR
  rejected HTTP-to-webhook routing to preserve the no-secret-over-HTTP property) + live fan-out.
- Thin Feishu/Slack/Teams inbound adapters onto this generic signed core.
- Rate limiting (gateway/platform-delegated, documented).

License: Apache-2.0.
