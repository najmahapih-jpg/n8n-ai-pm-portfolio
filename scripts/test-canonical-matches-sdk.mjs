// test-canonical-matches-sdk.mjs — offline proof that the committed canonical JSON IS a fresh compile of the
// SDK source (npm run verify:canonical; also run inside verify:static).
//
// Why this exists: the whole portfolio rests on "the SDK is the source of truth" — the canonical JSON in
// workflows/canonical/ is supposed to be exactly what scripts/lib/compile-sdk.mjs produces from the .workflow.js
// source. Until now NOTHING asserted that. If someone hand-edits a canonical (or forgets to recompile after an
// SDK change) the deploy artifact silently drifts from its source. This gate replicates compile-sdk.mjs's
// transform EXACTLY, then deep-equals a fresh compile against the committed canonical for each pair.
//
// Compile output is non-deterministic in exactly two provably-volatile ways (confirmed empirically):
//   (a) UUID-format values in id / webhookId / versionId / instanceId fields, and any bare UUID string;
//   (b) sticky-note node NAMES carry a random hex suffix (e.g. "Sticky Note e4abdcf1").
// The normalizer below neutralizes ONLY these. It does NOT widen to force a pass: if a pair still differs
// after this minimal normalization, that is REAL drift and the test fails (exit 1) with a diff. No n8n, no network.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseWorkflowCode } from '@n8n/workflow-sdk';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const PAIRS = [
  {
    name: 'interaction-gateway',
    sdk: join(repoRoot, 'workflows', 'sdk', 'interaction-gateway.workflow.js'),
    canonical: join(repoRoot, 'workflows', 'canonical', 'interaction-gateway.canonical.json')
  },
  {
    name: 'gateway-selftest-sibling',
    sdk: join(repoRoot, 'workflows', 'sdk', 'gateway-selftest-sibling.workflow.js'),
    canonical: join(repoRoot, 'workflows', 'canonical', 'gateway-selftest-sibling.canonical.json')
  }
];

// Replicate compile-sdk.mjs's transform EXACTLY: strip the editor-only import line (same regex), parse, drop
// the read-only `active`, ensure settings is an object. (We do NOT JSON.stringify — we compare objects.)
function compileFromSdk(sdkPath) {
  let code = readFileSync(sdkPath, 'utf8');
  code = code.replace(/^\s*import\s+.*?from\s+['"]@n8n\/workflow-sdk['"];?\s*$/m, '');
  const wf = parseWorkflowCode(code);
  delete wf.active;
  if (!wf.settings || typeof wf.settings !== 'object') { wf.settings = {}; }
  return wf;
}

// --- minimal, provably-volatile-only normalizer (deep) ---
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const VOLATILE_ID_KEYS = new Set(['id', 'webhookId', 'versionId', 'instanceId']);
const STICKY_NAME_RE = /^Sticky Note [0-9a-f]{6,}$/;

// `key` is the property name this value sits under (undefined for array elements / the root). We normalize:
//   - string values of keys id/webhookId/versionId/instanceId -> '<volatile-id>'
//   - any string fully matching the UUID format            -> '<uuid>'
//   - a NAME string matching the sticky-note hex pattern    -> 'Sticky Note <hex>'
// Nothing else is touched.
function normalize(value, key) {
  if (Array.isArray(value)) {
    return value.map((v) => normalize(v, undefined));
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = normalize(value[k], k);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (key !== undefined && VOLATILE_ID_KEYS.has(key)) { return '<volatile-id>'; }
    if (UUID_RE.test(value)) { return '<uuid>'; }
    if (key === 'name' && STICKY_NAME_RE.test(value)) { return 'Sticky Note <hex>'; }
    return value;
  }
  return value;
}

// Stable pretty-print for a deterministic, line-by-line diff when a pair really drifts.
function show(obj) { return JSON.stringify(obj, null, 2); }

function firstDiff(aStr, bStr) {
  const a = aStr.split('\n');
  const b = bStr.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return { line: i + 1, sdk: a[i] ?? '<eof>', canonical: b[i] ?? '<eof>' };
    }
  }
  return null;
}

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; } else { fail += 1; }
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (detail ? ' -> ' + detail : ''));
}

for (const pair of PAIRS) {
  let compiled;
  let canonical;
  try {
    compiled = compileFromSdk(pair.sdk);
  } catch (e) {
    check(pair.name + ': compile SDK source', false, e.message);
    continue;
  }
  try {
    canonical = JSON.parse(readFileSync(pair.canonical, 'utf8'));
  } catch (e) {
    check(pair.name + ': read canonical JSON', false, e.message);
    continue;
  }

  const compiledStr = show(normalize(compiled, undefined));
  const canonicalStr = show(normalize(canonical, undefined));
  const equal = compiledStr === canonicalStr;
  check(pair.name + ': committed canonical == fresh SDK compile (volatile-ids/uuid/sticky-name normalized only)', equal);
  if (!equal) {
    const diff = firstDiff(compiledStr, canonicalStr);
    if (diff) {
      console.log('       REAL DRIFT at normalized line ' + diff.line + ':');
      console.log('         SDK-compile : ' + diff.sdk.trim());
      console.log('         canonical   : ' + diff.canonical.trim());
    }
  }
}

console.log('');
console.log('canonical-matches-sdk self-test: ' + pass + ' passed, ' + fail + ' failed (' + PAIRS.length + ' SDK/canonical pairs, OFFLINE, "SDK is source-of-truth" invariant)');
process.exit(fail > 0 ? 1 : 0);
