---
name: red-team
description: Attack a change to make it fail instead of reviewing it. Use when you hold the red_team role in an agentchattr code-review session, when a lane, reviewer, or user asks for a red-team, adversarial, or try-to-break-it pass, and before you approve a change to auth, identity, validation, concurrency, or persistence. Produces failing repros (tests or exact commands) or the list of attacks that did not break it, never a restated review.
---

# Red Team

## Goal

Find an input, a state, or an interleaving that makes the change fail, and prove it with a repro. A reviewer asks whether the change is right. The red team asks how to make it fail.

In an agentchattr code-review session, the red team speaks after the reviewer in the Review phase. The session prompt for that turn is the short form of this skill.

## Rules

- Do not red-team your own work. agentchattr refuses to start a session that casts one agent, or one person, as both `builder` and `red_team`, in any template that has both roles. It cannot recognize the same two jobs under other role names, so check the cast yourself. In btrain, do not red-team a lane that you own.
- Do not restate the review. If the reviewer already found an issue, skip it, or add the repro that the review did not have.
- Work in a throwaway worktree, never in the author's tree: `git worktree add --detach "${TMPDIR:-/tmp}/red-team-<lane>" <lane-head-sha>`. Hand over each repro as a file or a patch. Never write untracked files into the author's tree.
- Do not edit the author's locked files. Put each repro in a new test file outside the lane's locks, or put the exact command and input in the review summary.
- Do not keep a repro under `.btrain/`. That directory is gitignored, so the writer and CI cannot run what is in it.

## Workflow

1. Read the change: the lane diff against its base, the handoff `Why` and review asks, and each comment that calls a guard load-bearing.
2. Write down 3 to 5 attacks before you run anything. Take them from these classes:
   - **Authority and identity.** A different actor, agent, lane, or template does the action. An identity field is missing or spoofed. The server trusts a value that the client sent.
   - **Boundaries.** Empty, one, the cap, the cap plus one, zero, negative, the wrong type, a missing key, a duplicate, a very long value, non-ASCII text.
   - **Every early return and exit.** List each `return`, `throw`, `raise`, `continue`, and `catch` in the touched functions. Find an input that reaches each one. Check what the caller sees: an error, a silent pass, or a default that looks like success.
   - **Interleavings and concurrency.** Two writers at once. A retry after a partial write. A timer or callback that fires after the state changed. Two sessions or lanes on the same resource.
   - **Save, reload, restart.** Persist the state, restart the process, and load it again. Check that the state survives, that nothing fires twice, and that work resumes at the right step.
3. Run each attack. Record the input, the expected result, the actual result, and the command.
4. Turn each failure into a repro that fails now:
   - Best: a test in a new file, written and run in your throwaway worktree, at a path outside the lane's locks, for example `test/<area>-red-team.test.mjs` or `agentchattr/tests/test_<area>_red_team.py`. Show the failure. Hand it over as the file, or as a patch that you make there with `git add -N <file>` and `git diff`.
   - Otherwise: the exact command, input, and output in the review summary, so that the writer can turn it into a test.
5. Give the verdict. When the writer has every repro, remove the worktree with `git worktree remove --force "${TMPDIR:-/tmp}/red-team-<lane>"`.

## If something breaks

1. In a btrain lane, request changes with the red-team tag:

   ```bash
   btrain handoff request-changes --lane <id> --reason-code regression-risk --reason-tag red-team \
     --summary "<one line per finding>" --actor "<assigned reviewer>"
   ```

   Only the lane's assigned reviewer can request changes. If that is not you, give the findings to the assigned reviewer and say who found them.

   In an agentchattr session, post the findings in the session channel. The builder answers them in the Respond phase.
2. For each finding, give the severity (P1, P2, or P3), the location, the repro, and why it matters.
3. The writer's first repair commit adds the repro as a test and shows it failing. The fix follows in a later commit, so that the review can see the test fail before the fix and pass after it.

## If nothing breaks

Say so, and list each attack that you tried: its class, the input, and the result. "Looks fine" without that list is not a red-team pass.

## Default output

- Attacks tried: class, input, result
- Findings: severity, location, repro (test path or exact command), why it matters
- Verdict: request changes (`regression-risk`, tag `red-team`), or no break found, with the attack list

## Failure mode (anti-example)

Bad: "Validation looks thin in places. Consider more tests." It has no input and no repro, and it restates the review.

Good: "P2. A blank `hard_ceiling = ""` reads as 0, and 0 disables the hard block. Repro: `test/context-budget-red-team.test.mjs`, test 'blank ceiling', expects 400000 and gets 0."

## Validation prompts

- "You are red_team in this code-review session" → attacks written down before any run, a repro for each break, and no restated review.
- "Red-team lane c before I approve it" → a failing test outside the lane's locks, and `request-changes` with `regression-risk` and the `red-team` tag.
- "Try to break the new rate limiter", and nothing breaks → the attack list with inputs and results, and no invented findings.
