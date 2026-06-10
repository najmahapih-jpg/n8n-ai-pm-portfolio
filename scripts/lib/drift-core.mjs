// drift-core.mjs — the scheduled-drift-monitor's PURE deterministic stub-path logic (single source of truth;
// the n8n Code nodes mirror these). No n8n, no network: assertable in-process by test-drift-workflow.mjs.
//
// SCOPE: this core reproduces the DETERMINISTIC STUB PATH only — the offline, reproducible lane the Layer-2
// suite (verify:static / CI) exercises. That path is the linear Code-node chain:
//   Normalize Run Config -> Load Prior Baseline -> M1 Collect Sources (stub) -> M1 Detect Source Drift
//   -> M2 Collect Eval Reading (stub) -> M2 Detect Quality Drift -> Aggregate Run Record
//   -> Summarize Digest (stub) -> Enforce Digest Integrity -> Create Redacted Audit Event -> Build Run Output
// The LIVE branches (mode:'live' source-fetch / A-eval, summarySource:'ollama' Ollama digest) call siblings /
// Ollama over HTTP and are NOT mirrored here — they are not part of the offline gate (they belong to
// verify:drift-live, which onError-degrades to stub). test-drift-workflow.mjs executes the COMPILED jsCode of
// each node above and asserts it is byte-behaviour-identical to the functions below over the golden/regression
// fixtures (the differential).
//
// BEHAVIOR-PRESERVING CONTRACT: each function is a verbatim reverse-extract of the corresponding node's body
// (stub path). Regex/unicode literals use the SINGLE-escaped form (e.g. /([^\s]+)/, the CJK strings), which is
// exactly what the compiled node's source evaluates to at runtime (the SDK double-escapes in the .js so the
// JSON-embedded copy single-escapes after JSON.parse). The core mirrors the node, never the other way around.
//
// The POLICY_VERSION below MUST match the literal 'scheduled-drift-monitor-v0.3.0' baked into the compiled
// nodes; if a future recompile bumps it the differential fails loudly until the core is re-synced (the guard).
export const POLICY_VERSION = 'scheduled-drift-monitor-v0.3.0';

