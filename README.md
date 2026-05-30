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

> **Status: v0.3.0 — live & verified.** The harness is deployed on local n8n (workflow id
> `IhmmthDFMKdDbgvp`, **26 nodes**, active) and now grades a **deployed sibling workflow** as a
> black-box subject-under-test: `sutMode:"workflow"` POSTs each golden case to the live
> **product-feedback** API (`6Gc3wmri0tJre07B`) over its real webhook and grades `response.theme`
> (exact-match), with graceful non-fatal failure when the sibling is down (see
> [ADR-0003](docs/adr/0003-grade-deployed-sibling-as-blackbox-sut.md)). The v0.2.0 **live local Ollama
> LLM-as-judge** (`llama3.2:3b`, behind a deterministic fallback) and the **judge–human calibration**
> (agreement → `judgeTrust`) are unchanged. The stub SUT **and** stub judge remain the defaults so the
> Layer-2 behavioral suite (`verify:live`) stays offline and reproducible; the live judge runs under
> `verify:judge` (needs Ollama) and the live connected eval under `verify:connected` (needs the sibling).

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

## Node graph (v0.3.0 — built; SUT *model* fan-out & regression delta deferred)

Built in v0.3.0: the webhook entrypoint, validation, a **gated subject-under-test** (stub default /
live `workflow` per request — a visual IF gate `SUT Mode = Workflow?` fans out each case to the
deployed **product-feedback** webhook and extracts `response.theme` as the actual output, with
`onError:continueRegularOutput` making an unreachable sibling a non-fatal `passed=false`), the 5-type
deterministic assertions, the **gated LLM-as-judge** (stub default / live Ollama per request) with
schema-validation + deterministic fallback, the **judge-drift guard** (judge vs. human-labeled slice →
`judgeTrust`), and the redacted audit + JSON response. The two SUT branches fan in to the deterministic
assertions, so the judge → aggregate → audit → response tail is defined once. Still deferred: live
**SUT `model`** fan-out (Ollama/cloud), the schedule trigger, regression-delta vs. previous run, and
optional Markdown/Feishu reporting.

```
trigger (webhook: one eval run  |  schedule: batch)
  -> load golden dataset (+ validate: tasks present)
  -> for each task:
       -> run subject-under-test  (mode: stub | model[ollama|cloud] | workflow[product-feedback])
       -> deterministic assertions (5-type taxonomy)  [FIRST — owns checkable facts]
       -> LLM-as-judge (stub | live)  -> {groundedness, relevance, helpfulness, safety} 1..5 + rationale
       -> validate judge output (schema)  -> fallback if invalid (passed=false)
  -> aggregate (per-SUT pass-rate, per-rubric mean, cost, latency)
  -> judge-drift guard (judge vs. human-labeled slice -> judgeTrust high|low)
  -> regression delta vs. previous run
  -> redacted audit event
  -> structured report (JSON; optional Markdown / Feishu)
```

## Docs & artifacts

- [fixtures/requests/llm-eval-harness.md](fixtures/requests/llm-eval-harness.md) — requirement spec (Problem → Solution → Impact + Control).
- [docs/eval-plan.md](docs/eval-plan.md) — the two-layer recursion, scorer contract, golden dataset, assertion map, regression semantics.
- [docs/adr/0001-hybrid-deterministic-and-llm-judge-scoring.md](docs/adr/0001-hybrid-deterministic-and-llm-judge-scoring.md) — the hybrid-scoring + calibrated-stub-judge decision.
- [docs/adr/0002-deploy-via-rest-api-without-mcp.md](docs/adr/0002-deploy-via-rest-api-without-mcp.md) — compile the SDK standalone and deploy via the n8n public REST API (no MCP).
- [docs/adr/0003-grade-deployed-sibling-as-blackbox-sut.md](docs/adr/0003-grade-deployed-sibling-as-blackbox-sut.md) — grade the deployed product-feedback sibling as a black-box subject-under-test (v0.3.0).

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
npm run verify:json       # n8n workflow JSON shape + node floor (canonical >= 26, releases)
npm run verify:live       # connection check -> SDK sync -> 30-assertion behavioral suite (STUB SUT + STUB judge)
npm run verify:judge      # LIVE Ollama judge + judge-human calibration over the slice (needs Ollama; NOT in CI)
npm run verify:connected  # LIVE connected eval: activates product-feedback, grades it as a black-box SUT (sutMode:workflow); needs the sibling; NOT in CI
```

`verify:live` exercises the **stub** SUT + **stub** judge only, so it is deterministic and offline (the
eval-plan's Layer-2 discipline). `verify:judge` is a **separate, Layer-1** activity: it deploys the
workflow, runs the live `llama3.2:3b` judge over `fixtures/calibration/calibration-slice.json`, and
prints the raw Ollama JSON, the per-case judge-vs-human comparison, the **agreement** number, and the
resulting `judgeTrust`. `verify:connected` is the other **Layer-1** activity: it activates the deployed
**product-feedback** sibling (`6Gc3wmri0tJre07B`), POSTs `fixtures/golden/connected-product-feedback.json`
with `sutMode:"workflow"`, and prints one verbatim raw product-feedback response plus the per-case
**theme (actual) vs expected** table and the pass-rate — honestly, even when the live themes do not all
match. Both Layer-1 drivers report real numbers (a low agreement or a sub-1.0 pass-rate is a correct,
surfaced result, not a hidden failure).

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

**Deferred (roadmap)**
- [ ] SUT **model** fan-out (`sutMode:"model"` — Ollama/cloud as the subject-under-test).
- [ ] Regression delta vs. the previous run (run store).
