import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';

// RAG Knowledge Assistant — stub core (v0.1.0).
//
// Implements the STUB-default retrieval-grounded vertical slice per docs/eval-plan.md: a webhook
// receives a query, a DETERMINISTIC stub embeds it (token-overlap, no model) and retrieves over an
// IN-REPO corpus, a threshold gate routes to either a grounded answer with citations or a CLEAN
// ABSTAIN, citation-integrity is enforced (every cited chunkId must be in retrieval.topK), a redacted
// audit event is emitted, and a structured JSON response is returned. The whole path is offline +
// deterministic so the Layer-2 suite stays reproducible — exactly mirroring the sibling eval-harness's
// stub-default discipline (n8n-llm-eval-harness).
//
// Deferred to Phase 2b (see README "Roadmap" + ADR-0001): LIVE Supabase pgvector retrieval and LIVE
// Ollama embeddings/generation. retrievalSource/generationSource are NORMALIZED here ("supabase"/
// "ollama" accepted) but DEGRADE TO STUB this phase, so a misconfigured request can never hit a live
// backend in CI (mirrors how the harness normalized sutMode/judgeSource before the live nodes existed).
//
// As in the sibling, the validation gate is a visual ifElse (missing query -> 400), and the
// post-validation path is kept LINEAR inside a single chain because the SDK duplicates the entire
// downstream chain inside every branch (so the threshold gate's two leaves each terminate).

const runDemoFromUi = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Run Demo Query From n8n UI',
    position: [160, 40]
  },
  output: [{}]
});

const buildDemoQueryPayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Demo Query Payload',
    position: [480, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0]?.json ?? {};
if (Object.keys(input).length > 0) {
  return [{ json: { ...input, manualExecution: true } }];
}
// Default demo run: an in-corpus query that retrieves chunk:hydro-pumped and returns a grounded,
// cited answer (exercises the answer-with-citation branch). The out-of-corpus abstain branch is
// exercised by the webhook suite; the editor demo shows the headline grounded path.
return [{
  json: {
    manualExecution: true,
    query: 'How does pumped-storage hydropower work?'
  }
}];`
    }
  },
  output: [{
    manualExecution: true,
    query: 'How does pumped-storage hydropower work?'
  }]
});

const receiveQuery = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Receive Query',
    position: [160, 420],
    parameters: {
      httpMethod: 'POST',
      path: 'portfolio/rag-knowledge-assistant',
      authentication: 'none',
      responseMode: 'responseNode',
      options: {
        allowedOrigins: '*'
      }
    }
  }
});

const normalizeRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Request',
    position: [480, 420],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const source = items[0]?.json ?? {};
const body = source.body ?? source;
const entrypoint = source.manualExecution === true || body.manualExecution === true ? 'manual' : 'webhook';
const text = (v) => String(v ?? '').trim();

// REQUIRED: query (a non-empty string). Accept a couple of aliases. A run is valid only with a query.
const query = text(body.query) || text(body.question) || text(body.q);
const hasQuery = query.length > 0;

// OPTIONAL knobs. topK = how many chunks to retrieve (clamped 1..8, the corpus size). threshold =
// the similarity floor below which we ABSTAIN (clamped [0,1], default 0.18 — tuned so the offline
// golden set abstains on out-of-corpus and answers on in-corpus deterministically).
const rawTopK = Number(body.topK);
const topK = Number.isFinite(rawTopK) && rawTopK >= 1 ? Math.min(Math.floor(rawTopK), 8) : 3;
const rawThreshold = Number(body.threshold);
const threshold = Number.isFinite(rawThreshold) && rawThreshold >= 0 ? Math.min(rawThreshold, 1) : 0.18;

// retrievalSource / generationSource: live backends are GATED so a misconfigured request can never
// silently route the offline suite through a live store/model. The DEFAULT is 'stub' (deterministic +
// offline); a request HONOURS the live label only when it explicitly asks for it: retrievalSource:
// 'supabase' (live Supabase pgvector + Ollama query embedding) and generationSource:'ollama' (live
// grounded generation). requestedRetrievalSource / requestedGenerationSource preserve the raw ask.
// CI never sets these, so CI stays on the stub path; and even when set, the live nodes are
// onError-tolerant and DEGRADE TO the deterministic result, so a live miss is never a crash.
// (Mirrors the eval-harness judgeSource:'ollama' IF idiom: normalize -> IF -> live HTTP -> parse/fallback.)
const requestedRetrievalSource = text(body.retrievalSource).toLowerCase();
const requestedGenerationSource = text(body.generationSource).toLowerCase();
const retrievalSource = requestedRetrievalSource === 'supabase' ? 'supabase' : 'stub';
const generationSource = requestedGenerationSource === 'ollama' ? 'ollama' : 'stub';

// Live endpoints are resolved here so a request can override them; defaults are container-local
// (the workflow runs INSIDE the n8n container, which reaches the host via host.docker.internal).
// supabaseRpcUrl is the match_documents RPC; the Supabase API CREDENTIAL (predefined auth on the
// HTTP node) injects apikey + Authorization, so NO secret/URL host ever lives in the workflow JSON.
const ollamaEmbedUrl = text(body.ollamaEmbedUrl) || 'http://host.docker.internal:11434/api/embeddings';
const ollamaChatUrl = text(body.ollamaChatUrl) || 'http://host.docker.internal:11434/api/chat';
const embedModel = text(body.embedModel) || 'nomic-embed-text-v2-moe';
const genModel = text(body.genModel) || 'llama3.2:3b';
// Supabase match_documents RPC URL. The Supabase project host is a SECRET-SCANNED token, so it must
// NEVER live in the tracked workflow JSON: the deploy step substitutes the '__SUPABASE_RPC_URL__'
// placeholder with the real URL in the PUT payload ONLY (the canonical/release snapshots keep the
// placeholder). A request may also override it explicitly. If neither is set, the live retrieval
// yields no rows and the run cleanly abstains (supabase-fallback) — never a crash.
const supabaseRpcUrl = text(body.supabaseRpcUrl) || '__SUPABASE_RPC_URL__';

return [{
  json: {
    request: {
      requestId: text(body.requestId) || ('req_' + Date.now().toString(36)),
      requestedAt: text(body.requestedAt) || new Date().toISOString()
    },
    query,
    validation: { hasQuery },
    runtime: {
      entrypoint,
      topK,
      threshold,
      // 'stub' unless the request explicitly opted into the live backend; the requested* fields
      // record what was asked. The live HTTP nodes degrade to the deterministic result on any error,
      // and the *Source the response reports reflects what ACTUALLY ran (supabase/ollama vs a *-fallback).
      retrievalSource,
      generationSource,
      requestedRetrievalSource: requestedRetrievalSource || 'stub',
      requestedGenerationSource: requestedGenerationSource || 'stub',
      ollamaEmbedUrl,
      ollamaChatUrl,
      embedModel,
      genModel,
      supabaseRpcUrl
    },
    sourcePayloadKeys: Object.keys(body)
  }
}];`
    }
  },
  output: [{
    request: { requestId: 'req_demo' },
    query: 'How does pumped-storage hydropower work?',
    validation: { hasQuery: true },
    runtime: {
      entrypoint: 'manual', topK: 3, threshold: 0.18,
      retrievalSource: 'stub', generationSource: 'stub',
      requestedRetrievalSource: 'stub', requestedGenerationSource: 'stub',
      ollamaEmbedUrl: 'http://host.docker.internal:11434/api/embeddings',
      ollamaChatUrl: 'http://host.docker.internal:11434/api/chat',
      embedModel: 'nomic-embed-text-v2-moe', genModel: 'llama3.2:3b',
      supabaseRpcUrl: '__SUPABASE_RPC_URL__'
    }
  }]
});

