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
// Default demo run: an in-corpus zh query that retrieves chunk:three-skill-clusters and returns a
// grounded, cited Chinese answer (exercises the answer-with-citation branch). The out-of-corpus abstain
// branch is exercised by the webhook suite; the editor demo shows the headline grounded path.
return [{
  json: {
    manualExecution: true,
    query: '转型 AI 产品经理要补齐哪三大技能簇?'
  }
}];`
    }
  },
  output: [{
    manualExecution: true,
    query: '转型 AI 产品经理要补齐哪三大技能簇?'
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

// OPTIONAL knobs. topK = how many chunks to retrieve (clamped 1..8). threshold = the similarity floor
// below which we ABSTAIN. There is NO single global default because the two retrieval methods score on
// DIFFERENT scales: the stub's TF-IDF cosine puts in-corpus at ~0.2-0.4 and out-of-corpus at ~0 (a 0.08
// floor separates them), while the live Supabase nomic-embed-text-v2-moe cosine puts in-corpus at
// ~0.63-0.68 and out-of-corpus at ~0.15-0.17 (a 0.08 floor would NEVER abstain — out-of-corpus sits
// above it). So the abstention floor is a PER-SOURCE default applied downstream (stub 0.08, supabase
// 0.35), and we thread thresholdOverride = the EXPLICIT per-request value (clamped [0,1]) or null when
// the request did not set one. Each retrieval branch then uses thresholdOverride ?? <its source default>.
const rawTopK = Number(body.topK);
const topK = Number.isFinite(rawTopK) && rawTopK >= 1 ? Math.min(Math.floor(rawTopK), 8) : 3;
const rawThreshold = Number(body.threshold);
const thresholdOverride = Number.isFinite(rawThreshold) && rawThreshold >= 0 ? Math.min(rawThreshold, 1) : null;

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
      // thresholdOverride = the EXPLICIT per-request abstention floor, or null. Each retrieval branch
      // resolves the effective threshold as thresholdOverride ?? <its per-source default> (stub 0.08,
      // supabase 0.35) and writes it onto retrieval.threshold, which is what every downstream node reads.
      thresholdOverride,
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
    query: '转型 AI 产品经理要补齐哪三大技能簇?',
    validation: { hasQuery: true },
    runtime: {
      entrypoint: 'manual', topK: 3, thresholdOverride: null,
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
      policyVersion: 'rag-knowledge-assistant-v0.3.0'
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
// store: it scores the query against an IN-REPO corpus with a TF-IDF COSINE over content terms
// (CJK character bigrams + ASCII word tokens, smoothed IDF, L2-normalized) so a fixed query maps to
// fixed chunks and an out-of-corpus query maps to (near-)nothing — driving the abstain branch
// deterministically. TF-IDF (vs raw token overlap) down-weights the ubiquitous "AI 产品经理" boilerplate
// and normalizes for chunk length, which the short generic chunks would otherwise exploit; the corpus is
// Chinese (zh) so an English/whitespace tokenizer would tokenize to nothing — hence CJK bigrams. Phase 2b
// replaces this with Supabase pgvector + Ollama 'nomic-embed-text-v2-moe' behind the retrievalSource gate;
// the row shape below is the contract the live retriever must also produce:
// retrieval.topK = [{ chunkId, source, score }], maxScore, threshold. Each corpus entry also carries the
// authoritative provenance (source = citation title, url) so the citation can name the real source + link.
//
// CORPUS (source of truth: fixtures/corpus/*.md — the 13 Chinese "AI 时代产品经理" chunks). Kept VERBATIM
// (byte-for-byte) from those chunks so the grounded quote matches; MUST stay in sync; carries source + url.
const CORPUS = [
  { chunkId: "rag-eval-faithfulness", source: "Hugging Face LLM/Agents Course(mlabonne 等)与 Ragas / DeepEval 开源评测框架", url: "https://github.com/mlabonne/llm-course", text: "开源社区给出了评测 RAG 的标准做法:要分别评检索与生成两段——检索看 context precision / recall(召回到的上下文准不准、全不全),生成看 faithfulness(忠实度:答案是否扎根于检索到的上下文)与 answer relevancy(答案相关性);这些可用开源工具 Ragas / DeepEval 简化。RAG 本身则是\\"无需微调即可扩展模型知识\\"的常用手段。" },
  { chunkId: "trust-reliability", source: "Lenny Rachitsky 等 — Lenny's Newsletter《Why most AI products fail》(2026)", url: "https://www.lennysnewsletter.com/p/what-openai-and-google-engineers-learned", text: "在 OpenAI、Google、Amazon 等公司 50+ 个企业级 AI 部署中,一条反复出现的教训是:\\"obsessing about customer trust and reliability is an underrated driver of successful AI products\\"(对客户信任与可靠性的执着,是 AI 产品成功被严重低估的驱动力)。评测必要但非万灵药——为可靠性与\\"优雅失败\\"路径而设计,才是把 demo 变成用户敢依赖的产品的关键。" },
  { chunkId: "how-to-learn", source: "InstitutePM《How to Become an AI Product Manager in 2026》(2026)", url: "https://www.institutepm.com/knowledge-hub/how-to-become-an-ai-product-manager-2026", text: "对 PM 而言,技术学习的\\"正确深度\\"是 \\"competent enough to make decisions and pressure-test your engineers\\"(足以做决策、并能向工程师施压检验)——既不必推导反向传播,也不能只刷一张证书。推荐路径:读 Anthropic 与 OpenAI 的 prompt 工程指南,然后 \\"build a RAG app, a tool-calling agent, and a fine-tuned classifier\\"(亲手做一个 RAG 应用、一个工具调用 agent、一个微调分类器,哪怕都很小)——三个一起做才会逼你学会其中的取舍;并把一套 eval 框架端到端做透。" },
  { chunkId: "portfolio-proof", source: "InstitutePM《How to Become an AI Product Manager in 2026》(2026)", url: "https://www.institutepm.com/knowledge-hub/how-to-become-an-ai-product-manager-2026", text: "转型最高杠杆的一步,是一份能证明\\"你能交付、并能就 AI 产品做推理\\"的作品集——因为招聘官\\"在简历上花 90 秒,在一份强 case study 上花 8 分钟\\"。能让你进面试的三件套:一个上线的产品(哪怕是 side project,有 URL 或仓库)、一篇带真实数字的 eval 驱动 case study、一套可演示的 eval 套件。" },
  { chunkId: "model-as-coach", source: "Marty Cagan — Silicon Valley Product Group《Product Coaching and AI》(2026)", url: "https://www.svpg.com/product-coaching-and-ai/", text: "SVPG 现在建议产品人把基础模型本身当作\\"个人产品教练\\"来加速培养 product sense——用你的目标、约束与战略背景把它配置好。在他们的表述里,\\"prompt engineering has evolved into context engineering\\"(提示工程已演进为上下文工程);一个配置得当的模型,提供的产品教练水准可以不输给多数管理者,而且是持续在线、而非每周一次的 1:1。" },
  { chunkId: "yujun-growth", source: "俞军 —《俞军产品方法论》(中信出版社,2019);《深度对话俞军》", url: "https://docs.feishu.cn/article/wiki/EzRKwB8NDi2gd0keAhhce6hFn8g", text: "俞军给出一条本土化的成长路径:产品经理的能力按\\"为企业创造价值的能力\\"分五级——可行性 → 创造 → 权衡 → 变迁 → 方法论。第一级\\"可行性\\"要求对用户价值、技术可行性、商业可行性有基本判断力;往上依次是为问题找最优解(创造)、跳出单点做全局取舍(权衡)、预判世事变迁(变迁),直到输出成体系的方法论。" },
  { chunkId: "pm-more-essential", source: "Marty Cagan — Silicon Valley Product Group《AI Product Management》(2024)", url: "https://www.svpg.com/ai-product-management/", text: "Marty Cagan(SVPG 创始人、《INSPIRED》作者)认为,几乎所有产品经理都将需要成为 AI 产品经理;且与\\"AI 让 PM 变多余\\"的流行担忧相反——他说 \\"the PM role becomes more essential but also more difficult with generative AI-powered products, not less\\"(在生成式 AI 产品中,PM 角色变得更关键、也更难,而不是更不重要)。AI 素养只是又一个例证:产品经理需要扎实的技术基础。" },
  { chunkId: "genuine-value", source: "Marty Cagan — Silicon Valley Product Group《AI Product Management》(2024)", url: "https://www.svpg.com/ai-product-management/", text: "按 SVPG 的说法,AI 产品经理的首要职责,是确保 AI 功能交付 \\"genuine, incremental value\\"(真实、增量的价值)——以明显优于现有方案的方式解决真问题。要极力避免的失败模式,是做出 \\"AI in name only\\" 的产品:为营销或竞争跟风而加 AI,而非为价值。" },
  { chunkId: "yujun-user-value", source: "俞军 —《俞军产品方法论》(中信出版社,2019);亦见《深度对话俞军》", url: "https://docs.feishu.cn/article/wiki/EzRKwB8NDi2gd0keAhhce6hFn8g", text: "俞军(《俞军产品方法论》作者、前百度产品副总裁)给出一个根基性定义:\\"产品经理是一个用科学方法研究复杂且非科学的人性,并转化为可执行的商业方案的实践验证学科。\\" 在他看来,产品经理的工作是找到\\"真的用户价值\\";一个具备人文逻辑的产品经理,最重要的是拥有批判性思维,其次是愿意并能够理解人和世界。" },
  { chunkId: "evals-defining-skill", source: "Aman Khan — Lenny's Newsletter《Beyond vibe checks: A PM's complete guide to evals》(2025)", url: "https://www.lennysnewsletter.com/p/beyond-vibe-checks-a-pms-complete", text: "写好评测(eval)正在成为做 AI 产品的决定性技能。Aman Khan(Arize AI 产品总监,与 Andrew Ng 合作开设 eval 课程)直言:写好 eval 的能力 \\"is rapidly becoming the defining skill for AI PMs in 2025 and beyond\\"(正迅速成为 2025 年及以后 AI 产品经理的决定性技能)。评测像传统软件的回归测试一样,为非确定性系统定义\\"什么叫好\\",让你能度量每次 prompt/模型/检索改动的影响,而不是靠\\"感觉\\"(vibe check)。" },
  { chunkId: "three-skill-clusters", source: "InstitutePM《How to Become an AI Product Manager in 2026》(2026)", url: "https://www.institutepm.com/knowledge-hub/how-to-become-an-ai-product-manager-2026", text: "转型 AI 产品经理要同时补齐三大技能簇:技术素养(足以做 eval/模型/成本决策——看得懂模型卡、算得清延迟预算、能用代码跑 eval)、适配 AI 不确定性的产品功力(写 eval 驱动的 spec 而非功能 spec,指标树看质量分布而非只看均值)、以及 AI 专属判断(模型选型、失败态 UX、成本-质量-延迟三角)。其中\\"判断\\"这一簇被认为\\"最难伪装,也是多数候选人最被低估的一项\\"。" },
  { chunkId: "hanniman-humanity", source: "黄钊 hanniman —《AI产品经理能力模型的重点素质:人文素养和灵魂境界》,人人都是产品经理 (2022);摘自《AI产品经理的实操手册》", url: "https://www.woshipm.com/pmd/5396083.html", text: "在 AI 产品经理的能力模型里,黄钊(hanniman,前腾讯 PM、\\"AI产品经理大本营\\"创始人)提出一个中文社区独有的关键差异点:\\"人文素养和灵魂境界\\"。他认为,常规产品能力、AI 知识、行业认知决定你产出价值的下限,而\\"人文素养和灵魂境界\\"决定上限——\\"如果你想成为 TOP 5%、甚至 TOP 1% 的 AI 产品经理,就一定不能忽视这个方面\\"。" },
  { chunkId: "geektime-abilities", source: "刘海丰 — 极客时间专栏《成为AI产品经理》,极客时间(time.geekbang.org)", url: "https://time.geekbang.org", text: "极客时间专栏《成为 AI 产品经理》(刘海丰)把 AI 产品经理的核心能力概括为三大能力:项目管控、算法技能、模型评估,并强调要能\\"主导 AI 项目、带领算法同学达成业务目标\\"。其中\\"模型评估\\"能力,与\\"eval 是 AI PM 决定性技能\\"的判断相互印证。" }
];

// Minimal ASCII stopword set so high-frequency function words don't inflate overlap. ASCII tokens shorter
// than 2 chars are dropped (so 'ai','pm','rag' survive). Chinese has no spaces, so CJK terms are character
// BIGRAMS (adjacent Han pairs) — the standard segmentation-free zh retrieval primitive.
const STOP = new Set(['the','a','an','and','or','of','to','in','is','are','was','were','be','as','at','by','for','on','it','its','that','this','these','those','with','from','into','your','you','my','our','their','his','her','do','does','how','what','why','when','where','which','who','whom','can','could','would','should','will','also','any','all','so','such','than','then','out','up','down','over']);
// terms(s) -> an ordered BAG (array, TF matters) of content terms: ASCII alnum words (>=2 chars, non-stop)
// plus CJK character bigrams. (chunkId hyphens are turned into spaces so its words count as ASCII tokens.)
function terms(s) {
  const arr = [];
  const str = String(s ?? '');
  (str.toLowerCase().match(/[a-z0-9]+/g) || []).forEach((w) => { if (w.length >= 2 && !STOP.has(w)) arr.push(w); });
  const han = str.match(/[\\u4e00-\\u9fff]/g) || [];
  for (let i = 0; i < han.length - 1; i += 1) arr.push(han[i] + han[i + 1]);
  return arr;
}

// Build smoothed IDF over the FIXED corpus (deterministic: corpus is a constant). idf = ln((1+N)/(1+df))+1.
const docTerms = CORPUS.map((c) => terms(c.text + ' ' + c.chunkId.replace(/-/g, ' ')));
const N = docTerms.length;
const df = new Map();
for (const d of docTerms) { for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1); }
function idf(t) { return Math.log((1 + N) / (1 + (df.get(t) || 0))) + 1; }
// tf-idf vector, L2-normalized, as a Map term -> weight.
function vec(arr) {
  const tf = new Map();
  for (const t of arr) tf.set(t, (tf.get(t) || 0) + 1);
  const v = new Map();
  let norm = 0;
  tf.forEach((f, t) => { const w = f * idf(t); v.set(t, w); norm += w * w; });
  norm = Math.sqrt(norm) || 1;
  v.forEach((w, t) => v.set(t, w / norm));
  return v;
}
const docVecs = docTerms.map(vec);

const qVec = vec(terms(input.query));
const scored = CORPUS.map((c, i) => {
  const dVec = docVecs[i];
  // Cosine = dot product of two L2-normalized tf-idf vectors. Iterate the smaller map for speed.
  let dot = 0;
  const [small, big] = qVec.size <= dVec.size ? [qVec, dVec] : [dVec, qVec];
  small.forEach((w, t) => { if (big.has(t)) dot += w * big.get(t); });
  const score = Number(dot.toFixed(4));
  return { chunkId: c.chunkId, source: c.source, url: c.url, score, text: c.text };
});

// Rank by score desc (ties broken by chunkId for determinism), take top-K.
scored.sort((a, b) => (b.score - a.score) || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0));
const topKFull = scored.slice(0, input.runtime.topK);
const maxScore = topKFull.length > 0 ? topKFull[0].score : 0;
// The public retrieval surface carries id/source/score only (no chunk text) — the grounded-answer
// node still has the text via topKFull. This keeps the response payload tight + the audit redacted.
const topK = topKFull.map((c) => ({ chunkId: c.chunkId, source: c.source, score: c.score }));

// PER-SOURCE abstention floor for the STUB (TF-IDF cosine): default 0.08, which separates the stub's
// in-corpus (~0.2-0.4) from out-of-corpus (~0). An explicit per-request body.threshold overrides it.
const threshold = input.runtime.thresholdOverride ?? 0.08;

return [{
  json: {
    ...input,
    retrieval: {
      topK,
      maxScore,
      threshold,
      retrievalSource: input.runtime.retrievalSource
    },
    // Internal: the retrieved chunk text + provenance (source/url), carried for the grounded-answer node
    // only. Stripped before the response/audit are built so chunk bodies never bloat the public payload.
    retrievedChunks: topKFull.map((c) => ({ chunkId: c.chunkId, source: c.source, url: c.url, score: c.score, text: c.text }))
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

// Each row: { id (uuid), content (text), metadata: { chunkId, source, url, retrievedAt }, similarity }.
// chunkId/source/url are taken from metadata (the ingest wrote them); fall back if ever absent, so the
// live citation names the same AUTHORITATIVE source + link the stub does.
const mapped = rows.map((r) => {
  const md = r && typeof r.metadata === 'object' && r.metadata ? r.metadata : {};
  const chunkId = String(md.chunkId || r.id || '').trim();
  const source = String(md.source || 'supabase').trim();
  const url = String(md.url || '').trim();
  const score = Number.isFinite(Number(r.similarity)) ? Number(Number(r.similarity).toFixed(4)) : 0;
  return { chunkId, source, url, score, text: String(r.content || '') };
}).filter((c) => c.chunkId.length > 0);

// Rank by similarity desc (ties by chunkId), clamp to topK (the RPC already limited to match_count).
mapped.sort((a, b) => (b.score - a.score) || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0));
const topKFull = mapped.slice(0, base.runtime.topK);
const maxScore = topKFull.length > 0 ? topKFull[0].score : 0;
const live = topKFull.length > 0;

// PER-SOURCE abstention floor for the LIVE supabase path (nomic-embed-text-v2-moe cosine): default 0.35,
// which separates live in-corpus (~0.63-0.68) from out-of-corpus (~0.15-0.17). The stub's 0.08 floor would
// NEVER abstain here (out-of-corpus sits above it). An explicit per-request body.threshold overrides it.
const threshold = base.runtime.thresholdOverride ?? 0.35;

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
      threshold,
      retrievalSource: live ? 'supabase' : 'supabase-fallback'
    },
    retrievedChunks: topKFull.map((c) => ({ chunkId: c.chunkId, source: c.source, url: c.url, score: c.score, text: c.text }))
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
// golden case relies on exactly this). The corpus is Chinese, so the assembled answer is Chinese (the
// live path's prompt likewise constrains llama3.2:3b to answer 用简体中文). Phase 2b swaps this for Ollama
// 'llama3.2:3b' behind the generationSource gate with the zh 'answer only from the provided context,
// else abstain' prompt.
//
// Grounding policy: cite the chunks that clear the threshold (the answer stands on them); compose the
// Chinese answer by quoting the grounded chunk text verbatim (a 'grounded extract'). citations =
// [{ chunkId, source, url, quote }] where source+url are the chunk's AUTHORITATIVE provenance (the real
// citation title + link, carried from the corpus) and quote is a span that EXISTS in the cited chunk, so
// citation-integrity + 'quote exists in chunk' both hold by construction and B cites a real source + URL.
const chunks = Array.isArray(input.retrievedChunks) ? input.retrievedChunks : [];
const threshold = input.retrieval.threshold;
// Only chunks at/above threshold are grounding-worthy. The top chunk always qualifies on this branch
// (maxScore >= threshold gated us here); include any other retrieved chunk that also clears it.
const grounding = chunks.filter((c) => c.score >= threshold);
const used = grounding.length > 0 ? grounding : chunks.slice(0, 1);

// groundedExtract: the verbatim chunk text up to the first sentence terminator. The zh chunks use full-
// width punctuation (。) and embed English quotes, so this returns the whole fact — exactly the grounded
// Chinese answer we want — while still being a guaranteed-present span of the cited chunk.
function groundedExtract(t) {
  const s = String(t ?? '').trim();
  const m = s.match(/^[\\s\\S]*?[.!?。!?]/);
  return (m ? m[0] : s).trim();
}

const citations = used.map((c) => ({
  chunkId: c.chunkId,
  source: c.source,
  url: c.url,
  quote: groundedExtract(c.text)
}));

// The answer is a deterministic Chinese composition of the grounded extract(s). No external text added.
const answer = used.map((c) => groundedExtract(c.text)).join(' ');

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
function groundedExtract(t) {
  const s = String(t ?? '').trim();
  const m = s.match(/^[\\s\\S]*?[.!?。！？]/);
  return (m ? m[0] : s).trim();
}
const chunks = Array.isArray(input.retrievedChunks) ? input.retrievedChunks : [];
const threshold = input.retrieval.threshold;
const grounding = chunks.filter((c) => c.score >= threshold);
const used = grounding.length > 0 ? grounding : chunks.slice(0, 1);
// Context block the model must answer strictly from. Each chunk is labelled with its source + id.
const contextText = used.map((c, i) => '[' + (i + 1) + '] (' + c.source + '#' + c.chunkId + ') ' + String(c.text || '')).join('\\n\\n');
// Grounded citations are pre-computed here from the corpus chunks (NOT from the model) so attribution
// integrity is guaranteed regardless of the model output — carrying the AUTHORITATIVE source + url.
const groundedCitations = used.map((c) => ({ chunkId: c.chunkId, source: c.source, url: c.url, quote: groundedExtract(c.text) }));
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
      // llama3.2:3b, temperature 0 (repeatable), stream:false. The system prompt CONSTRAINS the model to
      // answer strictly from the provided context, IN SIMPLIFIED CHINESE, and to ABSTAIN with the exact
      // zh sentinel ("信息不足,无法回答") when the context does not contain the answer — the grounding/
      // abstention/Chinese-output policy from the spec (citations are still recomputed from the corpus,
      // never from this prose, so citation-integrity holds regardless of what the model writes).
      jsonBody: '={{ ({ model: ($json.runtime.genModel || "llama3.2:3b"), stream: false, options: { temperature: 0 }, messages: [ { role: "system", content: "你是一个基于检索的助手。只依据提供的上下文用简体中文作答;不要使用上下文以外的任何知识。若上下文不足以回答,则只回答这一句:信息不足,无法回答。请简洁(1-3 句)。" }, { role: "user", content: "上下文:\\n" + $json.gen.contextText + "\\n\\n问题:\\n" + $json.query } ] }) }}',
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
function groundedExtract(t) {
  const s = String(t ?? '').trim();
  const m = s.match(/^[\\s\\S]*?[.!?。！？]/);
  return (m ? m[0] : s).trim();
}

const groundedCitations = Array.isArray(base.gen && base.gen.groundedCitations) ? base.gen.groundedCitations : [];
let answerText = readContent(http).trim();
let generationSource = 'ollama';

// Fallback: if the model returned nothing usable, deterministically compose the stub grounded extract
// (a Chinese grounded quote) from the same chunks (so the grounded branch ALWAYS yields a cited answer,
// never an empty one).
if (answerText.length === 0) {
  generationSource = 'ollama-fallback';
  const chunks = Array.isArray(base.retrievedChunks) ? base.retrievedChunks : [];
  const threshold = base.retrieval.threshold;
  const grounding = chunks.filter((c) => c.score >= threshold);
  const used = grounding.length > 0 ? grounding : chunks.slice(0, 1);
  answerText = used.map((c) => groundedExtract(c.text)).join(' ');
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
//   abstained:true, answer:null, citations:[]. The human-readable abstain message is CHINESE
// ('信息不足,无法回答') carried as a separate 'note' field — the 'I don't have enough information'
// contract in zh — while answer stays strictly null so Assert-CleanAbstain (answer==null AND
// citations==[]) holds unchanged. This is the system's controlled failure mode (an asserted invariant).
return [{
  json: {
    ...input,
    generation: {
      abstained: true,
      answer: null,
      citations: [],
      note: '信息不足,无法回答',
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
      policyVersion: 'rag-knowledge-assistant-v0.3.0',
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
      // On abstain, surface the CHINESE 'insufficient information' message (answer stays null); on a
      // grounded answer there is no note. This keeps the abstain human-readable + Chinese per spec.
      note: gen.abstained === true ? (gen.note || '信息不足,无法回答') : null,
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
      policyVersion: 'rag-knowledge-assistant-v0.3.0'
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
  '## RAG Knowledge Assistant v0.3.0 (zh "AI 时代产品经理" corpus, provenance-tracked; stub default + LIVE Supabase/Ollama, opt-in)\\nLocal retrieval-grounded API over a Chinese, authoritative-sourced, provenance-tracked corpus (fixtures/corpus/* — 13 chunks across 西方PM/中文社区/开源社区 sources, each carrying source title + url + retrievedAt). A webhook receives a query, then a RETRIEVAL-SOURCE gate routes: retrievalSource:"supabase" EMBEDS the query via Ollama nomic-embed-text-v2-moe (768-dim, "search_query: " prefix) and calls the Supabase match_documents pgvector RPC (header auth, User-Agent n8n); otherwise the DEFAULT deterministic STUB retriever (TF-IDF cosine over CJK bigrams + ASCII tokens, no model) searches the IN-REPO corpus. Both produce the same retrieval contract (topK=[{chunkId,source,score}], maxScore, threshold) but on DIFFERENT score scales, so the abstention floor is a PER-SOURCE default (stub TF-IDF 0.08; supabase nomic-embed cosine 0.35), overridable per request via body.threshold. A THRESHOLD GATE then routes to a GROUNDED ANSWER or a CLEAN ABSTAIN (abstained:true, answer:null, citations:[], note:"信息不足,无法回答" — the controlled failure mode, in Chinese). On the grounded branch a GENERATION-SOURCE gate routes: generationSource:"ollama" calls Ollama llama3.2:3b (temperature 0, "只依据提供的上下文用简体中文作答;若信息不足则回答『信息不足,无法回答』") for the prose; otherwise the DEFAULT stub composes a Chinese grounded extract. CRITICAL: on BOTH generation paths the CITATIONS are corpus-grounded (chunkId/source/url/quote derived from the retrieved chunks, never from the model), so B cites the REAL authoritative source + link and CITATION-INTEGRITY (every cited chunkId in retrieval.topK; the quote is a real span of its chunk) holds by construction and is ENFORCED deterministically (a cited chunk outside the retrieved set -> passed=false). Live nodes are onError-tolerant and DEGRADE to the deterministic result (retrievalSource:"supabase-fallback" / generationSource:"ollama-fallback"); the response reports what ACTUALLY ran. A redacted audit event (ids + scores + verdicts only — no raw query/answer/chunk text) precedes a structured JSON response per the eval-plan scorer contract (abstained, answer, note, citations, retrieval{topK,maxScore,threshold}, retrievalSource, generationSource, passed, policyVersion rag-knowledge-assistant-v0.3.0). The stub is the DEFAULT everywhere CI touches, so verify:static/json/live stay OFFLINE + deterministic; the live path is opt-in per request (verify:rag-live). Supabase is one-command-refreshable from the cited sources via scripts/Refresh-Corpus.ps1 (stub stays a pinned snapshot). Manual trigger runs an editor demo; the webhook serves the API. Mirrors the sibling eval-harness judgeSource:"ollama" live-gate idiom.',
  [runDemoFromUi, buildDemoQueryPayload, receiveQuery, normalizeRequest, hasQueryGate, retrievalSourceGate, embedQuery, callMatchDocuments, mapSupabaseRetrieval, stubRetrieve, thresholdGate, generationSourceGate, buildGenContext, callOllamaChat, parseOllamaAnswer, groundedAnswer, cleanAbstain, enforceCitationIntegrity, buildAuditEvent, buildResponse, manualUiExecution],
  { color: 4 }
);

// Callable as a sub-workflow by the interaction-gateway via Execute Workflow (in-process, no HTTP). Feeds the
// SAME Normalize Request pipeline as the webhook (which already tolerates passthrough via `source.body ?? source`),
// so the webhook contract is unchanged. The gateway sends { query, ... } directly. respondToWebhook is a no-op
// in a sub-workflow call; the caller receives the last node's output (Build Response, carrying `.response`).
const calledByGateway = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: { name: 'Called By Gateway (Execute Workflow)', position: [160, 760], parameters: { inputSource: 'passthrough' } }
});

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
  .to(normalizeRequest)
  .add(calledByGateway)
  .to(normalizeRequest);
