// The local-review gate binds a GitHub-bound revision to a recorded peer
// approval of that exact revision. These tests drive the real CLI so the
// approvals come from real `handoff resolve` events in `.btrain/events/`,
// and the revisions are real git SHAs.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  approvalIdentityProblem,
  findLocalReviewApproval,
  findLocalReviewProblem,
  enforceLocalReview,
  parseReviewedHead,
  readLaneEvents,
  shaMatches,
} from "../src/brain_train/local_review.mjs"
import { checkHandoff } from "../src/brain_train/core.mjs"
import { runPrCreate, runPrRequestReview } from "../src/brain_train/pr-flow.mjs"

const exec = promisify(execFile)
const CLI_PATH = path.resolve("src/brain_train/cli.mjs")

function cliEnv(home, agent) {
  const env = { ...process.env }
  for (const key of ["BTRAIN_AGENT", "BRAIN_TRAIN_AGENT", "BTRAIN_LANE", "BTRAIN_LANE_LOCKED", "BTRAIN_REPO", "BTRAIN_LOOP_ACTIVE"]) {
    delete env[key]
  }
  return { ...env, BRAIN_TRAIN_HOME: home, BTRAIN_NO_REVIEW_DISPATCH: "1", CI: "true", BTRAIN_AGENT: agent }
}

async function btrain(args, { cwd, home, agent = "alpha" }) {
  try {
    const result = await exec("node", [CLI_PATH, ...args], { cwd, env: cliEnv(home, agent), maxBuffer: 5 * 1024 * 1024 })
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: 0 }
  } catch (error) {
    return { stdout: error.stdout?.trim() || "", stderr: error.stderr?.trim() || "", code: typeof error.code === "number" ? error.code : 1 }
  }
}

async function git(cwd, ...args) {
  const { stdout } = await exec("git", ["-C", cwd, ...args])
  return stdout.trim()
}

const REVIEW_CONTEXT = [
  "--preflight", "read the lane files",
  "--changed", "src/a/feature.mjs - the change",
  "--verification", "node --test",
  "--verification", "- [X] code-simplifier passed",
  "--gap", "none",
  "--why", "exercise the local-review gate",
  "--review-ask", "check the gate",
]

async function commit(repo, text) {
  await fs.writeFile(path.join(repo, "src", "a", "feature.mjs"), text)
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", `change: ${text.length}`)
  return git(repo, "rev-parse", "HEAD")
}

