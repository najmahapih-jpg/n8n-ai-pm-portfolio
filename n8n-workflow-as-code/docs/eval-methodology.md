# Evaluation Methodology — Support Triage API

This document reframes the 8 pin-data fixtures of the `Portfolio - Support Triage API`
workflow as a **behavioral evaluation suite**, and states exactly what is and is not
enforced automatically. It is the companion to [ADR-0001](adr/0001-deterministic-routing-over-llm-classification.md),
which records *why* this workflow uses deterministic routing rather than an LLM classifier.

> Scope note: this is an evaluation of a **deterministic** workflow, so "eval" here means
> regression assertions against golden decisions. The methodology generalizes to a
> non-deterministic (LLM) workflow by swapping exact-match assertions for
> schema + range + confidence assertions — see the "Generalizing to non-deterministic
> workflows" section.

## Two-tier validation (what is enforced where)

The single most important honesty point: **the behavioral eval is a local step, not a CI gate.**

| Tier | Runs where | Command | What it proves | Executes the workflow? |
| --- | --- | --- | --- | --- |
| **1 — Static gate** | GitHub Actions on every push/PR (`.github/workflows/ci.yml`) | `Invoke-StaticValidation.ps1` + `Test-RepositorySecrets.ps1` | PS parse, fixture JSON parse, workflow JSON structure (27-node floor), Feishu guardrails, **no secrets** | No |
| **2 — Behavioral eval** | Local, requires live n8n at `localhost:5678` + `N8N_MCP_TOKEN` | `Test-SupportTriageWorkflow.ps1` | Every decision path returns the golden category / urgency / team / SLA / handling / escalation, with a parseable due date and a redacted audit event | **Yes**, via official n8n MCP `test_workflow` |

CI deliberately runs **offline only** so external contributors and GitHub runners never need
the maintainer's local n8n instance (see `docs/superpowers/specs/2026-05-28-offline-production-hardening-design.md`).
Do **not** describe the behavioral suite as "CI-enforced" — it is a reproducible local gate
documented in `docs/validation-runbook.md`.

## How the eval executes

`Test-SupportTriageWorkflow.ps1` pins each fixture into the `Receive Support Ticket` trigger
node, runs the real 27-node graph through the official n8n MCP `test_workflow` tool, fetches
the persisted execution, and asserts on the JSON emitted by the response-builder node
(`Build Escalation Customer Response` or `Build Standard Customer Response`, or the
`Build Validation Error` node for the negative case).

## Assertion taxonomy

The suite does **not** do naive whole-object equality. It uses four assertion *types*, each
chosen because exactness is correct for some fields and wrong for others:

| Type | Helper | Applied to | Why this type |
| --- | --- | --- | --- |
| **Exact-match** | `Assert-Equal` | `statusCode`, `ok`, `category`, `urgency`, `routingTeam`, `slaHours`, `handlingPath`, `escalationRequired`, `policyVersion`, `feishuDelivery.status` | These are the *decision*. Any drift is a regression by definition. |
| **Format / parse** | `Assert-ParseableDate` | `dueAt` | The value is time-relative (now + SLA), so the *format* is pinned, not the literal value. |
| **Negative + masking** | `Assert-AuditRedacted` | `auditEvent` | A safety invariant: the audit event must **not** contain the raw email or a 60-char probe of the raw message, must **not** carry raw `customerEmail`/`message` fields, and **must** carry a `***`-masked `redactedEmail`. |
| **Branch-shape** | inline | validation-error case | The error path asserts `response.error` + `missingFields` instead of routing fields — proving the response *shape* changes with the branch. |

## Coverage matrix

8 fixtures map 1:1 onto the workflow's decision paths: 5 categories × the urgency/handling
matrix, plus 2 negative / degradation cases.

