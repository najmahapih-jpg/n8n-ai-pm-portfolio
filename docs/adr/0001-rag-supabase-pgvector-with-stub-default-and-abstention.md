# ADR-0001: RAG over Supabase pgvector, with a deterministic stub default and abstention-over-hallucination

- **Status:** Accepted — **implemented (v0.2.0 live; see Implementation note)**
- **Date:** 2026-05-30 (v0.2.0 implementation note added 2026-05-31)
- **Workflow:** `Portfolio - RAG Knowledge Assistant API` (`workflows/sdk/rag-knowledge-assistant.workflow.js`, deployed as n8n workflow `jZ5Xfml8jbKexYqf`, 27 nodes, active)
- **Related:** [eval-plan.md](../eval-plan.md); the portfolio's honest-eval lineage —
  `n8n-llm-eval-harness/docs/adr/0001` (stub-default) and `n8n-product-feedback-intelligence/docs/adr/0001`.

## Context

This is the portfolio's first **retrieval-grounded** workflow. Two design questions dominate, and an
AI-PM is judged on the *reasoning*, not the tool: (1) **which vector store** (build-vs-buy), and
(2) **how to keep a cloud-backed RAG eval reproducible and offline** like the rest of the harness —
while making the two RAG trust behaviours (**citations** and **abstention**) first-class, tested invariants.

## Decision drivers
- **Grounding + attribution** — every answer cites the retrieved chunk(s) it stands on.
- **Abstention over hallucination** — on retrieval miss, say "I don't know"; never fabricate.
- **Reproducible, offline eval** — the Layer-2 suite must run with no vector store, no model, no keys.
- **Local-first embeddings/generation** — no paid cloud in the hot path; no secrets in CI.
- **Employable, low-maintenance stack** — a backend a hiring manager recognises and can reason about.

## Considered options (vector store)
1. **Local Qdrant (Docker)** — fully local, n8n-native, but one more container to run/maintain and a less "real-world SaaS" story.
2. **Supabase (pgvector), cloud free tier** — real managed Postgres+pgvector, n8n-native `Supabase Vector Store` node, free tier, highly employable; cost = a cloud dependency + keys. **← chosen (live backend)**
3. **In-memory / ephemeral store** — zero infra but non-persistent; not a credible product.

## Decision

**Live backend: Supabase (pgvector)** (option 2) — chosen for the employable, pgvector-ready,
free-tier story and the native n8n node. **Embeddings + generation run on local Ollama**
(`nomic-embed-text-v2-moe` for vectors, `llama3.2:3b` for grounded answers) so no paid cloud sits in the hot
path. **The default everywhere CI touches is a deterministic stub retriever + stub generator** over
the in-repo corpus: a fixed query maps to fixed chunks, an out-of-corpus query maps to **none** — so
the offline suite deterministically drives both the *cited-answer* and the *abstain* paths.

Two behaviours are **tested invariants, not best-effort**:
- **Mandatory citations with integrity** — every answer carries ≥1 citation, and every cited
  `chunkId` MUST be one that was actually retrieved for that query (a citation outside the retrieved
  set is hallucinated attribution → `passed=false`).
- **Abstention threshold** — `abstained=true` ⟺ `retrieval.maxScore < threshold`; when abstaining,
  `answer=null`, `citations=[]`. The generation prompt is constrained to "answer only from the
  provided context; if it is not there, abstain."

### Why not pure-local (Qdrant)
A fine choice, but Supabase tells a stronger, more employable build-vs-buy story and reuses managed
pgvector; the stub-default neutralises its only real downside (cloud/keys in CI). Qdrant remains the
documented fallback if local-only is ever required (the retrieval step is isolated behind one gate).

### Why not pure-cloud / live-in-CI
Non-reproducible, key-bearing, and flaky. The stub default keeps Layer-2 offline and deterministic;
live Supabase + Ollama are **opt-in per request** and demonstrated separately.

## Consequences
**Positive**
- A real, employable RAG (Supabase pgvector + local Ollama) with **citations + abstention as
  invariants**, plus a fully offline, reproducible Layer-2 suite.
- New technical axis (retrieval/embeddings) the rest of the portfolio lacks.
- Designed to be **graded by Project A** as a `sutMode:"workflow"` subject — connected projects.

