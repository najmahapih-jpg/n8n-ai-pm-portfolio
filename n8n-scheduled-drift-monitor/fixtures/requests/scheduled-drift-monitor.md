# Requirement Spec — Scheduled Drift Monitor

The behavior contract (a behavior spec, not a PRD) the node graph and
`Test-DriftMonitorWorkflow.ps1` must satisfy. Written **before** the workflow.
Companions: [eval-plan.md](../../docs/eval-plan.md),
[ADR-0001](../../docs/adr/0001-fused-scheduled-drift-monitor-with-eval-gated-refresh.md).

## Purpose

The portfolio's **fourth** project and its first **scheduled (cron) + monitoring** workflow — the
first that is *not* a synchronous request→response webhook. It is the portfolio's **standing health
monitor**: on a schedule it (1) keeps Project B's RAG knowledge base **fresh** and (2) watches whether
answer **quality drifts**, then emits a human-readable **digest**. Drift monitoring is the #4 AI-PM
hiring signal — and the one most portfolios skip ("大多数作品集在此失败"), so doing it *honestly* is the
whole point.

It closes the portfolio's connected-projects loop: **A grades B; D keeps B fresh and watches A's grades
drift over time** — "eval harness → drift dashboard."

## Archetype (what makes D different)

- **Trigger:** the `scheduleTrigger` (cron, default weekly) is the **production cadence**; a
  `manualTrigger` runs the editor demo; and an **on-demand `webhook`** (`POST
  portfolio/scheduled-drift-monitor`) runs the same pipeline and **returns the run record** — the entry
  ad-hoc ops and the deterministic Layer-2 suite use. D is **schedule-driven** (the cron is the
  product) and is fundamentally the *caller* (it calls A; it reads B's sources) — the inverse of A/B's
  request→response services — but it still exposes an HTTP entry so a run can be triggered + inspected.
- **Pluggable monitor framework:** every monitor is the same shape — a **collector** (where to pull),
  a **drift comparator** (what to compare against the prior period), and a **digest section**. The set
  of monitors is small and curated; adding one is additive, not a rewrite.

## Monitors (this version ships two; a third is a deferred plug-in)

### Monitor 1 — Corpus Freshness  *(serves B's RAG periodic update — your requirement)*
Implements the **automated source-drift refresh** that B's
[ADR-0004 option C](../../../n8n-rag-knowledge-assistant/docs/adr/0004-authoritative-sourced-corpus-and-refresh.md)
explicitly deferred to Project D.
- **Collect:** for each source in D's **source manifest** (`fixtures/sources/manifest.json` — B's
  allowlisted corpus URLs + a content fingerprint + `retrievedAt`), fetch the current content.
  **Default = deterministic stub fetch** from the in-workflow `SOURCE_MANIFEST` constant (offline,
  reproducible; a scenario overrides a source's fingerprint/status via `inject.stubSources`). **Live =
  opt-in HTTP fetch** with a **non-browser User-Agent** (the same `sb_secret_` / 401 gotcha class B
  documented; allowlisted domains only). In live mode there is no persisted prior fingerprint, so M1
  reports reachability + staleness only — cross-run change-detection is the host loop (`Refresh-Sources.ps1`).
- **Drift:** per source, compute a status — `unchanged` | `changed` (fingerprint differs) | `stale`
  (`retrievedAt` age > `staleAfterDays`, default 90) | `unreachable`.
- **Action (gated):** when a source is `changed` **and** `mode:"live"` **and** not `reportOnly` →
  re-embed the affected chunks into B's Supabase `documents` (same write path as B's
  `Ingest-Corpus.ps1`; idempotent DELETE-then-insert). **Default is `reportOnly`** — D *detects and
  recommends re-curation*; it never blind-writes the live KB in CI. This is the "change review" B's
  ADR-0004 said was out of scope for B.

### Monitor 2 — Answer-Quality Drift  *(the eval gate)*
- **Collect:** obtain a quality reading for the live SUTs by exercising **Project A's eval harness**
  (`POST /webhook/portfolio/llm-eval-harness`), which already grades RAG-B (`sutExtract:"abstained"`)
  and product-feedback (`sutExtract:"response.theme"`) as black-box SUTs and returns `passRate`,
  `perRubric`, and `regressionDelta`. **Default = deterministic stub** from the in-workflow `PRIOR_BASELINE`
  constant (overridable via `inject.stubQuality` / `inject.priorBaseline`). **Live = opt-in** real call to A.
- **Drift:** compare this run's metrics to a **single prior baseline** (an embedded constant today;
  persisted rolling run-history is deferred), distinct from A's single-baseline `regressionDelta`. Compute `passRateDelta`,
  per-rubric deltas, and a `regressed` flag (`delta < -driftThreshold`, default 0.05).

