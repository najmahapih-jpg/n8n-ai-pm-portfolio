import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';

// Scheduled Drift Monitor — stub-default core + opt-in live path (v0.2.0).
//
// The portfolio's first SCHEDULED (cron) + MONITORING workflow (not a synchronous webhook). On a
// schedule (default weekly) — or a manual editor run — it runs two pluggable monitors and emits an
// integrity-checked digest, per docs/eval-plan.md:
//   Monitor 1 (Corpus Freshness): fingerprints Project B's allowlisted corpus sources against a pinned
//     SOURCE_MANIFEST -> unchanged|changed|stale|unreachable (serves B's RAG periodic update). The
//     workflow is DETECT-ONLY: it never writes B's live KB, so refresh-gating ("zero live writes") holds
//     BY CONSTRUCTION (no Supabase-write node exists here); the gated re-embed is a later live increment.
//   Monitor 2 (Answer-Quality Drift): compares a quality reading to the prior run's baseline -> regressed?
// The two are aggregated into a run record, a digest is summarized FROM that record, and DIGEST-INTEGRITY
// is enforced in two record-grounded checks: the machine-appended METRICS line is recomputed from the
// record, AND any pass-rate-shaped figure in the summarizer's prose must match a record rate (so an LLM
// that states a passRate the data does not show fails the run; sibling B's citation-integrity for a summary).
//
// STUB-DEFAULT, exactly mirroring siblings A/B: mode is NORMALIZED ("live" accepted) but v0.1.0 DEGRADES
// it to "stub" (no live HTTP nodes yet), so CI can never reach a live backend. Layer-2 scenarios are
// driven DETERMINISTICALLY by per-request injections (stubSources / stubQuality / priorBaseline), so a
// fixed request + fixed asOf yields a byte-stable run record. Live source-fetch / A-eval / Ollama-digest
// land behind gates once the stub contract is pinned (see ADR-0001 implementation note).

const runOnSchedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.2,
  config: {
    name: 'Run Weekly (Schedule)',
    position: [160, 200],
    parameters: {
      rule: {
        interval: [
          { field: 'weeks', weeksInterval: 1, triggerAtDay: [1], triggerAtHour: 6, triggerAtMinute: 0 }
        ]
      }
    }
  },
  output: [{}]
});

const runFromUi = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Run Demo From n8n UI',
    position: [160, 460]
  },
  output: [{}]
});

const receiveRunRequest = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Receive Run Request (on-demand)',
    position: [160, 700],
    parameters: {
      httpMethod: 'POST',
      path: 'portfolio/scheduled-drift-monitor',
      authentication: 'none',
      responseMode: 'responseNode',
      options: { allowedOrigins: '*' }
    }
  }
});

const buildDemoRunConfig = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Demo Run Config',
    position: [420, 460],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0]?.json ?? {};
