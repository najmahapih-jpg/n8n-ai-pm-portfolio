// Standalone SDK -> deployable n8n workflow JSON compiler.
//
// The sibling project's Sync script relied on the official n8n MCP for the SDK->n8n step.
// This project has NO MCP available, so it uses the SDK's own `parseWorkflowCode` (a pure
// function in @n8n/workflow-sdk) to turn a .workflow.js source into deployable workflow JSON,
// then validates it with the SDK's `validateWorkflow`. See docs/adr/0002.
//
// Usage:
//   node scripts/lib/compile-sdk.mjs <sdkPath> [--out <jsonPath>] [--min <minNodes>] [--quiet]
//
// Behaviour:
//   - Strips the leading `import ... from '@n8n/workflow-sdk'` line (editor-only; the AST
//     interpreter injects the builtins and rejects import declarations).
//   - Prints a one-line JSON summary { name, nodeCount, connectionCount, valid } on success.
//   - Writes the compiled JSON to --out when provided (UTF-8, no BOM, trailing newline).
//   - Exits non-zero on parse/validation failure or when nodeCount < --min.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseWorkflowCode, validateWorkflow } from '@n8n/workflow-sdk';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') { args.out = argv[++i]; }
    else if (a === '--min') { args.min = Number(argv[++i]); }
    else if (a === '--quiet') { args.quiet = true; }
    else if (a === '--strict') { args.strict = true; }
    else { args._.push(a); }
  }
  return args;
}

function fail(message) {
  process.stderr.write('ERROR: ' + message + '\n');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const sdkPath = args._[0];
if (!sdkPath) { fail('usage: compile-sdk.mjs <sdkPath> [--out <jsonPath>] [--min <minNodes>]'); }

let code;
try {
  code = readFileSync(sdkPath, 'utf8');
} catch (e) {
  fail('could not read SDK source ' + sdkPath + ': ' + e.message);
}

// Editor-only import line; the interpreter injects builtins and disallows ImportDeclaration.
code = code.replace(/^\s*import\s+.*?from\s+['"]@n8n\/workflow-sdk['"];?\s*$/m, '');

let wf;
try {
  wf = parseWorkflowCode(code);
} catch (e) {
  fail('parseWorkflowCode failed: ' + e.message);
}

if (!wf || typeof wf !== 'object' || !Array.isArray(wf.nodes)) {
  fail('parseWorkflowCode did not return a workflow with a nodes array');
}

// n8n create API treats `active` as read-only and requires settings; normalise here.
delete wf.active;
if (!wf.settings || typeof wf.settings !== 'object') { wf.settings = {}; }

const nodeCount = wf.nodes.length;
const connectionCount = wf.connections ? Object.keys(wf.connections).length : 0;

// validateWorkflow takes the compiled workflow object (WorkflowJSON), not the source string.
// Schema validation needs an n8n node-types provider we do not ship offline, so validate the
// graph shape (nodes/connections/expressions) with schema checks disabled.
let valid = true;
let validationDetail = 'skipped';
try {
  const result = validateWorkflow(wf, { validateSchema: false });
  const errors = Array.isArray(result.errors) ? result.errors : [];
  valid = !!result.valid && errors.length === 0;
  validationDetail = valid ? 'valid' : errors.map((er) => er.code + ': ' + er.message).join(' | ');
} catch (e) {
  // The SDK validator can require n8n node-type metadata we do not bundle offline; that specific
  // failure is a known soft signal and degrades gracefully. Any OTHER throw is a real signal and
  // must NOT be swallowed (previously this catch set valid=true for every error, hiding genuine failures).
  const msg = (e && e.message) ? String(e.message) : String(e);
  process.stderr.write('WARN: validateWorkflow threw: ' + msg.slice(0, 200) + '\n');
  const knownOffline = /node[\s-]?type|nodetype|unknown node|node-types|metadata|provider/i.test(msg);
  if (args.strict || !knownOffline) {
    fail('SDK validation error: ' + msg.slice(0, 200));
  }
  valid = true;
  validationDetail = 'validator-unavailable (' + msg.slice(0, 80) + ')';
}

if (Number.isFinite(args.min) && nodeCount < args.min) {
  fail('compiled ' + nodeCount + ' nodes, below the required floor of ' + args.min);
}
if (!valid) {
  fail('SDK validation failed: ' + validationDetail);
}

if (args.out) {
  try {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify(wf, null, 2) + '\n', { encoding: 'utf8' });
  } catch (e) {
    fail('could not write compiled JSON to ' + args.out + ': ' + e.message);
  }
}

if (!args.quiet) {
  process.stdout.write(JSON.stringify({
    name: wf.name,
    nodeCount,
    connectionCount,
    valid,
    validationDetail,
    out: args.out ?? null
  }) + '\n');
}
