# Spec: Multi-Lane Handoffs with File Locking

**Status**: Partially implemented
**Version**: 1.1.2
**Author**: btrain
**Date**: 2026-03-15
**Updated**: 2026-10-07

The multi-lane lock baseline through v1.1.1 is implemented. Version 1.1.2 is the designated contract, including close-without-merge as terminal `resolved` and audited force-release. Both paths, and the `--final` review bypass, were repaired in PR #33 (merged 2026-09-01). The drift notes that remain inside the sections pinned by `specs/tla/LaneLock.tla` are kept verbatim until that model's pin is refreshed; read them as history, not as open drift.

## Summary

Concurrent work lanes allow multiple agents to work simultaneously on separate tasks with file-level isolation enforced by a lock registry and pre-commit hook.

## Configuration

Enabled via `[lanes]` in `.btrain/project.toml`:

```toml
[lanes]
enabled = true

[lanes.a]
handoff_path = ".claude/collab/HANDOFF_A.md"

[lanes.b]
handoff_path = ".claude/collab/HANDOFF_B.md"
```

When `[lanes]` is absent or `enabled = false`, btrain operates in single-handoff mode (backward compatible).

## Architecture

### Lane Files

Each lane has its own independent handoff file with the standard `## Current` section. Lanes are identified by single-letter IDs (`a`, `b`).

### Lock Registry

`.btrain/locks.json` stores file-level locks:

```json
{
  "version": 1,
  "locks": [
    {
      "path": "src/auth/",
      "lane": "a",
      "owner": "Claude",
      "acquired_at": "2026-03-15T21:00:00Z"
    }
  ]
}
```

### Lock Enforcement

1. **On claim**: `btrain handoff claim --files` acquires locks; conflicts with other lanes are rejected
2. **On terminal resolve**: `btrain handoff resolve --lane` auto-releases that lane's locks only when the lane actually becomes `resolved`
3. **Pre-commit hook**: Blocks commits touching files locked by another lane

When `[pr_flow].enabled` is true, peer `handoff resolve` means local review approval and advances the lane to `ready-for-pr`. It does **not** release locks. Locks stay held through `ready-for-pr`, `pr-review`, and `ready-to-merge`, and are released when the PR merges or closes (or via `btrain locks release-lane` after a spec 006 audited override). Close without merge is terminal `resolved` plus lock release; it is not `repair-needed`.

This PR-flow retention contract is the intended behavior for PR-flow-enabled repositories, including this one. Spec 002's original resolve-releases rule still applies only to terminal `resolved` (no PR-flow, or after the PR has merged or closed).

### PR-flow states and actors

These statuses and actors are the designated contract for the spec 014 first model. GitHub is an external event source; btrain's response is what is specified.

| Status | Meaning | Who may enter it | Locks |
|---|---|---|---|
| `ready-for-pr` | Local peer approved; a PR may be opened or relinked | Assigned reviewer via `handoff resolve`. The owner acts next (opens or relinks the PR) after the lane is already in this status. | retained |
| `pr-review` | A GitHub PR is linked and waiting on GitHub review/CI | Owner via `btrain pr create`, or owner via `handoff update --status pr-review --pr` to relink | retained |
| `ready-to-merge` | GitHub review/CI disposition is mergeable | `btrain pr poll --apply` (PR-flow), not a peer `handoff resolve` | retained |
| `changes-requested` (PR-flow) | GitHub review returned findings | `btrain pr poll --apply` when overall status is feedback; then the writer acts (spec 005). After pushing the fix the owner returns the lane directly to `pr-review` with `btrain pr request-review` or `handoff update --status pr-review`; GitHub review covers the fix and local approval survives GitHub feedback (spec 015 Q1, Option A, decided 2026-09-08) | retained |
| `resolved` after merge | PR merged | `btrain pr poll --apply` on merge | released |
| `resolved` after close without merge | PR closed unmerged; the lane is abandoned or replaced | `btrain pr poll --apply` on close, or, when a human or the owner abandons the work, closing the PR on GitHub and then running `btrain pr poll --apply` (a plain `handoff resolve` from a PR-flow status is rejected; spec 015 Phase B step 3, 2026-09-09) | released |