if (Object.keys(input).length > 0) {
  return [{ json: { ...input, manualExecution: true } }];
}
// Default demo: a DRIFT-DETECTED run (quality regressed 1.0 -> 0.83 + one source changed) so the editor
// demo shows the headline "drift caught" path. all-clear / stale / unreachable scenarios are exercised
// by the Layer-2 suite via the same injection knobs.
return [{
  json: {
    manualExecution: true,
    runId: 'run_demo',
    asOf: '2026-05-31',
    stubQuality: { passRate: 0.83, perRubric: { 'connected-product-feedback': 0.83, 'connected-rag-abstain': 1 } },
    stubSources: { 'institutepm-2026': { fingerprintNow: 'ffffffff' } }
  }
}];`
    }
  }
});

const normalizeRunConfig = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Run Config',
    position: [680, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const source = items[0]?.json ?? {};
const body = source.body ?? source;
const entrypoint = (source.manualExecution === true || body.manualExecution === true)
  ? 'manual'
  : (Object.prototype.hasOwnProperty.call(source, 'body') ? 'webhook' : 'schedule');
const text = (v) => String(v ?? '').trim();
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// mode: live is NORMALIZED but v0.1.0 DEGRADES it to stub (no live HTTP nodes yet) — a misconfigured
// request can never hit a live backend in the offline suite. requestedMode preserves the raw ask.
const requestedMode = text(body.mode).toLowerCase() === 'live' ? 'live' : 'stub';
const mode = requestedMode; // v0.2.0: live is WIRED (opt-in). stub remains the default + the only path CI touches.
// reportOnly defaults TRUE (detect + recommend, never auto-write B's KB).
const reportOnly = body.reportOnly === false ? false : true;
const driftThreshold = num(body.driftThreshold, 0.05);
const staleAfterDays = num(body.staleAfterDays, 90);
const asOf = text(body.asOf) || new Date().toISOString().slice(0, 10);
const monitors = Array.isArray(body.monitors) && body.monitors.length ? body.monitors : ['freshness', 'quality'];

// Deterministic Layer-2 scenario injections (the request DRIVES the stub collectors):
//   stubSources: { <sourceId>: { fingerprintNow?: string, statusHint?: 'unreachable' } }
//   stubQuality: { passRate?: number, perRubric?: object }   (the current eval reading)
//   priorBaseline: partial override of the embedded PRIOR_BASELINE
//   stubDigestProse: adversarial summarizer prose (a string) routed through the digest path so the
//     digest-integrity invariant can be tested as a NEGATIVE — prose that states a pass-rate the data
//     does not show MUST flip digestIntegrity.passed=false.
const isObj = (v) => v && typeof v === 'object';
const stubSources = isObj(body.stubSources) ? body.stubSources : {};
const stubQuality = isObj(body.stubQuality) ? body.stubQuality : null;
const priorBaseline = isObj(body.priorBaseline) ? body.priorBaseline : null;
const stubDigestProse = typeof body.stubDigestProse === 'string' ? body.stubDigestProse : null;

// summarySource: the digest prose engine. DEFAULT stub; in live mode default ollama; explicit 'stub' wins.
const summarySource = text(body.summarySource).toLowerCase() === 'stub' ? 'stub' : (mode === 'live' ? 'ollama' : 'stub');

// Optional correlation id: capture-and-echo only (never generated, so the deterministic offline differential
// stays reproducible). traceId falls back to requestId when traceId is absent; null when neither is supplied
// (a bare scheduled run carries none -> null). It is threaded onto runtime.traceId and echoed by the audit
// event + the run-output record (additive: when absent it is null and changes nothing else — it feeds NO
// id/hash/digest seed and is kept OUT of the digest prose so the digest-integrity prose scan never sees it).
const traceId = body.traceId ?? body.requestId ?? null;
// SSRF GUARD: the *Url overrides below drive server-side POSTs from INSIDE the n8n container. The
// on-demand webhook is unauthenticated (a public surface), so a caller-supplied URL arriving via the
// 'webhook' entrypoint is IGNORED — only the trusted 'manual'/'schedule' entrypoints may retarget these
// fetches, so a public caller can never redirect them to an internal/metadata host (169.254.x.x, etc.).
const trustOverrides = entrypoint !== 'webhook';
const pick = (v, def) => ((trustOverrides && text(v)) ? text(v) : def);
// Live endpoints — the workflow runs INSIDE the n8n container, which reaches host services (incl. the
// same n8n that hosts Project A) via host.docker.internal.
const aEvalUrl = pick(body.aEvalUrl, 'http://host.docker.internal:5678/webhook/portfolio/llm-eval-harness');
const ragSutUrl = pick(body.ragSutUrl, 'http://host.docker.internal:5678/webhook/portfolio/rag-knowledge-assistant');
const ollamaChatUrl = pick(body.ollamaChatUrl, 'http://host.docker.internal:11434/api/chat');
const genModel = text(body.genModel) || 'llama3.2:3b';
const userAgent = text(body.userAgent) || 'n8n';

return [{
  json: {
    request: {
      runId: text(body.runId) || ('run_' + Date.now().toString(36)),
      requestedAt: text(body.requestedAt) || new Date().toISOString()
    },
    runtime: { entrypoint, mode, requestedMode, summarySource, reportOnly, driftThreshold, staleAfterDays, asOf, monitors, traceId, aEvalUrl, ragSutUrl, ollamaChatUrl, genModel, userAgent },
    inject: { stubSources, stubQuality, priorBaseline, stubDigestProse },
    sourcePayloadKeys: Object.keys(body)
  }
}];`
    }
  }
});

