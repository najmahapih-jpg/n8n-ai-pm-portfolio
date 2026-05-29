import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';

const runDemoFromUi = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Run Demo Lead From n8n UI',
    position: [160, 40]
  },
  output: [{}]
});

const buildDemoLeadPayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Demo Lead Payload',
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
    email: 'buyer@finops.example',
    fullName: 'Avery Chen',
    title: 'VP Platform Operations',
    companyName: 'FinOps Cloud',
    companyDomain: 'finops.example',
    source: 'referral',
    industry: 'fintech',
    country: 'us',
    employeeCount: 2500,
    annualRevenue: 420000000,
    requestedProduct: 'Enterprise AI Workflow',
    message: 'We need a demo, pricing, implementation plan, and security review for a migration project. The buying committee wants an urgent shortlist this week.',
    intentSignals: ['security review', 'migration'],
    plan: 'enterprise',
    receivedAt: '2026-05-29T14:00:00.000Z'
  }
}];`
    }
  },
  output: [{
    manualExecution: true,
    email: 'buyer@finops.example',
    companyName: 'FinOps Cloud'
  }]
});

const receiveLead = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Receive Lead Intake',
    position: [160, 420],
    parameters: {
      httpMethod: 'POST',
      path: 'portfolio/lead-intelligence',
      authentication: 'none',
      responseMode: 'responseNode',
      options: {
        allowedOrigins: '*'
      }
    }
  }
});

const normalizeLead = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Lead Payload',
    position: [480, 420],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const source = items[0]?.json ?? {};
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

return [{
  json: {
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
      receivedAt: text(body.receivedAt) || new Date().toISOString()
    },
    validation: {
      requiredFieldsPresent: missingFields.length === 0,
      missingFields
    },
    runtime: {
      entrypoint
    },
    sourcePayloadKeys: Object.keys(body)
  }
}];`
    }
  },
  output: [{
    lead: {
      email: 'buyer@example.test',
      companyName: 'Example Co'
    },
    validation: {
      requiredFieldsPresent: true
    }
  }]
});

const validateRequiredFields = ifElse({
  version: 2.3,
  config: {
    name: 'Required Fields Present?',
    position: [800, 420],
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2
        },
        conditions: [{
          id: 'required-fields-present',
          leftValue: expr('{{ $json.validation.requiredFieldsPresent }}'),
          operator: {
            type: 'boolean',
            operation: 'true',
            singleValue: true
          },
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
      error: 'Missing required lead fields',
      missingFields: input.validation.missingFields,
      policyVersion: 'lead-intel-v0.1.0'
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
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2
        },
        conditions: [{
          id: 'manual-ui-required-error',
          leftValue: expr('{{ $json.runtime.entrypoint === "manual" }}'),
          operator: {
            type: 'boolean',
            operation: 'true',
            singleValue: true
          },
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
      options: {
        responseCode: '={{ $json.statusCode }}'
      }
    }
  }
});

const validateEmailSyntax = ifElse({
  version: 2.3,
  config: {
    name: 'Email Syntax Valid?',
    position: [1120, 300],
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2
        },
        conditions: [{
          id: 'email-syntax-valid',
          leftValue: expr('{{ /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test($json.lead.email) }}'),
          operator: {
            type: 'boolean',
            operation: 'true',
            singleValue: true
          },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const buildEmailError = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Email Syntax Error',
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
      error: 'Invalid email syntax',
      email: input.lead.email,
      policyVersion: 'lead-intel-v0.1.0'
    }
  }
}];`
    }
  }
});

const manualUiEmailError = ifElse({
  version: 2.3,
  config: {
    name: 'Manual UI Email Error?',
    position: [1760, 460],
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2
        },
        conditions: [{
          id: 'manual-ui-email-error',
          leftValue: expr('{{ $json.runtime.entrypoint === "manual" }}'),
          operator: {
            type: 'boolean',
            operation: 'true',
            singleValue: true
          },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const returnEmailError = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Return Email Syntax Error',
    position: [2080, 580],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json.response }}',
      options: {
        responseCode: '={{ $json.statusCode }}'
      }
    }
  }
});

const generateLeadIdentity = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Generate Lead Identity',
    position: [1440, 160],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
const identitySeed = [input.lead.email, input.lead.companyDomain].join('|');
return [{
  json: {
    ...input,
    identity: {
      leadId: 'lead_' + hash(identitySeed),
      emailHash: hash(input.lead.email),
      companyKey: hash(input.lead.companyDomain || input.lead.companyName.toLowerCase()),
      idempotencyKey: hash(identitySeed + '|' + input.lead.receivedAt.slice(0, 10))
    }
  }
}];`
    }
  }
});

