# ADR-0004: Multi-model SUT fan-out, cost–latency–quality surfacing, regression-vs-baseline

- **Status:** Accepted (planning → implementation v0.4.0 → decision 5 completed v0.5.0)
- **Date:** 2026-05-30
- **Workflow:** `Portfolio - LLM Eval Harness API` (`workflows/sdk/llm-eval-harness.workflow.js`)
- **Related:** [ADR-0001](0001-hybrid-deterministic-and-llm-judge-scoring.md) (hybrid scoring + stub default),
  [ADR-0003](0003-grade-deployed-sibling-as-blackbox-sut.md) (black-box SUT), [eval-plan.md](../eval-plan.md).

## Context

v0.3.0 grades **one** subject-under-test per run (stub default, or the product-feedback sibling as a
black-box `sutMode:"workflow"`). The harness's headline AI-PM capability is still deferred: **comparing
models on the cost–quality–latency triangle**, and **detecting quality regression over time**. This ADR
adds `sutMode:"model"` with multi-model fan-out, per-model cost/latency/quality aggregation, and a
regression delta — without breaking the reproducible, offline stub default.

## Decision drivers
- **Reproducible offline default unchanged** — stub SUT + stub judge stay the default; `verify:live` stays offline.
- **Local-first** — Ollama default; cloud optional behind env, never CI / secret-bearing.
- **Honest cost** — local models cost $0; report tokens + latency, estimate `$` only for cloud via an explicit price table; never fabricate a cost.
- **Deterministic regression in CI** — the delta must be reproducible, so the baseline is an **explicit input** (request or committed fixture), not hidden mutable state.
- **Uniform aggregate shape** across all `sutMode`s so the response/UI is consistent.

## Decisions

1. **Model dimension via `modelId` on every scored row.** Each evaluated item carries `{caseId, modelId, …}`.
   For `sutMode:"model"`, fan out **cases × `sutModels`**; for stub/workflow, `modelId` is the mode label
   (`"stub"` / `"product-feedback"`) so a single-"model" run is just the degenerate case. Deterministic
   assertions and the judge operate per row (key `caseId∷modelId`); **Aggregate groups by `modelId`**.

2. **`sutMode:"model"` calls Ollama** (`/api/chat`, `format` as needed, `temperature:0`) per (case, model)
   with the case `input` as the task prompt; extracts the model text as the actual output and
   `eval_count` + `prompt_eval_count` + `total_duration` for tokens/latency. `onError:continueRegularOutput`
   → an unreachable model yields `sutSource:"error"`, `passed:false` (never silently passes), mirroring the
   workflow-SUT discipline.

3. **3-way SUT routing.** Replace the 2-way "SUT Mode = Workflow?" IF with a **Switch** (`stub | workflow |
   model`) — or a second IF — feeding the same fan-in into the deterministic assertions. Implementer picks
   whichever keeps the graph clean and documents it.

4. **Cost–latency–quality surfacing.** Aggregate emits
   `perModel: [{ modelId, total, passRate, perRubricMean, meanLatencyMs, totalTokens, estCostUsd, costBasis }]`
   and a ranked `bench`. `estCostUsd` = tokens × an **explicit per-model price table** for known cloud models;
   local Ollama = `0` with `costBasis:"local-free"`. A harness that hides its own cost is not an AI-PM artifact.

5. **Regression vs. baseline (deterministic).** `regressionDelta` is computed when a `baseline` is provided —
   in the request (`body.baseline`) or, for the offline suite, from a committed
   `fixtures/baseline/regression-baseline.json` passed by the test driver. Delta = current − baseline on
   `passRate` (overall + per-model) and `perRubricMean`, with `regressed:true` when any pass-rate drops beyond
   a tolerance band. **No hidden mutable store in the hot path**; an optional `$getWorkflowStaticData("global")`
   "last run" convenience MAY be written for live runs but is NOT the CI mechanism. No baseline → `regressionDelta:null` (honest, as today).

6. **Reproducibility & gates.** Stub stays default. `verify:live` stays offline (stub SUT + stub judge) and now
   ALSO asserts a **deterministic** `regressionDelta` by passing the committed baseline fixture (stub is
   deterministic → the delta is stable). A new **`verify:bench`** (non-CI, like `verify:judge`) runs the LIVE
   multi-model fan-out against local Ollama and prints the per-model triangle. To make "multi-model" real even
   with a single local model, the bench always includes the **deterministic stub lane** as one `modelId`
   alongside any available live Ollama model(s) — an honest, reproducible comparison baseline.

