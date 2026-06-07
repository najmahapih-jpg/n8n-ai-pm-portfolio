// rag-core.mjs — the RAG-knowledge-assistant's PURE deterministic STUB-path logic (single source of truth;
// the n8n Code nodes mirror these). No n8n, no network: assertable in-process by test-rag-workflow.mjs.
//
// SCOPE: this core reproduces the DETERMINISTIC STUB PATH only — the offline, reproducible lane the Layer-2
// suite (verify:static / CI) exercises. That path is the linear Code-node chain the webhook/sub-workflow
// drives when retrievalSource/generationSource default to 'stub':
//   Normalize Request -> Stub Embed + Retrieve -> (threshold gate) -> Stub Grounded Answer | Clean Abstain
//   -> Enforce Citation Integrity -> Create Redacted Audit Event -> Build Response
// plus the Missing-Query 400 branch (Build Missing Query Error). The LIVE branches (retrievalSource:'supabase'
// -> Embed Query (Ollama) / Match Documents (Supabase RPC) / Map Supabase Retrieval; generationSource:'ollama'
// -> Build Grounding Context / Generate Answer (Ollama) / Parse + Ground Answer (Ollama)) call Supabase/Ollama
// over HTTP and are NOT mirrored here — they are not part of the offline gate (they belong to verify:rag-live).
// test-rag-workflow.mjs executes the COMPILED jsCode of each STUB node above and asserts it is byte-behaviour-
// identical to the functions below over the golden/regression fixtures (the differential).
//
// BEHAVIOR-PRESERVING CONTRACT: each function is a verbatim reverse-extract of the corresponding node's body.
// Regex/unicode literals use the SINGLE-escaped form (e.g. /[^\s@]+/, '∷' is not used here; the groundedExtract
// terminator class is [.!?。!?]), which is exactly what the compiled node's source evaluates to at runtime (the
// SDK double-escapes in the .js so the JSON-embedded copy single-escapes after JSON.parse). The core mirrors the
// node, never the other way around.
//
// IMPORTANT (finding #21, faithfully mirrored): the STUB 'Stub Grounded Answer' node's groundedExtract uses the
// HALF-WIDTH '!?' terminator class /^[\s\S]*?[.!?。!?]/ (full-width 。 + half-width ! ?), whereas the two LIVE-only
// nodes ('Build Grounding Context' / 'Parse + Ground Answer (Ollama)') use the FULL-WIDTH /^[\s\S]*?[.!?。！？]/.
// Because this core mirrors ONLY the stub path, groundedExtract here uses the STUB node's half-width form verbatim;
// the live divergence is irrelevant to the offline differential (those live nodes are not cored). The stub corpus
// chunks all terminate on a full-width 。 so both forms cut at the same place in practice, but the core is faithful
// to the exact stub literal so the differential is byte-identical, not coincidentally-equal.
//
// The POLICY_VERSION below MUST match the literal 'rag-knowledge-assistant-v0.3.0' baked into the compiled nodes;
// if a future recompile bumps it, the differential will fail loudly until the core is re-synced (the intended guard).
export const POLICY_VERSION = 'rag-knowledge-assistant-v0.3.0';

