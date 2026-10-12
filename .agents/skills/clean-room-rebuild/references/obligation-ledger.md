# Obligation ledger

The build side turns each spec claim it must reproduce into an obligation. An obligation
closes only when a passing test names its ID. Unknown, skipped, or truncated results stay
open.

```markdown
# <Target> obligation ledger

Built from spec version: <spec content hash recorded in provenance.md>

| ID | Spec ref | Obligation | Module | Case types required | Fixtures | Test(s) | Status |
|----|----------|------------|--------|---------------------|----------|---------|--------|
| OB-001 | F1 inputs | Rejects an empty title with a field error | items/create | positive, negative, malformed, empty | fixtures/items.json | items.create.test.ts::OB-001 | open |
```

Case types to consider for every obligation:

- **positive**: the normal path works.
- **negative**: a valid but disallowed request is refused.
- **malformed**: wrong type, missing field, oversize, bad encoding.
- **empty**: no data, first use, zero results.
- **permission-denied**: the wrong actor tries it.
- **concurrency**: two writers, retry after partial write.
- **cancellation / teardown**: the user leaves mid-flow; the job is cancelled.

Mark a case type `n/a` only with a one-line reason.

## Status values

`open`, `passing`, `accepted-divergence` (with a link to the decision), `dropped`
(the spec marked the quirk drop).