const loadPriorBaseline = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Load Prior Baseline',
    position: [940, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
// The rolling baseline (the prior run the current run is compared against). n8n cannot read repo files
// at runtime, so the pinned baseline is an EMBEDDED constant (mirrors B's CORPUS-as-constant); the live
// path will read/update it from a store. A scenario can override it via inject.priorBaseline.
const PRIOR_BASELINE = {
  runId: 'run_baseline',
  asOf: '2026-05-24',
  passRate: 1,
  perRubric: { 'connected-product-feedback': 1, 'connected-rag-abstain': 1 }
};
const baseline = input.inject.priorBaseline ? { ...PRIOR_BASELINE, ...input.inject.priorBaseline } : PRIOR_BASELINE;
return [{ json: { ...input, baseline } }];`
    }
  }
});

const collectSources = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'M1 Collect Sources (stub)',
    position: [1200, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
// SOURCE_MANIFEST — D's pinned snapshot of B's allowlisted corpus sources (sourceId, url, the chunkIds
// it backs, a content fingerprint = the last-known-good hash, and retrievedAt). Source of truth for the
// live fetch contract; in stub mode the "fetched" fingerprint == the manifest fingerprint (unchanged)
// unless a scenario injects an override. (Subset of B's 13-chunk corpus, grouped by source url.)
const SOURCE_MANIFEST = [
  { sourceId: 'svpg-ai-pm', url: 'https://www.svpg.com/ai-product-management/', chunkIds: ['pm-more-essential', 'genuine-value'], fingerprint: 'a1b2c3d4', retrievedAt: '2026-05-31' },
  { sourceId: 'lennys-evals', url: 'https://www.lennysnewsletter.com/p/beyond-vibe-checks-a-pms-complete', chunkIds: ['evals-defining-skill'], fingerprint: 'e5f6a7b8', retrievedAt: '2026-05-31' },
  { sourceId: 'institutepm-2026', url: 'https://www.institutepm.com/knowledge-hub/how-to-become-an-ai-product-manager-2026', chunkIds: ['how-to-learn', 'portfolio-proof', 'three-skill-clusters'], fingerprint: '0c1d2e3f', retrievedAt: '2026-05-31' },
  { sourceId: 'feishu-yujun', url: 'https://docs.feishu.cn/article/wiki/EzRKwB8NDi2gd0keAhhce6hFn8g', chunkIds: ['yujun-growth', 'yujun-user-value'], fingerprint: '4a5b6c7d', retrievedAt: '2026-05-31' },
  { sourceId: 'woshipm-hanniman', url: 'https://www.woshipm.com/pmd/5396083.html', chunkIds: ['hanniman-humanity'], fingerprint: '8e9f0a1b', retrievedAt: '2026-05-31' },
  { sourceId: 'hf-llm-course', url: 'https://github.com/mlabonne/llm-course', chunkIds: ['rag-eval-faithfulness'], fingerprint: '2c3d4e5f', retrievedAt: '2026-05-31' }
];
if (input.runtime.mode === 'live') {
  // LIVE M1: GET each allowlisted URL (non-browser UA), fingerprint the body (FNV-1a) and RECORD it.
  // A non-2xx / network error degrades THAT source to unreachable — never crashes the run. fetchSource 'http'.
  // NOTE: the workflow has NO persisted prior fingerprint (the embedded manifest value is a stub-mode
  // baseline, not a real cross-run one), so the live path does NOT derive a 'changed' verdict from it —
  // doing so would be a guaranteed false alarm on every run. Real cross-run change-detection is the host
  // loop's job (Refresh-Sources.ps1, persisted SHA-256). Live M1 = reachability + staleness; fingerprintNow
  // is recorded for the future persisted-baseline increment.
  function fnv(v){let h=2166136261;const t=String(v);for(let i=0;i<t.length;i+=1){h^=t.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,'0');}
  const ua = input.runtime.userAgent || 'n8n';
  const collectedLive = [];
  for (const s of SOURCE_MANIFEST) {
    let fingerprintNow = null; let statusHint = null;
    try {
      const res = await this.helpers.httpRequest({ method: 'GET', url: s.url, headers: { 'User-Agent': ua, 'Accept': 'text/html,application/xhtml+xml' }, timeout: 20000, returnFullResponse: false });
      const bodyText = typeof res === 'string' ? res : JSON.stringify(res);
      fingerprintNow = fnv(bodyText);
    } catch (e) { statusHint = 'unreachable'; }
    collectedLive.push({ sourceId: s.sourceId, url: s.url, chunkIds: s.chunkIds, retrievedAt: s.retrievedAt, fingerprintPrev: s.fingerprint, fingerprintNow, statusHint });
  }
  return [{ json: { ...input, freshness: { fetchSource: 'http', collected: collectedLive } } }];
}

const overrides = input.inject.stubSources || {};
const collected = SOURCE_MANIFEST.map((s) => {
  const o = overrides[s.sourceId] || {};
  const unreachable = o.statusHint === 'unreachable';
  return {
    sourceId: s.sourceId,
    url: s.url,
    chunkIds: s.chunkIds,
    retrievedAt: s.retrievedAt,
    fingerprintPrev: s.fingerprint,
    fingerprintNow: unreachable ? null : (typeof o.fingerprintNow === 'string' ? o.fingerprintNow : s.fingerprint),
    statusHint: o.statusHint || null
  };
});
return [{ json: { ...input, freshness: { fetchSource: 'stub', collected } } }];`
    }
  }
});