// =========================================================================================================
// CORPUS — the IN-REPO knowledge base the stub retriever scores against. A VERBATIM (byte-for-byte) mirror of
// the 'Stub Embed + Retrieve' node's CORPUS constant (source of truth: fixtures/corpus/*.md — 19 chunks: 13
// Chinese "AI 时代产品经理" + 6 English product-support known-issues/docs). MUST stay in sync with the node; the
// differential proves it (a drift in either copy fails the byte-identical retrieval compare).
// =========================================================================================================
export const CORPUS = [
  { chunkId: "rag-eval-faithfulness", source: "Hugging Face LLM/Agents Course(mlabonne 等)与 Ragas / DeepEval 开源评测框架", url: "https://github.com/mlabonne/llm-course", text: "开源社区给出了评测 RAG 的标准做法:要分别评检索与生成两段——检索看 context precision / recall(召回到的上下文准不准、全不全),生成看 faithfulness(忠实度:答案是否扎根于检索到的上下文)与 answer relevancy(答案相关性);这些可用开源工具 Ragas / DeepEval 简化。RAG 本身则是\"无需微调即可扩展模型知识\"的常用手段。" },
  { chunkId: "trust-reliability", source: "Lenny Rachitsky 等 — Lenny's Newsletter《Why most AI products fail》(2026)", url: "https://www.lennysnewsletter.com/p/what-openai-and-google-engineers-learned", text: "在 OpenAI、Google、Amazon 等公司 50+ 个企业级 AI 部署中,一条反复出现的教训是:\"obsessing about customer trust and reliability is an underrated driver of successful AI products\"(对客户信任与可靠性的执着,是 AI 产品成功被严重低估的驱动力)。评测必要但非万灵药——为可靠性与\"优雅失败\"路径而设计,才是把 demo 变成用户敢依赖的产品的关键。" },
  { chunkId: "how-to-learn", source: "InstitutePM《How to Become an AI Product Manager in 2026》(2026)", url: "https://www.institutepm.com/knowledge-hub/how-to-become-an-ai-product-manager-2026", text: "对 PM 而言,技术学习的\"正确深度\"是 \"competent enough to make decisions and pressure-test your engineers\"(足以做决策、并能向工程师施压检验)——既不必推导反向传播,也不能只刷一张证书。推荐路径:读 Anthropic 与 OpenAI 的 prompt 工程指南,然后 \"build a RAG app, a tool-calling agent, and a fine-tuned classifier\"(亲手做一个 RAG 应用、一个工具调用 agent、一个微调分类器,哪怕都很小)——三个一起做才会逼你学会其中的取舍;并把一套 eval 框架端到端做透。" },
  { chunkId: "portfolio-proof", source: "InstitutePM《How to Become an AI Product Manager in 2026》(2026)", url: "https://www.institutepm.com/knowledge-hub/how-to-become-an-ai-product-manager-2026", text: "转型最高杠杆的一步,是一份能证明\"你能交付、并能就 AI 产品做推理\"的作品集——因为招聘官\"在简历上花 90 秒,在一份强 case study 上花 8 分钟\"。能让你进面试的三件套:一个上线的产品(哪怕是 side project,有 URL 或仓库)、一篇带真实数字的 eval 驱动 case study、一套可演示的 eval 套件。" },
  { chunkId: "model-as-coach", source: "Marty Cagan — Silicon Valley Product Group《Product Coaching and AI》(2026)", url: "https://www.svpg.com/product-coaching-and-ai/", text: "SVPG 现在建议产品人把基础模型本身当作\"个人产品教练\"来加速培养 product sense——用你的目标、约束与战略背景把它配置好。在他们的表述里,\"prompt engineering has evolved into context engineering\"(提示工程已演进为上下文工程);一个配置得当的模型,提供的产品教练水准可以不输给多数管理者,而且是持续在线、而非每周一次的 1:1。" },
  { chunkId: "yujun-growth", source: "俞军 —《俞军产品方法论》(中信出版社,2019);《深度对话俞军》", url: "https://docs.feishu.cn/article/wiki/EzRKwB8NDi2gd0keAhhce6hFn8g", text: "俞军给出一条本土化的成长路径:产品经理的能力按\"为企业创造价值的能力\"分五级——可行性 → 创造 → 权衡 → 变迁 → 方法论。第一级\"可行性\"要求对用户价值、技术可行性、商业可行性有基本判断力;往上依次是为问题找最优解(创造)、跳出单点做全局取舍(权衡)、预判世事变迁(变迁),直到输出成体系的方法论。" },
  { chunkId: "pm-more-essential", source: "Marty Cagan — Silicon Valley Product Group《AI Product Management》(2024)", url: "https://www.svpg.com/ai-product-management/", text: "Marty Cagan(SVPG 创始人、《INSPIRED》作者)认为,几乎所有产品经理都将需要成为 AI 产品经理;且与\"AI 让 PM 变多余\"的流行担忧相反——他说 \"the PM role becomes more essential but also more difficult with generative AI-powered products, not less\"(在生成式 AI 产品中,PM 角色变得更关键、也更难,而不是更不重要)。AI 素养只是又一个例证:产品经理需要扎实的技术基础。" },
  { chunkId: "genuine-value", source: "Marty Cagan — Silicon Valley Product Group《AI Product Management》(2024)", url: "https://www.svpg.com/ai-product-management/", text: "按 SVPG 的说法,AI 产品经理的首要职责,是确保 AI 功能交付 \"genuine, incremental value\"(真实、增量的价值)——以明显优于现有方案的方式解决真问题。要极力避免的失败模式,是做出 \"AI in name only\" 的产品:为营销或竞争跟风而加 AI,而非为价值。" },
  { chunkId: "yujun-user-value", source: "俞军 —《俞军产品方法论》(中信出版社,2019);亦见《深度对话俞军》", url: "https://docs.feishu.cn/article/wiki/EzRKwB8NDi2gd0keAhhce6hFn8g", text: "俞军(《俞军产品方法论》作者、前百度产品副总裁)给出一个根基性定义:\"产品经理是一个用科学方法研究复杂且非科学的人性,并转化为可执行的商业方案的实践验证学科。\" 在他看来,产品经理的工作是找到\"真的用户价值\";一个具备人文逻辑的产品经理,最重要的是拥有批判性思维,其次是愿意并能够理解人和世界。" },
  { chunkId: "evals-defining-skill", source: "Aman Khan — Lenny's Newsletter《Beyond vibe checks: A PM's complete guide to evals》(2025)", url: "https://www.lennysnewsletter.com/p/beyond-vibe-checks-a-pms-complete", text: "写好评测(eval)正在成为做 AI 产品的决定性技能。Aman Khan(Arize AI 产品总监,与 Andrew Ng 合作开设 eval 课程)直言:写好 eval 的能力 \"is rapidly becoming the defining skill for AI PMs in 2025 and beyond\"(正迅速成为 2025 年及以后 AI 产品经理的决定性技能)。评测像传统软件的回归测试一样,为非确定性系统定义\"什么叫好\",让你能度量每次 prompt/模型/检索改动的影响,而不是靠\"感觉\"(vibe check)。" },
  { chunkId: "three-skill-clusters", source: "InstitutePM《How to Become an AI Product Manager in 2026》(2026)", url: "https://www.institutepm.com/knowledge-hub/how-to-become-an-ai-product-manager-2026", text: "转型 AI 产品经理要同时补齐三大技能簇:技术素养(足以做 eval/模型/成本决策——看得懂模型卡、算得清延迟预算、能用代码跑 eval)、适配 AI 不确定性的产品功力(写 eval 驱动的 spec 而非功能 spec,指标树看质量分布而非只看均值)、以及 AI 专属判断(模型选型、失败态 UX、成本-质量-延迟三角)。其中\"判断\"这一簇被认为\"最难伪装,也是多数候选人最被低估的一项\"。" },
  { chunkId: "hanniman-humanity", source: "黄钊 hanniman —《AI产品经理能力模型的重点素质:人文素养和灵魂境界》,人人都是产品经理 (2022);摘自《AI产品经理的实操手册》", url: "https://www.woshipm.com/pmd/5396083.html", text: "在 AI 产品经理的能力模型里,黄钊(hanniman,前腾讯 PM、\"AI产品经理大本营\"创始人)提出一个中文社区独有的关键差异点:\"人文素养和灵魂境界\"。他认为,常规产品能力、AI 知识、行业认知决定你产出价值的下限,而\"人文素养和灵魂境界\"决定上限——\"如果你想成为 TOP 5%、甚至 TOP 1% 的 AI 产品经理,就一定不能忽视这个方面\"。" },
  { chunkId: "geektime-abilities", source: "刘海丰 — 极客时间专栏《成为AI产品经理》,极客时间(time.geekbang.org)", url: "https://time.geekbang.org", text: "极客时间专栏《成为 AI 产品经理》(刘海丰)把 AI 产品经理的核心能力概括为三大能力:项目管控、算法技能、模型评估,并强调要能\"主导 AI 项目、带领算法同学达成业务目标\"。其中\"模型评估\"能力,与\"eval 是 AI PM 决定性技能\"的判断相互印证。" },
  { chunkId: "known-export-mobile-crash", source: "Internal Product Knowledge Base — Known Issues", url: "", text: "The data export button crashes the mobile app on both iOS and Android when a report is exported to CSV or PDF. This is a known issue affecting mobile app versions 2.2 and 2.3; a fix is scheduled for version 2.4. Workaround: run the export from the desktop web app instead, where export works normally. Owning team: product-engineering. Severity: high." },
  { chunkId: "known-dashboard-slow", source: "Internal Product Knowledge Base — Known Issues", url: "", text: "The analytics dashboard loads slowly, often taking ten seconds or more, for workspaces with large datasets. The known cause is unbounded client-side aggregation of the trend charts. A server-side aggregation fix is in progress. Workaround: narrow the dashboard date range, or open a saved view with fewer segments. Owning team: product-engineering. Severity: medium." },
  { chunkId: "known-sso-login-loop", source: "Internal Product Knowledge Base — Known Issues", url: "", text: "Single sign-on users are sometimes stuck in a login redirect loop after their session expires. The known cause is the browser blocking third-party cookies. Workaround: allow cookies for the app domain, or sign in with the email-and-password fallback. Owning team: platform-security. Severity: high." },
  { chunkId: "doc-export-howto", source: "Internal Product Knowledge Base — Product Docs", url: "", text: "To export data, open any report or dashboard, click the Export button, and choose a format: CSV, XLSX, or PDF. Exports run in the background, and you receive an email with a download link when the file is ready. Large exports over one million rows are queued and may take a few minutes." },
  { chunkId: "doc-dashboard-overview", source: "Internal Product Knowledge Base — Product Docs", url: "", text: "The analytics dashboard has three areas. KPI cards at the top show headline metrics, trend charts in the middle show changes over time, and a data table at the bottom lists the underlying records. You can filter the whole dashboard by date range, by segment, and by saved views that you create and share with your team." },
  { chunkId: "faq-mobile-support", source: "Internal Product Knowledge Base — Product Docs", url: "", text: "The mobile app supports viewing dashboards, reports, and notifications. Some administrative features, including data export, user management, and billing, are available on the desktop web app only and not on mobile." }
];

