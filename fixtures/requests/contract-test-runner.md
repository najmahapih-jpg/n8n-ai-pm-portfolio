# Requirement spec — contract-test-runner

Status: **design (P2′)** — authored before implementation, per the portfolio's eval-first discipline
(spec → eval-plan → ADR → build). Date: 2026-06-02.

## Why this exists

The portfolio publishes a per-project `docs/workflow-contract.md`, but nothing *enforces* that a workflow's
actual request/response shape still matches its published contract. The plan's stated Remaining Gap was
"No contract tests generated from `workflow-contract.md`." `contract-test-runner` closes that gap: it turns
each prose contract into a **machine-checkable conformance gate**, extending the portfolio's standout
honest-eval signal from "the workflow is correct" to "the workflow still honors its published interface."

It is a **standalone tool you point at a target repo** (like a linter), not a per-repo copy — so the
contract format + assertion logic live in one place and cannot drift per-repo. A reference run validates
all six sibling contracts.

## The machine-readable contract block (what each `workflow-contract.md` adopts)

Each target repo's `docs/workflow-contract.md` gains ONE fenced block under a `## Machine-readable contract`
heading. It is the single source the runner parses:

```json
{
  "contractVersion": "support-triage-v0.2.0",
  "webhookPath": "webhook/portfolio/support-triage",
  "request": {
    "required": ["channel", "subject", "message"],
    "optional": ["accountId", "source"],
    "limits": { "bodyBytes": 65536, "messageChars": 8000 },
    "limitsEnforcedBy": "gateway"
  },
  "response": {
    "required": ["category", "urgency", "routingTeam", "slaHours", "handlingPath", "auditEventId"],
    "types": { "category": "string", "urgency": "string", "slaHours": "number", "auditEventId": "string" }
  },
  "errors": [
    { "when": "missing required field", "status": 400, "responseRequired": ["ok"], "okValue": false }
  ]
}
```

Honesty rule (carried from the P1.6 relabel): `request.limits` are documented caps; `limitsEnforcedBy:
"gateway"` states plainly they are NOT workflow-enforced. The runner therefore does **not** assert the
workflow rejects oversized input — it only asserts the cap is *declared* and consistent.

## The runner

`scripts/Test-Contract.ps1 -RepoPath <path-to-target-repo> [-Live] [-BaseUrl <url>]`

- **Offline mode (default, stub — the CI gate):** no running n8n required.
- **Live mode (`-Live`, opt-in):** re-POSTs golden requests to the target's live webhook and validates the
  real response — gated behind a connection check that SKIPs honestly when n8n is unavailable (the P1.6
  pattern), never a false green.

### Offline assertions (deterministic, no network)
1. **contract-parses** — the `## Machine-readable contract` block exists and is valid JSON with the
   required keys (`contractVersion`, `webhookPath`, `request`, `response`).
2. **version-matches** — `contractVersion` equals the target's `meta.json` / `policyVersion` (no stale
   contract).
3. **webhookPath-matches** — `webhookPath` equals the path in the target's canonical workflow JSON
   (the contract points at the real endpoint).
4. **fixtures-use-declared-request-fields** — every key used by `fixtures/golden/*.json` (and the request
   examples in the contract doc) is in `request.required ∪ request.optional` (no undocumented input).
5. **limits-are-labeled** — every `request.limits` entry carries `limitsEnforcedBy` (no silent "enforced"
   claim — the honest-eval guard against the exact defect P1.6 fixed).

### Live assertions (opt-in, `-Live`)
6. **response-conforms** — for each golden request, the live response contains every `response.required`
   field, each matching `response.types`.
7. **errors-conform** — each declared `errors[]` case, when triggered, returns the documented `status` and
   `responseRequired` shape (e.g. missing-field → HTTP 400 + `ok:false`).
8. **no-secret-leak** — the response contains no raw secret/PII (reuses the shared secret-pattern scan).

### Assertion taxonomy (mirrors the portfolio's 5-type model)
`contract-parse | version-match | shape-conform | error-conform | masking` — each prints a PASS/FAIL line;
any FAIL exits non-zero (CI-gateable, like `verify:static`).

## Self-honesty (how the runner is itself tested — see docs/eval-plan.md)

The runner is graded by its OWN golden fixtures: a `good-contract` (all assertions PASS) and several
`bad-contract` negatives (missing block, stale version, undocumented field, unlabeled limit, wrong webhook
path) that each MUST flip the relevant assertion to FAIL — so the gate cannot silently no-op. This is the
digest-integrity / citation-integrity discipline applied to the contract checker itself.

## Out of scope (v0.1.0)
- Generating the contract block from the SDK automatically (manual adoption first; auto-derivation later).
- Deep JSON-schema typing (start with required-fields + primitive types).
- Enforcing the documented size caps (they are gateway-delegated by design — see the honesty rule above).
