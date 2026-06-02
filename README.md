# Scheduled Drift Monitor — n8n Workflow-as-Code

The portfolio's **fourth** project and its first **scheduled (cron) + monitoring** workflow — the first
that is *not* a synchronous request→response webhook. It is the portfolio's **standing health monitor**:
on a schedule it keeps Project B's RAG knowledge base **fresh** and watches whether answer **quality
drifts**, then emits a human-readable, integrity-checked **digest**.

> Drift monitoring is the #4 AI-PM hiring signal — and the one most portfolios skip. The point of this
> project is to do it **honestly**: distinguish a *missed drift* from a *false alarm*, never let a
> summary claim a drift the data doesn't show, and never let an automated refresh silently degrade B.

It closes the portfolio's connected-projects loop: **A grades B; D keeps B fresh and watches A's grades
drift over time** — "eval harness → drift dashboard."

## Archetype (what makes D different from A, B, and the three originals)

- **Trigger:** the `scheduleTrigger` (cron, default **weekly**) is the production cadence; a
  `manualTrigger` runs the editor demo; an **on-demand `webhook`** (`POST
  portfolio/scheduled-drift-monitor`) runs the same pipeline and returns the run record (the entry
  ad-hoc ops + the Layer-2 suite use). D is **schedule-driven** and is fundamentally the *caller* (it
  calls A; it reads B's sources) — the inverse of A/B's request→response services.
- **Pluggable monitor framework:** each monitor is the same shape — **collector → drift comparator →
  digest section**. Adding one is additive, not a rewrite.

## The two monitors + the eval-gated loop

```
scheduleTrigger (weekly) ┐
manualTrigger (demo)     ┤→ Normalize Run Config (mode:"stub" default, reportOnly:true default)
webhook (on-demand)      ┘   (webhook returns the run record; schedule emits the digest artifact)
   → Load Prior Baseline (single prior baseline; rolling history deferred)
   → Monitor 1 · Corpus Freshness     ← serves B's RAG periodic update
       collect:  fetch B's allowlisted source URLs   (stub snapshot default / live HTTP opt-in)
       drift:    fingerprint diff + staleness → unchanged|changed|stale|unreachable
       action:   re-embed changed chunks into B's Supabase   (ONLY live + !reportOnly; default: none)
   → Monitor 2 · Answer-Quality Drift  ← the eval gate
       collect:  re-run Project A's eval over RAG-B + product-feedback   (stub snapshot / live call)
       drift:    passRate / perRubric vs prior run(s) → regressed?
   → Aggregate Run Record  →  Summarize Digest (stub template / Ollama)
   → Persist Run + Update Baseline  →  Emit Digest Artifact (+ optional notify)
```

**The eval-gated refresh loop (the senior move):** refresh and quality are one loop — *a source drifts →
re-embed → re-run A → did quality drift?* D does **not** blindly auto-refresh B's KB; it gates the
refresh on an eval. Note: the host-side `Refresh-Sources.ps1` re-embeds into B's Supabase **before**
the before/after eval gate runs. A quality-lowering re-embed is detected **only after** B's Supabase
is overwritten — this is a **post-write detective control**, not a preventive one. On gate failure,
B is left degraded; the operator must re-run B's `Ingest-Corpus.ps1` from the last-known-good corpus
to restore. (Transactional/shadow-table staging is a deferred enhancement.)

## Three invariants (the honest core)

1. **Drift-detection correctness** — flags match a *known* fixture scenario; the two failure modes
   *missed drift* (false negative) and *false alarm* (false positive) both fail loudly.
2. **Refresh-gating** — a re-embed is reachable **only** in `mode:"live"` ∧ `reportOnly:false` ∧ a source
   actually `changed`; in CI (always report-only) **zero** live writes occur. This holds **by construction**:
   the 21-node workflow contains no Supabase-write node; the CI assertion `reembedded == 0` is structural,
   not a behavioral test that could fail. The only write-capable code is the host-side `Refresh-Sources.ps1`
   (explicitly not in CI).
3. **Digest-integrity** — enforced by two record-grounded checks: (1) the machine-appended `METRICS passRate=… changed=… …` line is recomputed from the run record; (2) any pass-rate-shaped figure (a percentage or a decimal in [0,1]) in the summarizer's prose must equal a record rate (`passRate` / `passRatePrev` / `|passRateDelta|`), so an LLM that states a passRate the data does not show causes `digestIntegrity.passed=false`. Authoritative counts live in the METRICS line; bare integers in prose are treated as context, not individually re-checked.

## Modes

| | source fetch | A's eval | LLM digest | Supabase re-embed |
|---|---|---|---|---|
| **stub** (default, CI) | pinned snapshot | pinned snapshot | deterministic template | never |
| **live** (opt-in) | HTTP + non-browser UA | `POST /webhook/portfolio/llm-eval-harness` | Ollama `llama3.2:3b` | gated (`!reportOnly`) |

With `mode:"stub"` and a fixed `asOf`, the run record (minus `runId`) is byte-stable — the offline suite
is reproducible. See [docs/eval-plan.md](docs/eval-plan.md) for the full scorer contract.

## Verify gates

| Command | What it proves | Network? |
|---|---|---|
| `npm run verify:static` | SDK compiles; canonical JSON well-formed; offline checks | offline |
| `npm run verify:json` | n8n workflow JSON shape + node-count floor | offline |
| `npm run verify:live` | sync from SDK + the Layer-2 stub scenario suite (drift-correctness, refresh-gating, digest-integrity) | local n8n only |
| `npm run verify:drift-live` | **opt-in** — real A call + real source fetch + eval-gated refresh | live A/B/Ollama |

`verify:static` + the repository secret scan also run in CI (`.github/workflows/ci.yml`); a pre-commit
hook (`core.hooksPath=.githooks`) runs `verify:static` before every commit.

## Eval-gated refresh loop (`npm run refresh:sources`)

`scripts/Refresh-Sources.ps1` closes the loop ADR-0001 describes — **host-side** (the n8n container has no
outbound internet; the host does), it: (1) **evals BEFORE** — A grades B's abstention → a passRate
baseline; (2) **detects** — fetches each allowlisted source URL, SHA-256-fingerprints the body, compares
to the persisted `fixtures/sources/manifest.json` → `new|unchanged|changed|stale|unreachable`;
(3) **re-embeds** (only with `-Apply`, and only if sources changed) by delegating to B's
`Ingest-Corpus.ps1`; (4) **evals AFTER** and **gates**: `passRateAfter ≥ passRateBefore − threshold`, so a
refresh that *lowers* B's answer quality fails loudly. The **default is report-only** (fetch + eval-before
only; zero writes). `-Pin` pins the fetched fingerprints into the manifest; `-Apply` mutates B's live
Supabase + runs the gate.

