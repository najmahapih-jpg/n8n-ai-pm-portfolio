# n8n LLM Eval Harness

Workflow-as-Code portfolio project: a local n8n API that **grades AI systems**. Given a golden
dataset of tasks and one or more subjects-under-test (a model, a prompt, or an existing portfolio
workflow), it scores each output with a **hybrid scorer** — deterministic assertions for checkable
facts + an **LLM-as-judge** for subjective quality — aggregates per-model pass-rate / cost / latency,
computes a **regression delta** vs. the previous run, and **calibrates the judge against human labels**
(reporting judge–human agreement + a judge-drift guard) so the grader itself is never treated as
ground truth.

This is the **fourth** workflow on the shared "Workflow-as-Code" harness and the first to operate at
the **meta level** — it does not do an end-user task, it **measures AI quality**, the single
highest-signal AI-PM portfolio artifact.

> **Status: v0.4.0 — live & verified (multi-model bench).** The harness is deployed on local n8n
> (workflow id `IhmmthDFMKdDbgvp`, **30 nodes**, active) and is now a **multi-model eval bench**: every
> scored row carries a `modelId` (key `caseId∷modelId`) and **Aggregate groups by `modelId`** into
> `perModel` (pass-rate + per-rubric mean + `meanLatencyMs` + `totalTokens` + `estCostUsd` + `costBasis`)
> plus a ranked `bench` — the **cost–quality–latency triangle** per model. `sutMode:"model"` fans out
> **cases × `sutModels`** and calls local **Ollama** (`/api/chat`, `temperature:0`) per `(case, model)`,
> running two lanes by default — the deterministic **`stub`** lane (the reproducible comparison baseline)
> **and** the live **`llama3.2:3b`** lane — with graceful non-fatal failure (`sutSource:"error"`,
> `passed=false`) on an unreachable model. Cost is **honest**: local Ollama is `estCostUsd:0` /
> `costBasis:"local-free"` (tokens + latency are the signal); a `$` estimate is only ever produced for
> **known cloud ids** in an explicit `priceTable` (none used now) — a local cost is never fabricated
> (see [ADR-0004](docs/adr/0004-multi-model-bench-cost-latency-regression.md)). v0.3.0's `sutMode:"workflow"`
> black-box SUT, the v0.2.0 **live Ollama judge** + **judge–human calibration** are unchanged. The stub SUT
> **and** stub judge remain the defaults so the Layer-2 behavioral suite (`verify:live`) stays offline and
> reproducible; the live bench runs under **`verify:bench`** (needs Ollama), the live judge under
> `verify:judge`, and the live connected eval under `verify:connected`. **Deferred to v0.5.0:**
> regression-vs-baseline delta (`regressionDelta` stays `null`).

## Why this project (AI-PM framing)

Owning **AI quality** is the non-negotiable AI-PM differentiator, and an eval harness is the artifact
that proves it. Unlike the three sibling workflows (which embed evals to test *their own* plumbing),
this one is a **standalone measurement product**:

- A **real LLM-as-judge** with a documented rubric — and, crucially, a **judge calibrated against
  human labels** with a drift guard. *Who judges the judge* is the senior signal most portfolios miss.
- **Deterministic-first** scoring so checkable facts never go to a fuzzy grader (cost + nondeterminism
  avoided by design).
- The **cost–quality–latency triangle** surfaced per run — the trade-off AI-PMs are hired to reason about.
- **Connected projects**: it evaluates `n8n-product-feedback-intelligence` (and the planned RAG
  project) as subjects-under-test, turning the portfolio into a system rather than four demos.

## Honest eval framing (read this first)

The project has **two layers of eval** and deliberately does not conflate them:

