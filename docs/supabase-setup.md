# Supabase (pgvector) setup — live backend for the RAG Knowledge Assistant

This is the **live, opt-in** vector store for Phase 2b. The stub-default core (v0.1.0) needs none of
this — it stays offline/reproducible. You only do this to wire the live retrieval path.

> **Critical:** the embedding dimension is **768**, because we embed with local Ollama
> `nomic-embed-text-v2-moe` (768-dim). Do NOT use the `1536` from Supabase's OpenAI examples — it will not
> match and inserts/searches will fail.

## What we need at the end
- `SUPABASE_URL` — e.g. `https://abcdwxyz.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` — the **secret** server-side key (NOT the `anon`/publishable key)
Both go into `C:\Dev\Projects\n8n-rag-knowledge-assistant\.env` (gitignored), never committed.

## Step 1 — Create a free project
1. Go to **https://supabase.com** → **Start your project** → sign in (GitHub or email).
2. Create an organization (Free plan) if prompted.
3. **New project**: name `n8n-rag` (anything), set a **database password** (save it somewhere — you
   won't need it for n8n, but you can't see it again), pick the **region closest to you**, Plan =
   **Free**. Click **Create new project** and wait ~2 minutes for provisioning.

## Step 2 — Enable pgvector + create the table & search function
Open **SQL Editor** (left sidebar) → **New query** → paste ALL of this → **Run**:

```sql
-- 1) Enable the vector extension
create extension if not exists vector;

-- 2) Documents table — 768 dims to match Ollama nomic-embed-text-v2-moe
create table if not exists documents (
  id        uuid primary key default gen_random_uuid(),
  content   text,
  metadata  jsonb,
  embedding vector(768)
);

-- 3) Similarity-search RPC used by the n8n Supabase Vector Store node
create or replace function match_documents (
  query_embedding vector(768),
  match_count int default 5,
  filter jsonb default '{}'
) returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
) language plpgsql as $$
begin
  return query
  select
    documents.id,
    documents.content,
    documents.metadata,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where documents.metadata @> filter
  order by documents.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- 4) Lock the table to server-side only: RLS on, NO policies.
--    (n8n's service_role key bypasses RLS; anon/authenticated are denied.)
alter table documents enable row level security;

-- 5) (optional, do AFTER you have rows) speed index for cosine distance
-- create index on documents using ivfflat (embedding vector_cosine_ops) with (lists = 100);
```

You should see "Success. No rows returned."

### Self-check (optional)
```sql
select extname from pg_extension where extname = 'vector';                 -- should return: vector
select relname, relrowsecurity from pg_class where relname = 'documents';  -- documents | true (RLS on)
select count(*) from documents;                                            -- should return: 0
```

## Step 3 — Grab the credentials
1. **Project Settings** (gear, bottom-left) → **API**.
2. Copy **Project URL** → this is `SUPABASE_URL`.
3. Under **Project API keys**, reveal and copy the **`service_role`** key → this is
   `SUPABASE_SERVICE_ROLE_KEY`.
   - If your project shows the newer key UI instead (a **secret** key like `sb_secret_…`), use that
     secret key. Either way it is the **server-side secret** key — never the `anon`/publishable one.

> ⚠️ The `service_role` (secret) key **bypasses Row-Level Security**. It is fine for n8n because n8n
> is server-side, but it must never appear in client code, screenshots, or git. Our `.gitignore`
> excludes `.env`, and `Secret-Patterns.psd1` scans for it on commit.

## Step 4 — Put them in the project `.env`
Create/edit `C:\Dev\Projects\n8n-rag-knowledge-assistant\.env` (copy from `.env.example`):

```
SUPABASE_URL=https://YOUR-PROJECT-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR-SERVICE-ROLE-KEY
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

## Step 5 — Hand off
Tell me when the SQL ran clean and the `.env` is filled. In Phase 2b I will:
1. Pull the local embedding model: `ollama pull nomic-embed-text-v2-moe` (768-dim, local/free; embedded with the `search_query:`/`search_document:` task prefixes).
2. Create the n8n **Supabase API** credential (host = your `SUPABASE_URL`, service_role key) so the
   live nodes can reach it (the workflow runs inside the n8n container).
3. Wire the live gates: `retrievalSource:"supabase"` (embed query via Ollama → `match_documents`
   RPC) and `generationSource:"ollama"` (`llama3.2:3b`), behind per-request switches — the stub stays
   the default so CI stays offline.
4. Ingest `fixtures/corpus/` into the `documents` table, then run a live grounded query end-to-end and
   have **Project A grade B** as a `sutMode:"workflow"` subject.

## Cost / safety notes
- Supabase Free tier is enough for this (a few hundred small chunks). No credit card required.
- Free projects **pause after ~1 week of inactivity** — you just click "Restore" in the dashboard.
- Everything in the hot path that costs money is avoided: embeddings + generation are **local Ollama**
  ($0); Supabase Free = $0.
