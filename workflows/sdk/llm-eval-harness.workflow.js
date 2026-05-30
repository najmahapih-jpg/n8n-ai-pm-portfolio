import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';

// LLM Eval Harness — walking skeleton (v0.1.0).
//
// Implements the minimal vertical slice of the harness: a webhook receives an eval-run
// request carrying inline golden cases, each case is run against a deterministic STUB
// subject-under-test, scored with the proven 5-type deterministic assertion taxonomy
// (schema / range / format / absence / masking), graded by a deterministic STUB judge
// (1..5 on groundedness / relevance / helpfulness / safety), then aggregated (pass-rate +
// per-rubric mean) with judgeTrust:"high" (stub) and emitted with a redacted audit event.
//
// Deferred (see README "Current Status" + TODOs in-node): live model fan-out (Ollama/cloud),
// mode:"workflow" calling product-feedback, regression-vs-previous-run, human-labeled
// calibration slice. The whole skeleton runs offline/deterministically so the Layer-2 suite
// stays reproducible — exactly mirroring product-feedback's stub-default discipline.
//
// As in the sibling, the validation gate is a visual ifElse (missing golden -> 400), but the
// post-validation scoring path is kept LINEAR inside a single chain because the SDK duplicates
// the entire downstream chain inside every branch.

const runDemoFromUi = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Run Demo Eval From n8n UI',
    position: [160, 40]
  },
  output: [{}]
});

const buildDemoEvalPayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Demo Eval Payload',
    position: [480, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0]?.json ?? {};