| Fixture | Input intent | Path | statusCode | category | urgency | routingTeam | SLA (h) | handling | escalation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `enterprise-incident` | Enterprise checkout outage | escalated | 200 | incident | critical | platform-support | 1 | escalated | yes |
| `urgent-incident` | Urgent incident | escalated | 200 | incident | urgent | platform-support | 2 | escalated | yes |
| `billing` | Billing dispute | standard | 200 | billing | high | billing-support | 8 | standard | no |
| `account-alias` | Account request via field alias | standard | 200 | account | normal | account-success | 24 | standard | no |
| `bug` | Bug report | standard | 200 | bug | normal | product-engineering | 24 | standard | no |
| `general` | Catch-all | standard | 200 | general | normal | general-support | 24 | standard | no |
| `invalid-date` | Malformed `receivedAt` | graceful degradation | 200 | general | normal | general-support | 24 | standard | no |
| `missing-field` | Missing `message` | validation error | 400 | — | — | — | — | — | — |

Every case also asserts `policyVersion = supportops-triage-v0.3.0-local-feishu`, a parseable
`dueAt` (200 cases), and a redacted audit event (200 cases).

### Why these inputs (input-selection rationale)

- **One fixture per decision, not per integration.** Coverage is organized around the
  *branch* the input forces (5 categories, the critical/urgent escalation split, the standard
  path), so the matrix maps directly onto routing logic rather than onto incidental payload shapes.
- **Boundaries, not just centers.** `enterprise-incident` (SLA 1h) vs `urgent-incident`
  (SLA 2h) pins the critical-vs-urgent SLA boundary, the most consequential routing edge.
- **Adversarial / degradation inputs are first-class.** `invalid-date` proves malformed input
  *degrades gracefully* to `general/normal` instead of crashing routing; `missing-field` proves
  the validation gate returns a structured 400 with the offending field named. `account-alias`
  proves field-alias normalization before classification.

### Why these expected outputs (expected-output rationale)

Expected values pin the **decision and its safety properties**, never incidental output. SLA
hours encode the business policy (critical 1h → urgent 2h → high 8h → normal 24h); the audit
assertion encodes a non-negotiable PII invariant; `policyVersion` pins which rule version
produced the decision so a silent policy change is caught.

## Regression semantics

A failing assertion means a **behavioral delta**: the workflow's decision for a known input
changed. Because categoricals are exact-matched, *any* drift in category/urgency/team/SLA/
escalation fails loudly. Where exactness would be wrong (time-relative `dueAt`, masked PII),
the looser format/negative assertions still catch the failure mode that matters (unparseable
date, leaked raw PII) without flaking on values that are *supposed* to vary.

## Production metrics this eval would back

If this ran against live traffic rather than fixtures, the suite is the offline proxy for:

- **Routing accuracy** vs. human triage labels (per category, confusion matrix).
- **SLA-assignment correctness** and escalation **precision/recall** (false escalations are costly).
- **PII-leak escapes** in audit events — target **0**; the `Assert-AuditRedacted` invariant is
  the regression guard for it.
- **Regression-catch rate**: share of decision-changing edits caught before release.

## Generalizing to non-deterministic (LLM) workflows

This methodology is the bridge to the next project (an LLM-classified feedback API). The
*structure* (one fixture per decision, golden expectations, a PII invariant, a coverage matrix)
carries over unchanged. Only the **assertion types** shift:

- Exact-match on a model's free-text output → **schema + value-range + confidence-threshold**
  assertions (the numeric-range idiom already exists in the sibling lead-intelligence suite via
  `Assert-NumberBetween`).
- Add a **graceful-degradation** assertion: low-confidence or schema-invalid model output must
  fall back to deterministic routing — the eval pins the *fallback*, which is reproducible, while
  the live model is demonstrated separately.

This is why the honest framing for an LLM eval is *"evals for schema-conformance, value range,
and graceful degradation,"* not *"evals that grade the model."*

## Résumé framing (bullets this artifact supports)

- Designed a behavioral evaluation suite (8 pinned fixtures) for a 27-node support-triage API,
  asserting routing, SLA, escalation, and a zero-PII-leak audit invariant across all 5 categories
  and 4 urgency tiers via the official n8n MCP.
- Established a two-tier validation model — offline static gating in CI plus a local behavioral
  pin-data eval — so every workflow change's decision delta is explicit, reproducible, and auditable.
- Authored an ADR documenting the deterministic-vs-LLM trade-off (cost, latency, reproducibility,
  evaluability) and the conditions under which an LLM is the right choice.