const detectSourceDrift = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'M1 Detect Source Drift',
    position: [1460, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const asOf = input.runtime.asOf;
const staleAfterDays = input.runtime.staleAfterDays;
function ageDays(d) {
  const a = Date.parse(asOf + 'T00:00:00Z');
  const b = Date.parse(String(d) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((a - b) / 86400000);
}
// Per source: unreachable (no fingerprint) -> changed (fingerprint differs) -> stale (age > window) ->
// unchanged. The two failure modes the eval-plan guards: a MISSED change (false negative) and a FALSE
// alarm (false positive) — both deterministic given the injected scenario.
// LIVE vs STUB: the n8n workflow has NO persisted prior fingerprint, so a live content-change verdict
// would be meaningless (the embedded manifest value is a stub baseline, not a real cross-run one) and
// would false-alarm on EVERY run. In live mode the 'changed' branch is therefore SKIPPED — live M1
// reports reachability + staleness only; real cross-run change-detection is the host loop's job
// (Refresh-Sources.ps1, persisted SHA-256). The 'changed' verdict is exercised by the stub scenarios.
const liveFetch = input.freshness.fetchSource === 'http';
const sources = input.freshness.collected.map((s) => {
  const age = ageDays(s.retrievedAt);
  let status;
  if (s.statusHint === 'unreachable' || s.fingerprintNow === null) status = 'unreachable';
  else if (!liveFetch && s.fingerprintNow !== s.fingerprintPrev) status = 'changed';
  else if (age !== null && age > staleAfterDays) status = 'stale';
  else status = 'unchanged';
  return { sourceId: s.sourceId, url: s.url, chunkIds: s.chunkIds, status, ageDays: age, fingerprintPrev: s.fingerprintPrev, fingerprintNow: s.fingerprintNow };
});
const changed = sources.filter((s) => s.status === 'changed').length;
const stale = sources.filter((s) => s.status === 'stale').length;
const unreachable = sources.filter((s) => s.status === 'unreachable').length;
// DETECT-ONLY: the workflow recommends which chunks to re-curate but performs ZERO live writes
// (reembedded is always 0 here) — refresh-gating holds by construction. The gated re-embed is a reviewed
// harness action (delegating to B's Ingest-Corpus.ps1), landing with the live increment.
const reembedRecommended = sources.filter((s) => s.status === 'changed').reduce((acc, s) => acc.concat(s.chunkIds), []);
return [{ json: { ...input, freshness: { fetchSource: input.freshness.fetchSource, sources, changed, stale, unreachable, reembedRecommended, reembedded: 0 } } }];`
    }
  }
});

const collectEvalReading = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'M2 Collect Eval Reading (stub)',
    position: [1720, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const baseline = input.baseline;
const inj = input.inject.stubQuality;

if (input.runtime.mode === 'live') {
  // LIVE M2: POST a connected-eval slice to Project A's eval webhook — A grades B's abstention as a
  // black-box SUT (sutExtract:'abstained') and returns passRate. A drop in B's health lowers A's
  // passRate -> D flags quality drift (the eval-gated loop, A->B->D). onError -> degrade to baseline.
  const slice = {
    runId: 'drift-monitor-' + (input.request.runId || 'live'),
    sutMode: 'workflow',
    sutExtract: 'abstained',
    sutWebhookUrl: input.runtime.ragSutUrl,
    golden: [
      { id: 'rag-in-corpus', input: { query: '写好 eval 对 AI 产品经理有多重要?' }, expected: 'false', assertions: { equals: 'false', maxLength: 8 } },
      { id: 'rag-out-of-corpus', input: { query: '法国的首都是哪里?' }, expected: 'true', assertions: { equals: 'true', maxLength: 8 } }
    ]
  };
  try {
    const res = await this.helpers.httpRequest({ method: 'POST', url: input.runtime.aEvalUrl, headers: { 'Content-Type': 'application/json', 'User-Agent': input.runtime.userAgent || 'n8n' }, body: slice, json: true, timeout: 120000 });
    const r = (res && typeof res === 'object' && res.body) ? res.body : res;
    const passRate = (r && Number.isFinite(Number(r.passRate))) ? Number(r.passRate) : null;
    if (passRate === null) { throw new Error('no passRate in A eval response'); }
    const perRubric = {};
    for (const c of (r && Array.isArray(r.results) ? r.results : [])) { perRubric[String(c.caseId || c.id)] = (c.passed === true || String(c.passed) === 'true') ? 1 : 0; }
    return [{ json: { ...input, quality: { current: { passRate, perRubric: (Object.keys(perRubric).length ? perRubric : baseline.perRubric) }, evalSource: 'workflow' } } }];
  } catch (e) {
    // A unreachable / shape drift -> degrade to the baseline reading, labelled truthfully.
    return [{ json: { ...input, quality: { current: { passRate: baseline.passRate, perRubric: baseline.perRubric }, evalSource: 'workflow-fallback' } } }];
  }
}
// Stub eval reading: the current quality reading. DEFAULT == the baseline (no drift) so a bare scheduled
// stub run is correctly "all-clear"; a scenario injects stubQuality to simulate the current A-eval result.
// The live path replaces this with a real POST to Project A's eval webhook (evalSource:'workflow').
const current = inj
  ? {
      passRate: Number.isFinite(Number(inj.passRate)) ? Number(inj.passRate) : baseline.passRate,
      perRubric: (inj.perRubric && typeof inj.perRubric === 'object') ? inj.perRubric : baseline.perRubric
    }
  : { passRate: baseline.passRate, perRubric: baseline.perRubric };
return [{ json: { ...input, quality: { current, evalSource: 'stub' } } }];`
    }
  }
});

