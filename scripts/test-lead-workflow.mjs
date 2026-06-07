// test-lead-workflow.mjs — offline behavioral proof of the COMPILED lead-intelligence workflow.
// (npm run verify:workflow; also run inside verify:static.)
//
// Why this exists: n8n Code nodes cannot import lead-core.mjs, so the deployed DETERMINISTIC lead logic is a
// COPY embedded as jsCode. The repo's behavioral coverage was verify:live (a live n8n MCP run, NOT in CI), so
// the compiled jsCode was never executed offline. This gate closes that gap — it is the portfolio's signature
// discipline (cf. interaction-gateway's test-gateway-workflow.mjs / llm-eval-harness's test-eval-workflow.mjs
// / rag-knowledge-assistant's test-rag-workflow.mjs). It:
//   1) loads the compiled CANONICAL JSON (the deploy artifact),
//   2) extracts each deterministic Code node's jsCode and runs the 11 golden fixtures through the real local
//      pipeline (Normalize -> [gates] -> Identity -> Redact PII -> Check Duplicate -> [Duplicate?] ->
//      {Duplicate Response | enrichment x2 -> evidence -> ICP/Intent/Priority -> grade -> route -> follow-up ->
//      [Hot?] -> {hot notif -> record skipped | -} -> CRM -> Audit -> Response}), threading each node's output
//      into the next exactly as n8n would (replicating the four ifElse gate decisions in JS), PLUS the
//      Required-Field 400 and Email-Syntax 422 error branches,
//   3) DIFFERENTIALLY checks each stage's output against lead-core.mjs on the same inputs (byte-identical),
//   4) asserts the documented behavioral expectations (the A/B/C/D scoring tiers, the route decision, the
//      zero-PII-leak invariant on the response AND the duplicate-response branch).
// So the deployed deterministic lead logic can't silently drift from the audited core. No n8n, no network.
//
// SCOPE: the ENTIRE non-error decision path is deterministic local rules — this workflow has NO live CRM/MCP/
// HTTP branch — so every Code node above is exercised here. The two Date-derived timestamps (Build Follow-up
// Policy's dueAt, Create Redacted Audit Event's createdAt) call Date.now()/new Date() with no override hook on
// the compiled side, so they legitimately differ run-to-run; they are asserted ISO separately then normalized
// identically on both sides for the whole-record differential. receivedAt is supplied by every fixture, so the
// receivedAt-derived idempotencyKey/auditEventId ARE pinned and compared byte-identical (the load-bearing hash).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import {
  normalizeLead, generateLeadIdentity, redactLeadPii, checkDuplicateCandidate, buildDuplicateResponse,
  mockCompanyEnrichment, mockIntentEnrichment, aggregateEvidence, calculateIcpFitScore, calculateIntentScore,
  calculatePriorityScore, assignLeadGrade, routeSalesOwner, buildFollowUpPolicy, buildHotLeadNotification,
  recordNotificationSkipped, buildCrmPayload, createAuditEvent, buildLeadResponse, buildRequiredError,
  buildEmailError, requiredFieldsPresent, emailSyntaxValid, isDuplicate, isHotLead, POLICY_VERSION
} from './lib/lead-core.mjs';

// The deployed Code nodes assume n8n's sandbox globals (items, Buffer, $env, require). The deterministic nodes
// use only `items`, but we inject a real require + Buffer for parity with how n8n builds the function.
const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const canonicalPath = join(repoRoot, 'workflows', 'canonical', 'lead-intelligence.canonical.json');
const pinDataDir = join(repoRoot, 'fixtures', 'pin-data');

const wf = JSON.parse(readFileSync(canonicalPath, 'utf8'));
const nodeByName = {};
for (const n of wf.nodes) { nodeByName[n.name] = n; }