Non-terminal `btrain pr poll --apply` outcomes (`waiting`, `feedback`, `clear`) apply only to a lane in `pr-review` or `ready-to-merge`, or in PR-flow `changes-requested` with a linked PR (`ready-for-pr` has no linked PR yet); an explicit `--pr` on a lane in any other status is rejected. PR-flow `changes-requested` means the lane entered `changes-requested` through `pr poll --apply` feedback (reason code `pr-review-feedback`) and local approval still stands. If the owner instead re-hands off locally and the reviewer requests changes, that approval is withdrawn and the lane re-enters the PR flow only through a new local approval (`ready-for-pr`). `waiting` observed after `ready-to-merge` (a new head, or a re-requested review) returns the lane to `pr-review`; `clear` observed on PR-flow `changes-requested` advances it to `ready-to-merge`. Designated 2026-09-09 for spec 015 rows 8, 9, 10, 12 (ledger finding 9).

Close without merge is a **terminal lock-release** event. It is not `repair-needed`. Spec 006 `repair-needed` is for workflow-integrity failures and retains locks; GitHub close is an external completion event. The lane becomes `resolved` and locks release.

Current `applyPrStatusToHandoff` sending `overall === "closed"` to `repair-needed` (`src/brain_train/pr-flow.mjs`) is implementation drift and a candidate counterexample. The model must pin this designated contract, not the current branch.

### GitHub bot review comes after local review

Every path that sends a lane's revision to GitHub — `btrain pr create`, `btrain pr request-review`, and `btrain pr poll --request-review` — shares one gate. A lane status is not enough on its own: the owner can be approved at `ready-for-pr`, commit again, and still be at `ready-for-pr`. So the gate binds the approval to one revision.

A revision may go to GitHub only when all of the following hold:

1. The lane is in `ready-for-pr` or `pr-review`.
2. The canonical event log (`.btrain/events/lane-<id>.jsonl`, or `repo.jsonl` when lanes are off) records a `handoff resolve` with `details.localReviewApproved` that reached `ready-for-pr` **since the current claim**. A later `claim`, `request-changes` or `watchdog-repair` event withdraws it, as does any later recorded move to a status outside the PR flow. Bot feedback therefore withdraws the approval, and relinking the lane to `pr-review` does not revive it. An event that records no state snapshot at all — `history-compact` archiving old handoff entries is the one that occurs — is bookkeeping, not a move, and leaves the approval alone.
3. The approver is a real peer: not the lane owner, equal to the recorded reviewer, and not an advisory resolve (L8 is exactly "actor is not the recorded reviewer"; L9 is an uncovered lane).
4. The approval names the **target** it covers, and that target is the one bound for GitHub. The target is four facts, because a head object ID alone does not describe a change: the diff a reviewer reads is `base...head`, so the same head against a different base is a different change. The four are the canonical repository identity, the base ref, the base object ID, and the head object ID. Object IDs are compared whole: a trailer must carry a full 40-character (sha1) or 64-character (sha256) ID, and an abbreviation is rejected rather than prefix-matched, because two commits can share a short prefix and a gate that accepts a prefix can authorize the wrong commit.

The reviewer names the target with two trailers in the summary they already pass. The canonical format is:

```
Reviewed-Head: <head object ID>
Reviewed-Base: <repository> <base ref> <base object ID>
```

`<repository>` is `host/owner/repo` for a network remote (`github.com/codeslp/btrain`), written the same way whichever URL form the remote uses, and `path:<path>` for a local one. Fields on the `Reviewed-Base` line are separated by spaces; a git branch name cannot contain one.

```
btrain handoff resolve --lane a --summary "$(printf 'approved: the gate reads clean\n\nReviewed-Head: %s\nReviewed-Base: github.com/codeslp/btrain main %s' "$(git rev-parse HEAD)" "$(git ls-remote origin refs/heads/main | cut -f1)")"
```

There is no new flag. Both are trailers inside `--summary`, and `handoff resolve` stores the summary verbatim in the resolve event, so the binding is recorded by the existing command. The `printf` form matters when the command is pasted into a shell: a literal `\n` inside double quotes reaches btrain as two characters and the trailer does not parse. A refusal from the gate prints the `Reviewed-Base` line for the live target, so the reviewer does not have to assemble it by hand — but it is the target to *review*, not a value to paste unread.

**Why the base is bound too.** A lane can be approved against one base and opened against another: `btrain pr create --base <other>` takes a base the review never saw, and a PR can be retargeted on GitHub after approval. Either way the diff the bots receive contains files no reviewer read. Binding the base ref and its object ID refuses both, and refuses a base that has simply moved on — a base that advanced is a diff nobody has read either. Refreshing is the normal two steps below.

**Which revision counts as "bound for GitHub".** Never a local cache.

