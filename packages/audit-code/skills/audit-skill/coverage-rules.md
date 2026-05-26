# Coverage rules

## Repository-wide requirements

- Every file must appear in the file inventory.
- Every file must be classified, excluded, or marked generated/vendor.
- Every non-excluded file must belong to at least one audit unit.
- Every unit must have required lenses.
- Every required lens must be completed or explicitly marked not applicable with justification.

## Line coverage requirements

- LLM audit tasks should operate on bounded line ranges.
- Reviewed line ranges should be recorded in structured output.
- Unreviewed ranges should be requeued automatically.

## Multi-pass requirements

- Critical units should be reviewed by multiple passes.
- Distinct passes should differ by lens, role, or purpose.
- Coverage verification should fail if overlap thresholds are not met.

## Flow coverage requirements

- Critical flows must be traced end-to-end.
- Trust boundaries must be explicitly reviewed.
- Write paths must receive integrity and reliability review.