// The deterministic Code-node names (the offline lane).
const NORMALIZE = 'Normalize Lead Payload';
const IDENTITY = 'Generate Lead Identity';
const REDACT = 'Redact Lead PII';
const DEDUPE = 'Check Duplicate Candidate';
const DUP_RESPONSE = 'Build Duplicate Lead Response';
const COMPANY = 'Mock Company Enrichment';
const INTENT = 'Mock Intent Enrichment';
const EVIDENCE = 'Aggregate Scoring Evidence';
const ICP = 'Calculate ICP Fit Score';
const INTENT_SCORE = 'Calculate Intent Score';
const PRIORITY = 'Calculate Priority Score';
const GRADE = 'Assign Lead Grade';
const ROUTE = 'Route Sales Owner';
const FOLLOWUP = 'Build Follow-up Policy';
const HOT_NOTIF = 'Build Hot Lead Notification';
const SKIPPED = 'Record Notification Skipped';
const CRM = 'Build CRM-ready Payload';
const AUDIT = 'Create Redacted Audit Event';
const BUILD = 'Build Lead Intelligence Response';
const REQUIRED_ERROR = 'Build Required Field Error';
const EMAIL_ERROR = 'Build Email Syntax Error';

// Mirror n8n's Code-node sandbox: items[], Buffer, $env, require. The body ends in `return`. The lead nodes
// are all synchronous (no awaits), so a plain Function is sufficient.
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

// A pinned instant so the two Date.now()/new Date() fields (Follow-up dueAt, Audit createdAt) are deterministic
// on the CORE side (via opts.now). The compiled nodes have no override hook, so their dueAt/createdAt are
// whatever wall-clock the run sees — normalized away for the structural diff, asserted ISO separately. All 11
// fixtures supply receivedAt verbatim, so receivedAt (and the receivedAt-derived ids) are byte-stable already.
const PINNED_AT = '2026-06-01T00:00:00.000Z';
function pinnedOpts() { return { now: PINNED_AT }; }

// Run the COMPILED deterministic pipeline, capturing a deep-clone snapshot at each stage and replicating the
// four ifElse gate decisions in JS (exactly how n8n routes the item to the next Code node). Returns
// { snap, final, branch } or throws on a bad item shape. The gate decisions are read from the snapshot the
// preceding Code node produced — the same JSON the ifElse evaluates its expression against.
function runCompiled(req, env) {
  let items = [{ json: req }];
  const snap = {};
  const step = (stage) => {
    items = runNode(stage, items, env);
    if (!Array.isArray(items) || !items[0] || !items[0].json) { throw new Error(stage + ' returned a bad item shape'); }
    snap[stage] = structuredClone(items[0].json);
  };

  step(NORMALIZE);
  // Gate: Required Fields Present?
  if (snap[NORMALIZE].validation.requiredFieldsPresent !== true) {
    items = [{ json: snap[NORMALIZE] }];
    step(REQUIRED_ERROR);
    return { snap, final: snap[REQUIRED_ERROR], branch: 'required-error' };
  }
  // Gate: Email Syntax Valid?  (replicates the ifElse runtime regex /^[^\s@]+@[^\s@]+\.[^\s@]+$/)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(snap[NORMALIZE].lead.email)) {
    items = [{ json: snap[NORMALIZE] }];
    step(EMAIL_ERROR);
    return { snap, final: snap[EMAIL_ERROR], branch: 'email-error' };
  }
  step(IDENTITY);
  step(REDACT);
  step(DEDUPE);
  // Gate: Duplicate Lead?
  if (snap[DEDUPE].dedupe.duplicate === true) {
    step(DUP_RESPONSE);
    return { snap, final: snap[DUP_RESPONSE], branch: 'duplicate' };
  }
  step(COMPANY);
  step(INTENT);
  step(EVIDENCE);
  step(ICP);
  step(INTENT_SCORE);
  step(PRIORITY);
  step(GRADE);
  step(ROUTE);
  step(FOLLOWUP);
  // Gate: Hot Lead?
  if (snap[FOLLOWUP].followUp.hotLead === true) {
    step(HOT_NOTIF);
    step(SKIPPED);
  }
  step(CRM);
  step(AUDIT);
  step(BUILD);
  return { snap, final: snap[BUILD], branch: 'lead' };
}

