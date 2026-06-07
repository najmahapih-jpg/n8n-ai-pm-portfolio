// lead-core.mjs — the lead-intelligence workflow's PURE deterministic stub-path logic (single source of truth;
// the n8n Code nodes mirror these). No n8n, no network: assertable in-process by test-lead-workflow.mjs.
//
// SCOPE: this core reproduces the DETERMINISTIC LOCAL path only — the offline, reproducible lane the Layer-2
// suite (verify:static / CI) exercises. That path is the Code-node chain the webhook/manual/executeWorkflow
// entrypoints all converge on:
//   Normalize Lead Payload -> [Required Fields Present?] -> [Email Syntax Valid?] -> Generate Lead Identity ->
//   Redact Lead PII -> Check Duplicate Candidate -> [Duplicate Lead?]
//     duplicate  -> Build Duplicate Lead Response (200)
//     not-dup    -> Mock Company Enrichment -> Mock Intent Enrichment -> Aggregate Scoring Evidence ->
//                   Calculate ICP Fit Score -> Calculate Intent Score -> Calculate Priority Score ->
//                   Assign Lead Grade -> Route Sales Owner -> Build Follow-up Policy -> [Hot Lead?]
//                     hot     -> Build Hot Lead Notification -> Record Notification Skipped -> Build CRM-ready Payload
//                     not-hot -> Build CRM-ready Payload
//                   -> Create Redacted Audit Event -> Build Lead Intelligence Response (200)
// plus the two error branches: Build Required Field Error (400) and Build Email Syntax Error (422).
// There is NO live CRM / MCP / HTTP branch in this workflow — every non-error node is a deterministic local
// rule engine, so the entire decision path is mirrored here. test-lead-workflow.mjs executes the COMPILED
// jsCode of each node above and asserts it is byte-behaviour-identical to the functions below over the 11
// golden fixtures (the differential).
//
// BEHAVIOR-PRESERVING CONTRACT: each function is a verbatim reverse-extract of the corresponding node's body.
// The Code nodes carry no regex literals (the email-syntax regex lives in the 'Email Syntax Valid?' ifElse,
// not a Code node) so there is no single/double-escape skew to reconcile; the core mirrors the node verbatim.
// The gate predicates (Required Fields / Email Syntax / Duplicate / Hot Lead ifElse nodes) are replicated as
// pure helpers so the full-pipeline composition makes the identical branch decision n8n would.
//
// The POLICY_VERSION below MUST match the literal 'lead-intel-v0.1.0' baked into the compiled nodes; if a
// future recompile bumps it, the differential will fail loudly until the core is re-synced (the intended guard).
export const POLICY_VERSION = 'lead-intel-v0.1.0';

