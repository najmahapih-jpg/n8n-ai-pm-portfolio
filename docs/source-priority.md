# Source Priority

The workflow uses deterministic local rules by design.

Priority order:

1. Explicit payload fields after normalization.
2. Deterministic local enrichment rules in SDK Code nodes.
3. Pin-data regression expectations in `scripts/Test-LeadIntelligenceWorkflow.ps1`.
4. Future external enrichment or CRM adapter responses.

External responses must not change v0.1 scoring behavior until a new policy version and fixture matrix are added.
