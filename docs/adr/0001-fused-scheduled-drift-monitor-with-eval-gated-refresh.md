# ADR-0001: A scheduled, pluggable drift monitor with eval-gated corpus refresh

- **Status:** Accepted — implementation in progress (v0.1.0 skeleton)
- **Date:** 2026-05-31
- **Workflow:** `Portfolio - Scheduled Drift Monitor`
  (`workflows/sdk/scheduled-drift-monitor.workflow.js`, to be deployed to n8n via the public REST API)
- **Related:** [eval-plan.md](../eval-plan.md); [requirement spec](../../fixtures/requests/scheduled-drift-monitor.md).
  Builds on the sibling harness discipline of
  [A (llm-eval-harness)](../../../n8n-llm-eval-harness) and
  [B (rag-knowledge-assistant)](../../../n8n-rag-knowledge-assistant); realises B's
  [ADR-0004 option C](../../../n8n-rag-knowledge-assistant/docs/adr/0004-authoritative-sourced-corpus-and-refresh.md)
  (automated web-fetch refresh), which was explicitly deferred to Project D.

## Context

Projects A, B, and the three originals are **synchronous webhooks** (`intake → … → respond`). The
portfolio's gap vs 2026 AI-PM hiring signals is **drift monitoring** — signal #4, and the one "大多数作品集
在此失败". Two threads converge on a fourth project:

1. B shipped a **manual, one-command** corpus refresh (`Refresh-Corpus.ps1` + a staleness report) and
   explicitly **deferred automated web-fetch refresh to Project D** — it needs a scheduler, per-source
   fetch adapters, and *change review*.
2. The OSS review's candidate D ("定时洞察简报 / 漂移监控") suggested D **merge with A**: "eval harness →
   漂移仪表盘" — a standing monitor over the portfolio's quality.

