// triage-core.mjs — the support-triage workflow's PURE deterministic stub-path logic (single source of truth;
// the n8n Code nodes mirror these). No n8n, no network: assertable in-process by test-triage-workflow.mjs.
//
// SCOPE: this core reproduces the DETERMINISTIC, OFFLINE-REPRODUCIBLE path of the support-triage workflow —
// the lane CI can exercise without n8n, Feishu, or any network. That path is the linear Code-node chain that
// runs when no FEISHU_BOT_WEBHOOK_URL is configured (the default local/offline posture):
//   Normalize Payload -> [Validate Required Fields gate]
//     onTrue:  Generate Ticket Metadata -> Redact Customer PII -> Classify Ticket Category -> Score Urgency
//              -> Route Owning Team -> Build SLA Policy -> [Escalation Needed? gate]
//        onTrue (escalated):  Build Escalation Payload -> Create Escalation Audit Event
//                             -> Record Feishu Skipped -> Build Escalation Customer Response
//        onFalse (standard):  Build Standard Handling Payload -> Create Standard Audit Event
//                             -> Build Standard Customer Response
//     onFalse: Build Validation Error
//
// The OUTBOUND Feishu branch (Send Feishu Alert httpRequest + Record Feishu Sent) is intentionally NOT mirrored
// here — it is outbound-only/live and belongs to verify:live. The offline escalation tail instead routes through
// Record Feishu Skipped (the n8n ifElse 'Feishu Enabled?' selects it when feishuDelivery.configured === false,
// which is the case whenever FEISHU_BOT_WEBHOOK_URL is unset). The compiled 'Build Feishu Alert Card' node runs
// on that tail too, but its only nondeterminism (payload.timestamp via Date.now(), and the HMAC sign which is
// only computed when a signing secret is present) is DISCARDED by Record Feishu Skipped, so the offline
// escalation response is fully deterministic. test-triage-workflow.mjs threads the COMPILED card+skipped nodes
// and asserts the resulting escalation response is byte-identical to buildEscalationResponse() below.
//
// BEHAVIOR-PRESERVING CONTRACT: each function is a verbatim reverse-extract of the corresponding node's body.
// Regex/unicode literals use the SINGLE-escaped form (e.g. /\s+/g), which is exactly what the compiled node's
// source evaluates to at runtime (the SDK double-escapes in the .js so the JSON-embedded copy single-escapes
// after JSON.parse). The core mirrors the node, never the other way around.
//
// FINDING #23: the workflow has TWO byte-identical audit-event builder nodes (Create Escalation Audit Event,
// Create Standard Audit Event). They are cored faithfully by the single buildAuditEvent() below (both nodes'
// jsCode is identical). The workflow is NOT deduped here — that is a separate behavior-affecting task.
//
// POLICY_VERSION below MUST match the literal baked into the compiled 'Generate Ticket Metadata' node; if a
// future recompile bumps it, the differential will fail loudly until the core is re-synced (the intended guard).
export const POLICY_VERSION = 'supportops-triage-v0.3.0-local-feishu';

