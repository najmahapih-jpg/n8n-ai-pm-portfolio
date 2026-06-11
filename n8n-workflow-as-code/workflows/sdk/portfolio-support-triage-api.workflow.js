import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';

const receiveTicket = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Receive Support Ticket',
    position: [200, 420],
    parameters: {
      httpMethod: 'POST',
      path: 'portfolio/support-triage',
      authentication: 'none',
      responseMode: 'responseNode',
      options: {
        allowedOrigins: '*'
      }
    }
  },
  output: [{
    body: {
      customerEmail: 'casey@example.test',
      subject: 'Production checkout failures',
      message: "Customers on our enterprise plan cannot complete checkout. The error started after today's deployment and affects all regions.",
      plan: 'enterprise',
      receivedAt: '2026-05-27T10:00:00-04:00',
      source: 'web',
      customerTier: 'enterprise'
    }
  }]
});

const normalizePayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Payload',
    position: [520, 420],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const raw = items[0]?.json?.body ?? items[0]?.json ?? {};
const normalized = {
  customerEmail: String(raw.customerEmail ?? raw.email ?? '').trim().toLowerCase(),
  subject: String(raw.subject ?? raw.title ?? '').trim(),
  message: String(raw.message ?? raw.description ?? '').trim(),
  plan: String(raw.plan ?? raw.customerTier ?? 'free').trim().toLowerCase(),
  receivedAt: String(raw.receivedAt ?? new Date().toISOString()),
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

return [{
  json: {
    ...normalized,
    isValid: missingFields.length === 0,
    missingFields,
    traceId,
    normalizedAt: new Date().toISOString()
  }
}];`
    }
  },
  output: [{
    customerEmail: 'casey@example.test',
    subject: 'Production checkout failures',
    message: "Customers on our enterprise plan cannot complete checkout. The error started after today's deployment and affects all regions.",
    plan: 'enterprise',
    receivedAt: '2026-05-27T10:00:00-04:00',
    source: 'webhook',
    accountId: '',
    isValid: true,
    missingFields: [],
    traceId: 'trace-1a2b3c4d',
    normalizedAt: '2026-05-27T10:00:01.000Z'
  }]
});

const validateRequiredFields = ifElse({
  version: 2.3,
  config: {
    name: 'Validate Required Fields',
    position: [840, 420],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'payload-is-valid',
          leftValue: expr('{{ $json.isValid }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      }
    }
  }
});

const buildValidationError = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Validation Error',
    position: [1160, 620],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
return [{
  json: {
    statusCode: 400,
    response: {
      ok: false,
      error: 'Missing required fields',
      missingFields: input.missingFields,
      traceId: input.traceId,
      message: 'Provide customerEmail, subject, and message.'
    }
  }
}];`
    }
  },
  output: [{
    statusCode: 400,
    response: {
      ok: false,
      error: 'Missing required fields',
      missingFields: ['message'],
      traceId: 'trace-invalid',
      message: 'Provide customerEmail, subject, and message.'
    }
  }]
});

const returnValidationError = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Return Validation Error',
    position: [1480, 620],
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ $json.response }}'),
      options: {
        responseCode: expr('{{ $json.statusCode }}'),
        responseHeaders: {
          entries: [{ name: 'Content-Type', value: 'application/json' }]
        }
      }
    }
  },
  output: [{
    ok: false,
    error: 'Missing required fields',
    missingFields: ['message']
  }]
});

const generateTicketMetadata = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Generate Ticket Metadata',
    position: [1160, 260],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const seed = [input.customerEmail, input.subject, input.receivedAt].join('|');
let hash = 5381;
for (const char of seed) {
  hash = ((hash << 5) + hash) + char.charCodeAt(0);
}
const ticketId = 'TKT-' + Math.abs(hash >>> 0).toString(36).toUpperCase().padStart(8, '0').slice(0, 8);
return [{
  json: {
    ...input,
    ticketId,
    status: 'triaged',
    policyVersion: 'supportops-triage-v0.3.0-local-feishu',
    generatedAt: new Date().toISOString()
  }
}];`
    }
  },
  output: [{
    ticketId: 'TKT-1A2B3C4D',
    status: 'triaged',
    policyVersion: 'supportops-triage-v0.3.0-local-feishu'
  }]
});

const redactCustomerPii = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Redact Customer PII',
    position: [1480, 260],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const [local, domain] = String(input.customerEmail).split('@');
const redactedEmail = domain ? local.slice(0, 2) + '***@' + domain : 'unknown';
const messagePreview = String(input.message).replace(/\\s+/g, ' ').slice(0, 160);
return [{
  json: {
    ...input,
    redactedEmail,
    messagePreview,
    piiRedacted: true
  }
}];`
    }
  },
  output: [{
    redactedEmail: 'ca***@example.test',
    messagePreview: 'Customers on our enterprise plan cannot complete checkout.',
    piiRedacted: true
  }]
});