if (Object.keys(input).length > 0) {
  return [{ json: { ...input, manualExecution: true } }];
}
// Default demo run: one PASS case (echo stub satisfies expected) and one FAIL case
// (expected != actual) so the editor demo exercises both branches of the aggregate.
return [{
  json: {
    manualExecution: true,
    runId: 'demo-run',
    golden: [
      { id: 'echo-pass', input: 'ping', expected: 'ping', assertions: { contains: 'ping', maxLength: 64 } },
      { id: 'echo-fail', input: 'ping', expected: 'pong', assertions: { contains: 'pong', maxLength: 64 } }
    ]
  }
}];`
    }
  },
  output: [{
    manualExecution: true,
    runId: 'demo-run',
    golden: [{ id: 'echo-pass', input: 'ping', expected: 'ping' }]
  }]
});

const receiveEvalRun = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Receive Eval Run',
    position: [160, 420],
    parameters: {
      httpMethod: 'POST',
      path: 'portfolio/llm-eval-harness',
      authentication: 'none',
      responseMode: 'responseNode',
      options: {
        allowedOrigins: '*'
      }
    }
  }
});

const normalizeEvalRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Eval Request',
    position: [480, 420],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const source = items[0]?.json ?? {};
const body = source.body ?? source;
const entrypoint = source.manualExecution === true || body.manualExecution === true ? 'manual' : 'webhook';
const text = (v) => String(v ?? '').trim();

// Accept golden cases under a few aliases; each case must carry input + expected to be valid.
const rawCases = Array.isArray(body.golden) ? body.golden
  : Array.isArray(body.cases) ? body.cases
  : Array.isArray(body.dataset) ? body.dataset
  : [];

// humanLabel is the calibration reference (Layer-1): an optional per-case object carrying the
// human-expected verdict. Accepted shapes: { passed: bool } and/or { groundednessBand: [lo, hi] }.
// It is OPTIONAL and never affects the stub path; it only powers judge-human agreement in live mode.
const normHumanLabel = (c) => {
  const h = c && typeof c.humanLabel === 'object' && c.humanLabel ? c.humanLabel : null;
  if (!h) return null;
  const out = {};
  if (typeof h.passed === 'boolean') out.passed = h.passed;
  const band = Array.isArray(h.groundednessBand) ? h.groundednessBand : null;
  if (band && band.length === 2 && Number.isFinite(Number(band[0])) && Number.isFinite(Number(band[1]))) {
    out.groundednessBand = [Number(band[0]), Number(band[1])];
  }
  return Object.keys(out).length > 0 ? out : null;
};

const golden = rawCases.map((c, i) => ({
  id: text(c && c.id) || ('case-' + (i + 1)),
  // input is kept verbatim when it is an OBJECT (the product-feedback request body used by
  // sutMode:"workflow") and coerced to a trimmed string otherwise (the stub/string SUT path). This
  // preserves the structured feedback payload so the workflow-SUT step can POST it to the sibling,
  // while the stub + Ollama-judge paths (which String()-coerce input themselves) are unaffected.
  input: c == null ? '' : (typeof c.input === 'string' ? c.input : (c.input && typeof c.input === 'object' ? c.input : text(c.input))),
  expected: c == null ? '' : (typeof c.expected === 'string' ? c.expected : text(c.expected)),
  assertions: (c && typeof c.assertions === 'object' && c.assertions) ? c.assertions : {},
  humanLabel: normHumanLabel(c),
  hasInput: !!(c && Object.prototype.hasOwnProperty.call(c, 'input')),
  hasExpected: !!(c && Object.prototype.hasOwnProperty.call(c, 'expected'))
}));

// A run is valid only if there is at least one golden case with both { input, expected }.
const validCases = golden.filter((c) => c.hasInput && c.hasExpected);
const hasValidGolden = validCases.length > 0;

// SUT mode + judge source are stub-only in the skeleton; live modes are deferred but the
// configuration surface is normalized here so a misconfigured request can never silently
// route the offline suite through a live model.
// sutMode accepts an alias under either 'sutMode' or 'mode'. v0.3.0 HONOURS 'workflow' (grade the
// live product-feedback sibling as a black-box subject-under-test via its real webhook); 'model'
// stays deferred and degrades to the stub; anything else is the deterministic stub (the default,
// keeping verify:live / CI offline + reproducible).
const requestedMode = (text(body.sutMode) || text(body.mode)).toLowerCase();
const sutMode = requestedMode === 'model' || requestedMode === 'workflow' ? requestedMode : 'stub';
// sutWebhookUrl is the product-feedback endpoint the workflow-SUT step POSTs each case to. The
// eval-harness runs INSIDE the n8n container, so it defaults to the container-local n8n port
// (the sibling webhook is served by the same n8n instance). An optional per-request override
// lets a caller point at host.docker.internal or a remote n8n if localhost is ever unreachable.
const sutWebhookUrl = text(body.sutWebhookUrl) || 'http://localhost:5678/webhook/portfolio/product-feedback-intelligence';
const requestedJudge = text(body.judgeSource).toLowerCase();
const judgeSource = requestedJudge === 'ollama' || requestedJudge === 'openai' ? requestedJudge : 'stub';
// judgeModel is an OPTIONAL per-request override of the Ollama model id. It defaults to the
// pinned 'llama3.2:3b'. Its honest purpose is twofold: (a) try a different local model, and
// (b) DEMONSTRATE the fallback — passing a non-existent model id makes Ollama 404, which the
// onError-tolerant HTTP node routes to the parser as a forced deterministic fallback. It never
// affects the stub path (stub is chosen whenever judgeSource !== 'ollama').
const judgeModel = text(body.judgeModel) || 'llama3.2:3b';

return [{
  json: {
    run: {
      runId: text(body.runId) || ('run_' + Date.now().toString(36)),
      requestedAt: text(body.requestedAt) || new Date().toISOString()
    },
    golden,
    validation: {
      hasValidGolden,
      caseCount: golden.length,
      validCaseCount: validCases.length
    },
    runtime: {
      entrypoint,
      // v0.3.0: the SUT now honours sutMode:'workflow' per-request — a visual IF gate downstream
      // routes it to an httpRequest that POSTs each golden case to the LIVE product-feedback sibling
      // (6Gc3wmri0tJre07B) and extracts response.theme as the case's actual output. 'model' fan-out
      // is still deferred and degrades to the stub. Anything else keeps the deterministic stub so CI /
      // verify:live stays offline + reproducible (stub is the default everywhere CI touches).
      sutMode: sutMode === 'workflow' ? 'workflow' : 'stub',
      requestedSutMode: sutMode,
      sutWebhookUrl,
      // v0.2.0: the JUDGE now honours judgeSource:'ollama' per-request (live local judge), routed
      // by a visual IF gate downstream. Any other value keeps the deterministic stub judge so CI /
      // verify:live stays offline + reproducible (stub is the default everywhere CI touches).
      judgeSource: judgeSource === 'ollama' ? 'ollama' : 'stub',
      requestedJudgeSource: judgeSource,
      judgeModel
    },
    sourcePayloadKeys: Object.keys(body)
  }
}];`
    }
  },
  output: [{
    run: { runId: 'run_demo' },
    golden: [{ id: 'echo-pass', input: 'ping', expected: 'ping' }],
    validation: { hasValidGolden: true, caseCount: 1, validCaseCount: 1 }
  }]
});

const hasGolden = ifElse({
  version: 2.3,
  config: {
    name: 'Golden Case Present?',
    position: [800, 420],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'golden-case-present',
          leftValue: expr('{{ $json.validation.hasValidGolden }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const buildMissingGoldenError = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Missing Golden Error',
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
      error: 'Missing golden case with {input, expected}',
      caseCount: input.validation.caseCount,
      validCaseCount: input.validation.validCaseCount,
      policyVersion: 'eval-harness-v0.3.0'
    }
  }
}];`
    }
  }
});

const manualUiMissingGoldenError = ifElse({
  version: 2.3,
  config: {
    name: 'Manual UI Missing Golden Error?',
    position: [1440, 640],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'manual-ui-missing-golden',
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

const returnMissingGoldenError = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Return Missing Golden Error',
    position: [1760, 760],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json.response }}',
      options: { responseCode: '={{ $json.statusCode }}' }
    }
  }
});

const runSubjectStub = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Run Subject-Under-Test (stub)',
    position: [1120, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
// Deterministic STUB subject-under-test (the default branch of the "SUT Mode = Workflow?" gate).
// The sutMode:"workflow" branch (v0.3.0) instead calls the LIVE product-feedback sibling over HTTP and
// returns the same { caseId, output } shape; a future sutMode:"model" would add an Ollama/cloud HTTP
// node here in parity. Stub policy: echo the input, but if the case input contains the token
// 'HALLUCINATE' emit a fixed wrong answer so a groundedness-fail case can be modelled deterministically.
// Deferred: sutMode:"model" (Ollama/cloud) fan-out + per-model latency/cost capture.
const t0 = Date.now();
const outputs = input.golden.map((c) => {
  const raw = String(c.input ?? '');
  let output = raw;
  if (raw.toUpperCase().includes('HALLUCINATE')) {
    output = 'The capital of France is Berlin.';
  }
  return { caseId: c.id, output, latencyMs: 1 };
});
return [{
  json: {
    ...input,
    sut: {
      mode: 'stub',
      latencyMs: Math.max(1, Date.now() - t0),
      outputs
    }
  }
}];`
    }
  }
});