// ---------------------------------------------------------------------------------------------------------
// (1) normalizePayload — mirror of the 'Normalize Payload' Code node.
// The node defaults receivedAt to new Date().toISOString() when absent and always stamps normalizedAt with
// new Date().toISOString(). normalizedAt is the only unconditional nondeterminism; the differential injects
// the SAME instant into both sides (via opts.now) so the records compare byte-identical. receivedAt is taken
// from the request in every golden fixture, so it is deterministic from input.
// traceId is CAPTURE-OR-GENERATE: it echoes a caller-supplied raw.traceId (else raw.requestId); when the caller
// supplies neither it FALLS BACK to the deterministic generated 'trace-<hash>' over [email|subject|receivedAt],
// so requests without a caller id stay byte-identical to the pre-capture behavior (the existing golden fixtures).
// ---------------------------------------------------------------------------------------------------------
export function normalizePayload(source, opts = {}) {
  const now = opts.now;
  const items = [{ json: source }];
  const raw = items[0]?.json?.body ?? items[0]?.json ?? {};
  const normalized = {
    customerEmail: String(raw.customerEmail ?? raw.email ?? '').trim().toLowerCase(),
    subject: String(raw.subject ?? raw.title ?? '').trim(),
    message: String(raw.message ?? raw.description ?? '').trim(),
    plan: String(raw.plan ?? raw.customerTier ?? 'free').trim().toLowerCase(),
    receivedAt: String(raw.receivedAt ?? (now ?? new Date().toISOString())),
    source: String(raw.source ?? 'webhook').trim().toLowerCase(),
    accountId: String(raw.accountId ?? raw.customerId ?? '').trim()
  };

  const requiredFields = ['customerEmail', 'subject', 'message'];
  const missingFields = requiredFields.filter((field) => !normalized[field]);
  const traceSeed = [normalized.customerEmail, normalized.subject, normalized.receivedAt].join('|');
  let hash = 0;
  for (const char of traceSeed) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  const traceId = raw.traceId ?? raw.requestId ?? ('trace-' + Math.abs(hash).toString(16).padStart(8, '0'));

  return {
    ...normalized,
    isValid: missingFields.length === 0,
    missingFields,
    traceId,
    normalizedAt: now ?? new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------------------------------------
// (2) buildValidationError — mirror of the 'Build Validation Error' Code node (the onFalse validation branch).
// ---------------------------------------------------------------------------------------------------------
export function buildValidationError(input) {
  return {
    statusCode: 400,
    response: {
      ok: false,
      error: 'Missing required fields',
      missingFields: input.missingFields,
      traceId: input.traceId,
      message: 'Provide customerEmail, subject, and message.'
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (3) generateTicketMetadata — mirror of the 'Generate Ticket Metadata' Code node.
// Stamps generatedAt with new Date().toISOString(); the differential injects opts.now for byte-parity.
// ---------------------------------------------------------------------------------------------------------
export function generateTicketMetadata(input, opts = {}) {
  const now = opts.now;
  const seed = [input.customerEmail, input.subject, input.receivedAt].join('|');
  let hash = 5381;
  for (const char of seed) {
    hash = ((hash << 5) + hash) + char.charCodeAt(0);
  }
  const ticketId = 'TKT-' + Math.abs(hash >>> 0).toString(36).toUpperCase().padStart(8, '0').slice(0, 8);
  return {
    ...input,
    ticketId,
    status: 'triaged',
    policyVersion: 'supportops-triage-v0.3.0-local-feishu',
    generatedAt: now ?? new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------------------------------------
// (4) redactCustomerPii — mirror of the 'Redact Customer PII' Code node.
// ---------------------------------------------------------------------------------------------------------
export function redactCustomerPii(input) {
  const [local, domain] = String(input.customerEmail).split('@');
  const redactedEmail = domain ? local.slice(0, 2) + '***@' + domain : 'unknown';
  const messagePreview = String(input.message).replace(/\s+/g, ' ').slice(0, 160);
  return {
    ...input,
    redactedEmail,
    messagePreview,
    piiRedacted: true
  };
}

// ---------------------------------------------------------------------------------------------------------
// (5) classifyTicketCategory — mirror of the 'Classify Ticket Category' Code node (deterministic routing).
// ---------------------------------------------------------------------------------------------------------
export function classifyTicketCategory(input) {
  const text = [input.subject, input.message, input.plan].join(' ').toLowerCase();
  const rules = [
    { category: 'incident', terms: ['outage', 'production', 'down', 'cannot complete checkout', 'all regions', 'sev1'] },
    { category: 'billing', terms: ['billing', 'invoice', 'refund', 'payment failed', 'charge'] },
    { category: 'account', terms: ['login', 'password', 'sso', 'permission', 'account'] },
    { category: 'bug', terms: ['bug', 'error', 'exception', 'regression', 'broken'] }
  ];
  let category = 'general';
  const matchedTerms = [];
  for (const rule of rules) {
    const hits = rule.terms.filter((term) => text.includes(term));
    if (hits.length > 0) {
      category = rule.category;
      matchedTerms.push(...hits);
      break;
    }
  }
  return { ...input, category, matchedTerms };
}

// ---------------------------------------------------------------------------------------------------------
// (6) scoreUrgency — mirror of the 'Score Urgency' Code node (deterministic priority decision).
// ---------------------------------------------------------------------------------------------------------
export function scoreUrgency(input) {
  const text = [input.subject, input.message].join(' ').toLowerCase();
  let score = 10;
  if (input.plan === 'enterprise') score += 30;
  if (input.category === 'incident') score += 35;
  if (input.category === 'billing') score += 35;
  if (['checkout', 'payment', 'production', 'all regions', 'outage'].some((term) => text.includes(term))) score += 25;
  if (['blocked', 'cannot', 'failed', 'failure'].some((term) => text.includes(term))) score += 10;
  score = Math.min(100, score);
  let urgency = 'normal';
  if (score >= 85) urgency = 'critical';
  else if (score >= 65) urgency = 'urgent';
  else if (score >= 40) urgency = 'high';
  return { ...input, urgencyScore: score, urgency };
}

// ---------------------------------------------------------------------------------------------------------
// (7) routeOwningTeam — mirror of the 'Route Owning Team' Code node (deterministic team decision).
// ---------------------------------------------------------------------------------------------------------
export function routeOwningTeam(input) {
  let routingTeam = 'general-support';
  if (input.category === 'incident' || input.urgency === 'critical' || input.urgency === 'urgent') routingTeam = 'platform-support';
  else if (input.category === 'billing') routingTeam = 'billing-support';
  else if (input.category === 'account') routingTeam = 'account-success';
  else if (input.category === 'bug') routingTeam = 'product-engineering';
  return { ...input, routingTeam };
}

// ---------------------------------------------------------------------------------------------------------
// (8) buildSlaPolicy — mirror of the 'Build SLA Policy' Code node (SLA + the escalation decision).
// dueAt is derived from receivedAt (deterministic from input) unless receivedAt is unparseable, in which case
// the node falls back to Date.now(); the differential injects opts.now so the invalid-date case is byte-stable.
// ---------------------------------------------------------------------------------------------------------
export function buildSlaPolicy(input, opts = {}) {
  const nowMs = opts.nowMs;
  const slaByUrgency = { critical: 1, urgent: 2, high: 8, normal: 24 };
  const slaHours = slaByUrgency[input.urgency] ?? 24;
  const start = new Date(input.receivedAt);
  const baseMs = Number.isNaN(start.getTime()) ? (nowMs ?? Date.now()) : start.getTime();
  const due = new Date(baseMs + slaHours * 60 * 60 * 1000);
  const escalationRequired = (
    (input.plan === 'enterprise' && ['critical', 'urgent'].includes(input.urgency)) ||
    (input.category === 'incident' && input.urgencyScore >= 65)
  );
  const breachRisk = input.urgency === 'critical' ? 'immediate' : input.urgency === 'urgent' ? 'elevated' : 'standard';
  return {
    ...input,
    slaHours,
    dueAt: due.toISOString(),
    breachRisk,
    escalationRequired
  };
}

// ---------------------------------------------------------------------------------------------------------
// (9) buildEscalationPayload — mirror of the 'Build Escalation Payload' Code node (escalated onTrue branch).
// ---------------------------------------------------------------------------------------------------------
export function buildEscalationPayload(input) {
  return {
    ...input,
    handlingPath: 'escalated',
    escalation: {
      required: true,
      target: 'incident-commander',
      channel: 'platform-sev-alerts',
      reason: input.matchedTerms.length > 0 ? input.matchedTerms.join(', ') : input.category,
      priority: input.urgency
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (10) buildStandardPayload — mirror of the 'Build Standard Handling Payload' Code node (standard onFalse).
// ---------------------------------------------------------------------------------------------------------
export function buildStandardPayload(input) {
  return {
    ...input,
    handlingPath: 'standard',
    escalation: {
      required: false,
      target: input.routingTeam,
      channel: input.routingTeam,
      reason: 'SLA queue routing',
      priority: input.urgency
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (11) buildAuditEvent — mirror of BOTH the 'Create Escalation Audit Event' AND 'Create Standard Audit Event'
// Code nodes (byte-identical jsCode; FINDING #23). Stamps createdAt with new Date().toISOString(); the
// differential injects opts.now for byte-parity, then blanks it before the structural compare.
// ---------------------------------------------------------------------------------------------------------
export function buildAuditEvent(input, opts = {}) {
  const now = opts.now;
  const auditEventId = 'audit-' + input.ticketId.toLowerCase();
  return {
    ...input,
    auditEventId,
    auditEvent: {
      id: auditEventId,
      type: 'support.ticket.triaged',
      traceId: input.traceId,
      ticketId: input.ticketId,
      redactedEmail: input.redactedEmail,
      category: input.category,
      urgency: input.urgency,
      urgencyScore: input.urgencyScore,
      routingTeam: input.routingTeam,
      slaHours: input.slaHours,
      escalationRequired: input.escalation.required,
      handlingPath: input.handlingPath,
      createdAt: now ?? new Date().toISOString()
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (12) recordFeishuSkipped — mirror of the 'Record Feishu Skipped' Code node (the OFFLINE escalation tail the
// 'Feishu Enabled?' ifElse selects when feishuDelivery.configured === false, i.e. FEISHU_BOT_WEBHOOK_URL unset).
// It rebuilds feishuDelivery from the prior (Build Feishu Alert Card) skipped delivery, discarding the card
// payload + the Date.now() timestamp, so the offline escalation response is fully deterministic.
// ---------------------------------------------------------------------------------------------------------
export function recordFeishuSkipped(input) {
  return {
    ...input,
    feishuDelivery: {
      configured: false,
      signed: input.feishuDelivery.signed,
      status: 'skipped',
      reason: input.feishuDelivery.reason
    }
  };
}

// The deterministic feishuDelivery object the offline escalation tail produces before Build Feishu Alert Card
// (env unset -> configured:false, signed:false, status:'skipped', reason). This is what 'Build Feishu Alert
// Card' emits with no FEISHU env and what recordFeishuSkipped consumes. Provided so the core can run the
// escalation tail standalone (without the live Feishu env / card payload), matching the compiled offline path.
export function skippedFeishuDelivery() {
  return {
    configured: false,
    signed: false,
    status: 'skipped',
    reason: 'FEISHU_BOT_WEBHOOK_URL is not set'
  };
}

// ---------------------------------------------------------------------------------------------------------
// (13) buildEscalationResponse — mirror of the 'Build Escalation Customer Response' Code node.
// CONTRACT: the escalated path's response INCLUDES feishuDelivery (carried from Record Feishu Skipped/Sent).
// ---------------------------------------------------------------------------------------------------------
export function buildEscalationResponse(input) {
  const response = {
    ok: true,
    ticketId: input.ticketId,
    traceId: input.traceId,
    category: input.category,
    urgency: input.urgency,
    urgencyScore: input.urgencyScore,
    routingTeam: input.routingTeam,
    slaHours: input.slaHours,
    dueAt: input.dueAt,
    escalationRequired: input.escalation.required,
    handlingPath: input.handlingPath,
    summary: input.subject + ' - ' + input.messagePreview,
    auditEventId: input.auditEventId,
    policyVersion: input.policyVersion,
    feishuDelivery: {
      configured: input.feishuDelivery?.configured ?? false,
      signed: input.feishuDelivery?.signed ?? false,
      status: input.feishuDelivery?.status ?? 'unknown',
      statusCode: input.feishuDelivery?.statusCode ?? null,
      reason: input.feishuDelivery?.reason ?? null
    }
  };
  return { statusCode: 200, response, auditEvent: input.auditEvent };
}

// ---------------------------------------------------------------------------------------------------------
// (14) buildStandardResponse — mirror of the 'Build Standard Customer Response' Code node.
// CONTRACT FINDING: the standard path's response ALSO carries a feishuDelivery object, but with the standard
// defaults (status defaults to 'skipped', reason 'standard handling path; no Feishu notification attempted').
// The standard path never builds a Feishu card, so input.feishuDelivery is absent and the ?? defaults apply.
// ---------------------------------------------------------------------------------------------------------
export function buildStandardResponse(input) {
  const response = {
    ok: true,
    ticketId: input.ticketId,
    traceId: input.traceId,
    category: input.category,
    urgency: input.urgency,
    urgencyScore: input.urgencyScore,
    routingTeam: input.routingTeam,
    slaHours: input.slaHours,
    dueAt: input.dueAt,
    escalationRequired: input.escalation.required,
    handlingPath: input.handlingPath,
    summary: input.subject + ' - ' + input.messagePreview,
    auditEventId: input.auditEventId,
    policyVersion: input.policyVersion,
    feishuDelivery: {
      configured: input.feishuDelivery?.configured ?? false,
      signed: input.feishuDelivery?.signed ?? false,
      status: input.feishuDelivery?.status ?? 'skipped',
      statusCode: input.feishuDelivery?.statusCode ?? null,
      reason: input.feishuDelivery?.reason ?? 'standard handling path; no Feishu notification attempted'
    }
  };
  return { statusCode: 200, response, auditEvent: input.auditEvent };
}

// ---------------------------------------------------------------------------------------------------------
// Convenience runner: the full deterministic OFFLINE pipeline, mirroring the n8n graph's branch decisions
// (Validate Required Fields gate -> Escalation Needed? gate -> standard/escalated response). Used by the
// differential to compute the core's final record per fixture. The escalation tail uses skippedFeishuDelivery
// (env unset) -> recordFeishuSkipped, matching the offline compiled tail.
// ---------------------------------------------------------------------------------------------------------
export function runTriageCore(source, opts = {}) {
  const norm = normalizePayload(source, opts);
  // Validate Required Fields gate (ifElse on isValid).
  if (!norm.isValid) {
    return { branch: 'validation-error', final: buildValidationError(norm), stages: { normalize: norm } };
  }
  const meta = generateTicketMetadata(norm, opts);
  const redacted = redactCustomerPii(meta);
  const classified = classifyTicketCategory(redacted);
  const scored = scoreUrgency(classified);
  const routed = routeOwningTeam(scored);
  const sla = buildSlaPolicy(routed, opts);
  const stages = { normalize: norm, meta, redacted, classified, scored, routed, sla };
  // Escalation Needed? gate (ifElse on escalationRequired).
  if (sla.escalationRequired) {
    const payload = buildEscalationPayload(sla);
    const audit = buildAuditEvent(payload, opts);
    // Offline Feishu tail: card (env unset) -> Feishu Enabled? false -> Record Feishu Skipped.
    const withSkipped = recordFeishuSkipped({ ...audit, feishuDelivery: skippedFeishuDelivery() });
    const final = buildEscalationResponse(withSkipped);
    return { branch: 'escalated', final, stages: { ...stages, payload, audit, withSkipped } };
  }
  const payload = buildStandardPayload(sla);
  const audit = buildAuditEvent(payload, opts);
  const final = buildStandardResponse(audit);
  return { branch: 'standard', final, stages: { ...stages, payload, audit } };
}
