// test-eval-workflow.mjs — offline behavioral proof of the COMPILED llm-eval-harness workflow.
// (npm run verify:workflow; also run inside verify:static.)
//
// Why this exists: n8n Code nodes cannot import eval-core.mjs, so the deployed DETERMINISTIC eval logic is a
// COPY embedded as jsCode. The repo's only behavioral coverage was verify:live (a live n8n run, NOT in CI),
// so the compiled jsCode was never executed offline. This gate closes that gap — it is the portfolio's
// signature discipline (cf. interaction-gateway's test-gateway-workflow.mjs / autonomous-agent's
// test-agent-workflow.mjs). It:
//   1) loads the compiled CANONICAL JSON (the deploy artifact),
//   2) extracts each deterministic-stub Code node's jsCode and runs the golden/calibration fixtures through
//      the real stub pipeline (Normalize -> Run SUT (stub) -> Run Deterministic Assertions -> Judge (stub)
//      -> Aggregate -> Create Redacted Audit Event -> Build Eval Response), threading each node's output into
//      the next exactly as n8n would, PLUS the Missing-Golden 400 branch,
//   3) DIFFERENTIALLY checks each stage's output against eval-core.mjs on the same inputs (byte-identical),
//   4) asserts the documented behavioral expectations (pass/fail outcome, scores, judgeTrust, audit shape).
// So the deployed deterministic eval can't silently drift from the audited core. No n8n, no network.
//
// SCOPE: only the DETERMINISTIC STUB PATH (the offline lane CI touches). The live branches (sutMode:'workflow'
// /'model', judgeSource:'ollama') call siblings/Ollama over HTTP and are intentionally NOT exercised here —
// they belong to verify:live. Fixtures that request a live mode are run in their REPRODUCIBLE form: this gate
// forces the stub SUT + stub judge so the compiled deterministic nodes (which are mode-agnostic given their
// inputs) are exercised identically to the core (see toReproducibleStubRequest below).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import {
  normalizeEvalRequest, runSubjectStub, runDeterministicAssertions, judgeStub,
  aggregateRun, buildAuditEvent, buildEvalResponse, buildMissingGoldenError, POLICY_VERSION
} from './lib/eval-core.mjs';

// The deployed Code nodes assume n8n's sandbox globals (items, Buffer, $env, require). Provide a real require
// so any builtin a node may load resolves identically here. The deterministic stub nodes use none of these
// beyond `items`, but we inject them for parity with how n8n constructs the function.
const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const canonicalPath = join(repoRoot, 'workflows', 'canonical', 'llm-eval-harness.canonical.json');
const goldenDir = join(repoRoot, 'fixtures', 'golden');
const calibrationPath = join(repoRoot, 'fixtures', 'calibration', 'calibration-slice.json');
const baselinePath = join(repoRoot, 'fixtures', 'baseline', 'regression-baseline.json');

const wf = JSON.parse(readFileSync(canonicalPath, 'utf8'));
const nodeByName = {};
for (const n of wf.nodes) { nodeByName[n.name] = n; }

// The deterministic-stub pipeline node names (the offline lane), in execution order.
const NORMALIZE = 'Normalize Eval Request';
const SUT = 'Run Subject-Under-Test (stub)';
const DET = 'Run Deterministic Assertions';
const JUDGE = 'LLM-as-Judge (stub)';
const AGG = 'Aggregate Eval Run';
const AUDIT = 'Create Redacted Audit Event';
const BUILD = 'Build Eval Response';
const MISSING = 'Build Missing Golden Error';
const HAPPY_PIPELINE = [NORMALIZE, SUT, DET, JUDGE, AGG, AUDIT, BUILD];

// Mirror n8n's Code-node sandbox: items[], Buffer, $env, require. The body ends in `return`.
function runNode(name, items, env) {
  const node = nodeByName[name];
  if (!node) { throw new Error('missing Code node in compiled JSON: ' + name); }
  const fn = new Function('items', 'Buffer', '$env', 'require', node.parameters.jsCode);
  return fn(items, Buffer, env || {}, require);
}

let pass = 0;
let fail = 0;
function check(scenario, label, ok, detail) {
  if (ok) { pass += 1; } else { fail += 1; }
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + scenario + ' :: ' + label + (detail ? ' -> ' + detail : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s)) && /\d{4}-\d{2}-\d{2}T/.test(s);