const detectQualityDrift = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'M2 Detect Quality Drift',
    position: [1980, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const cur = input.quality.current;
const base = input.baseline;
const round = (n) => Number(Number(n).toFixed(4));
const passRate = round(cur.passRate);
const passRatePrev = round(base.passRate);
const passRateDelta = round(passRate - passRatePrev);
// Time-series drift vs the PRIOR run (distinct from A's single-baseline regressionDelta): a regression is
// a drop beyond the threshold band. A rise (or a within-band wiggle) is NOT a regression (no false alarm).
const regressed = passRateDelta < -input.runtime.driftThreshold;
const perRubricDelta = {};
const keys = new Set([...Object.keys(cur.perRubric || {}), ...Object.keys(base.perRubric || {})]);
keys.forEach((k) => { perRubricDelta[k] = round(Number(cur.perRubric && cur.perRubric[k] != null ? cur.perRubric[k] : 0) - Number(base.perRubric && base.perRubric[k] != null ? base.perRubric[k] : 0)); });
return [{ json: { ...input, quality: { evalSource: input.quality.evalSource, passRate, passRatePrev, passRateDelta, regressed, perRubric: cur.perRubric, perRubricDelta } } }];`
    }
  }
});

const aggregateRunRecord = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Aggregate Run Record',
    position: [2240, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const f = input.freshness;
const q = input.quality;
// drift.any is the UNION of a quality regression with any non-clean source status; reasons is the single
// source of truth the digest must echo (digest-integrity then verifies the digest did not invent any).
const reasons = [];
if (q.regressed) reasons.push('quality regressed: passRate ' + q.passRatePrev + ' -> ' + q.passRate + ' (delta ' + q.passRateDelta + ')');
if (f.changed > 0) reasons.push(f.changed + ' source(s) changed');
if (f.stale > 0) reasons.push(f.stale + ' source(s) stale');
if (f.unreachable > 0) reasons.push(f.unreachable + ' source(s) unreachable');
return [{ json: { ...input, drift: { any: reasons.length > 0, reasons } } }];`
    }
  }
});

