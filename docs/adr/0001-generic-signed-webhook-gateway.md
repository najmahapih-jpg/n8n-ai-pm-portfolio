# ADR-0001 — A generic, signed-webhook interaction gateway with a pure-function security core

Date: 2026-06-02 · Status: Accepted (design phase, pre-implementation)

## Context

The portfolio needs a production-facing edge that authenticates callers and routes to the right business
workflow, without duplicating auth/routing/cross-cutting controls into each of the six contract-clean
workflows. The refined plan **descoped** this from a Feishu-bot-first design to a generic signed webhook,
because Feishu inbound is net-new crypto/protocol (`X-Lark-Signature` + AES-256-CBC decrypt +
verification-token + URL-challenge handshake + async reply) with no existing code to reuse, while a generic
HMAC-signed JSON webhook is offline-testable and low-maintenance. The plan also folded the standalone
"workflow-orchestrator" into this gateway (intent-routed fan-out is the only genuinely new composition).

## Decision

Build **`n8n-interaction-gateway`**: a single `POST` webhook that

1. **Verifies an HMAC-SHA256 signature** over `timestamp + "." + rawBody` (shared secret in runtime
   env/credential, never in the workflow JSON) with a timing-safe compare and a replay window.
2. Enforces a **body-size cap**, **strips secrets** from the inbound payload, and routes by an
   **allowlisted `intent`** (callers never supply a URL → SSRF-closed by construction).
3. Routes to sibling workflow(s) via the **Execute Workflow** (in-process sub-workflow) pattern reused from
   lead-intelligence — data passes n8n-internally, so **no secret forwarding over HTTP**.
4. Supports **fan-out** (an intent → >1 target) for composition, and stamps a generated
   **`traceId`/`requestId`** on every routed call + the response.

The security + routing logic lives in **pure functions** (`verifySignature` / `enforceBodySize` /
`stripSecrets` / `resolveRoute`), so the offline gate asserts them **in-process without a running n8n**.
**Stub-default** everywhere CI touches (assert the functions + the routing decision, no sibling execution);
live routing is opt-in. The five controls are **hard acceptance criteria** (asserted negatives), not prose.

## Alternatives considered

1. **Feishu-inbound first (rejected).** Net-new crypto/protocol/async-reply, no reuse; the only existing
   Feishu code is the *outbound* custom-bot signer. A generic signed webhook is cheaper, offline-testable,
   and Feishu becomes a thin later adapter onto it.
2. **Per-workflow authentication (rejected).** Pushing signature/secret-strip/allowlist into each of the
   six workflows duplicates the logic and pollutes their clean contracts. One edge = one source of truth.
3. **A standalone `workflow-orchestrator` (rejected / folded in).** Cross-workflow invocation + partial-
   failure degradation already exist (eval `sutMode:"workflow"`, drift A→B→D). The only new piece —
   intent-routed fan-out — belongs in this gateway, not a separate standing surface.
4. **Caller-supplied target URLs (rejected).** A fixed intent→allowlist map closes SSRF by construction;
   this is the exact gap the drift-monitor review flagged, designed out from the start here.

## Consequences

**Positive** — one authenticated production edge; security logic is pure + offline-asserted (signature /
size / secret-strip / allowlist all proven without n8n); SSRF-closed by construction; trace propagation
(the missing `traceId` the review noted); business workflows stay contract-clean; reuses the harness
(stub-default, assertion taxonomy, secret scan, SKIP-when-live-absent).

**Negative / trade-offs** — a new standing surface against the low-maintenance mandate (mitigated:
stub-default, no provider SDK, synchronous-only, no queue/state). The signed webhook is unauthenticated at
the n8n layer (`authentication:'none'`) but authenticated by the in-workflow HMAC check — deployment must
still add TLS + rate limits + replay controls at the gateway/platform layer (documented, delegated). Live
routing depends on sibling workflows being deployed + active.

## Adoption sequence

1. Build the four pure functions + their offline assertions (the hard-acceptance negatives).
2. Build the 21-ish node workflow (verify → size → strip → resolve-route → Execute-Workflow(s) → respond).
3. Wire `verify:static` / `verify:gateway` (offline) + opt-in `verify:live` (routes to a live sibling).
4. Later: thin Feishu/Slack inbound adapters that translate onto this generic signed core.
