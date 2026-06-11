# ADR-0004: A Chinese, authoritative-sourced, provenance-tracked corpus with a one-command refresh

- **Status:** Accepted — **implemented (v0.3.0)**
- **Date:** 2026-05-31
- **Workflow:** `Portfolio - RAG Knowledge Assistant API` (`workflows/sdk/rag-knowledge-assistant.workflow.js`, deployed as n8n workflow `jZ5Xfml8jbKexYqf`, 27 nodes, active)
- **Related:** [ADR-0001](0001-rag-supabase-pgvector-with-stub-default-and-abstention.md) (vector store + stub default + abstention/citation invariants); [eval-plan.md](../eval-plan.md). Supersedes the original renewable-energy demo corpus.

## Context

v0.1.0–v0.2.0 shipped the retrieval-grounded plumbing against a generic **renewable-energy** demo corpus
(solar / wind / hydro, 8 English chunks). That corpus proved the mechanics but was throwaway: it said
nothing about the portfolio's actual subject (an **AI Product Manager** building eval-first systems), the
chunks had no real provenance, and "answer cites its source" was technically true but pointed at invented
demo facts rather than nameable, linkable authorities.

For a portfolio piece whose whole value proposition is **source attribution + graceful failure**, the
corpus itself is part of the argument. Two questions: (1) **what content** should the knowledge base hold,
and (2) **how is each answer's citation made genuinely authoritative** (a real title + URL), and kept
fresh, without breaking the offline/reproducible eval discipline.

## Decision drivers
- **Domain credibility** — the corpus should be content an AI-PM reviewer recognises as real, current,
  and well-sourced, not filler.
- **Genuine provenance** — every chunk must carry the **authoritative source title + URL + retrieval
  date**, so a citation names a source a human can open and verify (not just an internal `chunkId`).
- **Reproducible offline eval (unchanged from ADR-0001)** — the stub default must stay deterministic,
  offline, key-free; the corpus swap must not introduce network or model dependencies into CI.