// ---------------------------------------------------------------------------------------------------------
// (1) normalizeRequest — mirror of the 'Normalize Request' Code node (deterministic fields only).
// The node defaults request.requestedAt to new Date().toISOString() and request.requestId to a Date.now()-
// derived id when absent; those are the only nondeterminism in the deterministic chain. The differential
// injects the SAME requestedAt/requestId into both sides (via opts) so the records — and the requestId+
// requestedAt-derived auditEventId — compare byte-identical. When opts are absent the core falls back to
// wall-clock exactly like the node.
// ---------------------------------------------------------------------------------------------------------
export function normalizeRequest(source, opts = {}) {
  source = source ?? {};
  const body = source.body ?? source;
  const entrypoint = source.manualExecution === true || body.manualExecution === true ? 'manual' : 'webhook';
  const text = (v) => String(v ?? '').trim();

  const query = text(body.query) || text(body.question) || text(body.q);
  const hasQuery = query.length > 0;

  const rawTopK = Number(body.topK);
  const topK = Number.isFinite(rawTopK) && rawTopK >= 1 ? Math.min(Math.floor(rawTopK), 8) : 3;
  const rawThreshold = Number(body.threshold);
  const thresholdOverride = Number.isFinite(rawThreshold) && rawThreshold >= 0 ? Math.min(rawThreshold, 1) : null;

  const requestedRetrievalSource = text(body.retrievalSource).toLowerCase();
  const requestedGenerationSource = text(body.generationSource).toLowerCase();
  const retrievalSource = requestedRetrievalSource === 'supabase' ? 'supabase' : 'stub';
  const generationSource = requestedGenerationSource === 'ollama' ? 'ollama' : 'stub';

  const ollamaEmbedUrl = text(body.ollamaEmbedUrl) || 'http://host.docker.internal:11434/api/embeddings';
  const ollamaChatUrl = text(body.ollamaChatUrl) || 'http://host.docker.internal:11434/api/chat';
  const embedModel = text(body.embedModel) || 'nomic-embed-text-v2-moe';
  const genModel = text(body.genModel) || 'llama3.2:3b';
  const supabaseRpcUrl = text(body.supabaseRpcUrl) || '__SUPABASE_RPC_URL__';

  // The node uses Date.now()/new Date() when requestId/requestedAt are absent; the core takes them via opts
  // so the differential can pin both sides to the same instant + id. Falls back to wall-clock like the node.
  const requestIdFallback = opts.requestIdFallback != null ? String(opts.requestIdFallback) : ('req_' + Date.now().toString(36));
  const requestedAtFallback = opts.now != null ? String(opts.now) : new Date().toISOString();

  return {
    request: {
      requestId: text(body.requestId) || requestIdFallback,
      requestedAt: text(body.requestedAt) || requestedAtFallback
    },
    query,
    validation: { hasQuery },
    runtime: {
      entrypoint,
      topK,
      thresholdOverride,
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
  };
}

// ---------------------------------------------------------------------------------------------------------
// (R) stubRetrieveCore — the PURE TF-IDF cosine retriever the 'Stub Embed + Retrieve' node runs. Factored out
// of the node body so it can be reused by callers OTHER than the node — most importantly the X4 follow-up,
// where rag's live-supabase-empty path will FALL BACK to this same deterministic TF-IDF retriever instead of
// abstaining. X4 is NOT implemented here; this factoring is the seam it will plug into:
//   stubRetrieveCore(query, { corpus, topK, thresholdOverride }) -> { topK, maxScore, threshold, retrievedChunks }
// — exactly the retrieval contract the live mapper produces, so the threshold gate / citation-integrity /
// response stay source-agnostic. corpus defaults to the in-repo CORPUS; X4 may pass the live corpus snapshot.
//
// The scoring is byte-identical to the node: CJK character bigrams + ASCII word tokens (>=2 chars, non-stop),
// smoothed IDF over the corpus, L2-normalized tf-idf cosine, score rounded to 4 dp, ranked desc with chunkId
// tie-break, sliced to topK. threshold = thresholdOverride ?? 0.08 (the stub's per-source abstention floor).
// ---------------------------------------------------------------------------------------------------------
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'was', 'were', 'be', 'as', 'at', 'by', 'for', 'on', 'it', 'its', 'that', 'this', 'these', 'those', 'with', 'from', 'into', 'your', 'you', 'my', 'our', 'their', 'his', 'her', 'do', 'does', 'how', 'what', 'why', 'when', 'where', 'which', 'who', 'whom', 'can', 'could', 'would', 'should', 'will', 'also', 'any', 'all', 'so', 'such', 'than', 'then', 'out', 'up', 'down', 'over']);