- **Layer 1** — the harness grades a subject-under-test (the product's job).
- **Layer 2** — this repo's behavioral suite grades the harness's *plumbing* against a **deterministic
  stub** subject + stub judge, so it stays offline and reproducible.

Layer 2 proves mechanics and graceful degradation — **not** that the live judge scores like a human.
Judge accuracy is a separate, manual, honestly-labeled calibration. See
[docs/eval-plan.md](docs/eval-plan.md) for exactly what is and isn't proven.

## Node graph (v0.4.0 — built; regression delta deferred to v0.5.0)

Built in v0.4.0 (**30 nodes**): the webhook entrypoint, validation, a **3-way gated subject-under-test**
routed by **two nested IFs** (`SUT Mode = Workflow?` → `SUT Mode = Model?`), all three SUT branches
fanning in to the deterministic assertions:

- **stub** (default) — deterministic echo SUT; keeps `verify:live` offline + reproducible.
- **`workflow`** — fans out each case to the deployed **product-feedback** webhook and grades
  `response.theme` (exact-match), `onError:continueRegularOutput` → unreachable sibling = `passed=false`.
- **`model`** (v0.4.0) — fans out **cases × `sutModels`** and calls **Ollama** `/api/chat`
  (`temperature:0`) per `(case, model)` via three nodes (`Fan Out Model Cases` → `Call Model SUT (Ollama)`
  → `Parse Model SUT (Ollama)`), extracting the model text as the actual output + `eval_count` +
  `prompt_eval_count` tokens + `total_duration` latency. `sutModels` defaults to `["stub","llama3.2:3b"]`
  (the deterministic stub lane **and** the live model lane); an unreachable model → `sutSource:"error"`,
  `passed=false`.

Every scored row carries a `modelId` (key `caseId∷modelId`); the 5-type deterministic assertions and the
**gated LLM-as-judge** (stub default / live Ollama per request, schema-validation + deterministic
fallback) operate **per row**, and **Aggregate groups by `modelId`** into `perModel`
(`{modelId, total, passRate, perRubricMean, meanLatencyMs, totalTokens, estCostUsd, costBasis}`) + a
ranked `bench`. Cost is honest: local Ollama is `estCostUsd:0` / `costBasis:"local-free"`; cloud ids are
priced only from an explicit `priceTable`. The **judge-drift guard** (judge vs. human-labeled slice →
`judgeTrust`) and the redacted audit + JSON response are unchanged. Still deferred to **v0.5.0**:
regression-delta vs. a committed baseline (`regressionDelta` stays `null`), the schedule trigger, and
optional Markdown/Feishu reporting.

```
trigger (webhook: one eval run  |  manual: editor demo)
  -> load golden dataset (+ validate: tasks present)
  -> route SUT  (two nested IFs: workflow? -> model? -> stub) -- fan in to assertions
  -> for each (case, model):                                  [modelId on every row; key caseId∷modelId]
       -> run subject-under-test  (stub | workflow[product-feedback] | model[ollama: cases × sutModels])
       -> deterministic assertions (5-type taxonomy)  [FIRST — owns checkable facts]
       -> LLM-as-judge (stub | live Ollama)  -> {groundedness, relevance, helpfulness, safety} 1..5
       -> validate judge output (schema)  -> fallback if invalid (passed=false)
  -> aggregate: GROUP BY modelId -> perModel {passRate, perRubricMean, meanLatencyMs, totalTokens,
                                              estCostUsd, costBasis} + ranked bench  (cost–quality–latency)
  -> judge-drift guard (judge vs. human-labeled slice -> judgeTrust high|low)
  -> regression delta vs. committed baseline  [DEFERRED to v0.5.0 -> null]
  -> redacted audit event
  -> structured report (JSON)
```

## Docs & artifacts

- [fixtures/requests/llm-eval-harness.md](fixtures/requests/llm-eval-harness.md) — requirement spec (Problem → Solution → Impact + Control).
- [docs/eval-plan.md](docs/eval-plan.md) — the two-layer recursion, scorer contract, golden dataset, assertion map, regression semantics.
- [docs/adr/0001-hybrid-deterministic-and-llm-judge-scoring.md](docs/adr/0001-hybrid-deterministic-and-llm-judge-scoring.md) — the hybrid-scoring + calibrated-stub-judge decision.
- [docs/adr/0002-deploy-via-rest-api-without-mcp.md](docs/adr/0002-deploy-via-rest-api-without-mcp.md) — compile the SDK standalone and deploy via the n8n public REST API (no MCP).
- [docs/adr/0003-grade-deployed-sibling-as-blackbox-sut.md](docs/adr/0003-grade-deployed-sibling-as-blackbox-sut.md) — grade the deployed product-feedback sibling as a black-box subject-under-test (v0.3.0).
- [docs/adr/0004-multi-model-bench-cost-latency-regression.md](docs/adr/0004-multi-model-bench-cost-latency-regression.md) — multi-model SUT fan-out + per-model cost–latency–quality bench (v0.4.0); regression-vs-baseline deferred to v0.5.0.

## Portfolio roadmap (chosen direction: build A first, keep B/C/D)

Per the OSS review ([../n8n-oss-review-and-best-practices-2026.md](../n8n-oss-review-and-best-practices-2026.md)),
this is project **A** of a four-project differentiation plan:

| # | Project | Status | Different-from-current axis |
|---|---|---|---|
| **A** | **LLM Eval Harness (this repo)** | **in progress** | meta-level: grades AI quality |
| B | RAG Knowledge Assistant (citations + "I don't know") | planned | retrieval grounding (new tech stack) |
| C | Autonomous Research Agent (multi-step + tools + retries) | planned | agentic / stateful |
| D | Scheduled Insight Digest / Drift Monitor | planned | scheduled batch + monitoring |

A is sequenced first because it has the highest signal-per-cost for this portfolio and lets the other
three be graded as subjects-under-test.

## Verify

```powershell
npm run verify:static     # offline gate: parse + secret scan + node floor + registry freshness
npm run verify:json       # n8n workflow JSON shape + node floor (canonical >= 30, releases)
npm run verify:live       # connection check -> SDK sync -> 38-assertion behavioral suite (STUB SUT + STUB judge; asserts aggregate.perModel)
npm run verify:judge      # LIVE Ollama judge + judge-human calibration over the slice (needs Ollama; NOT in CI)
npm run verify:connected  # LIVE connected eval: activates product-feedback, grades it as a black-box SUT (sutMode:workflow); needs the sibling; NOT in CI
npm run verify:bench      # LIVE multi-model bench: sutMode:model fan-out (stub + llama3.2:3b lanes, stub judge); prints the per-model triangle; needs Ollama; NOT in CI
```

`verify:live` exercises the **stub** SUT + **stub** judge only, so it is deterministic and offline (the
eval-plan's Layer-2 discipline); it now also asserts the `aggregate.perModel` surface exists (the
degenerate single-`"stub"`-model entry). `verify:judge` is a **separate, Layer-1** activity: it deploys
the workflow, runs the live `llama3.2:3b` judge over `fixtures/calibration/calibration-slice.json`, and
prints the raw Ollama JSON, the per-case judge-vs-human comparison, the **agreement** number, and the
resulting `judgeTrust`. `verify:connected` activates the deployed **product-feedback** sibling
(`6Gc3wmri0tJre07B`), POSTs `fixtures/golden/connected-product-feedback.json` with `sutMode:"workflow"`,
and prints the per-case **theme (actual) vs expected** table and pass-rate. `verify:bench` (v0.4.0) is the
other **Layer-1** activity: it runs the **live `sutMode:"model"` fan-out** over
`fixtures/golden/bench-model-slice.json` with the **stub judge** (a fixed judge, varying SUT model, to
avoid confounding the model comparison with judge variance) and prints the **per-model cost–quality–latency
triangle** + the ranked `bench` + the raw response JSON — the deterministic `stub` lane next to the live
`llama3.2:3b` lane. All Layer-1 drivers report real numbers (a low agreement or a sub-1.0 lane pass-rate is
a correct, surfaced result, not a hidden failure).

## Current Status

**v0.1.0 (done)**
- [x] Project skeleton created (mirrors sibling harness).
- [x] Eval-first front matter: requirement spec, eval plan, ADR-0001.
- [x] PowerShell toolchain (sync / scrub / validate / test / registry) adapted from siblings.
- [x] `package.json`, CI static gate, pre-commit hook, `.env.example`, secret patterns.
- [x] SDK workflow source + meta; node graph compiled via the standalone SDK and deployed via REST; validated.
- [x] Golden fixtures + 30-assertion behavioral suite; canonical/release snapshots + generated registry.

**v0.2.0 (done)**
- [x] Real **local-Ollama LLM-as-judge** (`judgeSource:"ollama"`, `llama3.2:3b`, `format:"json"`) behind a
      visual IF gate, with per-case fan-out, schema-validation, and a deterministic **fallback**
      (`judgeSource:"fallback"`, `passed=false`) on invalid/unreachable output (non-fatal via `onError`).
- [x] **Judge–human calibration**: optional per-case `humanLabel`; the run computes judge–human
      **agreement** and sets `judgeTrust = "high"` (≥ 0.8) else `"low"` (stub stays `"high"` by construction).
- [x] `fixtures/calibration/` slice (6 human-labeled cases) + `scripts/Test-LiveJudge.ps1` + `npm run verify:judge`.
- [x] Version bump to 0.2.0: `meta.json`, `workflows/releases/llm-eval-harness-v0.2.0.json`, regenerated registry.
- [x] Deployed live (id `IhmmthDFMKdDbgvp`, 22 nodes, active); `verify:static`/`json`/`live` green; `verify:judge` agreement 1.0 / `judgeTrust:high`.

**v0.3.0 (done — this release)**
- [x] **Live `sutMode:"workflow"`**: a visual IF gate (`SUT Mode = Workflow?`) fans out each golden case to
      the deployed **product-feedback** sibling (`6Gc3wmri0tJre07B`) over its real webhook and extracts
      `response.theme` (+ sentiment/urgency) as the actual output, graded by deterministic **exact-match**
      against the expected theme. Grading is **black-box** (HTTP, not a code import) — see [ADR-0003](docs/adr/0003-grade-deployed-sibling-as-blackbox-sut.md).
- [x] **Graceful non-fatal failure**: `onError:continueRegularOutput` on the SUT call → an unreachable/inactive
      sibling yields `sutSource:"error"`, `passed=false` (HTTP 200, no crash; a broken sibling never silently passes).
- [x] `fixtures/golden/connected-product-feedback.json` (6 real labelled cases) + `scripts/Test-ConnectedEval.ps1` + `npm run verify:connected`.
- [x] Tidied the cosmetic editor lint and bumped node floors to **26** across the toolchain; both SUT branches fan in to the deterministic assertions (graph topology preserved).
- [x] Version bump to 0.3.0: `meta.json`, `workflows/releases/llm-eval-harness-v0.3.0.json`, regenerated registry + canonical snapshot.
- [x] Deployed live (id `IhmmthDFMKdDbgvp`, **26 nodes**, active); `verify:static`/`json`/`live` green; `verify:judge` green; `verify:connected` passRate 1.0 (all 6 live themes matched).

**v0.4.0 (done — this release: multi-model bench)**
- [x] **`modelId` on every scored row** (key `caseId∷modelId`): the deterministic assertions + judge
      operate per row, and **Aggregate groups by `modelId`** into `perModel`
      (`{modelId, total, passRate, perRubricMean, meanLatencyMs, totalTokens, estCostUsd, costBasis}`) +
      a ranked `bench`. Stub/workflow stay the degenerate single-`"model"` case (`perModel` length 1; the
      existing `aggregate.passRate`/`perRubricMean`/`judgeTrust`/`calibration` are unchanged).
- [x] **`sutMode:"model"`** fans out **cases × `sutModels`** and calls **Ollama** `/api/chat`
      (`host.docker.internal:11434`, `temperature:0`) per `(case, model)` via three nodes
      (`Fan Out Model Cases` → `Call Model SUT (Ollama)` → `Parse Model SUT (Ollama)`); extracts the model
      text as the actual output + `eval_count` + `prompt_eval_count` tokens + `total_duration` latency.
      `onError:continueRegularOutput` → an unreachable model is `sutSource:"error"`, `passed=false`.
- [x] **Two real lanes**: `sutModels` defaults to `["stub","llama3.2:3b"]` (the deterministic stub lane +
      the live `llama3.2:3b` lane — only `llama3.2:3b` is pulled locally; no new models pulled), with a
      per-request override list (the stub lane is always forced in).
- [x] **Honest cost**: local Ollama is `estCostUsd:0` / `costBasis:"local-free"` (tokens + latency
      reported); a `$` estimate is only ever produced for **known cloud ids** in an explicit `priceTable`
      (none used now) — a local cost is never fabricated.
- [x] **3-way SUT routing** via a **second nested IF** (`SUT Mode = Model?` after `SUT Mode = Workflow?`),
      both fanning in to `Run Deterministic Assertions` (chosen over a Switch to keep every gate a uniform IF).
- [x] **Reproducible default kept**: stub SUT + stub judge stay the default; `verify:live` stays offline +
      green (assertions extended for the `perModel` shape). New **`npm run verify:bench`** (non-CI) runs the
      LIVE `sutMode:"model"` fan-out (stub + `llama3.2:3b` lanes) with the **stub judge** and prints the
      per-model triangle. Node floor raised **26 → 30** across the toolchain (compile/sync/static/json, meta, README).
- [x] Version bump to 0.4.0: `meta.json`, `workflows/releases/llm-eval-harness-v0.4.0.json`, regenerated
      registry + canonical snapshot; implementation note appended to [ADR-0004](docs/adr/0004-multi-model-bench-cost-latency-regression.md).
- [x] Deployed live (id `IhmmthDFMKdDbgvp`, **30 nodes**, active); `verify:static`/`json`/`live` green
      (38-assertion stub suite); `verify:judge` agreement 1.0 / `judgeTrust:high`; `verify:connected`
      passRate 1.0; `verify:bench` ran both lanes — `stub` passRate 0 / `llama3.2:3b` passRate 1 on the
      bench slice, `estCostUsd:0` / `costBasis:"local-free"` for both, `meanLatencyMs` 1 vs 662.

**Deferred (roadmap → v0.5.0)**
- [ ] Regression delta vs. a **committed baseline** (`body.baseline` / `fixtures/baseline/`), deterministic
      in CI via the stub lane (`regressionDelta` stays `null` until then).
- [ ] Schedule trigger (batch eval runs) + optional Markdown/Feishu reporting.
