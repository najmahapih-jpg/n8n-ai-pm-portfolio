// feedback-core.mjs — the product-feedback-intelligence DETERMINISTIC STUB-PATH logic as a PURE single source
// of truth; the deployed n8n Code nodes mirror these. No n8n, no network: assertable in-process by
// test-feedback-workflow.mjs.
//
// SCOPE: this core reproduces the DETERMINISTIC STUB PATH only — the offline, reproducible lane the Layer-2
// suite (verify:static / CI) exercises. That path is the linear Code-node chain:
//   Normalize Feedback Payload -> [Field Present? gate] -> [Non-empty? gate] -> [Classifier Mode = Ollama? -> stub]
//   -> Classify Feedback (stub) -> Resolve Classification (confidence gate + fallback) -> Derive Urgency
//   -> Score Priority -> Redact Feedback PII -> Create Redacted Audit Event -> [Needs Human Review? gate]
//   -> Build Approval-Gated Response | Build Classified Response
// plus the two early error branches: Build Required Field Error (400, no feedback key) and
// Build Empty Feedback Error (422, empty text). The LIVE classifier branch (Classifier Mode = Ollama? -> true:
// Classify Feedback (Ollama) HTTP node + Parse Ollama Response, which calls Ollama over HTTP and references
// $('Normalize Feedback Payload')) is NOT mirrored here — it is not part of the offline gate.
// test-feedback-workflow.mjs executes the COMPILED jsCode of each node above and asserts it is
// byte-behaviour-identical to the functions below over the pin-data fixtures (the differential).
//
// BEHAVIOR-PRESERVING CONTRACT: each function is a verbatim reverse-extract of the corresponding node's body.
// Regex literals use the SINGLE-escaped form (e.g. /[^\s@]+@[^\s@]+\.[^\s@]+/g), which is exactly what the
// compiled node's source evaluates to at runtime (the SDK double-escapes in the .js so the JSON-embedded copy
// single-escapes after JSON.parse). The core mirrors the node, never the other way around.
//
// The POLICY_VERSION below MUST match the literal 'feedback-intel-v0.1.0' baked into the compiled response/error
// nodes; if a future recompile bumps it, the differential will fail loudly until the core is re-synced (the
// intended guard).
export const POLICY_VERSION = 'feedback-intel-v0.1.0';

// ---------------------------------------------------------------------------------------------------------
// (1) normalizeFeedback — mirror of the 'Normalize Feedback Payload' Code node. The node defaults
// feedback.submittedAt to new Date().toISOString() ONLY when the payload omits submittedAt/createdAt; that is
// the single nondeterminism in the deterministic chain. The differential injects the SAME instant into both
// sides (via opts.now) so the records — and the submittedAt-derived auditEventId/feedbackId — compare
// byte-identical. classifierMode is the finding-#5 field: any value other than the literal 'ollama' (incl.
// garbage, empty, or absent) defaults to 'stub'.
// ---------------------------------------------------------------------------------------------------------
export function normalizeFeedback(source, opts = {}) {
  source = source ?? {};
  const body = source.body ?? source;
  const entrypoint = source.manualExecution === true || body.manualExecution === true ? 'manual' : 'webhook';
  const text = (v) => String(v ?? '').trim();
  const number = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const aliasKeys = ['feedbackText', 'text', 'message', 'comment'];
  const hasFeedbackKey = aliasKeys.some((k) => Object.prototype.hasOwnProperty.call(body, k));
  const feedbackText = text(body.feedbackText ?? body.text ?? body.message ?? body.comment);
  const reportedCountRaw = number(body.reportedCount ?? body.count);
  const reportedCount = reportedCountRaw && reportedCountRaw > 0 ? Math.floor(reportedCountRaw) : 1;
  const missingFields = [];
  if (!hasFeedbackKey) missingFields.push('feedbackText');
  // The node uses new Date().toISOString() when submittedAt/createdAt are both absent; the core takes that
  // instant via opts.now so the differential can pin both sides. When opts.now is absent it falls back to
  // wall-clock exactly like the node.
  const nowIso = opts.now != null ? String(opts.now) : new Date().toISOString();
  return {
    feedback: {
      feedbackText,
      reportedCount,
      source: String(body.source ?? body.channel ?? 'unknown').toLowerCase().trim(),
      submittedAt: text(body.submittedAt ?? body.createdAt) || nowIso
    },
    validation: {
      requiredFieldsPresent: hasFeedbackKey,
      nonEmpty: feedbackText.length > 0,
      missingFields
    },
    runtime: { entrypoint, classifierMode: (String(body.classifierMode ?? '').toLowerCase().trim() === 'ollama' ? 'ollama' : 'stub') },
    sourcePayloadKeys: Object.keys(body)
  };
}