const summarizeDigest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Summarize Digest (stub)',
    position: [2500, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const q = input.quality;
const f = input.freshness;
const d = input.drift;
// DEFAULT stub summarizer: composes the digest DETERMINISTICALLY from the run record (the live path swaps
// in Ollama llama3.2:3b for the prose). A machine-checkable METRICS line is embedded so the integrity node
// can parse the digest's numbers back out and prove they match the record (no fabricated drift).
const metrics = 'METRICS passRate=' + q.passRate + ' passRateDelta=' + q.passRateDelta + ' regressed=' + q.regressed + ' changed=' + f.changed + ' stale=' + f.stale + ' unreachable=' + f.unreachable + ' driftAny=' + d.any;
const headline = d.any ? '检测到漂移' : '无漂移';
const lines = [];
lines.push('# 漂移监控简报 (' + input.runtime.asOf + ')');
lines.push('');
lines.push('状态: ' + headline);
lines.push('');
lines.push('## 回答质量');
lines.push('通过率 ' + q.passRate + ' (上期 ' + q.passRatePrev + ', delta ' + q.passRateDelta + ')' + (q.regressed ? ' — 疑似回归' : ''));
lines.push('');
lines.push('## 语料新鲜度');
lines.push('变更 ' + f.changed + ' · 过期 ' + f.stale + ' · 不可达 ' + f.unreachable);
if (f.reembedRecommended.length) lines.push('建议复审并重嵌入: ' + f.reembedRecommended.join(', '));
lines.push('');
lines.push('## 结论');
lines.push(d.any ? ('发现 ' + d.reasons.length + ' 项漂移信号: ' + d.reasons.join('; ')) : '本期无漂移信号,知识库与质量稳定。');
lines.push('');
lines.push(metrics);
const stubMarkdown = lines.join('\\n');
const titleStr = headline + ' · ' + input.runtime.asOf;

if (input.runtime.summarySource === 'ollama') {
  // LIVE digest: llama3.2:3b writes the PROSE from a fact sheet; the machine-checkable METRICS line is
  // STILL appended deterministically from the run record, so DIGEST-INTEGRITY holds no matter what the
  // model writes (sibling B idiom: model supplies prose, the data supplies the checked facts). onError
  // -> the deterministic stub digest (still integrity-valid), labelled 'ollama-fallback'.
  const factSheet = 'passRate=' + q.passRate + ' prev=' + q.passRatePrev + ' delta=' + q.passRateDelta + ' regressed=' + q.regressed + ' changed=' + f.changed + ' stale=' + f.stale + ' unreachable=' + f.unreachable + ' driftAny=' + d.any + ' reasons=' + JSON.stringify(d.reasons);
  try {
    const res = await this.helpers.httpRequest({ method: 'POST', url: input.runtime.ollamaChatUrl, headers: { 'Content-Type': 'application/json' }, body: { model: input.runtime.genModel || 'llama3.2:3b', stream: false, options: { temperature: 0 }, messages: [ { role: 'system', content: '你是运维监控助手。只依据提供的事实,用简体中文写一段简洁的漂移监控简报(3-5 句);不要编造任何数字或事实。' }, { role: 'user', content: '本期漂移事实: ' + factSheet } ] }, json: true, timeout: 120000 });
    const r = (res && typeof res === 'object' && res.body) ? res.body : res;
    const prose = (r && r.message && typeof r.message.content === 'string') ? r.message.content.trim() : ((r && typeof r.response === 'string') ? r.response.trim() : '');
    if (prose.length === 0) { throw new Error('empty model output'); }
    const md = '# 漂移监控简报 (' + input.runtime.asOf + ')\\n\\n' + prose + '\\n\\n' + metrics;
    return [{ json: { ...input, digest: { title: titleStr, markdown: md, summarySource: 'ollama' } } }];
  } catch (e) {
    return [{ json: { ...input, digest: { title: titleStr, markdown: stubMarkdown, summarySource: 'ollama-fallback' } } }];
  }
}

// Layer-2 adversarial knob: if a scenario injects summarizer prose, route IT (not the deterministic stub
// body) through the digest — the METRICS line is STILL appended from the record, so this exercises whether
// digest-integrity catches prose that contradicts the data (the headline-invariant NEGATIVE test).
if (input.inject && typeof input.inject.stubDigestProse === 'string' && input.inject.stubDigestProse.length) {
  const injectedMd = '# 漂移监控简报 (' + input.runtime.asOf + ')\\n\\n' + input.inject.stubDigestProse + '\\n\\n' + metrics;
  return [{ json: { ...input, digest: { title: titleStr, markdown: injectedMd, summarySource: 'stub-injected' } } }];
}
return [{ json: { ...input, digest: { title: titleStr, markdown: stubMarkdown, summarySource: 'stub' } } }];`
    }
  }
});

const enforceDigestIntegrity = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Enforce Digest Integrity',
    position: [2760, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
// DIGEST-INTEGRITY (the headline invariant; sibling B's citation-integrity transposed to a summary).
// TWO checks, BOTH grounded only in the deterministic run record (the summarizer is never trusted):
//  (1) METRICS LINE — the machine-appended 'key=value' line must equal the record (it wasn't corrupted).
//  (2) PROSE CLAIM  — any PASS-RATE-SHAPED figure (a percentage, or a decimal in [0,1]) the summarizer
//      wrote in prose must equal a rate the record holds, so an LLM (or injected) summary that states a
//      pass-rate the data does not show -> passed=false. (Pre-v0.3.0 only (1) existed, so a fabricated
//      number in the prose passed. Authoritative counts are the METRICS line; bare integers are context.)
const md = String(input.digest.markdown || '');
const q = input.quality;
const f = input.freshness;
const d = input.drift;
function grab(key) {
  const m = md.match(new RegExp(key + '=([^\\\\s]+)'));
  return m ? m[1] : null;
}
const checks = [];
function check(name, actual) {
  const parsed = grab(name);
  const ok = parsed !== null && parsed === String(actual);
  checks.push({ name, ok, parsed, actual: String(actual) });
  return ok;
}
let passed = true;
passed = check('passRate', q.passRate) && passed;
passed = check('passRateDelta', q.passRateDelta) && passed;
passed = check('regressed', q.regressed) && passed;
passed = check('changed', f.changed) && passed;
passed = check('stale', f.stale) && passed;
passed = check('unreachable', f.unreachable) && passed;
passed = check('driftAny', d.any) && passed;

// (2) PROSE CLAIM — scan the prose (digest minus the appended METRICS line; ISO dates stripped so the
// dated title is not read as a metric). Any percentage, or any decimal <= 1, MUST equal a record rate
// (passRate / passRatePrev / |passRateDelta|), compared numerically (so 1.0 / 1 / 100% all reconcile).
const metricsIdx = md.indexOf('METRICS ');
let prose = (metricsIdx >= 0 ? md.slice(0, metricsIdx) : md);
prose = prose.replace(new RegExp('\\\\d{4}-\\\\d{2}-\\\\d{2}', 'g'), ' ');
const eqv = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const rateSet = [q.passRate, q.passRatePrev, Math.abs(q.passRateDelta)];
const pctSet = rateSet.map((r) => r * 100);
const fabricated = [];
const pcts = prose.match(new RegExp('\\\\d+(?:\\\\.\\\\d+)?%', 'g')) || [];
pcts.forEach((tok) => { const v = parseFloat(tok); if (!pctSet.some((p) => eqv(p, v))) fabricated.push(tok); });
const decs = prose.match(new RegExp('\\\\d*\\\\.\\\\d+', 'g')) || [];
decs.forEach((tok) => { const v = parseFloat(tok); if (v <= 1 && !rateSet.some((r) => eqv(r, v))) fabricated.push(tok); });
const proseOk = (fabricated.length === 0);
checks.push({ name: 'prose-no-fabricated-rate', ok: proseOk, parsed: fabricated.join(','), actual: '' });
passed = proseOk && passed;
return [{ json: { ...input, digestIntegrity: { passed, checks }, passed } }];`
    }
  }
});