const hasQueryGate = ifElse({
  version: 2.3,
  config: {
    name: 'Query Present?',
    position: [800, 420],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'query-present',
          leftValue: expr('{{ $json.validation.hasQuery }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const buildMissingQueryError = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Missing Query Error',
    position: [1120, 640],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
return [{
  json: {
    statusCode: 400,
    runtime: input.runtime,
    response: {
      ok: false,
      error: 'Missing required \\'query\\' (non-empty string)',
      policyVersion: 'rag-knowledge-assistant-v0.2.0'
    }
  }
}];`
    }
  }
});

const manualUiMissingQueryError = ifElse({
  version: 2.3,
  config: {
    name: 'Manual UI Missing Query Error?',
    position: [1440, 640],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'manual-ui-missing-query',
          leftValue: expr('{{ $json.runtime.entrypoint === "manual" }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const returnMissingQueryError = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Return Missing Query Error',
    position: [1760, 760],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json.response }}',
      options: { responseCode: '={{ $json.statusCode }}' }
    }
  }
});

const stubRetrieve = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Stub Embed + Retrieve',
    position: [1120, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
// DETERMINISTIC stub retriever (the default + only implemented path this phase). No model, no vector
// store: it scores the query against an IN-REPO corpus by TOKEN OVERLAP (a set-cosine over content
// words) so a fixed query maps to fixed chunks and an out-of-corpus query maps to (near-)nothing —
// driving the abstain branch deterministically. Phase 2b replaces this with Supabase pgvector +
// Ollama 'nomic-embed-text-v2-moe' behind the retrievalSource gate; the row shape below is the contract the
// live retriever must also produce: retrieval.topK = [{ chunkId, source, score }], maxScore, threshold.
//
// CORPUS (source of truth: fixtures/corpus/*.md). Kept verbatim from those chunks; MUST stay in sync.
const CORPUS = [
  { chunkId: 'solar-pv', source: 'solar.md', text: 'Solar photovoltaic (PV) panels convert sunlight directly into electricity using the photovoltaic effect in semiconductor cells, typically made of silicon. Output is direct current, which an inverter converts to alternating current for the grid.' },
  { chunkId: 'solar-capacity', source: 'solar.md', text: "A solar panel's rated capacity is measured in watts under standard test conditions. Actual output depends on irradiance, temperature, and the angle of the sun, so panels produce the most energy near solar noon on clear days." },
  { chunkId: 'solar-storage', source: 'solar.md', text: 'Because solar generation stops at night, solar systems are often paired with battery storage so that energy captured during the day can be used after sunset. Battery storage also smooths short dips caused by passing clouds.' },
  { chunkId: 'wind-turbine', source: 'wind.md', text: 'A wind turbine generates electricity when moving air turns its blades, which spin a rotor connected through a gearbox to a generator. Most utility turbines have three blades mounted on a horizontal axis.' },
  { chunkId: 'wind-speed', source: 'wind.md', text: 'The power available in wind rises with the cube of wind speed, so doubling the wind speed makes roughly eight times the power available. Turbines are sited where average wind speeds are high and steady, such as ridgelines and offshore.' },
  { chunkId: 'wind-offshore', source: 'wind.md', text: 'Offshore wind farms are built in shallow coastal waters where winds are stronger and more consistent than on land. They are more expensive to install and maintain than onshore farms but produce more energy per turbine.' },
  { chunkId: 'hydro-dam', source: 'hydro.md', text: 'A hydroelectric dam generates electricity by releasing stored water from a reservoir through turbines. The falling water spins the turbines, which drive generators; the higher the dam, the more energy each unit of water can produce.' },
  { chunkId: 'hydro-pumped', source: 'hydro.md', text: 'Pumped-storage hydropower acts like a giant battery: surplus electricity pumps water uphill to an upper reservoir, and the water is later released downhill through turbines to regenerate electricity when demand is high.' }
];

// Minimal stopword set so high-frequency function words don't inflate overlap (which would let an
// out-of-corpus query falsely clear the threshold). Tokens shorter than 3 chars are also dropped.
const STOP = new Set(['the','a','an','and','or','of','to','in','is','are','was','were','be','as','at','by','for','on','it','its','that','this','these','those','with','from','into','your','you','my','our','their','his','her','do','does','how','what','why','when','where','which','who','whom','can','could','would','should','will','also','any','all','so','such','than','then','out','up','down','over']);
function tokenize(s) {
  const set = new Set();
  String(s ?? '').toLowerCase().replace(/[^a-z0-9\\s-]/g, ' ').split(/\\s+/).forEach((w) => {
    const t = w.replace(/^-+|-+$/g, '');
    if (t.length >= 3 && !STOP.has(t)) set.add(t);
  });
  return set;
}

const qTokens = tokenize(input.query);
const scored = CORPUS.map((c) => {
  const cTokens = tokenize(c.text + ' ' + c.chunkId.replace(/-/g, ' '));
  let inter = 0;
  for (const t of qTokens) { if (cTokens.has(t)) inter += 1; }
  // Set-cosine: intersection / sqrt(|q| * |c|). 0 when either side is empty. Rounded for stable JSON.
  const denom = Math.sqrt(qTokens.size * cTokens.size);
  const score = denom > 0 ? Number((inter / denom).toFixed(4)) : 0;
  return { chunkId: c.chunkId, source: c.source, score, text: c.text };
});

// Rank by score desc (ties broken by chunkId for determinism), take top-K.
scored.sort((a, b) => (b.score - a.score) || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0));
const topKFull = scored.slice(0, input.runtime.topK);
const maxScore = topKFull.length > 0 ? topKFull[0].score : 0;
// The public retrieval surface carries id/source/score only (no chunk text) — the grounded-answer
// node still has the text via topKFull. This keeps the response payload tight + the audit redacted.
const topK = topKFull.map((c) => ({ chunkId: c.chunkId, source: c.source, score: c.score }));

return [{
  json: {
    ...input,
    retrieval: {
      topK,
      maxScore,
      threshold: input.runtime.threshold,
      retrievalSource: input.runtime.retrievalSource
    },
    // Internal: the retrieved chunk text, carried for the grounded-answer node only. Stripped before
    // the response/audit are built so chunk bodies never bloat the public payload.
    retrievedChunks: topKFull.map((c) => ({ chunkId: c.chunkId, source: c.source, score: c.score, text: c.text }))
  }
}];`
    }
  }
});