// ---------------------------------------------------------------------------------------------------------
// (1) normalizeRunConfig — mirror of the 'Normalize Run Config' Code node (deterministic fields only).
// The node defaults request.runId to 'run_'+Date.now() and request.requestedAt to new Date().toISOString()
// when absent; those are the only nondeterminism. The differential pins both by SUPPLYING runId + requestedAt
// in the request, so the records compare byte-identical. When opts.now/opts.runIdFallback are absent (direct
// core calls) it falls back to wall-clock exactly like the node.
// ---------------------------------------------------------------------------------------------------------
export function normalizeRunConfig(source, opts = {}) {
  source = source ?? {};
  const body = source.body ?? source;
  const entrypoint = (source.manualExecution === true || body.manualExecution === true)
    ? 'manual'
    : (Object.prototype.hasOwnProperty.call(source, 'body') ? 'webhook' : 'schedule');
  const text = (v) => String(v ?? '').trim();
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

  const requestedMode = text(body.mode).toLowerCase() === 'live' ? 'live' : 'stub';
  const mode = requestedMode;
  const reportOnly = body.reportOnly === false ? false : true;
  const driftThreshold = num(body.driftThreshold, 0.05);
  const staleAfterDays = num(body.staleAfterDays, 90);
  const nowIso = opts.now != null ? String(opts.now) : new Date().toISOString();
  const asOf = text(body.asOf) || nowIso.slice(0, 10);
  const monitors = Array.isArray(body.monitors) && body.monitors.length ? body.monitors : ['freshness', 'quality'];

  const isObj = (v) => v && typeof v === 'object';
  const stubSources = isObj(body.stubSources) ? body.stubSources : {};
  const stubQuality = isObj(body.stubQuality) ? body.stubQuality : null;
  const priorBaseline = isObj(body.priorBaseline) ? body.priorBaseline : null;
  const stubDigestProse = typeof body.stubDigestProse === 'string' ? body.stubDigestProse : null;

  const summarySource = text(body.summarySource).toLowerCase() === 'stub' ? 'stub' : (mode === 'live' ? 'ollama' : 'stub');

  // Optional correlation id: capture-and-echo only (never generated). traceId falls back to requestId, then null
  // (a bare scheduled run carries none). Threaded onto runtime.traceId; echoed by the audit event + run-output
  // record. Additive: feeds NO id/hash/digest seed and is kept OUT of the digest prose (digest-integrity safe).
  const traceId = body.traceId ?? body.requestId ?? null;

  const trustOverrides = entrypoint !== 'webhook';
  const pick = (v, def) => ((trustOverrides && text(v)) ? text(v) : def);
  const aEvalUrl = pick(body.aEvalUrl, 'http://host.docker.internal:5678/webhook/portfolio/llm-eval-harness');
  const ragSutUrl = pick(body.ragSutUrl, 'http://host.docker.internal:5678/webhook/portfolio/rag-knowledge-assistant');
  const ollamaChatUrl = pick(body.ollamaChatUrl, 'http://host.docker.internal:11434/api/chat');
  const genModel = text(body.genModel) || 'llama3.2:3b';
  const userAgent = text(body.userAgent) || 'n8n';

  // The node uses Date.now()/new Date() when these are absent; the core takes them via opts so the
  // differential can pin both sides to the same instant. Falls back to wall-clock exactly like the node.
  const runIdFallback = opts.runIdFallback != null ? String(opts.runIdFallback) : ('run_' + Date.now().toString(36));

  return {
    request: {
      runId: text(body.runId) || runIdFallback,
      requestedAt: text(body.requestedAt) || nowIso
    },
    runtime: { entrypoint, mode, requestedMode, summarySource, reportOnly, driftThreshold, staleAfterDays, asOf, monitors, traceId, aEvalUrl, ragSutUrl, ollamaChatUrl, genModel, userAgent },
    inject: { stubSources, stubQuality, priorBaseline, stubDigestProse },
    sourcePayloadKeys: Object.keys(body)
  };
}

// ---------------------------------------------------------------------------------------------------------
// (2) loadPriorBaseline — mirror of 'Load Prior Baseline'. The rolling baseline the current run is compared
// against, an EMBEDDED constant (n8n cannot read repo files at runtime); a scenario can override it via
// inject.priorBaseline.
// ---------------------------------------------------------------------------------------------------------
export function loadPriorBaseline(input) {
  const PRIOR_BASELINE = {
    runId: 'run_baseline',
    asOf: '2026-05-24',
    passRate: 1,
    perRubric: { 'connected-product-feedback': 1, 'connected-rag-abstain': 1 }
  };
  const baseline = input.inject.priorBaseline ? { ...PRIOR_BASELINE, ...input.inject.priorBaseline } : PRIOR_BASELINE;
  return { ...input, baseline };
}