// --- Live workflow-SUT branch (sutMode:"workflow") -------------------------------------------
// Mirrors the v0.2.0 Ollama-judge idiom: a visual IF gate routes to a per-case fan-out -> an
// httpRequest node calling a LIVE sibling -> a parse node that schema-validates and degrades
// gracefully. Here the sibling is the deployed product-feedback API, graded as a BLACK BOX via its
// real webhook (we POST the feedback object, read back response.theme) — an honest "tests the
// deployed system", not an import of its code. The fan-out fires the HTTP node once per case (it is
// one-request-per-item) and the parse node re-aggregates by index back into the SAME sut.outputs
// shape the stub produces, so the downstream deterministic + judge + aggregate tail is unchanged.
const sutModeGate = ifElse({
  version: 2.3,
  config: {
    name: 'SUT Mode = Workflow?',
    position: [1120, 120],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'sut-mode-workflow',
          leftValue: expr('{{ $json.runtime.sutMode === "workflow" }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const fanOutSutCases = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Fan Out SUT Cases',
    position: [1440, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
// Emit one item per golden case carrying exactly the product-feedback request body. For
// sutMode:"workflow" each case's 'input' is the feedback object ({ feedbackText, reportedCount,
// source, submittedAt }); we tolerate a bare-string input by wrapping it as feedbackText. Order is
// the correlation key — the parse node pairs HTTP responses back to cases by index via
// $('Fan Out SUT Cases').all(). The product-feedback webhook URL travels on each item so the
// httpRequest node can read it from $json (per-request overridable, container-local by default).
const sutUrl = (input.runtime && input.runtime.sutWebhookUrl) ? input.runtime.sutWebhookUrl : 'http://localhost:5678/webhook/portfolio/product-feedback-intelligence';
const items_out = input.golden.map((c) => {
  const raw = c.input;
  let feedbackBody;
  if (raw && typeof raw === 'object') {
    feedbackBody = raw;
  } else {
    // A bare string (or empty) input is wrapped as a minimal feedback object so the sibling still
    // receives its required shape; reportedCount defaults to 1, mirroring product-feedback's own norm.
    feedbackBody = { feedbackText: String(raw ?? '') };
  }
  return {
    json: {
      caseId: c.id,
      sutUrl,
      feedbackBody,
      expected: String(c.expected ?? '')
    }
  };
});
// Defensive: never emit zero items (would stall the branch). hasValidGolden upstream guarantees >=1.
return items_out.length > 0 ? items_out : [{ json: { caseId: '__none__', sutUrl, feedbackBody: { feedbackText: '' }, expected: '' } }];`
    }
  }
});

const callProductFeedback = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Call Product-Feedback (SUT)',
    position: [1760, 40],
    // onError: keep the run alive if the sibling is unreachable / inactive / returns non-2xx. The
    // error item flows to the parse node, which finds no valid theme and marks the case
    // sutSource:"error", passed-blocking (the deterministic exact-match cannot match an empty theme),
    // so an unreachable or erroring sibling is NON-FATAL — never a crash.
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      // The URL is resolved per-request on the fanned-out item (container-local by default). The
      // sibling product-feedback API is graded as a black box through this real HTTP endpoint.
      url: '={{ $json.sutUrl }}',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      // Pass the case's feedback object straight through as the product-feedback request body.
      jsonBody: '={{ $json.feedbackBody }}',
      options: { timeout: 60000 }
    }
  }
});

const parseProductFeedback = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse Product-Feedback (SUT)',
    position: [2080, 40],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// 'items' = the N product-feedback HTTP responses (one per fanned-out case, in order). Recover the
// full run context from the Normalize node (single item) and the per-case identities from the
// fan-out node, then extract response.theme (+ sentiment/urgency) as each case's ACTUAL output. The
// product-feedback webhook (responseMode:responseNode) returns the bare response object, so theme is
// at top level; we stay defensive about an { response: {...} } wrapper too. On an unreachable/erroring
// sibling (no usable theme) the case is marked sutSource:"error" with an empty output so the
// deterministic exact-match fails (passed=false) — a broken sibling never silently passes.
const base = $('Normalize Eval Request').item.json;
const fanned = $('Fan Out SUT Cases').all();

function readResponse(httpJson) {
  // product-feedback returns the bare response object (responseMode:responseNode). Tolerate a wrapper.
  if (httpJson == null) return null;
  if (typeof httpJson === 'object' && httpJson.response && typeof httpJson.response === 'object') return httpJson.response;
  return httpJson;
}

const t0 = Date.now();
const outputs = fanned.map((f, i) => {
  const caseId = f.json.caseId;
  const httpJson = items[i] ? items[i].json : null;
  const resp = readResponse(httpJson);
  const theme = resp && typeof resp.theme === 'string' ? resp.theme : '';
  const sentiment = resp && typeof resp.sentiment === 'string' ? resp.sentiment : '';
  const urgency = resp && typeof resp.urgency === 'string' ? resp.urgency : '';
  const ok = theme.length > 0;
  return {
    caseId,
    // The ACTUAL output graded by the deterministic exact-match is the classification theme; the
    // sibling's own classifierSource is surfaced for transparency but is NOT the harness's verdict.
    output: theme,
    sentiment,
    urgency,
    classifierSource: resp && typeof resp.classifierSource === 'string' ? resp.classifierSource : '',
    sutSource: ok ? 'workflow' : 'error',
    latencyMs: 1
  };
});

return [{
  json: {
    ...base,
    sut: {
      mode: 'workflow',
      latencyMs: Math.max(1, Date.now() - t0),
      // 'error' if ANY case failed to yield a theme (unreachable/erroring sibling); else 'workflow'.
      source: outputs.some((o) => o.sutSource === 'error') ? 'error' : 'workflow',
      outputs
    }
  }
}];`
    }
  }
});

const runDeterministicAssertions = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Run Deterministic Assertions',
    position: [1440, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
// Deterministic-FIRST scoring. Reuses the harness's proven 5-type taxonomy; every checkable
// property is verified here and is NEVER delegated to the judge:
//   schema   -> output is a non-empty string of the expected shape
//   range    -> output length within [1, maxLength]
//   format   -> output matches an optional regex / equals expected exact-match
//   absence  -> output does not contain a forbidden token (structural-absence)
//   masking  -> output carries no raw email / PII (masking invariant)
const outputsById = {};
for (const o of input.sut.outputs) outputsById[o.caseId] = o.output;

const emailRe = /[^\\s@]+@[^\\s@]+\\.[^\\s@]+/;
const results = input.golden.map((c) => {
  const output = String(outputsById[c.id] ?? '');
  const a = c.assertions || {};
  const maxLength = Number.isFinite(Number(a.maxLength)) ? Number(a.maxLength) : 2000;
  const forbid = typeof a.forbid === 'string' ? a.forbid : null;
  const formatRe = typeof a.matches === 'string' ? a.matches : null;
  const expectExact = typeof a.equals === 'string' ? a.equals
    : (typeof a.contains !== 'string' && c.expected != null ? String(c.expected) : null);

  const checks = [];
  // schema-conformance
  checks.push({ type: 'schema', field: 'output', ok: typeof output === 'string' && output.length > 0, detail: 'non-empty string output' });
  // numeric range / band (length)
  checks.push({ type: 'range', field: 'output.length', ok: output.length >= 1 && output.length <= maxLength, detail: 'len ' + output.length + ' in [1,' + maxLength + ']' });
  // format / parse (exact-match against expected, or contains, or regex)
  let formatOk = true;
  let formatDetail = 'no format assertion';
  if (typeof a.contains === 'string') { formatOk = output.includes(a.contains); formatDetail = 'contains "' + a.contains + '"'; }
  else if (formatRe) { try { formatOk = new RegExp(formatRe).test(output); formatDetail = 'matches /' + formatRe + '/'; } catch (e) { formatOk = false; formatDetail = 'invalid regex'; } }
  else if (expectExact != null) { formatOk = output === expectExact; formatDetail = 'exact-match expected'; }
  checks.push({ type: 'format', field: 'output', ok: formatOk, detail: formatDetail });
  // structural-absence
  checks.push({ type: 'absence', field: 'output', ok: forbid ? !output.includes(forbid) : true, detail: forbid ? 'must not contain "' + forbid + '"' : 'no absence assertion' });
  // masking / relational (no raw PII leak)
  checks.push({ type: 'masking', field: 'output', ok: !emailRe.test(output), detail: 'no raw email in output' });

  const passed = checks.every((ch) => ch.ok);
  return { caseId: c.id, passed, checks };
});

return [{ json: { ...input, deterministic: { results } } }];`
    }
  }
});

const judgeSourceGate = ifElse({
  version: 2.3,
  config: {
    name: 'Judge Source = Ollama?',
    position: [1760, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'judge-source-ollama',
          leftValue: expr('{{ $json.runtime.judgeSource === "ollama" }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const judgeStub = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'LLM-as-Judge (stub)',
    position: [2080, 160],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
// Deterministic STUB judge standing in for the LLM-as-judge. In live mode an Ollama/cloud HTTP
// node would replace this and return the SAME schema: four integer 1..5 scores
// { groundedness, relevance, helpfulness, safety } + rationale. The judge only scores the
// residual SUBJECTIVE dimensions — deterministic-checkable facts were already owned upstream.
// Stub policy (reproducible): a case whose deterministic checks all passed is scored 5s; a case
// that failed deterministically is scored low groundedness (2) so judge>=threshold also fails.
// TODO: live judge + schema-validate live output (fallback -> judgeSource:"fallback", passed=false).
const detById = {};
for (const r of input.deterministic.results) detById[r.caseId] = r.passed;

const outputsById = {};
for (const o of input.sut.outputs) outputsById[o.caseId] = o.output;

function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}

const judged = input.golden.map((c) => {
  const detPassed = detById[c.id] === true;
  const output = String(outputsById[c.id] ?? '');
  // Deterministic 1..5 scores. Passing cases score high; failing cases score low groundedness.
  const base = detPassed ? 5 : 2;
  const jitter = (dim) => 0; // stub is stable; live judge would vary. Kept for shape parity.
  const scores = {
    groundedness: detPassed ? 5 : 2,
    relevance: base + jitter('relevance'),
    helpfulness: base + jitter('helpfulness'),
    safety: 5
  };
  // Schema validation of judge output (integers within 1..5). On invalid -> fallback.
  const dims = ['groundedness', 'relevance', 'helpfulness', 'safety'];
  const schemaOk = dims.every((d) => Number.isInteger(scores[d]) && scores[d] >= 1 && scores[d] <= 5);
  const judgeSource = schemaOk ? 'stub' : 'fallback';
  const rationale = detPassed
    ? 'Output matches the reference on all deterministic checks; subjective quality high.'
    : 'Output failed a deterministic check; groundedness penalised.';
  return {
    caseId: c.id,
    scores: schemaOk ? scores : { groundedness: null, relevance: null, helpfulness: null, safety: null },
    judgeSource,
    rationaleHash: 'r_' + hash(rationale + '|' + c.id).toString(16),
    rationale
  };
});

return [{ json: { ...input, judge: { source: 'stub', results: judged } } }];`
    }
  }
});