## Considered & rejected
- **Hidden static-data baseline as the CI mechanism** — rejected: non-reproducible, the suite's delta would
  depend on execution history. Explicit baseline input keeps CI deterministic.
- **Fabricating a $ cost for local models** — rejected as dishonest; local is `0` / `costBasis:"local-free"`.
- **A separate per-model workflow** — rejected: the `modelId` dimension keeps one uniform graph + aggregate.

## Consequences
**Positive** — delivers the model-comparison (cost–quality–latency) + regression artifacts AI-PMs are hired to
reason about; uniform aggregate (stub/workflow = single-model degenerate case); regression reproducible in CI,
honest when absent.
**Negative / accepted** — more configuration surface (`sutModels`, price table) that must be defended in tests so
CI cannot route through a live model; cloud cost is an estimate from a maintained price table (labelled as such).

## Honest framing for the résumé / interview
*"A multi-model eval bench — the same golden set across models, scored deterministic-first + LLM-as-judge,
surfacing the cost–quality–latency triangle per model and a reproducible regression delta vs. a committed
baseline; live model/judge optional, the stub default keeps the suite offline and reproducible."* The
differentiation is **reproducible regression + honest cost surfacing**, not "I called three model APIs."

## Implementation / verification note (v0.4.0 — built + verified live 2026-05-30)

**Built this increment:** decisions 1–4 + the `verify:bench` part of 6. **Decision 5 (regression vs.
baseline) is DEFERRED to v0.5.0** — `regressionDelta` stays `null` (honest, as before).

- **`modelId` on every row (d.1).** Each SUT branch emits the uniform row shape
  `{ caseId, modelId, rowKey, output, latencyMs, totalTokens, estCostUsd, costBasis, sutSource }` where
  `rowKey = caseId + "∷" + modelId` (U+2237). `sut.outputs` is now the **row spine**: the deterministic
  assertions, the stub judge, the live-Ollama judge fan-out/parse, and Aggregate all iterate `sut.outputs`
  and key by `rowKey` (no longer by `golden`/`caseId`). Aggregate **groups by `modelId`** into
  `perModel:[{modelId,total,passRate,perRubricMean,meanLatencyMs,totalTokens,estCostUsd,costBasis}]` + a
  ranked `bench`. For stub/workflow, `modelId` is the mode label (`"stub"` / `"product-feedback"`), so
  `perModel` has length 1 and `aggregate.passRate`/`perRubricMean`/`judgeTrust`/`calibration` are byte-for-byte
  the pre-v0.4.0 single-model values (verified: the offline `verify:live` stub suite stays green, 38 assertions).

- **`sutMode:"model"` (d.2).** Three new nodes — `Fan Out Model Cases` (emits one item per `(case, model)`,
  the cross-product `cases × sutModels`), `Call Model SUT (Ollama)` (`httpRequest` POST
  `http://host.docker.internal:11434/api/chat`, `temperature:0`, **no** `format:json` so the model's raw text
  is the actual output, `onError:continueRegularOutput`), and `Parse Model SUT (Ollama)` (extracts
  `message.content`; `totalTokens = eval_count + prompt_eval_count`; `latencyMs = total_duration / 1e6`).
  An unreachable model / empty output → `sutSource:"error"`, empty output → the deterministic check fails →
  `passed=false` (never a silent pass — verified by a forced-error simulation).

- **Two lanes, reproducible (d.3).** `sutModels` defaults to `["stub","llama3.2:3b"]` and **always forces the
  `stub` lane in** (de-duplicated, stub first); a per-request `body.sutModels` overrides the live list. The
  `stub` lane is computed **deterministically inside `Parse Model SUT`** (echo / HALLUCINATE policy — no model
  call), so it stays offline + reproducible even within `sutMode:"model"`. Only `llama3.2:3b` is pulled locally;
  no new models were pulled.

- **Honest cost (d.4).** Local Ollama → `estCostUsd:0`, `costBasis:"local-free"` (tokens + latency reported).
  A `$` figure is produced **only** for a known cloud `modelId` present in an explicit `body.priceTable`
  (`tokens/1000 × usdPer1kTokens`, `costBasis:"cloud-estimate"`) — none are used now; a local cost is never
  fabricated (verified by a price-table simulation: `gpt-4o-mini` @ $0.6/1K, 50 tokens → `estCostUsd:0.03`,
  `costBasis:"cloud-estimate"`).