// Normalize the two non-injectable timestamps (followUp.dueAt + auditEvent.createdAt) before a whole-record
// differential: the compiled Follow-up/Audit nodes call Date.now()/new Date() with no override hook, so those
// two fields legitimately differ run-to-run. We assert them as ISO/parseable separately, then blank them for
// the structural compare. receivedAt IS supplied by every fixture so it is NOT blanked.
function blankVolatileTimestamps(record) {
  const r = structuredClone(record);
  if (r.response && r.response.followUp) { r.response.followUp.dueAt = '<ts>'; }
  if (r.auditEvent) { r.auditEvent.createdAt = '<ts>'; }
  return r;
}

// Documented behavioral expectations per fixture (mirrors scripts/Test-LeadIntelligenceWorkflow.ps1 cases).
// Each fixture's file is the differential input; the expectation pins the headline outcome.
const fixtureCases = [
  { id: 'hot-enterprise-lead', file: 'lead-hot-enterprise.json', node: BUILD, branch: 'lead',
    exp: { statusCode: 200, duplicate: false, grade: 'A', minPriority: 80, maxPriority: 100, ownerQueue: 'enterprise-ae', ownerTeam: 'enterprise-sales', slaHours: 2, hotLead: true, notificationStatus: 'skipped', manuallyOverridden: false } },
  { id: 'midmarket-qualified', file: 'lead-midmarket-qualified.json', node: BUILD, branch: 'lead',
    exp: { statusCode: 200, duplicate: false, grade: 'B', minPriority: 62, maxPriority: 79, ownerQueue: 'midmarket-ae', ownerTeam: 'commercial-sales', slaHours: 8, hotLead: false, notificationStatus: 'not_required', manuallyOverridden: false } },
  { id: 'high-intent-low-fit', file: 'lead-high-intent-low-fit.json', node: BUILD, branch: 'lead',
    exp: { statusCode: 200, duplicate: false, grade: 'C', minPriority: 40, maxPriority: 61, ownerQueue: 'sdr-qualification', ownerTeam: 'sales-development', slaHours: 48, hotLead: false, notificationStatus: 'not_required', manuallyOverridden: false } },
  { id: 'student-low-fit', file: 'lead-student-low-fit.json', node: BUILD, branch: 'lead',
    exp: { statusCode: 200, duplicate: false, grade: 'D', minPriority: 0, maxPriority: 39, ownerQueue: 'nurture', ownerTeam: 'growth-marketing', slaHours: 168, hotLead: false, notificationStatus: 'not_required', manuallyOverridden: false } },
  { id: 'newsletter-low-intent', file: 'lead-low-intent-newsletter.json', node: BUILD, branch: 'lead',
    exp: { statusCode: 200, duplicate: false, grade: 'D', minPriority: 0, maxPriority: 39, ownerQueue: 'nurture', ownerTeam: 'growth-marketing', slaHours: 168, hotLead: false, notificationStatus: 'not_required', manuallyOverridden: false } },
  { id: 'competitor-domain', file: 'lead-competitor-domain.json', node: BUILD, branch: 'lead',
    exp: { statusCode: 200, duplicate: false, grade: 'D', minPriority: 0, maxPriority: 25, ownerQueue: 'disqualified-competitor', ownerTeam: 'revops', slaHours: 168, hotLead: false, notificationStatus: 'not_required', manuallyOverridden: false, evidenceContains: 'competitor_domain' } },
  { id: 'manual-override', file: 'lead-manual-override.json', node: BUILD, branch: 'lead',
    exp: { statusCode: 200, duplicate: false, grade: 'A', minPriority: 85, maxPriority: 100, ownerQueue: 'enterprise-ae', ownerTeam: 'enterprise-sales', slaHours: 2, hotLead: true, notificationStatus: 'skipped', manuallyOverridden: true, redactedEmail: 'f***@gmail.com' } },
  { id: 'duplicate-existing-id', file: 'lead-duplicate-existing-id.json', node: DUP_RESPONSE, branch: 'duplicate',
    exp: { statusCode: 200, duplicate: true, action: 'attach_to_existing_record', reason: 'existingLeadId supplied', matchedLeadId: 'lead_existing_20260529' } },
  { id: 'duplicate-domain', file: 'lead-duplicate-domain.json', node: DUP_RESPONSE, branch: 'duplicate',
    exp: { statusCode: 200, duplicate: true, action: 'attach_to_existing_record', reason: 'domain recently processed', matchedLeadPrefix: 'lead_existing_' } },
  { id: 'bad-email', file: 'lead-bad-email.json', node: EMAIL_ERROR, branch: 'email-error',
    exp: { statusCode: 422, ok: false, error: 'Invalid email syntax', email: 'not-an-email' } },
  { id: 'missing-company', file: 'lead-missing-company.json', node: REQUIRED_ERROR, branch: 'required-error',
    exp: { statusCode: 400, ok: false, error: 'Missing required lead fields', missingField: 'companyName' } }
];