// --- Live Ollama judge branch (judgeSource:"ollama") -----------------------------------------
// Mirrors the sibling product-feedback idiom: an IF gate routes to an httpRequest node that calls
// a LOCAL model, then a parse node schema-validates and falls back deterministically on bad output.
// The eval-harness twist: the judge scores MANY golden cases, but /api/chat is one-prompt-per-call,
// so we FAN OUT to one item per case (the httpRequest node fires once per item, preserving order),
// then re-AGGREGATE by index in the parse node. The full run context is recovered from the
// 'Run Deterministic Assertions' node (single item) so the HTTP node replacing items is harmless.
const fanOutJudgeCases = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Fan Out Judge Cases',
    position: [2080, 480],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
// Emit one item per golden case carrying exactly what the judge prompt needs: the task input, the
// reference (expected), and the SUT's actual output. Order is the correlation key — the parse node
// pairs HTTP responses back to cases by index via $('Fan Out Judge Cases').all().
const outputsById = {};
for (const o of input.sut.outputs) outputsById[o.caseId] = o.output;
const judgeModel = (input.runtime && input.runtime.judgeModel) ? input.runtime.judgeModel : 'llama3.2:3b';
const items_out = input.golden.map((c) => ({
  json: {
    caseId: c.id,
    judgeModel,
    judgeInput: String(c.input ?? ''),
    judgeExpected: String(c.expected ?? ''),
    judgeActual: String(outputsById[c.id] ?? '')
  }
}));
// Defensive: never emit zero items (would stall the branch). hasValidGolden upstream guarantees >=1.
return items_out.length > 0 ? items_out : [{ json: { caseId: '__none__', judgeModel, judgeInput: '', judgeExpected: '', judgeActual: '' } }];`
    }
  }
});

const judgeOllama = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'LLM-as-Judge (Ollama)',
    position: [2400, 480],
    // onError: keep the run alive if Ollama is unreachable / returns non-2xx (e.g. bad model 404).
    // The error item flows to the parse node, which finds no valid judge JSON and engages the
    // deterministic fallback (judgeSource:"fallback", passed=false). A flaky model is NON-FATAL.
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: 'http://host.docker.internal:11434/api/chat',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      // format:"json" forces Ollama to emit a single JSON object. temperature:0 for repeatability.
      // The judge ONLY scores the four residual subjective dims — deterministic facts were owned
      // upstream. Strict instruction: integers 1..5 + a short rationale; JSON only.
      jsonBody: '={{ ({ model: ($json.judgeModel || "llama3.2:3b"), stream: false, format: "json", options: { temperature: 0 }, messages: [ { role: "system", content: "You are a strict LLM-as-judge for an evaluation harness. Score ONLY these four subjective dimensions, each an INTEGER on a scale from 1 (worst) to 5 (best): groundedness (is the answer supported by the input/reference, no fabrication; a fabricated or contradicted answer is 1), relevance (does it address the task), helpfulness (is it useful and complete), safety (is it free of harmful or policy-violating content). The minimum score is 1 and the maximum is 5 — NEVER use 0 or any value outside 1..5. Reply with JSON ONLY, with exactly these keys: groundedness, relevance, helpfulness, safety, rationale. rationale is one short sentence. Do not include any other keys or text." }, { role: "user", content: "TASK INPUT:\\n" + $json.judgeInput + "\\n\\nREFERENCE (EXPECTED):\\n" + $json.judgeExpected + "\\n\\nACTUAL OUTPUT TO JUDGE:\\n" + $json.judgeActual } ] }) }}',
      options: { timeout: 60000 }
    }
  }
});

const parseJudgeOllama = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse + Validate Judge (Ollama)',
    position: [2720, 480],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// 'items' = the N Ollama HTTP responses (one per fanned-out case, in order). Recover the full
// run context from the deterministic node (single item) and the per-case identities from the
// fan-out node, then schema-validate each judge response. On invalid/unreachable output for a case,
// force the deterministic FALLBACK: judgeSource:"fallback", null scores -> that case will fail in
// aggregate (a broken judge must NOT silently pass). Never throw: a flaky model is non-fatal.
const base = $('Run Deterministic Assertions').item.json;
const fanned = $('Fan Out Judge Cases').all();

function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}
const dims = ['groundedness', 'relevance', 'helpfulness', 'safety'];

function readContent(httpJson) {
  // Ollama /api/chat (non-stream) -> { message: { content: "<json string>" } }. Be defensive about
  // the exact shape n8n wraps it in (message.content | response | raw string | already-parsed).
  if (httpJson == null) return '';
  if (typeof httpJson === 'string') return httpJson;
  if (httpJson.message && typeof httpJson.message.content !== 'undefined') return httpJson.message.content;
  if (typeof httpJson.response !== 'undefined') return httpJson.response;
  return httpJson;
}

let anyFallback = false;
const results = fanned.map((f, i) => {
  const caseId = f.json.caseId;
  const httpJson = items[i] ? items[i].json : null;
  let scores = null;
  let rationale = '';
  let ok = false;
  try {
    const content = readContent(httpJson);
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    const candidate = {
      groundedness: Number(parsed.groundedness),
      relevance: Number(parsed.relevance),
      helpfulness: Number(parsed.helpfulness),
      safety: Number(parsed.safety)
    };
    ok = dims.every((d) => Number.isInteger(candidate[d]) && candidate[d] >= 1 && candidate[d] <= 5);
    if (ok) {
      scores = candidate;
      rationale = typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 280) : 'No rationale provided.';
    }
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    anyFallback = true;
    return {
      caseId,
      scores: { groundedness: null, relevance: null, helpfulness: null, safety: null },
      judgeSource: 'fallback',
      rationaleHash: 'r_' + hash('fallback|' + caseId).toString(16),
      rationale: 'Judge output invalid or unreachable; deterministic fallback engaged (case withheld a pass).'
    };
  }
  return {
    caseId,
    scores,
    judgeSource: 'ollama',
    rationaleHash: 'r_' + hash(rationale + '|' + caseId).toString(16),
    rationale
  };
});

// Source label: "ollama" if every case got a valid live score; "fallback" if ANY case degraded.
// Per-case judgeSource is authoritative for scoring; this top-level label drives judgeTrust framing.
const source = anyFallback ? 'fallback' : 'ollama';
return [{ json: { ...base, judge: { source, results } } }];`
    }
  }
});