- **Routing choice (d.3): a second nested IF, not a Switch.** The non-workflow path now passes through a new
  `SUT Mode = Model?` IF: `onTrue` → the model fan-out, `onFalse` → the deterministic stub SUT. All **three**
  SUT branches (`workflow` / `model` / `stub`) fan in to `Run Deterministic Assertions` by node identity, so the
  judge → aggregate → audit → response tail is still defined exactly once. A second IF (over `switchCase`) keeps
  the visual idiom uniform — every gate in this workflow is an IF — and avoids the SDK Switch connection-shape risk.

- **Gates (d.6).** Node floor raised **26 → 30** (compile/sync/static/json, `meta.json`, README). New
  `npm run verify:bench` (non-CI, like `verify:judge`) runs the live `sutMode:"model"` fan-out over
  `fixtures/golden/bench-model-slice.json` with the **stub judge** (a fixed judge, varying SUT model — so the
  bench isolates the SUT-model comparison from judge variance) and prints the per-model triangle + ranked bench +
  raw JSON.

**Live verification (2026-05-30, workflow `IhmmthDFMKdDbgvp`, 30 nodes, active; PUT 200 + activate):**

- `verify:static` / `verify:json` — green (registry fresh, canonical + release at floor 30, secret scan clean).
- `verify:live` — green, **38 assertions / 3 cases** (stub SUT + stub judge, offline); now asserts
  `aggregate.perModel` exists (single `"stub"` entry, `costBasis:"local-free"`), `policyVersion:eval-harness-v0.4.0`.
- `verify:judge` — green, live `llama3.2:3b` judge, agreement **1.0** over the 6-case slice, `judgeTrust:high`.
- `verify:connected` — green, `sutMode:"workflow"`, passRate **1.0** (6/6 live themes matched).
- `verify:bench` — live, `sutMode:"model"`, two lanes: **`stub`** passRate **0** (`meanLatencyMs` 1, no tokens —
  the reproducible baseline that echoes the prompt) vs **`llama3.2:3b`** passRate **1** (`meanLatencyMs` 662,
  135 tokens), both `estCostUsd:0` / `costBasis:"local-free"`; `bench` ranks `llama3.2:3b` #1. The lanes diverge
  honestly on the knowledge case (`capital-france`): the stub echoes the question (fails) while the live model
  answers "Paris" (passes) — a genuine multi-model comparison, not a trivially-all-pass slice.

**Honest deviations from the ADR-as-planned:** (a) `sutMode:"model"` uses **no** `format:json` (the ADR said
"`format` as needed") — a general text SUT must return free-form text, so its raw answer is what the deterministic
taxonomy grades. (b) `regressionDelta` and the `verify:live` deterministic-baseline assertion of decision 5/6 are
**deferred to v0.5.0** per the increment scope; `regressionDelta` stays `null`.

## Implementation / verification note (v0.5.0 — decision 5 DONE, built + verified live 2026-05-30)

**Built this increment:** **decision 5 (regression vs. baseline)** + the regression part of decision 6.
Decisions 1–4 (multi-model bench) are unchanged from v0.4.0. **`regressionDelta` is now COMPUTED** (it was
the `null` placeholder) — **DECISION 5 is DONE.**

- **Where + how (decision 5).** The compute lives in the **existing `Aggregate Eval Run` node** (it already
  had `passRate` / `perModel` / `perRubricMean` in scope) — **no new node**, so the node floor **stays 30**.
  The baseline is an **explicit input** carried in the **request body** (`body.baseline`): a caller supplies it
  inline (`baselineSource:"request"`) or the offline test driver injects the committed
  `fixtures/baseline/regression-baseline.json` (`baselineSource:"fixture"`). `Normalize Eval Request` validates
  + threads it onto `runtime.baseline` / `runtime.baselineSource` / `runtime.regressionTolerance`. Delta =
  **current − baseline** on overall `passRate`, **per-model** `passRate` (matched by `modelId`), and
  `perRubricMean` (per dim). `regressed:true` iff **any** overall/per-model `passRate` drops **more than the
  tolerance band** (`current < baseline − tolerance`, default tolerance `0`). A `modelId` present now but
  **absent from the baseline** is reported (`passRateDelta:null`, `isNew:true`) and **never** a regression
  (you cannot regress vs. nothing). **No baseline → `regressionDelta:null`** (honest, exactly as before).
  Emitted shape:

  ```
  regressionDelta: {
    baselineSource: "request" | "fixture",
    tolerance: <band>,
    overall: { passRate, baselinePassRate, passRateDelta },
    perModel: [ { modelId, passRate, baselinePassRate, passRateDelta, isNew } ],
    perRubricMeanDelta: { groundedness, relevance, helpfulness, safety },
    regressed: <bool>
  }
  ```