**Negative / accepted trade-offs**
- A cloud dependency + `service_role` key (env only, scrubbed, opt-in) — never load-bearing for tests.
- The reproducible suite validates the **stub + plumbing + invariants**, not live retrieval recall or
  generation faithfulness — those are a manual Layer-1 activity (and A's job).
- Two source paths (stub vs live) are a config surface that must be defended so CI can't hit Supabase/Ollama.

## Honest framing for the résumé / interview
*"A grounded RAG assistant over Supabase pgvector with local-Ollama embeddings — every answer cited to
its retrieved source, and an enforced abstention threshold so a retrieval miss returns 'I don't know'
instead of a hallucination, all behind a deterministic stub default that keeps the eval offline and
reproducible (and lets my eval-harness project grade it as a black box)."* The differentiation is
**citation integrity + enforced abstention + reproducibility**, not "I put docs in a vector DB."

## Implementation note (v0.2.0 — live path wired, 2026-05-31)

The decision above shipped exactly as designed. What v0.2.0 added and the few honest deviations:

**Live pipeline (opt-in per request).** A `retrievalSource:"supabase"` IF gate routes the query to
`Embed Query (Ollama)` (`nomic-embed-text-v2-moe`, 768-dim, `search_query:` task prefix; the corpus was ingested with `search_document:`) → `Match Documents (Supabase RPC)`
(`POST …/rest/v1/rpc/match_documents`, top-k cosine search) → `Map Supabase Retrieval`, which maps the
rows to the **same** retrieval contract the stub emits (`topK=[{chunkId,source,score}]`, `maxScore`,
`threshold`). A `generationSource:"ollama"` IF gate on the grounded branch routes to
`Generate Answer (Ollama)` (`llama3.2:3b`, temperature 0, "answer ONLY from the provided context; else
abstain"). Both gates' branches converge on the existing threshold / citation-integrity / audit /
response tail, so everything downstream is source-agnostic and the node graph grew by 8 (19 → 27).

**Citation integrity holds on the live path by construction.** The `llama3.2:3b` call supplies only the
prose; the **citations are always recomputed from the retrieved chunks** (`chunkId`/`source`/
`quote=firstSentence`), never parsed from the model. So "every cited `chunkId` ∈ `retrieval.topK`" and
"the quote is a real span of its chunk" remain *enforced invariants*, not model-trusted output.

**Secret handling.** The Supabase host and `service_role` key **never enter the workflow JSON**. The
source carries a `__SUPABASE_RPC_URL__` placeholder; the deploy step (`Sync-N8nWorkflowFromSdk.ps1`)
substitutes the real RPC URL and attaches an n8n credential **by id** into the PUT payload only. The
`verify:static` secret scan enforces that the tracked canonical/release/generated stay key-free and
host-free.

**Deviation — credential type.** The ADR assumed the native `Supabase Vector Store` node / `supabaseApi`
credential. In this n8n build that predefined credential surfaces `ECONNREFUSED` on the HTTP Request
node, so the live retrieval uses a generic **HTTP Header Auth** credential carrying the Supabase
`apikey` header instead. The ADR's *intent* — "n8n injects the auth header; the secret stays out of the
JSON" — is fully satisfied; only the credential *type* differs. (Direct PostgREST RPC was also chosen
over the Vector Store node for the same reliability reason and to keep the row→contract mapping explicit.)

**Deviation — the `sb_secret_` browser guard.** New-style `sb_secret_` keys return HTTP 401 "Forbidden
use of secret API key in browser" when the request User-Agent looks browser-like. Every direct Supabase
call (the RPC node and `Ingest-Corpus.ps1`) therefore sets a non-browser `User-Agent: n8n`.

**Graceful degrade.** Both live HTTP nodes use `onError:continueRegularOutput`; an unreachable
Supabase/Ollama maps to an empty retrieval / empty generation and degrades to the deterministic result
(`retrievalSource:"supabase-fallback"` / `generationSource:"ollama-fallback"`). A live miss is a clean
abstain or stub extract, never a crash, and the response `*Source` reports what actually ran.

**Verification evidence.** `verify:static` / `verify:json` / `verify:live` stay green and **offline**
(the stub is the default on every CI path; `verify:live` = 97 assertions, all `retrievalSource:"stub"`).
The live path is proven separately by `verify:rag-live` (non-CI, 15 assertions): an in-corpus query
returns a real `llama3.2:3b` answer citing `hydro-pumped` (Supabase cosine `maxScore≈0.79`,
`retrievalSource:"supabase"`, `generationSource:"ollama"`, `passed:true`), and an out-of-corpus query
abstains cleanly (all scores below a raised threshold → `abstained:true`, `answer:null`, `citations:[]`).
Corpus ingest loaded 8 chunks into Supabase `documents` at 768-dim (a wrong dimension would fail the
insert, so the ingest also confirms the schema).

**Connected (A grades B) — honest status.** Project A reaches B end-to-end as a black-box
`sutMode:"workflow"` subject over B's real webhook, but A's workflow-SUT parser extracts
`response.theme` (it was built for the product-feedback classifier sibling); B is a RAG assistant
returning `answer`/`abstained`/`citations` with no `theme`, so A's exact-match verdict is honestly
`passed:false` — a cross-project response-shape mismatch, not a B defect. Teaching A's parser to grade a
RAG SUT is a Project A change and is out of scope here (A's deployed workflows are frozen).
