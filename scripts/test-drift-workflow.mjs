// test-drift-workflow.mjs — offline behavioral proof of the COMPILED scheduled-drift-monitor workflow.
// (npm run verify:workflow; also run inside verify:static.)
//
// Why this exists: n8n Code nodes cannot import drift-core.mjs, so the deployed DETERMINISTIC drift logic is a
// COPY embedded as jsCode. The repo's only behavioral coverage was verify:live / verify:drift-live (live n8n
// runs, NOT in CI), so the compiled jsCode was never executed offline. This gate closes that gap — it is the
// portfolio's signature discipline (cf. interaction-gateway's test-gateway-workflow.mjs / llm-eval-harness's
// test-eval-workflow.mjs). It:
//   1) loads the compiled CANONICAL JSON (the deploy artifact),
//   2) extracts each deterministic-stub Code node's jsCode and runs the golden/regression fixtures through the
//      real stub pipeline (Normalize -> Load Prior Baseline -> M1 Collect Sources -> M1 Detect Source Drift
//      -> M2 Collect Eval Reading -> M2 Detect Quality Drift -> Aggregate -> Summarize Digest -> Enforce
//      Digest Integrity -> Create Redacted Audit Event -> Build Run Output), threading each node's output into
//      the next exactly as n8n would,
//   3) DIFFERENTIALLY checks each stage's output against drift-core.mjs on the same inputs (byte-identical),
//   4) asserts the documented behavioral expectations (drift verdict, source statuses, digest-integrity holds
//      on real digests / REJECTS a fabricated-number prose, safe-degrade produces stub labels, masking).
// So the deployed deterministic drift logic can't silently drift from the audited core. No n8n, no network.
//
// SCOPE: only the DETERMINISTIC STUB PATH (the offline lane CI touches). The live branches (mode:'live'
// source-fetch / A-eval, summarySource:'ollama' Ollama digest) call siblings/Ollama over HTTP and are
// intentionally NOT exercised here — they belong to verify:drift-live (which onError-degrades to stub).
// Fixtures are run in their REPRODUCIBLE stub form: requestedAt + runId are pinned so the compiled Normalize
// node — which defaults them to wall-clock when absent — produces a record byte-identical to the core's.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import {
  normalizeRunConfig, loadPriorBaseline, collectSourcesStub, detectSourceDrift,
  collectEvalReadingStub, detectQualityDrift, aggregateRunRecord, summarizeDigestStub,
  enforceDigestIntegrity, buildAuditEvent, buildRunOutput, POLICY_VERSION
} from './lib/drift-core.mjs';

// The deployed Code nodes assume n8n's sandbox globals (items, Buffer, $env, require) plus `this.helpers` on
// the live branches. Provide a real require for parity. The deterministic stub nodes touch none of these
// beyond `items`, but three nodes (M1 Collect Sources, M2 Collect Eval Reading, Summarize Digest) carry an
// `await this.helpers.httpRequest` in their UNREACHED live branch, so their bodies parse as ASYNC — they must
// be constructed via AsyncFunction (a plain Function throws on `await`). We construct ALL nodes via
// AsyncFunction and await each call, so the stub path runs identically regardless of whether a node is async.
const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const canonicalPath = join(repoRoot, 'workflows', 'canonical', 'scheduled-drift-monitor.canonical.json');
const goldenDir = join(repoRoot, 'fixtures', 'golden');

const wf = JSON.parse(readFileSync(canonicalPath, 'utf8'));
const nodeByName = {};
for (const n of wf.nodes) { nodeByName[n.name] = n; }

// The deterministic-stub pipeline node names (the offline lane), in execution order.
const NORMALIZE = 'Normalize Run Config';
const BASELINE = 'Load Prior Baseline';
const COLLECT = 'M1 Collect Sources (stub)';
const SOURCEDRIFT = 'M1 Detect Source Drift';
const EVAL = 'M2 Collect Eval Reading (stub)';
const QUALITYDRIFT = 'M2 Detect Quality Drift';
const AGG = 'Aggregate Run Record';
const DIGEST = 'Summarize Digest (stub)';
const INTEGRITY = 'Enforce Digest Integrity';
const AUDIT = 'Create Redacted Audit Event';
const BUILD = 'Build Run Output';
const PIPELINE = [NORMALIZE, BASELINE, COLLECT, SOURCEDRIFT, EVAL, QUALITYDRIFT, AGG, DIGEST, INTEGRITY, AUDIT, BUILD];

