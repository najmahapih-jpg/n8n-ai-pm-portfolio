// test-feedback-workflow.mjs — offline behavioral proof of the COMPILED product-feedback-intelligence workflow.
// (npm run verify:workflow; also run inside verify:static.)
//
// Why this exists: n8n Code nodes cannot import feedback-core.mjs, so the deployed DETERMINISTIC stub-path logic
// is a COPY embedded as jsCode. The repo's only behavioral coverage was verify:live (a live n8n run via MCP,
// NOT in CI), so the compiled jsCode was never executed offline. This gate closes that gap — it is the
// portfolio's signature discipline (cf. interaction-gateway's test-gateway-workflow.mjs / llm-eval-harness's
// test-eval-workflow.mjs / rag-knowledge-assistant's test-rag-workflow.mjs). It:
//   1) loads the compiled CANONICAL JSON (the deploy artifact),
//   2) extracts each deterministic-STUB Code node's jsCode and runs the pin-data fixtures through the real stub
//      pipeline (Normalize -> [Field Present?] -> [Non-empty?] -> [Classifier Mode = Ollama? -> stub] ->
//      Classify (stub) -> Resolve -> Derive Urgency -> Score Priority -> Redact PII -> Audit ->
//      [Needs Human Review?] -> Build Approval | Build Classified), threading each node's output into the next
//      exactly as n8n would, PLUS the Required-Field 400 and Empty-Feedback 422 error branches,
//   3) DIFFERENTIALLY checks each stage's output against feedback-core.mjs on the same inputs (byte-identical),
//   4) asserts the documented behavioral expectations (theme/sentiment/urgency/priorityScore/HITL per fixture;
//      the finding-#5 garbage-classifierMode -> classifierSource 'stub' default; PII masking; audit redaction).
// So the deployed deterministic stub path can't silently drift from the audited core. No n8n, no network.
//
// SCOPE: only the DETERMINISTIC STUB PATH (the offline lane CI touches). The LIVE classifier branch
// (Classifier Mode = Ollama? -> Classify Feedback (Ollama) HTTP node + Parse Ollama Response, which references
// $('Normalize Feedback Payload') and calls Ollama over HTTP) is intentionally NOT exercised here — it belongs
// to verify:live. Fixtures are run in their REPRODUCIBLE stub form: classifierMode defaults to 'stub' and
// submittedAt is supplied by every fixture, with createdAt pinned so the records (and the submittedAt-derived
// feedbackId/auditEventId) are byte-stable.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import {
  normalizeFeedback, classifyStub, resolveClassification, deriveUrgency, scorePriority,
  redactFeedbackPii, buildAuditEvent, buildApprovalResponse, buildClassifiedResponse,
  buildRequiredError, buildEmptyError, needsHumanReview, POLICY_VERSION
} from './lib/feedback-core.mjs';

// The deployed Code nodes assume n8n's sandbox globals (items, Buffer, $env, require, $). The deterministic stub
// nodes use only `items`; we inject a real require + Buffer for parity with how n8n builds the fn. ($ is only
// referenced by the LIVE-only Parse Ollama Response node, which we never run here.)
const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const canonicalPath = join(repoRoot, 'workflows', 'canonical', 'product-feedback-intelligence.canonical.json');
const pinDataDir = join(repoRoot, 'fixtures', 'pin-data');

const wf = JSON.parse(readFileSync(canonicalPath, 'utf8'));
const nodeByName = {};
for (const n of wf.nodes) { nodeByName[n.name] = n; }

// The deterministic-STUB pipeline node names (the offline lane).
const NORMALIZE = 'Normalize Feedback Payload';
const CLASSIFY = 'Classify Feedback (stub)';
const RESOLVE = 'Resolve Classification (confidence gate + fallback)';
const URGENCY = 'Derive Urgency';
const PRIORITY = 'Score Priority';
const REDACT = 'Redact Feedback PII';
const AUDIT = 'Create Redacted Audit Event';
const APPROVAL = 'Build Approval-Gated Response';
const CLASSIFIED = 'Build Classified Response';
const REQUIRED_ERR = 'Build Required Field Error';
const EMPTY_ERR = 'Build Empty Feedback Error';