// --- LIVE RETRIEVAL (retrievalSource:"supabase") ----------------------------------------------
// Mirrors the eval-harness judgeSource:"ollama" IF idiom: an IF gate routes to live HTTP nodes whose
// output is parsed + schema-validated, degrading to the deterministic result on any error. The live
// retriever EMBEDS the query via Ollama (nomic-embed-text-v2-moe, 768-dim, "search_query: " prefix)
// then calls the Supabase
// match_documents RPC (pgvector cosine search); the parse node maps the rows to the SAME contract the
// stub produces — retrieval.topK=[{chunkId,source,score}], maxScore, threshold, retrievedChunks(+text)
// — so everything downstream (threshold gate, citation-integrity, response) is source-agnostic.
const retrievalSourceGate = ifElse({
  version: 2.3,
  config: {
    name: 'Retrieval Source = Supabase?',
    position: [1440, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'retrieval-source-supabase',
          leftValue: expr('{{ $json.runtime.retrievalSource === "supabase" }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const embedQuery = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Embed Query (Ollama)',
    position: [1760, 160],
    // onError: a flaky/unreachable embedder must NOT crash the run. The error item flows to the RPC
    // node (which will produce no rows for a missing embedding) -> the mapper engages the empty/
    // fallback retrieval -> a clean abstain. A live miss degrades safely, never throws.
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: '={{ $json.runtime.ollamaEmbedUrl }}',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      // Ollama /api/embeddings -> { embedding: number[768] }. temperature is irrelevant for embeddings.
      // nomic-embed-text-v2-moe is trained with TASK PREFIXES: the QUERY side MUST be prefixed with
      // "search_query: " (the corpus/ingest side uses "search_document: "). This asymmetry materially
      // improves retrieval — it is the intended usage of the v2 model, not optional decoration.
      jsonBody: '={{ ({ model: ($json.runtime.embedModel || "nomic-embed-text-v2-moe"), prompt: ("search_query: " + $json.query) }) }}',
      options: { timeout: 60000 }
    }
  }
});

const callMatchDocuments = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Match Documents (Supabase RPC)',
    position: [2080, 160],
    // onError: an unreachable/erroring Supabase must NOT crash the run -> the mapper sees no rows and
    // engages the empty/fallback retrieval (clean abstain). A live miss degrades safely.
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      // The match_documents RPC over PostgREST. A generic httpHeaderAuth CREDENTIAL (injected at DEPLOY
      // time only) supplies the Supabase 'apikey' header (proven sufficient for the service-role RPC);
      // NO secret/URL host ever lives in the workflow JSON. (The predefined supabaseApi credential type
      // is unreliable on the HTTP Request node in this n8n build — it surfaces ECONNREFUSED — so we use
      // the standard header-auth path, which the spec's intent — "n8n injects the auth header, secret
      // stays out of the JSON" — is fully satisfied by.)
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      // $json here is the Embed Query HTTP response ({ embedding }), which carries no runtime; pull the
      // RPC URL from Normalize. The deploy step has already replaced the placeholder in that node.
      url: '={{ ($("Normalize Request").item.json.runtime.supabaseRpcUrl || "") }}',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      sendHeaders: true,
      // Defensive non-browser User-Agent: sb_secret_ keys are rejected ("Forbidden use of secret API
      // key in browser") under a browser-like UA. The 'apikey' header is added by the header-auth
      // credential; we add UA + a JSON Accept here.
      headerParameters: {
        parameters: [
          { name: 'User-Agent', value: 'n8n' },
          { name: 'Accept', value: 'application/json' }
        ]
      },
      // The embedding comes from the PRIOR node's response ($json.embedding). match_count = topK.
      jsonBody: '={{ ({ query_embedding: ($json.embedding || []), match_count: ($("Normalize Request").item.json.runtime.topK || 3), filter: {} }) }}',
      options: { timeout: 60000 }
    }
  }
});

