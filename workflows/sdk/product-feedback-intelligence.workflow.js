import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';

// NOTE: The confidence gate + deterministic fallback is implemented inside the
// "Resolve Classification" Code node rather than as a visual ifElse branch. This keeps
// the post-classification path linear (the SDK duplicates the entire downstream chain
// inside every branch), while the eval still asserts classifierSource = stub | fallback.

const runDemoFromUi = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Run Demo Feedback From n8n UI',
    position: [160, 40]
  },
  output: [{}]
});

const buildDemoFeedbackPayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Demo Feedback Payload',
    position: [480, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0]?.json ?? {};
if (Object.keys(input).length > 0) {
  return [{ json: { ...input, manualExecution: true } }];
}
return [{
  json: {
    manualExecution: true,
    feedbackText: 'We are seriously considering cancelling next month - the export keeps failing on Safari and support has been slow to respond.',
    reportedCount: 3,
    source: 'support-reply',
    submittedAt: '2026-05-29T14:00:00.000Z'
  }
}];`
    }
  },
  output: [{
    manualExecution: true,
    feedbackText: 'We are seriously considering cancelling next month...',
    reportedCount: 3
  }]
});

const receiveFeedback = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Receive Feedback Intake',
    position: [160, 420],
    parameters: {
      httpMethod: 'POST',
      path: 'portfolio/product-feedback-intelligence',
      authentication: 'none',
      responseMode: 'responseNode',
      options: {
        allowedOrigins: '*'
      }
    }
  }
});

const normalizeFeedback = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Feedback Payload',
    position: [480, 420],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const source = items[0]?.json ?? {};
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
return [{
  json: {
    feedback: {
      feedbackText,
      reportedCount,
      source: String(body.source ?? body.channel ?? 'unknown').toLowerCase().trim(),
      submittedAt: text(body.submittedAt ?? body.createdAt) || new Date().toISOString()
    },
    validation: {
      requiredFieldsPresent: hasFeedbackKey,
      nonEmpty: feedbackText.length > 0,
      missingFields
    },
    runtime: { entrypoint, classifierMode: (String(body.classifierMode ?? '').toLowerCase().trim() === 'ollama' ? 'ollama' : 'stub') },
    sourcePayloadKeys: Object.keys(body)
  }
}];`
    }
  },
  output: [{
    feedback: { feedbackText: 'Example feedback', reportedCount: 1 },
    validation: { requiredFieldsPresent: true, nonEmpty: true }
  }]
});

const requiredPresent = ifElse({
  version: 2.3,
  config: {
    name: 'Feedback Field Present?',
    position: [800, 420],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'feedback-field-present',
          leftValue: expr('{{ $json.validation.requiredFieldsPresent }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const buildRequiredError = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Required Field Error',
    position: [1120, 640],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
return [{
  json: {
    statusCode: 400,
    runtime: input.runtime,
    response: {
      ok: false,
      error: 'Missing required feedback field',
      missingFields: input.validation.missingFields,
      policyVersion: 'feedback-intel-v0.1.0'
    }
  }
}];`
    }
  }
});

const manualUiRequiredError = ifElse({
  version: 2.3,
  config: {
    name: 'Manual UI Required Error?',
    position: [1440, 640],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'manual-ui-required-error',
          leftValue: expr('{{ $json.runtime.entrypoint === "manual" }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const returnRequiredError = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Return Required Field Error',
    position: [1760, 760],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json.response }}',
      options: { responseCode: '={{ $json.statusCode }}' }
    }
  }
});

const nonEmpty = ifElse({
  version: 2.3,
  config: {
    name: 'Feedback Non-empty?',
    position: [1120, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'feedback-non-empty',
          leftValue: expr('{{ $json.validation.nonEmpty }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const buildEmptyError = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Empty Feedback Error',
    position: [1440, 460],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
return [{
  json: {
    statusCode: 422,
    runtime: input.runtime,
    response: {
      ok: false,
      error: 'Empty feedback text',
      policyVersion: 'feedback-intel-v0.1.0'
    }
  }
}];`
    }
  }
});

const manualUiEmptyError = ifElse({
  version: 2.3,
  config: {
    name: 'Manual UI Empty Error?',
    position: [1760, 460],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'manual-ui-empty-error',
          leftValue: expr('{{ $json.runtime.entrypoint === "manual" }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const returnEmptyError = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Return Empty Feedback Error',
    position: [2080, 580],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json.response }}',
      options: { responseCode: '={{ $json.statusCode }}' }
    }
  }
});

const classifyStub = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Classify Feedback (stub)',
    position: [1440, 160],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
