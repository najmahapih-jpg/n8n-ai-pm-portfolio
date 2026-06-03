// gateway-core.mjs — the interaction-gateway's PURE security + routing functions (single source of truth;
// the n8n Code nodes mirror these). No n8n, no network: assertable in-process by test-gateway-core.mjs.
import crypto from 'node:crypto';

// Fixed intent -> sibling-target allowlist. Callers NEVER supply a URL/host (SSRF-closed by construction).
// A multi-target intent is a fan-out composition (the orchestrator piece folded into the gateway).
export const DEFAULT_ALLOWLIST = {
  'support-triage': ['support-triage'],
  'product-feedback': ['product-feedback'],
  'rag': ['rag'],
  'eval': ['eval-harness'],
  'drift': ['scheduled-drift-monitor'],
  'feedback-then-grade': ['product-feedback', 'eval-harness']
};

// Default secret patterns (value-side) + sensitive key names (key-side). Mirrors the portfolio scanner.
const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9]{8,}/,
  /sb_secret_[A-Za-z0-9_-]{8,}/,
  /sb_publishable_[A-Za-z0-9_-]{8,}/,
  /Bearer\s+[A-Za-z0-9._-]{10,}/i,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ // JWT
];
const SECRET_KEY_NAMES = /(secret|token|apikey|api_key|password|signingsecret|webhookurl|authorization|credential)/i;

// (1) verifySignature — timing-safe HMAC-SHA256 over `timestamp + "." + rawBody`, with a replay window.
export function verifySignature(rawBody, timestamp, signatureHeader, secret, nowSeconds, windowSeconds = 300) {
  if (!signatureHeader) return { ok: false, reason: 'missing signature' };
  if (timestamp === undefined || timestamp === null || timestamp === '') return { ok: false, reason: 'missing timestamp' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(Number(nowSeconds) - ts) > windowSeconds) return { ok: false, reason: 'expired timestamp (replay window)' };
  const expected = 'sha256=' + crypto.createHmac('sha256', String(secret)).update(ts + '.' + String(rawBody)).digest('hex');
  const a = Buffer.from(String(signatureHeader));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false, reason: 'signature mismatch' };
  return crypto.timingSafeEqual(a, b) ? { ok: true, reason: 'ok' } : { ok: false, reason: 'signature mismatch' };
}

// (2) enforceBodySize — reject a raw body over the byte cap.
export function enforceBodySize(rawBody, maxBytes) {
  const bytes = Buffer.byteLength(rawBody ?? '', 'utf8');
  return bytes <= maxBytes ? { ok: true, reason: 'ok', bytes } : { ok: false, reason: 'oversized body', bytes };
}

// (3) stripSecrets — recursively redact any field whose KEY name or string VALUE looks secret. A secret is
// never forwarded to a sibling, echoed in the response, or logged.
export function stripSecrets(obj, valuePatterns = SECRET_VALUE_PATTERNS, keyNames = SECRET_KEY_NAMES) {
  const stripped = [];
  function walk(node, path) {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`));
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        const keyPath = path ? `${path}.${k}` : k;
        if (keyNames.test(k)) { stripped.push(keyPath); out[k] = '[stripped]'; continue; }
        if (typeof v === 'string' && valuePatterns.some((p) => p.test(v))) { stripped.push(keyPath); out[k] = '[stripped]'; continue; }
        out[k] = walk(v, keyPath);
      }
      return out;
    }
    return node;
  }
  return { clean: walk(obj, ''), stripped };
}

// (4) resolveRoute — map an intent to 1+ allowlisted sibling targets; reject unknown / non-allowlisted.
export function resolveRoute(intent, allowlist = DEFAULT_ALLOWLIST) {
  if (!intent || typeof intent !== 'string') return { ok: false, targets: [], reason: 'missing intent' };
  const targets = allowlist[intent];
  if (!Array.isArray(targets) || targets.length === 0) return { ok: false, targets: [], reason: `non-allowlisted intent: ${intent}` };
  return { ok: true, targets: [...targets], reason: 'ok' };
}

export const _internal = { SECRET_VALUE_PATTERNS, SECRET_KEY_NAMES };
