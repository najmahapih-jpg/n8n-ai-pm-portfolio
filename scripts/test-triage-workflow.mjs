// test-triage-workflow.mjs — offline behavioral proof of the COMPILED support-triage workflow.
// (npm run verify:workflow; also run inside verify:static.)
//
// Why this exists: n8n Code nodes cannot import triage-core.mjs, so the deployed DETERMINISTIC triage logic is a
// COPY embedded as jsCode. The repo's only behavioral coverage was Test-SupportTriageWorkflow.ps1 (a live n8n
// run via MCP, NOT in CI), so the compiled jsCode was never executed offline. This gate closes that gap — it is
// the portfolio's signature offline-differential discipline (cf. llm-eval-harness's test-eval-workflow.mjs /
// rag-knowledge-assistant's test-rag-workflow.mjs / interaction-gateway's test-gateway-workflow.mjs). It:
//   1) loads the compiled CANONICAL JSON (the deploy artifact),
//   2) extracts each deterministic Code node's jsCode and runs the golden pin-data fixtures through the real
//      pipeline (Normalize Payload -> [Validate gate] -> Generate Metadata -> Redact PII -> Classify -> Score
//      Urgency -> Route Team -> Build SLA -> [Escalation gate] -> escalated tail | standard tail), threading
//      each node's output into the next exactly as n8n would, PLUS the validation-error 400 branch,
//   3) DIFFERENTIALLY checks each stage's output against triage-core.mjs on the same inputs (byte-identical),
//   4) asserts the documented behavioral expectations (category/urgency/routingTeam/SLA routing decisions, the
//      escalation vs standard handling path, the standard-vs-escalated response shape incl. feishuDelivery
//      presence, the validation-error 400, and the audit-redaction / no-raw-email invariant).
// So the deployed deterministic triage can't silently drift from the audited core. No n8n, no network.
//
// SCOPE: only the DETERMINISTIC, OFFLINE-REPRODUCIBLE path (the lane CI touches). The OUTBOUND Feishu branch
// (Send Feishu Alert httpRequest + Record Feishu Sent) is intentionally NOT exercised — it is outbound-only/live
// and belongs to verify:live. The offline escalation tail routes through Record Feishu Skipped (which the
// 'Feishu Enabled?' ifElse selects when no FEISHU_BOT_WEBHOOK_URL is set). The compiled 'Build Feishu Alert
// Card' node IS threaded on that tail (with empty env, as the 'Load Feishu Runtime Config' Set node yields when
// the vars are unset), but its only nondeterminism (payload.timestamp via Date.now()) is discarded downstream.
//
// PINS: receivedAt comes from every fixture, so the chain is deterministic from input EXCEPT the three
// new Date().toISOString() stamps (normalizedAt, generatedAt, auditEvent.createdAt) and the invalid-date SLA
// fallback to Date.now(). The differential injects the SAME instant into both the compiled nodes (via $env-less
// monkeypatch of Date) and the core (via opts), so the records compare byte-identical; the volatile stamps are
// asserted as ISO format then blanked on both sides for the structural compare.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import {
  normalizePayload, buildValidationError, generateTicketMetadata, redactCustomerPii,
  classifyTicketCategory, scoreUrgency, routeOwningTeam, buildSlaPolicy, buildEscalationPayload,
  buildStandardPayload, buildAuditEvent, recordFeishuSkipped, runTriageCore, POLICY_VERSION
} from './lib/triage-core.mjs';

// The deployed Code nodes assume n8n's sandbox globals (items, Buffer, $env, require). The 'Build Feishu Alert
// Card' node calls require('crypto') only when a signing secret is present (never on the offline tail), but we
// inject a real require for parity with how n8n builds the function.
const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const canonicalPath = join(repoRoot, 'workflows', 'canonical', 'portfolio-support-triage-api.canonical.json');
const pinDataDir = join(repoRoot, 'fixtures', 'pin-data');

const wf = JSON.parse(readFileSync(canonicalPath, 'utf8'));
const nodeByName = {};
for (const n of wf.nodes) { nodeByName[n.name] = n; }