// terms(s) -> an ordered BAG (array, TF matters) of content terms: ASCII alnum words (>=2 chars, non-stop)
// plus CJK character bigrams. (chunkId hyphens are turned into spaces so its words count as ASCII tokens.)
function terms(s) {
  const arr = [];
  const str = String(s ?? '');
  (str.toLowerCase().match(/[a-z0-9]+/g) || []).forEach((w) => { if (w.length >= 2 && !STOP.has(w)) arr.push(w); });
  const han = str.match(/[一-鿿]/g) || [];
  for (let i = 0; i < han.length - 1; i += 1) arr.push(han[i] + han[i + 1]);
  return arr;
}

export function stubRetrieveCore(query, opts = {}) {
  const corpus = Array.isArray(opts.corpus) ? opts.corpus : CORPUS;
  const topKLimit = Number.isFinite(Number(opts.topK)) && Number(opts.topK) >= 1 ? Math.min(Math.floor(Number(opts.topK)), 8) : 3;
  const thresholdOverride = (opts.thresholdOverride === null || opts.thresholdOverride === undefined) ? null : Number(opts.thresholdOverride);

  // Build smoothed IDF over the corpus (deterministic: corpus is fixed). idf = ln((1+N)/(1+df))+1.
  const docTerms = corpus.map((c) => terms(c.text + ' ' + c.chunkId.replace(/-/g, ' ')));
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

  const qVec = vec(terms(query));
  const scored = corpus.map((c, i) => {
    const dVec = docVecs[i];
    let dot = 0;
    const [small, big] = qVec.size <= dVec.size ? [qVec, dVec] : [dVec, qVec];
    small.forEach((w, t) => { if (big.has(t)) dot += w * big.get(t); });
    const score = Number(dot.toFixed(4));
    return { chunkId: c.chunkId, source: c.source, url: c.url, score, text: c.text };
  });

  scored.sort((a, b) => (b.score - a.score) || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0));
  const topKFull = scored.slice(0, topKLimit);
  const maxScore = topKFull.length > 0 ? topKFull[0].score : 0;
  const topK = topKFull.map((c) => ({ chunkId: c.chunkId, source: c.source, score: c.score }));
  const threshold = thresholdOverride ?? 0.08;

  return {
    topK,
    maxScore,
    threshold,
    retrievedChunks: topKFull.map((c) => ({ chunkId: c.chunkId, source: c.source, url: c.url, score: c.score, text: c.text }))
  };
}