// Coerce any live-mode fixture into its REPRODUCIBLE stub form so the deterministic nodes (and the core) are
// exercised identically and offline. We drop the live-routing knobs (sutMode/judgeSource/sutModels/...) and
// pin requestedAt so the compiled Normalize node — which defaults requestedAt to wall-clock when absent —
// produces a deterministic record byte-identical to the core's (which is fed the SAME requestedAt). A bare
// string/object 'input' is kept verbatim (the stub SUT String()-coerces it). humanLabel is preserved (it
// drives the stub-mode calibration). runId is preserved (or synthesized) so auditEventId is deterministic.
function toReproducibleStubRequest(fixture, fallbackRunId) {
  const requestedAt = '2026-06-01T00:00:00.000Z'; // pinned instant: makes Normalize deterministic on both sides
  const runId = (typeof fixture.runId === 'string' && fixture.runId.length > 0) ? fixture.runId : fallbackRunId;
  const req = {
    runId,
    requestedAt,
    golden: Array.isArray(fixture.golden) ? fixture.golden : []
  };
  // Carry a baseline through only if the fixture itself supplies one (none of the golden fixtures do; the
  // baseline fixture is fed separately below). This keeps each fixture's documented behavior intact.
  if (fixture.baseline && typeof fixture.baseline === 'object') { req.baseline = fixture.baseline; req.baselineSource = fixture.baselineSource || 'request'; }
  if (fixture.regressionTolerance !== undefined) { req.regressionTolerance = fixture.regressionTolerance; }
  return { req, opts: { now: requestedAt, runIdFallback: runId } };
}

// Run the COMPILED deterministic-stub pipeline, capturing a deep-clone snapshot at each stage (the nodes
// spread-merge a fresh object each stage so aliasing is not the hazard it is in the gateway, but we clone
// for safety + to capture exact per-stage state). Returns { snap, final } or throws on a bad item shape.
function runCompiledHappy(req, env) {
  let items = [{ json: req }];
  const snap = {};
  for (const stage of HAPPY_PIPELINE) {
    items = runNode(stage, items, env);
    if (!Array.isArray(items) || !items[0] || !items[0].json) { throw new Error(stage + ' returned a bad item shape'); }
    snap[stage] = structuredClone(items[0].json);
  }
  return { snap, final: snap[BUILD] };
}

// Normalize the two non-injectable timestamps (processedAt in Build, createdAt in Audit) before a whole-record
// differential: the compiled Build/Audit nodes call new Date().toISOString() with no override hook, so those
// two fields legitimately differ run-to-run. We assert them as ISO format separately, then blank them for the
// structural compare. requestedAt IS pinned on both sides (via the request + opts.now) so it is NOT blanked.
function blankVolatileTimestamps(record) {
  const r = structuredClone(record);
  if (r.response) { r.response.processedAt = '<ts>'; }
  if (r.auditEvent) { r.auditEvent.createdAt = '<ts>'; }
  if (r.response && r.response.latencyMs !== undefined) { r.response.latencyMs = '<latency>'; } // sut.latencyMs is Date-derived (>=1)
  return r;
}

// ---------------------------------------------------------------------------------------------------------
// HAPPY PATH (deterministic stub) — every golden + the calibration slice, run reproducibly offline.
// ---------------------------------------------------------------------------------------------------------
const goldenFiles = readdirSync(goldenDir).filter((f) => f.endsWith('.json')).sort();
const fixtureFiles = goldenFiles.map((f) => ({ id: f.replace(/\.json$/, ''), path: join(goldenDir, f) }));
fixtureFiles.push({ id: 'calibration-slice', path: calibrationPath });