// ---------------------------------------------------------------------------------------------------------
// (2) classifyStub — mirror of 'Classify Feedback (stub)'. Deterministic keyword classifier standing in for
// the LLM: theme by best keyword score, sentiment by pos/neg word balance (praise forces positive), confidence
// by best score band. classifierSource:'stub'.
// ---------------------------------------------------------------------------------------------------------
export function classifyStub(input) {
  const text = input.feedback.feedbackText.toLowerCase();
  const themeKeywords = {
    bug: ['broken', 'crash', 'error', 'bug', 'does nothing', 'not working', 'fails', 'failing', 'spinning', 'blank screen', 'glitch'],
    performance: ['slow', 'lag', 'laggy', 'takes forever', '30 seconds', 'timeout', 'timing out', 'unusable', 'freezes', 'slow to load'],
    pricing: ['expensive', 'too expensive', 'pricing', 'overpriced', 'costs too much', 'cost too much'],
    usability: ['confusing', 'cannot find', 'hard to use', 'not intuitive', 'unclear', 'where is', 'difficult to'],
    feature_request: ['please add', 'add support', 'would be great', 'feature request', 'wish there was', 'can you add', 'add csv', 'export to csv'],
    churn_risk: ['cancel', 'cancelling', 'canceling', 'switching to', 'switch to', 'refund', 'downgrade', 'leaving', 'competitor'],
    praise: ['love', 'great', 'awesome', 'amazing', 'fantastic', 'excellent', 'works great', 'so fast', 'thank you', 'well done']
  };
  const positiveWords = ['love', 'great', 'awesome', 'amazing', 'fantastic', 'excellent', 'thank', 'wonderful', 'works great', 'so fast'];
  const negativeWords = ['broken', 'crash', 'error', 'bug', 'not working', 'fails', 'slow', 'confusing', 'expensive', 'cancel', 'refund', 'hate', 'worst', 'terrible', 'unusable', 'frustrat'];
  const matched = [];
  const scores = {};
  for (const [theme, words] of Object.entries(themeKeywords)) {
    let s = 0;
    for (const w of words) { if (text.includes(w)) { s += 1; matched.push(theme + ':' + w); } }
    scores[theme] = s;
  }
  let bestTheme = 'other';
  let bestScore = 0;
  for (const [theme, s] of Object.entries(scores)) { if (s > bestScore) { bestScore = s; bestTheme = theme; } }
  const posHits = positiveWords.filter((w) => text.includes(w)).length;
  const negHits = negativeWords.filter((w) => text.includes(w)).length;
  let sentiment = 'neutral';
  if (negHits > posHits) sentiment = 'negative';
  else if (posHits > negHits) sentiment = 'positive';
  if (bestScore > 0 && bestTheme === 'praise') sentiment = 'positive';
  const confidence = bestScore >= 2 ? 0.9 : bestScore === 1 ? 0.65 : 0.3;
  return {
    ...input,
    classification: {
      theme: bestScore > 0 ? bestTheme : 'other',
      sentiment,
      confidence,
      classifierSource: 'stub',
      matchedKeywords: matched.slice(0, 8)
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (3) resolveClassification — mirror of 'Resolve Classification (confidence gate + fallback)'. confidence >=
// 0.6 keeps the classifier verdict (fallbackEngaged:false); below threshold (or schema-invalid in live mode)
// engages the deterministic keyword fallback (classifierSource:'fallback').
// ---------------------------------------------------------------------------------------------------------
export function resolveClassification(input) {
  const c = input.classification;
  const threshold = 0.6;
  if (c.confidence >= threshold) {
    return { ...input, classification: { ...c, fallbackEngaged: false } };
  }
  // Low confidence (or schema-invalid in live mode) -> deterministic keyword fallback.
  const text = input.feedback.feedbackText.toLowerCase();
  const negativeWords = ['broken', 'error', 'bug', 'not working', 'slow', 'confusing', 'expensive', 'cancel', 'refund', 'hate', 'worst', 'unusable', 'frustrat', 'problem', 'issue'];
  const neg = negativeWords.some((w) => text.includes(w));
  return {
    ...input,
    classification: {
      ...c,
      theme: c.theme && c.theme !== 'other' ? c.theme : 'other',
      sentiment: neg ? 'negative' : 'neutral',
      classifierSource: 'fallback',
      fallbackEngaged: true
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (4) deriveUrgency — mirror of 'Derive Urgency'. churn_risk+negative=critical, churn_risk=high,
// negative bug/performance=high, praise/positive=low, else normal.
// ---------------------------------------------------------------------------------------------------------
export function deriveUrgency(input) {
  const theme = input.classification.theme;
  const sentiment = input.classification.sentiment;
  let urgency = 'normal';
  if (theme === 'churn_risk' && sentiment === 'negative') urgency = 'critical';
  else if (theme === 'churn_risk') urgency = 'high';
  else if (sentiment === 'negative' && (theme === 'bug' || theme === 'performance')) urgency = 'high';
  else if (theme === 'praise' || sentiment === 'positive') urgency = 'low';
  return { ...input, derived: { urgency } };
}

// ---------------------------------------------------------------------------------------------------------
// (5) scorePriority — mirror of 'Score Priority'. urgency weight * volume (reportedCount clamped to 50).
// ---------------------------------------------------------------------------------------------------------
export function scorePriority(input) {
  const weights = { critical: 10, high: 6, normal: 3, low: 1 };
  const w = weights[input.derived.urgency] ?? 3;
  const volume = Math.min(input.feedback.reportedCount, 50);
  return { ...input, derived: { ...input.derived, priorityScore: w * volume } };
}

// ---------------------------------------------------------------------------------------------------------
// (6) redactFeedbackPii — mirror of 'Redact Feedback PII'. Masks email local-parts and emits a 60-char safe
// excerpt of the masked text. The emailRe here is the SINGLE-escaped runtime form of the node's source.
// ---------------------------------------------------------------------------------------------------------
export function redactFeedbackPii(input) {
  const raw = input.feedback.feedbackText;
  const emailRe = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
  const emails = raw.match(emailRe) ?? [];
  const maskEmail = (e) => { const parts = e.split('@'); const local = parts[0]; const domain = parts[1] ?? ''; return (local ? local[0] + '***' : '***') + '@' + domain; };
  let masked = raw;
  for (const e of emails) masked = masked.split(e).join(maskEmail(e));
  return {
    ...input,
    pii: {
      redactedEmail: emails.length ? maskEmail(emails[0]) : '',
      containedEmail: emails.length > 0,
      safeExcerpt: masked.slice(0, 60)
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (7) buildAuditEvent — mirror of 'Create Redacted Audit Event'. Carries only ids/verdicts/scores/counts +
// the masked email + the safe excerpt — never the raw feedbackText. feedbackId/auditEventId/idempotencyKey are
// FNV-1a hashes seeded by feedbackText|submittedAt. createdAt is the node's new Date().toISOString(); the
// differential injects the SAME instant via opts.now into both sides.
// ---------------------------------------------------------------------------------------------------------
export function buildAuditEvent(input, opts = {}) {
  function hash(value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  const seed = input.feedback.feedbackText + '|' + input.feedback.submittedAt;
  const feedbackId = 'feedback_' + hash(seed);
  const createdAt = opts.now != null ? String(opts.now) : new Date().toISOString();
  return {
    ...input,
    identity: {
      feedbackId,
      idempotencyKey: hash(seed + '|' + input.feedback.submittedAt.slice(0, 10))
    },
    auditEvent: {
      auditEventId: 'audit_' + hash(seed),
      feedbackId,
      source: input.feedback.source,
      theme: input.classification.theme,
      sentiment: input.classification.sentiment,
      urgency: input.derived.urgency,
      priorityScore: input.derived.priorityScore,
      classifierSource: input.classification.classifierSource,
      confidence: input.classification.confidence,
      reportedCount: input.feedback.reportedCount,
      redactedEmail: input.pii.redactedEmail,
      safeExcerpt: input.pii.safeExcerpt,
      createdAt
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (8) buildApprovalResponse — mirror of 'Build Approval-Gated Response' (the Needs-Human-Review TRUE branch:
// churn_risk theme OR critical urgency). status 'awaiting_approval', needsHumanReview:true.
// ---------------------------------------------------------------------------------------------------------
export function buildApprovalResponse(input) {
  return {
    statusCode: 200,
    runtime: input.runtime,
    response: {
      ok: true,
      status: 'awaiting_approval',
      needsHumanReview: true,
      feedbackId: input.identity.feedbackId,
      theme: input.classification.theme,
      sentiment: input.classification.sentiment,
      urgency: input.derived.urgency,
      priorityScore: input.derived.priorityScore,
      confidence: input.classification.confidence,
      classifierSource: input.classification.classifierSource,
      redactedEmail: input.pii.redactedEmail,
      auditEventId: input.auditEvent.auditEventId,
      notification: { status: 'pending_review', reason: 'Churn-risk or critical item gated for human approval' },
      policyVersion: 'feedback-intel-v0.1.0'
    },
    auditEvent: input.auditEvent
  };
}

// ---------------------------------------------------------------------------------------------------------
// (9) buildClassifiedResponse — mirror of 'Build Classified Response' (the Needs-Human-Review FALSE branch).
// status 'classified', needsHumanReview:false.
// ---------------------------------------------------------------------------------------------------------
export function buildClassifiedResponse(input) {
  return {
    statusCode: 200,
    runtime: input.runtime,
    response: {
      ok: true,
      status: 'classified',
      needsHumanReview: false,
      feedbackId: input.identity.feedbackId,
      theme: input.classification.theme,
      sentiment: input.classification.sentiment,
      urgency: input.derived.urgency,
      priorityScore: input.derived.priorityScore,
      confidence: input.classification.confidence,
      classifierSource: input.classification.classifierSource,
      redactedEmail: input.pii.redactedEmail,
      auditEventId: input.auditEvent.auditEventId,
      notification: { status: 'skipped', reason: 'No external notification adapter configured in v0.1' },
      policyVersion: 'feedback-intel-v0.1.0'
    },
    auditEvent: input.auditEvent
  };
}

// ---------------------------------------------------------------------------------------------------------
// (10) buildRequiredError — mirror of 'Build Required Field Error' (the 400 branch when no feedback key).
// ---------------------------------------------------------------------------------------------------------
export function buildRequiredError(input) {
  return {
    statusCode: 400,
    runtime: input.runtime,
    response: {
      ok: false,
      error: 'Missing required feedback field',
      missingFields: input.validation.missingFields,
      policyVersion: 'feedback-intel-v0.1.0'
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (11) buildEmptyError — mirror of 'Build Empty Feedback Error' (the 422 branch when the feedback key is
// present but the text is empty/whitespace).
// ---------------------------------------------------------------------------------------------------------
export function buildEmptyError(input) {
  return {
    statusCode: 422,
    runtime: input.runtime,
    response: {
      ok: false,
      error: 'Empty feedback text',
      policyVersion: 'feedback-intel-v0.1.0'
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// needsHumanReview — the 'Needs Human Review?' ifElse predicate, factored so the differential and runStubFeedback
// make the identical branch decision (churn_risk theme OR critical urgency).
// ---------------------------------------------------------------------------------------------------------
export function needsHumanReview(input) {
  return input.classification.theme === 'churn_risk' || input.derived.urgency === 'critical';
}

// ---------------------------------------------------------------------------------------------------------
// runStubFeedback — convenience composition of the full deterministic stub pipeline + the two early error
// branches, exactly as n8n routes (Field Present? -> Non-empty? -> stub classify -> ... -> Needs Human Review?).
// Threads opts.now into the two timestamp-bearing stages (normalize submittedAt fallback + audit createdAt) so a
// full run is reproducible end-to-end. Returns the Build*Response (200) or the 400/422 error record.
// This is the single entry point the differential and any future direct core test reuse.
// ---------------------------------------------------------------------------------------------------------
export function runStubFeedback(source, opts = {}) {
  const normalized = normalizeFeedback(source, opts);
  if (!normalized.validation.requiredFieldsPresent) {
    return { record: buildRequiredError(normalized), normalized, branch: 'required-error' };
  }
  if (!normalized.validation.nonEmpty) {
    return { record: buildEmptyError(normalized), normalized, branch: 'empty-error' };
  }
  const afterClassify = classifyStub(normalized);
  const afterResolve = resolveClassification(afterClassify);
  const afterUrgency = deriveUrgency(afterResolve);
  const afterPriority = scorePriority(afterUrgency);
  const afterPii = redactFeedbackPii(afterPriority);
  const afterAudit = buildAuditEvent(afterPii, opts);
  const hitl = needsHumanReview(afterAudit);
  const record = hitl ? buildApprovalResponse(afterAudit) : buildClassifiedResponse(afterAudit);
  return {
    record,
    normalized,
    branch: hitl ? 'approval' : 'classified',
    needsHumanReview: hitl,
    classification: afterResolve.classification,
    derived: afterPriority.derived,
    pii: afterPii.pii,
    identity: afterAudit.identity,
    auditEvent: afterAudit.auditEvent
  };
}