// The raw fixture is the webhook/manual body shape; the Code nodes read items[0].json directly (the canonical
// Normalize node folds source.body ?? source). We feed the fixture verbatim as the webhook body would arrive.
function loadFixture(file) { return JSON.parse(readFileSync(join(pinDataDir, file), 'utf8')); }

// Run the audited core over the same request + same pinned instant, walking the identical branch decisions.
function runCore(req) {
  const opts = pinnedOpts();
  const norm = normalizeLead(req, opts);
  const snap = { [NORMALIZE]: norm };
  if (!requiredFieldsPresent(norm)) { return { snap, final: buildRequiredError(norm), branch: 'required-error' }; }
  if (!emailSyntaxValid(norm)) { return { snap, final: buildEmailError(norm), branch: 'email-error' }; }
  const identity = generateLeadIdentity(norm); snap[IDENTITY] = identity;
  const pii = redactLeadPii(identity); snap[REDACT] = pii;
  const dedupe = checkDuplicateCandidate(pii); snap[DEDUPE] = dedupe;
  if (isDuplicate(dedupe)) { return { snap, final: buildDuplicateResponse(dedupe), branch: 'duplicate' }; }
  const company = mockCompanyEnrichment(dedupe); snap[COMPANY] = company;
  const intent = mockIntentEnrichment(company); snap[INTENT] = intent;
  const evidence = aggregateEvidence(intent); snap[EVIDENCE] = evidence;
  const icp = calculateIcpFitScore(evidence); snap[ICP] = icp;
  const intentScore = calculateIntentScore(icp); snap[INTENT_SCORE] = intentScore;
  const priority = calculatePriorityScore(intentScore); snap[PRIORITY] = priority;
  const grade = assignLeadGrade(priority); snap[GRADE] = grade;
  const route = routeSalesOwner(grade); snap[ROUTE] = route;
  const followUp = buildFollowUpPolicy(route, opts); snap[FOLLOWUP] = followUp;
  let beforeCrm = followUp;
  if (isHotLead(followUp)) {
    const notif = buildHotLeadNotification(followUp); snap[HOT_NOTIF] = notif;
    beforeCrm = recordNotificationSkipped(notif); snap[SKIPPED] = beforeCrm;
  }
  const crm = buildCrmPayload(beforeCrm); snap[CRM] = crm;
  const audit = createAuditEvent(crm, opts); snap[AUDIT] = audit;
  const final = buildLeadResponse(audit); snap[BUILD] = final;
  return { snap, final, branch: 'lead' };
}

// The raw PII probes (from the original fixture) that must NEVER appear in the response or the audit event.
function rawProbes(fixture) {
  const f = fixture.body ?? fixture;
  const email = String(f.email ?? f.workEmail ?? f.customerEmail ?? '').trim();
  const fullName = String(f.fullName ?? f.name ?? '').trim();
  const message = String(f.message ?? f.notes ?? f.description ?? f.request ?? '').trim();
  return { email, fullName, message };
}