const buildAuditEvent = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Create Redacted Audit Event',
    position: [3020, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
function hash(value) {
  let h = 2166136261;
  const s = String(value);
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
// Redacted audit: ids + counts + verdicts only — no source urls, no digest prose (masking invariant).
const runSeed = input.request.runId + '|' + (input.runtime.asOf || '');
return [{
  json: {
    ...input,
    auditEvent: {
      auditEventId: 'audit_' + hash(runSeed),
      runId: input.request.runId,
      // Optional caller/gateway-supplied correlation id, captured-and-echoed (never generated); null when absent.
      // It is a string id (not a source url or digest prose), so the masking invariant is unaffected; feeds no id/hash seed.
      traceId: input.runtime.traceId,
      mode: input.runtime.mode,
      reportOnly: input.runtime.reportOnly,
      evalSource: input.quality.evalSource,
      summarySource: input.digest.summarySource,
      driftAny: input.drift.any,
      reasonCount: input.drift.reasons.length,
      changed: input.freshness.changed,
      stale: input.freshness.stale,
      unreachable: input.freshness.unreachable,
      reembedded: input.freshness.reembedded,
      regressed: input.quality.regressed,
      passRate: input.quality.passRate,
      passRateDelta: input.quality.passRateDelta,
      digestIntegrityPassed: input.digestIntegrity.passed,
      policyVersion: 'scheduled-drift-monitor-v0.3.0',
      createdAt: new Date().toISOString()
    }
  }
}];`
    }
  }
});

const buildRunOutput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Run Output',
    position: [3280, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
// The run record — the scorer contract shape from docs/eval-plan.md. entrypoint is surfaced at top level
// so the terminal gate can route manual (editor display) vs scheduled (emit artifact).
return [{
  json: {
    runId: input.request.runId,
    entrypoint: input.runtime.entrypoint,
    // Optional caller/gateway-supplied correlation id, captured-and-echoed (never generated); null when absent
    // (a scheduled run carries none). Surfaced as a structured top-level field only — NOT in the digest prose —
    // so the digest-integrity prose scan never sees it; feeds no id/hash/digest seed (purely additive).
    traceId: input.runtime.traceId,
    asOf: input.runtime.asOf,
    mode: input.runtime.mode,
    requestedMode: input.runtime.requestedMode,
    reportOnly: input.runtime.reportOnly,
    monitors: input.runtime.monitors,
    freshness: {
      fetchSource: input.freshness.fetchSource,
      sources: input.freshness.sources,
      changed: input.freshness.changed,
      stale: input.freshness.stale,
      unreachable: input.freshness.unreachable,
      reembedRecommended: input.freshness.reembedRecommended,
      reembedded: input.freshness.reembedded
    },
    quality: {
      passRate: input.quality.passRate,
      passRatePrev: input.quality.passRatePrev,
      passRateDelta: input.quality.passRateDelta,
      regressed: input.quality.regressed,
      perRubric: input.quality.perRubric,
      perRubricDelta: input.quality.perRubricDelta,
      evalSource: input.quality.evalSource
    },
    drift: input.drift,
    digest: input.digest,
    digestIntegrity: input.digestIntegrity,
    history: { priorRunId: input.baseline.runId, priorAsOf: input.baseline.asOf, baselineUpdated: false },
    passed: input.passed === true,
    auditEvent: input.auditEvent,
    policyVersion: 'scheduled-drift-monitor-v0.3.0',
    processedAt: new Date().toISOString()
  }
}];`
    }
  }
});

const runEntrypointGate = ifElse({
  version: 2.3,
  config: {
    name: 'Manual UI Execution?',
    position: [3540, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'manual-ui-execution',
          leftValue: expr('{{ $json.entrypoint === "manual" }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const showRunResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Show Run Result',
    position: [3800, 180],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
return [{
  json: {
    ok: true,
    executionMode: 'manual-ui',
    run: input,
    note: 'Terminal result for n8n editor Execute Workflow. Scheduled executions emit the digest artifact instead.'
  }
}];`
    }
  },
  output: [{ ok: true, executionMode: 'manual-ui' }]
});

const emitDigest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Emit Digest Artifact',
    position: [3800, 440],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
// Scheduled emit: in stub mode the run record + digest ARE the artifact (the harness persists them under
// artifacts/runs/ and, opt-in, pushes to DIGEST_NOTIFY_WEBHOOK_URL). reportOnly default => notified:false
// and no live writes occurred anywhere in this run.
return [{
  json: {
    ok: true,
    executionMode: 'scheduled',
    emitted: { artifact: 'artifacts/runs/' + input.runId + '.json', notified: false },
    run: input
  }
}];`
    }
  }
});

const returnResponse = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Return Run Record',
    position: [3820, 460],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json }}',
      options: { responseCode: 200 }
    }
  }
});