// FNV-1a hash, 8-hex-padded — the exact helper baked into 'Generate Lead Identity' / 'Create Redacted Audit Event'.
function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------------------------------------
// (1) normalizeLead — mirror of the 'Normalize Lead Payload' Code node. Alias-folds the intake fields, derives
// the company domain, splits intent signals, and computes the required-field validation. The node defaults
// lead.receivedAt to new Date().toISOString() ONLY when the payload omits it; the differential injects the
// SAME instant via opts.now so the records (and the receivedAt-derived idempotencyKey) compare byte-identical.
// All 11 golden fixtures supply receivedAt, so opts.now is exercised only as a parity safeguard.
// ---------------------------------------------------------------------------------------------------------
export function normalizeLead(source, opts = {}) {
  source = source ?? {};
  const body = source.body ?? source;
  const entrypoint = source.manualExecution === true || body.manualExecution === true ? 'manual' : 'webhook';
  const text = (value) => String(value ?? '').trim();
  const lower = (value) => text(value).toLowerCase();
  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const splitSignals = (value) => {
    if (Array.isArray(value)) return value.map(text).filter(Boolean);
    return text(value).split(',').map((part) => part.trim()).filter(Boolean);
  };

  const email = lower(body.email ?? body.workEmail ?? body.customerEmail);
  const domainFromEmail = email.includes('@') ? email.split('@').pop() : '';
  const companyDomain = lower(body.companyDomain ?? body.domain ?? domainFromEmail);
  const companyName = text(body.companyName ?? body.company ?? body.accountName);
  const requestedProduct = text(body.requestedProduct ?? body.product ?? body.interest);
  const message = text(body.message ?? body.notes ?? body.description ?? body.request);
  const sourceName = lower(body.source ?? body.channel ?? 'web');
  const intentSignals = splitSignals(body.intentSignals ?? body.signals ?? body.intent);
  const missingFields = [];
  if (!email) missingFields.push('email');
  if (!companyName) missingFields.push('companyName');
  if (!message && intentSignals.length === 0 && !requestedProduct) missingFields.push('message');

  // The node uses new Date().toISOString() when receivedAt is absent; the core takes it via opts so the
  // differential can pin both sides to the same instant. When opts.now is absent (e.g. a direct core call)
  // it falls back to wall-clock exactly like the node.
  const nowIso = opts.now != null ? String(opts.now) : new Date().toISOString();

  return {
    lead: {
      email,
      fullName: text(body.fullName ?? body.name),
      title: text(body.title ?? body.jobTitle),
      companyName,
      companyDomain,
      source: sourceName,
      industry: lower(body.industry),
      country: lower(body.country ?? body.region),
      employeeCount: number(body.employeeCount ?? body.employees ?? body.companySize),
      annualRevenue: number(body.annualRevenue ?? body.revenue),
      requestedProduct,
      message,
      intentSignals,
      plan: lower(body.plan),
      manualGrade: text(body.manualGrade ?? body.overrideGrade).toUpperCase(),
      existingLeadId: text(body.existingLeadId),
      receivedAt: text(body.receivedAt) || nowIso
    },
    validation: {
      requiredFieldsPresent: missingFields.length === 0,
      missingFields
    },
    runtime: {
      entrypoint
    },
    sourcePayloadKeys: Object.keys(body)
  };
}

