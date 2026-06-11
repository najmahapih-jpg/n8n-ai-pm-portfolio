# Swap Guide — Bring Your Own Corpus and Models

This repo ships with a demo corpus (bilingual product-support + AI-PM knowledge) and local models
(Ollama `nomic-embed-text-v2-moe` for embeddings, `llama3.2:3b` for opt-in generation). Both are
**deliberately replaceable**. This guide is the supported path for adopters who want their own
knowledge base, a different embedding model, or a cloud LLM API instead of a local one.

## The contract: what you swap vs what you keep

| Yours to replace | Fixed trust invariants (do NOT loosen) |
|---|---|
| Corpus content (`fixtures/corpus/*.md`) | Citation integrity: every answer cites really-retrieved chunks; fabricated citations fail the run |
| Embedding model + vector store | Threshold-gated abstention: below the floor the system says "not enough information" instead of guessing |
| Generation model (local or API) | Stub-default / live-opt-in: CI runs fully offline and deterministic; live backends are explicit per request |
| Golden questions (`fixtures/golden/*.json`) | Honest source labels: the response reports what ACTUALLY ran (`supabase` / `supabase-fallback-stub` / `ollama-fallback`) |

The invariants are content-agnostic — swapping the corpus or models never requires touching them.

## 1. Swap the knowledge base (5 steps)

1. **Replace the corpus files.** Each chunk in `fixtures/corpus/*.md` follows:

   ```markdown
   ### chunk:your-chunk-id
   One self-contained passage. First sentence should stand alone (the stub generator quotes it).
   > 来源:Your Source Title。检索 2026-01-01
   ```

   Keep chunks self-contained (one fact/topic each, ~50–150 words). Avoid ASCII double quotes
   inside chunk text (the stub mirror embeds it in JS strings). If you serve bilingual users,
   append a one-sentence translation per chunk with no internal `.` `!` `?` before its final
   terminator — the language-aware extract will pick it for same-language answers.

2. **Sync the stub corpus copies.** The deterministic stub retriever carries a pinned snapshot of
   the corpus in `scripts/lib/rag-core.mjs` (`CORPUS`) and in the SDK workflow (two copies:
   'Stub Embed + Retrieve' and the live-degrade fallback in 'Map Supabase Retrieval'). These must
   stay byte-identical to the `.md` text. Use a count-asserting script (assert each chunk text
   appears exactly 1× in the md, 1× in rag-core, 2× in the SDK before writing) rather than hand
   edits; then `npm run compile` and commit the regenerated canonical.

3. **Re-embed into your vector store.** `npm run ingest:corpus` auto-discovers every
   `fixtures/corpus/*.md`, embeds with the `search_document: ` task prefix, and rebuilds the
   `documents` table. Point it at your Supabase via `.env` (`SUPABASE_URL` + key); the deploy step
   injects the RPC URL — the tracked workflow JSON stays secret-free.

4. **Rewrite the goldens for YOUR domain.** Replace `fixtures/golden/*.json` with 3–8 questions
   your corpus can answer (`expectCiteChunkIds` naming your chunk ids) plus at least one
   out-of-domain question with `expectAbstain: true`. The abstain case is not optional — it is the
   proof your assistant refuses to hallucinate. Then run the deployed suite
   (`scripts/Test-RagAssistantWorkflow.ps1`). Deploy BEFORE running it: the suite tests the live
   workflow, not your working tree.

5. **Recalibrate the thresholds.** The abstention floors are per retrieval source (stub TF-IDF
   `0.08`, Supabase cosine `0.35`) and were calibrated for the shipped corpus + embedder. Probe
   with 5–10 in-corpus and 5–10 out-of-corpus queries (`body.threshold` overrides per request),
   look at `retrieval.maxScore` for both groups, and set each floor in the gap between the two
   distributions. If the gap is thin, your chunks are too similar to each other or too short.

## 2. Swap the generation model — local vs cloud API

**Yes, an API works, and the recommended unification is the OpenAI-compatible protocol.** The
request already parameterizes everything (`normalizeRequest` accepts per-request `ollamaChatUrl`,
`genModel`; defaults live in one node), so the swap surface is small:

- **Local (default demo):** Ollama. Zero cost, fully private, reproducible — and Ollama exposes an
  OpenAI-compatible endpoint at `http://localhost:11434/v1` in addition to its native API.
- **Cloud (performance/quality):** any OpenAI-compatible provider — DeepSeek, Moonshot/Kimi,
  Alibaba DashScope (Qwen), Zhipu GLM, OpenAI, Anthropic-via-gateway. Same request schema; you
  change `base URL + API key + model name`, nothing else.

One-time code note: the shipped 'Generate Answer (Ollama)' node speaks Ollama-native `/api/chat`.
To make local↔cloud a pure config swap, convert that one node to the OpenAI-compatible
`/v1/chat/completions` shape (request `{model, messages, temperature}`, parse
`choices[0].message.content`) and point it at Ollama's `/v1` locally or your provider's URL in the
cloud. Everything downstream is unchanged because of the safety invariant below.

**Why the swap is safe by construction:** citations are NEVER parsed from the model — they are
derived from the retrieved chunks before generation. A better (or worse) LLM changes the prose
only; citation integrity and abstention hold for any model. On any API failure the run degrades to
the deterministic extractive answer (`generationSource: 'ollama-fallback'`), so a flaky provider
can never take the assistant down.

**Secrets discipline:** API keys live in the gitignored `.env` only and are attached at deploy
time (credential id / header injection), never in tracked workflow JSON. CI never sets a live
`generationSource`, so pipelines stay offline and free.

## 3. Swap the embedding model

Three coupled facts to respect:

1. **Dimensions are schema.** The `documents` table is `vector(768)` for nomic-v2-moe. A different
   embedder (e.g. `bge-m3` = 1024, `text-embedding-3-small` = 1536) requires recreating the column
   and re-running `ingest:corpus`. Embeddings from different models are never mixable.
2. **Task prefixes are model-specific.** nomic-v2 needs `search_document:` / `search_query:`
   asymmetric prefixes; bge and OpenAI embedders do not. Check your model card and adjust the two
   places that add prefixes (ingest script + the query-embed node).
3. **Thresholds do not transfer.** Every embedder has its own cosine distribution. Redo step 1.5
   after any embedder change. (For reference: nomic-v2 here gives in-corpus ~0.5–0.73 vs
   out-of-corpus ~0.15–0.17 — the 0.35 floor sits in that gap.)

If your users are bilingual, pick a multilingual embedder — cross-lingual retrieval (zh question →
en chunk) is an embedding-model property, not a pipeline feature.

## 4. Recommended operating modes

| Mode | Retrieval | Generation | Use when |
|---|---|---|---|
| Demo / CI (default) | stub TF-IDF | extractive stub | reproducible, offline, free — what CI gates |
| Local live | Supabase + local Ollama | extractive or local LLM | private data, no API budget |
| Hybrid (recommended prod) | Supabase + local embeddings | cloud API LLM | best answer quality; embeddings stay cheap/local; LLM failure degrades to extractive |

The default everywhere stays the stub: anyone can clone, run `npm run verify:static`, and get green
with zero accounts, zero keys, zero GPUs. Live quality is an opt-in layer on top — that ordering is
the portfolio's core reliability discipline and the part adopters should keep.