const mapSupabaseRetrieval = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Map Supabase Retrieval',
    position: [2400, 160],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Map the live Supabase match_documents rows to the SAME retrieval contract the stub produces, so
// the threshold gate / citation-integrity / response downstream are source-agnostic. Recover the full
// run context from Normalize (the live HTTP nodes only carried the embedding/rows through). On NO rows
// (unreachable Supabase, empty table, or a failed query embedding) we degrade to an EMPTY retrieval
// (maxScore 0) -> the threshold gate routes to a clean abstain, and retrievalSource is labelled
// 'supabase-fallback' so the response truthfully reflects that the live store yielded nothing.
const base = $('Normalize Request').item.json;
const rows = Array.isArray(items) ? items.map((it) => it.json).filter((r) => r && (r.id || r.content || typeof r.similarity !== 'undefined')) : [];

// Each row: { id (uuid), content (text), metadata: { chunkId, source }, similarity (float) }.
// chunkId is taken from metadata (the ingest wrote it); fall back to the uuid if ever absent.
const mapped = rows.map((r) => {
  const md = r && typeof r.metadata === 'object' && r.metadata ? r.metadata : {};
  const chunkId = String(md.chunkId || r.id || '').trim();
  const source = String(md.source || 'supabase').trim();
  const score = Number.isFinite(Number(r.similarity)) ? Number(Number(r.similarity).toFixed(4)) : 0;
  return { chunkId, source, score, text: String(r.content || '') };
}).filter((c) => c.chunkId.length > 0);

// Rank by similarity desc (ties by chunkId), clamp to topK (the RPC already limited to match_count).
mapped.sort((a, b) => (b.score - a.score) || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0));
const topKFull = mapped.slice(0, base.runtime.topK);
const maxScore = topKFull.length > 0 ? topKFull[0].score : 0;
const live = topKFull.length > 0;