- `btrain pr create` approves the local `HEAD` against the base it has just resolved — including an explicit `--base` — then pushes *that object by name* (`git push origin <approved>:refs/heads/<branch>`) rather than the branch tip, so a commit made between the check and the push cannot be published. It then reads the branch back off **every push destination** of the head remote with `git ls-remote` and refuses unless each one has the approved revision. The push destinations are `git remote get-url --push --all`, not the fetch URL: a remote with `pushurl` set publishes somewhere the fetch URL cannot see, and a remote may have several push URLs, all of which receive the push. Under `--no-push` btrain publishes nothing, so that same read is the only thing standing between an unpublished or foreign branch revision and `gh pr create`; a missing or mismatched branch is refused there. Push URLs can embed credentials, so diagnostics print host and path only.
- `gh pr create` is told which repository to open on (`--repo <host/owner/repo>`, from the identity the gate just authorized) instead of being left to its own default. gh otherwise resolves the base repository from a `gh-resolved` remote marker, the `GH_REPO` environment variable or a fork's parent, none of which has to be the repository the approval covers. Because the repository is explicit, a head branch living in another repository — the ordinary fork layout — is passed as `--head <owner>:<branch>`, and a same-repository head stays bare.
- Every bot review request asks GitHub for the PR's whole current target at posting time — `headRefOid`, `baseRefName`, `baseRefOid`, and the repository from the PR URL — and authorizes against that. No local remote is consulted: the bots review what GitHub has, and a checkout's remotes can point elsewhere. A local tracking ref such as `refs/remotes/origin/<branch>` is only as fresh as the last fetch and must not authorize a post. If the checkout is on the PR's head branch at a different revision, the request is refused and the owner is told to push or wait for propagation, rather than having the bots review something other than what is in front of them.
- Both paths authorize the same four facts against the same approval. They differ only in source, and each uses the best one available: before the PR exists there is nothing to ask but the remote, and once it exists GitHub is the authority on its own target.
- Refusals print a ready-made `handoff resolve` command. A repository identity and a base ref come from a remote URL and a branch name, and git permits `$`, backticks, quotes and `%` in a branch name, so those values are interpolated into the printed command only when they are inert in both shell and `printf`. Otherwise the command keeps its placeholders and the live target is printed beside it as plain text.

**Refreshing an approval.** An approval made before this gate existed has no trailers, and an approval overtaken by a new commit, a changed base, or a base that has moved no longer covers the current target. All are refreshed the same way, through the normal lane lifecycle: the owner runs `btrain handoff update --lane <id> --status needs-review`, and the reviewer resolves again with a summary carrying the current `Reviewed-Head` and `Reviewed-Base`. No override and no administrative command is involved.

The gate runs before any side effect. `btrain pr create` checks it before `git push` and before `gh pr create`, so a refusal leaves nothing on the remote. `btrain pr request-review` settles everything except the revision comparison before its first `gh` call, then compares against GitHub's head at post time. An explicit `--pr` that is not the lane's linked PR is refused, so one lane's approval cannot be carried onto another PR's head.

`btrain pr create` additionally requires `ready-for-pr` because row 7 opens a PR from that status only. That requirement is structural and the `local_review` feature does not lift it.

`btrain features disable local_review` turns the whole gate into a warning for when the local reviewer cannot run (out of tokens, rate limited); `btrain features enable local_review` restores it. The feature defaults to on. While it is on, a current peer approval of the exact revision is a hard requirement.

Scope, as of 2026-11-20: this gate lives in the PR-flow commands, not in the transition rows. The row 12 return (`handoff update --status pr-review` from PR-flow `changes-requested`, spec 015 Q1 Option A) and the advisory L8 self-approval still reach a gate-passing *status* without a fresh local review. They no longer reach GitHub: the approval check above refuses both, because bot feedback withdrew the approval and an advisory resolve does not count as a peer act. Moving the refusal into the rows themselves is spec 015 Q1 Option B and is still outstanding.

### `handoff resolve --final`

`--final` marks a resolve as terminal: the lane becomes `resolved` and locks release. It does not enter `ready-for-pr`.

In a PR-flow-enabled repository this is not a reviewer bypass of local approval. From `needs-review`, the assigned reviewer uses plain `handoff resolve` (no `--final`) to enter `ready-for-pr` with locks retained. `--final` from `needs-review` or from any PR-flow status (`ready-for-pr`, `pr-review`, `ready-to-merge`) is rejected. Earlier CLI versions honored it; that was implementation drift, repaired in PR #33.

`--final` is valid only when terminal `resolved` is already the designated next status: in repositories without PR-flow, where resolve is terminal, or as the explicit terminal disposition after merge or close handling. The actor is the same as for that terminal resolve.

