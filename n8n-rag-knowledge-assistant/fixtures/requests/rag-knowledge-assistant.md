# Requirement Spec — RAG Knowledge Assistant API

*Captured before any node is built (eval-first). Companion: [docs/eval-plan.md](../../docs/eval-plan.md),
[docs/adr/0001-rag-supabase-pgvector-with-stub-default-and-abstention.md](../../docs/adr/0001-rag-supabase-pgvector-with-stub-default-and-abstention.md).*

## Problem

Project A proved I can **measure** AI quality. This project proves I can **build a grounded AI
feature that controls its own failure mode**. The single most in-demand 2026 AI capability is
retrieval-augmented generation — but the thing hiring managers actually probe is not "can you call a
vector DB," it is:

> When the answer **is not in the knowledge base**, does the system **say so** — or does it
> hallucinate? And can you **prove** which source each answer came from?

## Solution

A local n8n workflow — `Portfolio - RAG Knowledge Assistant API` — that answers questions **grounded
in a fixed corpus**, with two non-negotiable behaviours:

1. **Every answer carries citations** — the specific retrieved chunk(s) the answer is grounded in
   (id + source + the quoted span). An answer with no citation is a bug, not an answer.
2. **Abstention over hallucination** — when retrieval returns nothing above the similarity threshold
   (the question is out-of-corpus, or the corpus genuinely lacks the answer), the system returns
   **"I don't have enough information"** with `abstained: true`, never a fabricated answer.

Pipeline: `ingest corpus → chunk → embed → upsert to vector store → (per query) embed query →
similarity search (top-k + threshold) → ground generation on retrieved chunks → answer + citations,
or abstain`.

### Backend & reproducibility (see ADR-0001)
- **Live backend: Supabase (pgvector)** — real, employable, pgvector-ready, free tier, n8n-native
  `Supabase Vector Store` node. Embeddings + generation: **local Ollama** (`nomic-embed-text-v2-moe` +
  `llama3.2:3b`).
- **Default: a deterministic stub retriever** over the in-repo corpus (fixed query → fixed chunks),
  so the behavioural eval runs **offline, reproducible, and free** — exactly A's stub-default
  discipline. Live Supabase + Ollama are opt-in per request, never in CI, keys in env only.

## Impact

- Demonstrates the **most in-demand 2026 AI-PM capability (RAG)** at the level hiring managers test:
  **source attribution** and **graceful failure on retrieval miss**.
- Adds a genuinely **new technical axis** to the portfolio (retrieval/embeddings/vector store) that A
  and the three siblings do not have — the "different direction" selection rule.
- **Connected projects**: B is built to be **graded by A** (the eval harness) as a `sutMode:"workflow"`
  subject — A scores B's groundedness, citation validity, and abstention. The portfolio becomes a system.

## Control (failure-mode & governance requirements)

| Requirement | Control |
|---|---|
| No hallucination on retrieval miss | Similarity threshold → `abstained:true` + "insufficient information"; tested as an invariant. |
| Every answer is attributable | Answer must carry ≥1 citation referencing a **real retrieved chunk id**; a citation that doesn't map to a retrieved chunk fails. |
| Reproducible / offline eval | Stub retriever + stub generator are the **default**; live Supabase/Ollama are opt-in, never in CI. |
| No secrets in git / hot path | `SUPABASE_URL` + `service_role` key in `.env` only (scrubbed); stub/CI path needs no keys. |
| No PII / raw key leakage in audit | Redacted audit event; masking asserted. |
| Answer must not exceed grounding | Generation prompt forbids facts not in retrieved chunks; "answer only from context, else abstain". |

## Out of scope (v0.1.0)
- Multi-turn chat memory, re-ranking, hybrid (BM25+vector) search — candidate later increments.
- Grading the *live* generation's absolute quality as a CI claim (that is A's job + a manual activity).
- Public deployment; paid cloud as a hard dependency; real user data.