// ---------------------------------------------------------------------------------------------------------
// (3) collectSourcesStub — mirror of 'M1 Collect Sources (stub)' STUB PATH. The pinned SOURCE_MANIFEST (D's
// snapshot of B's allowlisted corpus sources); in stub mode the "fetched" fingerprint == the manifest
// fingerprint (unchanged) unless a scenario injects an override. The live HTTP branch is out of scope.
// ---------------------------------------------------------------------------------------------------------
export const SOURCE_MANIFEST = [
  { sourceId: 'svpg-ai-pm', url: 'https://www.svpg.com/ai-product-management/', chunkIds: ['pm-more-essential', 'genuine-value'], fingerprint: 'a1b2c3d4', retrievedAt: '2026-05-31' },
  { sourceId: 'lennys-evals', url: 'https://www.lennysnewsletter.com/p/beyond-vibe-checks-a-pms-complete', chunkIds: ['evals-defining-skill'], fingerprint: 'e5f6a7b8', retrievedAt: '2026-05-31' },
  { sourceId: 'institutepm-2026', url: 'https://www.institutepm.com/knowledge-hub/how-to-become-an-ai-product-manager-2026', chunkIds: ['how-to-learn', 'portfolio-proof', 'three-skill-clusters'], fingerprint: '0c1d2e3f', retrievedAt: '2026-05-31' },
  { sourceId: 'feishu-yujun', url: 'https://docs.feishu.cn/article/wiki/EzRKwB8NDi2gd0keAhhce6hFn8g', chunkIds: ['yujun-growth', 'yujun-user-value'], fingerprint: '4a5b6c7d', retrievedAt: '2026-05-31' },
  { sourceId: 'woshipm-hanniman', url: 'https://www.woshipm.com/pmd/5396083.html', chunkIds: ['hanniman-humanity'], fingerprint: '8e9f0a1b', retrievedAt: '2026-05-31' },
  { sourceId: 'hf-llm-course', url: 'https://github.com/mlabonne/llm-course', chunkIds: ['rag-eval-faithfulness'], fingerprint: '2c3d4e5f', retrievedAt: '2026-05-31' }
];

export function collectSourcesStub(input) {
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
  return { ...input, freshness: { fetchSource: 'stub', collected } };
}

// ---------------------------------------------------------------------------------------------------------
// (4) detectSourceDrift — mirror of 'M1 Detect Source Drift'. Per source: unreachable -> changed -> stale ->
// unchanged. The 'changed' branch is SKIPPED when fetchSource==='http' (live has no persisted prior); in stub
// mode liveFetch is false so the 'changed' verdict is reachable (exercised by the stub scenarios).
// ---------------------------------------------------------------------------------------------------------
export function detectSourceDrift(input) {
  const asOf = input.runtime.asOf;
  const staleAfterDays = input.runtime.staleAfterDays;
  function ageDays(d) {
    const a = Date.parse(asOf + 'T00:00:00Z');
    const b = Date.parse(String(d) + 'T00:00:00Z');
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.floor((a - b) / 86400000);
  }
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
  const reembedRecommended = sources.filter((s) => s.status === 'changed').reduce((acc, s) => acc.concat(s.chunkIds), []);
  return { ...input, freshness: { fetchSource: input.freshness.fetchSource, sources, changed, stale, unreachable, reembedRecommended, reembedded: 0 } };
}

// ---------------------------------------------------------------------------------------------------------
// (5) collectEvalReadingStub — mirror of 'M2 Collect Eval Reading (stub)' STUB PATH. The current quality
// reading. DEFAULT == the baseline (no drift); a scenario injects inject.stubQuality to simulate the current
// A-eval result. The live A-eval POST branch is out of scope.
// ---------------------------------------------------------------------------------------------------------
export function collectEvalReadingStub(input) {
  const baseline = input.baseline;
  const inj = input.inject.stubQuality;
  const current = inj
    ? {
        passRate: Number.isFinite(Number(inj.passRate)) ? Number(inj.passRate) : baseline.passRate,
        perRubric: (inj.perRubric && typeof inj.perRubric === 'object') ? inj.perRubric : baseline.perRubric
      }
    : { passRate: baseline.passRate, perRubric: baseline.perRubric };
  return { ...input, quality: { current, evalSource: 'stub' } };
}

