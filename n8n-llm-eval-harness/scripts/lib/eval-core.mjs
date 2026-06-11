// eval-core.mjs — the LLM-eval-harness's PURE deterministic stub-path eval logic (single source of truth;
// the n8n Code nodes mirror these). No n8n, no network: assertable in-process by test-eval-workflow.mjs.
//
// SCOPE: this core reproduces the DETERMINISTIC STUB PATH only — the offline, reproducible lane the Layer-2
// suite (verify:static / CI) exercises. That path is the linear Code-node chain:
//   Normalize Eval Request -> Run Subject-Under-Test (stub) -> Run Deterministic Assertions
//   -> LLM-as-Judge (stub) -> Aggregate Eval Run -> Create Redacted Audit Event -> Build Eval Response
// plus the Missing-Golden error branch (Build Missing Golden Error). The LIVE branches (sutMode:'workflow' /
// 'model', judgeSource:'ollama') call siblings/Ollama over HTTP and are NOT mirrored here — they are not part
// of the offline gate. test-eval-workflow.mjs executes the COMPILED jsCode of each node above and asserts it is
// byte-behaviour-identical to the functions below over the golden/calibration fixtures (the differential).
//
// BEHAVIOR-PRESERVING CONTRACT: each function is a verbatim reverse-extract of the corresponding node's body.
// Regex/unicode literals use the SINGLE-escaped form (e.g. /[^\s@]+/, '∷'), which is exactly what the
// compiled node's source evaluates to at runtime (the SDK double-escapes in the .js so the JSON-embedded copy
// single-escapes after JSON.parse). The core mirrors the node, never the other way around.
//
// The POLICY_VERSION below MUST match the literal 'eval-harness-v0.6.0' baked into the compiled nodes; if a
// future recompile bumps it, the differential will fail loudly until the core is re-synced (the intended guard).
export const POLICY_VERSION = 'eval-harness-v0.6.0';

