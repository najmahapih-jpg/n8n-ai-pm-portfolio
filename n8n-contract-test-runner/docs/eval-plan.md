# Eval plan — contract-test-runner

The contract checker is held to the same two-tier, stub-default discipline as the workflows it checks.
"Who tests the contract-tester" is answered here: the runner is graded by its OWN golden contracts.

## Layer 1 — static (offline, in CI)

| Check | Asserts |
| --- | --- |
| PowerShell parse | every `scripts/*.ps1` parses |
| JSON parse | every `fixtures/**/*.json` (self-test contracts + expectations) is valid JSON |
| secret scan | no secret/PII in any tracked file (shared pattern set) |

## Layer 2 — behavioral (offline, stub; the runner run against fixture contracts)

The runner is pointed at synthetic target fixtures under `fixtures/self/` — a known-good contract and a
set of deliberately-broken ones. Each negative MUST flip exactly the assertion it targets, so the gate
cannot silently pass.

| Self-test fixture | Drives | Expected |
| --- | --- | --- |
| `good-contract` | a well-formed contract + aligned fixtures | ALL offline assertions PASS |
| `bad-missing-block` | no `## Machine-readable contract` block | `contract-parse` FAIL |
| `bad-stale-version` | `contractVersion` ≠ meta/policyVersion | `version-match` FAIL |
| `bad-undeclared-field` | a golden request uses an undocumented field | `shape-conform` (fixtures-use-declared) FAIL |
| `bad-unlabeled-limit` | a `request.limits` entry without `limitsEnforcedBy` | `limits-are-labeled` FAIL |
| `bad-wrong-webhook` | `webhookPath` ≠ the workflow JSON's path | `webhookPath-match` FAIL |

A final harness self-test (no target call) builds an in-memory "good" then "tampered" contract and confirms
the assertion functions report PASS then FAIL respectively — the membership/integrity guard pattern reused
from `Test-RagAssistantWorkflow.ps1` / `Test-DriftMonitorWorkflow.ps1`.

## Opt-in live tier (`-Live`, not in CI)

Pointed at a deployed sibling (e.g. support-triage), behind the connection-check SKIP gate:
- `response-conform` — each golden request's live response carries every `response.required` field at the
  declared type.
- `error-conform` — the documented error case (missing required field) returns the documented status+shape.
- `masking` — no raw secret/PII in the live response.

If live n8n / keys are absent the live tier prints **SKIPPED** (exit 0, labeled) — never a false pass
(the P1.6 honesty rule).

## Gates (planned)

| Script | Tier | In CI |
| --- | --- | --- |
| `npm run verify:static` | Layer 1 | yes |
| `npm run verify:self` | Layer 2 (runner vs self-test contracts) | yes (offline) |
| `npm run verify:portfolio` | offline run over all six sibling contracts | yes (offline; SKIPs siblings whose contract block is not yet adopted) |
| `npm run verify:live -- -RepoPath <sibling>` | opt-in live | no |
