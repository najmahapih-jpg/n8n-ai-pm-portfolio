# Evaluation Methodology — Lead Intelligence API

This document reframes the 11 pin-data fixtures of the `Portfolio - Lead Intelligence API`
workflow as a **behavioral evaluation suite**. It is the richer of the two portfolio suites:
it already exercises five distinct assertion *types*, including the numeric-range and
structural-absence idioms that a future LLM workflow needs. Companion:
[ADR-0001](adr/0001-deterministic-scoring-over-llm.md) records *why* scoring is deterministic.

## Two-tier validation (what is enforced where)

The behavioral eval is a **local** step, not a CI gate.

| Tier | Runs where | Command | What it proves | Executes the workflow? |
| --- | --- | --- | --- | --- |
| **1 — Static gate** | GitHub Actions on every push/PR (`.github/workflows/ci.yml`) | `Invoke-StaticValidation.ps1` + `Test-RepositorySecrets.ps1` | PS parse, fixture JSON parse, workflow JSON structure, **no secrets** | No |
| **2 — Behavioral eval** | Local, requires live n8n at `localhost:5678` + `N8N_MCP_TOKEN` | `Test-LeadIntelligenceWorkflow.ps1` | Every grade band, dedup branch, validation failure, and the zero-PII-leak invariant | **Yes**, via official n8n MCP `test_workflow` |

CI runs offline only by design (see `docs/validation-runbook.md`); do not call the behavioral
suite "CI-enforced."

## How the eval executes

`Test-LeadIntelligenceWorkflow.ps1` resolves the workflow id from
`workflows/sdk/lead-intelligence.meta.json`, pins each fixture into the
`Run Demo Lead From n8n UI` trigger, runs the graph through the official n8n MCP `test_workflow`
tool, then asserts on the response-builder node for that branch (`Build Lead Intelligence
Response`, `Build Duplicate Lead Response`, `Build Email Syntax Error`, or `Build Required
Field Error`). Every case also asserts `policyVersion = lead-intel-v0.1.0`.

## Assertion taxonomy

| Type | Helper | Applied to | Why this type |
| --- | --- | --- | --- |
| **Exact-match** | `Assert-Equal` | `statusCode`, `ok`, `duplicate`, `grade`, `route.ownerQueue`, `route.ownerTeam`, `followUp.slaHours`, `followUp.hotLead`, `notification.status`, `manuallyOverridden`, `policyVersion`, `action`, `reason`, `error`, `redactedEmail` | The categorical decision and its policy. |
| **Numeric-range band** | `Assert-NumberBetween` | `priorityScore` (per-grade band), `icpFitScore` (0–100), `intentScore` (0–100) | The *grade band* is the business invariant; the exact integer from the weighted formula is an implementation detail and must not be pinned. |
| **Format / parse** | `Assert-ParseableDate` | `followUp.dueAt` | Time-relative value; pin the format, not the literal. |
| **Structural / absence** | `Assert-HasNoProperty` | duplicate response must lack `grade`/`route`/`followUp`; `crmPayload` must lack `email`/`companyDomain` | Proves the response *shape* is branch-correct and that the CRM payload carries no PII. |
| **Negative + masking** | `Assert-NoRawPiiLeak` | `auditEvent` and `response` | Neither may contain the raw email / full name / message probe; audit must omit raw `email`/`fullName`/`message` fields and carry a `***`-masked `redactedEmail`. |
| **Relational / prefix** | inline | `leadId` starts `lead_`, `auditEventId` starts `audit_`, `crmPayload.externalId == leadId`, non-blank `idempotencyKey`, competitor audit `evidence` contains `competitor_domain` | Encodes the idempotency/dedup contract and the disqualification evidence trail. |

## Coverage matrix

11 fixtures cover the full A–D grade ladder, both dedup branches, an adversarial competitor
case, a human-override path, and two distinct validation failures.