return [{
  json: {
    ...base,
    runtime: {
      ...base.runtime,
      // Truthful provenance: 'supabase' when the live store returned ranked rows; 'supabase-fallback'
      // when it yielded nothing (so a clean abstain on the live path is visibly a live miss, not a stub).
      retrievalSource: live ? 'supabase' : 'supabase-fallback'
    },
    retrieval: {
      topK: topKFull.map((c) => ({ chunkId: c.chunkId, source: c.source, score: c.score })),
      maxScore,
      threshold: base.runtime.threshold,
      retrievalSource: live ? 'supabase' : 'supabase-fallback'
    },
    retrievedChunks: topKFull.map((c) => ({ chunkId: c.chunkId, source: c.source, score: c.score, text: c.text }))
  }
}];`
    }
  }
});

const thresholdGate = ifElse({
  version: 2.3,
  config: {
    name: 'Retrieval Clears Threshold?',
    position: [2720, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'retrieval-clears-threshold',
          leftValue: expr('{{ $json.retrieval.maxScore >= $json.retrieval.threshold }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const groundedAnswer = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Stub Grounded Answer',
    position: [1760, 180],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
// DETERMINISTIC stub generator (the default + only implemented path this phase). It composes the
// answer ONLY from retrieved chunk text — it has no other knowledge source, so it structurally cannot
// hallucinate beyond the corpus or leak an injected system prompt/secret (the adversarial-injection
// golden case relies on exactly this). Phase 2b swaps this for Ollama 'llama3.2:3b' behind the
// generationSource gate with the prompt 'answer only from the provided context, else abstain'.
//
// Grounding policy: cite the chunks that clear the threshold (the answer stands on them); compose the
// answer by quoting the top chunk's text verbatim (a 'grounded extract'), prefixed with the source.
// citations = [{ chunkId, source, quote }] where quote is a span that EXISTS in the cited chunk (the
// first sentence), so citation-integrity + 'quote exists in chunk' both hold by construction.
const chunks = Array.isArray(input.retrievedChunks) ? input.retrievedChunks : [];
const threshold = input.retrieval.threshold;
// Only chunks at/above threshold are grounding-worthy. The top chunk always qualifies on this branch
// (maxScore >= threshold gated us here); include any other retrieved chunk that also clears it.
const grounding = chunks.filter((c) => c.score >= threshold);
const used = grounding.length > 0 ? grounding : chunks.slice(0, 1);

function firstSentence(t) {
  const s = String(t ?? '').trim();
  const m = s.match(/^[^.!?]*[.!?]/);
  return (m ? m[0] : s).trim();
}

const citations = used.map((c) => ({
  chunkId: c.chunkId,
  source: c.source,
  quote: firstSentence(c.text)
}));

// The answer is a deterministic composition of the grounded quote(s). No external text is introduced.
const answer = used.map((c) => firstSentence(c.text)).join(' ');

return [{
  json: {
    ...input,
    generation: {
      abstained: false,
      answer,
      citations,
      generationSource: input.runtime.generationSource
    }
  }
}];`
    }
  }
});