const classifyTicketCategory = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Classify Ticket Category',
    position: [1800, 260],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
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
return [{ json: { ...input, category, matchedTerms } }];`
    }
  },
  output: [{
    category: 'incident',
    matchedTerms: ['production', 'cannot complete checkout', 'all regions']
  }]
});

const scoreUrgency = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Score Urgency',
    position: [2120, 260],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
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
return [{ json: { ...input, urgencyScore: score, urgency } }];`
    }
  },
  output: [{
    urgencyScore: 100,
    urgency: 'critical'
  }]
});

const routeOwningTeam = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Route Owning Team',
    position: [2440, 260],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
let routingTeam = 'general-support';
if (input.category === 'incident' || input.urgency === 'critical' || input.urgency === 'urgent') routingTeam = 'platform-support';
else if (input.category === 'billing') routingTeam = 'billing-support';
else if (input.category === 'account') routingTeam = 'account-success';
else if (input.category === 'bug') routingTeam = 'product-engineering';
return [{ json: { ...input, routingTeam } }];`
    }
  },
  output: [{
    routingTeam: 'platform-support'
  }]
});

const buildSlaPolicy = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build SLA Policy',
    position: [2760, 260],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const slaByUrgency = { critical: 1, urgent: 2, high: 8, normal: 24 };
const slaHours = slaByUrgency[input.urgency] ?? 24;
const start = new Date(input.receivedAt);
const due = new Date((Number.isNaN(start.getTime()) ? Date.now() : start.getTime()) + slaHours * 60 * 60 * 1000);
const escalationRequired = (
  (input.plan === 'enterprise' && ['critical', 'urgent'].includes(input.urgency)) ||
  (input.category === 'incident' && input.urgencyScore >= 65)
);
const breachRisk = input.urgency === 'critical' ? 'immediate' : input.urgency === 'urgent' ? 'elevated' : 'standard';
return [{
  json: {
    ...input,
    slaHours,
    dueAt: due.toISOString(),
    breachRisk,
    escalationRequired
  }
}];`
    }
  },
  output: [{
    slaHours: 1,
    dueAt: '2026-05-27T11:00:00.000Z',
    breachRisk: 'immediate',
    escalationRequired: true
  }]
});

const escalationNeeded = ifElse({
  version: 2.3,
  config: {
    name: 'Escalation Needed?',
    position: [3080, 260],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'escalation-required',
          leftValue: expr('{{ $json.escalationRequired }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      }
    }
  }
});

const buildEscalationPayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Escalation Payload',
    position: [3400, 120],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
return [{
  json: {
    ...input,
    handlingPath: 'escalated',
    escalation: {
      required: true,
      target: 'incident-commander',
      channel: 'platform-sev-alerts',
      reason: input.matchedTerms.length > 0 ? input.matchedTerms.join(', ') : input.category,
      priority: input.urgency
    }
  }
}];`
    }
  },
  output: [{
    handlingPath: 'escalated',
    escalation: {
      required: true,
      target: 'incident-commander',
      channel: 'platform-sev-alerts',
      priority: 'critical'
    }
  }]
});

const buildStandardPayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Standard Handling Payload',
    position: [3400, 420],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
return [{
  json: {
    ...input,
    handlingPath: 'standard',
    escalation: {
      required: false,
      target: input.routingTeam,
      channel: input.routingTeam,
      reason: 'SLA queue routing',
      priority: input.urgency
    }
  }
}];`
    }
  },
  output: [{
    handlingPath: 'standard',
    escalation: {
      required: false,
      target: 'billing-support'
    }
  }]
});

const createEscalationAuditEvent = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Create Escalation Audit Event',
    position: [3720, 120],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const auditEventId = 'audit-' + input.ticketId.toLowerCase();