const aggregateRun = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Aggregate Eval Run',
    position: [3040, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const judgeThreshold = 4; // judge dims must average >= threshold for a case to "pass"
const detById = {};
for (const r of input.deterministic.results) detById[r.caseId] = r;
const judgeById = {};
for (const j of input.judge.results) judgeById[j.caseId] = j;

const dims = ['groundedness', 'relevance', 'helpfulness', 'safety'];
const perCase = input.golden.map((c) => {
  const det = detById[c.id];
  const jr = judgeById[c.id];
  const scores = jr ? jr.scores : null;
  const haveScores = scores && dims.every((d) => Number.isInteger(scores[d]));
  const judgeMean = haveScores ? dims.reduce((s, d) => s + scores[d], 0) / dims.length : null;
  // Combined verdict: deterministic AND judge>=threshold AND judge schema valid.
  const passed = !!(det && det.passed) && haveScores && judgeMean >= judgeThreshold;
  return {
    caseId: c.id,
    passed,
    deterministicPassed: !!(det && det.passed),
    judgeSource: jr ? jr.judgeSource : 'fallback',
    judgeMean: judgeMean,
    scores,
    humanLabel: c.humanLabel || null
  };
});

const total = perCase.length;
const passedCount = perCase.filter((p) => p.passed).length;
const passRate = total > 0 ? passedCount / total : 0;

// Per-rubric mean across all cases that produced valid scores.
const perRubricMean = {};
for (const d of dims) {
  const vals = perCase.map((p) => (p.scores ? p.scores[d] : null)).filter((v) => Number.isInteger(v));
  perRubricMean[d] = vals.length ? Number((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(3)) : null;
}

// --- Judge-human calibration (who-judges-the-judge) -----------------------------------------
// HONEST trust metric. For every case that carries a humanLabel, compare the JUDGE's verdict to the
// HUMAN reference and count an agreement:
//   - label.passed (bool)        -> judge "passed" (the combined per-case verdict) must match it
//   - label.groundednessBand     -> judge groundedness score must fall within [lo, hi] (within-band)
// A case with BOTH constraints agrees only if both hold. agreement = matches / labelledCases.
// judgeTrust = "high" if agreement >= 0.8 (the eval-plan target) else "low" — never assumed.
const calThreshold = 0.8;
const calibrationCases = [];
let agreeCount = 0;
let labelledCount = 0;
for (const p of perCase) {
  const label = p.humanLabel;
  if (!label) continue;
  labelledCount += 1;
  const sub = [];
  if (typeof label.passed === 'boolean') {
    sub.push({ kind: 'passed', expected: label.passed, actual: p.passed, ok: p.passed === label.passed });
  }
  if (Array.isArray(label.groundednessBand) && p.scores && Number.isInteger(p.scores.groundedness)) {
    const g = p.scores.groundedness;
    const inBand = g >= label.groundednessBand[0] && g <= label.groundednessBand[1];
    sub.push({ kind: 'groundednessBand', expected: label.groundednessBand, actual: g, ok: inBand });
  } else if (Array.isArray(label.groundednessBand)) {
    // No usable score (e.g. fallback) cannot satisfy a band constraint -> disagreement (honest).
    sub.push({ kind: 'groundednessBand', expected: label.groundednessBand, actual: null, ok: false });
  }
  const caseAgrees = sub.length > 0 && sub.every((s) => s.ok);
  if (caseAgrees) agreeCount += 1;
  calibrationCases.push({
    caseId: p.caseId,
    judgeSource: p.judgeSource,
    judgePassed: p.passed,
    judgeGroundedness: p.scores ? p.scores.groundedness : null,
    checks: sub,
    agrees: caseAgrees
  });
}
const hasCalibration = labelledCount > 0;
const agreement = hasCalibration ? Number((agreeCount / labelledCount).toFixed(3)) : null;

// Trust policy:
//   - STUB judge: "high" by construction (the stub agrees with the deterministic verdict by design,
//     so it is a perfect-agreement reference — we SAY SO rather than implying live accuracy).
//   - LIVE judge WITH a calibration slice: "high" iff agreement >= 0.8, else "low" (drift guard fires).
//   - LIVE judge WITHOUT labels: "low" — an uncalibrated grader is never trusted silently.
let judgeTrust;
if (input.judge.source === 'stub') {
  judgeTrust = 'high';
} else if (hasCalibration) {
  judgeTrust = agreement >= calThreshold ? 'high' : 'low';
} else {
  judgeTrust = 'low';
}

const calibration = {
  labelledCount,
  agreeCount,
  agreement,
  threshold: calThreshold,
  basis: input.judge.source === 'stub' ? 'stub-perfect-agreement-by-construction' : 'judge-vs-human',
  cases: calibrationCases
};

// regressionDelta vs previous run is DEFERRED (no run store yet) -> null, surfaced honestly.
const regressionDelta = null;

return [{
  json: {
    ...input,
    aggregate: {
      total,
      passedCount,
      passRate: Number(passRate.toFixed(3)),
      perRubricMean,
      judgeTrust,
      calibration,
      regressionDelta,
      perCase
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
    position: [3360, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
// Redacted audit: carries ONLY case ids, verdicts, scores and counts — never the raw inputs,
// expected answers, SUT outputs, or judge rationale text (masking invariant asserted by the
// Layer-2 suite). Any email-shaped token that somehow reached an output is masked defensively.
const emailRe = /[^\\s@]+@[^\\s@]+\\.[^\\s@]+/g;
const maskEmail = (e) => { const p = e.split('@'); return (p[0] ? p[0][0] + '***' : '***') + '@' + (p[1] ?? ''); };
const runSeed = input.run.runId + '|' + input.run.requestedAt;

const cases = input.aggregate.perCase.map((p) => ({
  caseId: p.caseId,
  passed: p.passed,
  deterministicPassed: p.deterministicPassed,
  judgeSource: p.judgeSource,
  judgeMean: p.judgeMean
}));

return [{
  json: {
    ...input,
    auditEvent: {
      auditEventId: 'audit_' + hash(runSeed),
      runId: input.run.runId,
      sutMode: input.runtime.sutMode,
      judgeSource: input.judge.source,
      judgeTrust: input.aggregate.judgeTrust,
      total: input.aggregate.total,
      passedCount: input.aggregate.passedCount,
      passRate: input.aggregate.passRate,
      perRubricMean: input.aggregate.perRubricMean,
      // Calibration summary only (counts + agreement + per-case verdict comparison). The per-case
      // 'checks' carry expected/actual verdicts and bands — these are pass/fail booleans and small
      // integers, never raw inputs or rationale text, so the masking invariant still holds.
      calibration: {
        labelledCount: input.aggregate.calibration.labelledCount,
        agreeCount: input.aggregate.calibration.agreeCount,
        agreement: input.aggregate.calibration.agreement,
        threshold: input.aggregate.calibration.threshold,
        basis: input.aggregate.calibration.basis
      },
      cases,
      policyVersion: 'eval-harness-v0.3.0',
      createdAt: new Date().toISOString()
    }
  }
}];`
    }
  }
});

const buildEvalResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Eval Response',
    position: [3680, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const input = items[0].json;
const agg = input.aggregate;
return [{
  json: {
    statusCode: 200,
    runtime: input.runtime,
    response: {
      ok: true,
      runId: input.run.runId,
      sutMode: input.runtime.sutMode,
      judgeSource: input.judge.source,
      judgeTrust: agg.judgeTrust,
      passed: agg.passRate >= 1,
      total: agg.total,
      passedCount: agg.passedCount,
      passRate: agg.passRate,
      perRubricMean: agg.perRubricMean,
      regressionDelta: agg.regressionDelta,
      // The who-judges-the-judge surface: the honest agreement number + per-case judge-vs-human
      // comparison. null when no humanLabel was supplied (e.g. the stub Layer-2 fixtures).
      calibration: agg.calibration,
      results: agg.perCase.map((p) => ({
        caseId: p.caseId,
        passed: p.passed,
        deterministicPassed: p.deterministicPassed,
        judgeSource: p.judgeSource,
        judgeMean: p.judgeMean,
        scores: p.scores
      })),
      auditEventId: input.auditEvent.auditEventId,
      processedAt: new Date().toISOString(),
      latencyMs: input.sut.latencyMs,
      policyVersion: 'eval-harness-v0.3.0'
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
    position: [4000, 300],
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
    position: [4320, 180],
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
    note: 'Terminal result for n8n editor Execute Workflow. Webhook executions use Return Eval Response instead.'
  }
}];`
    }
  },
  output: [{
    ok: true,
    executionMode: 'manual-ui',
    response: { passRate: 0.5, judgeTrust: 'high' }
  }]
});

const returnEvalResponse = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Return Eval Response',
    position: [4320, 420],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json.response }}',
      options: { responseCode: '={{ $json.statusCode }}' }
    }
  }
});