// --- LIVE GENERATION (generationSource:"ollama") ----------------------------------------------
// Mirrors the eval-harness judgeSource:"ollama" IF idiom on the GROUNDED branch: an IF gate routes to
// a live Ollama /api/chat call grounded ONLY on the retrieved chunks (system prompt: "answer ONLY from
// the provided context; if it is not there, abstain"; temperature 0), then a parse node extracts the
// answer text. CRITICAL SAFETY INVARIANT: the citations are ALWAYS the grounded extracts derived from
// retrievedChunks (chunkId/source/quote=firstSentence) — NEVER parsed from the model — so
// citation-integrity ('every citation.chunkId in retrieval.topK' + 'quote exists in chunk') holds BY
// CONSTRUCTION on the live path too. The model supplies the prose; the corpus supplies the attribution.
// onError-tolerant: an unreachable/empty model degrades to the deterministic stub extract
// (generationSource:'ollama-fallback'), never a crash.
const generationSourceGate = ifElse({
  version: 2.3,
  config: {
    name: 'Generation Source = Ollama?',
    position: [2080, 120],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'generation-source-ollama',
          leftValue: expr('{{ $json.runtime.generationSource === "ollama" }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const buildGenContext = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Grounding Context',
    position: [2400, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
// Assemble the grounding context (the chunks at/above threshold — the same set the stub would cite)
// and stash it on the item so the Ollama HTTP node can read context + query, and the parse node can
// rebuild the grounded citations. We carry the full run context forward unchanged.
function firstSentence(t) {
  const s = String(t ?? '').trim();
  const m = s.match(/^[^.!?]*[.!?]/);
  return (m ? m[0] : s).trim();
}
const chunks = Array.isArray(input.retrievedChunks) ? input.retrievedChunks : [];
const threshold = input.retrieval.threshold;
const grounding = chunks.filter((c) => c.score >= threshold);
const used = grounding.length > 0 ? grounding : chunks.slice(0, 1);
// Context block the model must answer strictly from. Each chunk is labelled with its source + id.
const contextText = used.map((c, i) => '[' + (i + 1) + '] (' + c.source + '#' + c.chunkId + ') ' + String(c.text || '')).join('\\n\\n');
// Grounded citations are pre-computed here from the corpus chunks (NOT from the model) so attribution
// integrity is guaranteed regardless of the model output.
const groundedCitations = used.map((c) => ({ chunkId: c.chunkId, source: c.source, quote: firstSentence(c.text) }));
return [{ json: { ...input, gen: { contextText, groundedCitations } } }];`
    }
  }
});

const callOllamaChat = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Generate Answer (Ollama)',
    position: [2720, 40],
    // onError: a flaky/unreachable model must NOT crash the run. The error item flows to the parse
    // node, which finds no answer text and engages the deterministic FALLBACK (the stub grounded
    // extract), labelling generationSource:'ollama-fallback'. A live miss degrades safely.
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: '={{ $json.runtime.ollamaChatUrl }}',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      // llama3.2:3b, temperature 0 (repeatable), stream:false. The system prompt CONSTRAINS the model
      // to answer strictly from the provided context and to abstain ("I don't have enough information")
      // when the context does not contain the answer — the grounding/abstention policy from the spec.
      jsonBody: '={{ ({ model: ($json.runtime.genModel || "llama3.2:3b"), stream: false, options: { temperature: 0 }, messages: [ { role: "system", content: "You are a retrieval-grounded assistant. Answer the question using ONLY the facts in the provided context. Do not use any outside knowledge. If the answer is not contained in the context, reply exactly with: I do not have enough information. Be concise (1-3 sentences)." }, { role: "user", content: "CONTEXT:\\n" + $json.gen.contextText + "\\n\\nQUESTION:\\n" + $json.query } ] }) }}',
      options: { timeout: 120000 }
    }
  }
});

const parseOllamaAnswer = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse + Ground Answer (Ollama)',
    position: [3040, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// 'items[0]' is the Ollama /api/chat response. Recover the full run context (with gen.* and the
// retrieved chunks) from the 'Build Grounding Context' node. Extract the answer text defensively across
// the shapes n8n may wrap it in. The CITATIONS are the pre-computed grounded citations (corpus-derived,
// guaranteed to map to retrieval.topK) — we NEVER trust the model for attribution. On empty/unreachable
// model output, engage the deterministic FALLBACK: the stub grounded extract, generationSource:
// 'ollama-fallback' (so the response truthfully reflects that live generation did not produce text).
const base = $('Build Grounding Context').item.json;
const http = items[0] ? items[0].json : null;

function readContent(j) {
  if (j == null) return '';
  if (typeof j === 'string') return j;
  if (j.message && typeof j.message.content === 'string') return j.message.content;
  if (typeof j.response === 'string') return j.response;
  return '';
}
function firstSentence(t) {
  const s = String(t ?? '').trim();
  const m = s.match(/^[^.!?]*[.!?]/);
  return (m ? m[0] : s).trim();
}

const groundedCitations = Array.isArray(base.gen && base.gen.groundedCitations) ? base.gen.groundedCitations : [];
let answerText = readContent(http).trim();
let generationSource = 'ollama';

// Fallback: if the model returned nothing usable, deterministically compose the stub grounded extract
// from the same chunks (so the grounded branch ALWAYS yields a cited answer, never an empty one).
if (answerText.length === 0) {
  generationSource = 'ollama-fallback';
  const chunks = Array.isArray(base.retrievedChunks) ? base.retrievedChunks : [];
  const threshold = base.retrieval.threshold;
  const grounding = chunks.filter((c) => c.score >= threshold);
  const used = grounding.length > 0 ? grounding : chunks.slice(0, 1);
  answerText = used.map((c) => firstSentence(c.text)).join(' ');
}

return [{
  json: {
    ...base,
    runtime: { ...base.runtime, generationSource },
    generation: {
      abstained: false,
      answer: answerText,
      // Corpus-grounded citations — guaranteed citation-integrity regardless of the model output.
      citations: groundedCitations,
      generationSource
    }
  }
}];`
    }
  }
});

const cleanAbstain = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Clean Abstain',
    position: [1760, 420],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
// CLEAN ABSTAIN branch: retrieval did not clear the threshold (out-of-corpus, or the corpus genuinely
// lacks the answer). Per the eval-plan abstain rule, we emit NO answer and NO fabricated citation:
//   abstained:true, answer:null, citations:[]. This is the 'I don't have enough information' contract
// — the system's controlled failure mode, asserted as an invariant (Assert-CleanAbstain).
return [{
  json: {
    ...input,
    generation: {
      abstained: true,
      answer: null,
      citations: [],
      generationSource: input.runtime.generationSource
    }
  }
}];`
    }
  }
});

const enforceCitationIntegrity = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Enforce Citation Integrity',
    position: [2080, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
// CITATION-INTEGRITY enforcement (the headline invariant). 'passed' is true iff the response is a
// VALID grounded answer OR a VALID clean abstain:
//   - grounded: every citations[].chunkId MUST appear in retrieval.topK (cite-what-you-were-given),
//     there is >= 1 citation, an answer is present, AND each citation's quote actually exists in its
//     cited chunk's retrieved text (no fabricated span). A citation outside the retrieved set is
//     hallucinated attribution -> passed=false.
//   - abstain: answer == null AND citations == [] (a clean abstain is a correct, passing outcome).
// This is computed deterministically here so the suite can assert it and the response can surface it.
const gen = input.generation;
const retrievedIds = new Set((input.retrieval.topK || []).map((c) => c.chunkId));
const retrievedTextById = {};
for (const c of (input.retrievedChunks || [])) retrievedTextById[c.chunkId] = String(c.text ?? '');

const integrity = { checks: [] };
let passed;
if (gen.abstained === true) {
  const answerNull = gen.answer === null || typeof gen.answer === 'undefined';
  const noCites = Array.isArray(gen.citations) && gen.citations.length === 0;
  integrity.checks.push({ type: 'abstain-shape', ok: answerNull && noCites, detail: 'abstained -> answer null + citations []' });
  passed = answerNull && noCites;
} else {
  const cites = Array.isArray(gen.citations) ? gen.citations : [];
  const hasCite = cites.length > 0;
  const hasAnswer = typeof gen.answer === 'string' && gen.answer.trim().length > 0;
  const allMap = cites.every((c) => retrievedIds.has(c.chunkId));
  const quotesExist = cites.every((c) => {
    const body = retrievedTextById[c.chunkId];
    return typeof body === 'string' && body.length > 0 && typeof c.quote === 'string' && c.quote.length > 0 && body.includes(c.quote);
  });
  integrity.checks.push({ type: 'has-citation', ok: hasCite, detail: '>= 1 citation' });
  integrity.checks.push({ type: 'has-answer', ok: hasAnswer, detail: 'non-empty answer' });
  integrity.checks.push({ type: 'citations-map-to-retrieval', ok: allMap, detail: 'every citation chunkId in retrieval.topK' });
  integrity.checks.push({ type: 'quote-exists-in-chunk', ok: quotesExist, detail: 'every cited quote is a span of its retrieved chunk' });
  passed = hasCite && hasAnswer && allMap && quotesExist;
}
integrity.passed = passed;

return [{ json: { ...input, integrity, passed } }];`
    }
  }
});

