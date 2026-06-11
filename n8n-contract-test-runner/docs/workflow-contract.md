# Workflow Contract

## No webhook contract

This repository is an offline contract-test tool, not a deployed n8n workflow. It exposes no webhook and therefore has no machine-readable webhook contract of its own.

Its job is the opposite: it **parses and validates** the `## Machine-readable contract` blocks published by the other portfolio repos (see `scripts/Test-Contract.ps1` and `npm run verify:portfolio`).

## What this tool asserts

For each target repo's `docs/workflow-contract.md`, the runner checks:

- The `## Machine-readable contract` JSON block is present and well-formed (`contractVersion`, `webhookPath`, `request`, `response` all present).
- The `contractVersion` string appears in the target's deployed workflow JSON (version drift detection).
- The `webhookPath` string appears in the target's deployed workflow JSON (path drift detection).
- Every fixture file listed under `fixtures.valid` uses only fields declared in `request.accepted`.
- Any documented size limits carry `limitsEnforcedBy: "gateway"` (honest labeling — the workflow itself does not enforce caps).

The self-test gate (`npm run verify:self`) runs these assertions over synthetic good and targeted-bad contracts in `fixtures/self/`, confirming that every defect type is caught and the gate cannot silently no-op.

## Gates

```powershell
npm run verify:self        # self-test: 6/6 synthetic fixtures (good + 5 targeted-bad)
npm run verify:portfolio   # offline conformance across all sibling repos
```

See `README.md` for full usage and `docs/security-boundaries.md` for the trust-boundary rules.