const webhookExecutionGate = ifElse({
  version: 2.3,
  config: {
    name: 'Webhook Execution?',
    position: [3540, 460],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'webhook-execution',
          leftValue: expr('{{ $json.entrypoint === "webhook" }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const overview = sticky(
  '## Scheduled Drift Monitor v0.3.0 (stub default + opt-in live; cron + monitoring — the first scheduled + monitoring workflow in the portfolio). On a SCHEDULE (default weekly) or a manual editor run, two pluggable monitors run and an integrity-checked digest is emitted. Monitor 1 (Corpus Freshness): checks the allowlisted corpus sources of Project B -> unchanged|changed|stale|unreachable. STUB mode drives the changed verdict from an injected fingerprint; LIVE mode has no persisted prior fingerprint, so it reports reachability + staleness only (real cross-run change-detection is the host loop Refresh-Sources.ps1, persisted SHA-256). Serves the RAG periodic refresh for B = B ADR-0004 option C. DETECT-ONLY: no Supabase-write node exists here, so refresh-gating (zero live writes) holds BY CONSTRUCTION; the gated re-embed is a reviewed harness action landing with the live increment. Monitor 2 (Answer-Quality Drift): compares a quality reading to the prior run baseline -> regressed? (a time-series drift, distinct from the single-baseline regressionDelta in A). The two are aggregated (drift.any = quality regressed OR any source changed/stale/unreachable), a digest is summarized FROM the run record, and DIGEST-INTEGRITY is enforced in TWO record-grounded checks (the summarizer is never trusted): (1) the machine-appended METRICS line is recomputed from the record, and (2) any pass-rate-shaped figure (a percentage or a decimal in [0,1]) in the summarizer prose must equal a record rate — so an LLM that states a passRate the data does not show fails the run (sibling B citation-integrity transposed to a summary; proven by the digest-fabricated-prose negative scenario). STUB-DEFAULT everywhere CI touches (stub is the default + the only path verify:static/json/live touch), so the offline suite stays deterministic; Layer-2 scenarios are driven by per-request injections (stubSources / stubQuality / priorBaseline). The LIVE path (mode:live, opt-in) is WIRED: live source-fetch (allowlisted URLs, non-browser UA) + live A-eval (Project A grades B as a black-box SUT and returns passRate) + live Ollama llama3.2:3b digest prose — each onError-tolerant (degrades to stub), exercised by verify:drift-live. Caller-supplied URL overrides are honored only from the trusted manual/schedule entrypoints; the unauthenticated webhook entrypoint IGNORES them (SSRF guard). The digest METRICS line is always pinned from the run record, so digest-integrity holds even under the live LLM. The gated re-embed (delegating to B Ingest-Corpus.ps1) + Monitor 3 remain deferred. policyVersion scheduled-drift-monitor-v0.3.0.',
  [runOnSchedule, runFromUi, receiveRunRequest, buildDemoRunConfig, normalizeRunConfig, loadPriorBaseline, collectSources, detectSourceDrift, collectEvalReading, detectQualityDrift, aggregateRunRecord, summarizeDigest, enforceDigestIntegrity, buildAuditEvent, buildRunOutput, webhookExecutionGate, runEntrypointGate, returnResponse],
  { name: 'scheduled-drift-monitor overview', color: 4 }
);

// Callable as a sub-workflow by the interaction-gateway via Execute Workflow (in-process). Feeds the SAME
// Normalize Run Config pipeline as the on-demand webhook (tolerates passthrough via `source.body ?? source`),
// so schedule + webhook contracts are unchanged. respondToWebhook is a no-op in a sub-workflow call — the
// caller receives the run record. On-demand drift run; stub-default.
const calledByGateway = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: { name: 'Called By Gateway (Execute Workflow)', position: [160, 940], parameters: { inputSource: 'passthrough' } }
});

export default workflow('scheduled-drift-monitor', 'Portfolio - Scheduled Drift Monitor')
  .add(overview)
  .add(runOnSchedule)
  .to(normalizeRunConfig)
  .to(loadPriorBaseline)
  .to(collectSources)
  .to(detectSourceDrift)
  .to(collectEvalReading)
  .to(detectQualityDrift)
  .to(aggregateRunRecord)
  .to(summarizeDigest)
  .to(enforceDigestIntegrity)
  .to(buildAuditEvent)
  .to(buildRunOutput)
  .to(webhookExecutionGate
    .onTrue(returnResponse)
    .onFalse(runEntrypointGate
      .onTrue(showRunResult)
      .onFalse(emitDigest)
    )
  )
  .add(runFromUi)
  .to(buildDemoRunConfig)
  .to(normalizeRunConfig)
  .add(receiveRunRequest)
  .to(normalizeRunConfig)
  .add(calledByGateway)
  .to(normalizeRunConfig);