// Deterministic stub standing in for the LLM classifier. In live mode an Ollama HTTP
// node would replace this and return the same { theme, sentiment, confidence } schema.
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
return [{
  json: {
    ...input,
    classification: {
      theme: bestScore > 0 ? bestTheme : 'other',
      sentiment,
      confidence,
      classifierSource: 'stub',
      matchedKeywords: matched.slice(0, 8)
    }
  }
}];`
    }
  }
});

const classifierModeGate = ifElse({
  version: 2.3,
  config: {
    name: 'Classifier Mode = Ollama?',
    position: [1440, 360],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'classifier-mode-ollama',
          leftValue: expr('{{ $json.runtime.classifierMode === "ollama" }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const classifyOllama = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Classify Feedback (Ollama)',
    position: [1760, 480],
    parameters: {
      method: 'POST',
      url: 'http://host.docker.internal:11434/api/chat',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: '={{ ({ model: "llama3.2:3b", stream: false, format: "json", options: { temperature: 0 }, messages: [ { role: "system", content: "You are a product feedback classifier. Reply with JSON only, with keys theme, sentiment, confidence. theme is one of bug, feature_request, usability, performance, pricing, praise, churn_risk, other. sentiment is one of positive, neutral, negative. confidence is a number from 0 to 1." }, { role: "user", content: $json.feedback.feedbackText } ] }) }}',
      options: { timeout: 60000 }
    }
  }
});

const parseOllama = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse Ollama Response',
    position: [2080, 480],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const http = items[0].json;
// The HTTP node replaced the item with Ollama's response; recover the feedback payload
// from the Normalize node and attach only the classification.
const base = $('Normalize Feedback Payload').item.json;
const themes = ['bug', 'feature_request', 'usability', 'performance', 'pricing', 'praise', 'churn_risk', 'other'];
const sentiments = ['positive', 'neutral', 'negative'];
let theme = 'other';
let sentiment = 'neutral';
let confidence = 0;
try {
  const content = http?.message?.content ?? http?.response ?? '';
  const parsed = typeof content === 'string' ? JSON.parse(content) : content;
  const validTheme = themes.includes(parsed.theme);
  theme = validTheme ? parsed.theme : 'other';
  sentiment = sentiments.includes(parsed.sentiment) ? parsed.sentiment : 'neutral';
  const c = Number(parsed.confidence);
  confidence = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5;
  // Schema-invalid theme -> force low confidence so the confidence gate uses the deterministic fallback.
  if (!validTheme) confidence = 0;
} catch (e) {
  confidence = 0;
}
return [{
  json: {
    ...base,
    classification: { theme, sentiment, confidence, classifierSource: 'ollama' }
  }
}];`
    }
  }
});

const resolveClassification = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Resolve Classification (confidence gate + fallback)',
    position: [1760, 160],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const c = input.classification;
const threshold = 0.6;
if (c.confidence >= threshold) {
  return [{ json: { ...input, classification: { ...c, fallbackEngaged: false } } }];
}
// Low confidence (or schema-invalid in live mode) -> deterministic keyword fallback.
const text = input.feedback.feedbackText.toLowerCase();
const negativeWords = ['broken', 'error', 'bug', 'not working', 'slow', 'confusing', 'expensive', 'cancel', 'refund', 'hate', 'worst', 'unusable', 'frustrat', 'problem', 'issue'];
const neg = negativeWords.some((w) => text.includes(w));
return [{
  json: {
    ...input,
    classification: {
      ...c,
      theme: c.theme && c.theme !== 'other' ? c.theme : 'other',
      sentiment: neg ? 'negative' : 'neutral',
      classifierSource: 'fallback',
      fallbackEngaged: true
    }
  }
}];`
    }
  }
});

const deriveUrgency = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Derive Urgency',
    position: [2080, 160],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const theme = input.classification.theme;
const sentiment = input.classification.sentiment;
let urgency = 'normal';
if (theme === 'churn_risk' && sentiment === 'negative') urgency = 'critical';
else if (theme === 'churn_risk') urgency = 'high';
else if (sentiment === 'negative' && (theme === 'bug' || theme === 'performance')) urgency = 'high';
else if (theme === 'praise' || sentiment === 'positive') urgency = 'low';
return [{ json: { ...input, derived: { urgency } } }];`
    }
  }
});

const scorePriority = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Score Priority',
    position: [2400, 160],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const weights = { critical: 10, high: 6, normal: 3, low: 1 };
const w = weights[input.derived.urgency] ?? 3;
const volume = Math.min(input.feedback.reportedCount, 50);
return [{ json: { ...input, derived: { ...input.derived, priorityScore: w * volume } } }];`
    }
  }
});

const redactFeedbackPii = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Redact Feedback PII',
    position: [2720, 160],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const raw = input.feedback.feedbackText;
const emailRe = /[^\\s@]+@[^\\s@]+\\.[^\\s@]+/g;
const emails = raw.match(emailRe) ?? [];
const maskEmail = (e) => { const parts = e.split('@'); const local = parts[0]; const domain = parts[1] ?? ''; return (local ? local[0] + '***' : '***') + '@' + domain; };
let masked = raw;
for (const e of emails) masked = masked.split(e).join(maskEmail(e));
return [{
  json: {
    ...input,
    pii: {
      redactedEmail: emails.length ? maskEmail(emails[0]) : '',
      containedEmail: emails.length > 0,
      safeExcerpt: masked.slice(0, 60)
    }
  }
}];`
    }
  }
});

