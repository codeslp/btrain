---
name: mutation-round
description: Run a hand-driven mutation round on a lane's changed source to find guards that no test protects. Use when you review a lane whose code or comments call a guard load-bearing, when a review asks whether the tests would catch a regression, before you approve a change to validation, parsing, auth, config fallbacks, or error handling, and when a writer must pin the survivors of an earlier round. Produces a numbered mutant table and one P2 finding that lists every survivor with a test that would kill it.
---

# Mutation Round

## Goal

Show that the tests fail when the code is wrong. Change one thing at a time in the lane's source and run the suites. Each change that the suites do not notice is a guard that no test protects.

## Rules

- Mutate the source under review, not the tests.
- Work in a throwaway worktree at the lane head. Never stash, reset, check out, or edit files in the author's tree.
- Make one change per mutant, and run each mutant alone.
- Start from a green baseline. If the baseline fails, stop. A red baseline makes every result meaningless.

## Workflow

1. **Pick the targets.** List the lane's changed files with `git diff --name-only <base>...<head>` and drop the tests. Start with the guards that the code, its comments, or the handoff call load-bearing. Then add the other changed branches.
2. **Make the throwaway worktree.**

   ```bash
   git worktree add --detach "${TMPDIR:-/tmp}/mut-<lane>" <lane-head-sha>
   ```

   Install its dependencies there, for example with `npm ci`, or in a venv for Python. Do not run an installer through a symlinked `node_modules`. When you finish, remove the worktree with `git worktree remove --force "${TMPDIR:-/tmp}/mut-<lane>"`.

   If you may not add a worktree, for example because a lane rule keeps you out of the shared `.git`, extract a snapshot instead: `mkdir -p "${TMPDIR:-/tmp}/mut-<lane>" && git archive <lane-head-sha> | tar -x -C "${TMPDIR:-/tmp}/mut-<lane>"`. A snapshot has no git, so keep a copy of each original file to restore it.
3. **Record the baseline.** Find every suite that imports each target, not only the sibling test, for example with `rg -l "<module name>" test/`. Run them. Record the command, the pass count, and the time. That command is the kill check for every mutant.
4. **Write the mutants.** Before you run any, write 15 to 30 numbered mutants, M1 to Mn. Give each one a location, the original code, and the change. Use these operators:
   - Negate a guard: `if (!x)` to `if (x)`, or to `if (false)`.
   - Flip a boundary: `>` to `>=`, `< n` to `<= n`, or off by one.
   - Drop a filter, an early `return`, or a `continue`.
   - Loosen a regex: drop an anchor, change `+` to `*`, or strip the input before the test.
   - Drop a config or environment fallback.
   - Swallow an error: a `catch` that returns a default, or a removed `throw`.
   - Reverse a sort or a comparison.
5. **Run each mutant alone.** Apply it, run the baseline command, and restore the file with `git checkout -- <file>`, in the throwaway worktree only: in the author's tree that command destroys their uncommitted edits. Check that `git status` is clean before the next mutant.
   - Keep each mutant as an exact triple: the file, the original text, and the replacement. Refuse a mutant whose original text does not match exactly once, because an ambiguous match changes the wrong line.
   - A fail-fast run (for example `pytest -x`) is enough to mark a kill. The revert check in step 7 needs the full run.

   Mark each mutant:
   - **killed**: at least one test failed.
   - **survived**: every test passed.
   - **equivalent**: no input can change the behavior. Give the reason.
   - **timed out**: the run took more than about three times the baseline. Report it as timed out, not as killed.
6. **Report the survivors as one P2.** Give the score first, for example "24 mutants, 18 killed, 4 survived, 2 equivalent". Then give each survivor, most serious first: its ID, the location, the change, why it matters, and a test that would kill it.
   - For "why it matters", check whether the guard is load-bearing on real data, not only in the fixtures.
   - When a survivor looks impossible, look for a second path that fails first and masks it.
7. **Pin each survivor (author).** Add one test per survivor. Start its comment with the mutant ID, and say why the mutant survived:

   ```js
   // M22. The only "no reading" test used a missing directory, which returns two branches earlier.
   ```

   In Python, use `# M22. ...`.

   Commit the pinning tests before you revert-check them. Then make a throwaway worktree at that commit (or a snapshot, as in step 2), never your own tree:

   ```bash
   git worktree add --detach "${TMPDIR:-/tmp}/revert-<lane>" <pin-sha>
   ```

   There, apply each survivor's mutant again, run the suites, and confirm that only its new test fails. Then remove the worktree. Your own tree never holds a mutant, so it has nothing to restore.
8. **Record the result** in the handoff with `--verification`, for example:

   ```bash
   --verification "mutation round on src/x.mjs: M1-M24, 18 killed, 4 survived and pinned by 4 revert-checked tests, 2 equivalent"
   ```

## Default output

- Targets and baseline: command, pass count, time
- Mutant table: ID, location, change, result
- One P2 with every survivor, most serious first
- The `--verification` line

## Failure mode (anti-example)

Bad: "Ran mutation testing, and most mutants were killed." It has no IDs and no survivors, so nobody can check it.

Also bad: a survivor "pinned" by a test that still passes when the mutant is applied again. The revert check exists to catch this.

## Worked examples (btrain repo)

- `test/context_budget.test.mjs`, the block "guards the earlier rounds left unpinned": M5, M18, and M23 get one test each, and each comment says why the mutant survived.
- `test/cgraph-wiring.test.mjs`: a narrowed catch-all "survived all 51 tests", because every suite that reached it degraded for another reason first.

## Validation prompts

- "Run a mutation round on lane b's parser" → a throwaway worktree, a recorded baseline, M1 to Mn written before any run, and one P2 that lists every survivor.
- "Would the tests catch it if this guard were removed?" → the guard is among the first mutants, with its result and the kill-check command.
- "Pin the survivors from the last round" → one test per survivor with a `// Mn.` comment, each one revert-checked.
