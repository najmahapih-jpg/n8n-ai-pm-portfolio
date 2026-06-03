import { workflow, node, trigger, sticky } from '@n8n/workflow-sdk';

// Gateway Selftest Sibling v0.1.0 — a minimal, REAL n8n sub-workflow the interaction-gateway invokes via
// Execute Workflow (in-process, no HTTP, no secret forwarding). Its only purpose is to PROVE the gateway's
// live routing end-to-end: the gateway resolves an intent -> this workflow's id, calls it with the (already
// secret-stripped) clean payload, this workflow runs a small genuine task, and returns a result object that
// the gateway wraps into its response. It deliberately does NOT respond to a webhook — a sub-workflow returns
// the output of its LAST node to the caller. Wiring the real business siblings is the SAME executeWorkflowTrigger
// pattern, applied per-repo on each sibling's own toolchain.

const calledByGateway = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: {
    name: 'Called By Gateway (Execute Workflow)',
    position: [220, 300],
    parameters: { inputSource: 'passthrough' }
  }
});

const handleRoutedRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Handle Routed Request',
    position: [460, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// A small but GENUINE task (so this is a real sibling, not a no-op echo): deterministic urgency
// classification from keyword hits, plus a structured acknowledgement of what was routed in. The input was
// already secret-stripped by the gateway, so we never see a raw secret. The returned object is what the
// gateway receives in-process and wraps into its response.
const src = items[0].json || {};
const payload = (src.payload && typeof src.payload === 'object') ? src.payload : src;
const intent = typeof src.intent === 'string' ? src.intent : (typeof payload.intent === 'string' ? payload.intent : 'unknown');
const traceId = typeof src.traceId === 'string' ? src.traceId : null;
const text = (String(payload.subject || '') + ' ' + String(payload.message || '') + ' ' + String(payload.feedback || '')).toLowerCase();
const URGENT = ['down', 'outage', 'urgent', 'critical', 'cannot', 'broken', 'security', 'breach', 'unresponsive', 'crash'];
const hits = URGENT.filter(function (w) { return text.indexOf(w) !== -1; });
const urgency = hits.length >= 2 ? 'high' : (hits.length === 1 ? 'medium' : 'low');
return [{ json: {
  ok: true,
  handledBy: 'gateway-selftest-sibling',
  siblingPolicyVersion: 'gateway-selftest-sibling-v0.1.0',
  receivedIntent: intent,
  receivedTraceId: traceId,
  payloadKeys: Object.keys(payload || {}),
  computedUrgency: urgency,
  urgencyKeywordHits: hits,
  note: 'real sub-workflow result, returned to the gateway in-process via Execute Workflow (no HTTP)'
} }];`
    }
  }
});

const overview = sticky(
  '## Gateway Selftest Sibling v0.1.0. A minimal REAL sub-workflow the interaction-gateway invokes via ' +
  'Execute Workflow (in-process, no HTTP). Proves the gateway routes to a live sub-workflow and receives its ' +
  'result. executeWorkflowTrigger (passthrough) -> a Code node that does a small genuine task (deterministic ' +
  'keyword urgency classification) and returns an acknowledgement. Not active (Execute Workflow calls by id ' +
  'regardless of active state). The real business siblings get the same executeWorkflowTrigger per-repo.',
  [calledByGateway, handleRoutedRequest],
  { color: 5 }
);

export default workflow('gateway-selftest-sibling', 'Portfolio - Gateway Selftest Sibling')
  .add(overview)
  .add(calledByGateway)
  .to(handleRoutedRequest);