return [{
  json: {
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
      createdAt: new Date().toISOString()
    }
  }
}];`
    }
  },
  output: [{
    auditEventId: 'audit-tkt-1a2b3c4d',
    auditEvent: {
      type: 'support.ticket.triaged',
      routingTeam: 'platform-support',
      escalationRequired: true
    }
  }]
});

const loadFeishuRuntimeConfig = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Load Feishu Runtime Config',
    position: [4040, 120],
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          {
            id: 'feishu-webhook-url',
            name: 'feishuWebhookUrl',
            value: expr('{{ $env.FEISHU_BOT_WEBHOOK_URL || "" }}'),
            type: 'string'
          },
          {
            id: 'feishu-signing-secret',
            name: 'feishuSigningSecret',
            value: expr('{{ $env.FEISHU_BOT_SIGNING_SECRET || "" }}'),
            type: 'string'
          }
        ]
      }
    }
  },
  output: [{
    feishuWebhookUrl: '',
    feishuSigningSecret: ''
  }]
});

const buildFeishuAlertCard = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Feishu Alert Card',
    position: [4360, 120],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const webhookUrl = String(input.feishuWebhookUrl ?? '').trim();
const signingSecret = String(input.feishuSigningSecret ?? '').trim();
const { feishuWebhookUrl, feishuSigningSecret, ...safeInput } = input;
const timestamp = Math.floor(Date.now() / 1000).toString();
let sign = '';
if (signingSecret) {
  const crypto = require('crypto');
  const stringToSign = timestamp + '\\n' + signingSecret;
  sign = crypto.createHmac('sha256', Buffer.from(stringToSign, 'utf8')).update(Buffer.alloc(0)).digest('base64');
}

const severityTemplate = input.urgency === 'critical' ? 'red' : 'orange';
const summary = input.subject + ' - ' + input.messagePreview;
const payload = {
  msg_type: 'interactive',
  card: {
    config: { wide_screen_mode: true },
    header: {
      template: severityTemplate,
      title: {
        tag: 'plain_text',
        content: '[SupportOps] ' + input.urgency.toUpperCase() + ' escalation'
      }
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '**Ticket**: ' + input.ticketId +
            '\\n**Category**: ' + input.category +
            '\\n**Urgency**: ' + input.urgency + ' (' + input.urgencyScore + ')' +
            '\\n**Team**: ' + input.routingTeam +
            '\\n**SLA**: ' + input.slaHours + 'h, due ' + input.dueAt +
            '\\n**Summary**: ' + summary
        }
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: 'traceId=' + input.traceId + ' auditEventId=' + input.auditEventId
          }
        ]
      }
    ]
  }
};
if (signingSecret) {
  payload.timestamp = timestamp;
  payload.sign = sign;
}

return [{
  json: {
    ...safeInput,
    feishuDelivery: {
      configured: webhookUrl.length > 0,
      webhookUrl,
      signed: signingSecret.length > 0,
      status: webhookUrl.length > 0 ? 'ready' : 'skipped',
      reason: webhookUrl.length > 0 ? 'configured' : 'FEISHU_BOT_WEBHOOK_URL is not set',
      payload
    }
  }
}];`
    }
  },
  output: [{
    feishuDelivery: {
      configured: false,
      signed: false,
      status: 'skipped',
      reason: 'FEISHU_BOT_WEBHOOK_URL is not set'
    }
  }]
});

const feishuEnabled = ifElse({
  version: 2.3,
  config: {
    name: 'Feishu Enabled?',
    position: [4680, 120],
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2
        },
        conditions: [{
          id: 'feishu-configured',
          leftValue: expr('{{ $json.feishuDelivery.configured }}'),
          operator: {
            type: 'boolean',
            operation: 'true',
            singleValue: true
          },
          rightValue: true
        }],
        combinator: 'and'
      }
    }
  }
});

const sendFeishuAlert = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Send Feishu Alert',
    position: [5000, 20],
    parameters: {
      method: 'POST',
      url: expr('{{ $json.feishuDelivery.webhookUrl }}'),
      authentication: 'none',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' }
        ]
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ $json.feishuDelivery.payload }}'),
      options: {
        response: {
          response: {
            fullResponse: true,
            neverError: true,
            responseFormat: 'json'
          }
        },
        timeout: 10000
      }
    }
  },
  output: [{
    statusCode: 200,
    body: {
      code: 0,
      msg: 'success'
    }
  }]
});

const recordFeishuSent = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Record Feishu Sent',
    position: [5320, 20],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const source = $('Build Feishu Alert Card').first().json;
const deliveryResponse = items[0]?.json ?? {};
const statusCode = Number(deliveryResponse.statusCode ?? deliveryResponse.code ?? 0);
const ok = statusCode >= 200 && statusCode < 300;
return [{
  json: {
    ...source,
    feishuDelivery: {
      configured: source.feishuDelivery.configured,
      signed: source.feishuDelivery.signed,
      status: ok ? 'sent' : 'failed',
      statusCode,
      responseCode: deliveryResponse.body?.code ?? deliveryResponse.code ?? null,
      responseMessage: deliveryResponse.body?.msg ?? deliveryResponse.msg ?? null
    }
  }
}];`
    }
  },
  output: [{
    feishuDelivery: {
      configured: true,
      status: 'sent',
      statusCode: 200
    }
  }]
});

const recordFeishuSkipped = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Record Feishu Skipped',
    position: [5000, 220],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
return [{
  json: {
    ...input,
    feishuDelivery: {
      configured: false,
      signed: input.feishuDelivery.signed,
      status: 'skipped',
      reason: input.feishuDelivery.reason
    }
  }
}];`
    }
  },
  output: [{
    feishuDelivery: {
      configured: false,
      status: 'skipped'
    }
  }]
});

const buildEscalationResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Escalation Customer Response',
    position: [5640, 120],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
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
return [{ json: { statusCode: 200, response, auditEvent: input.auditEvent } }];`
    }
  },
  output: [{
    statusCode: 200,
    response: {
      ok: true,
      ticketId: 'TKT-1A2B3C4D',
      urgency: 'critical',
      routingTeam: 'platform-support',
      slaHours: 1,
      escalationRequired: true,
      feishuDelivery: {
        configured: false,
        status: 'skipped'
      }
    }
  }]
});

const returnEscalationResponse = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Return Escalation Response',
    position: [5960, 120],
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ $json.response }}'),
      options: {
        responseCode: expr('{{ $json.statusCode }}'),
        responseHeaders: {
          entries: [{ name: 'Content-Type', value: 'application/json' }]
        }
      }
    }
  },
  output: [{
    ok: true,
    ticketId: 'TKT-1A2B3C4D',
    urgency: 'critical',
    routingTeam: 'platform-support'
  }]
});

const createStandardAuditEvent = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Create Standard Audit Event',
    position: [3720, 420],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const auditEventId = 'audit-' + input.ticketId.toLowerCase();
return [{
  json: {
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
      createdAt: new Date().toISOString()
    }
  }
}];`
    }
  },
  output: [{
    auditEventId: 'audit-tkt-standard',
    auditEvent: {
      type: 'support.ticket.triaged',
      routingTeam: 'billing-support',
      escalationRequired: false
    }
  }]
});

const buildStandardResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Standard Customer Response',
    position: [4040, 420],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
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
return [{ json: { statusCode: 200, response, auditEvent: input.auditEvent } }];`
    }
  },
  output: [{
    statusCode: 200,
    response: {
      ok: true,
      ticketId: 'TKT-STANDARD',
      urgency: 'high',
      routingTeam: 'billing-support',
      slaHours: 8,
      escalationRequired: false
    }
  }]
});

const returnStandardResponse = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Return Standard Response',
    position: [4360, 420],
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ $json.response }}'),
      options: {
        responseCode: expr('{{ $json.statusCode }}'),
        responseHeaders: {
          entries: [{ name: 'Content-Type', value: 'application/json' }]
        }
      }
    }
  },
  output: [{
    ok: true,
    ticketId: 'TKT-STANDARD',
    urgency: 'high',
    routingTeam: 'billing-support'
  }]
});

const overview = sticky(
  '## SupportOps Incident Triage v0.3.0-local-feishu\\nEngineering-grade workflow: normalize, validate, classify, score urgency, route team, compute SLA, branch escalation, create audit event, optionally notify Feishu, and respond. Feishu uses local environment variables and never stores webhook secrets in Git.',
  [receiveTicket, normalizePayload, validateRequiredFields, generateTicketMetadata, buildSlaPolicy, escalationNeeded, loadFeishuRuntimeConfig, buildFeishuAlertCard, feishuEnabled],
  { color: 4 }
);

// Callable as a sub-workflow by the interaction-gateway via Execute Workflow (in-process). Feeds the SAME
// Normalize Payload pipeline as the webhook (tolerates passthrough via `source.body ?? source`), so the webhook
// contract is unchanged. respondToWebhook is a no-op in a sub-workflow call — the caller receives the last
// node's output (the Build*Response object carrying `.response`).
const calledByGateway = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: { name: 'Called By Gateway (Execute Workflow)', position: [160, 980], parameters: { inputSource: 'passthrough' } }
});

export default workflow('portfolio-support-triage-api', 'Portfolio - Support Triage API')
  .add(overview)
  .add(receiveTicket)
  .to(normalizePayload)
  .to(validateRequiredFields
    .onTrue(
      generateTicketMetadata
        .to(redactCustomerPii)
        .to(classifyTicketCategory)
        .to(scoreUrgency)
        .to(routeOwningTeam)
        .to(buildSlaPolicy)
        .to(escalationNeeded
          .onTrue(
            buildEscalationPayload
              .to(createEscalationAuditEvent)
              .to(loadFeishuRuntimeConfig)
              .to(buildFeishuAlertCard)
              .to(feishuEnabled
                .onTrue(
                  sendFeishuAlert
                    .to(recordFeishuSent)
                    .to(buildEscalationResponse)
                    .to(returnEscalationResponse)
                )
                .onFalse(
                  recordFeishuSkipped
                    .to(buildEscalationResponse)
                    .to(returnEscalationResponse)
                )
              )
          )
          .onFalse(
            buildStandardPayload
              .to(createStandardAuditEvent)
              .to(buildStandardResponse)
              .to(returnStandardResponse)
          )
        )
    )
    .onFalse(
      buildValidationError
        .to(returnValidationError)
    )
  )
  .add(calledByGateway)
  .to(normalizePayload);
