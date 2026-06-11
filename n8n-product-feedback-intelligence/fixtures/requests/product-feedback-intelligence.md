# Product Feedback Intelligence Workflow Request

Build a local-first n8n workflow that accepts free-text product feedback and returns a
structured, auditable product signal suitable for portfolio review. This is the first workflow
on the harness to place an LLM in the decision loop, behind a deterministic safety net.

## Problem

Product teams receive unstructured feedback (support replies, in-app forms, reviews) faster than
they can read it. The signal — what theme, how negative, how urgent, is this a churn risk — is
buried in free text. Manual triage is slow, inconsistent, and loses the highest-severity items.

## Solution

A webhook API that classifies each feedback item by theme, sentiment, and urgency, scores its
priority, gates the most dangerous items for human review, and records a redacted audit trail —
deterministically reproducible for testing, with a real LLM available for the live path.

## Impact + Control

- **Impact:** turns free-text feedback into a routed, scored signal a PM can act on.
- **Control:** a confidence threshold with a deterministic fallback (no garbage on low confidence),
  a human-in-the-loop gate for churn-risk/critical items, and a redacted audit event (no raw PII).

## Required behavior

- Accept POST webhook payloads at `portfolio/product-feedback-intelligence`.
- Normalize common aliases: `feedbackText` / `text` / `message` / `comment`; `reportedCount` / `count`; `source`; `submittedAt`.
- Validate required field `feedbackText` (non-empty after trim); reject missing with HTTP 400 and empty/whitespace with HTTP 422.
- Classify into a **fixed theme taxonomy**, a **sentiment** label, and a **confidence** score via the active classifier (`stub` or `ollama`).
- If confidence is below threshold **or** the classifier output fails schema validation, fall back to a deterministic keyword classifier and set `classifierSource = "fallback"`.
- Derive **urgency** deterministically from sentiment + theme + churn signals (do not let the model set urgency directly).
- Score `priorityScore` from urgency weight × a bounded function of `reportedCount`.
- Route churn-risk **or** critical items into a **human-in-the-loop** branch (`status = "awaiting_approval"`, `needsHumanReview = true`); everything else is auto-classified.
- Emit a redacted audit event that never contains raw feedback text beyond a short safe excerpt and never contains raw PII (e.g. emails embedded in feedback are masked).
- Build a structured response returning only a safe subset; keep the Feishu alert adapter as final optional configuration, not part of the v0.1 acceptance path.

## Fixed taxonomy (v0.1)

`theme`: `bug`, `feature_request`, `usability`, `performance`, `pricing`, `praise`, `churn_risk`, `other`.
`sentiment`: `positive`, `neutral`, `negative`.
`urgency`: `critical`, `high`, `normal`, `low`.

## Out of scope (v0.1)

- Cross-item clustering / true volume aggregation (single-item scoring uses `reportedCount`; batch aggregation deferred).
- Grading the LLM's classification quality (the eval validates the stub + fallback; the live model is demonstrated manually).
- External CRM / ticketing delivery.

## Portfolio value

Demonstrates LLM-in-the-loop design with a deterministic fallback, eval design for a
non-deterministic system (schema / range / graceful-degradation assertions), human-in-the-loop
governance, PII-redacted auditing, workflow-as-code, pin-data regression tests, canonical release
snapshots, and local n8n MCP automation — all local-only with no paid cloud dependency.
