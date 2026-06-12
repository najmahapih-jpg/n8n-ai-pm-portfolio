import { workflow, node, trigger, sticky } from '@n8n/workflow-sdk';

// Feishu Notify Sibling v0.1.0 — the portfolio's UNIFIED notification outlet, callable ONLY through the
// signed interaction-gateway (intent 'notify' -> Execute Workflow, in-process). Any portfolio workflow —
// or any authorized external caller — sends ONE signed gateway request instead of each knowing the Feishu
// webhook URL/secret. The card build is PURE and mirrored from gateway-core.mjs (normalizeNotifyInput +
// buildNotifyCard, differentially pinned by test-gateway-workflow.mjs); the SEND half is env-gated exactly
// like the drift monitor's digest: unconfigured -> honest 'skipped', live error -> 'failed' (degrade,
// never crash, never a fabricated 'sent'). The webhook URL + signing secret live ONLY in the runner env.

const SIBLING_POLICY_VERSION = 'feishu-notify-sibling-v0.1.0';

const calledByGateway = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.1,
  config: {
    name: 'Called By Gateway (Execute Workflow)',
    position: [220, 300],
    parameters: { inputSource: 'passthrough' }
  }
});

const buildNotifyCard = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Notify Card',
    position: [460, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// PURE half — mirrors gateway-core.normalizeNotifyInput + buildNotifyCard (differentially pinned by
// test-gateway-workflow.mjs, so this inline copy cannot drift from the audited core). The gateway already
// secret-stripped the payload; this node only validates, bounds, and deterministically shapes the card.
const src = items[0].json || {};
function normalizeNotifyInput(s) {
  s = s && typeof s === 'object' ? s : {};
  const payload = (s.payload && typeof s.payload === 'object') ? s.payload : s;
  const text = String(payload.text ?? payload.message ?? '').trim().slice(0, 4000);
  const title = String(payload.title ?? '').trim().slice(0, 120);
  const rawLevel = String(payload.level ?? 'info').toLowerCase();
  const level = (rawLevel === 'warn' || rawLevel === 'error') ? rawLevel : 'info';
  const traceId = typeof s.traceId === 'string' ? s.traceId : (typeof payload.traceId === 'string' ? payload.traceId : '');
  if (!text) return { ok: false, reason: 'missing text', notify: null };
  return { ok: true, reason: 'ok', notify: { level: level, title: title, text: text, traceId: traceId } };
}
function buildNotifyCard(notify, siblingPolicyVersion) {
  const n = notify && typeof notify === 'object' ? notify : { level: 'info', title: '', text: '', traceId: '' };
  const TEMPLATES = { info: 'blue', warn: 'yellow', error: 'red' };
  const ICONS = { info: '🔔', warn: '⚠️', error: '🚨' };
  const level = TEMPLATES[n.level] ? n.level : 'info';
  return {
    config: { wide_screen_mode: true },
    header: {
      template: TEMPLATES[level],
      title: { tag: 'plain_text', content: ICONS[level] + ' ' + (n.title ? n.title : 'Portfolio notification') }
    },
    elements: [
      { tag: 'markdown', content: String(n.text || '') },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: 'traceId ' + String(n.traceId || '-') + ' · via interaction-gateway notify · ' + String(siblingPolicyVersion || '') }] }
    ]
  };
}
const norm = normalizeNotifyInput(src);
if (!norm.ok) {
  // An empty notification is a CALLER bug surfaced honestly — never a silently-dropped or fabricated send.
  return [{ json: {
    ok: false,
    handledBy: 'feishu-notify-sibling',
    siblingPolicyVersion: '${SIBLING_POLICY_VERSION}',
    error: norm.reason,
    feishuDelivery: { status: 'rejected', reason: norm.reason }
  } }];
}
const card = buildNotifyCard(norm.notify, '${SIBLING_POLICY_VERSION}');
return [{ json: {
  ok: true,
  handledBy: 'feishu-notify-sibling',
  siblingPolicyVersion: '${SIBLING_POLICY_VERSION}',
  notify: norm.notify,
  card: card
} }];`
    }
  }
});

const sendNotification = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Send Feishu Notification',
    position: [700, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// SEND half (live-only, intentionally NOT mirrored in core — offline the differential proves the CARD
// instead). Env-gated like the drift monitor's digest: no webhook URL -> honest 'skipped'; optional
// custom-bot HMAC signing (key = timestamp + '\\n' + secret over an EMPTY message, base64); a live send
// error -> 'failed' (degrade, never crash — the gateway still gets a truthful record). The URL/secret are
// read from the runner env ONLY and are never copied into the returned record.
const input = items[0].json || {};
if (input.ok !== true) { return [{ json: input }]; }
const url = String($env.FEISHU_BOT_WEBHOOK_URL || '');
const secret = String($env.FEISHU_BOT_SIGNING_SECRET || '');
if (!url) {
  return [{ json: Object.assign({}, input, { feishuDelivery: { status: 'skipped', reason: 'FEISHU_BOT_WEBHOOK_URL not configured' } }) }];
}
const payload = { msg_type: 'interactive', card: input.card };
if (secret) {
  const crypto = require('crypto');
  const ts = String(Math.floor(Date.now() / 1000));
  payload.timestamp = ts;
  payload.sign = crypto.createHmac('sha256', ts + '\\n' + secret).update('').digest('base64');
}
try {
  const res = await this.helpers.httpRequest({ method: 'POST', url, body: payload, json: true });
  const code = res && typeof res === 'object' && typeof res.code === 'number' ? res.code : null;
  const ok = code === 0;
  return [{ json: Object.assign({}, input, { feishuDelivery: { status: ok ? 'sent' : 'failed', code: code, msg: res && res.msg != null ? String(res.msg).slice(0, 120) : '' } }) }];
} catch (e) {
  return [{ json: Object.assign({}, input, { feishuDelivery: { status: 'failed', error: String(e && e.message ? e.message : e).slice(0, 200) } }) }];
}`
    }
  }
});

const overview = sticky(
  '## Feishu Notify Sibling v0.1.0 — the portfolio\'s unified notification outlet. Callable ONLY through ' +
  'the signed interaction-gateway (intent \'notify\' -> Execute Workflow, in-process): one signed request ' +
  'sends a Feishu group card, so no caller ever holds the webhook URL/secret. Build Notify Card is PURE ' +
  '(mirrors gateway-core normalizeNotifyInput + buildNotifyCard; differentially pinned offline). Send is ' +
  'env-gated: unconfigured -> skipped, error -> failed (degrade, never crash, never a fabricated sent). ' +
  'Level maps the header colour (info=blue / warn=yellow / error=red); the footer note carries the gateway ' +
  'traceId for end-to-end correlation. Not active (Execute Workflow calls by id regardless of active state).',
  [calledByGateway, buildNotifyCard, sendNotification],
  { name: 'feishu-notify-sibling overview', color: 5 }
);

export default workflow('feishu-notify-sibling', 'Portfolio - Feishu Notify Sibling')
  .add(overview)
  .add(calledByGateway)
  .to(buildNotifyCard)
  .to(sendNotification);
