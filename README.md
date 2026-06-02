# n8n RAG Knowledge Assistant

Workflow-as-Code portfolio project **B**: a local n8n API that answers questions **grounded in a fixed
corpus**, where **every answer cites its retrieved source** and the system **abstains ("I don't have
enough information") instead of hallucinating** when retrieval comes up empty.

This is the portfolio's first **retrieval-grounded** workflow — the most in-demand 2026 AI-PM
capability — and it is built to be **graded by Project A** (the LLM eval harness) as a black-box
subject-under-test, turning the portfolio into a connected system.

> **Status: v0.3.0 — live (stub-default core + opt-in Supabase pgvector / Ollama, deployed & verified)**
> over a **Chinese, authoritative-sourced, provenance-tracked "AI 时代产品经理" knowledge base**.
> The eval-first front matter (requirement spec, eval plan, ADR-0001) was authored **before any node**;
> the deterministic stub core shipped in v0.1.0; v0.2.0 wired the **live retrieval-grounded path**
> (Supabase pgvector `match_documents` + Ollama `nomic-embed-text-v2-moe` embeddings + `llama3.2:3b` grounded
> generation) behind per-request gates; **v0.3.0 swaps the corpus to a 13-chunk Chinese AI-PM knowledge
> base** (三大权威来源: 西方PM / 中文社区 / 开源社区; every chunk carries `source` + `url` + `retrievedAt`
> provenance, refreshable via `scripts/Refresh-Corpus.ps1`) with Chinese grounded answers + a Chinese
> abstain message. The stub remains the default everywhere CI touches; the live path is proven end-to-end
> through the deployed webhook (`npm run verify:rag-live`).

## What it does

```
ingest corpus -> chunk -> embed -> upsert to vector store
(per query) embed query -> similarity search (top-k + threshold)
   -> if maxScore >= threshold : ground generation ONLY on retrieved chunks -> answer + citations
   -> else                     : ABSTAIN  (answer=null, citations=[], "insufficient information")
```

Two behaviours are **tested invariants**, not best-effort:
- **Citation integrity** — every answer carries ≥1 citation, and every cited `chunkId` must be one that
  was actually retrieved for that query (cite-what-you-weren't-given → fail).
- **Abstention threshold** — `abstained` ⟺ retrieval below threshold; on abstain, no answer and no
  fabricated citation.

## Backend & reproducibility (see ADR-0001)

| Layer | Default (CI / reproducible) | Live (opt-in, per request) |
|---|---|---|
| Corpus | **13 Chinese "AI 时代产品经理" chunks** (`fixtures/corpus/ai-pm-*.md`) across 西方PM / 中文社区 / 开源社区, each carrying `source` + `url` + `retrievedAt` | same chunks, embedded into Supabase `documents` (`metadata={chunkId,source,url,retrievedAt}`) — refreshable via `scripts/Refresh-Corpus.ps1` |
| Vector store | deterministic **stub retriever** (TF-IDF cosine over CJK bigrams + ASCII tokens, in-repo corpus) | **Supabase (pgvector)** — free tier, n8n-native node |
| Embeddings | stub vectors | **Ollama `nomic-embed-text-v2-moe`** (local, free; `search_query:`/`search_document:` task prefixes) |
| Generation | deterministic **stub generator** (Chinese grounded extract) | **Ollama `llama3.2:3b`** (local, free; 只依据上下文用简体中文作答) |

The default everywhere CI touches is stub → offline, reproducible, key-free. Live Supabase + Ollama
are opt-in **per request** (`retrievalSource:"supabase"`, `generationSource:"ollama"`) and routed behind
IF gates that mirror Project A's `judgeSource:"ollama"` live-gate idiom; the live nodes are
`onError`-tolerant and **degrade to the deterministic stub** (`retrievalSource:"supabase-fallback"` /
`generationSource:"ollama-fallback"`) so a backend miss is a clean degrade, never a crash. The Supabase
`SUPABASE_URL` + `service_role` key live in `.env` only (scrubbed, never git) and **never enter the
workflow JSON**: the deploy step substitutes the RPC URL and attaches an n8n header-auth credential by
id into the PUT payload only, so the tracked canonical/release stay secret-free (`verify:static` secret
scan enforces this).

## Why this project (AI-PM framing)

RAG is the most in-demand 2026 capability, but the signal hiring managers test is **source
attribution** and **graceful failure on a retrieval miss** — both enforced and eval'd here. It adds a
new technical axis (retrieval/embeddings/vector store) the rest of the portfolio lacks, and the
**connected-projects** story: A grades B.

## Honest eval framing

Two layers, not conflated (see [docs/eval-plan.md](docs/eval-plan.md)): **Layer 2** grades the
plumbing + the citation-integrity / clean-abstain invariants against a deterministic stub (offline,
reproducible); **Layer 1** (live retrieval recall + generation faithfulness) is a separate, manual,
honestly-labelled activity — and the job of Project A.

## Docs & artifacts
- [fixtures/requests/rag-knowledge-assistant.md](fixtures/requests/rag-knowledge-assistant.md) — requirement spec (Problem → Solution → Impact + Control).
- [docs/eval-plan.md](docs/eval-plan.md) — two-layer recursion, scorer contract, golden dataset, citation/abstain assertion map.
- [docs/adr/0001-rag-supabase-pgvector-with-stub-default-and-abstention.md](docs/adr/0001-rag-supabase-pgvector-with-stub-default-and-abstention.md) — vector-store choice + stub default + abstention/citation invariants.
- [docs/adr/0004-authoritative-sourced-corpus-and-refresh.md](docs/adr/0004-authoritative-sourced-corpus-and-refresh.md) — Chinese authoritative-sourced, provenance-tracked corpus + `Refresh-Corpus.ps1` (with deferred automated web-fetch).

## Portfolio roadmap

| # | Project | Status | Different-from-current axis |
|---|---|---|---|
| A | LLM Eval Harness (`../n8n-llm-eval-harness`) | **done — v0.6.0, live (grades B as a black-box SUT via `sutExtract:"abstained"`)** | meta-level: grades AI quality |
| **B** | **RAG Knowledge Assistant (this repo)** | **done — v0.3.0, live (zh AI-PM corpus, stub default + opt-in Supabase/Ollama), deployed & verified; graded by A** | retrieval grounding (new tech stack) |
| C | Autonomous Research Agent | planned | agentic / stateful |
| D | Scheduled Insight Digest / Drift Monitor | planned | scheduled batch + monitoring |

## Verify matrix

| Command | Scope | CI? | What it proves |
|---|---|---|---|
| `npm run verify:static` | parse + tracked-JSON + **secret scan** + registry freshness + node floor | yes | source is well-formed and **no Supabase key/host leaks** into tracked files |
| `npm run verify:json` | canonical + release JSON shape, node floor (27) | yes | the committed workflow snapshots are valid n8n graphs |
| `npm run verify:live` | deploy SDK → live n8n, then the **offline stub** Layer-2 suite (97 assertions, 6 golden cases) | yes | ingest→retrieve→ground→cite→**abstain** plumbing + **citation-integrity** + **clean-abstain**, deterministically (stub default) |
| `npm run verify:rag-live` | **LIVE** Supabase pgvector + Ollama through the deployed webhook (15 assertions) | **no** (opt-in, Layer-1) | the real retrieval-grounded path answers an in-corpus **Chinese** question with a real citation (**source + url**) and abstains cleanly out-of-corpus (Chinese abstain) |
| `npm run refresh:corpus` | re-embed `fixtures/corpus/*.md` → Supabase + a **staleness report** (each chunk's `retrievedAt` age, flag > 90d) | **no** (ops) | the live corpus is one-command-refreshable from the allowlisted sources; the stub stays a pinned snapshot |

The stub is the default on every CI path, so `verify:static` / `verify:json` / `verify:live` stay
**offline + deterministic + key-free** even though the live nodes are deployed.

## Setup you need to do (live path only — does NOT block the stub core)
1. Create a free **Supabase** project; in the SQL editor run `create extension if not exists vector;`,
   then create the `documents(id uuid, content text, metadata jsonb, embedding vector(768))` table and
   the `match_documents(query_embedding vector(768), match_count int, filter jsonb)` RPC
   (see [docs/supabase-setup.md](docs/supabase-setup.md)).
2. Put `SUPABASE_URL` and the `service_role` (`sb_secret_…`) key in local `.env` (never committed).
   **GOTCHA:** `sb_secret_` keys are rejected ("Forbidden use of secret API key in browser") under a
   browser-like User-Agent — every direct Supabase call sets a non-browser `User-Agent: n8n`.
3. Pull the local Ollama embedding model: `ollama pull nomic-embed-text-v2-moe` (768-dim; `llama3.2:3b` for generation).
4. Create the n8n header-auth credential carrying the Supabase `apikey` header (its id is referenced by
   the deploy step, never written to tracked files) and ingest the corpus: `npm run ingest:corpus`
   (embeds each `fixtures/corpus/*.md` chunk via Ollama and upserts it into Supabase `documents` with
   `metadata={chunkId,source,url,retrievedAt}`). Later, `npm run refresh:corpus` re-embeds + prints a
   staleness report; automated web-fetch refresh of the source URLs is deferred to Project D (see ADR-0004).

## Current Status
- [x] Project skeleton created (mirrors the proven harness).
- [x] Eval-first front matter: requirement spec, eval plan, ADR-0001.
- [x] PowerShell toolchain + package.json + CI + hooks + secret patterns (adapted from siblings).
- [x] SDK workflow: stub retriever + stub generator core (offline) — ingest/chunk/retrieve/ground/cite/abstain.
- [x] Golden corpus + question set + Layer-2 behavioural suite (97 assertions; citation-integrity + clean-abstain), in Chinese.
- [x] Live wiring: Supabase pgvector retrieval + Ollama embeddings/generation behind per-request gates (v0.2.0).
- [x] v0.3.0 corpus: 13 Chinese "AI 时代产品经理" chunks, authoritative-sourced + provenance-tracked (`source`/`url`/`retrievedAt`); Chinese grounded answers + Chinese abstain.
- [x] Deployed to local n8n via REST API (workflow `jZ5Xfml8jbKexYqf`, 27 nodes, active); canonical/release v0.3.0 snapshots refreshed.
- [x] Corpus ingested into Supabase `documents` (13 chunks, 768-dim, `metadata.url`); live path verified end-to-end (`verify:rag-live`, 15 assertions; Chinese grounded answer + Chinese abstain).
- [x] `scripts/Refresh-Corpus.ps1` re-embeds the corpus + prints a staleness report (retrievedAt age, flag > 90d); automated web-fetch refresh deferred to Project D.
- [x] Project A grades B as a black-box SUT — A's configurable `sutExtract:"abstained"` (ADR-0005 in A)
  reads B's top-level `abstained` flag and exact-matches it; B's deterministic stub answers in-corpus and
  abstains out-of-corpus, so A's `verify:connected-rag` is a reproducible **2/2 (passRate 1.0)**.

## Open Source Health

This repository includes the baseline files needed for public collaboration:

- License: Apache-2.0 (`LICENSE`).
- Contributions: `CONTRIBUTING.md`.
- Security policy: `SECURITY.md`.
- Security and privacy boundaries: `docs/security-boundaries.md`.
- Workflow contract: `docs/workflow-contract.md`.
- Conduct: `CODE_OF_CONDUCT.md`.
- GitHub templates: `.github/ISSUE_TEMPLATE/` and `.github/pull_request_template.md`.

Before publishing or accepting contributions, run `npm run verify:static`, `npm run verify:json`, and `npm run smoke`; run `npm run verify:live` only when local n8n and required credentials are configured.