// Mirror n8n's Code-node sandbox: items[], Buffer, $env, require. The deterministic stub bodies end in
// `return`; three carry `await` in their unreached live branch, so we run every node as async and await it.
async function runNode(name, items, env) {
  const node = nodeByName[name];
  if (!node) { throw new Error('missing Code node in compiled JSON: ' + name); }
  const fn = new AsyncFunction('items', 'Buffer', '$env', 'require', node.parameters.jsCode);
  return await fn(items, Buffer, env || {}, require);
}

let pass = 0;
let fail = 0;
function check(scenario, label, ok, detail) {
  if (ok) { pass += 1; } else { fail += 1; }
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + scenario + ' :: ' + label + (detail ? ' -> ' + detail : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s)) && /\d{4}-\d{2}-\d{2}T/.test(s);

// The pinned instant: makes Normalize (requestedAt fallback) + Audit (createdAt) + Build (processedAt)
// deterministic on the CORE side via opts.now. The compiled Audit/Build nodes call new Date().toISOString()
// with no override hook, so those two FINAL-record fields legitimately differ run-to-run on the compiled side
// (asserted ISO separately, then normalized for the structural compare). requestedAt is pinned on BOTH sides
// (supplied in the request + opts.now), so it is NOT normalized.
const PINNED_NOW = '2026-06-01T00:00:00.000Z';

// Coerce a fixture into its REPRODUCIBLE stub request: force stub mode, pin runId + requestedAt. The Layer-2
// injection knobs (stubSources / stubQuality / priorBaseline / stubDigestProse) and asOf are carried verbatim
// so each fixture's documented behavior is intact.
function toStubRequest(fixture) {
  const r = fixture.request || {};
  const runId = (typeof r.runId === 'string' && r.runId.length > 0) ? r.runId : fixture.id;
  const req = { ...r, mode: 'stub', runId, requestedAt: PINNED_NOW };
  return { req, opts: { now: PINNED_NOW, runIdFallback: runId } };
}

// Run the COMPILED deterministic-stub pipeline, capturing a deep-clone snapshot at each stage (the nodes
// spread-merge a fresh object each stage, but we clone for safety + to capture exact per-stage state).
async function runCompiled(req, env) {
  let items = [{ json: req }];
  const snap = {};
  for (const stage of PIPELINE) {
    items = await runNode(stage, items, env);
    if (!Array.isArray(items) || !items[0] || !items[0].json) { throw new Error(stage + ' returned a bad item shape'); }
    snap[stage] = structuredClone(items[0].json);
  }
  return { snap, final: snap[BUILD] };
}

// Run the CORE pipeline on the same request + injected instant, capturing each stage for the differential.
function runCore(req, opts) {
  const normalized = normalizeRunConfig(req, opts);
  const afterBaseline = loadPriorBaseline(normalized);
  const afterCollect = collectSourcesStub(afterBaseline);
  const afterSourceDrift = detectSourceDrift(afterCollect);
  const afterEval = collectEvalReadingStub(afterSourceDrift);
  const afterQualityDrift = detectQualityDrift(afterEval);
  const afterAgg = aggregateRunRecord(afterQualityDrift);
  const afterDigest = summarizeDigestStub(afterAgg);
  const afterIntegrity = enforceDigestIntegrity(afterDigest);
  const afterAudit = buildAuditEvent(afterIntegrity, opts);
  const record = buildRunOutput(afterAudit, opts);
  return {
    [NORMALIZE]: normalized, [BASELINE]: afterBaseline, [COLLECT]: afterCollect, [SOURCEDRIFT]: afterSourceDrift,
    [EVAL]: afterEval, [QUALITYDRIFT]: afterQualityDrift, [AGG]: afterAgg, [DIGEST]: afterDigest,
    [INTEGRITY]: afterIntegrity, [AUDIT]: afterAudit, record
  };
}

