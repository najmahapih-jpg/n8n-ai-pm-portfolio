# Lead Intelligence Pin Data

Current `v0.1.0` acceptance fixtures:

- `lead-hot-enterprise.json`: grade A, hot lead, enterprise AE routing, notification skipped.
- `lead-midmarket-qualified.json`: grade B, midmarket AE routing.
- `lead-high-intent-low-fit.json`: grade C, SDR qualification routing.
- `lead-student-low-fit.json`: grade D, nurture routing.
- `lead-low-intent-newsletter.json`: grade D, nurture routing.
- `lead-duplicate-existing-id.json`: duplicate branch through explicit `existingLeadId`.
- `lead-duplicate-domain.json`: duplicate branch through deterministic domain match.
- `lead-competitor-domain.json`: competitor disqualification branch.
- `lead-manual-override.json`: manual grade override to A.
- `lead-bad-email.json`: HTTP 422 validation branch.
- `lead-missing-company.json`: HTTP 400 required-field branch.
- `lead-traceid-correlation.json`: grade A lead carrying an optional caller-supplied `traceId`, echoed (never generated) into both the response and the redacted audit event; identical to `lead-hot-enterprise.json` otherwise, so the offline differential proves the additive traceId is the only record delta and does not perturb the deterministic identity hashes.

These fixtures are safe to commit. They use reserved/example domains and do not contain real customer data.