// A PR-flow repo with lane a claimed by alpha and reviewed by beta.
async function withRepo(fn) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-local-review-")))
  const home = path.join(root, "home")
  const repo = path.join(root, "repo")
  try {
    await exec("git", ["init", "-q", "-b", "main", repo])
    await git(repo, "config", "user.email", "test@example.com")
    await git(repo, "config", "user.name", "Test Bot")
    await git(repo, "config", "commit.gpgsign", "false")
    await fs.mkdir(path.join(repo, "src", "a"), { recursive: true })
    const init = await btrain(["init", repo, "--tracked", "--agent", "alpha", "--agent", "beta", "--core-only", "--no-hooks"], { cwd: repo, home })
    assert.equal(init.code, 0, init.stderr)
    await fs.appendFile(path.join(repo, ".btrain", "project.toml"), '\n[pr_flow]\nenabled = true\nbase = "main"\n')
    await commit(repo, "export const feature = 0\n")
    // The lane works on a branch so `--base main` sees a real diff, which is
    // what the needs-review evidence gate requires.
    await git(repo, "checkout", "-q", "-b", "feat/gate")

    const claim = await btrain(["handoff", "claim", "--lane", "a", "--task", "gate lane", "--owner", "alpha", "--reviewer", "beta", "--files", "src/a/"], { cwd: repo, home })
    assert.equal(claim.code, 0, `${claim.stdout}\n${claim.stderr}`)
    const headA = await commit(repo, "export const feature = 1\n")

    await fn({ repo, home, headA })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function handOff(repo, home) {
  const review = await btrain(
    ["handoff", "update", "--lane", "a", "--status", "needs-review", "--actor", "alpha", "--base", "main", "--no-dispatch", ...REVIEW_CONTEXT],
    { cwd: repo, home },
  )
  assert.equal(review.code, 0, `${review.stdout}\n${review.stderr}`)
}

async function approve(repo, home, { sha, actor = "beta" }) {
  const summary = sha ? `approved locally\n\nReviewed-Head: ${sha}` : "approved locally"
  const result = await btrain(["handoff", "resolve", "--lane", "a", "--summary", summary, "--actor", actor], { cwd: repo, home, agent: actor })
  return result
}

async function laneA(repo) {
  const handoff = await checkHandoff(repo)
  return handoff.lanes ? handoff.lanes.find((lane) => lane._laneId === "a") : handoff.current
}

async function problemFor(repo, targetSha) {
  return findLocalReviewProblem(repo, { lane: await laneA(repo), laneId: "a", targetSha })
}

describe("local-review gate: trailer parsing and SHA equality", () => {
  it("accepts only a full object ID in the Reviewed-Head trailer", () => {
    const full = "0123456789abcdef0123456789abcdef01234567"
    assert.equal(parseReviewedHead(`looks good\n\nReviewed-Head: ${full.toUpperCase()}\n`), full)
    assert.equal(parseReviewedHead(`Reviewed-Head:\t${full}`), full)
    assert.equal(parseReviewedHead(`Reviewed-Head: ${"a".repeat(64)}`), "a".repeat(64), "sha256 object IDs are accepted")
    assert.equal(parseReviewedHead(`approved, reviewed head ${full}`), "")
    assert.equal(parseReviewedHead("Reviewed-Head: nothex0"), "")
    assert.equal(parseReviewedHead("Reviewed-Head: 9f8bbe4"), "", "an abbreviation is rejected")
    assert.equal(parseReviewedHead(`Reviewed-Head: ${full.slice(0, 39)}`), "", "39 hex is still an abbreviation")
    assert.equal(parseReviewedHead(""), "")
  })

  it("compares object IDs whole, so a shared short prefix is not a match", () => {
    const full = "9f8bbe431660e1e8899d0bd56ea4b78f452e86b6"
    // Same seven-character prefix, different commits. Prefix matching would
    // have authorized either one against an approval of the other.
    const sibling = "9f8bbe4ffffffffffffffffffffffffffffffffff".slice(0, 40)
    assert.equal(full.slice(0, 7), sibling.slice(0, 7))
    assert.equal(shaMatches(full, full), true)
    assert.equal(shaMatches(full, sibling), false)
    assert.equal(shaMatches("9f8bbe4", full), false, "an abbreviation never matches")
    assert.equal(shaMatches(full, "9f8bbe4"), false)
    assert.equal(shaMatches(full.toUpperCase(), full), true, "case is normalized")
    assert.equal(shaMatches("", full), false)
  })
})

describe("local-review gate: which approval is live", () => {
  const approval = {
    type: "resolve",
    actor: "beta",
    before: { owner: "alpha", reviewer: "beta" },
    after: { status: "ready-for-pr" },
    details: { localReviewApproved: true, summary: `ok\n\nReviewed-Head: ${"a".repeat(40)}` },
  }

  it("ignores an approval made before the current claim", () => {
    assert.equal(findLocalReviewApproval([approval]).approval, approval)
    const reclaimed = findLocalReviewApproval([approval, { type: "claim", after: { status: "in-progress" } }])
    assert.equal(reclaimed.approval, null)
    assert.match(reclaimed.reason, /since the current claim/)
  })

  it("drops an approval once a later event withdraws it", () => {
    for (const later of [
      { type: "request-changes", after: { status: "changes-requested" } },
      { type: "watchdog-repair", after: { status: "repair-needed" } },
      { type: "update", after: { status: "needs-review" } },
      { type: "update", after: { status: "changes-requested" } },
    ]) {
      assert.equal(findLocalReviewApproval([approval, later]).approval, null, `${later.type}/${later.after.status} should withdraw it`)
    }
  })

  it("keeps an approval through ordinary PR-flow movement", () => {
    for (const later of [
      { type: "update", after: { status: "pr-review" } },
      { type: "update", after: { status: "ready-to-merge" } },
    ]) {
      assert.equal(findLocalReviewApproval([approval, later]).approval, approval, `${later.after.status} should keep it`)
    }
  })

  it("rejects an approval that is not a clean peer act", () => {
    assert.equal(approvalIdentityProblem(approval, { owner: "alpha" }), "")
    assert.match(
      approvalIdentityProblem({ ...approval, actor: "alpha" }, { owner: "alpha" }),
      /self-approved/,
    )
    assert.match(
      approvalIdentityProblem({ ...approval, actor: "gamma" }, { owner: "alpha" }),
      /recorded reviewer is `beta`/,
    )
    assert.match(
      approvalIdentityProblem({ ...approval, details: { ...approval.details, "transition-advisory": "L8" } }, { owner: "alpha" }),
      /advisory resolve \(L8\)/,
    )
    assert.match(approvalIdentityProblem({ ...approval, actor: "" }, {}), /no actor/)
  })
})

describe("local-review gate: real approvals over real events", () => {
  it("accepts a genuine peer approval of the current head", async () => {
    await withRepo(async ({ repo, home, headA }) => {
      await handOff(repo, home)
      const approved = await approve(repo, home, { sha: headA })
      assert.equal(approved.code, 0, `${approved.stdout}\n${approved.stderr}`)
      assert.match(approved.stdout, /ready-for-pr/)

      const events = await readLaneEvents(repo, "a")
      const { approval } = findLocalReviewApproval(events)
      assert.ok(approval, "the resolve should be recorded as an approval")
      assert.equal(approval.actor, "beta")
      assert.equal(approval.details.localReviewApproved, true)

      assert.equal(await problemFor(repo, headA), "", "same-head peer approval should pass")
      // An abbreviation of the same commit is not accepted as the target.
      assert.match(await problemFor(repo, headA.slice(0, 7)), /but the revision bound for GitHub is/)
    })
  })

  it("refuses the head committed after the approval, with no status change at all", async () => {
    await withRepo(async ({ repo, home, headA }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA })).code, 0)
      assert.equal(await problemFor(repo, headA), "")

      // The owner commits B. The lane never leaves ready-for-pr.
      const headB = await commit(repo, "export const feature = 2\n")
      assert.notEqual(headA, headB)
      assert.equal((await laneA(repo)).status, "ready-for-pr", "status is unchanged, which is the point")

      const problem = await problemFor(repo, headB)
      assert.match(problem, /covers `/)
      assert.match(problem, new RegExp(headB))
    })
  })

  it("refuses an approval the lane owner gave themselves", async () => {
    await withRepo(async ({ repo, home, headA }) => {
      await handOff(repo, home)
      // btrain itself lets the owner resolve their own lane; it records the
      // act as an advisory rather than refusing it. The gate is what stops
      // that advisory from reaching GitHub.
      const selfApproved = await approve(repo, home, { sha: headA, actor: "alpha" })
      assert.equal(selfApproved.code, 0, `${selfApproved.stdout}\n${selfApproved.stderr}`)
      assert.equal((await laneA(repo)).status, "ready-for-pr")

      const problem = await problemFor(repo, headA)
      assert.match(problem, /does not count: it was self-approved by the lane owner `alpha`/)

      await assert.rejects(
        runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha" }),
        /needs a current local peer review first/,
      )
    })
  })

  it("withdraws the approval on bot feedback and restores it only after a fresh review", async () => {
    await withRepo(async ({ repo, home, headA }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA })).code, 0)

      const link = await btrain(["handoff", "update", "--lane", "a", "--status", "pr-review", "--pr", "7", "--actor", "alpha"], { cwd: repo, home })
      assert.equal(link.code, 0, `${link.stdout}\n${link.stderr}`)
      assert.equal(await problemFor(repo, headA), "", "linking the PR keeps the approval")

      // Bot feedback lands, the owner fixes it and relinks without a new review.
      const feedback = await btrain(
        ["handoff", "update", "--lane", "a", "--status", "changes-requested", "--reason-code", "pr-review-feedback", "--pr", "7", "--actor", "alpha"],
        { cwd: repo, home },
      )
      assert.equal(feedback.code, 0, `${feedback.stdout}\n${feedback.stderr}`)
      const headB = await commit(repo, "export const feature = 3\n")

      const relink = await btrain(["handoff", "update", "--lane", "a", "--status", "pr-review", "--pr", "7", "--actor", "alpha"], { cwd: repo, home })
      assert.equal(relink.code, 0, `${relink.stdout}\n${relink.stderr}`)
      assert.equal((await laneA(repo)).status, "pr-review", "the relink puts the lane back in a gate-passing status")

      const problem = await problemFor(repo, headB)
      assert.match(problem, /no live local peer approval/, "the relink must not revive the withdrawn approval")

      // A fresh local review of B restores it.
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headB })).code, 0)
      assert.equal(await problemFor(repo, headB), "")
    })
  })

  it("refuses an approval with no Reviewed-Head trailer and names the refresh route", async () => {
    await withRepo(async ({ repo, home, headA }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, {})).code, 0)

      const problem = await problemFor(repo, headA)
      assert.match(problem, /does not name the revision it covers/)

      await assert.rejects(
        enforceLocalReview(repo, {}, { lane: await laneA(repo), laneId: "a", targetSha: headA, stage: "`btrain pr create`" }),
        (error) => {
          // The remediation must be copyable: a real printf, not a literal
          // backslash-n that a shell would pass through as two characters.
          assert.match(error.message, /--summary "\$\(printf '<verdict>\\n\\nReviewed-Head: %s' "\$\(git rev-parse HEAD\)"\)"/)
          assert.match(error.message, /full 40-character object ID/)
          assert.match(error.message, /refreshed by those same two steps/)
          return true
        },
      )
    })
  })
})

describe("local-review gate: command paths", () => {
  it("stops `pr create` before the push when the approval is stale", async () => {
    await withRepo(async ({ repo, home, headA }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA })).code, 0)
      await commit(repo, "export const feature = 4\n")

      const before = await git(repo, "rev-parse", "HEAD")
      await assert.rejects(
        runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha" }),
        /needs a current local peer review first/,
      )
      // Nothing was pushed and no PR was linked.
      assert.equal(await git(repo, "rev-parse", "HEAD"), before)
      assert.equal((await laneA(repo)).status, "ready-for-pr")
    })
  })

  it("stops `pr request-review` on a lane whose approval was withdrawn", async () => {
    await withRepo(async ({ repo, home, headA }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA })).code, 0)
      const link = await btrain(["handoff", "update", "--lane", "a", "--status", "pr-review", "--pr", "7", "--actor", "alpha"], { cwd: repo, home })
      assert.equal(link.code, 0, `${link.stdout}\n${link.stderr}`)
      const feedback = await btrain(
        ["handoff", "update", "--lane", "a", "--status", "changes-requested", "--reason-code", "pr-review-feedback", "--pr", "7", "--actor", "alpha"],
        { cwd: repo, home },
      )
      assert.equal(feedback.code, 0, `${feedback.stdout}\n${feedback.stderr}`)

      await assert.rejects(
        runPrRequestReview(repo, { lane: "a", bots: "all" }),
        /needs a current local peer review first/,
      )
    })
  })

  it("refuses an explicit --pr that is not the lane's PR", async () => {
    await withRepo(async ({ repo, home, headA }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA })).code, 0)
      const link = await btrain(["handoff", "update", "--lane", "a", "--status", "pr-review", "--pr", "7", "--actor", "alpha"], { cwd: repo, home })
      assert.equal(link.code, 0, `${link.stdout}\n${link.stderr}`)

      await assert.rejects(
        runPrRequestReview(repo, { lane: "a", pr: "9", bots: "all" }),
        /linked to PR #7; refusing --pr 9/,
      )
    })
  })

  it("keeps `pr create` on ready-for-pr whether local_review is on or off", async () => {
    await withRepo(async ({ repo, home }) => {
      await handOff(repo, home)
      assert.equal((await laneA(repo)).status, "needs-review")

      await assert.rejects(
        runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha" }),
        /requires lane a to be in `ready-for-pr`/,
      )

      await fs.appendFile(path.join(repo, ".btrain", "project.toml"), "\n[features]\nlocal_review = false\n")
      await assert.rejects(runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha" }), (error) => {
        assert.match(error.message, /requires lane a to be in `ready-for-pr`/)
        assert.match(error.message, /does not lift this requirement/)
        return true
      })
    })
  })

  it("warns instead of refusing while local_review is off", async () => {
    await withRepo(async ({ repo, home, headA }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA })).code, 0)
      const headB = await commit(repo, "export const feature = 5\n")

      const lane = await laneA(repo)
      const context = { lane, laneId: "a", targetSha: headB, stage: "`btrain pr create`" }
      await assert.rejects(enforceLocalReview(repo, {}, context), /needs a current local peer review first/)

      const warnings = []
      await enforceLocalReview(repo, { features: { local_review: false } }, context, (line) => warnings.push(line))
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /local_review is disabled/)
      assert.match(warnings[0], /btrain features enable local_review/)
    })
  })
})

// The findings below are about what is really on the remote and really on
// GitHub, so these tests give the repo a real bare remote and a fake `gh` on
// PATH rather than asserting against local state.

// A `gh` shim that answers `pr view --json headRefOid,headRefName` from a
// JSON file the test controls, records every `pr comment` it is asked to
// post, and refuses anything else.
async function installFakeGh(root, { headRefOid, headRefName }) {
  const binDir = path.join(root, "fakebin")
  const statePath = path.join(root, "gh-head.json")
  const postedPath = path.join(root, "gh-posted.log")
  await fs.mkdir(binDir, { recursive: true })
  await fs.writeFile(statePath, JSON.stringify({ headRefOid, headRefName }))
  await fs.writeFile(
    path.join(binDir, "gh"),
    `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  cat ${JSON.stringify(statePath)}
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  echo "$@" >> ${JSON.stringify(postedPath)}
  echo "https://github.com/o/r/pull/7#issuecomment-1"
  exit 0
fi
echo "fake gh: unsupported: $@" >&2
exit 1
`,
    { mode: 0o755 },
  )
  return {
    binDir,
    async setHead(next) {
      await fs.writeFile(statePath, JSON.stringify({ headRefOid: next.headRefOid, headRefName: next.headRefName }))
    },
    async posted() {
      return fs.readFile(postedPath, "utf8").catch(() => "")
    },
  }
}

async function withPath(binDir, fn) {
  const previous = process.env.PATH
  process.env.PATH = `${binDir}${path.delimiter}${previous}`
  try {
    return await fn()
  } finally {
    process.env.PATH = previous
  }
}

// Adds a real bare remote at `origin` to the lane repo.
async function addBareRemote(repo) {
  const bare = path.join(path.dirname(repo), "remote.git")
  await exec("git", ["init", "-q", "--bare", bare])
  await git(repo, "remote", "add", "origin", bare)
  return bare
}

describe("local-review gate: the published revision, not the local one", () => {
  it("refuses --no-push when the branch is absent from the remote", async () => {
    await withRepo(async ({ repo, home, headA }) => {
      await addBareRemote(repo)
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA })).code, 0)

      await assert.rejects(
        runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha", "no-push": true }),
        (error) => {
          assert.match(error.message, /does not exist on the remote/)
          assert.match(error.message, /git push origin [0-9a-f]{40}:refs\/heads\/feat\/gate/)
          return true
        },
      )
    })
  })

  it("refuses --no-push when the published revision is not the approved one", async () => {
    await withRepo(async ({ repo, home, headA }) => {
      await addBareRemote(repo)
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA })).code, 0)
      // Someone publishes a different revision on the branch.
      const headB = await commit(repo, "export const feature = 6\n")
      await git(repo, "push", "-q", "origin", `${headB}:refs/heads/feat/gate`)
      await git(repo, "reset", "-q", "--hard", headA)

      await assert.rejects(
        runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha", "no-push": true }),
        (error) => {
          assert.match(error.message, new RegExp(`is at ${headB}`))
          assert.match(error.message, new RegExp(`approved ${headA}`))
          assert.match(error.message, /no reviewer has approved/)
          return true
        },
      )
    })
  })

  it("pushes the approved object by name rather than the branch tip", async () => {
    await withRepo(async ({ repo, home, headA }) => {
      const bare = await addBareRemote(repo)
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA })).code, 0)

      // runPrCreate reaches `gh pr create` with no gh installed; the push and
      // the remote check have already happened by then.
      await assert.rejects(runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha" }))

      const published = await git(bare, "rev-parse", "refs/heads/feat/gate")
      assert.equal(published, headA, "the approved object is what reached the remote")
    })
  })
})

describe("local-review gate: GitHub's head authorizes each bot request", () => {
  it("refuses to post when GitHub's head is not the approved revision", async () => {
    await withRepo(async ({ repo, home, headA }) => {
      const root = path.dirname(repo)
      await addBareRemote(repo)
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA })).code, 0)
      const link = await btrain(["handoff", "update", "--lane", "a", "--status", "pr-review", "--pr", "7", "--actor", "alpha"], { cwd: repo, home })
      assert.equal(link.code, 0, `${link.stdout}\n${link.stderr}`)

      // GitHub is on some other revision. The local checkout and the local
      // tracking cache know nothing about it.
      const other = "b".repeat(40)
      const gh = await installFakeGh(root, { headRefOid: other, headRefName: "feat/gate" })
      await withPath(gh.binDir, async () => {
        await assert.rejects(
          runPrRequestReview(repo, { lane: "a", bots: "all" }),
          (error) => {
            assert.match(error.message, new RegExp(`GitHub has PR #7 at ${other}`))
            assert.match(error.message, new RegExp(`this checkout is on ${headA}`))
            return true
          },
        )
      })
      assert.equal(await gh.posted(), "", "nothing may be posted while the two disagree")
    })
  })

  it("posts against GitHub's head, not a stale local tracking ref", async () => {
    await withRepo(async ({ repo, home, headA }) => {
      const root = path.dirname(repo)
      await addBareRemote(repo)
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA })).code, 0)
      const link = await btrain(["handoff", "update", "--lane", "a", "--status", "pr-review", "--pr", "7", "--actor", "alpha"], { cwd: repo, home })
      assert.equal(link.code, 0, `${link.stdout}\n${link.stderr}`)

      // Push A, so the tracking cache says A, then move GitHub to B. A gate
      // that trusted the tracking ref would authorize A and post about it.
      await git(repo, "push", "-q", "-u", "origin", "feat/gate")
      const headB = await commit(repo, "export const feature = 7\n")
      await git(repo, "reset", "-q", "--hard", headA)
      assert.equal(await git(repo, "rev-parse", "refs/remotes/origin/feat/gate"), headA)

      const gh = await installFakeGh(root, { headRefOid: headB, headRefName: "feat/gate" })
      await withPath(gh.binDir, async () => {
        await assert.rejects(
          runPrRequestReview(repo, { lane: "a", bots: "all" }),
          /GitHub has PR #7 at /,
          "the stale tracking ref must not authorize the post",
        )
      })
      assert.equal(await gh.posted(), "")

      // Approve what GitHub actually has, and move the checkout onto it.
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headB })).code, 0)
      await btrain(["handoff", "update", "--lane", "a", "--status", "pr-review", "--pr", "7", "--actor", "alpha"], { cwd: repo, home })
      await git(repo, "reset", "-q", "--hard", headB)

      await withPath(gh.binDir, async () => {
        const posted = await runPrRequestReview(repo, { lane: "a", bots: "all" })
        assert.ok(posted.length > 0, "a current approval of GitHub's head posts")
      })
      const log = await gh.posted()
      assert.match(log, new RegExp(`head=${headB}`), "the marker records GitHub's head")
      assert.doesNotMatch(log, new RegExp(`head=${headA}`))
    })
  })
})