const overview = sticky(
  '## LLM Eval Harness v0.3.0\\nLocal eval-harness API: receives an eval run with inline golden cases, runs a GATED subject-under-test, scores each output with the 5-type deterministic assertion taxonomy (schema/range/format/absence/masking) FIRST, then grades the residual subjective dims (1..5 groundedness/relevance/helpfulness/safety) with a GATED judge. SUT gate: sutMode:"workflow" routes each case to the LIVE product-feedback sibling (POST /webhook/portfolio/product-feedback-intelligence) as a BLACK BOX and extracts response.theme as the actual output (onError:continueRegularOutput -> sutSource:"error", passed=false on an unreachable sibling); any other value uses the deterministic STUB SUT (the default, keeping the Layer-2 suite offline + reproducible). Judge gate: judgeSource:"ollama" calls a LIVE local llama3.2:3b (host.docker.internal:11434, format:json) per case, schema-validates, and falls back deterministically (judgeSource:"fallback", passed=false) on bad/unreachable output; any other value uses the deterministic STUB judge. Judge-human CALIBRATION: cases may carry a humanLabel; the run computes judge-vs-human agreement and sets judgeTrust:"high" (>=0.8) else "low" (the who-judges-the-judge drift guard). Emits a redacted audit event. Manual trigger runs an editor demo; webhook serves the API. DEFERRED: SUT model fan-out, regression-vs-previous-run.',
  [runDemoFromUi, buildDemoEvalPayload, receiveEvalRun, normalizeEvalRequest, hasGolden, sutModeGate, fanOutSutCases, callProductFeedback, parseProductFeedback, runSubjectStub, runDeterministicAssertions, judgeSourceGate, judgeStub, fanOutJudgeCases, judgeOllama, parseJudgeOllama, aggregateRun, buildAuditEvent, manualUiExecution],
  { color: 4 }
);

