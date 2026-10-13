# Behavior spec template

Write in our own words. Every claim carries a label and an evidence reference.

- **Labels:** `[O]` observed, `[I]` inferred, `[U]` unknown.
- **Evidence:** a scenario step (`S3.4`), a screenshot (`shot-12`), or a public doc URL.

```markdown
# <Target> behavior spec — <scope>

Spec version: see provenance.md (content hash recorded after the firewall review; never stored in this file)
Study author: <agent>    Firewall reviewer: <agent or human>

## 1. Scope
In: <features>. Out: <features>.

## 2. Actors and permissions
| Actor | Can | Cannot | Label | Evidence |

## 3. Features
### F1 <name>
- Purpose: what the user gets done.
- Inputs: fields, types, required, limits. [O] S1.2
- Outputs: what changes, what is shown. [O] shot-04
- Validation and errors: each rule and the message meaning (not its exact wording). [O] S1.5
- Empty and loading states. [O] shot-05
- Quirks: <behavior> — keep | drop, and why.

## 4. UI state machines
For each screen: states, events, transitions, guards.
| From | Event | Guard | To | Label | Evidence |

## 5. API surface (from reduced captures and public docs)
| Method | Path template | Request shape (names, types) | Response shape | Errors | Label | Evidence |

## 6. Data model
Entities, fields, relations, lifecycle. Shapes only, never sample values.

## 7. Limits and non-functional behavior
Pagination, rate limits seen in normal use, sizes, time zones, rounding, sort order.

## 8. Open questions
| ID | Question | Why it matters | What evidence would settle it |

## 9. Checklist status
| Question | Answered / partial / unresolved | Evidence |
```