// ---------------------------------------------------------------------------------------------------------
// (1) normalizeEvalRequest — mirror of the 'Normalize Eval Request' Code node (deterministic fields only).
// The node defaults run.requestedAt to new Date().toISOString() when absent; that single timestamp is the
// only nondeterminism in the deterministic chain. The differential injects the SAME requestedAt into both
// sides (via opts.now) so the records — and the requestedAt-derived auditEventId — compare byte-identical.
// It also captures an OPTIONAL correlation id traceId = body.traceId ?? body.requestId ?? null (pure
// passthrough, never generated) onto runtime.traceId, which buildAuditEvent + buildEvalResponse echo. When
// absent it is null and changes nothing else (the additive-null contract; it feeds no id/hash seed).
// ---------------------------------------------------------------------------------------------------------
export function normalizeEvalRequest(source, opts = {}) {
  source = source ?? {};
  const body = source.body ?? source;
  const entrypoint = source.manualExecution === true || body.manualExecution === true ? 'manual' : 'webhook';
  const text = (v) => String(v ?? '').trim();

  // Optional correlation id: capture-and-echo only (never generated, so the deterministic offline differential
  // stays reproducible). traceId falls back to requestId when traceId is absent; null when neither is supplied.
  // It is threaded onto runtime.traceId and echoed by the audit event + the main eval response (additive: when
  // absent it is null and changes nothing else — it feeds NO id/hash seed). Not surfaced on the error response.
  const traceId = body.traceId ?? body.requestId ?? null;

  const rawCases = Array.isArray(body.golden) ? body.golden
    : Array.isArray(body.cases) ? body.cases
    : Array.isArray(body.dataset) ? body.dataset
    : [];

  const normHumanLabel = (c) => {
    const h = c && typeof c.humanLabel === 'object' && c.humanLabel ? c.humanLabel : null;
    if (!h) return null;
    const out = {};
    if (typeof h.passed === 'boolean') out.passed = h.passed;
    const band = Array.isArray(h.groundednessBand) ? h.groundednessBand : null;
    if (band && band.length === 2 && Number.isFinite(Number(band[0])) && Number.isFinite(Number(band[1]))) {
      out.groundednessBand = [Number(band[0]), Number(band[1])];
    }
    return Object.keys(out).length > 0 ? out : null;
  };

  const golden = rawCases.map((c, i) => ({
    id: text(c && c.id) || ('case-' + (i + 1)),
    input: c == null ? '' : (typeof c.input === 'string' ? c.input : (c.input && typeof c.input === 'object' ? c.input : text(c.input))),
    expected: c == null ? '' : (typeof c.expected === 'string' ? c.expected : text(c.expected)),
    assertions: (c && typeof c.assertions === 'object' && c.assertions) ? c.assertions : {},
    humanLabel: normHumanLabel(c),
    hasInput: !!(c && Object.prototype.hasOwnProperty.call(c, 'input')),
    hasExpected: !!(c && Object.prototype.hasOwnProperty.call(c, 'expected'))
  }));

  const validCases = golden.filter((c) => c.hasInput && c.hasExpected);
  const hasValidGolden = validCases.length > 0;

  const requestedMode = (text(body.sutMode) || text(body.mode)).toLowerCase();
  const sutMode = requestedMode === 'model' || requestedMode === 'workflow' ? requestedMode : 'stub';
  const defaultSutModels = ['stub', 'llama3.2:3b'];
  const rawSutModels = Array.isArray(body.sutModels)
    ? body.sutModels.map((m) => text(m)).filter((m) => m.length > 0)
    : [];
  let sutModels;
  if (sutMode === 'model') {
    const requested = rawSutModels.length > 0 ? rawSutModels : defaultSutModels;
    const seen = new Set();
    sutModels = ['stub', ...requested].filter((m) => { if (seen.has(m)) return false; seen.add(m); return true; });
  } else if (sutMode === 'workflow') {
    sutModels = ['workflow'];
  } else {
    sutModels = ['stub'];
  }
  const priceTable = (body.priceTable && typeof body.priceTable === 'object' && !Array.isArray(body.priceTable))
    ? body.priceTable
    : {};
  const sutWebhookUrl = text(body.sutWebhookUrl) || 'http://localhost:5678/webhook/portfolio/product-feedback-intelligence';
  const sutExtract = text(body.sutExtract) || 'response.theme';
  const requestedJudge = text(body.judgeSource).toLowerCase();
  const judgeSource = requestedJudge === 'ollama' || requestedJudge === 'openai' ? requestedJudge : 'stub';
  const judgeModel = text(body.judgeModel) || 'llama3.2:3b';

  const rawBaseline = (body.baseline && typeof body.baseline === 'object' && !Array.isArray(body.baseline)) ? body.baseline : null;
  function normBaseline(b) {
    if (!b) return null;
    const out = {};
    const ov = b.overall && typeof b.overall === 'object' ? b.overall : b;
    if (Number.isFinite(Number(ov.passRate))) out.overall = { passRate: Number(ov.passRate) };
    const pm = Array.isArray(b.perModel) ? b.perModel : [];
    out.perModel = pm
      .filter((m) => m && (typeof m.modelId === 'string') && Number.isFinite(Number(m.passRate)))
      .map((m) => ({ modelId: String(m.modelId), passRate: Number(m.passRate) }));
    const dims = ['groundedness', 'relevance', 'helpfulness', 'safety'];
    const prm = b.perRubricMean && typeof b.perRubricMean === 'object' ? b.perRubricMean : null;
    if (prm) {
      const r = {};
      for (const d of dims) { if (Number.isFinite(Number(prm[d]))) r[d] = Number(prm[d]); }
      if (Object.keys(r).length > 0) out.perRubricMean = r;
    }
    return (out.overall && Number.isFinite(out.overall.passRate)) ? out : null;
  }
  const baseline = normBaseline(rawBaseline);
  const requestedBaselineSource = text(body.baselineSource).toLowerCase();
  const baselineSource = baseline
    ? (requestedBaselineSource === 'fixture' ? 'fixture' : 'request')
    : null;
  const rawTolerance = Number(body.regressionTolerance);
  const regressionTolerance = Number.isFinite(rawTolerance) && rawTolerance >= 0 ? Math.min(rawTolerance, 1) : 0;

  // The node uses Date.now()/new Date() when these are absent; the core takes them via opts so the
  // differential can pin both sides to the same instant. When opts.now is absent (e.g. verify:eval-core
  // direct calls) it falls back to wall-clock exactly like the node.
  const nowIso = opts.now != null ? String(opts.now) : new Date().toISOString();
  const runIdFallback = opts.runIdFallback != null ? String(opts.runIdFallback) : ('run_' + Date.now().toString(36));

  return {
    run: {
      runId: text(body.runId) || runIdFallback,
      requestedAt: text(body.requestedAt) || nowIso
    },
    golden,
    validation: {
      hasValidGolden,
      caseCount: golden.length,
      validCaseCount: validCases.length
    },
    runtime: {
      entrypoint,
      // Optional caller/gateway-supplied correlation id, captured-and-echoed (never generated); null when absent.
      // Echoed by Create Redacted Audit Event + Build Eval Response; feeds no id/hash seed (purely additive).
      traceId,
      sutMode: sutMode === 'workflow' || sutMode === 'model' ? sutMode : 'stub',
      requestedSutMode: sutMode,
      sutModels,
      priceTable,
      sutModelUrl: text(body.sutModelUrl) || 'http://host.docker.internal:11434/api/chat',
      sutWebhookUrl,
      sutExtract,
      judgeSource: judgeSource === 'ollama' ? 'ollama' : 'stub',
      requestedJudgeSource: judgeSource,
      judgeModel,
      baseline,
      baselineSource,
      regressionTolerance
    },
    sourcePayloadKeys: Object.keys(body)
  };
}

