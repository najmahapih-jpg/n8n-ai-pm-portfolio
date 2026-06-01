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
   → Load Prior Baseline (rolling run history)
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
refresh on an eval, so a source change that degrades answer quality is caught **before** it's trusted.

## Three invariants (the honest core)

1. **Drift-detection correctness** — flags match a *known* fixture scenario; the two failure modes
   *missed drift* (false negative) and *false alarm* (false positive) both fail loudly.
2. **Refresh-gating** — a re-embed is reachable **only** in `mode:"live"` ∧ `reportOnly:false` ∧ a source
   actually `changed`; in CI (always report-only) **zero** live writes occur (asserted as a negative).
3. **Digest-integrity** — every number in the digest is recomputed from the run record, never invented by
   the summarizer (B's *citation-integrity*, transposed to a summary).

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
> **stable main-text extract** rather than the whole body. The loop's real safety net is the **eval gate**,
> not fingerprint precision: even a false `changed` only triggers a re-embed that must still pass the
> before/after quality gate before it is trusted.

## Repo layout

```
fixtures/requests/   behavior spec (the contract)
fixtures/sources/    source manifest + pinned snapshots (Monitor 1 stub)   [added with v0.1.0]
fixtures/eval/       pinned A-response snapshots (Monitor 2 stub)           [added with v0.1.0]
fixtures/golden/     scenario fixtures (all-clear / regressed / changed / …) + expected flags
fixtures/baseline/   the rolling baseline the run compares against
fixtures/history/    pinned run-history snapshots (reproducible drift tests)
docs/eval-plan.md    the testable contract
docs/adr/            architecture decision records
workflows/sdk/       *.workflow.js — the SOURCE OF TRUTH (compiled → canonical → released)
scripts/             PowerShell harness (compile, sync, validate, secret-scan, tests)
artifacts/runs/      live run digests (gitignored)
```

## Roadmap / deferred

- **Monitor 3 — feedback-theme distribution drift** (pluggable; product-feedback theme PSI period-over-
  period). Deferred: no causal tie to the refresh→re-measure loop; would add an independent live
  integration against D's low-cost mandate.
- Live notification channel (Feishu/Slack webhook) beyond the default file artifact (opt-in, stubbed).
- A hosted dashboard view of the run history; automated PR of re-curated provenance.

## Status

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