const buildAuditEvent = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Create Redacted Audit Event',
    position: [3040, 160],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
const seed = input.feedback.feedbackText + '|' + input.feedback.submittedAt;
const feedbackId = 'feedback_' + hash(seed);
return [{
  json: {
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
      createdAt: new Date().toISOString()
    }
  }
}];`
    }
  }
});

const humanReviewGate = ifElse({
  version: 2.3,
  config: {
    name: 'Needs Human Review?',
    position: [3360, 160],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'needs-human-review',
          leftValue: expr('{{ $json.classification.theme === "churn_risk" || $json.derived.urgency === "critical" }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const buildApprovalResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Approval-Gated Response',
    position: [3680, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
return [{
  json: {
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
  }
}];`
    }
  }
});

const buildClassifiedResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Classified Response',
    position: [3680, 280],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
return [{
  json: {
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
  }
}];`
    }
  }
});

const manualUiExecution = ifElse({
  version: 2.3,
  config: {
    name: 'Manual UI Execution?',
    position: [4000, 160],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'manual-ui-execution',
          leftValue: expr('{{ $json.runtime.entrypoint === "manual" }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const showUiExecutionResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Show UI Execution Result',
    position: [4320, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
return [{
  json: {
    ok: true,
    executionMode: 'manual-ui',
    statusCode: input.statusCode,
    response: input.response,
    auditEvent: input.auditEvent ?? null,
    note: 'Terminal result for n8n editor Execute Workflow. Webhook executions use Return Feedback Response instead.'
  }
}];`
    }
  },
  output: [{
    ok: true,
    executionMode: 'manual-ui',
    response: { status: 'awaiting_approval', theme: 'churn_risk' }
  }]
});

const returnFeedbackResponse = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Return Feedback Response',
    position: [4320, 280],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json.response }}',
      options: { responseCode: '={{ $json.statusCode }}' }
    }
  }
});

const overview = sticky(
  '## Product Feedback Intelligence v0.1.0\\nLocal product-feedback API: classifies theme/sentiment/urgency with an LLM-in-the-loop classifier (deterministic stub for CI/eval, env-switchable Ollama for live), applies a confidence gate + deterministic fallback, scores priority, gates churn-risk/critical items for human review, and emits a redacted audit event. Manual trigger runs an editor demo; webhook serves the API. External Feishu alerting is deferred.',
  [runDemoFromUi, buildDemoFeedbackPayload, receiveFeedback, normalizeFeedback, requiredPresent, nonEmpty, classifyStub, resolveClassification, humanReviewGate, manualUiExecution],
  { color: 4 }
);

// Callable as a sub-workflow by the interaction-gateway via Execute Workflow (in-process, no HTTP). Feeds the
// SAME Normalize Feedback Payload pipeline as the webhook, so the webhook contract is unchanged. Passthrough:
// the gateway sends { feedbackText, reportedCount?, source?, ... } directly (no `.body` wrapper, which Normalize
// already tolerates via `source.body ?? source`). When invoked as a sub-workflow, respondToWebhook is a no-op and
// the caller receives the last node's output (the Build*Response object carrying `.response`).
const calledByGateway = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: { name: 'Called By Gateway (Execute Workflow)', position: [160, 760], parameters: { inputSource: 'passthrough' } }
});

export default workflow('product-feedback-intelligence', 'Portfolio - Product Feedback Intelligence API')
  .add(overview)
  .add(runDemoFromUi)
  .to(buildDemoFeedbackPayload)
  .to(normalizeFeedback)
  .to(requiredPresent
    .onTrue(
      nonEmpty
        .onTrue(
          classifierModeGate
            .onTrue(
              classifyOllama
                .to(parseOllama)
                .to(resolveClassification)
            )
            .onFalse(
              classifyStub
                .to(resolveClassification
                  .to(deriveUrgency)
                  .to(scorePriority)
                  .to(redactFeedbackPii)
                  .to(buildAuditEvent)
                  .to(humanReviewGate
                    .onTrue(
                      buildApprovalResponse
                        .to(manualUiExecution
                          .onTrue(showUiExecutionResult)
                          .onFalse(returnFeedbackResponse)
                        )
                    )
                    .onFalse(
                      buildClassifiedResponse
                        .to(manualUiExecution
                          .onTrue(showUiExecutionResult)
                          .onFalse(returnFeedbackResponse)
                        )
                    )
                  )
                )
            )
        )
        .onFalse(
          buildEmptyError
            .to(manualUiEmptyError
              .onTrue(showUiExecutionResult)
              .onFalse(returnEmptyError)
            )
        )
    )
    .onFalse(
      buildRequiredError
        .to(manualUiRequiredError
          .onTrue(showUiExecutionResult)
          .onFalse(returnRequiredError)
        )
    )
  )
  .add(receiveFeedback)
  .to(normalizeFeedback)
  .add(calledByGateway)
  .to(normalizeFeedback);