// ---------------------------------------------------------------------------------------------------------
// (2) stubRetrieve — mirror of the 'Stub Embed + Retrieve' node: runs stubRetrieveCore over the in-repo CORPUS
// with input.runtime.topK / thresholdOverride, then spreads { retrieval, retrievedChunks } onto the run item
// exactly as the node returns it. retrieval.retrievalSource carries input.runtime.retrievalSource ('stub').
// ---------------------------------------------------------------------------------------------------------
export function stubRetrieve(input) {
  const r = stubRetrieveCore(input.query, {
    corpus: CORPUS,
    topK: input.runtime.topK,
    thresholdOverride: input.runtime.thresholdOverride
  });
  return {
    ...input,
    retrieval: {
      topK: r.topK,
      maxScore: r.maxScore,
      threshold: r.threshold,
      retrievalSource: input.runtime.retrievalSource
    },
    retrievedChunks: r.retrievedChunks
  };
}

// ---------------------------------------------------------------------------------------------------------
// groundedExtract — mirror of the STUB 'Stub Grounded Answer' node's helper: the verbatim chunk text up to the
// first sentence terminator. Terminator class is the STUB node's HALF-WIDTH form [.!?。!?] (see finding #21
// note at the top of this file). Returns the whole sentence (a guaranteed-present span of the cited chunk).
// ---------------------------------------------------------------------------------------------------------
function groundedExtract(t) {
  const s = String(t ?? '').trim();
  const m = s.match(/^[\s\S]*?[.!?。!?]/);
  return (m ? m[0] : s).trim();
}