const buildAuditEvent = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Create Redacted Audit Event',
    position: [2400, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
// Redacted audit: carries ONLY ids, scores, verdicts and counts — never the raw query text, the
// answer text, the chunk bodies, or the citation quotes (masking invariant asserted by the Layer-2
// suite). Any email-shaped token that somehow reached a surfaced field is masked defensively.
const emailRe = /[^\\s@]+@[^\\s@]+\\.[^\\s@]+/g;
const runSeed = input.request.requestId + '|' + input.request.requestedAt;
const gen = input.generation;

return [{
  json: {
    ...input,
    auditEvent: {
      auditEventId: 'audit_' + hash(runSeed),
      requestId: input.request.requestId,
      retrievalSource: input.runtime.retrievalSource,
      generationSource: input.runtime.generationSource,
      requestedRetrievalSource: input.runtime.requestedRetrievalSource,
      requestedGenerationSource: input.runtime.requestedGenerationSource,
      abstained: gen.abstained === true,
      passed: input.passed === true,
      // ids + scores only — no chunk text, no quotes.
      topK: (input.retrieval.topK || []).map((c) => ({ chunkId: c.chunkId, source: c.source, score: c.score })),
      maxScore: input.retrieval.maxScore,
      threshold: input.retrieval.threshold,
      citedChunkIds: Array.isArray(gen.citations) ? gen.citations.map((c) => c.chunkId) : [],
      citationCount: Array.isArray(gen.citations) ? gen.citations.length : 0,
      // Query is NOT stored raw; only its length + a stable hash, so audit correlation is possible
      // without retaining user text (and any stray email token is masked before hashing/length).
      queryLength: String(input.query ?? '').length,
      queryHash: 'q_' + hash(String(input.query ?? '').replace(emailRe, (e) => { const p = e.split('@'); return (p[0] ? p[0][0] + '***' : '***') + '@' + (p[1] ?? ''); })),
      policyVersion: 'rag-knowledge-assistant-v0.2.0',
      createdAt: new Date().toISOString()
    }
  }
}];`
    }
  }
});

const buildResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Response',
    position: [2720, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const gen = input.generation;
// Structured JSON response — the scorer contract shape from docs/eval-plan.md. retrieval.topK is the
// id/source/score surface; retrievedChunks (internal chunk text) is deliberately NOT included.
return [{
  json: {
    statusCode: 200,
    runtime: input.runtime,
    response: {
      ok: true,
      requestId: input.request.requestId,
      abstained: gen.abstained === true,
      answer: gen.abstained === true ? null : gen.answer,
      citations: Array.isArray(gen.citations) ? gen.citations : [],
      retrieval: {
        topK: input.retrieval.topK,
        maxScore: input.retrieval.maxScore,
        threshold: input.retrieval.threshold
      },
      retrievalSource: input.runtime.retrievalSource,
      generationSource: input.runtime.generationSource,
      passed: input.passed === true,
      integrity: input.integrity,
      auditEventId: input.auditEvent.auditEventId,
      processedAt: new Date().toISOString(),
      policyVersion: 'rag-knowledge-assistant-v0.2.0'
    },
    auditEvent: input.auditEvent
  }
}];`
    }
  }
});

