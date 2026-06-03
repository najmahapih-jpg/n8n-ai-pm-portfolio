# ADR-0001 — A generic, signed-webhook interaction gateway with a pure-function security core

Date: 2026-06-02 (implementation note 2026-06-03) · Status: Accepted; **implemented v0.1.0**

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
2. Build the 21-ish node workflow (verify → size → strip → resolve-route → Execute-Workflow(s) → respond). *(Superseded by the Implementation Note below: built as a 12-node linear pipeline, decision-only routing, size-before-signature.)*
3. Wire `verify:static` / `verify:gateway` (offline) + opt-in `verify:live` (routes to a live sibling).
4. Later: thin Feishu/Slack inbound adapters that translate onto this generic signed core.

## Implementation note (v0.1.0, 2026-06-03)

Built as a **12-node** SDK workflow (`workflows/sdk/interaction-gateway.workflow.js`), compiled to canonical
JSON via `@n8n/workflow-sdk` (`parseWorkflowCode`), mirroring the drift-monitor toolchain.

- **Pipeline order is size-before-signature** (the decision above listed signature first): an oversized body
  is rejected (413) *before* spending crypto. Each gate computes its verdict in JS and only the first failure
  flips the status (401/413/422); the `respondToWebhook` node merely echoes the JS-decided `statusCode`, so
  the contract-critical codes are proven offline, independent of n8n's live respond plumbing.
- **A linear pipeline, not IF-gated branches.** Because the status is decided in JS, the response needs no
  runtime branch; an IF-gated live-vs-stub split is a future increment. This keeps the workflow inspectable
  without decorative dead nodes.