> **Known limitation (honest):** the fingerprint is a raw-body SHA-256, so it is sensitive to *dynamic*
> page content (CSRF nonces, timestamps) — some sources flip to `changed` between runs even when the
> substantive content is unchanged (observed: 3/6 of B's sources). The precision fix is to fingerprint a
> **stable main-text extract** rather than the whole body. The eval gate is a **post-write detective
> control**: a false `changed` triggers a re-embed into B's Supabase, and a quality regression is detected
> only after that overwrite has occurred.

## Repo layout

```
fixtures/requests/          behavior spec (the contract)
fixtures/sources/           host source manifest (real SHA-256 fingerprints, used by Refresh-Sources.ps1)
fixtures/golden/            scenario fixtures (all-clear / regressed / changed / …) + expected flags
fixtures/baseline/          placeholder for future baseline storage (currently empty)
fixtures/history/           placeholder for future run-history snapshots (currently empty)
docs/eval-plan.md           the testable contract
docs/adr/                   architecture decision records
workflows/sdk/              *.workflow.js — the SOURCE OF TRUTH (compiled → canonical → released)
scripts/                    PowerShell harness (compile, sync, validate, secret-scan, tests)
artifacts/runs/             live run digests (gitignored)
```

Note: `fixtures/sources/snapshots/` and `fixtures/eval/` do not exist. The workflow's stub mode uses
embedded `SOURCE_MANIFEST` and `PRIOR_BASELINE` constants inside the workflow itself, overridable
per-request via `inject.stubSources` / `inject.stubQuality` / `inject.priorBaseline` / `inject.stubDigestProse`.

## Roadmap / deferred

- **Monitor 3 — feedback-theme distribution drift** (pluggable; product-feedback theme PSI period-over-
  period). Deferred: no causal tie to the refresh→re-measure loop; would add an independent live
  integration against D's low-cost mandate.
- Live notification channel (Feishu/Slack webhook) beyond the default file artifact (opt-in, stubbed).
- A hosted dashboard view of the run history; automated PR of re-curated provenance.

## Status

**v0.3.0 — current.** Digest-integrity now enforces a two-check prose rate guard (see invariant 3 above); live Monitor 1 reports reachability + staleness only (cross-run change-detection is the host loop `Refresh-Sources.ps1`); SSRF guard on the webhook entrypoint (caller-supplied URL overrides ignored on unauthenticated webhook); secret scanner extended to `sb_secret_…` / `sb_publishable_…` Supabase key formats. New golden scenario: `fixtures/golden/digest-fabricated-prose.json` (injects prose "通过率 0.99" while record passRate is 0.83 → `digestIntegrity.passed=false`). `verify:drift-live` asserts live M1 emits no `changed` verdict.

**v0.2.0 — live-wired + fully verified.** Contract + the stub-default 21-node pipeline + the Layer-2
suite + the opt-in **LIVE path** are all done; deployed via the n8n public REST API (no MCP; see A's
ADR-0002) as workflow `Gjd7wma62zubk3Wy` (active). Gates green: `verify:static` (7 checks) +
`verify:live` (115 assertions / 6 scenarios, offline stub) + `verify:drift-live` (11 checks, opt-in live:
real A-eval passRate, live source-fetch path, live Ollama digest with integrity intact). The gated
re-embed (the reviewed action that closes the corpus-refresh loop, delegating to B's
`Ingest-Corpus.ps1`) + Monitor 3 remain deferred. Live source reachability is container-network
dependent (A reached via `host.docker.internal`; public source URLs were unreachable in this
environment — reported honestly as drift). **Never touched the 5 existing workflow ids.**

## Connected projects
- [`n8n-llm-eval-harness`](../n8n-llm-eval-harness) (A) — D's quality reading comes from A's eval.
- [`n8n-rag-knowledge-assistant`](../n8n-rag-knowledge-assistant) (B) — D keeps B's corpus fresh; B's
  ADR-0004 deferred automated refresh to D.

## Open Source Health

This repository includes the baseline files needed for public collaboration:

- License: Apache-2.0 (`LICENSE`).
- Contributions: `CONTRIBUTING.md`.
- Security policy: `SECURITY.md`.
- Security and privacy boundaries: `docs/security-boundaries.md`.
- Workflow contract: `docs/workflow-contract.md`.
- Conduct: `CODE_OF_CONDUCT.md`.
- GitHub templates: `.github/ISSUE_TEMPLATE/` and `.github/pull_request_template.md`.

Before publishing or accepting contributions, run `npm run verify:static` and `npm run verify:json` (both offline). `npm run smoke` sends stub payloads to a **running, imported, active local n8n** instance (localhost:5678) — it is not an offline gate; run it only when a local n8n is available. Run `npm run verify:live` only when local n8n and all required credentials are configured.