// ---------------------------------------------------------------------------------------------------------
// MAIN LOOP — every golden fixture, run reproducibly offline: compiled pipeline == core (per stage + whole
// record), the correct branch is selected, and the documented behavioral outcome + zero-PII-leak invariant hold.
// ---------------------------------------------------------------------------------------------------------
for (const fc of fixtureCases) {
  const fixture = loadFixture(fc.file);

  // (a) the DEPLOYED jsCode pipeline (extracted from the compiled canonical), walking the gate decisions.
  let compiled;
  try {
    compiled = runCompiled(fixture, {});
  } catch (e) {
    check(fc.id, 'compiled pipeline executes', false, e.message);
    continue;
  }
  check(fc.id, 'compiled pipeline executes', true);
  check(fc.id, 'compiled selects branch ' + fc.branch, compiled.branch === fc.branch, compiled.branch);
  check(fc.id, 'terminal node == ' + fc.node, compiled.snap[fc.node] !== undefined, Object.keys(compiled.snap).join(','));

  // (b) the audited core, same request + same pinned instant (runCore makes the same gate decisions).
  const core = runCore(fixture);
  check(fc.id, 'core selects same branch', core.branch === compiled.branch, core.branch + ' vs ' + compiled.branch);

  // (c) DIFFERENTIAL — each compiled stage output EQUALS the core's on the same input.
  // Normalize is byte-identical (receivedAt is fixture-supplied, so no Date default fires).
  check(fc.id, 'DIFF normalize == core', eq(compiled.snap[NORMALIZE], core.snap[NORMALIZE]));
  if (compiled.branch === 'lead') {
    check(fc.id, 'DIFF identity == core', eq(compiled.snap[IDENTITY].identity, core.snap[IDENTITY].identity));
    check(fc.id, 'DIFF redacted pii == core', eq(compiled.snap[REDACT].pii, core.snap[REDACT].pii));
    check(fc.id, 'DIFF dedupe == core', eq(compiled.snap[DEDUPE].dedupe, core.snap[DEDUPE].dedupe));
    check(fc.id, 'DIFF company enrichment == core', eq(compiled.snap[COMPANY].enrichment, core.snap[COMPANY].enrichment));
    check(fc.id, 'DIFF intent enrichment == core', eq(compiled.snap[INTENT].enrichment, core.snap[INTENT].enrichment));
    check(fc.id, 'DIFF evidence == core', eq(compiled.snap[EVIDENCE].evidence, core.snap[EVIDENCE].evidence));
    check(fc.id, 'DIFF icpFitScore == core', eq(compiled.snap[ICP].scoring, core.snap[ICP].scoring));
    check(fc.id, 'DIFF intentScore == core', eq(compiled.snap[INTENT_SCORE].scoring, core.snap[INTENT_SCORE].scoring));
    check(fc.id, 'DIFF priorityScore == core', eq(compiled.snap[PRIORITY].scoring, core.snap[PRIORITY].scoring));
    check(fc.id, 'DIFF grade == core', eq(compiled.snap[GRADE].scoring, core.snap[GRADE].scoring));
    check(fc.id, 'DIFF route == core', eq(compiled.snap[ROUTE].route, core.snap[ROUTE].route));
    // Follow-up: dueAt is Date.now()-derived on the compiled side; compare everything else, dueAt as parseable.
    const blankDue = (fu) => { const c = structuredClone(fu); c.dueAt = '<ts>'; return c; };
    check(fc.id, 'DIFF follow-up == core (dueAt-normalized)', eq(blankDue(compiled.snap[FOLLOWUP].followUp), blankDue(core.snap[FOLLOWUP].followUp)));
    check(fc.id, 'follow-up dueAt is parseable date', isIso(compiled.snap[FOLLOWUP].followUp.dueAt), compiled.snap[FOLLOWUP].followUp.dueAt);
    check(fc.id, 'DIFF crm payload == core (dueAt-normalized)',
      eq({ ...compiled.snap[CRM].crmPayload, followUpDueAt: '<ts>' }, { ...core.snap[CRM].crmPayload, followUpDueAt: '<ts>' }));
    // Audit: createdAt is new Date() on the compiled side; blank it both sides. auditEventId IS pinned
    // (receivedAt-derived idempotencyKey hash) and proven byte-identical — the load-bearing hash differential.
    const blankCreatedAt = (ae) => { const c = structuredClone(ae); c.createdAt = '<ts>'; return c; };
    check(fc.id, 'DIFF audit event == core (createdAt-normalized)',
      eq(blankCreatedAt(compiled.snap[AUDIT].auditEvent), blankCreatedAt(core.snap[AUDIT].auditEvent)));
    check(fc.id, 'DIFF auditEventId == core (receivedAt-derived hash)',
      compiled.snap[AUDIT].auditEvent.auditEventId === core.snap[AUDIT].auditEvent.auditEventId,
      compiled.snap[AUDIT].auditEvent.auditEventId + ' vs ' + core.snap[AUDIT].auditEvent.auditEventId);
    check(fc.id, 'audit createdAt is parseable date', isIso(compiled.snap[AUDIT].auditEvent.createdAt), compiled.snap[AUDIT].auditEvent.createdAt);
  }
  // whole-record differential (the two Date-derived timestamps normalized identically on both sides).
  check(fc.id, 'DIFF terminal record == core (whole record, ts-normalized)',
    eq(blankVolatileTimestamps(compiled.final), blankVolatileTimestamps(core.final)), 'records diverge');

  // (d) BEHAVIORAL expectations against the DEPLOYED jsCode.
  const final = compiled.final;
  const resp = final.response;
  const exp = fc.exp;
  check(fc.id, 'statusCode == ' + exp.statusCode, final.statusCode === exp.statusCode, 'got ' + final.statusCode);
  check(fc.id, 'policyVersion == ' + POLICY_VERSION, resp.policyVersion === POLICY_VERSION, resp.policyVersion);

  if (fc.branch === 'lead') {
    check(fc.id, 'response.ok == true', resp.ok === true);
    check(fc.id, 'duplicate == false', resp.duplicate === false);
    check(fc.id, 'grade == ' + exp.grade, resp.grade === exp.grade, resp.grade);
    check(fc.id, 'priorityScore in [' + exp.minPriority + ',' + exp.maxPriority + ']',
      resp.priorityScore >= exp.minPriority && resp.priorityScore <= exp.maxPriority, String(resp.priorityScore));
    check(fc.id, 'icpFitScore in [0,100]', resp.icpFitScore >= 0 && resp.icpFitScore <= 100, String(resp.icpFitScore));
    check(fc.id, 'intentScore in [0,100]', resp.intentScore >= 0 && resp.intentScore <= 100, String(resp.intentScore));
    check(fc.id, 'route.ownerQueue == ' + exp.ownerQueue, resp.route.ownerQueue === exp.ownerQueue, resp.route.ownerQueue);
    check(fc.id, 'route.ownerTeam == ' + exp.ownerTeam, resp.route.ownerTeam === exp.ownerTeam, resp.route.ownerTeam);
    check(fc.id, 'followUp.slaHours == ' + exp.slaHours, resp.followUp.slaHours === exp.slaHours, String(resp.followUp.slaHours));
    check(fc.id, 'followUp.hotLead == ' + exp.hotLead, resp.followUp.hotLead === exp.hotLead, String(resp.followUp.hotLead));
    check(fc.id, 'notification.status == ' + exp.notificationStatus, resp.notification.status === exp.notificationStatus, resp.notification.status);
    check(fc.id, 'manuallyOverridden == ' + exp.manuallyOverridden, resp.manuallyOverridden === exp.manuallyOverridden, String(resp.manuallyOverridden));
    check(fc.id, 'leadId has lead_ prefix', typeof resp.leadId === 'string' && resp.leadId.startsWith('lead_'), resp.leadId);
    check(fc.id, 'auditEventId has audit_ prefix', typeof resp.auditEventId === 'string' && resp.auditEventId.startsWith('audit_'), resp.auditEventId);
    check(fc.id, 'crmPayload.externalId == leadId', resp.crmPayload.externalId === resp.leadId);
    check(fc.id, 'response crmPayload omits email/companyDomain (subset)',
      !('email' in resp.crmPayload) && !('companyDomain' in resp.crmPayload), Object.keys(resp.crmPayload).join(','));
    if (exp.evidenceContains) {
      check(fc.id, 'audit evidence contains ' + exp.evidenceContains, Array.isArray(final.auditEvent.evidence) && final.auditEvent.evidence.includes(exp.evidenceContains), (final.auditEvent.evidence || []).join(','));
    }
    if (exp.redactedEmail) {
      check(fc.id, 'redactedEmail == ' + exp.redactedEmail, resp.redactedEmail === exp.redactedEmail, resp.redactedEmail);
    }
  } else if (fc.branch === 'duplicate') {
    check(fc.id, 'response.ok == true', resp.ok === true);
    check(fc.id, 'duplicate == true', resp.duplicate === true);
    check(fc.id, 'action == ' + exp.action, resp.action === exp.action, resp.action);
    check(fc.id, 'reason == ' + exp.reason, resp.reason === exp.reason, resp.reason);
    if (exp.matchedLeadId) {
      check(fc.id, 'matchedLeadId == ' + exp.matchedLeadId, resp.matchedLeadId === exp.matchedLeadId, resp.matchedLeadId);
    }
    if (exp.matchedLeadPrefix) {
      check(fc.id, 'matchedLeadId has prefix ' + exp.matchedLeadPrefix, typeof resp.matchedLeadId === 'string' && resp.matchedLeadId.startsWith(exp.matchedLeadPrefix), resp.matchedLeadId);
    }
    // The duplicate response must NOT carry scoring/route/follow-up (it branches before enrichment).
    check(fc.id, 'duplicate response omits grade/route/followUp',
      !('grade' in resp) && !('route' in resp) && !('followUp' in resp), Object.keys(resp).join(','));
    // The duplicate branch builds NO audit event (terminal record carries only { statusCode, runtime, response }).
    check(fc.id, 'duplicate terminal record carries no auditEvent', !('auditEvent' in final), Object.keys(final).join(','));
  } else {
    // error branches (400 / 422)
    check(fc.id, 'response.ok == false', resp.ok === false);
    check(fc.id, 'error == ' + exp.error, resp.error === exp.error, resp.error);
    if (exp.email) { check(fc.id, 'response.email == ' + exp.email, resp.email === exp.email, resp.email); }
    if (exp.missingField) {
      check(fc.id, 'missingFields contains ' + exp.missingField, Array.isArray(resp.missingFields) && resp.missingFields.includes(exp.missingField), (resp.missingFields || []).join(','));
    }
    // error branches build NO audit event and expose NO scoring.
    check(fc.id, 'error terminal record carries no auditEvent', !('auditEvent' in final), Object.keys(final).join(','));
    check(fc.id, 'error response omits grade/route', !('grade' in resp) && !('route' in resp), Object.keys(resp).join(','));
  }

  // (e) ZERO-PII-LEAK invariant — for EVERY branch (incl. the duplicate-response branch per finding #34): no
  // raw email anywhere in the terminal record, and the specific raw email/name/message from this fixture must
  // not appear. The redacted audit event (when present) must never carry the raw email/fullName/message keys.
  const serialized = JSON.stringify(final);
  check(fc.id, 'no raw email pattern in terminal record (masking)',
    !/[^\s@"]+@[^\s@"]+\.[^\s@"]+/.test(serialized.replace(/[a-z]\*{3}@/g, '')),
    /[^\s@"]+@[^\s@"]+\.[^\s@"]+/.test(serialized.replace(/[a-z]\*{3}@/g, '')) ? 'LEAK' : 'clean');
  const probes = rawProbes(fixture);
  // The email-error (422) branch DELIBERATELY echoes the rejected email in response.email so the caller knows
  // what was rejected (the documented contract; cf. Test-LeadIntelligenceWorkflow.ps1's Email assertion). That
  // reflected value is an already-invalid, non-deliverable string that never reached scoring or the audit event,
  // so it is exempt from the raw-email probe; the masking invariant is still enforced on the lead/duplicate
  // branches and on the audit event below.
  if (probes.email && fc.branch !== 'email-error') {
    check(fc.id, 'raw fixture email not in terminal record', !serialized.includes(probes.email), probes.email);
  }
  if (probes.fullName && probes.fullName.length > 2) {
    check(fc.id, 'raw fixture full name not in terminal record', !serialized.includes(probes.fullName), probes.fullName);
  }
  if (probes.message && probes.message.length > 20) {
    check(fc.id, 'raw fixture message not in terminal record', !serialized.includes(probes.message.slice(0, 60)));
  }
  if ('auditEvent' in final) {
    const auditStr = JSON.stringify(final.auditEvent);
    check(fc.id, 'audit omits raw email/fullName/message keys',
      !/"email"/.test(auditStr) && !/"fullName"/.test(auditStr) && !/"message"/.test(auditStr));
    check(fc.id, 'audit redactedEmail carries a mask', typeof final.auditEvent.redactedEmail === 'string' && final.auditEvent.redactedEmail.includes('***'), final.auditEvent.redactedEmail);
  }
}

// ---------------------------------------------------------------------------------------------------------
// HEADLINE PINS — explicit, not derived from the loop: the four scoring tiers, the competitor cap, and the
// manual-override floor, each proven against the DEPLOYED jsCode.
// ---------------------------------------------------------------------------------------------------------
function runFileCompiled(file) { return runCompiled(loadFixture(file), {}); }

// Grade tiers map to the documented owner queues.
{
  const a = runFileCompiled('lead-hot-enterprise.json').final.response;
  check('pin:tiers', 'A -> enterprise-ae', a.grade === 'A' && a.route.ownerQueue === 'enterprise-ae', a.grade + '/' + a.route.ownerQueue);
  const b = runFileCompiled('lead-midmarket-qualified.json').final.response;
  check('pin:tiers', 'B -> midmarket-ae', b.grade === 'B' && b.route.ownerQueue === 'midmarket-ae', b.grade + '/' + b.route.ownerQueue);
  const c = runFileCompiled('lead-high-intent-low-fit.json').final.response;
  check('pin:tiers', 'C -> sdr-qualification', c.grade === 'C' && c.route.ownerQueue === 'sdr-qualification', c.grade + '/' + c.route.ownerQueue);
  const d = runFileCompiled('lead-student-low-fit.json').final.response;
  check('pin:tiers', 'D -> nurture', d.grade === 'D' && d.route.ownerQueue === 'nurture', d.grade + '/' + d.route.ownerQueue);
}
// Competitor cap: priorityScore <= 25 AND routed to disqualified-competitor regardless of firmographic fit.
{
  const r = runFileCompiled('lead-competitor-domain.json').final.response;
  check('pin:competitor-cap', 'priorityScore <= 25', r.priorityScore <= 25, String(r.priorityScore));
  check('pin:competitor-cap', 'route == disqualified-competitor', r.route.ownerQueue === 'disqualified-competitor', r.route.ownerQueue);
}
// Manual-override floor: a manualGrade lifts a would-be-D lead to A with priorityScore >= 85.
{
  const r = runFileCompiled('lead-manual-override.json').final.response;
  check('pin:manual-override', 'grade forced to A', r.grade === 'A', r.grade);
  check('pin:manual-override', 'priorityScore floored >= 85', r.priorityScore >= 85, String(r.priorityScore));
  check('pin:manual-override', 'manuallyOverridden == true', r.manuallyOverridden === true, String(r.manuallyOverridden));
}
// Duplicate-response zero-PII-leak (finding #34): the duplicate branch returns ids only, no audit, no raw email.
{
  const dup = runFileCompiled('lead-duplicate-existing-id.json').final;
  check('pin:dup-leak', 'no auditEvent in duplicate record', !('auditEvent' in dup), Object.keys(dup).join(','));
  check('pin:dup-leak', 'no raw email in duplicate record', !JSON.stringify(dup).includes('ops@known-account.example'));
  check('pin:dup-leak', 'duplicate response omits scoring', !('grade' in dup.response) && !('priorityScore' in dup.response), Object.keys(dup.response).join(','));
}

console.log('');
console.log('lead-workflow behavioral self-test: ' + pass + ' passed, ' + fail + ' failed ('
  + fixtureCases.length + ' golden fixtures + headline pins, OFFLINE, compiled jsCode + differential vs core)');
process.exit(fail > 0 ? 1 : 0);