// ---------------------------------------------------------------------------------------------------------
// (6) detectQualityDrift — mirror of 'M2 Detect Quality Drift'. Time-series drift vs the PRIOR run: a
// regression is a drop beyond the threshold band. A rise (or within-band wiggle) is NOT a regression.
// ---------------------------------------------------------------------------------------------------------
export function detectQualityDrift(input) {
  const cur = input.quality.current;
  const base = input.baseline;
  const round = (n) => Number(Number(n).toFixed(4));
  const passRate = round(cur.passRate);
  const passRatePrev = round(base.passRate);
  const passRateDelta = round(passRate - passRatePrev);
  const regressed = passRateDelta < -input.runtime.driftThreshold;
  const perRubricDelta = {};
  const keys = new Set([...Object.keys(cur.perRubric || {}), ...Object.keys(base.perRubric || {})]);
  keys.forEach((k) => { perRubricDelta[k] = round(Number(cur.perRubric && cur.perRubric[k] != null ? cur.perRubric[k] : 0) - Number(base.perRubric && base.perRubric[k] != null ? base.perRubric[k] : 0)); });
  return { ...input, quality: { evalSource: input.quality.evalSource, passRate, passRatePrev, passRateDelta, regressed, perRubric: cur.perRubric, perRubricDelta } };
}

// ---------------------------------------------------------------------------------------------------------
// (7) aggregateRunRecord — mirror of 'Aggregate Run Record'. drift.any is the UNION of a quality regression
// with any non-clean source status; reasons is the single source of truth the digest must echo.
// ---------------------------------------------------------------------------------------------------------
export function aggregateRunRecord(input) {
  const f = input.freshness;
  const q = input.quality;
  const reasons = [];
  if (q.regressed) reasons.push('quality regressed: passRate ' + q.passRatePrev + ' -> ' + q.passRate + ' (delta ' + q.passRateDelta + ')');
  if (f.changed > 0) reasons.push(f.changed + ' source(s) changed');
  if (f.stale > 0) reasons.push(f.stale + ' source(s) stale');
  if (f.unreachable > 0) reasons.push(f.unreachable + ' source(s) unreachable');
  return { ...input, drift: { any: reasons.length > 0, reasons } };
}

// ---------------------------------------------------------------------------------------------------------
// (8) summarizeDigestStub — mirror of 'Summarize Digest (stub)' STUB PATH (incl. the stub-injected adversarial
// knob). Composes the digest DETERMINISTICALLY from the run record; a machine-checkable METRICS line is
// embedded so the integrity node can parse the numbers back out. inject.stubDigestProse routes adversarial
// prose through the digest (METRICS still appended from the record) — the negative-test path. The live Ollama
// branch is out of scope. CJK strings are kept verbatim; '\n' is a real newline here (the SDK double-escapes
// in the .js so the JSON-embedded copy is a single-escaped '\n' that yields a newline at runtime).
// ---------------------------------------------------------------------------------------------------------
export function summarizeDigestStub(input) {
  const q = input.quality;
  const f = input.freshness;
  const d = input.drift;
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
  const stubMarkdown = lines.join('\n');
  const titleStr = headline + ' · ' + input.runtime.asOf;

  // Layer-2 adversarial knob: a scenario can route summarizer prose (not the deterministic stub body) through
  // the digest — the METRICS line is STILL appended from the record, so this exercises whether digest-integrity
  // catches prose that contradicts the data (the headline-invariant NEGATIVE test).
  if (input.inject && typeof input.inject.stubDigestProse === 'string' && input.inject.stubDigestProse.length) {
    const injectedMd = '# 漂移监控简报 (' + input.runtime.asOf + ')\n\n' + input.inject.stubDigestProse + '\n\n' + metrics;
    return { ...input, digest: { title: titleStr, markdown: injectedMd, summarySource: 'stub-injected' } };
  }
  return { ...input, digest: { title: titleStr, markdown: stubMarkdown, summarySource: 'stub' } };
}

