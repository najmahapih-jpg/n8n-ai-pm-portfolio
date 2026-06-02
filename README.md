# n8n-contract-test-runner

A standalone, offline-capable **contract-conformance gate** for the n8n Workflow-as-Code portfolio. Point
it at any sibling repo; it turns that repo's `docs/workflow-contract.md` from prose into a machine-checkable
test — asserting the workflow still honors its published request/response interface.

> **Status: v0.1.0 — implemented (2026-06-02).** `scripts/Test-Contract.ps1` + the self-test fixtures are
> built and green: self-test **6/6** (every synthetic defect caught), offline vs support-triage **5/5**.
> Live mode is proven — on its first live run it caught a real response-shape gap in support-triage
> (standard-path responses omit the contract-required `feishuDelivery`). Adopted by **1 of 6** sibling
> contracts so far (support-triage, the reference target).

## Why

The portfolio's standout signal is *honest-eval discipline*. Each project publishes a contract, but until
now nothing enforced it — a "narrated but not asserted" gap. This tool closes it and gates every later live
surface (e.g. the planned interaction gateway) against contract drift. It is the **first new build** in the
refined roadmap precisely because it amplifies that signal at the lowest cost.

## How it will work

```
scripts/Test-Contract.ps1 -RepoPath <path-to-sibling-repo> [-Live] [-BaseUrl <url>]
```

- **Offline (default, CI):** parse the target's `## Machine-readable contract` block; assert it is
  well-formed, its `contractVersion` + `webhookPath` match the target's meta/canonical JSON, and its
  golden fixtures use only declared request fields. No running n8n needed.
- **Live (`-Live`, opt-in):** re-POST the golden requests and assert the real response conforms to the
  declared `response` shape + documented error codes — behind a connection-check that **SKIPs honestly**
  (exit 0, labeled) when n8n is unavailable.

Documented size caps stay labeled `limitsEnforcedBy: "gateway"` — the runner asserts the *label exists*,
never that the workflow enforces a cap it doesn't (carrying the honest input-size relabel into the format).

## Design docs

- Spec: [`fixtures/requests/contract-test-runner.md`](fixtures/requests/contract-test-runner.md)
- Architecture decision: [`docs/adr/0001-standalone-contract-conformance-tool.md`](docs/adr/0001-standalone-contract-conformance-tool.md)
- Eval plan (how the runner is itself graded): [`docs/eval-plan.md`](docs/eval-plan.md)

## Run it

```powershell
npm run verify:self                                   # the runner's own good/bad self-test (offline, CI)
npm run contract -- -RepoPath ..\n8n-workflow-as-code            # offline conformance vs a sibling
npm run contract -- -RepoPath ..\n8n-workflow-as-code -Live      # + live (opt-in; SKIPs if the webhook is inactive)
```

## Next steps

- Add the `## Machine-readable contract` block to the other 5 sibling `workflow-contract.md` files.
- A `verify:portfolio` gate that runs offline over all six (SKIPping not-yet-adopted ones — the null-guarded
  "no contract block" path already degrades gracefully).
- Optional: response **type** checking (v0.1.0 checks required-field *presence*), and SDK auto-derivation of
  the contract block.

License: Apache-2.0.