for (const ff of fixtureFiles) {
  const fixture = JSON.parse(readFileSync(ff.path, 'utf8'));
  const { req, opts } = toReproducibleStubRequest(fixture, ff.id);

  // (a) the DEPLOYED jsCode pipeline (extracted from the compiled canonical)
  let compiled;
  try {
    compiled = runCompiledHappy(req, {});
  } catch (e) {
    check(ff.id, 'compiled pipeline executes', false, e.message);
    continue;
  }
  check(ff.id, 'compiled pipeline executes', true);

  // (b) the audited core, same request + same injected instant
  const coreNorm = normalizeEvalRequest(req, opts);
  const coreSut = runSubjectStub(coreNorm);
  const coreDet = runDeterministicAssertions(coreSut);
  const coreJudge = judgeStub(coreDet);
  const coreAgg = aggregateRun(coreJudge);
  const coreAudit = buildAuditEvent(coreAgg, opts);
  const coreRecord = buildEvalResponse(coreAudit, opts);

  // (c) DIFFERENTIAL — each compiled stage output EQUALS the core's on the same input.
  check(ff.id, 'DIFF normalize == core (runtime+golden+validation)',
    eq(compiled.snap[NORMALIZE].runtime, coreNorm.runtime)
    && eq(compiled.snap[NORMALIZE].golden, coreNorm.golden)
    && eq(compiled.snap[NORMALIZE].validation, coreNorm.validation)
    && eq(compiled.snap[NORMALIZE].run, coreNorm.run));
  check(ff.id, 'DIFF stub SUT outputs == core',
    eq(compiled.snap[SUT].sut.outputs, coreSut.sut.outputs) && compiled.snap[SUT].sut.mode === coreSut.sut.mode);
  check(ff.id, 'DIFF deterministic results == core', eq(compiled.snap[DET].deterministic, coreDet.deterministic));
  check(ff.id, 'DIFF stub judge results == core', eq(compiled.snap[JUDGE].judge, coreJudge.judge));
  check(ff.id, 'DIFF aggregate == core', eq(compiled.snap[AGG].aggregate, coreAgg.aggregate));
  // The audit node calls new Date().toISOString() for createdAt with NO override hook, so that one field
  // legitimately differs run-to-run on the compiled side (asserted ISO separately below). Blank it on both
  // sides for the structural compare; the requestedAt-derived auditEventId is NOT blanked (it is pinned and
  // proven byte-identical — the load-bearing hash differential).
  const blankCreatedAt = (ae) => { const c = structuredClone(ae); c.createdAt = '<ts>'; return c; };
  check(ff.id, 'DIFF audit event == core (createdAt-normalized)',
    eq(blankCreatedAt(compiled.snap[AUDIT].auditEvent), blankCreatedAt(coreAudit.auditEvent)));
  check(ff.id, 'DIFF auditEventId == core (requestedAt-derived hash)',
    compiled.snap[AUDIT].auditEvent.auditEventId === coreAudit.auditEvent.auditEventId,
    compiled.snap[AUDIT].auditEvent.auditEventId + ' vs ' + coreAudit.auditEvent.auditEventId);
  // whole-record differential (timestamps + Date-derived latency normalized identically on both sides)
  check(ff.id, 'DIFF build response record == core (whole record, ts-normalized)',
    eq(blankVolatileTimestamps(compiled.final), blankVolatileTimestamps(coreRecord)),
    'records diverge');

  // (d) BEHAVIORAL expectations against the DEPLOYED jsCode.
  const final = compiled.final;
  const resp = final.response;
  check(ff.id, 'statusCode == 200', final.statusCode === 200, 'got ' + final.statusCode);
  check(ff.id, 'response.ok == true', resp.ok === true);
  check(ff.id, 'judgeSource == stub (offline)', resp.judgeSource === 'stub', resp.judgeSource);
  check(ff.id, 'judgeTrust == high (stub)', resp.judgeTrust === 'high', resp.judgeTrust);
  check(ff.id, 'policyVersion == ' + POLICY_VERSION, resp.policyVersion === POLICY_VERSION, resp.policyVersion);
  check(ff.id, 'processedAt is ISO', isIso(resp.processedAt), resp.processedAt);
  check(ff.id, 'audit createdAt is ISO', isIso(final.auditEvent.createdAt), final.auditEvent.createdAt);
  // pass-rate band: must be a rate in [0,1] and equal passedCount/total.
  check(ff.id, 'passRate in [0,1] and == passedCount/total',
    resp.passRate >= 0 && resp.passRate <= 1 && Math.abs(resp.passRate - (resp.passedCount / resp.total)) < 1e-9,
    'passRate ' + resp.passRate + ' total ' + resp.total + ' passed ' + resp.passedCount);
  // every judge score (when present) is an integer in 1..5.
  for (const r of resp.results) {
    if (r.scores) {
      const okScores = ['groundedness', 'relevance', 'helpfulness', 'safety']
        .every((d) => Number.isInteger(r.scores[d]) && r.scores[d] >= 1 && r.scores[d] <= 5);
      check(ff.id, 'row ' + r.caseId + ' judge scores integer 1..5', okScores, JSON.stringify(r.scores));
    }
  }
  // deterministic-first invariant: a row that failed deterministically must NOT pass overall.
  const noFreePass = resp.results.every((r) => r.deterministicPassed || !r.passed);
  check(ff.id, 'no row passes overall without deterministic pass', noFreePass);
  // MASKING / absence: no raw email anywhere in the response or the redacted audit event.
  const serialized = JSON.stringify(final.response) + JSON.stringify(final.auditEvent);
  check(ff.id, 'no raw email in response/audit (masking)', !/[^\s@"]+@[^\s@"]+\.[^\s@"]+/.test(serialized),
    /[^\s@"]+@[^\s@"]+\.[^\s@"]+/.test(serialized) ? 'LEAK' : 'clean');
  // the audit event must NOT carry the golden array, raw inputs, expected, SUT outputs, or rationale text.
  const auditStr = JSON.stringify(final.auditEvent);
  check(ff.id, 'audit omits raw inputs/golden/rationale',
    !/"golden"/.test(auditStr) && !/"input"/.test(auditStr) && !/"expected"/.test(auditStr) && !/"rationale"/.test(auditStr) && !/"output"/.test(auditStr));
}

// ---------------------------------------------------------------------------------------------------------
// FIXTURE-SPECIFIC behavioral pins (the documented expected outcomes from docs/eval-plan.md + fixtures).
// ---------------------------------------------------------------------------------------------------------
function runStubFixtureCompiled(fixture, fallbackRunId) {
  const { req } = toReproducibleStubRequest(fixture, fallbackRunId);
  return runCompiledHappy(req, {}).final.response;
}

// echo-pass: stub echoes 'ping', contains 'ping' -> deterministic pass -> judge 5s -> overall pass, passRate 1.
{
  const r = runStubFixtureCompiled(JSON.parse(readFileSync(join(goldenDir, 'echo-pass.json'), 'utf8')), 'echo-pass');
  check('echo-pass', 'passRate == 1 (echo matches)', r.passRate === 1, String(r.passRate));
  check('echo-pass', 'passed == true', r.passed === true);
  check('echo-pass', 'results[0].deterministicPassed', r.results[0].deterministicPassed === true);
}
// echo-fail: stub echoes 'ping' but assertions.contains 'pong' -> deterministic fail -> overall fail, passRate 0.
{
  const r = runStubFixtureCompiled(JSON.parse(readFileSync(join(goldenDir, 'echo-fail.json'), 'utf8')), 'echo-fail');
  check('echo-fail', 'passRate == 0 (echo != contains)', r.passRate === 0, String(r.passRate));
  check('echo-fail', 'passed == false', r.passed === false);
  check('echo-fail', 'results[0].deterministicPassed == false', r.results[0].deterministicPassed === false);
  check('echo-fail', 'failing row groundedness == 2 (penalised)', r.results[0].scores.groundedness === 2, String(r.results[0].scores.groundedness));
}
// calibration-slice: in STUB mode judgeTrust is 'high' by construction; the slice carries humanLabels, so the
// stub-mode calibration runs (basis = stub-perfect-agreement). The HALLUCINATE case fails deterministically.
{
  const fixture = JSON.parse(readFileSync(calibrationPath, 'utf8'));
  const r = runStubFixtureCompiled(fixture, 'calibration-slice');
  check('calibration-slice', 'judgeTrust == high (stub construction)', r.judgeTrust === 'high', r.judgeTrust);
  check('calibration-slice', 'calibration.basis == stub-perfect-agreement-by-construction',
    r.calibration.basis === 'stub-perfect-agreement-by-construction', r.calibration.basis);
  check('calibration-slice', 'calibration.labelledCount == 6 (all labelled)', r.calibration.labelledCount === 6, String(r.calibration.labelledCount));
  const hall = r.results.find((x) => x.caseId === 'cal-hallucination-fail');
  check('calibration-slice', 'HALLUCINATE case fails deterministically', hall && hall.deterministicPassed === false, hall ? String(hall.deterministicPassed) : 'missing');
  const grounded = r.results.find((x) => x.caseId === 'cal-grounded-exact');
  check('calibration-slice', 'grounded-exact case passes', grounded && grounded.passed === true, grounded ? String(grounded.passed) : 'missing');
}

// ---------------------------------------------------------------------------------------------------------
// MISSING-GOLDEN 400 branch — an empty/invalid golden set returns the 400 error record; compiled == core.
// ---------------------------------------------------------------------------------------------------------
for (const missing of [
  { id: 'missing-empty', req: { runId: 'm1', requestedAt: '2026-06-01T00:00:00.000Z', golden: [] } },
  { id: 'missing-no-expected', req: { runId: 'm2', requestedAt: '2026-06-01T00:00:00.000Z', golden: [{ id: 'x', input: 'a' }] } }
]) {
  const opts = { now: missing.req.requestedAt, runIdFallback: missing.req.runId };
  // compiled: Normalize then Build Missing Golden Error (the 400 branch the ifElse selects on !hasValidGolden).
  let compiledNorm, compiledErr;
  try {
    compiledNorm = runNode(NORMALIZE, [{ json: missing.req }], {})[0].json;
    compiledErr = runNode(MISSING, [{ json: compiledNorm }], {})[0].json;
  } catch (e) {
    check(missing.id, 'compiled missing-golden executes', false, e.message);
    continue;
  }
  check(missing.id, 'compiled missing-golden executes', true);
  check(missing.id, 'hasValidGolden == false', compiledNorm.validation.hasValidGolden === false);
  const coreNorm = normalizeEvalRequest(missing.req, opts);
  const coreErr = buildMissingGoldenError(coreNorm);
  check(missing.id, 'DIFF missing-golden record == core', eq(compiledErr, coreErr), 'records diverge');
  check(missing.id, 'statusCode == 400', compiledErr.statusCode === 400, String(compiledErr.statusCode));
  check(missing.id, 'response.ok == false', compiledErr.response.ok === false);
  check(missing.id, 'error message present', typeof compiledErr.response.error === 'string' && compiledErr.response.error.length > 0);
  check(missing.id, 'policyVersion == ' + POLICY_VERSION, compiledErr.response.policyVersion === POLICY_VERSION, compiledErr.response.policyVersion);
}

// ---------------------------------------------------------------------------------------------------------
// REGRESSION-vs-BASELINE — the committed baseline fixture, fed the no-drift way (baseline == current run) and
// the regressed way (baseline mutated UP), proving the compiled Aggregate's regressionDelta == core.
// ---------------------------------------------------------------------------------------------------------
{
  const baseFix = JSON.parse(readFileSync(baselinePath, 'utf8'));
  // The baseline fixture carries its own golden slice [echo-pass, echo-fail] + the baseline object.
  function runWithBaseline(label, baselineObj, tolerance) {
    const req = {
      runId: 'baseline-' + label,
      requestedAt: '2026-06-01T00:00:00.000Z',
      golden: baseFix.golden,
      baseline: baselineObj,
      baselineSource: 'fixture',
      regressionTolerance: tolerance
    };
    const opts = { now: req.requestedAt, runIdFallback: req.runId };
    const compiled = runCompiledHappy(req, {});
    const coreAgg = aggregateRun(judgeStub(runDeterministicAssertions(runSubjectStub(normalizeEvalRequest(req, opts)))));
    return { compiledAgg: compiled.snap[AGG].aggregate, coreAgg: coreAgg.aggregate, resp: compiled.final.response };
  }
  // No-drift: baseline equals the deterministic stub run's aggregate (passRate 0.5) -> regressed:false, delta 0.
  const noDrift = runWithBaseline('nodrift', baseFix.baseline, 0);
  check('regression-nodrift', 'DIFF aggregate.regressionDelta == core', eq(noDrift.compiledAgg.regressionDelta, noDrift.coreAgg.regressionDelta));
  check('regression-nodrift', 'overall passRate == 0.5 (deterministic stub slice)', noDrift.resp.passRate === 0.5, String(noDrift.resp.passRate));
  check('regression-nodrift', 'regressed == false (no drift)', noDrift.resp.regressionDelta && noDrift.resp.regressionDelta.regressed === false, JSON.stringify(noDrift.resp.regressionDelta && noDrift.resp.regressionDelta.regressed));
  check('regression-nodrift', 'overall passRateDelta == 0', noDrift.resp.regressionDelta && noDrift.resp.regressionDelta.overall.passRateDelta === 0, JSON.stringify(noDrift.resp.regressionDelta && noDrift.resp.regressionDelta.overall.passRateDelta));
  // Regressed: a deliberately-HIGHER baseline (passRate 1.0) -> current 0.5 drops below -> regressed:true.
  const higher = { overall: { passRate: 1.0 }, perModel: [{ modelId: 'stub', passRate: 1.0 }], perRubricMean: baseFix.baseline.perRubricMean };
  const regressed = runWithBaseline('regressed', higher, 0);
  check('regression-regressed', 'DIFF aggregate.regressionDelta == core', eq(regressed.compiledAgg.regressionDelta, regressed.coreAgg.regressionDelta));
  check('regression-regressed', 'regressed == true (passRate dropped)', regressed.resp.regressionDelta && regressed.resp.regressionDelta.regressed === true, JSON.stringify(regressed.resp.regressionDelta && regressed.resp.regressionDelta.regressed));
  check('regression-regressed', 'overall passRateDelta == -0.5', regressed.resp.regressionDelta && regressed.resp.regressionDelta.overall.passRateDelta === -0.5, JSON.stringify(regressed.resp.regressionDelta && regressed.resp.regressionDelta.overall.passRateDelta));
}

console.log('');
console.log('eval-workflow behavioral self-test: ' + pass + ' passed, ' + fail + ' failed ('
  + fixtureFiles.length + ' stub fixtures + missing-golden + regression, OFFLINE, compiled jsCode + differential vs core)');
process.exit(fail > 0 ? 1 : 0);
