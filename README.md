# n8n AI-PM Portfolio — Workflow-as-Code, Eval-First

一套互联的 AI 产品工程作品集:用 n8n Workflow-as-Code 构建,评测先行,每个子系统都带离线验证门。
A connected AI product-engineering portfolio built as n8n Workflow-as-Code: eval-first, every
subsystem gated by offline, deterministic verification.

**One repo, ten projects, full git history.** Each directory below was developed as an independent
repository with its own CI gates and per-file commit discipline, then assembled here with
`git subtree` (history preserved). Every project still works standalone — clone, `npm ci`, run its
offline gate, green with zero accounts, zero keys, zero GPUs.

## The system

```
Feishu chat ⇄ feishu-adapter ⇄ signed interaction-gateway ⇄ in-process workflow targets
                                              │
        eval-harness (A) ── grades ──▶ rag-assistant (B) ◀── corpus refresh ── drift-monitor (D)
                ▲                                                                    │
                └────────────── score-drift tracking ◀──────────────────────────────┘
        autonomous-agent (C) ── uses every workflow above as signed gateway tools
```

## Projects

| Directory | What it proves |
|---|---|
| `n8n-llm-eval-harness` | Eval harness: deterministic assertions + LLM-as-judge that is never trusted as ground truth (judge calibration + drift guards) |
| `n8n-rag-knowledge-assistant` | Bilingual zh/en RAG with citation integrity by construction, threshold-gated honest abstention, swappable corpus/models (see its `docs/swap-corpus-and-models.md`) |
| `n8n-scheduled-drift-monitor` | Scheduled corpus refresh + eval-gated quality drift with digest-integrity checks (a summary may not claim numbers the run record does not support) |
| `n8n-interaction-gateway` | HMAC-signed, replay-windowed, intent-allowlisted gateway turning every workflow into an in-process callable target; fail-closed security core |
| `n8n-autonomous-agent` | Bounded tool-use agent whose tools are the portfolio workflows via the signed gateway; one trajectory rubric scores both stub and live LLM planners |
| `n8n-feishu-adapter` | Feishu long-connection chat entrance: signed allowlisted gateway client, interactive card replies with honest abstain/fallback |
| `n8n-product-feedback-intelligence` | Feedback classification workflow (theme / sentiment / urgency), eval-harness SUT |
| `n8n-lead-intelligence-workflow` | Lead scoring + routing workflow with offline gates |
| `n8n-contract-test-runner` | Cross-repo machine-readable workflow-contract verification (the portfolio gate: 8/8 live webhook contracts) |
| `n8n-workflow-as-code` | The Workflow-as-Code toolchain conventions + cross-repo deployment guide (`docs/adopt-on-your-n8n.md`) |

## Reproduce

Each project is self-contained. Inside any project directory:

```powershell
npm ci          # where a package.json exists
npm run verify:static    # or verify:core / Test-Contract.ps1 -SelfTest, per the project README
```

All gates are offline and deterministic (stub-default; live backends are explicit opt-in per
request). See each project's README Quickstart and the root CI workflow for the exact command.

## Trust invariants (the part that does not change when you swap content or models)

- Citations come from really-retrieved chunks, never from a model; fabricated attribution fails the run.
- Below the similarity floor the assistant says it does not have enough information — it never guesses.
- Summaries and digests are re-verified against run records; unsupported pass-rates fail the run.
- CI never touches a live backend; stub paths are bit-reproducible.

## License

Each project directory carries its own `LICENSE` (Apache-2.0).