const redactLeadPii = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Redact Lead PII',
    position: [1760, 160],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const email = input.lead.email;
const [localPart, domain] = email.split('@');
const redactedLocal = localPart ? localPart[0] + '***' : '***';
return [{
  json: {
    ...input,
    pii: {
      redactedEmail: redactedLocal + '@' + domain,
      redactedName: input.lead.fullName ? input.lead.fullName[0] + '***' : ''
    }
  }
}];`
    }
  }
});

const checkDuplicateCandidate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Check Duplicate Candidate',
    position: [2080, 160],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const domain = input.lead.companyDomain;
const duplicateDomains = new Set(['acme.test', 'duplicate.example']);
const duplicateByPayload = Boolean(input.lead.existingLeadId);
const duplicateByDomain = duplicateDomains.has(domain);
return [{
  json: {
    ...input,
    dedupe: {
      duplicate: duplicateByPayload || duplicateByDomain,
      reason: duplicateByPayload ? 'existingLeadId supplied' : duplicateByDomain ? 'domain recently processed' : 'no duplicate signals',
      matchedLeadId: input.lead.existingLeadId || (duplicateByDomain ? 'lead_existing_' + input.identity.companyKey : '')
    }
  }
}];`
    }
  }
});

const duplicateLead = ifElse({
  version: 2.3,
  config: {
    name: 'Duplicate Lead?',
    position: [2400, 160],
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2
        },
        conditions: [{
          id: 'duplicate-lead',
          leftValue: expr('{{ $json.dedupe.duplicate }}'),
          operator: {
            type: 'boolean',
            operation: 'true',
            singleValue: true
          },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const buildDuplicateResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Duplicate Lead Response',
    position: [2720, 360],
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
      duplicate: true,
      leadId: input.identity.leadId,
      matchedLeadId: input.dedupe.matchedLeadId,
      reason: input.dedupe.reason,
      action: 'attach_to_existing_record',
      policyVersion: 'lead-intel-v0.1.0'
    }
  }
}];`
    }
  }
});

const manualUiDuplicateResponse = ifElse({
  version: 2.3,
  config: {
    name: 'Manual UI Duplicate Response?',
    position: [3040, 360],
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2
        },
        conditions: [{
          id: 'manual-ui-duplicate-response',
          leftValue: expr('{{ $json.runtime.entrypoint === "manual" }}'),
          operator: {
            type: 'boolean',
            operation: 'true',
            singleValue: true
          },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const returnDuplicateResponse = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Return Duplicate Lead Response',
    position: [3360, 480],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json.response }}',
      options: {
        responseCode: '={{ $json.statusCode }}'
      }
    }
  }
});

const mockCompanyEnrichment = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Mock Company Enrichment',
    position: [2720, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
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
return [{
  json: {
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
  }
}];`
    }
  }
});

const mockIntentEnrichment = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Mock Intent Enrichment',
    position: [3040, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
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
return [{
  json: {
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
  }
}];`
    }
  }
});

const aggregateEvidence = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Aggregate Scoring Evidence',
    position: [3360, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
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
return [{
  json: {
    ...input,
    evidence
  }
}];`
    }
  }
});

const calculateIcpFitScore = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Calculate ICP Fit Score',
    position: [3680, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
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
return [{ json: { ...input, scoring: { icpFitScore: score } } }];`
    }
  }
});

const calculateIntentScore = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Calculate Intent Score',
    position: [4000, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const intent = input.enrichment.intent;
let score = 30 + intent.keywordScore + intent.sourceScore;
if (input.lead.requestedProduct) score += 8;
if (input.lead.message.length > 80) score += 6;
score = Math.max(0, Math.min(100, score));
return [{ json: { ...input, scoring: { ...input.scoring, intentScore: score } } }];`
    }
  }
});