- **Bilingual reality** — the AI-PM discipline has a distinct, high-signal **Chinese-language** community
  (俞军, 黄钊/hanniman, 极客时间) alongside the Western canon (Cagan/SVPG, Lenny's, InstitutePM); a
  Chinese corpus both reflects that and exercises the retriever on CJK text (a real engineering wrinkle).
- **Freshness without a scheduler** — sources drift; there must be a low-friction way to re-curate and
  re-embed, with visibility into how stale each chunk is — without yet committing to a scheduled crawler.

## Considered options (corpus)
1. **Keep the renewable demo corpus** — zero work, but off-topic and provenance-free; weak portfolio signal.
2. **English-only AI-PM corpus** — on-topic and well-sourced, but ignores the Chinese AI-PM community and
   leaves the CJK-retrieval capability untested.
3. **Chinese, authoritative-sourced, provenance-tracked AI-PM corpus** (西方PM + 中文社区 + 开源社区), each
   chunk carrying `source` + `url` + `retrievedAt`. **← chosen.**

## Considered options (freshness)
A. **Manual re-edit only** — edit the `.md` files, re-run ingest by hand; no visibility into staleness.
B. **`Refresh-Corpus.ps1`: re-embed + a staleness report, source-allowlist in the header** — one command
   re-reads the `.md` files, prints each chunk's `retrievedAt` age (flagging > 90 days), and re-embeds +
   upserts to Supabase. **← chosen.**
C. **Automated web-fetch refresh** — re-fetch each source URL, diff, and rewrite the provenance
   automatically. **Deferred to Project D** (the scheduled-ingestion / drift-monitor project): it needs a
   scheduler, per-source fetch adapters, and change review that are out of scope for B.

## Decision

**Adopt the Chinese, authoritative-sourced, provenance-tracked AI-PM corpus** (option 3): 13 chunks in
`fixtures/corpus/ai-pm-{role,skills,learning,eval-tools}.md`, organised across three authority lanes —
**西方PM** (Marty Cagan / SVPG, Aman Khan in Lenny's Newsletter, InstitutePM), **中文社区** (俞军《俞军产品
方法论》, 黄钊 hanniman, 刘海丰 / 极客时间), and **开源社区** (Hugging Face LLM course, Ragas / DeepEval). Each
`### chunk:<id>` carries a `> 来源:` line = **citation title + https URL + 检索 date**, which is the single
source of truth for that chunk's provenance.

**Provenance flows end-to-end.** `scripts/Ingest-Corpus.ps1` parses each `> 来源:` line into
`metadata = {chunkId, source, url, retrievedAt}` in Supabase `documents`; the in-workflow stub `CORPUS`
constant carries the same `source` + `url` verbatim. On **both** the stub and live generation paths the
**citations are corpus-grounded** (`{chunkId, source, url, quote}` derived from the retrieved chunks,
never from the model), so a grounded answer names a **real, openable source + link**, and
citation-integrity (every cited `chunkId` ∈ `retrieval.topK`; the quote is a real span of its chunk) holds
by construction (the invariant from ADR-0001 is unchanged — only the corpus behind it became authoritative).

**Output language is Chinese.** The grounded answer is a Chinese extract / a `llama3.2:3b` answer
constrained to 只依据上下文用简体中文作答, and the abstain message is the Chinese sentinel
`信息不足,无法回答` (with `answer:null`, `citations:[]` preserved, so `Assert-CleanAbstain` is unchanged).

**Freshness: `scripts/Refresh-Corpus.ps1`** (option B). It re-reads `fixtures/corpus/*.md`, prints a
**staleness report** (each chunk's `retrievedAt` age in days, flagging any older than `-StaleAfterDays`,
default 90), and — unless `-ReportOnly` — re-embeds + upserts every chunk to Supabase by delegating to
`Ingest-Corpus.ps1` (the single source of truth for the embed/upsert path; idempotent — DELETE each
`chunkId` then re-insert). The script header carries the **source allowlist** (svpg.com,
lennysnewsletter.com, institutepm.com, woshipm.com, time.geekbang.org, docs.feishu.cn, github.com/mlabonne)
that provenance URLs must come from. **Automated web-fetch refresh is explicitly deferred to Project D**
(option C), noted in the script header.

## Consequences

**Positive**
- The "every answer cites its source" claim is now **genuinely authoritative** — citations name a real
  title + URL a reviewer can open, not an invented demo fact.
- The corpus is **on-topic for the portfolio** (AI-PM building eval-first systems) and showcases the
  bilingual reality of the discipline; the CJK content also exercises the retriever's CJK-bigram path.
- Freshness is **visible and one-command** (`npm run refresh:corpus`), with a staleness flag, without
  standing up a scheduler.
- The eval discipline is **unchanged**: the stub default stays deterministic, offline, key-free; the
  Layer-2 golden suite still passes 97 assertions (now in Chinese), and the live path still proves a real
  Chinese grounded answer (citing `source` + `url`) + a clean Chinese abstain (`verify:rag-live`, 15 assertions).

**Negative / trade-offs**
- The stub `CORPUS` constant must stay byte-for-byte in sync with `fixtures/corpus/*.md` (a known
  maintenance tax, mitigated by both deriving from the same chunk text and the refresh script re-reading
  the `.md` files as the source of truth).
- The TF-IDF stub threshold was re-tuned (0.18 → 0.08) for the Chinese corpus + CJK-bigram tokenizer; the
  golden questions were re-pinned to the chunks the deterministic stub actually retrieves.
- Provenance is only as fresh as the last manual re-curation until Project D lands automated web-fetch.

## Implementation note (v0.3.0)

Live: ingested 13 chunks into Supabase `documents` (768-dim, `metadata.url` present); `verify:rag-live`
green — an in-corpus Chinese question (`写好 eval 对 AI 产品经理有多重要?`) returns a Chinese grounded answer
citing `evals-defining-skill` with its real `source` + `url`, `retrievalSource:supabase`; an out-of-corpus
question (`法国的首都是哪里?`) returns a clean Chinese abstain. Project A grades B's abstention as a
black-box SUT via `sutExtract:"abstained"` — `verify:connected-rag` is a reproducible 2/2.