- **Routing is a DECISION in v0.1.0, not execution.** The eval-plan Layer-2 scope ("pure functions + routing
  decision, NO sibling execution") is fully met and offline-proven. Live **Execute Workflow** execution is
  deferred because **no current sibling exposes an `executeWorkflowTrigger`** (they are webhook-triggered);
  adding one per target is a small, separate increment. **HTTP-to-webhook routing was rejected** even though
  it would "work" sooner — it would forward over HTTP and break the *no-secret-over-HTTP-by-construction*
  property this ADR commits to. Honesty over expedience.
- **The deployed copy is held to the audited core BY TEST.** n8n Code nodes can't import `gateway-core.mjs`,
  so the security logic is necessarily a copy. `scripts/test-gateway-workflow.mjs` extracts each Code node's
  body from the *compiled* JSON, runs the 15 golden scenarios against it, **and** asserts node-output ≡
  core-output on identical inputs for the four security gates — verdicts, reason strings, and the whole-body
  strip (155 assertions). A future edit that lets the n8n copy drift from the 20/20-proven library turns the
  gate red. (The harness uses `new Function` over our **own** version-controlled jsCode — no untrusted input
  is interpolated; it is the deliberate "run the deployed code" pattern.)
- **`stripSecrets` runs over the WHOLE envelope, and security primitives fail CLOSED.** A secret-shaped
  `intent`/`requestId` (client-controlled, echoed/reflected into the trace id + audit) is redacted before
  use; an unset signing secret or a non-finite clock is a hard reject (an empty HMAC key is forgeable, and
  `Math.abs(NaN) > w` would otherwise skip the replay check). These are pinned by negative self-tests.
- **Open CORS is an intentional trade-off for a signed M2M edge.** The webhook sets `allowedOrigins:'*'` +
  `authentication:'none'` at the n8n layer; the auth IS the in-workflow HMAC, so any origin may *attempt* a
  request but only a correctly-signed one is processed. A deployment that fronts the gateway for browsers
  should pin `allowedOrigins` to known callers. TLS, rate-limits, and replay caps remain platform-delegated.
- **Live deployment surfaced an offline blind spot (the honest-eval payoff).** Deployed + activated via the
  n8n REST API as id `YKT4FJmC8Xg2G9hs`; `verify:live` proves valid→200 + echoed `traceId` and tampered→401.
  The FIRST live run failed `crypto is not defined`: n8n's **external task-runner** sandbox exposes no `crypto`
  global, but the offline harness had injected one — so 133/133 offline was green while the workflow was
  *undeployable*. Fixed by `require('crypto')` in the Code nodes + `NODE_FUNCTION_ALLOW_BUILTIN=crypto` on the
  runner, and the harness now injects a real `require` so the differential still pins the deployed copy.
  Deploy requirements: `GATEWAY_SIGNING_SECRET` + `NODE_FUNCTION_ALLOW_BUILTIN=crypto` in the **runner** env.

## Implementation note (v0.2.0, 2026-06-03) — real in-process sibling routing

v0.2.0 implements the ADR's Execute-Workflow routing and proves it live. The gateway grew to **17 nodes**: after
`resolveRoute`, an IF gate (`Live Route To Sibling?`) branches — for a **callable** target (one with a known
`executeWorkflowTrigger` id in `TARGET_WORKFLOW_IDS`) when `mode==='live'` OR intent `gateway-selftest`, it routes
`Prepare Sibling Input → Execute Sibling (in-process) → Merge Sibling Result → Respond`; otherwise the decision path.
The sibling receives ONLY the secret-stripped clean payload + intent + `traceId` (never the rawBody/signature);
`Merge Sibling Result` re-attaches the gateway metadata via `$('Prepare Sibling Input')`.

- **Proven live** against `gateway-selftest-sibling` (id `yqjMTU3XHwBT8b0L`, a 3-node sub-workflow in this repo):
  a signed `gateway-selftest` request returns `result.executed:true` with the sibling's real output; a business
  intent (`support-triage`) returns `executed:false` (decision-only) — the gating is correct.
- **n8n 2.x findings (caught live, in an isolated throwaway caller before touching the gateway):** (1)
  `executeWorkflow` is **typeVersion 1.2** with a **resourceLocator** `workflowId` (`{ __rl, value, mode:'id' }`);
  (2) a referenced sub-workflow must be **published (active)** in n8n 2.x — activating suffices even for an
  `executeWorkflowTrigger`-only workflow.
- **Business siblings deliberately NOT modified.** Each is on its own toolchain (e.g. support-triage uses the n8n
  MCP); rebuilding them through the gateway's standalone compiler would risk their committed canonicals. The
  dedicated callable sibling proves the mechanism; wiring each business sibling is the same pattern, per-repo.
- **HTTP-to-webhook routing stays rejected** — the in-process Execute-Workflow path keeps the
  no-secret-over-HTTP property this ADR commits to (and the payload is secret-stripped regardless).

## Implementation note (v0.3.0, 2026-06-03) — a real business sibling, wired

v0.3.0 wires the first REAL business sibling and makes routing dynamic. `TARGET_WORKFLOW_IDS` now maps both
`gateway-selftest-sibling` and `product-feedback` (id `6Gc3wmri0tJre07B`) to their n8n ids; the gate keys on
**callability alone** (`accepted && targetCallable`) — a target executes iff it has a wired id — so no `mode`
flag/restart is needed, and non-callable business intents stay decision-only. The `Execute Sibling` node's
`workflowId` is now a **dynamic resourceLocator** (`={{ $json.__targetId }}`), and `Prepare Sibling Input`
spreads the clean payload at top level (so business siblings read `feedbackText` etc.) while keeping a `payload`
key (for the selftest sibling) — one shape that serves multiple sibling input contracts.

- **Proven live:** a signed `product-feedback` request routes IN-PROCESS to the real SUT and returns its genuine
  classification (`theme/sentiment/urgency/priorityScore`); the selftest sibling still works via the dynamic id.
- **The SUT was not regressed.** product-feedback (a SUT graded by the eval harness) got the `executeWorkflowTrigger`
  ADDITIVELY (it feeds the same `Normalize Feedback Payload` the webhook does); its webhook contract was
  regression-tested after deploy (`theme=bug` / `theme=praise`) and is byte-unchanged. It is on the n8n-MCP
  toolchain; since no MCP was connected this session, it was compiled via the standalone `@n8n/workflow-sdk`
  compiler (which reproduced its 28 nodes exactly before the +1 trigger) and deployed via REST PUT.