`resolveHandoff` (`src/brain_train/core.mjs`) enforces this since PR #33: with `[pr_flow].enabled`, `--final` from `needs-review` or a PR-flow status fails unless the resolve is the internal PR-outcome path. The `test/formal/` harness carries a regression witness for it.

### Force-release override

`btrain locks release --path` and `btrain locks release-lane` may drop lock-registry coverage without resolving the lane, but only as a spec 006 FR-2c/FR-2d audited override:

- an agent or guardian requests the override
- a reason is recorded
- a human confirms before execution
- the override is granted and consumed in canonical workflow history

Matching lock coverage is suspended **only after** that verified override event. The model must record an uncovered/override flag; the handoff locked-file list is stale until the next claim or rescope.

A CLI call that releases locks from `--path` or `--lane` alone, without grant/consume and human confirmation, is implementation drift and a candidate counterexample. The conformance harness must not treat that unaudited path as a valid uncovered trace.

The default invariant "every active lane has exclusive, matching lock coverage" holds on every trace that has not completed a verified spec 006 override.

## CLI Commands

All `handoff` subcommands accept `--lane <id>`:

| Command | Behavior |
|---|---|
| `btrain handoff` | Shows all lanes' status and guidance |
| `btrain handoff claim --lane a` | Claims a task on lane A |
| `btrain handoff update --lane a` | Updates lane A's state |
| `btrain handoff resolve --lane a` | Local approval or terminal resolve. Releases locks only when the lane becomes `resolved`; in PR-flow, local approval keeps locks through merge or close. `--final` is not a reviewer bypass; see `handoff resolve --final`. |
| `btrain locks` | Lists all active file locks |
| `btrain locks release --path <p>` | Force-releases a specific lock after a spec 006 audited override |
| `btrain locks release-lane --lane <id>` | Releases all locks for a lane after a spec 006 audited override |
| `btrain status` | Shows per-lane breakdown when lanes enabled |
| `btrain doctor` | Checks lane files, locks.json validity, stale locks, lock overlaps |

If `--lane` is omitted on `claim`, btrain auto-selects the first idle or resolved lane.

### Resolve, update, and claim authority

Designated 2026-09-09 (spec 015 Phase B steps 3 and 4; open questions Q5 and Q8 decided 2026-09-08):

- `handoff resolve` requires an active lane. Resolving an `idle` lane, or resolving a `resolved` lane again, is rejected (ledger findings 5 and L14).
- A plain `handoff resolve` from `ready-for-pr`, `pr-review`, `ready-to-merge`, or from `changes-requested` with a linked PR is rejected. A PR-flow lane terminates only through its PR outcome, `btrain pr poll --apply` after the PR merges or is closed (ledger finding 4).
- Either the owner or the reviewer may resolve an active lane that has not entered review or the PR flow and has no linked PR: `in-progress`, or `changes-requested` without a linked PR (spec 015 row 6; Q5, Option A).
- `handoff update` that changes only metadata (no `--status`, `--files`, `--owner`, or `--reviewer`) is a lane-agent action: the owner or the reviewer (spec 015 row 19). A `--status` equal to the lane's current status, without `--files`, `--owner`, or `--reviewer`, is the same metadata update (designated 2026-10-06): the lane keeps its status, locks, and repair assignment, and `--status repair-needed` on a `repair-needed` lane is not a new repair entry. `--status resolved` stays rejected on every lane; only `handoff resolve` enters `resolved`.
- `handoff claim` requires an `idle` or `resolved` lane in single-handoff mode as well as in lane mode; a claim over an active handoff is rejected (spec 015 L13).
- `handoff request-changes` is the recorded reviewer's action (spec 005 FR-8). An actor verified as someone other than the recorded reviewer is rejected, as today. With no recorded reviewer, or with no verifiable actor at all, the request is accepted with a `transition-advisory` (spec 015 L15) during the advisory window and rejected after it.

These rules enter spec 015 FR-5 advisory mode when the designating change merges and are enforced after the advisory window.

## Health Checks (`btrain doctor`)

When lanes are enabled, doctor validates:

- Lane handoff files exist
- `locks.json` exists and is valid JSON
- No stale locks (locks on resolved/idle lanes)
- No cross-lane lock overlaps

## Backward Compatibility

- Repos without `[lanes]` in `project.toml` work identically to before
- The original `HANDOFF.md` is preserved and still used for single-lane mode
- All existing tests (29) pass unchanged