// ---------------------------------------------------------------------------------------------------------
// (9) enforceDigestIntegrity — mirror of 'Enforce Digest Integrity' (the headline invariant; sibling B's
// citation-integrity transposed to a summary). TWO checks, BOTH grounded only in the deterministic run record
// (the summarizer is never trusted):
//   (1) METRICS LINE — each machine-appended 'key=value' must equal the record (it wasn't corrupted).
//   (2) PROSE CLAIM  — any PASS-RATE-SHAPED figure (a percentage, or a decimal <= 1) in the summarizer prose
//       must equal a rate the record holds (passRate / passRatePrev / |passRateDelta|), compared numerically
//       (so 1.0 / 1 / 100% all reconcile) — so an LLM (or injected) summary that states a pass-rate the data
//       does not show -> passed=false.
// Regex literals match the COMPILED node's single-escaped runtime form exactly: grab() uses key+'=([^\s]+)';
// the ISO-date strip is '\d{4}-\d{2}-\d{2}'; the percentage scan is '\d+(?:\.\d+)?%'; the decimal scan is
// '\d*\.\d+'. (In the .workflow.js these appear quadruple/double-escaped; after compile + JSON.parse they are
// these single-escaped strings, which is what this core must reproduce.)
// ---------------------------------------------------------------------------------------------------------
export function enforceDigestIntegrity(input) {
  const md = String(input.digest.markdown || '');
  const q = input.quality;
  const f = input.freshness;
  const d = input.drift;
  function grab(key) {
    const m = md.match(new RegExp(key + '=([^\\s]+)'));
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

  // (2) PROSE CLAIM — scan the prose (digest minus the appended METRICS line; ISO dates stripped so the dated
  // title is not read as a metric). Any percentage, or any decimal <= 1, MUST equal a record rate.
  const metricsIdx = md.indexOf('METRICS ');
  let prose = (metricsIdx >= 0 ? md.slice(0, metricsIdx) : md);
  prose = prose.replace(new RegExp('\\d{4}-\\d{2}-\\d{2}', 'g'), ' ');
  const eqv = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
  const rateSet = [q.passRate, q.passRatePrev, Math.abs(q.passRateDelta)];
  const pctSet = rateSet.map((r) => r * 100);
  const fabricated = [];
  const pcts = prose.match(new RegExp('\\d+(?:\\.\\d+)?%', 'g')) || [];
  pcts.forEach((tok) => { const v = parseFloat(tok); if (!pctSet.some((p) => eqv(p, v))) fabricated.push(tok); });
  const decs = prose.match(new RegExp('\\d*\\.\\d+', 'g')) || [];
  decs.forEach((tok) => { const v = parseFloat(tok); if (v <= 1 && !rateSet.some((r) => eqv(r, v))) fabricated.push(tok); });
  const proseOk = (fabricated.length === 0);
  checks.push({ name: 'prose-no-fabricated-rate', ok: proseOk, parsed: fabricated.join(','), actual: '' });
  passed = proseOk && passed;
  return { ...input, digestIntegrity: { passed, checks }, passed };
}

// ---------------------------------------------------------------------------------------------------------
// (10) buildAuditEvent — mirror of 'Create Redacted Audit Event'. Redacted audit: ids + counts + verdicts
// only — no source urls, no digest prose (masking invariant). createdAt is the node's new Date().toISOString();
// the differential normalizes it identically on both sides (no override hook, asserted ISO separately).
// ---------------------------------------------------------------------------------------------------------
export function buildAuditEvent(input, opts = {}) {
  function hash(value) {
    let h = 2166136261;
    const s = String(value);
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  const runSeed = input.request.runId + '|' + (input.runtime.asOf || '');
  const createdAt = opts.now != null ? String(opts.now) : new Date().toISOString();
  return {
    ...input,
    auditEvent: {
      auditEventId: 'audit_' + hash(runSeed),
      runId: input.request.runId,
      // Optional caller/gateway-supplied correlation id, captured-and-echoed (never generated); null when absent.
      // A string id (not a source url or digest prose), so the masking invariant is unaffected; feeds no id/hash seed.
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
      policyVersion: POLICY_VERSION,
      createdAt
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (11) buildRunOutput — mirror of 'Build Run Output'. The run record (the scorer contract shape). entrypoint
// is surfaced at top level so the terminal gate can route manual (display) vs scheduled (emit). processedAt is
// new Date().toISOString(); the differential normalizes it identically on both sides (asserted ISO separately).
// ---------------------------------------------------------------------------------------------------------
export function buildRunOutput(input, opts = {}) {
  const processedAt = opts.now != null ? String(opts.now) : new Date().toISOString();
  return {
    runId: input.request.runId,
    entrypoint: input.runtime.entrypoint,
    // Optional caller/gateway-supplied correlation id, captured-and-echoed (never generated); null when absent
    // (a scheduled run carries none). A structured top-level field only — NOT in the digest prose — so the
    // digest-integrity prose scan never sees it; feeds no id/hash/digest seed (purely additive).
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
    policyVersion: POLICY_VERSION,
    processedAt
  };
}

// ---------------------------------------------------------------------------------------------------------
// (13) buildFeishuDigestCard — mirror of the card-building half of 'Notify Feishu Digest'. Builds the outbound
// Feishu interactive card DETERMINISTICALLY from the run record (header colour from drift.any, body = the
// digest markdown the integrity node already verified, footer note = runId + digestIntegrity verdict +
// summarySource), so the digest-integrity guarantee extends to what lands in the group chat. The SEND half
// (env gating, optional custom-bot HMAC signing, this.helpers.httpRequest) is live-only and intentionally NOT
// mirrored — offline, the differential stubs the HTTP helper and proves this card byte-identical instead.
// ---------------------------------------------------------------------------------------------------------
export function buildFeishuDigestCard(run) {
  run = run && typeof run === 'object' ? run : {};
  const d = run.drift && typeof run.drift === 'object' ? run.drift : { any: false, reasons: [] };
  const dg = run.digest && typeof run.digest === 'object' ? run.digest : { title: '', markdown: '', summarySource: '' };
  const integrityPassed = !!(run.digestIntegrity && run.digestIntegrity.passed === true);
  return {
    config: { wide_screen_mode: true },
    header: {
      template: d.any ? 'red' : 'green',
      title: { tag: 'plain_text', content: (d.any ? '🚨 检测到漂移' : '✅ 无漂移') + ' · Scheduled Drift Monitor · ' + String(run.asOf || '') }
    },
    elements: [
      { tag: 'markdown', content: String(dg.markdown || '').slice(0, 4000) },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: 'runId ' + String(run.runId || '') + ' · digestIntegrity ' + (integrityPassed ? 'passed' : 'FAILED') + ' · summarySource ' + String(dg.summarySource || '') }] }
    ]
  };
}

// ---------------------------------------------------------------------------------------------------------
// runStubDrift — convenience composition of the full deterministic stub pipeline. Threads opts.now into the
// timestamp-bearing stages (Normalize requestedAt fallback, Audit createdAt, Build processedAt) + opts.runIdFallback
// into Normalize so a full run is reproducible end-to-end. Returns the Build Run Output record plus every
// intermediate stage (the single entry point the differential and any future direct core test reuse).
// ---------------------------------------------------------------------------------------------------------
export function runStubDrift(source, opts = {}) {
  const normalized = normalizeRunConfig(source, opts);
  const afterBaseline = loadPriorBaseline(normalized);
  const afterCollect = collectSourcesStub(afterBaseline);
  const afterSourceDrift = detectSourceDrift(afterCollect);
  const afterEval = collectEvalReadingStub(afterSourceDrift);
  const afterQualityDrift = detectQualityDrift(afterEval);
  const afterAggregate = aggregateRunRecord(afterQualityDrift);
  const afterDigest = summarizeDigestStub(afterAggregate);
  const afterIntegrity = enforceDigestIntegrity(afterDigest);
  const afterAudit = buildAuditEvent(afterIntegrity, opts);
  const record = buildRunOutput(afterAudit, opts);
  return {
    record,
    normalized,
    baseline: afterBaseline.baseline,
    freshness: afterSourceDrift.freshness,
    quality: afterQualityDrift.quality,
    drift: afterAggregate.drift,
    digest: afterDigest.digest,
    digestIntegrity: afterIntegrity.digestIntegrity,
    auditEvent: afterAudit.auditEvent
  };
}