// Normalize the two non-injectable timestamps (createdAt in Audit, processedAt in Build) before a whole-record
// differential: the compiled Audit/Build nodes call new Date().toISOString() with no override hook, so those
// two fields legitimately differ run-to-run. We assert them as ISO separately, then blank them on both sides.
function blankVolatile(record) {
  const r = structuredClone(record);
  if (r.processedAt !== undefined) { r.processedAt = '<ts>'; }
  if (r.auditEvent && r.auditEvent.createdAt !== undefined) { r.auditEvent.createdAt = '<ts>'; }
  return r;
}
const blankCreatedAt = (ae) => { const c = structuredClone(ae); if (c.createdAt !== undefined) { c.createdAt = '<ts>'; } return c; };

// ---------------------------------------------------------------------------------------------------------
// PER-FIXTURE: every golden/regression fixture, run reproducibly offline through compiled jsCode + core.
// ---------------------------------------------------------------------------------------------------------
const goldenFiles = readdirSync(goldenDir).filter((f) => f.endsWith('.json')).sort();

for (const f of goldenFiles) {
  const fixture = JSON.parse(readFileSync(join(goldenDir, f), 'utf8'));
  const id = fixture.id || f.replace(/\.json$/, '');
  const exp = fixture.expect || {};
  const { req, opts } = toStubRequest(fixture);

  // (a) the DEPLOYED jsCode pipeline (extracted from the compiled canonical)
  let compiled;
  try {
    compiled = await runCompiled(req, {});
  } catch (e) {
    check(id, 'compiled pipeline executes', false, e.message);
    continue;
  }
  check(id, 'compiled pipeline executes', true);

  // (b) the audited core, same request + same injected instant
  const core = runCore(req, opts);

  // (c) DIFFERENTIAL — each compiled stage output EQUALS the core's on the same input.
  check(id, 'DIFF normalize == core (runtime+inject+request)',
    eq(compiled.snap[NORMALIZE].runtime, core[NORMALIZE].runtime)
    && eq(compiled.snap[NORMALIZE].inject, core[NORMALIZE].inject)
    && eq(compiled.snap[NORMALIZE].request, core[NORMALIZE].request)
    && eq(compiled.snap[NORMALIZE].sourcePayloadKeys, core[NORMALIZE].sourcePayloadKeys));
  check(id, 'DIFF load baseline == core', eq(compiled.snap[BASELINE].baseline, core[BASELINE].baseline));
  check(id, 'DIFF collect sources == core', eq(compiled.snap[COLLECT].freshness, core[COLLECT].freshness));
  check(id, 'DIFF detect source drift == core', eq(compiled.snap[SOURCEDRIFT].freshness, core[SOURCEDRIFT].freshness));
  check(id, 'DIFF collect eval reading == core', eq(compiled.snap[EVAL].quality, core[EVAL].quality));
  check(id, 'DIFF detect quality drift == core', eq(compiled.snap[QUALITYDRIFT].quality, core[QUALITYDRIFT].quality));
  check(id, 'DIFF aggregate (drift) == core', eq(compiled.snap[AGG].drift, core[AGG].drift));
  check(id, 'DIFF summarize digest == core', eq(compiled.snap[DIGEST].digest, core[DIGEST].digest));
  check(id, 'DIFF enforce digest integrity == core', eq(compiled.snap[INTEGRITY].digestIntegrity, core[INTEGRITY].digestIntegrity));
  // audit createdAt has no override hook on the compiled side -> blank it on both sides; auditEventId is
  // runId/asOf-derived (pinned), so it is NOT blanked and is proven byte-identical (the load-bearing hash).
  check(id, 'DIFF audit event == core (createdAt-normalized)',
    eq(blankCreatedAt(compiled.snap[AUDIT].auditEvent), blankCreatedAt(core[AUDIT].auditEvent)));
  check(id, 'DIFF auditEventId == core (runId/asOf-derived hash)',
    compiled.snap[AUDIT].auditEvent.auditEventId === core[AUDIT].auditEvent.auditEventId,
    compiled.snap[AUDIT].auditEvent.auditEventId + ' vs ' + core[AUDIT].auditEvent.auditEventId);
  // whole-record differential (the two Date-derived timestamps normalized identically on both sides)
  check(id, 'DIFF build run output record == core (whole record, ts-normalized)',
    eq(blankVolatile(compiled.final), blankVolatile(core.record)), 'records diverge');

  // (d) BEHAVIORAL expectations against the DEPLOYED jsCode (the documented fixture outcomes).
  const rec = compiled.final;
  check(id, 'mode == stub (offline; live degraded)', rec.mode === 'stub', rec.mode);
  check(id, 'policyVersion == ' + POLICY_VERSION, rec.policyVersion === POLICY_VERSION, rec.policyVersion);
  check(id, 'processedAt is ISO', isIso(rec.processedAt), rec.processedAt);
  check(id, 'audit createdAt is ISO', isIso(rec.auditEvent.createdAt), rec.auditEvent.createdAt);
  check(id, 'freshness.fetchSource == stub', rec.freshness.fetchSource === 'stub', rec.freshness.fetchSource);
  check(id, 'quality.evalSource == stub', rec.quality.evalSource === 'stub', rec.quality.evalSource);
  // DETECT-ONLY invariant: zero live writes anywhere in the run (reembedded is always 0).
  check(id, 'reembedded == 0 (detect-only; zero live writes)', rec.freshness.reembedded === 0, String(rec.freshness.reembedded));

  if (exp.driftAny !== undefined) { check(id, 'drift.any == ' + exp.driftAny, rec.drift.any === exp.driftAny, String(rec.drift.any)); }
  if (exp.regressed !== undefined) { check(id, 'quality.regressed == ' + exp.regressed, rec.quality.regressed === exp.regressed, String(rec.quality.regressed)); }
  if (exp.changed !== undefined) { check(id, 'freshness.changed == ' + exp.changed, rec.freshness.changed === exp.changed, String(rec.freshness.changed)); }
  if (exp.stale !== undefined) { check(id, 'freshness.stale == ' + exp.stale, rec.freshness.stale === exp.stale, String(rec.freshness.stale)); }
  if (exp.unreachable !== undefined) { check(id, 'freshness.unreachable == ' + exp.unreachable, rec.freshness.unreachable === exp.unreachable, String(rec.freshness.unreachable)); }
  if (exp.reembedded !== undefined) { check(id, 'freshness.reembedded == ' + exp.reembedded, rec.freshness.reembedded === exp.reembedded, String(rec.freshness.reembedded)); }
  if (exp.passed !== undefined) { check(id, 'passed == ' + exp.passed, rec.passed === exp.passed, String(rec.passed)); }
  if (exp.digestIntegrity !== undefined) { check(id, 'digestIntegrity.passed == ' + exp.digestIntegrity, rec.digestIntegrity.passed === exp.digestIntegrity, String(rec.digestIntegrity.passed)); }
  if (exp.summarySource !== undefined) { check(id, 'digest.summarySource == ' + exp.summarySource, rec.digest.summarySource === exp.summarySource, rec.digest.summarySource); }

  // DIGEST-INTEGRITY headline invariant: passed flows from digestIntegrity (a fabricated digest fails the run).
  check(id, 'run passed iff digestIntegrity passed', rec.passed === rec.digestIntegrity.passed, 'passed=' + rec.passed + ' integrity=' + rec.digestIntegrity.passed);
  // METRICS line is always present + record-grounded: the appended key=value line must echo the record.
  const metricsOk = rec.digestIntegrity.checks
    .filter((c) => ['passRate', 'passRateDelta', 'regressed', 'changed', 'stale', 'unreachable', 'driftAny'].includes(c.name))
    .every((c) => c.ok === true);
  check(id, 'METRICS line matches record (all 7 record-grounded checks ok)', metricsOk);

  // MASKING invariant: the redacted audit event carries no source urls and no digest prose.
  const auditStr = JSON.stringify(rec.auditEvent);
  check(id, 'audit omits source urls + digest prose (masking)',
    !/"url"/.test(auditStr) && !/"markdown"/.test(auditStr) && !/https?:\/\//.test(auditStr) && !/"sources"/.test(auditStr));

  // (e) traceId capture-and-echo (additive correlation): the optional caller-supplied traceId/requestId surfaces
  // in the run-output record, the redacted audit event, AND on runtime — never generated. When the fixture omits
  // it, all three are null (additive — the whole-record differential above proves the absent case keeps its record
  // otherwise byte-identical; the only new field is traceId:null). The expected value is resolved from the request
  // (NOT a derived hash), so it also proves traceId feeds no id/hash seed. It is NOT in the digest prose, so it
  // cannot reach the digest-integrity prose scan (the negatives below still reject independently).
  const expectedTraceId = req.traceId ?? req.requestId ?? null;
  check(id, 'record.traceId echoes caller (or null when absent)', rec.traceId === expectedTraceId, JSON.stringify(rec.traceId));
  check(id, 'auditEvent.traceId echoes caller (or null when absent)', rec.auditEvent.traceId === expectedTraceId, JSON.stringify(rec.auditEvent.traceId));
  check(id, 'runtime.traceId echoes caller (or null when absent)', compiled.snap[NORMALIZE].runtime.traceId === expectedTraceId, JSON.stringify(compiled.snap[NORMALIZE].runtime.traceId));
  if (exp.traceId !== undefined) { check(id, 'traceId == ' + JSON.stringify(exp.traceId), rec.traceId === exp.traceId, JSON.stringify(rec.traceId)); }
  // traceId is kept OUT of the digest prose -> the digest markdown must NOT contain the trace id token.
  if (expectedTraceId) { check(id, 'traceId absent from digest prose (digest-integrity safe)', !String(rec.digest.markdown || '').includes(String(expectedTraceId)), 'trace id leaked into digest'); }
}

// ---------------------------------------------------------------------------------------------------------
// traceId correlation pin (additive capture-and-echo, never generated): a WEBHOOK-triggered run carrying
// body.traceId echoes it into runtime.traceId, the redacted audit event, AND the run-output record. A BARE
// SCHEDULE run carries traceId:null in all three (the documented "null on schedule runs" guarantee). requestId
// is the documented fallback. CRITICAL: traceId must NOT perturb the runId/asOf-derived auditEventId (it feeds
// no id/hash seed) and must NOT leak into the digest prose (so the digest-integrity prose scan never sees it).
// We feed requests DIRECTLY (no toStubRequest body-wrapper coercion) so the webhook entrypoint is real.
// ---------------------------------------------------------------------------------------------------------
{
  const opts = { now: PINNED_NOW, runIdFallback: 'run_trace' };
  // (1) webhook-triggered run with a supplied traceId: source.body present -> entrypoint=webhook; body.traceId captured.
  const webhookReq = { body: { mode: 'stub', runId: 'run_trace', requestedAt: PINNED_NOW, asOf: '2026-05-31', traceId: 'trace-drift-123' } };
  const wfRun = await runCompiled(webhookReq, {});
  const wfRec = wfRun.final;
  check('pin:traceid', 'webhook entrypoint detected', wfRec.entrypoint === 'webhook', wfRec.entrypoint);
  check('pin:traceid', 'supplied traceId on runtime', wfRun.snap[NORMALIZE].runtime.traceId === 'trace-drift-123', JSON.stringify(wfRun.snap[NORMALIZE].runtime.traceId));
  check('pin:traceid', 'supplied traceId echoed in run record', wfRec.traceId === 'trace-drift-123', JSON.stringify(wfRec.traceId));
  check('pin:traceid', 'supplied traceId echoed in audit event', wfRec.auditEvent.traceId === 'trace-drift-123', JSON.stringify(wfRec.auditEvent.traceId));
  check('pin:traceid', 'traceId NOT in digest prose (digest-integrity safe)', !String(wfRec.digest.markdown || '').includes('trace-drift-123'), 'leaked into digest');
  check('pin:traceid', 'digest integrity still holds with a traceId present', wfRec.digestIntegrity.passed === true, String(wfRec.digestIntegrity.passed));
  // differential: webhook run record == core (ts-normalized) — the traceId path is mirrored byte-identically.
  const wfCore = runCore(webhookReq, opts);
  check('pin:traceid', 'DIFF webhook record == core (ts-normalized)', eq(blankVolatile(wfRec), blankVolatile(wfCore.record)), 'records diverge');

  // (2) bare SCHEDULE run (no body wrapper, no traceId) -> traceId null in all three surfaces (additive).
  const bareReq = { mode: 'stub', runId: 'run_trace', requestedAt: PINNED_NOW, asOf: '2026-05-31' };
  const bareRun = await runCompiled(bareReq, {});
  const bareRec = bareRun.final;
  check('pin:traceid', 'bare schedule run -> entrypoint schedule', bareRec.entrypoint === 'schedule', bareRec.entrypoint);
  check('pin:traceid', 'absent traceId is null on runtime (additive)', bareRun.snap[NORMALIZE].runtime.traceId === null, JSON.stringify(bareRun.snap[NORMALIZE].runtime.traceId));
  check('pin:traceid', 'absent traceId is null in run record (additive)', bareRec.traceId === null, JSON.stringify(bareRec.traceId));
  check('pin:traceid', 'absent traceId is null in audit event (additive)', bareRec.auditEvent.traceId === null, JSON.stringify(bareRec.auditEvent.traceId));

  // (3) requestId fallback: traceId absent but requestId present -> echoed (proves the ?? requestId fallback).
  const fbReq = { body: { mode: 'stub', runId: 'run_trace', requestedAt: PINNED_NOW, asOf: '2026-05-31', requestId: 'req-drift-789' } };
  const fbRun = await runCompiled(fbReq, {});
  check('pin:traceid', 'requestId fallback echoed in record when traceId absent', fbRun.final.traceId === 'req-drift-789', JSON.stringify(fbRun.final.traceId));
  check('pin:traceid', 'requestId fallback echoed in audit when traceId absent', fbRun.final.auditEvent.traceId === 'req-drift-789', JSON.stringify(fbRun.final.auditEvent.traceId));

  // (4) traceId feeds NO id/hash seed: the auditEventId for the SAME run (runId+asOf) is identical with and
  // without a traceId. The webhook run (with traceId) vs the bare run (without) share runId+asOf, so the
  // runId/asOf-derived auditEventId must match.
  check('pin:traceid', 'auditEventId unaffected by traceId (no hash seed)',
    wfRec.auditEvent.auditEventId === bareRec.auditEvent.auditEventId,
    wfRec.auditEvent.auditEventId + ' vs ' + bareRec.auditEvent.auditEventId);
}

// ---------------------------------------------------------------------------------------------------------
// DIGEST-INTEGRITY NEGATIVES (load-bearing): a fabricated pass-rate in the summarizer prose MUST be rejected
// (digestIntegrity.passed=false), in BOTH the decimal (digest-fabricated-prose) and percentage
// (digest-fabricated-percent) shapes. The METRICS line is recomputed from the record (so it still matches) —
// proving the rejection comes from the PROSE-CLAIM guard, exactly the failure the pre-v0.3.0 METRICS-only
// check could not catch. We also assert the fabricated token is the one named in the prose check.
for (const neg of [
  { file: 'digest-fabricated-prose.json', token: '0.99', shape: 'decimal' },
  { file: 'digest-fabricated-percent.json', token: '99%', shape: 'percentage' }
]) {
  const fixture = JSON.parse(readFileSync(join(goldenDir, neg.file), 'utf8'));
  const id = fixture.id;
  const { req } = toStubRequest(fixture);
  const compiled = await runCompiled(req, {});
  const ic = compiled.final.digestIntegrity;
  check(id, 'digestIntegrity REJECTS fabricated ' + neg.shape + ' (passed=false)', ic.passed === false, String(ic.passed));
  check(id, 'run passed=false (fabricated digest fails the run)', compiled.final.passed === false, String(compiled.final.passed));
  const proseCheck = ic.checks.find((c) => c.name === 'prose-no-fabricated-rate');
  check(id, 'prose-no-fabricated-rate check is FAILING', !!(proseCheck && proseCheck.ok === false), proseCheck ? String(proseCheck.ok) : 'missing');
  check(id, 'fabricated token "' + neg.token + '" flagged in prose check', !!(proseCheck && String(proseCheck.parsed).includes(neg.token)), proseCheck ? proseCheck.parsed : 'missing');
  // The 7 record-grounded METRICS checks STILL pass (the line is recomputed from the record) — proving the
  // rejection is the prose guard, not a corrupted METRICS line.
  const metricsStillOk = ic.checks
    .filter((c) => ['passRate', 'passRateDelta', 'regressed', 'changed', 'stale', 'unreachable', 'driftAny'].includes(c.name))
    .every((c) => c.ok === true);
  check(id, 'METRICS line still matches record (rejection is the prose guard, not METRICS corruption)', metricsStillOk);
}

// ---------------------------------------------------------------------------------------------------------
// SAFE-DEGRADE STUB LABELS: a BARE scheduled run (an empty body — no mode, no asOf, no injections, exactly the
// scheduleTrigger entrypoint) must take the reproducible stub path everywhere CI touches and produce the stub
// labels (mode=stub, fetchSource=stub, evalSource=stub, summarySource=stub) + the all-clear verdict (the
// current reading defaults to the baseline -> no false alarm). This is the offline-lane degrade contract: with
// no live knobs the workflow stays deterministic. asOf is pinned (the bare body has none) so the differential
// is reproducible; everything else is left at its node defaults. compiled == core.
//
// NOTE on the LIVE path (intentionally NOT exercised here): a request that ASKS for mode:'live' makes the
// compiled nodes ENTER their live branches (fetchSource:'http', a real httpRequest, an Ollama POST). Those are
// out of scope for this offline gate (they belong to verify:drift-live) and are NOT mirrored in drift-core —
// driving them here would call out over HTTP. This gate proves only the deterministic stub lane.
{
  const id = 'safe-degrade-scheduled';
  // A bare scheduled body: no 'body' wrapper (so entrypoint=schedule), no mode (defaults to stub), only asOf
  // pinned for a reproducible stale=0. The Normalize defaults supply everything else.
  const req = { asOf: '2026-05-31', runId: 'run_safe-degrade', requestedAt: PINNED_NOW };
  const opts = { now: PINNED_NOW, runIdFallback: req.runId };
  let compiled;
  try {
    compiled = await runCompiled(req, {});
  } catch (e) {
    check(id, 'compiled pipeline executes', false, e.message);
  }
  if (compiled) {
    const core = runCore(req, opts);
    const rec = compiled.final;
    check(id, 'entrypoint == schedule (bare scheduled run)', rec.entrypoint === 'schedule', rec.entrypoint);
    check(id, 'mode == stub (default; offline lane)', rec.mode === 'stub', rec.mode);
    check(id, 'freshness.fetchSource == stub', rec.freshness.fetchSource === 'stub', rec.freshness.fetchSource);
    check(id, 'quality.evalSource == stub', rec.quality.evalSource === 'stub', rec.quality.evalSource);
    check(id, 'digest.summarySource == stub (not ollama)', rec.digest.summarySource === 'stub', rec.digest.summarySource);
    check(id, 'all-clear (no false alarm on a bare stub run)', rec.drift.any === false && rec.passed === true, 'driftAny=' + rec.drift.any + ' passed=' + rec.passed);
    check(id, 'DIFF whole record == core (ts-normalized)', eq(blankVolatile(rec), blankVolatile(core.record)), 'records diverge');
  }
}

console.log('');
console.log('drift-workflow behavioral self-test: ' + pass + ' passed, ' + fail + ' failed ('
  + goldenFiles.length + ' golden/regression fixtures + integrity negatives + safe-degrade, OFFLINE, compiled jsCode + differential vs core)');
process.exit(fail > 0 ? 1 : 0);