// ---------------------------------------------------------------------------------------------------------
// (2) runSubjectStub — mirror of 'Run Subject-Under-Test (stub)'. Echo the input; a HALLUCINATE token emits a
// fixed wrong answer so a groundedness-fail case is modelled deterministically. latencyMs is the node's
// Math.max(1, Date.now()-t0) which the node clamps to >=1; on a fast machine this is 1 — the differential
// asserts the per-row OUTPUT/identity fields (deterministic) and treats the run-level latencyMs as >=1.
// ---------------------------------------------------------------------------------------------------------
export function runSubjectStub(input) {
  const t0 = Date.now();
  const modelId = 'stub';
  const outputs = input.golden.map((c) => {
    const raw = String(c.input ?? '');
    let output = raw;
    if (raw.toUpperCase().includes('HALLUCINATE')) {
      output = 'The capital of France is Berlin.';
    }
    return {
      caseId: c.id,
      modelId,
      rowKey: c.id + '∷' + modelId,
      output,
      latencyMs: 1,
      totalTokens: null,
      estCostUsd: 0,
      costBasis: 'local-free',
      sutSource: 'stub'
    };
  });
  return {
    ...input,
    sut: {
      mode: 'stub',
      latencyMs: Math.max(1, Date.now() - t0),
      outputs
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (3) runDeterministicAssertions — mirror of 'Run Deterministic Assertions'. The proven 5-type taxonomy
// (schema/range/format/absence/masking) scored per SUT row, matched to its case by caseId.
// ---------------------------------------------------------------------------------------------------------
export function runDeterministicAssertions(input) {
  const caseById = {};
  for (const c of input.golden) caseById[c.id] = c;

  const emailRe = /[^\s@]+@[^\s@]+\.[^\s@]+/;
  const results = input.sut.outputs.map((row) => {
    const c = caseById[row.caseId] || { id: row.caseId, assertions: {}, expected: '' };
    const output = String(row.output ?? '');
    const a = c.assertions || {};
    const maxLength = Number.isFinite(Number(a.maxLength)) ? Number(a.maxLength) : 2000;
    const forbid = typeof a.forbid === 'string' ? a.forbid : null;
    const formatRe = typeof a.matches === 'string' ? a.matches : null;
    const expectExact = typeof a.equals === 'string' ? a.equals
      : (typeof a.contains !== 'string' && c.expected != null ? String(c.expected) : null);

    const checks = [];
    checks.push({ type: 'schema', field: 'output', ok: typeof output === 'string' && output.length > 0, detail: 'non-empty string output' });
    checks.push({ type: 'range', field: 'output.length', ok: output.length >= 1 && output.length <= maxLength, detail: 'len ' + output.length + ' in [1,' + maxLength + ']' });
    let formatOk = true;
    let formatDetail = 'no format assertion';
    if (typeof a.contains === 'string') { formatOk = output.includes(a.contains); formatDetail = 'contains "' + a.contains + '"'; }
    else if (formatRe) { try { formatOk = new RegExp(formatRe).test(output); formatDetail = 'matches /' + formatRe + '/'; } catch (e) { formatOk = false; formatDetail = 'invalid regex'; } }
    else if (expectExact != null) { formatOk = output === expectExact; formatDetail = 'exact-match expected'; }
    checks.push({ type: 'format', field: 'output', ok: formatOk, detail: formatDetail });
    checks.push({ type: 'absence', field: 'output', ok: forbid ? !output.includes(forbid) : true, detail: forbid ? 'must not contain "' + forbid + '"' : 'no absence assertion' });
    checks.push({ type: 'masking', field: 'output', ok: !emailRe.test(output), detail: 'no raw email in output' });

    const passed = checks.every((ch) => ch.ok);
    return { caseId: row.caseId, modelId: row.modelId, rowKey: row.rowKey, passed, checks };
  });

  return { ...input, deterministic: { results } };
}

// ---------------------------------------------------------------------------------------------------------
// (4) judgeStub — mirror of 'LLM-as-Judge (stub)'. Deterministic 1..5 scores following each row's
// deterministic verdict; schema-validates its own output (fallback on invalid). Stable hash for rationaleHash.
// ---------------------------------------------------------------------------------------------------------
export function judgeStub(input) {
  const detById = {};
  for (const r of input.deterministic.results) detById[r.rowKey] = r.passed;

  function hash(value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0);
  }

  const judged = input.sut.outputs.map((row) => {
    const detPassed = detById[row.rowKey] === true;
    const base = detPassed ? 5 : 2;
    const jitter = (_dim) => 0;
    const scores = {
      groundedness: detPassed ? 5 : 2,
      relevance: base + jitter('relevance'),
      helpfulness: base + jitter('helpfulness'),
      safety: 5
    };
    const dims = ['groundedness', 'relevance', 'helpfulness', 'safety'];
    const schemaOk = dims.every((d) => Number.isInteger(scores[d]) && scores[d] >= 1 && scores[d] <= 5);
    const judgeSource = schemaOk ? 'stub' : 'fallback';
    const rationale = detPassed
      ? 'Output matches the reference on all deterministic checks; subjective quality high.'
      : 'Output failed a deterministic check; groundedness penalised.';
    return {
      caseId: row.caseId,
      modelId: row.modelId,
      rowKey: row.rowKey,
      scores: schemaOk ? scores : { groundedness: null, relevance: null, helpfulness: null, safety: null },
      judgeSource,
      rationaleHash: 'r_' + hash(rationale + '|' + row.rowKey).toString(16),
      rationale
    };
  });

  return { ...input, judge: { source: 'stub', results: judged } };
}

// ---------------------------------------------------------------------------------------------------------
// (5) aggregateRun — mirror of 'Aggregate Eval Run'. passRate, perRubricMean, judge-human calibration +
// judgeTrust, per-model bench (cost-quality-latency), and the regression-vs-baseline delta.
// ---------------------------------------------------------------------------------------------------------
export function aggregateRun(input) {
  const judgeThreshold = 4;
  const detById = {};
  for (const r of input.deterministic.results) detById[r.rowKey] = r;
  const judgeById = {};
  for (const j of input.judge.results) judgeById[j.rowKey] = j;
  const caseById = {};
  for (const c of input.golden) caseById[c.id] = c;
  const sutRowByKey = {};
  for (const o of input.sut.outputs) sutRowByKey[o.rowKey] = o;

  const dims = ['groundedness', 'relevance', 'helpfulness', 'safety'];
  const perCase = input.sut.outputs.map((row) => {
    const c = caseById[row.caseId] || {};
    const det = detById[row.rowKey];
    const jr = judgeById[row.rowKey];
    const scores = jr ? jr.scores : null;
    const haveScores = scores && dims.every((d) => Number.isInteger(scores[d]));
    const judgeMean = haveScores ? dims.reduce((s, d) => s + scores[d], 0) / dims.length : null;
    const passed = !!(det && det.passed) && haveScores && judgeMean >= judgeThreshold;
    return {
      caseId: row.caseId,
      modelId: row.modelId,
      rowKey: row.rowKey,
      passed,
      deterministicPassed: !!(det && det.passed),
      judgeSource: jr ? jr.judgeSource : 'fallback',
      judgeMean: judgeMean,
      scores,
      sutSource: row.sutSource || null,
      latencyMs: Number.isFinite(Number(row.latencyMs)) ? Number(row.latencyMs) : null,
      totalTokens: Number.isInteger(row.totalTokens) ? row.totalTokens : null,
      estCostUsd: Number.isFinite(Number(row.estCostUsd)) ? Number(row.estCostUsd) : 0,
      costBasis: row.costBasis || 'local-free',
      humanLabel: c.humanLabel || null
    };
  });

  const total = perCase.length;
  const passedCount = perCase.filter((p) => p.passed).length;
  const passRate = total > 0 ? passedCount / total : 0;

  const perRubricMean = {};
  for (const d of dims) {
    const vals = perCase.map((p) => (p.scores ? p.scores[d] : null)).filter((v) => Number.isInteger(v));
    perRubricMean[d] = vals.length ? Number((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(3)) : null;
  }

  const calThreshold = 0.8;
  const calibrationCases = [];
  let agreeCount = 0;
  let labelledCount = 0;
  for (const p of perCase) {
    const label = p.humanLabel;
    if (!label) continue;
    labelledCount += 1;
    const sub = [];
    if (typeof label.passed === 'boolean') {
      sub.push({ kind: 'passed', expected: label.passed, actual: p.passed, ok: p.passed === label.passed });
    }
    if (Array.isArray(label.groundednessBand) && p.scores && Number.isInteger(p.scores.groundedness)) {
      const g = p.scores.groundedness;
      const inBand = g >= label.groundednessBand[0] && g <= label.groundednessBand[1];
      sub.push({ kind: 'groundednessBand', expected: label.groundednessBand, actual: g, ok: inBand });
    } else if (Array.isArray(label.groundednessBand)) {
      sub.push({ kind: 'groundednessBand', expected: label.groundednessBand, actual: null, ok: false });
    }
    const caseAgrees = sub.length > 0 && sub.every((s) => s.ok);
    if (caseAgrees) agreeCount += 1;
    calibrationCases.push({
      caseId: p.caseId,
      modelId: p.modelId,
      judgeSource: p.judgeSource,
      judgePassed: p.passed,
      judgeGroundedness: p.scores ? p.scores.groundedness : null,
      checks: sub,
      agrees: caseAgrees
    });
  }
  const hasCalibration = labelledCount > 0;
  const agreement = hasCalibration ? Number((agreeCount / labelledCount).toFixed(3)) : null;

  let judgeTrust;
  if (input.judge.source === 'stub') {
    judgeTrust = 'high';
  } else if (hasCalibration) {
    judgeTrust = agreement >= calThreshold ? 'high' : 'low';
  } else {
    judgeTrust = 'low';
  }

  const calibration = {
    labelledCount,
    agreeCount,
    agreement,
    threshold: calThreshold,
    basis: input.judge.source === 'stub' ? 'stub-perfect-agreement-by-construction' : 'judge-vs-human',
    cases: calibrationCases
  };

  const byModel = {};
  const modelOrder = [];
  for (const p of perCase) {
    if (!byModel[p.modelId]) { byModel[p.modelId] = []; modelOrder.push(p.modelId); }
    byModel[p.modelId].push(p);
  }
  const perModel = modelOrder.map((modelId) => {
    const rows = byModel[modelId];
    const mTotal = rows.length;
    const mPassed = rows.filter((r) => r.passed).length;
    const mPassRate = mTotal > 0 ? Number((mPassed / mTotal).toFixed(3)) : 0;
    const mRubric = {};
    for (const d of dims) {
      const vals = rows.map((r) => (r.scores ? r.scores[d] : null)).filter((v) => Number.isInteger(v));
      mRubric[d] = vals.length ? Number((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(3)) : null;
    }
    const latencies = rows.map((r) => r.latencyMs).filter((v) => Number.isFinite(v));
    const meanLatencyMs = latencies.length ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) : null;
    const tokenRows = rows.map((r) => r.totalTokens).filter((v) => Number.isInteger(v));
    const totalTokens = tokenRows.length ? tokenRows.reduce((s, v) => s + v, 0) : null;
    const estCostUsd = Number(rows.reduce((s, r) => s + (Number.isFinite(Number(r.estCostUsd)) ? Number(r.estCostUsd) : 0), 0).toFixed(6));
    const costBasis = rows.some((r) => r.costBasis === 'cloud-estimate') ? 'cloud-estimate' : 'local-free';
    return { modelId, total: mTotal, passRate: mPassRate, perRubricMean: mRubric, meanLatencyMs, totalTokens, estCostUsd, costBasis };
  });
  const bench = perModel.slice().sort((a, b) => {
    if (b.passRate !== a.passRate) return b.passRate - a.passRate;
    const al = a.meanLatencyMs == null ? Infinity : a.meanLatencyMs;
    const bl = b.meanLatencyMs == null ? Infinity : b.meanLatencyMs;
    if (al !== bl) return al - bl;
    return a.estCostUsd - b.estCostUsd;
  }).map((m, i) => ({ rank: i + 1, modelId: m.modelId, passRate: m.passRate, meanLatencyMs: m.meanLatencyMs, totalTokens: m.totalTokens, estCostUsd: m.estCostUsd, costBasis: m.costBasis }));

  const baseline = (input.runtime && input.runtime.baseline) ? input.runtime.baseline : null;
  const tolerance = (input.runtime && Number.isFinite(Number(input.runtime.regressionTolerance))) ? Number(input.runtime.regressionTolerance) : 0;
  let regressionDelta = null;
  if (baseline && baseline.overall && Number.isFinite(Number(baseline.overall.passRate))) {
    const round3 = (n) => Number(Number(n).toFixed(3));
    let regressed = false;
    const baseOverall = Number(baseline.overall.passRate);
    const overallDelta = round3(passRate - baseOverall);
    if (passRate < baseOverall - tolerance) regressed = true;
    const baseModelMap = {};
    if (Array.isArray(baseline.perModel)) {
      for (const bm of baseline.perModel) {
        if (bm && typeof bm.modelId === 'string' && Number.isFinite(Number(bm.passRate))) baseModelMap[bm.modelId] = Number(bm.passRate);
      }
    }
    const perModelDelta = perModel.map((m) => {
      const has = Object.prototype.hasOwnProperty.call(baseModelMap, m.modelId);
      if (!has) {
        return { modelId: m.modelId, passRate: m.passRate, baselinePassRate: null, passRateDelta: null, isNew: true };
      }
      const basePr = baseModelMap[m.modelId];
      if (m.passRate < basePr - tolerance) regressed = true;
      return { modelId: m.modelId, passRate: m.passRate, baselinePassRate: basePr, passRateDelta: round3(m.passRate - basePr), isNew: false };
    });
    const baseRubric = baseline.perRubricMean && typeof baseline.perRubricMean === 'object' ? baseline.perRubricMean : {};
    const perRubricMeanDelta = {};
    for (const d of dims) {
      const cur = perRubricMean[d];
      const bas = baseRubric[d];
      perRubricMeanDelta[d] = (Number.isFinite(Number(cur)) && Number.isFinite(Number(bas))) ? round3(Number(cur) - Number(bas)) : null;
    }
    regressionDelta = {
      baselineSource: (input.runtime && input.runtime.baselineSource) ? input.runtime.baselineSource : 'request',
      tolerance,
      overall: { passRate: Number(passRate.toFixed(3)), baselinePassRate: round3(baseOverall), passRateDelta: overallDelta },
      perModel: perModelDelta,
      perRubricMeanDelta,
      regressed
    };
  }

  return {
    ...input,
    aggregate: {
      total,
      passedCount,
      passRate: Number(passRate.toFixed(3)),
      perRubricMean,
      judgeTrust,
      calibration,
      regressionDelta,
      perModel,
      bench,
      perCase
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (6) buildAuditEvent — mirror of 'Create Redacted Audit Event'. Carries only ids/verdicts/scores/counts —
// never raw inputs/expected/outputs/rationale (masking invariant). createdAt is the node's
// new Date().toISOString(); the differential injects the SAME instant via opts.now into both sides.
// ---------------------------------------------------------------------------------------------------------
export function buildAuditEvent(input, opts = {}) {
  function hash(value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  const runSeed = input.run.runId + '|' + input.run.requestedAt;

  const cases = input.aggregate.perCase.map((p) => ({
    caseId: p.caseId,
    modelId: p.modelId,
    passed: p.passed,
    deterministicPassed: p.deterministicPassed,
    judgeSource: p.judgeSource,
    judgeMean: p.judgeMean
  }));
  const perModel = (input.aggregate.perModel || []).map((m) => ({
    modelId: m.modelId,
    total: m.total,
    passRate: m.passRate,
    meanLatencyMs: m.meanLatencyMs,
    totalTokens: m.totalTokens,
    estCostUsd: m.estCostUsd,
    costBasis: m.costBasis
  }));

  const createdAt = opts.now != null ? String(opts.now) : new Date().toISOString();

  return {
    ...input,
    auditEvent: {
      auditEventId: 'audit_' + hash(runSeed),
      // Optional correlation id echoed from the request (capture-and-echo, never generated); null when absent.
      traceId: input.runtime.traceId ?? null,
      runId: input.run.runId,
      sutMode: input.runtime.sutMode,
      sutModels: input.runtime.sutModels,
      judgeSource: input.judge.source,
      judgeTrust: input.aggregate.judgeTrust,
      total: input.aggregate.total,
      passedCount: input.aggregate.passedCount,
      passRate: input.aggregate.passRate,
      perRubricMean: input.aggregate.perRubricMean,
      perModel,
      bench: input.aggregate.bench || [],
      regressionDelta: input.aggregate.regressionDelta || null,
      calibration: {
        labelledCount: input.aggregate.calibration.labelledCount,
        agreeCount: input.aggregate.calibration.agreeCount,
        agreement: input.aggregate.calibration.agreement,
        threshold: input.aggregate.calibration.threshold,
        basis: input.aggregate.calibration.basis
      },
      cases,
      policyVersion: POLICY_VERSION,
      createdAt
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (7) buildEvalResponse — mirror of 'Build Eval Response'. The final { statusCode, runtime, response,
// auditEvent }. processedAt is new Date().toISOString(); the differential injects the SAME instant via opts.now.
// ---------------------------------------------------------------------------------------------------------
export function buildEvalResponse(input, opts = {}) {
  const agg = input.aggregate;
  const processedAt = opts.now != null ? String(opts.now) : new Date().toISOString();
  return {
    statusCode: 200,
    runtime: input.runtime,
    response: {
      ok: true,
      runId: input.run.runId,
      // Optional correlation id echoed from the request (capture-and-echo, never generated); null when absent.
      traceId: input.runtime.traceId ?? null,
      sutMode: input.runtime.sutMode,
      sutModels: input.runtime.sutModels,
      judgeSource: input.judge.source,
      judgeTrust: agg.judgeTrust,
      passed: agg.passRate >= 1,
      total: agg.total,
      passedCount: agg.passedCount,
      passRate: agg.passRate,
      perRubricMean: agg.perRubricMean,
      perModel: agg.perModel,
      bench: agg.bench,
      regressionDelta: agg.regressionDelta,
      calibration: agg.calibration,
      results: agg.perCase.map((p) => ({
        caseId: p.caseId,
        modelId: p.modelId,
        passed: p.passed,
        deterministicPassed: p.deterministicPassed,
        judgeSource: p.judgeSource,
        judgeMean: p.judgeMean,
        scores: p.scores,
        latencyMs: p.latencyMs,
        totalTokens: p.totalTokens,
        estCostUsd: p.estCostUsd,
        costBasis: p.costBasis,
        sutSource: p.sutSource
      })),
      auditEventId: input.auditEvent.auditEventId,
      processedAt,
      latencyMs: input.sut.latencyMs,
      policyVersion: POLICY_VERSION
    },
    auditEvent: input.auditEvent
  };
}

// ---------------------------------------------------------------------------------------------------------
// (8) buildMissingGoldenError — mirror of 'Build Missing Golden Error' (the 400 branch when no valid golden).
// ---------------------------------------------------------------------------------------------------------
export function buildMissingGoldenError(input) {
  return {
    statusCode: 400,
    runtime: input.runtime,
    response: {
      ok: false,
      error: 'Missing golden case with {input, expected}',
      caseCount: input.validation.caseCount,
      validCaseCount: input.validation.validCaseCount,
      policyVersion: POLICY_VERSION
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// runStubEval — convenience composition of the full deterministic stub pipeline (the happy path) + the
// missing-golden branch. Threads opts.now into the three timestamp-bearing stages so a full run is
// reproducible end-to-end. Returns the Build Eval Response (200) or Build Missing Golden Error (400) shape.
// This is the single entry point the differential and any future direct core test reuse.
// ---------------------------------------------------------------------------------------------------------
export function runStubEval(source, opts = {}) {
  const normalized = normalizeEvalRequest(source, opts);
  if (!normalized.validation.hasValidGolden) {
    return { record: buildMissingGoldenError(normalized), normalized };
  }
  const afterSut = runSubjectStub(normalized);
  const afterDet = runDeterministicAssertions(afterSut);
  const afterJudge = judgeStub(afterDet);
  const afterAgg = aggregateRun(afterJudge);
  const afterAudit = buildAuditEvent(afterAgg, opts);
  const record = buildEvalResponse(afterAudit, opts);
  return {
    record,
    normalized,
    sut: afterSut.sut,
    deterministic: afterDet.deterministic,
    judge: afterJudge.judge,
    aggregate: afterAgg.aggregate,
    auditEvent: afterAudit.auditEvent
  };
}