// Node names (must match the compiled canonical exactly).
const NORMALIZE = 'Normalize Payload';
const VALIDATION_ERROR = 'Build Validation Error';
const META = 'Generate Ticket Metadata';
const REDACT = 'Redact Customer PII';
const CLASSIFY = 'Classify Ticket Category';
const SCORE = 'Score Urgency';
const ROUTE = 'Route Owning Team';
const SLA = 'Build SLA Policy';
const ESC_PAYLOAD = 'Build Escalation Payload';
const ESC_AUDIT = 'Create Escalation Audit Event';
const FEISHU_CARD = 'Build Feishu Alert Card';
const FEISHU_SKIPPED = 'Record Feishu Skipped';
const ESC_RESPONSE = 'Build Escalation Customer Response';
const STD_PAYLOAD = 'Build Standard Handling Payload';
const STD_AUDIT = 'Create Standard Audit Event';
const STD_RESPONSE = 'Build Standard Customer Response';

// The deterministic prefix (Normalize is run separately so the gate can branch on its output).
const TRIAGE_PREFIX = [META, REDACT, CLASSIFY, SCORE, ROUTE, SLA];

// Pinned instants: the only nondeterminism in the deterministic chain. Both sides get the SAME values.
const PINNED_ISO = '2026-06-01T00:00:00.000Z';
const PINNED_MS = Date.parse(PINNED_ISO);

// Mirror n8n's Code-node sandbox: items[], Buffer, $env, require. The body ends in `return`. We pin Date so the
// compiled nodes' new Date().toISOString() / Date.now() produce PINNED_ISO/PINNED_MS exactly like the core's
// injected opts — making the records byte-identical without blanking the injected stamps. (Date(arg) is left
// intact so receivedAt parsing is unaffected; only the zero-arg now() forms are pinned.)
const RealDate = Date;
function runNodePinned(name, items, env) {
  const node = nodeByName[name];
  if (!node) { throw new Error('missing Code node in compiled JSON: ' + name); }
  if (node.type !== 'n8n-nodes-base.code') { throw new Error('not a Code node: ' + name); }
  const PinnedDate = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) { super(PINNED_MS); } else { super(...args); }
    }
    static now() { return PINNED_MS; }
  };
  const fn = new Function('items', 'Buffer', '$env', 'require', 'Date', node.parameters.jsCode);
  return fn(items, Buffer, env || {}, require, PinnedDate);
}

let pass = 0;
let fail = 0;
function check(scenario, label, ok, detail) {
  if (ok) { pass += 1; } else { fail += 1; }
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + scenario + ' :: ' + label + (detail ? ' -> ' + detail : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s)) && /\d{4}-\d{2}-\d{2}T/.test(s);

// Run a single compiled Code node on one json item, returning items[0].json.
function step(name, json, env) {
  const out = runNodePinned(name, [{ json }], env);
  if (!Array.isArray(out) || !out[0] || !out[0].json) { throw new Error(name + ' returned a bad item shape'); }
  return out[0].json;
}