// ---------------------------------------------------------------------------------------------------------
// (3) stubGroundedAnswer — mirror of 'Stub Grounded Answer'. Cites the chunks at/above threshold (or the top
// chunk if none clears it on this gated branch), composes the Chinese answer by joining each grounded extract,
// and builds citations = [{ chunkId, source, url, quote }] from the corpus chunks (never the model), so
// citation-integrity + 'quote exists in chunk' hold by construction. abstained:false.
// ---------------------------------------------------------------------------------------------------------
export function stubGroundedAnswer(input) {
  const chunks = Array.isArray(input.retrievedChunks) ? input.retrievedChunks : [];
  const threshold = input.retrieval.threshold;
  const grounding = chunks.filter((c) => c.score >= threshold);
  const used = grounding.length > 0 ? grounding : chunks.slice(0, 1);

  const citations = used.map((c) => ({
    chunkId: c.chunkId,
    source: c.source,
    url: c.url,
    quote: groundedExtract(c.text)
  }));

  const answer = used.map((c) => groundedExtract(c.text)).join(' ');

  return {
    ...input,
    generation: {
      abstained: false,
      answer,
      citations,
      generationSource: input.runtime.generationSource
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (4) cleanAbstain — mirror of 'Clean Abstain'. The controlled failure mode: abstained:true, answer:null,
// citations:[], with the CHINESE 'insufficient information' message as a separate 'note' field.
// ---------------------------------------------------------------------------------------------------------
export function cleanAbstain(input) {
  return {
    ...input,
    generation: {
      abstained: true,
      answer: null,
      citations: [],
      note: '信息不足,无法回答',
      generationSource: input.runtime.generationSource
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (5) enforceCitationIntegrity — mirror of 'Enforce Citation Integrity'. The headline invariant: passed iff
// a VALID grounded answer (>=1 citation, an answer present, every citation.chunkId in retrieval.topK, each
// quote a real span of its cited chunk) OR a VALID clean abstain (answer null + citations []).
// ---------------------------------------------------------------------------------------------------------
export function enforceCitationIntegrity(input) {
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

  return { ...input, integrity, passed };
}

// ---------------------------------------------------------------------------------------------------------
// (6) buildAuditEvent — mirror of 'Create Redacted Audit Event'. Carries ONLY ids/scores/verdicts/counts —
// never the raw query text, answer text, chunk bodies, or quotes (masking invariant). createdAt is the node's
// new Date().toISOString(); the differential injects the SAME instant via opts.now into both sides.
// ---------------------------------------------------------------------------------------------------------
export function buildAuditEvent(input, opts = {}) {
  function hash(value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  const emailRe = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
  const runSeed = input.request.requestId + '|' + input.request.requestedAt;
  const gen = input.generation;
  const createdAt = opts.now != null ? String(opts.now) : new Date().toISOString();

  return {
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
      topK: (input.retrieval.topK || []).map((c) => ({ chunkId: c.chunkId, source: c.source, score: c.score })),
      maxScore: input.retrieval.maxScore,
      threshold: input.retrieval.threshold,
      citedChunkIds: Array.isArray(gen.citations) ? gen.citations.map((c) => c.chunkId) : [],
      citationCount: Array.isArray(gen.citations) ? gen.citations.length : 0,
      queryLength: String(input.query ?? '').length,
      queryHash: 'q_' + hash(String(input.query ?? '').replace(emailRe, (e) => { const p = e.split('@'); return (p[0] ? p[0][0] + '***' : '***') + '@' + (p[1] ?? ''); })),
      policyVersion: POLICY_VERSION,
      createdAt
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (7) buildResponse — mirror of 'Build Response'. The final { statusCode, runtime, response, auditEvent }.
// processedAt is new Date().toISOString(); the differential injects the SAME instant via opts.now.
// ---------------------------------------------------------------------------------------------------------
export function buildResponse(input, opts = {}) {
  const gen = input.generation;
  const processedAt = opts.now != null ? String(opts.now) : new Date().toISOString();
  return {
    statusCode: 200,
    runtime: input.runtime,
    response: {
      ok: true,
      requestId: input.request.requestId,
      abstained: gen.abstained === true,
      answer: gen.abstained === true ? null : gen.answer,
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
      processedAt,
      policyVersion: POLICY_VERSION
    },
    auditEvent: input.auditEvent
  };
}

// ---------------------------------------------------------------------------------------------------------
// (8) buildMissingQueryError — mirror of 'Build Missing Query Error' (the 400 branch when no query).
// ---------------------------------------------------------------------------------------------------------
export function buildMissingQueryError(input) {
  return {
    statusCode: 400,
    runtime: input.runtime,
    response: {
      ok: false,
      error: "Missing required 'query' (non-empty string)",
      policyVersion: POLICY_VERSION
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// runStubRag — convenience composition of the full deterministic stub pipeline (the happy path) + the
// missing-query branch + the threshold-gated abstain/grounded split. Threads opts (now/requestIdFallback)
// into the timestamp/id-bearing stages so a full run is reproducible end-to-end. Returns the Build Response
// (200) or Build Missing Query Error (400) shape. Single entry point the differential and any future direct
// core test reuse.
// ---------------------------------------------------------------------------------------------------------
export function runStubRag(source, opts = {}) {
  const normalized = normalizeRequest(source, opts);
  if (!normalized.validation.hasQuery) {
    return { record: buildMissingQueryError(normalized), normalized };
  }
  const afterRetrieve = stubRetrieve(normalized);
  const clears = afterRetrieve.retrieval.maxScore >= afterRetrieve.retrieval.threshold;
  const afterGen = clears ? stubGroundedAnswer(afterRetrieve) : cleanAbstain(afterRetrieve);
  const afterIntegrity = enforceCitationIntegrity(afterGen);
  const afterAudit = buildAuditEvent(afterIntegrity, opts);
  const record = buildResponse(afterAudit, opts);
  return {
    record,
    normalized,
    retrieval: afterRetrieve.retrieval,
    retrievedChunks: afterRetrieve.retrievedChunks,
    generation: afterGen.generation,
    integrity: afterIntegrity.integrity,
    passed: afterIntegrity.passed,
    auditEvent: afterAudit.auditEvent,
    clearedThreshold: clears
  };
}
