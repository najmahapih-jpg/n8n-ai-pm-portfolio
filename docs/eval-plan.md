# Eval Plan — Scheduled Drift Monitor

Written **before** the workflow is built. The contract the node graph and
`Test-DriftMonitorWorkflow.ps1` must satisfy. Companions:
[ADR-0001](adr/0001-fused-scheduled-drift-monitor-with-eval-gated-refresh.md),
[requirement spec](../fixtures/requests/scheduled-drift-monitor.md).

## Two layers of eval (read first)

- **Layer 1** — the monitor *actually catches real drift when it happens, and stays quiet when it
  doesn't* (the product's job): a source really changed, or B's live answer quality really dropped, and
  the digest says so — with no false alarms. This is a **manual, honestly-labelled** activity over the
  live backends (and, fittingly, **Project A** can grade D's own pass/fail outputs as yet another
  black-box SUT).
- **Layer 2** — this repo's behavioural suite grades the monitor's *plumbing* against **deterministic
  stub collectors** (stub source-fetch + stub eval-reading + stub digest) over in-repo fixtures, so it
  stays offline and reproducible.

**What Layer 2 proves:** schedule→collect→**detect-drift**→gate-refresh→summarize→persist wiring is
correct and safe — the stub collectors return fixtures that encode *known* scenarios (no-drift /
quality-degraded / source-changed / source-stale), so the suite deterministically exercises both the
**drift-flagged** and the **all-clear** paths, plus refresh-gating and digest-integrity.

**What Layer 2 does NOT prove:** that a *live* HTTP fetch correctly fingerprints a real web page, that a
*live* call to A reflects real model quality, or that the *live* Ollama digest is faithful. Live drift
fidelity is a **Layer-1, manual, honestly-labelled** activity. We do **not** narrate the stub suite as
"evals that prove my monitor catches real drift."

## What gets measured (Layer 1 — the real drift metrics)

| Metric | Definition |
|---|---|
| **Detection recall** | When a source *really* changed (or quality *really* dropped), the run flags it. The error is a **missed drift** (false negative) — the most dangerous, because the digest then falsely reassures. |
| **False-alarm rate** | On a genuine no-change period, the run does **not** flag drift. The error is a **false alarm** (false positive) — it erodes trust in the monitor. |
| **Refresh safety** | A re-embed happens **only** for a genuinely-changed source, **only** in live + non-report-only mode, and an eval re-run confirms the refresh did not *lower* answer quality (the eval-gated-refresh loop). |
| **Digest faithfulness** | Every number the digest states is the number the run record holds (no summarizer drift / hallucinated metric). |

## Run / scorer contract (per scheduled run)

See the [requirement spec](../fixtures/requests/scheduled-drift-monitor.md#run-contract) for the full
shape. The grading-relevant fields:

```
run(config) -> {
  freshness: { sources:[{chunkId, url, status, ageDays, fingerprintPrev, fingerprintNow}],
               changed, stale, unreachable, reembedded },
  quality:   { passRate, passRatePrev, passRateDelta, regressed, perRubric, perRubricDelta, evalSource },
  drift:     { any: bool, reasons: [string] },     // union of quality.regressed OR any source changed/stale
  digest:    { title, markdown, summarySource },
  history:   { priorRuns, baselineUpdated },
  evalSource:"stub"|"workflow", summarySource:"stub"|"ollama", reportOnly: bool, mode:"stub"|"live"
}
```

- **Drift rule:** `quality.regressed = passRateDelta < -driftThreshold`; `drift.any` is the union of
  `quality.regressed` with any source `status ∈ {changed, stale, unreachable}`. `drift.reasons` lists
  the human-readable causes — and is the single source of truth the digest must echo.
- **Refresh-gating rule:** `reembedded > 0` is reachable **only** when `mode=="live"` ∧ `reportOnly==false`
  ∧ at least one source `status=="changed"`. In every other case (and always in CI) `reembedded==0` and
  no Supabase write path executes.
- **Digest-integrity rule:** the numbers parsed back out of `digest.markdown` MUST equal the run
  record's `quality.passRate` / `passRateDelta` / `freshness.changed` / … — recomputed, never trusted
  from the summarizer.
- **Default sources are stub** (`evalSource:"stub"`, `summarySource:"stub"`, stub source-fetch),
  deterministic and offline. Live `workflow`/`ollama`/HTTP are opt-in per request and never touched by CI.

## Golden dataset (planned)

A small fixed set of **scenario fixtures** — each pins what the stub collectors return and the expected
flags, so the suite exercises every branch deterministically:

| Golden scenario | stub collectors return | expected |
|---|---|---|
| `all-clear` | sources unchanged + fresh; quality == prior | `drift.any:false`, `reembedded:0`, digest says "no drift" |
| `quality-regressed` | quality passRate prior 1.0 → now 0.80 | `quality.regressed:true`, `drift.any:true`, reason names the drop |
| `source-changed` | one source fingerprint differs | source `status:"changed"`, `drift.any:true`, re-curate recommended, `reembedded:0` (report-only) |
| `source-stale` | one source `retrievedAt` age > window | source `status:"stale"`, `drift.any:true` |
| `source-unreachable` | stub fetch returns an error sentinel | source `status:"unreachable"`, non-fatal, `drift.any:true` |
| `refresh-gated-live` | live + non-report-only + a changed source | `reembedded:1` reachable (the ONLY scenario that writes) — exercised by the live suite, not CI |
| `digest-must-be-real` | any of the above | every metric in `digest.markdown` == run record (integrity) |

## Layer-2 behavioural suite (what `verify:live` asserts — stub collectors)

| Field(s) | Assertion type | Helper |
|---|---|---|
| `mode`, `evalSource`, `summarySource`, `reportOnly`, `policyVersion` | **exact-match** | `Assert-Equal` |
| `quality.passRateDelta`, `perRubricDelta`, source `ageDays` | **numeric-range band** | `Assert-NumberBetween` |
| `quality.regressed` ⟺ `passRateDelta < -driftThreshold` | **branch-shape / relational** | `Assert-DriftFlag` |
| `drift.any` ⟺ union of quality-regressed ∨ any source changed/stale/unreachable | **relational / union** | `Assert-DriftUnion` |
| `reportOnly ⇒ reembedded==0` ∧ no write path reached | **negative / absence** | `Assert-NoLiveWrite` |
| numbers in `digest.markdown` == run record | **relational / membership** | `Assert-DigestMatchesRecord` |
| audit & digest carry no raw key / no PII | **negative + masking** | `Assert-NoRawPiiLeak` |

These reuse the harness's proven assertion taxonomy (from A/B). The **new** invariants D adds are
**drift-flag correctness**, **refresh-gating (no-live-write)**, and **digest-integrity** — all asserted
deterministically via the stub scenarios.

## Regression semantics
Categoricals (`status`, `regressed`, `drift.any`, `*Source`) exact-matched; deltas/ages as bands.
Highest-severity guards: a **missed drift** (false negative — the digest reassures while quality fell or
a source changed) and a **live write in report-only/CI** (a refresh that should never have fired) — both
must fail loudly.

## Live layer (`verify:drift-live`, opt-in — not in CI)
Proves the real path end-to-end against the live backends:
- a **real call to A** (`POST /webhook/portfolio/llm-eval-harness`) returns a `passRate` that is
  persisted to history and compared to the prior run;
- a **real source fetch** (allowlisted URL, non-browser UA) fingerprints + flags `unchanged`/`changed`;
- the **eval-gated-refresh** loop: re-embed a changed source, then re-run A and confirm quality did not
  regress (or, if it did, the digest flags it — honest either way).