### Monitor 3 — Feedback-Theme Distribution Drift  *(DEFERRED — pluggable)*
The framework supports it (collector = product-feedback outputs over a window; comparator = theme
distribution shift / PSI). **Not built this version** — it shares no causal tie with the refresh→
re-measure loop and would add an independent live integration, raising maintenance against D's
low-cost mandate. Tracked in the roadmap; adding it is one new monitor, not a rewrite.

## Run contract

**Input** (manual-trigger body, or schedule defaults):
```jsonc
{
  "mode": "stub",            // "stub" (default, offline) | "live"
  "reportOnly": true,        // true (default) = detect + recommend, no live writes
  "monitors": ["freshness", "quality"],
  "driftThreshold": 0.05,    // quality regression flag threshold
  "staleAfterDays": 90,      // freshness window
  "asOf": "2026-05-31"       // optional: deterministic "now" for reproducible age math
}
```

**Output** — a structured **run record** + a **digest**:
```jsonc
{
  "runId": "...", "asOf": "2026-05-31", "mode": "stub", "reportOnly": true,
  "freshness": {
    "sources": [{ "chunkIds": ["..."], "url": "...", "status": "unchanged|changed|stale|unreachable",
                  "ageDays": 12, "fingerprintPrev": "...", "fingerprintNow": "..." }],
    "changed": 0, "stale": 0, "unreachable": 0, "reembedded": 0
  },
  "quality": {
    "passRate": 1.0, "passRatePrev": 1.0, "passRateDelta": 0.0, "regressed": false,
    "perRubric": { "...": 1.0 }, "perRubricDelta": { "...": 0.0 },
    "evalSource": "stub|workflow"
  },
  "drift": { "any": false, "reasons": [] },   // union: quality regressed OR sources changed/stale
  "digest": { "title": "...", "markdown": "...", "summarySource": "stub|ollama" },
  "history": { "priorRuns": 3, "baselineUpdated": true },
  "notified": false
}
```

## Behavior rules / invariants (the testable core)

1. **Drift-detection correctness.** Given a run whose collectors return a *known* scenario, the
   `regressed` / source-`status` flags MUST match the expectation. Two failure modes, both must fail
   loudly: **missed drift** (a real degradation not flagged) and **false alarm** (drift flagged on a
   no-change run). (The dual mirrors B's *hallucinate-on-miss* / *false-abstain*.)
2. **Refresh-gating.** A `changed` source produces a re-curate recommendation; the workflow performs
   **zero live writes** to Supabase **by construction** — no Supabase-write node exists in the 21-node
   workflow (so the CI check of `reembedded == 0` is structural, not a behavioral negative). The only
   write-capable code is the host-side `Refresh-Sources.ps1` (report-only default, never in CI).
3. **Digest-integrity.** Enforced in two record-grounded checks: (a) the machine-appended `METRICS …`
   line is recomputed from the run record and must match exactly; (b) any **pass-rate-shaped figure** (a
   percentage, or a decimal in [0,1]) in the summarizer's prose must equal a record rate — so an LLM that
   states a passRate the data does not show fails the run (authoritative counts are the METRICS line;
   bare integers in prose are context). This is B's *citation-integrity* applied to a summary; proven by
   the `digest-fabricated-prose` negative scenario.
4. **Stub-default, live opt-in.** Every external touch (source fetch, A's eval, LLM summary, Supabase
   re-embed) has a deterministic offline stub as the default; live is per-request opt-in and never
   touched by CI. A misconfigured request can never reach a live backend in the offline suite.
5. **Idempotent, deterministic given `asOf`.** With `mode:"stub"` and a fixed `asOf`, the run record
   (minus `runId`) is byte-stable — so the Layer-2 suite is reproducible.

## In scope
Scheduled + manual triggers; Monitor 1 (freshness, report-only default + gated live re-embed);
Monitor 2 (quality drift vs rolling history); deterministic stub collectors + stub digest; run-history
persistence + baseline update; digest artifact emit; the three invariants above.

## Out of scope (deferred — see roadmap)
Monitor 3 (feedback-theme distribution drift); live notification channels beyond a file artifact
(Feishu/Slack webhook is opt-in, stubbed by default); a hosted dashboard UI; automated PR/commit of
re-curated provenance; per-source HTML→text extraction beyond a fingerprint diff.

## Success criteria
- Offline Layer-2 suite is green and reproducible (stub collectors, fixed `asOf`): drift-correctness
  (no-drift + degraded + source-changed scenarios), refresh-gating (no writes), digest-integrity.
- Live (opt-in) proves a real reading end-to-end: a real call to A returns a pass-rate that is
  persisted and compared to the prior run; a real source fetch fingerprints + flags drift.
- The digest reads like something a PM would actually act on, and its numbers are recomputed from the run record (the METRICS line), not invented by the summarizer.
