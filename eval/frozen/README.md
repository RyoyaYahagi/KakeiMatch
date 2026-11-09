# Frozen 1.2.0 reconciliation engine

`reconciliation-engine-1.2.0.ts` is a verbatim copy of the rule 1.2.0 engine,
kept for evaluation only. Application code must not import it.

`eval:reconciliation-property` runs the current engine and this frozen copy on
the same Issue #380 gate cases, so a change that loses a correct 1.2.0 automatic
confirmation or introduces a new wrong one fails the gate.
