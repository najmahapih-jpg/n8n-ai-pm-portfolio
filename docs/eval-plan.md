# Eval Plan — RAG Knowledge Assistant API

Written **before** the workflow is built. The contract the node graph and
`Test-RagAssistantWorkflow.ps1` must satisfy. Companion:
[ADR-0001](adr/0001-rag-supabase-pgvector-with-stub-default-and-abstention.md),
[requirement spec](../fixtures/requests/rag-knowledge-assistant.md).

## Two layers of eval (read first)

- **Layer 1** — the assistant answers a question grounded in the corpus (the product's job).
- **Layer 2** — this repo's behavioural suite grades the assistant's *plumbing* against a
  **deterministic stub retriever + stub generator** over the in-repo corpus, so it stays offline and
  reproducible.

**What Layer 2 proves:** ingest→chunk→retrieve→ground→cite→**abstain** wiring is correct and safe —
the stub retriever returns fixed chunks for in-corpus queries and **nothing** for out-of-corpus
queries, so the suite deterministically exercises both the *answer-with-citation* path and the
*abstain* path, plus citation validity and audit redaction.

**What Layer 2 does NOT prove:** that the *live* Ollama generation is faithful, or that *live*
Supabase retrieval recall is good. Live RAG quality is a **Layer-1, manual, honestly-labelled**
activity — and, fittingly, **the job of Project A** (the eval harness grades this workflow as a
black-box `sutMode:"workflow"` subject). We do not narrate the stub suite as "evals that prove my RAG
is faithful."

## What gets measured (Layer 1, the real RAG metrics)

| Metric | Definition |
|---|---|
| **Groundedness / faithfulness** | Every claim in the answer is supported by a cited retrieved chunk (no unsupported facts). |
| **Citation validity** | Each citation references a chunk id that was actually retrieved for this query, and the cited span exists in that chunk. |
| **Abstention correctness** | Abstains (`abstained:true`) iff no chunk clears the similarity threshold; answers iff the corpus supports it. The two error types: *hallucinated answer on miss* and *false abstain on a hit*. |
| **Retrieval recall@k** | For golden questions, the gold chunk is in the top-k retrieved set. |

## Scorer contract (per query)

```
answer(query, mode) -> {
  abstained: bool,
  answer: string | null,              // null when abstained
  citations: [{ chunkId, source, quote }],   // [] only when abstained
  retrieval: { topK: [{chunkId, score}], threshold, maxScore },
  retrievalSource: "stub" | "supabase",
  generationSource: "stub" | "ollama",
  passed: bool                        // grounded AND every citation maps to a retrieved chunk (or a correct abstain)
}
```

- **Citation-integrity rule:** every `citations[].chunkId` MUST appear in `retrieval.topK`; otherwise
  the response is invalid (`passed=false`). A model that cites a chunk it wasn't given is hallucinating
  attribution — caught deterministically.
- **Abstain rule:** `abstained=true` ⟺ `retrieval.maxScore < threshold`. When abstained,
  `answer=null` and `citations=[]` (no fabricated citation to dress up a non-answer).
- **Default sources are stub** (`retrievalSource:"stub"`, `generationSource:"stub"`), deterministic
  and offline. Live `supabase`/`ollama` are opt-in per request and never touched by CI.

## Golden dataset (planned)

A small fixed **corpus** (`fixtures/corpus/`) + a labelled question set (`fixtures/golden/`) where
each case is `{ query, expectAbstain: bool, expectAnswerContains?: [...], expectCiteChunkIds?: [...] }`:

| Golden case | exercises | expected |
|---|---|---|
| `in-corpus-direct` | answer + citation | `abstained:false`, cites the gold chunk, answer contains the fact |
| `in-corpus-paraphrased` | retrieval on novel phrasing | retrieves gold chunk, grounded answer |
| `out-of-corpus` | **abstention** | `abstained:true`, `answer:null`, `citations:[]` |
| `adversarial-injection` | prompt-injection in the query | ignores injection; answers from corpus or abstains |
| `partial-corpus` | answer present but thin | answers with citation OR abstains — never fabricates beyond the chunk |
| `citation-must-be-real` | attribution integrity | every citation ∈ retrieved top-k |

## Layer-2 behavioural suite (what `verify:live` asserts — stub retriever + stub generator)

> **Gate attribution:** `verify:live` (`npm run verify:live`) is **opt-in and NOT part of CI**.
> It requires a live n8n instance (connects, syncs, then runs `Test-RagAssistantWorkflow.ps1`).
> The CI pipeline (`ci.yml`) runs only the **offline static/JSON/secret gate**:
> `Invoke-StaticValidation.ps1` (PS parse check, JSON parse check, registry freshness, workflow
> structural validation) and `Test-RepositorySecrets.ps1` (secret scan).  The CI gate does NOT
> execute any request against the workflow and does NOT assert any of the behavioral invariants
> below (abstain correctness, citation integrity, groundedness, PII masking).  Those invariants
> are only proven by running `verify:live`.

| Field(s) | Assertion type | Helper |
|---|---|---|
| `abstained`, `retrievalSource`, `generationSource`, `policyVersion` | **exact-match** | `Assert-Equal` |
| `retrieval.maxScore` vs `threshold`, `topK` length ≤ k | **numeric-range band** | `Assert-NumberBetween` |
| every `citations[].chunkId` ∈ `retrieval.topK` (citation integrity) | **relational / membership** | `Assert-CitationsMapToRetrieval` |
| out-of-corpus → `abstained:true` ∧ `answer==null` ∧ `citations==[]` | **branch-shape / absence** | `Assert-CleanAbstain` |
| audit & response carry no raw key / no PII | **negative + masking** | `Assert-NoRawPiiLeak` |

These reuse the harness's proven assertion taxonomy; the **new** invariants this workflow adds are
**citation-integrity** and **clean-abstain**, both asserted deterministically via the stub.

## Regression semantics
Categoricals (`abstained`, `*Source`) exact-matched; scores/threshold as bands. Highest-severity
guards: a **hallucinated answer on an out-of-corpus query** (false non-abstain) and a **citation that
doesn't map to a retrieved chunk** — both must fail loudly.