// ---------------------------------------------------------------------------------------------------------
// (2) generateLeadIdentity — mirror of 'Generate Lead Identity'. Deterministic FNV-1a ids from email/domain.
// ---------------------------------------------------------------------------------------------------------
export function generateLeadIdentity(input) {
  const identitySeed = [input.lead.email, input.lead.companyDomain].join('|');
  return {
    ...input,
    identity: {
      leadId: 'lead_' + hash(identitySeed),
      emailHash: hash(input.lead.email),
      companyKey: hash(input.lead.companyDomain || input.lead.companyName.toLowerCase()),
      idempotencyKey: hash(identitySeed + '|' + input.lead.receivedAt.slice(0, 10))
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (3) redactLeadPii — mirror of 'Redact Lead PII'. Masks the email local-part and the full name first letter.
// ---------------------------------------------------------------------------------------------------------
export function redactLeadPii(input) {
  const email = input.lead.email;
  const [localPart, domain] = email.split('@');
  const redactedLocal = localPart ? localPart[0] + '***' : '***';
  return {
    ...input,
    pii: {
      redactedEmail: redactedLocal + '@' + domain,
      redactedName: input.lead.fullName ? input.lead.fullName[0] + '***' : ''
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (4) checkDuplicateCandidate — mirror of 'Check Duplicate Candidate'. existingLeadId OR a known dup domain.
// ---------------------------------------------------------------------------------------------------------
export function checkDuplicateCandidate(input) {
  const domain = input.lead.companyDomain;
  const duplicateDomains = new Set(['acme.test', 'duplicate.example']);
  const duplicateByPayload = Boolean(input.lead.existingLeadId);
  const duplicateByDomain = duplicateDomains.has(domain);
  return {
    ...input,
    dedupe: {
      duplicate: duplicateByPayload || duplicateByDomain,
      reason: duplicateByPayload ? 'existingLeadId supplied' : duplicateByDomain ? 'domain recently processed' : 'no duplicate signals',
      matchedLeadId: input.lead.existingLeadId || (duplicateByDomain ? 'lead_existing_' + input.identity.companyKey : '')
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (5) buildDuplicateResponse — mirror of 'Build Duplicate Lead Response' (the duplicate 200 branch). Carries
// only ids/reason/action — never the raw email, name, message, PII, scoring, route, or audit event (the
// duplicate-branch zero-PII-leak invariant: this branch precedes scoring and never builds an audit event).
// ---------------------------------------------------------------------------------------------------------
export function buildDuplicateResponse(input) {
  return {
    statusCode: 200,
    runtime: input.runtime,
    response: {
      ok: true,
      duplicate: true,
      leadId: input.identity.leadId,
      matchedLeadId: input.dedupe.matchedLeadId,
      reason: input.dedupe.reason,
      action: 'attach_to_existing_record',
      policyVersion: 'lead-intel-v0.1.0'
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (6) mockCompanyEnrichment — mirror of 'Mock Company Enrichment'. Deterministic firmographic bands/flags.
// ---------------------------------------------------------------------------------------------------------
export function mockCompanyEnrichment(input) {
  const lead = input.lead;
  const employeeCount = lead.employeeCount ?? 0;
  const domain = lead.companyDomain;
  const freeDomains = new Set(['gmail.com', 'qq.com', 'outlook.com', '163.com', 'example.test']);
  const competitorDomains = new Set(['competitor.example', 'rival.test']);
  const studentDomains = ['.edu', 'student.'];
  const isFreeEmail = freeDomains.has(domain);
  const isCompetitor = competitorDomains.has(domain) || lead.companyName.toLowerCase().includes('competitor');
  const isStudent = studentDomains.some((probe) => domain.includes(probe)) || lead.title.toLowerCase().includes('student');
  let employeeBand = 'unknown';
  if (employeeCount >= 1000) employeeBand = 'enterprise';
  else if (employeeCount >= 200) employeeBand = 'mid_market';
  else if (employeeCount > 0) employeeBand = 'smb';
  const highFitIndustries = new Set(['saas', 'fintech', 'ecommerce', 'healthcare', 'logistics']);
  return {
    ...input,
    enrichment: {
      company: {
        employeeBand,
        normalizedEmployeeCount: employeeCount,
        freeEmailDomain: isFreeEmail,
        competitor: isCompetitor,
        studentOrAcademic: isStudent,
        industryFit: highFitIndustries.has(lead.industry) ? 'high' : lead.industry ? 'medium' : 'unknown',
        geoFit: ['us', 'usa', 'united states', 'canada', 'uk', 'singapore', 'china'].includes(lead.country) ? 'supported' : 'unknown'
      }
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (7) mockIntentEnrichment — mirror of 'Mock Intent Enrichment'. Keyword + source weight tables.
// ---------------------------------------------------------------------------------------------------------
export function mockIntentEnrichment(input) {
  const lead = input.lead;
  const text = [lead.message, lead.requestedProduct, ...lead.intentSignals].join(' ').toLowerCase();
  const keywordWeights = [
    ['demo', 28],
    ['pricing', 20],
    ['quote', 20],
    ['pilot', 18],
    ['implementation', 16],
    ['security review', 14],
    ['migration', 14],
    ['urgent', 12],
    ['newsletter', -18],
    ['student', -30],
    ['research', -12],
    ['free', -10]
  ];
  const matchedSignals = [];
  let keywordScore = 0;
  for (const [keyword, weight] of keywordWeights) {
    if (text.includes(keyword)) {
      matchedSignals.push(keyword);
      keywordScore += weight;
    }
  }
  const sourceWeights = {
    partner: 16,
    webinar: 10,
    paid_search: 8,
    outbound: 6,
    referral: 14,
    newsletter: -8,
    student: -20
  };
  return {
    ...input,
    enrichment: {
      ...input.enrichment,
      intent: {
        matchedSignals,
        keywordScore,
        sourceScore: sourceWeights[lead.source] ?? 0,
        requestedProduct: lead.requestedProduct || 'unknown'
      }
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (8) aggregateEvidence — mirror of 'Aggregate Scoring Evidence'. Flattens company + intent into evidence[].
// ---------------------------------------------------------------------------------------------------------
export function aggregateEvidence(input) {
  const evidence = [];
  const company = input.enrichment.company;
  const intent = input.enrichment.intent;
  evidence.push('employee_band:' + company.employeeBand);
  evidence.push('industry_fit:' + company.industryFit);
  evidence.push('geo_fit:' + company.geoFit);
  if (company.freeEmailDomain) evidence.push('free_email_domain');
  if (company.competitor) evidence.push('competitor_domain');
  if (company.studentOrAcademic) evidence.push('student_or_academic');
  for (const signal of intent.matchedSignals) evidence.push('intent:' + signal);
  return {
    ...input,
    evidence
  };
}

// ---------------------------------------------------------------------------------------------------------
// (9) calculateIcpFitScore — mirror of 'Calculate ICP Fit Score'. Firmographic weight table clamped to 0..100.
// ---------------------------------------------------------------------------------------------------------
export function calculateIcpFitScore(input) {
  const company = input.enrichment.company;
  let score = 20;
  if (company.employeeBand === 'enterprise') score += 35;
  else if (company.employeeBand === 'mid_market') score += 25;
  else if (company.employeeBand === 'smb') score += 10;
  if (company.industryFit === 'high') score += 22;
  else if (company.industryFit === 'medium') score += 10;
  if (company.geoFit === 'supported') score += 10;
  if (input.lead.plan === 'enterprise') score += 8;
  if (company.freeEmailDomain) score -= 28;
  if (company.studentOrAcademic) score -= 35;
  if (company.competitor) score -= 45;
  score = Math.max(0, Math.min(100, score));
  return { ...input, scoring: { icpFitScore: score } };
}

// ---------------------------------------------------------------------------------------------------------
// (10) calculateIntentScore — mirror of 'Calculate Intent Score'. base 30 + keyword + source + product/length.
// ---------------------------------------------------------------------------------------------------------
export function calculateIntentScore(input) {
  const intent = input.enrichment.intent;
  let score = 30 + intent.keywordScore + intent.sourceScore;
  if (input.lead.requestedProduct) score += 8;
  if (input.lead.message.length > 80) score += 6;
  score = Math.max(0, Math.min(100, score));
  return { ...input, scoring: { ...input.scoring, intentScore: score } };
}

// ---------------------------------------------------------------------------------------------------------
// (11) calculatePriorityScore — mirror of 'Calculate Priority Score'. ICP 0.58 + intent 0.42; competitor cap;
// manual-grade floor.
// ---------------------------------------------------------------------------------------------------------
export function calculatePriorityScore(input) {
  const icp = input.scoring.icpFitScore;
  const intent = input.scoring.intentScore;
  let score = Math.round((icp * 0.58) + (intent * 0.42));
  if (input.enrichment.company.competitor) score = Math.min(score, 25);
  if (input.lead.manualGrade) score = Math.max(score, 85);
  score = Math.max(0, Math.min(100, score));
  return { ...input, scoring: { ...input.scoring, priorityScore: score } };
}

// ---------------------------------------------------------------------------------------------------------
// (12) assignLeadGrade — mirror of 'Assign Lead Grade'. A>=80, B>=62, C>=40, else D; manualGrade override.
// ---------------------------------------------------------------------------------------------------------
export function assignLeadGrade(input) {
  let grade = 'D';
  const score = input.scoring.priorityScore;
  if (score >= 80) grade = 'A';
  else if (score >= 62) grade = 'B';
  else if (score >= 40) grade = 'C';
  if (['A', 'B', 'C', 'D'].includes(input.lead.manualGrade)) {
    grade = input.lead.manualGrade;
  }
  return {
    ...input,
    scoring: {
      ...input.scoring,
      grade,
      manuallyOverridden: ['A', 'B', 'C', 'D'].includes(input.lead.manualGrade)
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (13) routeSalesOwner — mirror of 'Route Sales Owner'. competitor disqualify, else by grade A/B/C, else nurture.
// ---------------------------------------------------------------------------------------------------------
export function routeSalesOwner(input) {
  const grade = input.scoring.grade;
  let route = {
    ownerQueue: 'nurture',
    ownerTeam: 'growth-marketing',
    reason: 'low priority or insufficient fit'
  };
  if (input.enrichment.company.competitor) {
    route = { ownerQueue: 'disqualified-competitor', ownerTeam: 'revops', reason: 'competitor domain' };
  } else if (grade === 'A') {
    route = { ownerQueue: 'enterprise-ae', ownerTeam: 'enterprise-sales', reason: 'high fit and high intent' };
  } else if (grade === 'B') {
    route = { ownerQueue: 'midmarket-ae', ownerTeam: 'commercial-sales', reason: 'qualified commercial lead' };
  } else if (grade === 'C') {
    route = { ownerQueue: 'sdr-qualification', ownerTeam: 'sales-development', reason: 'needs qualification' };
  }
  return { ...input, route };
}

// ---------------------------------------------------------------------------------------------------------
// (14) buildFollowUpPolicy — mirror of 'Build Follow-up Policy'. SLA hours by grade + the hotLead flag. dueAt
// is the node's new Date(Date.now() + slaHours*hr).toISOString(); the differential injects the SAME base
// instant via opts.now so dueAt compares byte-identical (the only Date.now()-derived field in this stage).
// ---------------------------------------------------------------------------------------------------------
export function buildFollowUpPolicy(input, opts = {}) {
  const hoursByGrade = { A: 2, B: 8, C: 48, D: 168 };
  const followUpSlaHours = hoursByGrade[input.scoring.grade] ?? 168;
  const baseMs = opts.now != null ? Date.parse(String(opts.now)) : Date.now();
  const dueAt = new Date(baseMs + followUpSlaHours * 60 * 60 * 1000).toISOString();
  return {
    ...input,
    followUp: {
      slaHours: followUpSlaHours,
      dueAt,
      hotLead: input.scoring.grade === 'A',
      playbook: input.scoring.grade === 'A' ? 'same-day executive AE follow-up' : input.scoring.grade === 'B' ? 'commercial AE follow-up' : input.scoring.grade === 'C' ? 'SDR qualification' : 'nurture sequence'
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (15) buildHotLeadNotification — mirror of 'Build Hot Lead Notification' (the hot-lead branch). Composes a
// notification object from already-redacted/scored fields (companyName + scores + queue + evidence head).
// ---------------------------------------------------------------------------------------------------------
export function buildHotLeadNotification(input) {
  return {
    ...input,
    notification: {
      channel: 'sales-hot-leads',
      status: 'ready',
      title: 'Hot lead: ' + input.lead.companyName,
      summary: input.lead.companyName + ' scored ' + input.scoring.priorityScore + ' (' + input.scoring.grade + ') and routes to ' + input.route.ownerQueue,
      evidence: input.evidence.slice(0, 8)
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (16) recordNotificationSkipped — mirror of 'Record Notification Skipped'. Marks the (v0.1) no-adapter skip.
// ---------------------------------------------------------------------------------------------------------
export function recordNotificationSkipped(input) {
  return {
    ...input,
    notification: {
      ...(input.notification ?? {}),
      status: 'skipped',
      reason: 'No external notification adapter configured in v0.1'
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (17) buildCrmPayload — mirror of 'Build CRM-ready Payload'. The full CRM record (internal; the response
// later exposes only a safe subset). Carries the raw email here, but the response/audit redact it.
// ---------------------------------------------------------------------------------------------------------
export function buildCrmPayload(input) {
  return {
    ...input,
    crmPayload: {
      externalId: input.identity.leadId,
      idempotencyKey: input.identity.idempotencyKey,
      email: input.lead.email,
      companyName: input.lead.companyName,
      companyDomain: input.lead.companyDomain,
      source: input.lead.source,
      requestedProduct: input.lead.requestedProduct,
      grade: input.scoring.grade,
      priorityScore: input.scoring.priorityScore,
      icpFitScore: input.scoring.icpFitScore,
      intentScore: input.scoring.intentScore,
      ownerQueue: input.route.ownerQueue,
      ownerTeam: input.route.ownerTeam,
      followUpDueAt: input.followUp.dueAt,
      evidence: input.evidence
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (18) createAuditEvent — mirror of 'Create Redacted Audit Event'. Carries only ids/redacted-email/verdicts/
// scores/evidence — never the raw email, full name, or message (masking invariant). createdAt is the node's
// new Date().toISOString(); the differential injects the SAME instant via opts.now into both sides.
// ---------------------------------------------------------------------------------------------------------
export function createAuditEvent(input, opts = {}) {
  const createdAt = opts.now != null ? String(opts.now) : new Date().toISOString();
  return {
    ...input,
    auditEvent: {
      auditEventId: 'audit_' + input.identity.idempotencyKey,
      leadId: input.identity.leadId,
      emailHash: input.identity.emailHash,
      redactedEmail: input.pii.redactedEmail,
      companyName: input.lead.companyName,
      grade: input.scoring.grade,
      priorityScore: input.scoring.priorityScore,
      ownerQueue: input.route.ownerQueue,
      evidence: input.evidence,
      createdAt
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (19) buildLeadResponse — mirror of 'Build Lead Intelligence Response'. The final { statusCode, runtime,
// response, auditEvent }. The response exposes only the safe subset (redactedEmail, scores, route, follow-up,
// a trimmed crmPayload) — never the raw email/name/message.
// ---------------------------------------------------------------------------------------------------------
export function buildLeadResponse(input) {
  return {
    statusCode: 200,
    runtime: input.runtime,
    response: {
      ok: true,
      duplicate: false,
      leadId: input.identity.leadId,
      companyName: input.lead.companyName,
      companyDomain: input.lead.companyDomain,
      redactedEmail: input.pii.redactedEmail,
      grade: input.scoring.grade,
      icpFitScore: input.scoring.icpFitScore,
      intentScore: input.scoring.intentScore,
      priorityScore: input.scoring.priorityScore,
      manuallyOverridden: input.scoring.manuallyOverridden,
      route: input.route,
      followUp: input.followUp,
      crmPayload: {
        externalId: input.crmPayload.externalId,
        idempotencyKey: input.crmPayload.idempotencyKey,
        ownerQueue: input.crmPayload.ownerQueue,
        grade: input.crmPayload.grade
      },
      auditEventId: input.auditEvent.auditEventId,
      notification: input.notification ?? { status: 'not_required' },
      policyVersion: 'lead-intel-v0.1.0'
    },
    auditEvent: input.auditEvent
  };
}

// ---------------------------------------------------------------------------------------------------------
// (20) buildRequiredError — mirror of 'Build Required Field Error' (the 400 branch when required fields miss).
// ---------------------------------------------------------------------------------------------------------
export function buildRequiredError(input) {
  return {
    statusCode: 400,
    runtime: input.runtime,
    response: {
      ok: false,
      error: 'Missing required lead fields',
      missingFields: input.validation.missingFields,
      policyVersion: 'lead-intel-v0.1.0'
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (21) buildEmailError — mirror of 'Build Email Syntax Error' (the 422 branch on a malformed email address).
// ---------------------------------------------------------------------------------------------------------
export function buildEmailError(input) {
  return {
    statusCode: 422,
    runtime: input.runtime,
    response: {
      ok: false,
      error: 'Invalid email syntax',
      email: input.lead.email,
      policyVersion: 'lead-intel-v0.1.0'
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// GATE PREDICATES — pure replicas of the four ifElse decision nodes, so the full-pipeline composition selects
// the identical branch n8n routes. (These nodes are NOT Code nodes; the differential replicates their boolean
// to drive the next compiled Code node, exactly how n8n's ifElse routes the item.)
// ---------------------------------------------------------------------------------------------------------
// 'Required Fields Present?' — on validation.requiredFieldsPresent.
export function requiredFieldsPresent(normalized) {
  return normalized.validation.requiredFieldsPresent === true;
}
// 'Email Syntax Valid?' — the ifElse's runtime regex /^[^\s@]+@[^\s@]+\.[^\s@]+$/ over lead.email.
export function emailSyntaxValid(normalized) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.lead.email);
}
// 'Duplicate Lead?' — on dedupe.duplicate.
export function isDuplicate(afterDedupe) {
  return afterDedupe.dedupe.duplicate === true;
}
// 'Hot Lead?' — on followUp.hotLead.
export function isHotLead(afterFollowUp) {
  return afterFollowUp.followUp.hotLead === true;
}

// ---------------------------------------------------------------------------------------------------------
// runLeadPipeline — convenience composition of the full deterministic local path + every gated branch. Threads
// opts.now into the timestamp-bearing stages (Normalize receivedAt default, Build Follow-up Policy dueAt,
// Create Redacted Audit Event createdAt) so a full run is reproducible end-to-end. Returns the terminal record
// (Required 400 / Email 422 / Duplicate 200 / Lead 200) plus the intermediate stage snapshots for assertion.
// This is the single entry point the differential and any future direct core test reuse.
// ---------------------------------------------------------------------------------------------------------
export function runLeadPipeline(source, opts = {}) {
  const normalized = normalizeLead(source, opts);
  if (!requiredFieldsPresent(normalized)) {
    return { branch: 'required-error', record: buildRequiredError(normalized), normalized };
  }
  if (!emailSyntaxValid(normalized)) {
    return { branch: 'email-error', record: buildEmailError(normalized), normalized };
  }
  const afterIdentity = generateLeadIdentity(normalized);
  const afterPii = redactLeadPii(afterIdentity);
  const afterDedupe = checkDuplicateCandidate(afterPii);
  if (isDuplicate(afterDedupe)) {
    return {
      branch: 'duplicate',
      record: buildDuplicateResponse(afterDedupe),
      normalized,
      identity: afterIdentity.identity,
      pii: afterPii.pii,
      dedupe: afterDedupe.dedupe
    };
  }
  const afterCompany = mockCompanyEnrichment(afterDedupe);
  const afterIntent = mockIntentEnrichment(afterCompany);
  const afterEvidence = aggregateEvidence(afterIntent);
  const afterIcp = calculateIcpFitScore(afterEvidence);
  const afterIntentScore = calculateIntentScore(afterIcp);
  const afterPriority = calculatePriorityScore(afterIntentScore);
  const afterGrade = assignLeadGrade(afterPriority);
  const afterRoute = routeSalesOwner(afterGrade);
  const afterFollowUp = buildFollowUpPolicy(afterRoute, opts);
  let beforeCrm;
  if (isHotLead(afterFollowUp)) {
    const afterNotify = buildHotLeadNotification(afterFollowUp);
    beforeCrm = recordNotificationSkipped(afterNotify);
  } else {
    beforeCrm = afterFollowUp;
  }
  const afterCrm = buildCrmPayload(beforeCrm);
  const afterAudit = createAuditEvent(afterCrm, opts);
  const record = buildLeadResponse(afterAudit);
  return {
    branch: 'lead',
    record,
    normalized,
    identity: afterIdentity.identity,
    pii: afterPii.pii,
    dedupe: afterDedupe.dedupe,
    enrichment: afterIntent.enrichment,
    evidence: afterEvidence.evidence,
    scoring: afterGrade.scoring,
    route: afterRoute.route,
    followUp: afterFollowUp.followUp,
    notification: beforeCrm.notification ?? null,
    crmPayload: afterCrm.crmPayload,
    auditEvent: afterAudit.auditEvent
  };
}