The design question: build D as a single-subject monitor, or as something that serves **both** the RAG
refresh (the user's explicit requirement) **and** the quality-drift story — without becoming a bloated,
high-maintenance project that forfeits D's whole advantage (lowest build + maintenance cost)?

## Decision drivers
- **Serve B's periodic refresh** — a hard requirement; D must keep B's KB fresh.
- **Honest drift detection** — the headline capability; must distinguish *missed drift* from *false
  alarm*, and must never let an LLM summary claim a drift the data does not show.
- **Low maintenance** — D's reason-to-exist is "lowest cost, closest to the existing scaffold." Live
  web-fetch is the heaviest of the candidate subjects; the design must keep *standing* maintenance low.
- **Reproducible offline eval (unchanged from A/B)** — a deterministic stub default, offline, key-free;
  CI never reaches a live backend.
- **Connected-projects narrative** — reuse A (it already grades B + product-feedback as black-box SUTs)
  rather than re-implement grading; close the A→B→D loop.

## Considered options

### Shape of the project
1. **Single-subject monitor** (only refresh, or only eval-drift). Simplest, but the user wants refresh
   *and* the eval-drift story is the highest-signal companion — picking one leaves value on the table.
2. **Glue three independent monitors together** (refresh + eval-drift + feedback-theme). Maximal, but
   feedback-theme shares no causal tie with refresh and adds a third live integration → maintenance up,
   coherence down. Contradicts the low-cost mandate.
3. **A pluggable monitor *framework* with two coherent monitors now (freshness + quality) tied by a
   causal loop, and a third (feedback-theme) as a deferred plug-in.** ← **chosen.**

### Refresh write policy
A. **Auto-write** — on a detected source change, blind re-embed into the live KB. Fast, but unsafe: a
   bad source edit silently corrupts B; no review; tension with honest-eval discipline.
B. **Report-only by default; gated live re-embed opt-in; an eval re-run confirms quality didn't drop.**
   ← **chosen.** This is the "change review" B's ADR-0004 said was out of scope for B.

## Decision

**Adopt option 3 (pluggable framework) + option B (eval-gated, report-only-default refresh).**

**One archetype, two monitors, one causal loop.** D is a `scheduleTrigger` (cron, default weekly —
the production cadence) + `manualTrigger` (editor demo) + an on-demand `webhook` pipeline; the webhook
runs the same pipeline and returns the run record (for ad-hoc ops and the deterministic Layer-2 suite,
since the n8n public REST API cannot execute a workflow with custom input). Each monitor is the same
shape: *collector → drift comparator → digest section*.

- **Monitor 1 — Corpus Freshness.** A **source manifest** (B's allowlisted URLs + a content fingerprint
  + `retrievedAt`) is the unit. Default **stub fetch** (pinned snapshot, offline); opt-in **live HTTP
  fetch** with a non-browser User-Agent over allowlisted domains only. Per source →
  `unchanged|changed|stale|unreachable`. A `changed` source triggers a re-embed **only** in
  `mode:"live"` ∧ `reportOnly:false`; the **default is report-only** (detect + recommend, zero live
  writes).
- **Monitor 2 — Answer-Quality Drift.** The collector exercises **Project A** (`POST
  /webhook/portfolio/llm-eval-harness`) — reusing A's existing black-box grading of RAG-B + product-
  feedback — and compares this run's `passRate`/`perRubric` to the **prior run(s)** in a rolling
  run-history (a *time-series* drift, distinct from A's single-baseline `regressionDelta`). Default
  **stub** (pinned A-response snapshot); opt-in **live** call.

**The eval-gated refresh loop (the senior move).** Refresh and quality are not two unrelated monitors —
they are a loop: *a source drifts → re-embed → re-run A → did quality drift?* D does **not** blindly
auto-refresh B's KB; it gates the refresh on an eval, so a source change that degrades answer quality is
caught as drift **before** it is trusted. This is the portfolio's honest-eval discipline applied to a
scheduled monitor.

**Digest-integrity (the new invariant).** The run produces a deterministic **run record**; the digest is
an LLM (or stub) summary **constrained to the run record's numbers**. Every quantitative claim in the
digest is recomputed from the record and must match — the digest cannot state a drift the data does not
show. This is B's *citation-integrity* invariant, transposed from "answer cites a retrieved chunk" to
"summary cites a computed metric."

**Stub-default everywhere CI touches.** Source fetch, A's eval, the LLM summary, and the Supabase
re-embed each have a deterministic offline stub as the default; live is per-request opt-in and never
touched by CI. With `mode:"stub"` and a fixed `asOf`, the run record (minus `runId`) is byte-stable.

**Feedback-theme distribution drift (Monitor 3) is deferred** — the framework supports it; building it
now would add an independent live integration with no tie to the refresh→re-measure loop, against the
low-cost mandate. Roadmapped.

## Consequences

**Positive**
- D **serves B's periodic refresh** *and* tells the highest-signal quality-drift story, in one coherent
  archetype — closing the A→B→D connected-projects loop ("eval harness → drift dashboard").
- Drift detection is **honest**: missed-drift vs false-alarm are distinct, tested failure modes; the
  digest can't fabricate a metric (digest-integrity); a refresh can't silently degrade B (eval-gated).
- The new archetype (**scheduled/batch + monitoring**) is a genuine portfolio expansion vs four prior
  webhooks — and reuses ~all of the existing Workflow-as-Code scaffold (lowest build cost).

**Negative / trade-offs**
- Live web-fetch is the heaviest-maintenance subject (pages change/break). Mitigated by **stub-default +
  live-opt-in**: CI is offline/reproducible and *standing* maintenance stays low; live fetch is a
  manual/opt-in act with allowlisted domains + a non-browser UA.
- D reads across repos (A's webhook, B's Supabase + source list). Coupling is intentional (the connected-
  projects narrative) but means D's *live* path depends on A and B being deployed; the **stub default**
  keeps D fully self-contained offline.
- The source manifest's fingerprints are a snapshot — provenance is only as fresh as the last live run;
  the digest says so honestly rather than implying real-time freshness.

## Implementation note (v0.1.0 skeleton → v0.2.0 live)
**v0.1.0** shipped the stub-default 21-node pipeline + the Layer-2 scenario suite (`all-clear`,
`quality-regressed`, `source-changed`, `source-stale`, `source-unreachable`, `digest-must-be-real`),
deployed as `Gjd7wma62zubk3Wy`. **v0.2.0 wired the opt-in LIVE path** behind in-code `mode:live` gates
(each onError-tolerant, degrading to stub — chosen over B's visual IF gates to avoid a fragile assembly
rewrite while preserving the stub-default discipline): live source-fetch (allowlisted URLs + non-browser
UA via the Code node `this.helpers.httpRequest`), live A-eval (D POSTs a connected-eval slice to Project
A; A grades B and returns `passRate` — the eval-gated A→B→D loop), and a live Ollama `llama3.2:3b` digest
whose prose is free but whose METRICS line is **pinned from the run record** (so digest-integrity holds
under the live LLM). Asserted by `verify:drift-live` (opt-in, not in CI). The gated re-embed loop is now implemented
host-side as `Refresh-Sources.ps1` (eval-before → fetch + SHA-256 fingerprint detect vs a persisted
`fixtures/sources/manifest.json` → `-Apply` re-embed via B's `Ingest-Corpus.ps1` → eval-after GATE so a
refresh that lowers B's answer quality fails loudly; report-only default). Known limitation: the
raw-body fingerprint is dynamic-content-sensitive (a stable main-text extract is the precision fix; the
eval gate, not fingerprint precision, is the real safety net). STILL DEFERRED: Monitor 3 (feedback-theme
drift) + the fingerprint-precision upgrade. Deploy via REST `POST /api/v1/workflows` (no n8n MCP; see A's
ADR-0002); **never touch the 5 existing workflow ids** (`IhmmthDFMKdDbgvp` A · `jZ5Xfml8jbKexYqf` B ·
`6Gc3wmri0tJre07B` product-feedback · the two others).