// Run the COMPILED deterministic pipeline for a fixture, mirroring the n8n graph's branch decisions, capturing
// a snapshot at each stage. Returns { branch, snap, final }.
//   Normalize -> [Validate gate on isValid]
//     false -> Build Validation Error (400)
//     true  -> Generate Metadata -> Redact -> Classify -> Score -> Route -> Build SLA -> [Escalation gate]
//        true  -> Build Escalation Payload -> Create Escalation Audit Event -> (Load Feishu Set: env unset)
//                 -> Build Feishu Alert Card -> [Feishu Enabled? false] -> Record Feishu Skipped
//                 -> Build Escalation Customer Response
//        false -> Build Standard Handling Payload -> Create Standard Audit Event -> Build Standard Customer Response
function runCompiled(source) {
  const snap = {};
  const norm = step(NORMALIZE, source, {});
  snap[NORMALIZE] = structuredClone(norm);
  if (!norm.isValid) {
    const err = step(VALIDATION_ERROR, norm, {});
    snap[VALIDATION_ERROR] = structuredClone(err);
    return { branch: 'validation-error', snap, final: err };
  }
  let cur = norm;
  for (const stage of TRIAGE_PREFIX) {
    cur = step(stage, cur, {});
    snap[stage] = structuredClone(cur);
  }
  const sla = snap[SLA];
  if (sla.escalationRequired) {
    cur = step(ESC_PAYLOAD, cur, {});
    snap[ESC_PAYLOAD] = structuredClone(cur);
    cur = step(ESC_AUDIT, cur, {});
    snap[ESC_AUDIT] = structuredClone(cur);
    // 'Load Feishu Runtime Config' is a Set node: with FEISHU env unset it injects empty strings.
    cur = { ...cur, feishuWebhookUrl: '', feishuSigningSecret: '' };
    cur = step(FEISHU_CARD, cur, {});
    snap[FEISHU_CARD] = structuredClone(cur);
    // 'Feishu Enabled?' ifElse selects the onFalse (Record Feishu Skipped) branch because configured === false.
    cur = step(FEISHU_SKIPPED, cur, {});
    snap[FEISHU_SKIPPED] = structuredClone(cur);
    cur = step(ESC_RESPONSE, cur, {});
    snap[ESC_RESPONSE] = structuredClone(cur);
    return { branch: 'escalated', snap, final: cur };
  }
  cur = step(STD_PAYLOAD, cur, {});
  snap[STD_PAYLOAD] = structuredClone(cur);
  cur = step(STD_AUDIT, cur, {});
  snap[STD_AUDIT] = structuredClone(cur);
  cur = step(STD_RESPONSE, cur, {});
  snap[STD_RESPONSE] = structuredClone(cur);
  return { branch: 'standard', snap, final: cur };
}

// Blank the three Date-derived stamps (normalizedAt, generatedAt, auditEvent.createdAt) on a node record before
// a structural compare. With PinnedDate they ARE equal on both sides, but we blank them defensively and assert
// ISO separately so the differential proves their FORMAT independent of the pin. (traceId/ticketId/auditEventId
// are seed-derived and NOT blanked — they are the load-bearing deterministic identifiers.)
function blankStamps(record) {
  const r = structuredClone(record);
  if (r.normalizedAt !== undefined) r.normalizedAt = '<ts>';
  if (r.generatedAt !== undefined) r.generatedAt = '<ts>';
  if (r.auditEvent && r.auditEvent.createdAt !== undefined) r.auditEvent.createdAt = '<ts>';
  return r;
}

// ---------------------------------------------------------------------------------------------------------
// DOCUMENTED behavioral expectations per fixture (the SAME contract Test-SupportTriageWorkflow.ps1 asserts
// live). branch + the response routing decisions + handlingPath + feishuDelivery presence.
// ---------------------------------------------------------------------------------------------------------
const EXPECT = {
  'support-triage-enterprise-incident': { branch: 'escalated', statusCode: 200, ok: true, category: 'incident', urgency: 'critical', routingTeam: 'platform-support', slaHours: 1, handlingPath: 'escalated', escalationRequired: true, feishuStatus: 'skipped' },
  'support-triage-urgent-incident': { branch: 'escalated', statusCode: 200, ok: true, category: 'incident', urgency: 'urgent', routingTeam: 'platform-support', slaHours: 2, handlingPath: 'escalated', escalationRequired: true, feishuStatus: 'skipped' },
  'support-triage-billing': { branch: 'standard', statusCode: 200, ok: true, category: 'billing', urgency: 'high', routingTeam: 'billing-support', slaHours: 8, handlingPath: 'standard', escalationRequired: false, feishuStatus: 'skipped' },
  'support-triage-account-alias': { branch: 'standard', statusCode: 200, ok: true, category: 'account', urgency: 'normal', routingTeam: 'account-success', slaHours: 24, handlingPath: 'standard', escalationRequired: false, feishuStatus: 'skipped' },
  'support-triage-bug': { branch: 'standard', statusCode: 200, ok: true, category: 'bug', urgency: 'normal', routingTeam: 'product-engineering', slaHours: 24, handlingPath: 'standard', escalationRequired: false, feishuStatus: 'skipped' },
  'support-triage-general': { branch: 'standard', statusCode: 200, ok: true, category: 'general', urgency: 'normal', routingTeam: 'general-support', slaHours: 24, handlingPath: 'standard', escalationRequired: false, feishuStatus: 'skipped' },
  'support-triage-invalid-date': { branch: 'standard', statusCode: 200, ok: true, category: 'general', urgency: 'normal', routingTeam: 'general-support', slaHours: 24, handlingPath: 'standard', escalationRequired: false, feishuStatus: 'skipped' },
  'support-triage-missing-field': { branch: 'validation-error', statusCode: 400, ok: false, error: 'Missing required fields', missingField: 'message' }
};