- **Deterministic + reproducible (the whole point, decision 6).** The STUB SUT + STUB judge path is
  deterministic, so the committed `fixtures/baseline/regression-baseline.json` (the captured stub-run aggregate
  for the 2-case echo slice — overall `passRate 0.5`, `stub` lane `0.5`, `perRubricMean {3.5,3.5,3.5,5}`) yields a
  **byte-stable** delta. A baseline-equals-current run → `passRateDelta:0`, `regressed:false`.

- **No hidden store as the CI mechanism (decision 5).** The request/fixture baseline is **primary and the only
  CI mechanism**. The optional `$getWorkflowStaticData("global")` "last run" convenience was **SKIPPED** — it is
  not needed for any gate and keeping it out guarantees `verify:live` stays reproducible (no dependency on
  execution history). This is the ADR's preferred resolution ("if in doubt, skip static-data").

- **`verify:live` stays offline + green AND now asserts the deterministic `regressionDelta` (decision 6).**
  `scripts/Test-EvalHarnessWorkflow.ps1` gained a `regression-baseline` case asserting BOTH: (a) a
  baseline-equals-current run (inject the fixture as `body.baseline`) → `regressed:false`, every
  `passRateDelta == 0`, `baselineSource == "fixture"`; (b) a deliberately-higher-pass-rate baseline (the same
  fixture mutated upward to `passRate 1.0`) → `regressed:true` with a **negative** overall `passRateDelta`. All
  existing v0.4.0 assertions (`perModel` etc.) stay green. `policyVersion` bumped `v0.4.0 → v0.5.0`. The suite
  grew **38 → 52 assertions**, all PASS, offline.

**Live verification (2026-05-30, workflow `IhmmthDFMKdDbgvp`, 30 nodes, active; PUT 200 + re-activated):**

- `verify:static` / `verify:json` — green (registry fresh, canonical + `llm-eval-harness-v0.5.0.json` at floor 30, secret scan clean).
- `verify:live` — green, **52 assertions / 3 cases**, fully offline (stub SUT + stub judge), incl. the two deterministic regression assertions; `policyVersion:eval-harness-v0.5.0`.
- `verify:judge` — green, live `llama3.2:3b` judge, agreement **1.0**, `judgeTrust:high` (unchanged by v0.5.0).
- `verify:connected` — green, `sutMode:"workflow"`, passRate **1.0** (unchanged by v0.5.0).
- `verify:bench` — green, live `sutMode:"model"`, two lanes (`stub` + `llama3.2:3b`); `regressionDelta` is `null` here (no baseline passed to the bench), surfaced honestly.

Two raw `regressionDelta` blocks captured live from `IhmmthDFMKdDbgvp` (v0.5.0), 2-case echo slice, verbatim:

```json
// (a) baseline EQUALS current (committed fixture) -> regressed:false, all deltas 0
{
  "baselineSource": "fixture",
  "tolerance": 0,
  "overall": { "passRate": 0.5, "baselinePassRate": 0.5, "passRateDelta": 0 },
  "perModel": [ { "modelId": "stub", "passRate": 0.5, "baselinePassRate": 0.5, "passRateDelta": 0, "isNew": false } ],
  "perRubricMeanDelta": { "groundedness": 0, "relevance": 0, "helpfulness": 0, "safety": 0 },
  "regressed": false
}
```

```json
// (b) deliberately-HIGHER-passRate baseline -> regressed:true, negative passRateDelta (drift guard fires)
{
  "baselineSource": "request",
  "tolerance": 0,
  "overall": { "passRate": 0.5, "baselinePassRate": 1, "passRateDelta": -0.5 },
  "perModel": [ { "modelId": "stub", "passRate": 0.5, "baselinePassRate": 1, "passRateDelta": -0.5, "isNew": false } ],
  "perRubricMeanDelta": { "groundedness": -1.5, "relevance": -1.5, "helpfulness": -1.5, "safety": 0 },
  "regressed": true
}
```

**Honest deviations from the ADR-as-planned (v0.5.0):** (a) **No new node** — the ADR did not mandate one;
the regression compute fits the existing `Aggregate` node, so the node floor stays 30 (no toolchain churn).
(b) The optional `$getWorkflowStaticData` "last run" convenience was **skipped entirely** (the ADR permitted
this: "if in doubt, skip static-data and keep only the explicit baseline"). (c) `perRubricMeanDelta` is an
informational drift signal and is **not** part of the `regressed` gate — the **pass-rate** is the headline
regression metric (mirroring the eval-plan's band semantics); a rubric-mean drift surfaces in the delta but
does not by itself flip `regressed`.