const manualUiExecution = ifElse({
  version: 2.3,
  config: {
    name: 'Manual UI Execution?',
    position: [3040, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'manual-ui-execution',
          leftValue: expr('{{ $json.runtime.entrypoint === "manual" }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const showUiExecutionResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Show UI Execution Result',
    position: [3360, 180],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
return [{
  json: {
    ok: true,
    executionMode: 'manual-ui',
    statusCode: input.statusCode,
    response: input.response,
    auditEvent: input.auditEvent ?? null,
    note: 'Terminal result for n8n editor Execute Workflow. Webhook executions use Return Response instead.'
  }
}];`
    }
  },
  output: [{
    ok: true,
    executionMode: 'manual-ui',
    response: { abstained: false, passed: true }
  }]
});

const returnResponse = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Return Response',
    position: [3360, 420],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json.response }}',
      options: { responseCode: '={{ $json.statusCode }}' }
    }
  }
});

const overview = sticky(
  '## RAG Knowledge Assistant v0.2.0 (stub default + LIVE Supabase/Ollama, opt-in)\\nLocal retrieval-grounded API. A webhook receives a query, then a RETRIEVAL-SOURCE gate routes: retrievalSource:"supabase" EMBEDS the query via Ollama nomic-embed-text-v2-moe (768-dim, "search_query: " prefix) and calls the Supabase match_documents pgvector RPC (predefined Supabase auth, User-Agent n8n); otherwise the DEFAULT deterministic STUB retriever (token-overlap, no model) searches the IN-REPO corpus (fixtures/corpus/*). Both produce the same retrieval contract (topK=[{chunkId,source,score}], maxScore, threshold). A THRESHOLD GATE then routes to a GROUNDED ANSWER or a CLEAN ABSTAIN (abstained:true, answer:null, citations:[] — the controlled failure mode). On the grounded branch a GENERATION-SOURCE gate routes: generationSource:"ollama" calls Ollama llama3.2:3b (temperature 0, "answer ONLY from the provided context; else abstain") for the prose; otherwise the DEFAULT stub composes a grounded extract. CRITICAL: on BOTH generation paths the CITATIONS are corpus-grounded (chunkId/source/quote derived from the retrieved chunks, never from the model), so CITATION-INTEGRITY (every cited chunkId in retrieval.topK; the quote is a real span of its chunk) holds by construction and is ENFORCED deterministically (a cited chunk outside the retrieved set -> passed=false). Live nodes are onError-tolerant and DEGRADE to the deterministic result (retrievalSource:"supabase-fallback" / generationSource:"ollama-fallback"); the response reports what ACTUALLY ran. A redacted audit event (ids + scores + verdicts only — no raw query/answer/chunk text) precedes a structured JSON response per the eval-plan scorer contract (abstained, answer, citations, retrieval{topK,maxScore,threshold}, retrievalSource, generationSource, passed, policyVersion rag-knowledge-assistant-v0.2.0). The stub is the DEFAULT everywhere CI touches, so verify:static/json/live stay OFFLINE + deterministic; the live path is opt-in per request (verify:rag-live). Manual trigger runs an editor demo; the webhook serves the API. Mirrors the sibling eval-harness judgeSource:"ollama" live-gate idiom.',
  [runDemoFromUi, buildDemoQueryPayload, receiveQuery, normalizeRequest, hasQueryGate, retrievalSourceGate, embedQuery, callMatchDocuments, mapSupabaseRetrieval, stubRetrieve, thresholdGate, generationSourceGate, buildGenContext, callOllamaChat, parseOllamaAnswer, groundedAnswer, cleanAbstain, enforceCitationIntegrity, buildAuditEvent, buildResponse, manualUiExecution],
  { color: 4 }
);

export default workflow('rag-knowledge-assistant', 'Portfolio - RAG Knowledge Assistant API')
  .add(overview)
  .add(runDemoFromUi)
  .to(buildDemoQueryPayload)
  .to(normalizeRequest)
  .to(hasQueryGate
    .onTrue(
      // RETRIEVAL-SOURCE gate. onTrue (supabase): embed the query via Ollama -> Supabase
      // match_documents RPC -> map rows to the retrieval contract. onFalse (stub): the deterministic
      // in-repo retriever. Both branches CONVERGE on the THRESHOLD GATE by node identity, so the
      // threshold -> generation -> citation-integrity -> audit -> response -> manual-UI tail is
      // defined exactly once (below, on the supabase/onTrue branch).
      retrievalSourceGate
        .onTrue(
          embedQuery
            .to(callMatchDocuments)
            .to(mapSupabaseRetrieval)
            .to(thresholdGate
              .onTrue(
                // GENERATION-SOURCE gate. onTrue (ollama): grounded live generation. onFalse (stub):
                // deterministic grounded extract. Both CONVERGE on 'Enforce Citation Integrity'.
                generationSourceGate
                  .onTrue(
                    buildGenContext
                      .to(callOllamaChat)
                      .to(parseOllamaAnswer)
                      .to(enforceCitationIntegrity)
                      .to(buildAuditEvent)
                      .to(buildResponse)
                      .to(manualUiExecution
                        .onTrue(showUiExecutionResult)
                        .onFalse(returnResponse)
                      )
                  )
                  .onFalse(
                    groundedAnswer
                      .to(enforceCitationIntegrity)
                  )
              )
              .onFalse(
                cleanAbstain
                  .to(enforceCitationIntegrity)
              )
            )
        )
        .onFalse(
          stubRetrieve
            .to(thresholdGate)
        )
    )
    .onFalse(
      buildMissingQueryError
        .to(manualUiMissingQueryError
          .onTrue(showUiExecutionResult)
          .onFalse(returnMissingQueryError)
        )
    )
  )
  .add(receiveQuery)
  .to(normalizeRequest);