| Fixture | Intent | Path | status | grade | priority band | ownerQueue | SLA (h) | hot |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `lead-hot-enterprise` | High ICP + high intent | scored | 200 | A | 80–100 | enterprise-ae | 2 | yes |
| `lead-midmarket-qualified` | Mid ICP/intent | scored | 200 | B | 62–79 | midmarket-ae | 8 | no |
| `lead-high-intent-low-fit` | High intent, low ICP | scored | 200 | C | 40–61 | sdr-qualification | 48 | no |
| `lead-student-low-fit` | Student / academic | scored | 200 | D | 0–39 | nurture | 168 | no |
| `lead-low-intent-newsletter` | Newsletter signup | scored | 200 | D | 0–39 | nurture | 168 | no |
| `lead-duplicate-existing-id` | Explicit `existingLeadId` | dedup | 200 | — | — | — | — | — |
| `lead-duplicate-domain` | Known duplicate domain | dedup | 200 | — | — | — | — | — |
| `lead-competitor-domain` | Competitor domain | scored (capped) | 200 | D | 0–25 | disqualified-competitor | 168 | no |
| `lead-manual-override` | Manual grade override | scored | 200 | A | 85–100 | enterprise-ae | 2 | yes |
| `lead-bad-email` | Malformed email | validation | 422 | — | — | — | — | — |
| `lead-missing-company` | Missing `companyName` | validation | 400 | — | — | — | — | — |

Scoring rubric under test (`docs/scoring-policy.md`): ICP fit base 20, intent base 30,
`priorityScore = round(icpFitScore*0.58 + intentScore*0.42)`, competitor scores capped at 25,
manual override raises priority to ≥85. Grades: A ≥ 80, B ≥ 62, C ≥ 40, D < 40.

### Why these inputs (input-selection rationale)

- **The whole grade ladder, including both ends.** A (hot enterprise) through D (student /
  newsletter) so every routing tier and SLA is exercised.
- **Both dedup *mechanisms*, not just "a duplicate."** `existing-id` tests the explicit
  idempotency key; `duplicate-domain` tests the heuristic domain match — different code paths
  with different `reason` strings.
- **Adversarial + human-in-the-loop.** `competitor-domain` proves the score cap (≤25),
  disqualification route, and an `evidence` tag in the audit trail; `manual-override` proves a
  human grade takes precedence over the computed score (priority floored at 85) — a deliberate
  control point.
- **Two failure *classes*, two status codes.** `bad-email` → 422 (semantic/syntactic),
  `missing-company` → 400 (structural). Distinct codes prove the validation gate distinguishes
  failure types rather than collapsing them.

### Why these expected outputs (expected-output rationale)

`priorityScore` is asserted as a **band**, not a point, because the band *is* the grade and the
exact integer is a formula detail; pinning the integer would create brittle, meaningless
failures. PII invariants are asserted on **both** the audit event and the response. The
`crmPayload.externalId == leadId` + non-blank `idempotencyKey` assertions encode the
idempotency contract that makes re-delivery safe. Structural-absence assertions prove a
duplicate response never leaks scoring fields.

## Regression semantics

A failure is a behavioral delta. Categoricals (grade, route, SLA, dedup action) are
exact-matched, so any drift fails loudly. Range bands tolerate a *formula tweak that stays
within a grade* but catch a tweak that **crosses a grade boundary** — exactly the line that
matters. Negative/structural assertions catch the highest-severity failure modes (PII leak,
wrong response shape) that an output-value diff would miss.

## Production metrics this eval would back

- Grade-distribution drift over time (are we silently inflating/deflating grades?).
- Dedup **precision/recall** (false merges lose leads; missed dups create duplicates).
- **PII-leak escapes** — target 0 (guarded by `Assert-NoRawPiiLeak`).
- Idempotency-key collisions — target 0.
- Manual-override rate (how often humans disagree with the model) and routing accuracy vs. human SDR labels.

## Generalizing to non-deterministic (LLM) workflows

This suite is the proof that the assertion idioms a future LLM workflow needs **already exist
in the harness**: numeric-range bands (`Assert-NumberBetween`), structural-absence
(`Assert-HasNoProperty`), and masking/negative checks (`Assert-NoRawPiiLeak`). An LLM-scored
variant would keep the band + structural + masking assertions, add a confidence threshold, and
assert that low-confidence output falls back to the deterministic score — i.e., evaluate
schema-conformance and graceful degradation, not the model's taste.

## Résumé framing (bullets this artifact supports)

- Built a multi-band scoring evaluation (11 fixtures) for a B2B lead-intelligence API,
  validating ICP/intent priority bands (A–D), both deduplication branches, and a zero-PII-leak
  audit invariant using exact-match, numeric-range, structural-absence, masking, and relational
  assertions via the official n8n MCP.
- Encoded an idempotency contract (`externalId == leadId`, non-blank idempotency key) as a
  tested invariant so CRM re-delivery is safe by construction.
- Designed a human-in-the-loop override path that takes precedence over the computed score, with
  a dedicated fixture proving the control works.
