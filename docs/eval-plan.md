# Eval plan — interaction-gateway

The gateway is held to the portfolio's two-tier, stub-default discipline. The security controls are
**asserted negatives**, not prose: each control has a fixture that MUST be rejected (and proven *not
routed*), so the gate cannot silently pass an insecure request.

## Layer 1 — static (offline, in CI)

| Check | Asserts |
| --- | --- |
| PowerShell parse | every `scripts/*.ps1` parses |
| JSON parse | every `fixtures/**/*.json` is valid JSON |
| secret scan | no secret/PII in any tracked file (shared pattern set) |

## Layer 2 — behavioral (offline, stub; pure functions + routing decision, NO sibling execution)

Golden fixtures drive each control. "routed=false" is asserted as a **negative** (the request reaches no
target) so a rejection cannot leak through.

| Golden scenario | input | expected |
| --- | --- | --- |
| `sig-valid` | correct HMAC over `timestamp.body`, fresh timestamp | accepted; `resolveRoute` returns the target |
| `sig-tampered` | body changed after signing | **401**; routed=false |
| `sig-missing` | no `X-Signature` | **401**; routed=false |
| `sig-expired` | timestamp outside the replay window | **401**; routed=false |
| `body-oversize` | raw body > `maxBytes` | **413**; routed=false |
| `secret-in-payload` | payload carries an `sk-…`/`sb_secret_…`/bearer field | accepted but `stripSecrets.stripped[]` non-empty; routed payload + response contain NO secret |
| `intent-unknown` | `intent` not in the allowlist | **422**; routed=false |
| `intent-fanout` | an intent mapping to 2 allowlisted targets | `routedTo.length == 2` (composition) |
| `traceId-present` | any accepted request | response `traceId` non-empty and echoed to the target |

### Harness self-test (no workflow call — the pure functions in isolation)
Mirrors the digest-integrity / citation-integrity guards: build a known-good signed payload and assert
`verifySignature` returns ok; flip one byte and assert it returns reject; feed `stripSecrets` an object
with a planted `sb_secret_…` and assert it is removed; feed `resolveRoute` a non-allowlisted intent and
assert rejection. This proves the four security functions actually fire (the gate can't no-op).

## Opt-in live tier (`-Live`, not in CI)

Behind a connection-check SKIP gate (the P1.6 pattern): sign a real `support-triage` request, POST it to
the deployed gateway webhook, and assert the response wraps the sibling's real triage result with a
`traceId`. SKIPs honestly (exit 0, labeled) when n8n / the sibling is unavailable — never a false green.

## Gates (planned)

| Script | Tier | In CI |
| --- | --- | --- |
| `npm run verify:static` | Layer 1 | yes |
| `npm run verify:gateway` | Layer 2 (pure functions + routing decision, offline stub) | yes |
| `npm run verify:live` | opt-in live routing to a deployed sibling | no |

## Invariants (the testable core)

1. **Authenticated-by-construction** — no request is routed without a valid, fresh HMAC signature.
2. **SSRF-closed-by-construction** — targets come only from the fixed intent→allowlist; callers never name a URL.
3. **No-secret-forwarding** — a secret in the inbound payload never reaches a sibling, the response, or a log.
4. **Trace-propagation** — every routed call + response carries a generated `traceId`.
