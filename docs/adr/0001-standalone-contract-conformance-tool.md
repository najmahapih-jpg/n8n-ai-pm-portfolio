# ADR-0001 — A standalone, offline-capable contract-conformance tool

Date: 2026-06-02 · Status: Accepted (design phase, pre-implementation)

## Context

The portfolio ships a per-project `docs/workflow-contract.md`, but nothing enforces that a workflow's real
request/response shape still matches its published contract — the plan's stated Remaining Gap ("No contract
tests generated from `workflow-contract.md`"). The portfolio's standout signal is honest-eval discipline;
an unenforced contract is exactly the kind of "narrated but not asserted" claim that discipline forbids.
This is also why `contract-test-runner` was **promoted to the FIRST new build** (ahead of the gateway):
it directly amplifies the existing signal and gates every later live surface against contract drift.

## Decision

Build a **standalone tool repo** `n8n-contract-test-runner` that is **pointed at a target repo**
(`Test-Contract.ps1 -RepoPath <repo>`), like a linter — not a `verify:contract` script copied into each of
the six repos.

- Each target `workflow-contract.md` adopts ONE machine-readable contract block (see the spec).
- The runner is **offline-capable by default** (parses the contract + cross-checks fixtures/canonical JSON,
  no running n8n) with an **opt-in `-Live` mode** that re-POSTs golden requests and validates real
  responses, behind the P1.6 connection-check SKIP gate (no false green).
- The runner is **graded by its own golden fixtures** (a passing `good-contract` + several `bad-contract`
  negatives that must each FAIL the relevant assertion) — the digest-integrity discipline turned on the
  checker itself.
- Documented size caps stay labeled `limitsEnforcedBy: "gateway"`; the runner asserts the *label exists*,
  not that the workflow enforces the cap (carrying the honest P1.6 relabel into the contract format).

## Alternatives considered

1. **Per-repo `verify:contract` gate (rejected).** Six copies of the parse + assertion logic would drift
   independently — the precise failure mode that rotted the RAG smoke (a probe drifting from its source of
   truth). One tool = one source of truth.
2. **Auto-derive the contract block from the SDK (deferred).** Higher value long-term, but larger; v0.1.0
   uses manual contract adoption so the format can stabilize first. Auto-derivation is a roadmap follow-up.
3. **Full JSON-Schema typing (deferred).** Start with required-fields + primitive types; richer schemas
   can come once the gate proves its worth.

## Consequences

**Positive** — one source of truth for the contract format + assertions; a portfolio-wide
contract-conformance gate (high AI-PM "quality infrastructure" signal); offline-runnable in CI;
self-tested so the invariant can't silently no-op; reuses the proven harness idioms (stub-default,
assertion taxonomy, SKIP-when-live-absent, secret scan).

**Negative / trade-offs** — cross-repo path coupling (the tool reaches into a sibling's
`docs/`/`fixtures/`/`workflows/`). Mitigated: the target is an explicit `-RepoPath` parameter and the six
repos are co-located siblings under `C:\Dev\Projects` (precedented — D references B's paths). The offline
gate proves *self-consistency* (contract well-formed, fixtures aligned, version/path match), not live
conformance; real response conformance is the **opt-in `-Live`** tier, consistent with the rest of the
portfolio's offline-stub / opt-in-live split.

## Adoption sequence

1. Build the runner + its self-test golden fixtures (good/bad contracts).
2. Add the `## Machine-readable contract` block to the six `workflow-contract.md` files, one per-file commit.
3. A reference run (`Test-Contract.ps1` over all six) becomes a portfolio-level gate.