const calculatePriorityScore = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Calculate Priority Score',
    position: [4320, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const icp = input.scoring.icpFitScore;
const intent = input.scoring.intentScore;
let score = Math.round((icp * 0.58) + (intent * 0.42));
if (input.enrichment.company.competitor) score = Math.min(score, 25);
if (input.lead.manualGrade) score = Math.max(score, 85);
score = Math.max(0, Math.min(100, score));
return [{ json: { ...input, scoring: { ...input.scoring, priorityScore: score } } }];`
    }
  }
});

const assignLeadGrade = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Assign Lead Grade',
    position: [4640, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
let grade = 'D';
const score = input.scoring.priorityScore;
if (score >= 80) grade = 'A';
else if (score >= 62) grade = 'B';
else if (score >= 40) grade = 'C';
if (['A', 'B', 'C', 'D'].includes(input.lead.manualGrade)) {
  grade = input.lead.manualGrade;
}
return [{
  json: {
    ...input,
    scoring: {
      ...input.scoring,
      grade,
      manuallyOverridden: ['A', 'B', 'C', 'D'].includes(input.lead.manualGrade)
    }
  }
}];`
    }
  }
});

const routeSalesOwner = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Route Sales Owner',
    position: [4960, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
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
return [{ json: { ...input, route } }];`
    }
  }
});

const buildFollowUpPolicy = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Follow-up Policy',
    position: [5280, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const hoursByGrade = { A: 2, B: 8, C: 48, D: 168 };
const followUpSlaHours = hoursByGrade[input.scoring.grade] ?? 168;
const dueAt = new Date(Date.now() + followUpSlaHours * 60 * 60 * 1000).toISOString();
return [{
  json: {
    ...input,
    followUp: {
      slaHours: followUpSlaHours,
      dueAt,
      hotLead: input.scoring.grade === 'A',
      playbook: input.scoring.grade === 'A' ? 'same-day executive AE follow-up' : input.scoring.grade === 'B' ? 'commercial AE follow-up' : input.scoring.grade === 'C' ? 'SDR qualification' : 'nurture sequence'
    }
  }
}];`
    }
  }
});

const hotLead = ifElse({
  version: 2.3,
  config: {
    name: 'Hot Lead?',
    position: [5600, 40],
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2
        },
        conditions: [{
          id: 'hot-lead',
          leftValue: expr('{{ $json.followUp.hotLead }}'),
          operator: {
            type: 'boolean',
            operation: 'true',
            singleValue: true
          },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const buildHotLeadNotification = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Hot Lead Notification',
    position: [5920, -120],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
return [{
  json: {
    ...input,
    notification: {
      channel: 'sales-hot-leads',
      status: 'ready',
      title: 'Hot lead: ' + input.lead.companyName,
      summary: input.lead.companyName + ' scored ' + input.scoring.priorityScore + ' (' + input.scoring.grade + ') and routes to ' + input.route.ownerQueue,
      evidence: input.evidence.slice(0, 8)
    }
  }
}];`
    }
  }
});

const recordNotificationSkipped = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Record Notification Skipped',
    position: [6240, -120],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
return [{
  json: {
    ...input,
    notification: {
      ...(input.notification ?? {}),
      status: 'skipped',
      reason: 'No external notification adapter configured in v0.1'
    }
  }
}];`
    }
  }
});

const buildCrmPayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build CRM-ready Payload',
    position: [6560, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
return [{
  json: {
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
  }
}];`
    }
  }
});

const createAuditEvent = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Create Redacted Audit Event',
    position: [6880, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
return [{
  json: {
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
      createdAt: new Date().toISOString()
    }
  }
}];`
    }
  }
});

const buildLeadResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Lead Intelligence Response',
    position: [7200, 40],
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
  }
}];`
    }
  },
  output: [{
    statusCode: 200,
    response: {
      ok: true,
      grade: 'A',
      priorityScore: 88,
      notification: {
        status: 'skipped'
      }
    }
  }]
});

const manualUiExecution = ifElse({
  version: 2.3,
  config: {
    name: 'Manual UI Execution?',
    position: [7520, 40],
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2
        },
        conditions: [{
          id: 'manual-ui-execution',
          leftValue: expr('{{ $json.runtime.entrypoint === "manual" }}'),
          operator: {
            type: 'boolean',
            operation: 'true',
            singleValue: true
          },
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
    position: [7840, -120],
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
    auditEvent: input.auditEvent,
    note: 'This node is the terminal result for n8n editor Execute Workflow. Webhook executions use Return Lead Intelligence Response instead.'
  }
}];`
    }
  },
  output: [{
    ok: true,
    executionMode: 'manual-ui',
    response: {
      grade: 'A',
      route: {
        ownerQueue: 'enterprise-ae'
      }
    }
  }]
});

const returnLeadResponse = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Return Lead Intelligence Response',
    position: [7840, 160],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json.response }}',
      options: {
        responseCode: '={{ $json.statusCode }}'
      }
    }
  }
});

const overview = sticky(
  '## Lead Intelligence v0.1.1\\nLocal B2B lead scoring workflow: supports n8n editor Execute Workflow through a manual demo trigger, plus webhook intake for API calls. It normalizes, validates, dedupes, enriches with deterministic local rules, scores ICP and intent, routes owner, builds CRM-ready payload, creates a redacted audit event, and responds. External CRM and Feishu adapters are intentionally deferred.',
  [runDemoFromUi, buildDemoLeadPayload, receiveLead, normalizeLead, validateRequiredFields, validateEmailSyntax, duplicateLead, hotLead, manualUiRequiredError, manualUiEmailError, manualUiDuplicateResponse, manualUiExecution],
  { color: 4 }
);

export default workflow('lead-intelligence', 'Portfolio - Lead Intelligence API')
  .add(overview)
  .add(runDemoFromUi)
  .to(buildDemoLeadPayload)
  .to(normalizeLead)
  .to(validateRequiredFields
    .onTrue(
      validateEmailSyntax
        .onTrue(
          generateLeadIdentity
            .to(redactLeadPii)
            .to(checkDuplicateCandidate)
            .to(duplicateLead
              .onTrue(
              buildDuplicateResponse
                  .to(manualUiDuplicateResponse
                    .onTrue(
                      showUiExecutionResult
                    )
                    .onFalse(
                      returnDuplicateResponse
                    )
                  )
              )
              .onFalse(
                mockCompanyEnrichment
                  .to(mockIntentEnrichment)
                  .to(aggregateEvidence)
                  .to(calculateIcpFitScore)
                  .to(calculateIntentScore)
                  .to(calculatePriorityScore)
                  .to(assignLeadGrade)
                  .to(routeSalesOwner)
                  .to(buildFollowUpPolicy)
                  .to(hotLead
                    .onTrue(
                      buildHotLeadNotification
                        .to(recordNotificationSkipped)
                        .to(buildCrmPayload)
                        .to(createAuditEvent)
                        .to(buildLeadResponse)
                        .to(manualUiExecution
                          .onTrue(
                            showUiExecutionResult
                          )
                          .onFalse(
                            returnLeadResponse
                          )
                        )
                    )
                    .onFalse(
                      buildCrmPayload
                        .to(createAuditEvent)
                        .to(buildLeadResponse)
                        .to(manualUiExecution
                          .onTrue(
                            showUiExecutionResult
                          )
                          .onFalse(
                            returnLeadResponse
                          )
                        )
                    )
                  )
              )
            )
        )
        .onFalse(
          buildEmailError
            .to(manualUiEmailError
              .onTrue(
                showUiExecutionResult
              )
              .onFalse(
                returnEmailError
              )
            )
        )
    )
    .onFalse(
      buildRequiredError
        .to(manualUiRequiredError
          .onTrue(
            showUiExecutionResult
          )
          .onFalse(
            returnRequiredError
          )
        )
    )
  )
  .add(receiveLead)
  .to(normalizeLead);
