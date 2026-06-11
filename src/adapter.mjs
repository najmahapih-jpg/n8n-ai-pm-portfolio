// adapter.mjs — the LIVE shell of the Feishu inbound adapter (npm run adapter:start).
// Receives im.message.receive_v1 over the Feishu WebSocket LONG CONNECTION (no public callback
// URL, the connection is outbound from this host), maps each text message to an allowlisted
// intent via the pure core, signs + posts it to the local interaction-gateway, and replies in
// the chat with the sibling workflow's result. `--connect-check` starts the connection, holds it
// for a short window to prove auth + connectivity, then exits 0.
//
// All credentials come from ./.env (gitignored): FEISHU_APP_ID / FEISHU_APP_SECRET /
// GATEWAY_URL / GATEWAY_SIGNING_SECRET. The offline gate (verify:core) never loads this file.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { parseFeishuEvent, mapMessageToIntent, buildGatewayRequest, buildReplyPayload } from '../scripts/lib/adapter-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Tiny zero-dependency .env loader (KEY=VALUE lines, no quoting/expansion — by design).
function loadEnvFile(path) {
  let raw = '';
  try { raw = readFileSync(path, 'utf8'); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) { process.env[m[1]] = m[2]; }
  }
}
loadEnvFile(join(here, '..', '.env'));

// Bypass any host proxy for Feishu domains: the SDK's axios honours HTTP(S)_PROXY env vars, and a
// host-local proxy (e.g. 127.0.0.1:10808) mangles the WS-endpoint POST into a 400. Feishu is
// directly reachable (domestic), so force NO_PROXY for it — process-scoped, nothing global.
for (const key of ['NO_PROXY', 'no_proxy']) {
  const cur = process.env[key] || '';
  const parts = cur.split(',').map((s) => s.trim()).filter(Boolean);
  for (const host of ['.feishu.cn', 'open.feishu.cn', 'localhost', '127.0.0.1']) {
    if (!parts.includes(host)) { parts.push(host); }
  }
  process.env[key] = parts.join(',');
}

const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:5678/webhook/portfolio/interaction-gateway';
const GATEWAY_SECRET = process.env.GATEWAY_SIGNING_SECRET || '';
const CONNECT_CHECK = process.argv.includes('--connect-check');

if (!APP_ID || !APP_SECRET) {
  console.error('ERROR: FEISHU_APP_ID / FEISHU_APP_SECRET not set (copy .env.example -> .env).');
  process.exit(2);
}
if (!CONNECT_CHECK && !GATEWAY_SECRET) {
  console.error('ERROR: GATEWAY_SIGNING_SECRET not set — the adapter cannot sign gateway requests.');
  process.exit(2);
}

const restClient = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET });
const wsClient = new lark.WSClient({ appId: APP_ID, appSecret: APP_SECRET, loggerLevel: lark.LoggerLevel.info });

// Feishu may redeliver an event; reply at most once per message_id (bounded memory).
const seen = new Set();
function dedupe(messageId) {
  if (!messageId || seen.has(messageId)) { return false; }
  seen.add(messageId);
  if (seen.size > 500) { seen.delete(seen.values().next().value); }
  return true;
}

async function replyText(messageId, text) {
  await restClient.im.message.reply({
    path: { message_id: messageId },
    data: { content: JSON.stringify({ text }), msg_type: 'text' }
  });
}

async function replyMessage(messageId, payload) {
  const p = payload && typeof payload === 'object' ? payload : { msg_type: 'text', content: { text: String(payload ?? '') } };
  const msgType = p.msg_type === 'interactive' ? 'interactive' : 'text';
  const content = msgType === 'interactive' ? p.content : (p.content || { text: p.fallbackText || '' });
  try {
    await restClient.im.message.reply({
      path: { message_id: messageId },
      data: { content: JSON.stringify(content), msg_type: msgType }
    });
  } catch (e) {
    if (msgType !== 'interactive') { throw e; }
    console.error('[adapter] interactive reply failed, falling back to text: ' + (e && e.message ? e.message : e));
    await replyText(messageId, p.fallbackText || '知识库已返回结果,但卡片渲染失败。');
  }
}

async function callGateway(intent, payload) {
  const requestId = 'feishu-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const ts = String(Math.floor(Date.now() / 1000));
  const { rawBody, headers } = buildGatewayRequest(requestId, intent, payload, GATEWAY_SECRET, ts);
  const res = await fetch(GATEWAY_URL, { method: 'POST', headers, body: rawBody });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!body || typeof body !== 'object') { return { ok: false, status: res.status, error: 'non-JSON gateway response' }; }
  return { ...body, status: res.status };
}

async function onMessage(data) {
  const parsed = parseFeishuEvent(data);
  if (!dedupe(parsed.messageId)) { return; }
  console.log('[adapter] message in ' + parsed.chatId + ': ' + (parsed.text || '<' + parsed.messageType + '>'));
  try {
    const mapped = mapMessageToIntent(parsed.text, { runSeed: parsed.messageId.slice(-8), asOf: new Date().toISOString().slice(0, 10) });
    if (!mapped.intent) {
      await replyText(parsed.messageId, '用法: 直接提问(走知识库 rag),或发"日报/漂移/drift"(跑漂移体检,简报卡片会发到群),或"自检/selftest"。');
      return;
    }
    console.log('[adapter] -> intent ' + mapped.intent + ' (' + mapped.reason + ')');
    const gw = await callGateway(mapped.intent, mapped.payload);
    const reply = buildReplyPayload(mapped.intent, gw);
    await replyMessage(parsed.messageId, reply);
    console.log('[adapter] <- replied (gateway ok=' + gw.ok + ', traceId=' + (gw.traceId || 'n/a') + ')');
  } catch (e) {
    console.error('[adapter] handler error: ' + (e && e.message ? e.message : e));
    try { await replyText(parsed.messageId, '⚠️ 适配器处理出错: ' + String(e && e.message ? e.message : e).slice(0, 120)); } catch { /* reply best-effort */ }
  }
}

const dispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': onMessage
});

console.log('[adapter] starting Feishu long connection (app ' + APP_ID.slice(0, 8) + '…, gateway ' + GATEWAY_URL + ')');
wsClient.start({ eventDispatcher: dispatcher });

if (CONNECT_CHECK) {
  setTimeout(() => {
    console.log('[adapter] connect-check window elapsed — if the SDK logged a successful connection above and no auth error appeared, the long connection is UP. Exiting.');
    process.exit(0);
  }, 15000);
}