// Mirror n8n's Code-node sandbox: items[], Buffer, $env, require. The body ends in `return`.
function runNode(name, items, env) {
  const node = nodeByName[name];
  if (!node) { throw new Error('missing Code node in compiled JSON: ' + name); }
  if (node.type !== 'n8n-nodes-base.code') { throw new Error('not a Code node: ' + name); }
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

// Pin createdAt so the compiled Audit node — which defaults createdAt to wall-clock — produces a record
// byte-identical to the core's (fed the SAME pin via opts.now). Every pin-data fixture supplies submittedAt, so
// the normalize submittedAt-fallback never fires; opts.now still threads the SAME value into normalize's
// fallback on both sides for completeness. The fixture is taken verbatim (no `.body` wrapper — Normalize
// tolerates both via `source.body ?? source`). classifierMode is absent in every fixture -> defaults to 'stub'.
const PINNED_AT = '2026-06-01T00:00:00.000Z';
function toStubOpts() {
  return { now: PINNED_AT };
}

// Run the COMPILED deterministic-stub HAPPY pipeline, capturing a deep-clone snapshot at each stage. The two
// validation gates (Field Present?, Non-empty?) and the Needs Human Review? gate are n8n ifElse nodes; we
// replicate their boolean decisions in JS to select the branch exactly as n8n routes, so the gated Code node the
// compiled jsCode runs matches the core's branch decision (runStubFeedback makes the identical decision).
// Returns { snap, final, branch }.
const HAPPY_CHAIN = [CLASSIFY, RESOLVE, URGENCY, PRIORITY, REDACT, AUDIT];
function runCompiled(fixture, env) {
  let items = [{ json: fixture }];
  const snap = {};
  // Normalize (linear)
  items = runNode(NORMALIZE, items, env);
  if (!Array.isArray(items) || !items[0] || !items[0].json) { throw new Error(NORMALIZE + ' returned a bad item shape'); }
  snap[NORMALIZE] = structuredClone(items[0].json);

  // Field Present? gate (mirrors the ifElse on validation.requiredFieldsPresent).
  if (!snap[NORMALIZE].validation.requiredFieldsPresent) {
    items = runNode(REQUIRED_ERR, items, env);
    snap[REQUIRED_ERR] = structuredClone(items[0].json);
    return { snap, final: snap[REQUIRED_ERR], branch: 'required-error' };
  }
  // Non-empty? gate (mirrors the ifElse on validation.nonEmpty).
  if (!snap[NORMALIZE].validation.nonEmpty) {
    items = runNode(EMPTY_ERR, items, env);
    snap[EMPTY_ERR] = structuredClone(items[0].json);
    return { snap, final: snap[EMPTY_ERR], branch: 'empty-error' };
  }
  // Classifier Mode = Ollama? gate -> onFalse path (stub) is the offline lane.
  for (const stage of HAPPY_CHAIN) {
    items = runNode(stage, items, env);
    if (!Array.isArray(items) || !items[0] || !items[0].json) { throw new Error(stage + ' returned a bad item shape'); }
    snap[stage] = structuredClone(items[0].json);
  }
  // Needs Human Review? gate (mirrors the ifElse on theme==churn_risk || urgency==critical).
  const afterAudit = snap[AUDIT];
  const hitl = afterAudit.classification.theme === 'churn_risk' || afterAudit.derived.urgency === 'critical';
  snap.__hitl = hitl;
  const respStage = hitl ? APPROVAL : CLASSIFIED;
  items = runNode(respStage, items, env);
  if (!Array.isArray(items) || !items[0] || !items[0].json) { throw new Error(respStage + ' returned a bad item shape'); }
  snap[respStage] = structuredClone(items[0].json);
  snap.__respStage = respStage;
  return { snap, final: snap[respStage], branch: hitl ? 'approval' : 'classified' };
}

// Normalize the non-injectable timestamp (createdAt in Audit, surfaced on the response.auditEvent) before a
// whole-record differential: the compiled Audit node calls new Date().toISOString() with no override hook, so
// that one field legitimately differs run-to-run. We assert it as ISO format separately, then blank it on both
// sides for the structural compare. submittedAt IS pinned/supplied on both sides so it is NOT blanked.
function blankVolatileTimestamps(record) {
  const r = structuredClone(record);
  if (r.auditEvent) { r.auditEvent.createdAt = '<ts>'; }
  return r;
}

// Documented behavioral expectations per pin-data fixture (mirrors Test-ProductFeedbackWorkflow.ps1's cases).
const fixtureExpectations = {
  'feedback-bug-negative.json': { node: CLASSIFIED, theme: 'bug', sentiment: 'negative', urgency: 'high', status: 'classified', needsHumanReview: false, classifierSource: 'stub', priorityScore: 24, containsEmail: true },
  'feedback-feature-request.json': { node: CLASSIFIED, theme: 'feature_request', sentiment: 'neutral', urgency: 'normal', status: 'classified', needsHumanReview: false, classifierSource: 'stub', priorityScore: 27 },
  'feedback-praise.json': { node: CLASSIFIED, theme: 'praise', sentiment: 'positive', urgency: 'low', status: 'classified', needsHumanReview: false, classifierSource: 'stub', priorityScore: 1 },
  'feedback-churn-risk.json': { node: APPROVAL, theme: 'churn_risk', sentiment: 'negative', urgency: 'critical', status: 'awaiting_approval', needsHumanReview: true, classifierSource: 'stub', priorityScore: 20 },
  'feedback-performance.json': { node: CLASSIFIED, theme: 'performance', sentiment: 'negative', urgency: 'high', status: 'classified', needsHumanReview: false, classifierSource: 'stub', priorityScore: 36 },
  'feedback-pricing.json': { node: CLASSIFIED, theme: 'pricing', sentiment: 'negative', urgency: 'normal', status: 'classified', needsHumanReview: false, classifierSource: 'stub', priorityScore: 9 },
  'feedback-usability.json': { node: CLASSIFIED, theme: 'usability', sentiment: 'negative', urgency: 'normal', status: 'classified', needsHumanReview: false, classifierSource: 'stub', priorityScore: 15 },
  'feedback-low-confidence-fallback.json': { node: CLASSIFIED, theme: 'other', sentiment: 'neutral', urgency: 'normal', status: 'classified', needsHumanReview: false, classifierSource: 'fallback', priorityScore: 3 },
  'feedback-prompt-injection.json': { node: CLASSIFIED, theme: 'other', sentiment: 'neutral', urgency: 'normal', status: 'classified', needsHumanReview: false, classifierSource: 'fallback', priorityScore: 3 },
  'feedback-missing-text.json': { node: REQUIRED_ERR, statusCode: 400, ok: false, error: 'Missing required feedback field', missingField: 'feedbackText' }
};

// ---------------------------------------------------------------------------------------------------------
// HAPPY / ERROR PATH (deterministic stub) — every pin-data fixture, run reproducibly offline:
// compiled stub pipeline == core (per stage + whole record) + documented behavioral expectations.
// ---------------------------------------------------------------------------------------------------------
const fixtureFiles = readdirSync(pinDataDir).filter((f) => f.endsWith('.json')).sort();
check('coverage', 'every pin-data fixture has an expectation', fixtureFiles.every((f) => fixtureExpectations[f]),
  fixtureFiles.filter((f) => !fixtureExpectations[f]).join(',') || 'all covered');

for (const file of fixtureFiles) {
  const id = file.replace(/\.json$/, '');
  const fixture = JSON.parse(readFileSync(join(pinDataDir, file), 'utf8'));
  const exp = fixtureExpectations[file];
  const opts = toStubOpts();

  // (a) the DEPLOYED jsCode pipeline (extracted from the compiled canonical)
  let compiled;
  try {
    compiled = runCompiled(fixture, {});
  } catch (e) {
    check(id, 'compiled pipeline executes', false, e.message);
    continue;
  }
  check(id, 'compiled pipeline executes', true);

  // (b) the audited core, same request + same injected instant (runStubFeedback makes the same gate decisions).
  const coreNorm = normalizeFeedback(fixture, opts);

  // (c) DIFFERENTIAL — normalize is always exercised; compare it for every fixture.
  check(id, 'DIFF normalize == core (feedback+validation+runtime+keys)',
    eq(compiled.snap[NORMALIZE].feedback, coreNorm.feedback)
    && eq(compiled.snap[NORMALIZE].validation, coreNorm.validation)
    && eq(compiled.snap[NORMALIZE].runtime, coreNorm.runtime)
    && eq(compiled.snap[NORMALIZE].sourcePayloadKeys, coreNorm.sourcePayloadKeys));

  if (compiled.branch === 'required-error') {
    const coreErr = buildRequiredError(coreNorm);
    check(id, 'DIFF required-error record == core', eq(compiled.final, coreErr), 'records diverge');
    check(id, 'statusCode == 400', compiled.final.statusCode === 400, String(compiled.final.statusCode));
    check(id, 'response.ok == false', compiled.final.response.ok === false);
    check(id, 'error message present', typeof compiled.final.response.error === 'string' && compiled.final.response.error.length > 0);
    check(id, 'policyVersion == ' + POLICY_VERSION, compiled.final.response.policyVersion === POLICY_VERSION, compiled.final.response.policyVersion);
    if (exp.missingField) {
      check(id, 'missingFields includes ' + exp.missingField, Array.isArray(compiled.final.response.missingFields) && compiled.final.response.missingFields.includes(exp.missingField), JSON.stringify(compiled.final.response.missingFields));
    }
    continue;
  }
  if (compiled.branch === 'empty-error') {
    const coreErr = buildEmptyError(coreNorm);
    check(id, 'DIFF empty-error record == core', eq(compiled.final, coreErr), 'records diverge');
    check(id, 'statusCode == 422', compiled.final.statusCode === 422, String(compiled.final.statusCode));
    check(id, 'response.ok == false', compiled.final.response.ok === false);
    continue;
  }

  // HAPPY branch — full per-stage + whole-record differential vs core.
  const coreClassify = classifyStub(coreNorm);
  const coreResolve = resolveClassification(coreClassify);
  const coreUrgency = deriveUrgency(coreResolve);
  const corePriority = scorePriority(coreUrgency);
  const corePii = redactFeedbackPii(corePriority);
  const coreAudit = buildAuditEvent(corePii, opts);
  const coreHitl = needsHumanReview(coreAudit);
  const coreRecord = coreHitl ? buildApprovalResponse(coreAudit) : buildClassifiedResponse(coreAudit);

  check(id, 'Needs-Human-Review gate decision == core', compiled.snap.__hitl === coreHitl,
    'compiled ' + compiled.snap.__hitl + ' vs core ' + coreHitl);
  check(id, 'DIFF classify (stub) == core', eq(compiled.snap[CLASSIFY].classification, coreClassify.classification));
  check(id, 'DIFF resolve classification == core', eq(compiled.snap[RESOLVE].classification, coreResolve.classification));
  check(id, 'DIFF derive urgency == core', eq(compiled.snap[URGENCY].derived, coreUrgency.derived));
  check(id, 'DIFF score priority == core', eq(compiled.snap[PRIORITY].derived, corePriority.derived));
  check(id, 'DIFF redact PII == core', eq(compiled.snap[REDACT].pii, corePii.pii));
  check(id, 'DIFF identity == core (feedbackId/idempotencyKey)', eq(compiled.snap[AUDIT].identity, coreAudit.identity));
  // The audit node calls new Date().toISOString() for createdAt with NO override hook, so that one field
  // legitimately differs run-to-run on the compiled side (asserted ISO separately below). Blank it on both
  // sides for the structural compare; the submittedAt-derived auditEventId/feedbackId are NOT blanked (they are
  // pinned and proven byte-identical — the load-bearing hash differential).
  const blankCreatedAt = (ae) => { const c = structuredClone(ae); c.createdAt = '<ts>'; return c; };
  check(id, 'DIFF audit event == core (createdAt-normalized)',
    eq(blankCreatedAt(compiled.snap[AUDIT].auditEvent), blankCreatedAt(coreAudit.auditEvent)));
  check(id, 'DIFF auditEventId == core (submittedAt-derived hash)',
    compiled.snap[AUDIT].auditEvent.auditEventId === coreAudit.auditEvent.auditEventId,
    compiled.snap[AUDIT].auditEvent.auditEventId + ' vs ' + coreAudit.auditEvent.auditEventId);
  // whole-record differential (the Date-derived createdAt normalized identically on both sides).
  check(id, 'DIFF build response record == core (whole record, ts-normalized)',
    eq(blankVolatileTimestamps(compiled.final), blankVolatileTimestamps(coreRecord)), 'records diverge');

  // (d) BEHAVIORAL expectations against the DEPLOYED jsCode.
  const final = compiled.final;
  const resp = final.response;
  check(id, 'routed to ' + exp.node, compiled.snap.__respStage === exp.node, compiled.snap.__respStage);
  check(id, 'statusCode == 200', final.statusCode === 200, 'got ' + final.statusCode);
  check(id, 'response.ok == true', resp.ok === true);
  check(id, 'theme == ' + exp.theme, resp.theme === exp.theme, resp.theme);
  check(id, 'sentiment == ' + exp.sentiment, resp.sentiment === exp.sentiment, resp.sentiment);
  check(id, 'urgency == ' + exp.urgency, resp.urgency === exp.urgency, resp.urgency);
  check(id, 'status == ' + exp.status, resp.status === exp.status, resp.status);
  check(id, 'needsHumanReview == ' + exp.needsHumanReview, resp.needsHumanReview === exp.needsHumanReview, String(resp.needsHumanReview));
  check(id, 'classifierSource == ' + exp.classifierSource, resp.classifierSource === exp.classifierSource, resp.classifierSource);
  check(id, 'priorityScore == ' + exp.priorityScore, resp.priorityScore === exp.priorityScore, String(resp.priorityScore));
  check(id, 'confidence in [0,1]', typeof resp.confidence === 'number' && resp.confidence >= 0 && resp.confidence <= 1, String(resp.confidence));
  check(id, 'policyVersion == ' + POLICY_VERSION, resp.policyVersion === POLICY_VERSION, resp.policyVersion);
  check(id, 'audit createdAt is ISO', isIso(final.auditEvent.createdAt), final.auditEvent.createdAt);

  // PII MASKING / absence: no UNMASKED email anywhere in the response or the redacted audit event. The
  // workflow's masking deliberately keeps the domain (local-part -> `x***@domain`), so the redacted form
  // `x***@example.test` is email-shaped BY DESIGN and is the expected safe marker — we only flag a leak if an
  // email with a real (>=2-char, non-`***`) local-part appears. (The raw-address check below is the strict one.)
  const serialized = JSON.stringify(final.response) + JSON.stringify(final.auditEvent);
  const unmaskedEmailRe = /[^\s@"*][^\s@"*]+@[^\s@"]+\.[^\s@"]+/;
  check(id, 'no unmasked email in response/audit (masking keeps domain by design)', !unmaskedEmailRe.test(serialized),
    unmaskedEmailRe.test(serialized) ? 'LEAK' : 'clean');
  if (exp.containsEmail) {
    check(id, 'redactedEmail is masked (***)', typeof final.auditEvent.redactedEmail === 'string' && final.auditEvent.redactedEmail.includes('***'), final.auditEvent.redactedEmail);
    // the raw email local-part/full address must NOT appear verbatim in the serialized output.
    const rawEmail = (String(fixture.feedbackText).match(/[^\s@]+@[^\s@]+\.[^\s@]+/) || [])[0];
    if (rawEmail) { check(id, 'raw email NOT leaked', !serialized.includes(rawEmail), rawEmail); }
  }
  // the audit event must NOT carry the raw feedbackText (only the 60-char safe excerpt + masked email).
  check(id, 'audit omits raw feedbackText key', !/"feedbackText"/.test(JSON.stringify(final.auditEvent)));
}

// ---------------------------------------------------------------------------------------------------------
// FINDING #5 — INVALID/garbage classifierMode defaults to runtime.classifierMode = 'stub' (the offline lane).
// The Normalize node only treats the EXACT literal 'ollama' (case-insensitively, trimmed) as live; everything
// else — garbage strings, empty, whitespace, numbers, the absent field, even mixed-case near-misses — defaults
// to 'stub'. We assert the COMPILED Normalize node (not only the core) against the core for each, and that the
// stub default actually drives the stub classifier pipeline (classifierSource 'stub'/'fallback', never 'ollama').
// ---------------------------------------------------------------------------------------------------------
{
  const base = { feedbackText: 'The export button is broken and crashes.', reportedCount: 1, source: 'test', submittedAt: PINNED_AT };
  const garbageModes = [
    { id: 'garbage-string', classifierMode: 'totally-not-a-mode' },
    { id: 'empty-string', classifierMode: '' },
    { id: 'whitespace', classifierMode: '   ' },
    { id: 'numeric', classifierMode: 12345 },
    { id: 'near-miss', classifierMode: 'ollamaa' },
    { id: 'object', classifierMode: { x: 1 } },
    { id: 'absent', __absent: true }
  ];
  for (const g of garbageModes) {
    const payload = { ...base };
    if (!g.__absent) { payload.classifierMode = g.classifierMode; }
    const opts = toStubOpts();
    // COMPILED Normalize node.
    let compiledNorm;
    try {
      compiledNorm = runNode(NORMALIZE, [{ json: payload }], {})[0].json;
    } catch (e) {
      check('classifierMode:' + g.id, 'compiled Normalize executes', false, e.message);
      continue;
    }
    const coreNorm = normalizeFeedback(payload, opts);
    check('classifierMode:' + g.id, 'compiled runtime.classifierMode == "stub"', compiledNorm.runtime.classifierMode === 'stub', compiledNorm.runtime.classifierMode);
    check('classifierMode:' + g.id, 'DIFF compiled Normalize == core', eq(compiledNorm, coreNorm));
    // and the full stub pipeline runs (Classify stub -> ... -> Build*) with classifierSource never 'ollama'.
    const compiled = runCompiled(payload, {});
    check('classifierMode:' + g.id, 'stub pipeline runs (statusCode 200)', compiled.final.statusCode === 200, String(compiled.final.statusCode));
    check('classifierMode:' + g.id, 'classifierSource is stub|fallback (never ollama)',
      compiled.final.response.classifierSource === 'stub' || compiled.final.response.classifierSource === 'fallback',
      compiled.final.response.classifierSource);
  }
  // Positive control: the EXACT literal 'ollama' (and case/space variants) DOES select live mode — proving the
  // default is a real gate, not an accept-all. (We only check the runtime flag; the live branch is not run.)
  for (const live of ['ollama', 'OLLAMA', '  Ollama  ']) {
    const payload = { ...base, classifierMode: live };
    const compiledNorm = runNode(NORMALIZE, [{ json: payload }], {})[0].json;
    check('classifierMode:live(' + JSON.stringify(live) + ')', 'compiled runtime.classifierMode == "ollama"', compiledNorm.runtime.classifierMode === 'ollama', compiledNorm.runtime.classifierMode);
    check('classifierMode:live(' + JSON.stringify(live) + ')', 'DIFF compiled Normalize == core', eq(compiledNorm, normalizeFeedback(payload, toStubOpts())));
  }
}

// ---------------------------------------------------------------------------------------------------------
// EMPTY-FEEDBACK 422 branch — a present-but-empty feedback key returns the 422 error record; compiled == core.
// (No pin-data fixture exercises this; it is a documented branch, so we drive it explicitly.)
// ---------------------------------------------------------------------------------------------------------
for (const empty of [
  { id: 'empty-text', payload: { feedbackText: '', reportedCount: 1, source: 'test', submittedAt: PINNED_AT } },
  { id: 'whitespace-text', payload: { feedbackText: '   ', reportedCount: 1, source: 'test', submittedAt: PINNED_AT } }
]) {
  const opts = toStubOpts();
  let compiled;
  try {
    compiled = runCompiled(empty.payload, {});
  } catch (e) {
    check(empty.id, 'compiled empty-feedback executes', false, e.message);
    continue;
  }
  check(empty.id, 'branch == empty-error', compiled.branch === 'empty-error', compiled.branch);
  const coreNorm = normalizeFeedback(empty.payload, opts);
  const coreErr = buildEmptyError(coreNorm);
  check(empty.id, 'DIFF empty-feedback record == core', eq(compiled.final, coreErr), 'records diverge');
  check(empty.id, 'statusCode == 422', compiled.final.statusCode === 422, String(compiled.final.statusCode));
  check(empty.id, 'response.ok == false', compiled.final.response.ok === false);
  check(empty.id, 'error == "Empty feedback text"', compiled.final.response.error === 'Empty feedback text', compiled.final.response.error);
}

// ---------------------------------------------------------------------------------------------------------
// HEADLINE PINS — the churn-risk HITL path + the PII-redaction proof, explicit (not derived from the loop).
// ---------------------------------------------------------------------------------------------------------
{
  // churn-risk: theme churn_risk + negative -> critical urgency -> Needs Human Review TRUE -> approval-gated.
  const churn = JSON.parse(readFileSync(join(pinDataDir, 'feedback-churn-risk.json'), 'utf8'));
  const c = runCompiled(churn, {});
  check('pin:churn-risk', 'routed to approval branch', c.branch === 'approval', c.branch);
  check('pin:churn-risk', 'response.status == awaiting_approval', c.final.response.status === 'awaiting_approval', c.final.response.status);
  check('pin:churn-risk', 'needsHumanReview == true', c.final.response.needsHumanReview === true);
  check('pin:churn-risk', 'urgency == critical', c.final.response.urgency === 'critical', c.final.response.urgency);
  check('pin:churn-risk', 'notification.status == pending_review', c.final.response.notification.status === 'pending_review', c.final.response.notification.status);
}
{
  // bug-negative carries a raw email -> Redact PII masks it; the safe excerpt + masked email never leak the raw.
  const bug = JSON.parse(readFileSync(join(pinDataDir, 'feedback-bug-negative.json'), 'utf8'));
  const c = runCompiled(bug, {});
  const rawEmail = (String(bug.feedbackText).match(/[^\s@]+@[^\s@]+\.[^\s@]+/) || [])[0];
  check('pin:pii-redaction', 'redactedEmail masked', c.snap[REDACT].pii.redactedEmail.includes('***'), c.snap[REDACT].pii.redactedEmail);
  check('pin:pii-redaction', 'safeExcerpt <= 60 chars', c.snap[REDACT].pii.safeExcerpt.length <= 60, String(c.snap[REDACT].pii.safeExcerpt.length));
  const wholeOut = JSON.stringify(c.final);
  check('pin:pii-redaction', 'raw email absent from whole output', !!rawEmail && !wholeOut.includes(rawEmail), rawEmail || 'no-email');
}

console.log('');
console.log('feedback-workflow behavioral self-test: ' + pass + ' passed, ' + fail + ' failed ('
  + fixtureFiles.length + ' pin-data fixtures + classifierMode-default (finding #5) + empty-422 + headline pins, '
  + 'OFFLINE, compiled jsCode + differential vs core)');
process.exit(fail > 0 ? 1 : 0);