export default workflow('llm-eval-harness', 'Portfolio - LLM Eval Harness API')
  .add(overview)
  .add(runDemoFromUi)
  .to(buildDemoEvalPayload)
  .to(normalizeEvalRequest)
  .to(hasGolden
    .onTrue(
      // v0.3.0: the SUBJECT-UNDER-TEST is now gated. sutMode:"workflow" routes to the live
      // product-feedback sibling (fan-out -> httpRequest -> parse theme); anything else uses the
      // deterministic stub SUT. Both SUT branches CONVERGE on 'Run Deterministic Assertions' (the
      // SDK fans in by node identity), so the deterministic -> judge -> aggregate -> audit -> response
      // tail is defined exactly once, below, on the stub branch.
      sutModeGate
        .onTrue(
          fanOutSutCases
            .to(callProductFeedback)
            .to(parseProductFeedback)
            .to(runDeterministicAssertions)
        )
        .onFalse(
          runSubjectStub
            .to(runDeterministicAssertions)
            // v0.2.0: the judge is gated too. judgeSource:"ollama" routes to the live local judge
            // (fan-out -> Ollama HTTP -> parse/validate/fallback); anything else uses the stub judge.
            // Both judge branches CONVERGE on aggregateRun (fan-in), so the audit -> response ->
            // manual-UI tail is defined exactly once on the live judge branch.
            .to(judgeSourceGate
              .onTrue(
                fanOutJudgeCases
                  .to(judgeOllama)
                  .to(parseJudgeOllama)
                  .to(aggregateRun)
                  .to(buildAuditEvent)
                  .to(buildEvalResponse)
                  .to(manualUiExecution
                    .onTrue(showUiExecutionResult)
                    .onFalse(returnEvalResponse)
                  )
              )
              .onFalse(
                judgeStub.to(aggregateRun)
              )
            )
        )
    )
    .onFalse(
      buildMissingGoldenError
        .to(manualUiMissingGoldenError
          .onTrue(showUiExecutionResult)
          .onFalse(returnMissingGoldenError)
        )
    )
  )
  .add(receiveEvalRun)
  .to(normalizeEvalRequest);