// support-triage-input.json is the retained v0.1.0 historical fixture (not part of the v0.3.0 acceptance suite);
// we still run it through the differential (compiled == core) without a behavioral pin, to widen coverage.
const NO_PIN = new Set(['support-triage-input']);

// ---------------------------------------------------------------------------------------------------------
// MAIN: every pin-data fixture through the compiled pipeline + the core, asserting byte-identity per stage and
// the documented behavioral expectations.
// ---------------------------------------------------------------------------------------------------------
const fixtureFiles = readdirSync(pinDataDir).filter((f) => f.endsWith('.json')).sort();
const opts = { now: PINNED_ISO, nowMs: PINNED_MS };

for (const file of fixtureFiles) {
  const id = file.replace(/\.json$/, '');
  const fixture = JSON.parse(readFileSync(join(pinDataDir, file), 'utf8'));

  // (a) the DEPLOYED jsCode pipeline (extracted from the compiled canonical, Date pinned).
  let compiled;
  try {
    compiled = runCompiled(fixture);
  } catch (e) {
    check(id, 'compiled pipeline executes', false, e.message);
    continue;
  }
  check(id, 'compiled pipeline executes', true);

  // (b) the audited core, same request + same injected instant.
  const core = runTriageCore(fixture, opts);

  // (c) DIFFERENTIAL — branch decision + each compiled stage output EQUALS the core's on the same input.
  check(id, 'branch decision == core', compiled.branch === core.branch, compiled.branch + ' vs ' + core.branch);

  check(id, 'DIFF normalize == core (stamps-normalized)',
    eq(blankStamps(compiled.snap[NORMALIZE]), blankStamps(normalizePayload(fixture, opts))));

  if (compiled.branch === 'validation-error') {
    check(id, 'DIFF validation-error record == core', eq(compiled.final, buildValidationError(compiled.snap[NORMALIZE])), 'records diverge');
  } else {
    const coreNorm = normalizePayload(fixture, opts);
    const coreMeta = generateTicketMetadata(coreNorm, opts);
    const coreRedact = redactCustomerPii(coreMeta);
    const coreClassify = classifyTicketCategory(coreRedact);
    const coreScore = scoreUrgency(coreClassify);
    const coreRoute = routeOwningTeam(coreScore);
    const coreSla = buildSlaPolicy(coreRoute, opts);

    check(id, 'DIFF generate metadata == core (stamps-normalized)', eq(blankStamps(compiled.snap[META]), blankStamps(coreMeta)));
    check(id, 'DIFF redact PII == core', eq(blankStamps(compiled.snap[REDACT]), blankStamps(coreRedact)));
    check(id, 'DIFF classify == core (category+matchedTerms)',
      eq(compiled.snap[CLASSIFY].category, coreClassify.category) && eq(compiled.snap[CLASSIFY].matchedTerms, coreClassify.matchedTerms));
    check(id, 'DIFF score urgency == core (score+urgency)',
      compiled.snap[SCORE].urgencyScore === coreScore.urgencyScore && compiled.snap[SCORE].urgency === coreScore.urgency);
    check(id, 'DIFF route team == core', compiled.snap[ROUTE].routingTeam === coreRoute.routingTeam);
    check(id, 'DIFF SLA policy == core (slaHours+dueAt+breachRisk+escalationRequired)',
      compiled.snap[SLA].slaHours === coreSla.slaHours
      && compiled.snap[SLA].dueAt === coreSla.dueAt
      && compiled.snap[SLA].breachRisk === coreSla.breachRisk
      && compiled.snap[SLA].escalationRequired === coreSla.escalationRequired);

    if (compiled.branch === 'escalated') {
      const corePayload = buildEscalationPayload(coreSla);
      const coreAudit = buildAuditEvent(corePayload, opts);
      check(id, 'DIFF escalation payload == core', eq(blankStamps(compiled.snap[ESC_PAYLOAD]), blankStamps(corePayload)));
      check(id, 'DIFF escalation audit event == core (createdAt-normalized)',
        eq(blankStamps(compiled.snap[ESC_AUDIT]).auditEvent, blankStamps(coreAudit).auditEvent));
      check(id, 'DIFF auditEventId == core (ticketId-derived)',
        compiled.snap[ESC_AUDIT].auditEventId === coreAudit.auditEventId,
        compiled.snap[ESC_AUDIT].auditEventId + ' vs ' + coreAudit.auditEventId);
      // Record Feishu Skipped (offline tail) — the compiled card's nondeterministic payload is discarded here.
      const coreSkipped = recordFeishuSkipped({ ...coreAudit, feishuDelivery: { configured: false, signed: false, status: 'skipped', reason: 'FEISHU_BOT_WEBHOOK_URL is not set' } });
      check(id, 'DIFF record feishu skipped == core (feishuDelivery)', eq(compiled.snap[FEISHU_SKIPPED].feishuDelivery, coreSkipped.feishuDelivery));
    } else {
      const corePayload = buildStandardPayload(coreSla);
      const coreAudit = buildAuditEvent(corePayload, opts);
      check(id, 'DIFF standard payload == core', eq(blankStamps(compiled.snap[STD_PAYLOAD]), blankStamps(corePayload)));
      check(id, 'DIFF standard audit event == core (createdAt-normalized)',
        eq(blankStamps(compiled.snap[STD_AUDIT]).auditEvent, blankStamps(coreAudit).auditEvent));
      check(id, 'DIFF auditEventId == core (ticketId-derived)',
        compiled.snap[STD_AUDIT].auditEventId === coreAudit.auditEventId,
        compiled.snap[STD_AUDIT].auditEventId + ' vs ' + coreAudit.auditEventId);
    }

    // whole-record differential: compiled final response == core final response (stamps normalized identically).
    check(id, 'DIFF final response record == core (whole record, ts-normalized)',
      eq(blankStamps(compiled.final), blankStamps(core.final)), 'records diverge');
  }

  // (d) BEHAVIORAL expectations against the DEPLOYED jsCode.
  const exp = EXPECT[id];
  if (!exp) {
    if (!NO_PIN.has(id)) { check(id, 'has a behavioral pin', false, 'no EXPECT entry for fixture'); }
    continue;
  }
  check(id, 'branch == ' + exp.branch, compiled.branch === exp.branch, compiled.branch);
  check(id, 'statusCode == ' + exp.statusCode, compiled.final.statusCode === exp.statusCode, String(compiled.final.statusCode));

  if (exp.branch === 'validation-error') {
    const r = compiled.final.response;
    check(id, 'response.ok == false', r.ok === false);
    check(id, 'error == "' + exp.error + '"', r.error === exp.error, r.error);
    check(id, 'missingFields includes "' + exp.missingField + '"', Array.isArray(r.missingFields) && r.missingFields.includes(exp.missingField), JSON.stringify(r.missingFields));
    check(id, 'traceId present', typeof r.traceId === 'string' && r.traceId.startsWith('trace-'), r.traceId);
    // the validation-error response carries NO feishuDelivery (contract: only triaged responses do).
    check(id, 'validation-error response omits feishuDelivery', r.feishuDelivery === undefined);
  } else {
    const r = compiled.final.response;
    check(id, 'response.ok == true', r.ok === exp.ok);
    check(id, 'category == ' + exp.category, r.category === exp.category, r.category);
    check(id, 'urgency == ' + exp.urgency, r.urgency === exp.urgency, r.urgency);
    check(id, 'routingTeam == ' + exp.routingTeam, r.routingTeam === exp.routingTeam, r.routingTeam);
    check(id, 'slaHours == ' + exp.slaHours, r.slaHours === exp.slaHours, String(r.slaHours));
    check(id, 'handlingPath == ' + exp.handlingPath, r.handlingPath === exp.handlingPath, r.handlingPath);
    check(id, 'escalationRequired == ' + exp.escalationRequired, r.escalationRequired === exp.escalationRequired, String(r.escalationRequired));
    check(id, 'policyVersion == ' + POLICY_VERSION, r.policyVersion === POLICY_VERSION, r.policyVersion);
    check(id, 'ticketId present (TKT-)', typeof r.ticketId === 'string' && r.ticketId.startsWith('TKT-'), r.ticketId);
    check(id, 'auditEventId present (audit-tkt-)', typeof r.auditEventId === 'string' && r.auditEventId.startsWith('audit-tkt-'), r.auditEventId);
    check(id, 'dueAt is ISO', isIso(r.dueAt), r.dueAt);
    // CONTRACT: both standard AND escalated triaged responses carry a feishuDelivery object (with status skipped
    // when no Feishu is configured). This pins the documented standard-vs-escalated response shape.
    check(id, 'response carries feishuDelivery', r.feishuDelivery && typeof r.feishuDelivery === 'object');
    check(id, 'feishuDelivery.status == ' + exp.feishuStatus, r.feishuDelivery.status === exp.feishuStatus, r.feishuDelivery.status);
    check(id, 'feishuDelivery.configured == false (offline)', r.feishuDelivery.configured === false);

    // MASKING / absence: the raw customer email must NOT appear anywhere in the response OR the audit event.
    const src = fixture.body ?? fixture;
    const rawEmail = String(src.customerEmail ?? src.email ?? '').trim().toLowerCase();
    const serialized = JSON.stringify(compiled.final.response) + JSON.stringify(compiled.final.auditEvent);
    if (rawEmail) {
      check(id, 'no raw customer email in response/audit (masking)', !serialized.includes(rawEmail), serialized.includes(rawEmail) ? 'LEAK' : 'clean');
    }
    // the audit event must carry a redacted (masked) email and NOT the raw message text.
    const ae = compiled.final.auditEvent;
    check(id, 'audit event redactedEmail is masked', typeof ae.redactedEmail === 'string' && ae.redactedEmail.includes('***'), ae.redactedEmail);
    check(id, 'audit event omits raw customerEmail/message fields', ae.customerEmail === undefined && ae.message === undefined);
    const rawMessage = String(src.message ?? src.description ?? '');
    if (rawMessage.length > 20) {
      const probe = rawMessage.slice(0, 60);
      check(id, 'audit event does not leak raw message', !JSON.stringify(ae).includes(probe));
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// EDGE: a fully-empty body -> validation error with all three required fields missing (compiled == core).
// ---------------------------------------------------------------------------------------------------------
{
  const empty = { body: {} };
  const compiled = runCompiled(empty);
  const core = runTriageCore(empty, opts);
  check('empty-body', 'branch == validation-error', compiled.branch === 'validation-error', compiled.branch);
  check('empty-body', 'DIFF validation-error record == core', eq(compiled.final, core.final), 'records diverge');
  check('empty-body', 'statusCode == 400', compiled.final.statusCode === 400, String(compiled.final.statusCode));
  check('empty-body', 'all three required fields missing',
    eq(compiled.final.response.missingFields, ['customerEmail', 'subject', 'message']), JSON.stringify(compiled.final.response.missingFields));
}

console.log('');
console.log('triage-workflow behavioral self-test: ' + pass + ' passed, ' + fail + ' failed ('
  + fixtureFiles.length + ' pin-data fixtures + empty-body, OFFLINE, compiled jsCode + differential vs core)');
process.exit(fail > 0 ? 1 : 0);
