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
  canonicalRepoIdentity,
  findLocalReviewApproval,
  findLocalReviewProblem,
  enforceLocalReview,
  normalizeReviewTarget,
  parseReviewedBase,
  parseReviewedHead,
  readLaneEvents,
  shaMatches,
} from "../src/brain_train/local_review.mjs"
import { checkHandoff } from "../src/brain_train/core.mjs"
import {
  ghRepoArgs,
  ghRepoFlagFor,
  prCreateHeadSpec,
  redactRemoteUrl,
  resolvePrRepository,
  restIdentityFor,
  runPrCreate,
  runPrPoll,
  runPrRequestReview,
} from "../src/brain_train/pr-flow.mjs"

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

// A PR-flow repo with lane a claimed by alpha and reviewed by beta, and a
// real bare `origin` carrying `main`. The gate reads the base off the remote
// on every path, so a repo without one cannot exercise it.
async function withRepo(fn) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-local-review-")))
  const home = path.join(root, "home")
  const repo = path.join(root, "repo")
  const bare = path.join(root, "remote.git")
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
    await exec("git", ["init", "-q", "--bare", "-b", "main", bare])
    await git(repo, "remote", "add", "origin", bare)
    await git(repo, "push", "-q", "origin", "main")
    // The lane works on a branch so `--base main` sees a real diff, which is
    // what the needs-review evidence gate requires.
    await git(repo, "checkout", "-q", "-b", "feat/gate")

    const claim = await btrain(["handoff", "claim", "--lane", "a", "--task", "gate lane", "--owner", "alpha", "--reviewer", "beta", "--files", "src/a/"], { cwd: repo, home })
    assert.equal(claim.code, 0, `${claim.stdout}\n${claim.stderr}`)
    const headA = await commit(repo, "export const feature = 1\n")

    await fn({ repo, home, headA, bare, base: await baseTarget(bare) })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

// What the gate should compute for a bare remote: `path:<dir>` without the
// `.git`, the base ref, and the object that ref is at on the remote itself.
async function baseTarget(bare, ref = "main") {
  return {
    repo: `path:${bare.replace(/\.git$/, "")}`,
    ref,
    sha: await git(bare, "rev-parse", `refs/heads/${ref}`),
  }
}

async function handOff(repo, home) {
  const review = await btrain(
    ["handoff", "update", "--lane", "a", "--status", "needs-review", "--actor", "alpha", "--base", "main", "--no-dispatch", ...REVIEW_CONTEXT],
    { cwd: repo, home },
  )
  assert.equal(review.code, 0, `${review.stdout}\n${review.stderr}`)
}

// `base: null` drops the Reviewed-Base trailer, `sha: ""` drops Reviewed-Head.
async function approve(repo, home, { sha, base, actor = "beta" }) {
  const lines = ["approved locally", ""]
  if (sha) lines.push(`Reviewed-Head: ${sha}`)
  if (base) lines.push(`Reviewed-Base: ${base.repo} ${base.ref} ${base.sha}`)
  const result = await btrain(
    ["handoff", "resolve", "--lane", "a", "--summary", lines.join("\n"), "--actor", actor],
    { cwd: repo, home, agent: actor },
  )
  return result
}

async function laneA(repo) {
  const handoff = await checkHandoff(repo)
  return handoff.lanes ? handoff.lanes.find((lane) => lane._laneId === "a") : handoff.current
}

async function problemFor(repo, targetSha, targetBase) {
  return findLocalReviewProblem(repo, { lane: await laneA(repo), laneId: "a", targetSha, targetBase })
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

  it("parses the Reviewed-Base trailer into repository, ref and object ID", () => {
    const oid = "c".repeat(40)
    assert.deepEqual(
      parseReviewedBase(`ok\n\nReviewed-Head: ${"a".repeat(40)}\nReviewed-Base: github.com/codeslp/btrain main ${oid}\n`),
      { repo: "github.com/codeslp/btrain", ref: "main", sha: oid },
    )
    assert.deepEqual(
      parseReviewedBase(`Reviewed-Base:\thttps://github.com/Codeslp/BTrain.git\trelease/2.x\t${oid.toUpperCase()}`),
      { repo: "github.com/codeslp/btrain", ref: "release/2.x", sha: oid },
      "a URL and a mixed-case host normalize to the same identity",
    )
    assert.equal(parseReviewedBase(`Reviewed-Base: github.com/codeslp/btrain main ${oid.slice(0, 7)}`), null, "an abbreviation is rejected")
    assert.equal(parseReviewedBase("Reviewed-Base: github.com/codeslp/btrain main"), null, "a missing field is rejected")
    assert.equal(parseReviewedBase(`Reviewed-Base: origin main ${oid}`), null, "a remote name is not a repository identity")
    assert.equal(parseReviewedBase(`approved against main ${oid}`), null)
    assert.equal(parseReviewedBase(""), null)
  })

  it("gives one canonical identity per repository, and none for a non-repository", () => {
    for (const form of [
      "github.com/codeslp/btrain",
      "https://github.com/codeslp/btrain.git",
      "https://github.com/codeslp/btrain/",
      "git@github.com:codeslp/btrain.git",
      "ssh://git@github.com/codeslp/btrain",
      "GitHub.com/codeslp/BTrain",
    ]) {
      assert.equal(canonicalRepoIdentity(form), "github.com/codeslp/btrain", form)
    }
    assert.notEqual(
      canonicalRepoIdentity("git@ghe.internal:codeslp/btrain.git"),
      canonicalRepoIdentity("git@github.com:codeslp/btrain.git"),
      "the same slug on another host is another repository",
    )
    assert.notEqual(
      canonicalRepoIdentity("https://github.com/someone-else/btrain"),
      canonicalRepoIdentity("https://github.com/codeslp/btrain"),
      "the same name under another owner is another repository",
    )
    assert.equal(canonicalRepoIdentity("/srv/git/btrain.git"), "path:/srv/git/btrain")
    assert.equal(canonicalRepoIdentity("file:///srv/git/btrain.git"), "path:/srv/git/btrain")
    assert.equal(canonicalRepoIdentity("path:/srv/git/btrain"), "path:/srv/git/btrain")
    for (const notARepo of ["", "   ", "origin", "upstream", "http://"]) {
      assert.equal(canonicalRepoIdentity(notARepo), "", JSON.stringify(notARepo))
    }
  })

  it("accepts a target only when all four facts are known", () => {
    const oid = "d".repeat(40)
    assert.deepEqual(
      normalizeReviewTarget({ repo: "https://github.com/codeslp/btrain", ref: "main", sha: oid.toUpperCase() }),
      { repo: "github.com/codeslp/btrain", ref: "main", sha: oid },
    )
    assert.equal(normalizeReviewTarget({ repo: "", ref: "main", sha: oid }), null)
    assert.equal(normalizeReviewTarget({ repo: "github.com/codeslp/btrain", ref: "", sha: oid }), null)
    assert.equal(normalizeReviewTarget({ repo: "github.com/codeslp/btrain", ref: "main", sha: "d".repeat(7) }), null)
    assert.equal(normalizeReviewTarget({}), null)
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

  it("keeps an approval across a bookkeeping event that records no state", () => {
    // `history-compact` archives old handoff entries. It carries no `after`
    // at all, and the lane does not move; reading the missing snapshot as a
    // move to "" would retire a live approval over a cleanup run.
    const compact = {
      type: "history-compact",
      actor: "btrain hcleanup",
      laneId: "a",
      details: { keep: 1, archivedCount: 2, keptCount: 1 },
    }
    assert.equal(findLocalReviewApproval([approval, compact]).approval, approval)
    assert.equal(
      findLocalReviewApproval([approval, compact, { type: "update", after: { status: "pr-review" } }]).approval,
      approval,
      "compaction between PR-flow moves changes nothing",
    )
    // Withdrawal still works on both routes: an explicit withdrawal type
    // even without a snapshot, and a recorded move out of the PR flow.
    assert.equal(findLocalReviewApproval([approval, compact, { type: "claim" }]).approval, null)
    assert.equal(
      findLocalReviewApproval([approval, compact, { type: "request-changes", details: {} }]).approval,
      null,
      "an explicit withdrawal event needs no snapshot to count",
    )
    const moved = findLocalReviewApproval([approval, compact, { type: "update", after: { status: "needs-review" } }])
    assert.equal(moved.approval, null)
    assert.match(moved.reason, /moved to `needs-review`/)
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
    await withRepo(async ({ repo, home, headA, base }) => {
      await handOff(repo, home)
      const approved = await approve(repo, home, { sha: headA, base })
      assert.equal(approved.code, 0, `${approved.stdout}\n${approved.stderr}`)
      assert.match(approved.stdout, /ready-for-pr/)

      const events = await readLaneEvents(repo, "a")
      const { approval } = findLocalReviewApproval(events)
      assert.ok(approval, "the resolve should be recorded as an approval")
      assert.equal(approval.actor, "beta")
      assert.equal(approval.details.localReviewApproved, true)

      assert.equal(await problemFor(repo, headA, base), "", "same-head peer approval should pass")
      // An abbreviation of the same commit is not accepted as the target.
      assert.match(await problemFor(repo, headA.slice(0, 7), base), /but the revision bound for GitHub is/)
    })
  })

  it("refuses the head committed after the approval, with no status change at all", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base })).code, 0)
      assert.equal(await problemFor(repo, headA, base), "")

      // The owner commits B. The lane never leaves ready-for-pr.
      const headB = await commit(repo, "export const feature = 2\n")
      assert.notEqual(headA, headB)
      assert.equal((await laneA(repo)).status, "ready-for-pr", "status is unchanged, which is the point")

      const problem = await problemFor(repo, headB, base)
      assert.match(problem, /covers `/)
      assert.match(problem, new RegExp(headB))
    })
  })

  it("refuses an approval the lane owner gave themselves", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await handOff(repo, home)
      // btrain itself lets the owner resolve their own lane; it records the
      // act as an advisory rather than refusing it. The gate is what stops
      // that advisory from reaching GitHub.
      const selfApproved = await approve(repo, home, { sha: headA, base, actor: "alpha" })
      assert.equal(selfApproved.code, 0, `${selfApproved.stdout}\n${selfApproved.stderr}`)
      assert.equal((await laneA(repo)).status, "ready-for-pr")

      const problem = await problemFor(repo, headA, base)
      assert.match(problem, /does not count: it was self-approved by the lane owner `alpha`/)

      await assert.rejects(
        runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha" }),
        /needs a current local peer review first/,
      )
    })
  })

  it("withdraws the approval on bot feedback and restores it only after a fresh review", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base })).code, 0)

      const link = await btrain(["handoff", "update", "--lane", "a", "--status", "pr-review", "--pr", "7", "--actor", "alpha"], { cwd: repo, home })
      assert.equal(link.code, 0, `${link.stdout}\n${link.stderr}`)
      assert.equal(await problemFor(repo, headA, base), "", "linking the PR keeps the approval")

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

      const problem = await problemFor(repo, headB, base)
      assert.match(problem, /no live local peer approval/, "the relink must not revive the withdrawn approval")

      // A fresh local review of B restores it.
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headB, base })).code, 0)
      assert.equal(await problemFor(repo, headB, base), "")
    })
  })

  it("refuses an approval with no trailers and names the refresh route", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, {})).code, 0)

      assert.match(await problemFor(repo, headA, base), /does not name the revision it covers/)

      await assert.rejects(
        enforceLocalReview(repo, {}, { lane: await laneA(repo), laneId: "a", targetSha: headA, targetBase: base, stage: "`btrain pr create`" }),
        (error) => {
          // The remediation must be copyable: a real printf, not a literal
          // backslash-n that a shell would pass through as two characters,
          // and it must carry the live target on the Reviewed-Base line.
          assert.match(error.message, /--summary "\$\(printf '<verdict>\\n\\nReviewed-Head: %s\\nReviewed-Base: /)
          assert.match(error.message, new RegExp(`Reviewed-Base: ${base.repo} ${base.ref} ${base.sha}'`))
          assert.match(error.message, /"\$\(git rev-parse HEAD\)"\)"/)
          assert.match(error.message, /full 40-character IDs/)
          assert.match(error.message, /refreshed by those same two steps/)
          return true
        },
      )
    })
  })

  it("keeps a real approval alive across a history compaction of the lane log", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base })).code, 0)
      assert.equal(await problemFor(repo, headA, base), "")

      // The event `compactLaneHandoffHistory` appends when `btrain hcleanup`,
      // `btrain doctor` or the watchdog archives old handoff entries: lane
      // bookkeeping, with no `before`/`after` state at all. (A PR-flow lane
      // never reaches the terminal resolve that writes the handoff entries
      // compaction consumes, so the event is written here directly, in the
      // shape core.mjs emits.)
      const logPath = path.join(repo, ".btrain", "events", "lane-a.jsonl")
      await fs.appendFile(logPath, `${JSON.stringify({
        version: 1,
        recordedAt: new Date().toISOString(),
        type: "history-compact",
        actor: "btrain hcleanup",
        laneId: "a",
        details: { keep: 1, archivedCount: 2, keptCount: 1, archivePath: "archive.md", handoffPath: "HANDOFF_A.md" },
      })}\n`)

      const events = await readLaneEvents(repo, "a")
      const compaction = events.filter((event) => event.type === "history-compact")
      assert.equal(compaction.length, 1)
      assert.equal(compaction[0].after, undefined, "the regression only bites while compaction records no snapshot")

      assert.equal((await laneA(repo)).status, "ready-for-pr", "compaction does not move the lane")
      assert.equal(await problemFor(repo, headA, base), "", "cleanup must not retire the approval")
    })
  })

  it("refuses an approval that names a head but no base", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA })).code, 0)

      const problem = await problemFor(repo, headA, base)
      assert.match(problem, /does not name the base it was read against/)
      assert.match(problem, /Reviewed-Base: <repository> <base ref> <base object ID>/)
    })
  })
})

describe("local-review gate: command paths", () => {
  it("stops `pr create` before the push when the approval is stale", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base })).code, 0)
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
    await withRepo(async ({ repo, home, headA, base }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base })).code, 0)
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
    await withRepo(async ({ repo, home, headA, base }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base })).code, 0)
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
    await withRepo(async ({ repo, home, headA, base }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base })).code, 0)
      const headB = await commit(repo, "export const feature = 5\n")

      const lane = await laneA(repo)
      const context = { lane, laneId: "a", targetSha: headB, targetBase: base, stage: "`btrain pr create`" }
      await assert.rejects(enforceLocalReview(repo, {}, context), /needs a current local peer review first/)

      const warnings = []
      await enforceLocalReview(repo, { features: { local_review: false } }, context, (line) => warnings.push(line))
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /local_review is disabled/)
      assert.match(warnings[0], /btrain features enable local_review/)
    })
  })
})

// The findings below are about what is really published and what GitHub
// really has, so these tests use real bare remotes and a fake `gh` on PATH
// rather than asserting against local state.

// A `gh` shim that answers `pr view --json ...` from a JSON file the test
// controls, records every `pr comment` it is asked to post, and refuses
// anything else.
//
// It resolves the repository a `pr` subcommand is about the way gh does: the
// `--repo` on the command when there is one, otherwise `GH_REPO`, otherwise
// the checkout's default. REST reads carry their repository in the endpoint
// instead. Only the one repository below holds PR #7, so a call that lands on
// another fails the way the real gh does rather than quietly answering about
// something else.
//
// Every invocation is logged as one line: the subcommand plus the `--repo`
// and `--hostname` it carried. Bodies are left out — they are multi-line, and
// what these tests assert on is where a call went.
async function installFakeGh(root, pr, { host = "github.com/o/r" } = {}) {
  const binDir = path.join(root, "fakebin")
  const statePath = path.join(root, "gh-head.json")
  const postedPath = path.join(root, "gh-posted.log")
  const invokedPath = path.join(root, "gh-invoked.log")
  await fs.mkdir(binDir, { recursive: true })
  const write = (next) => fs.writeFile(statePath, JSON.stringify({ url: `https://${host}/pull/7`, ...next }))
  await write(pr)
  const q = (value) => JSON.stringify(value)
  await fs.writeFile(
    path.join(binDir, "gh"),
    `#!/bin/sh
repo=""
line="$1 $2"
prev=""
for arg in "$@"; do
  case "$prev" in
    --repo) repo="$arg"; line="$line --repo $arg" ;;
    --hostname) line="$line --hostname $arg" ;;
  esac
  prev="$arg"
done
echo "$line" >> ${q(invokedPath)}
if [ "$1" = "--version" ]; then echo "gh version 2.0.0 (fake)"; exit 0; fi
# A REST read names its repository in the endpoint, never with --repo.
if [ "$1" = "api" ]; then
  case "$2" in
    repos/${host.split("/").slice(1).join("/")}/*) echo "[]"; exit 0 ;;
    *) echo "fake gh: no such repository: $2" >&2; exit 1 ;;
  esac
fi
[ -n "$repo" ] || repo="\${GH_REPO:-${host}}"
# A PR is opened wherever gh resolved, and its URL says where that was.
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo "https://$repo/pull/7"
  exit 0
fi
if [ "$repo" != ${q(host)} ]; then
  echo "fake gh: no such pull request in $repo" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  cat ${q(statePath)}
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  echo "$@" >> ${q(postedPath)}
  echo "https://${host}/pull/7#issuecomment-1"
  exit 0
fi
echo "fake gh: unsupported: $@" >&2
exit 1
`,
    { mode: 0o755 },
  )
  return {
    binDir,
    setPr: write,
    async posted() {
      return fs.readFile(postedPath, "utf8").catch(() => "")
    },
    async invocations() {
      const log = await fs.readFile(invokedPath, "utf8").catch(() => "")
      return log.split("\n").filter(Boolean)
    },
  }
}

// `gh pr create` opens the PR on the repository the gate authorized, but
// nothing afterwards knows which one that was unless it is carried: the
// alternate default below is what the plain `gh pr view <number>` of the old
// code would have asked about.
const OTHER_DEFAULT_REPO = "github.com/other/elsewhere"

async function withEnv(vars, fn) {
  const previous = {}
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key]
    process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// A remote that names a GitHub repository rather than the test's bare path,
// so the lane resolves a repository `gh --repo` can be pointed at. The bot
// paths never contact it: they read its URL and ask GitHub everything else.
async function addGitHubBaseRemote(repo, url = "https://github.com/o/r.git") {
  await git(repo, "remote", "add", "upstream", url)
}

// One file per lane, PR and claim, so counting them is how a test sees
// whether an association was written and how many times.
async function prAssociationFiles(repo) {
  const dir = path.join(repo, ".btrain", "pr-flow")
  const names = await fs.readdir(dir).catch(() => [])
  return names.sort().map((name) => path.join(dir, name))
}

// A lane sitting at `pr-review` on PR #7, approved for GitHub's own target.
async function linkApprovedPr(repo, home, { headA, base }) {
  await handOff(repo, home)
  assert.equal((await approve(repo, home, { sha: headA, base: ghBase(base) })).code, 0)
  const link = await btrain(
    ["handoff", "update", "--lane", "a", "--status", "pr-review", "--pr", "7", "--actor", "alpha"],
    { cwd: repo, home },
  )
  assert.equal(link.code, 0, `${link.stdout}\n${link.stderr}`)
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

// On the bot path the gate authorizes against what GitHub reports, so the
// reviewer's approval names the PR's own repository rather than the bare
// remote the test pushes through.
const GH_REPO = "github.com/o/r"

function ghBase(base, ref = "main") {
  return { repo: GH_REPO, ref, sha: base.sha }
}

// A PR on GitHub whose repository, base and head all match what the lane
// reviewed. Individual tests move one fact at a time.
function prOn(base, headRefOid) {
  return {
    headRefOid,
    headRefName: "feat/gate",
    baseRefName: "main",
    baseRefOid: base.sha,
    url: "https://github.com/o/r/pull/7",
  }
}

describe("local-review gate: the published revision, not the local one", () => {
  it("refuses --no-push when the branch is absent from the destination", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base })).code, 0)

      await assert.rejects(
        runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha", "no-push": true }),
        (error) => {
          assert.match(error.message, /does not have the branch/)
          assert.match(error.message, /git push origin [0-9a-f]{40}:refs\/heads\/feat\/gate/)
          return true
        },
      )
    })
  })

  it("refuses --no-push when the published revision is not the approved one", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base })).code, 0)
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
    await withRepo(async ({ repo, home, headA, base, bare }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base })).code, 0)

      // runPrCreate reaches `gh pr create` with no gh installed; the push and
      // the published-revision check have already happened by then.
      await assert.rejects(runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha" }))

      const published = await git(bare, "rev-parse", "refs/heads/feat/gate")
      assert.equal(published, headA, "the approved object is what reached the remote")
    })
  })

  it("verifies the destination the push writes to, not the fetch URL", async () => {
    await withRepo(async ({ repo, home, headA, base, bare }) => {
      // origin fetches from `bare` and pushes to `pushBare`. A check that
      // read the fetch URL would look at the wrong repository entirely.
      const pushBare = path.join(path.dirname(bare), "push-remote.git")
      await exec("git", ["init", "-q", "--bare", "-b", "main", pushBare])
      await git(repo, "remote", "set-url", "--push", "origin", pushBare)

      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base })).code, 0)
      await assert.rejects(runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha" }))

      assert.equal(
        await git(pushBare, "rev-parse", "refs/heads/feat/gate"),
        headA,
        "the push went to the push URL",
      )
      await assert.rejects(
        git(bare, "rev-parse", "refs/heads/feat/gate"),
        "the fetch URL never received the branch, which is what makes the check meaningful",
      )
    })
  })

  it("refuses when a second push URL carries a different revision", async () => {
    await withRepo(async ({ repo, home, headA, base, bare }) => {
      // Two push URLs: git pushes to both, so both have to carry the
      // approved revision before a PR may be opened on the branch.
      const mirror = path.join(path.dirname(bare), "mirror.git")
      await exec("git", ["init", "-q", "--bare", "-b", "main", mirror])
      await git(repo, "remote", "set-url", "--push", "origin", bare)
      await git(repo, "remote", "set-url", "--push", "--add", "origin", mirror)
      // The first destination has the approved revision; the mirror already
      // holds someone else's work on the same branch.
      await git(repo, "push", "-q", bare, `${headA}:refs/heads/feat/gate`)
      const foreign = await commit(repo, "export const feature = 99\n")
      await git(repo, "push", "-q", mirror, `${foreign}:refs/heads/feat/gate`)
      await git(repo, "reset", "-q", "--hard", headA)

      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base })).code, 0)

      await assert.rejects(
        runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha", "no-push": true }),
        (error) => {
          assert.match(error.message, new RegExp(`is at ${foreign}`))
          assert.match(error.message, new RegExp(`approved ${headA}`))
          assert.match(error.message, /mirror/, "the failing destination is named")
          return true
        },
      )
    })
  })

  it("never prints the credentials a push URL may carry", () => {
    assert.equal(
      redactRemoteUrl("https://octocat:ghp_SECRETTOKEN@github.com/codeslp/btrain.git"),
      "https://***@github.com/codeslp/btrain.git",
    )
    assert.equal(redactRemoteUrl("https://github.com/codeslp/btrain.git"), "https://github.com/codeslp/btrain.git")
    assert.equal(redactRemoteUrl("git@github.com:codeslp/btrain.git"), "github.com:codeslp/btrain.git")
    assert.equal(redactRemoteUrl("/srv/git/btrain.git"), "/srv/git/btrain.git")
    assert.equal(redactRemoteUrl(""), "")
  })
})

describe("local-review gate: the base is part of the approval", () => {
  it("refuses a --base the review never read", async () => {
    await withRepo(async ({ repo, home, headA, base, bare }) => {
      // `legacy` is an older base the lane was reviewed against; `main` has
      // since gained a file the reviewer never saw. Same head, other diff.
      await git(repo, "push", "-q", "origin", `${base.sha}:refs/heads/legacy`)
      const legacy = await baseTarget(bare, "legacy")
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base: legacy })).code, 0)

      assert.equal(await problemFor(repo, headA, legacy), "", "the reviewed base passes")
      const problem = await problemFor(repo, headA, base)
      assert.match(problem, /was read against base `legacy`, but the PR opens against `main`/)

      await assert.rejects(
        runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha", base: "main" }),
        (error) => {
          assert.match(error.message, /a different base is a different diff/)
          return true
        },
      )
      // Refused before anything was published.
      await assert.rejects(git(bare, "rev-parse", "refs/heads/feat/gate"))
    })
  })

  it("refuses once the reviewed base itself has moved", async () => {
    await withRepo(async ({ repo, home, headA, base, bare }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base })).code, 0)
      assert.equal(await problemFor(repo, headA, base), "")

      // main gains a commit the reviewer never read, so `main...HEAD` is a
      // different diff even though HEAD has not moved.
      await git(repo, "checkout", "-q", "main")
      const movedMain = await commit(repo, "export const feature = 100\n")
      await git(repo, "push", "-q", "origin", "main")
      await git(repo, "checkout", "-q", "feat/gate")
      const moved = await baseTarget(bare)
      assert.equal(moved.sha, movedMain)

      const problem = await problemFor(repo, headA, moved)
      assert.match(problem, new RegExp(`read against \`main\` at \`${base.sha}\``))
      assert.match(problem, new RegExp(`\`main\` is now at \`${movedMain}\``))
    })
  })

  it("refuses an approval read in another repository", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await handOff(repo, home)
      const elsewhere = { ...base, repo: "github.com/someone-else/btrain" }
      assert.equal((await approve(repo, home, { sha: headA, base: elsewhere })).code, 0)

      const problem = await problemFor(repo, headA, base)
      assert.match(problem, /was read in `github.com\/someone-else\/btrain`, but the revision is bound for/)
    })
  })

  it("never interpolates a hostile ref or repository into the printed command", async () => {
    await withRepo(async ({ repo, home, headA }) => {
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA })).code, 0)

      // Git allows these characters in a branch name, and the remediation is
      // printed for a human to paste into a shell.
      const hostile = { repo: "github.com/o/r", ref: "feat/$(id)`id`", sha: "f".repeat(40) }
      await assert.rejects(
        enforceLocalReview(repo, {}, { lane: await laneA(repo), laneId: "a", targetSha: headA, targetBase: hostile, stage: "`btrain pr create`" }),
        (error) => {
          const command = error.message.split("\n").find((line) => line.includes("btrain handoff resolve"))
          assert.ok(command, error.message)
          assert.ok(!command.includes("$(id)"), `shell syntax reached the printed command:\n${command}`)
          assert.ok(!command.includes("`id`"), `shell syntax reached the printed command:\n${command}`)
          assert.match(command, /Reviewed-Base: <repository> <base ref> <base object ID>/)
          // The real target is still reported, as plain text beside the
          // command rather than inside it.
          assert.match(error.message, /to fill in by hand: repository github.com\/o\/r, base ref feat\/\$\(id\)/)
          return true
        },
      )
    })
  })

  it("names the repository gh must open on, and qualifies a fork head", () => {
    assert.equal(ghRepoFlagFor("github.com/codeslp/btrain"), "github.com/codeslp/btrain")
    assert.equal(ghRepoFlagFor("ghe.internal/codeslp/btrain"), "ghe.internal/codeslp/btrain")
    assert.equal(ghRepoFlagFor("path:/srv/git/btrain"), "", "a local remote is no GitHub repository")
    assert.equal(ghRepoFlagFor("codeslp/btrain"), "", "an identity without a host is not usable")
    assert.equal(ghRepoFlagFor(""), "")

    const upstream = "github.com/codeslp/btrain"
    assert.equal(prCreateHeadSpec("feat/gate", upstream, upstream), "feat/gate", "a same-repository head stays bare")
    assert.equal(
      prCreateHeadSpec("feat/gate", "github.com/contributor/btrain", upstream),
      "contributor:feat/gate",
      "a fork head is qualified with its owner",
    )
    assert.equal(prCreateHeadSpec("feat/gate", "", upstream), "feat/gate", "an unknown head repository changes nothing")
  })
})

describe("local-review gate: GitHub's target authorizes each bot request", () => {
  it("refuses to post when GitHub's head is not the approved revision", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      const root = path.dirname(repo)
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base: ghBase(base) })).code, 0)
      const link = await btrain(["handoff", "update", "--lane", "a", "--status", "pr-review", "--pr", "7", "--actor", "alpha"], { cwd: repo, home })
      assert.equal(link.code, 0, `${link.stdout}\n${link.stderr}`)

      // GitHub is on some other revision. The local checkout and the local
      // tracking cache know nothing about it.
      const other = "b".repeat(40)
      const gh = await installFakeGh(root, prOn(base, other))
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

  it("refuses to post when GitHub has retargeted the PR after the approval", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      const root = path.dirname(repo)
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base: ghBase(base) })).code, 0)
      const link = await btrain(["handoff", "update", "--lane", "a", "--status", "pr-review", "--pr", "7", "--actor", "alpha"], { cwd: repo, home })
      assert.equal(link.code, 0, `${link.stdout}\n${link.stderr}`)

      const gh = await installFakeGh(root, { ...prOn(base, headA), baseRefName: "release/2.x" })
      await withPath(gh.binDir, async () => {
        await assert.rejects(
          runPrRequestReview(repo, { lane: "a", bots: "all" }),
          /was read against base `main`, but the PR opens against `release\/2.x`/,
        )
      })
      assert.equal(await gh.posted(), "", "a retargeted PR gets no bot request")

      // Same PR, same head, but GitHub's base has moved on instead.
      await gh.setPr({ ...prOn(base, headA), baseRefOid: "e".repeat(40) })
      await withPath(gh.binDir, async () => {
        await assert.rejects(runPrRequestReview(repo, { lane: "a", bots: "all" }), /`main` is now at `e{40}`/)
      })
      assert.equal(await gh.posted(), "")

      // And the approval still works for the target it actually covers.
      await gh.setPr(prOn(base, headA))
      await withPath(gh.binDir, async () => {
        const posted = await runPrRequestReview(repo, { lane: "a", bots: "all" })
        assert.ok(posted.length > 0, "the reviewed target posts")
      })
      assert.match(await gh.posted(), new RegExp(`head=${headA}`))
    })
  })

  it("posts against GitHub's head, not a stale local tracking ref", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      const root = path.dirname(repo)
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base: ghBase(base) })).code, 0)
      const link = await btrain(["handoff", "update", "--lane", "a", "--status", "pr-review", "--pr", "7", "--actor", "alpha"], { cwd: repo, home })
      assert.equal(link.code, 0, `${link.stdout}\n${link.stderr}`)

      // Push A, so the tracking cache says A, then move GitHub to B. A gate
      // that trusted the tracking ref would authorize A and post about it.
      await git(repo, "push", "-q", "-u", "origin", "feat/gate")
      const headB = await commit(repo, "export const feature = 7\n")
      await git(repo, "reset", "-q", "--hard", headA)
      assert.equal(await git(repo, "rev-parse", "refs/remotes/origin/feat/gate"), headA)

      const gh = await installFakeGh(root, prOn(base, headB))
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
      assert.equal((await approve(repo, home, { sha: headB, base: ghBase(base) })).code, 0)
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

describe("the lane's PR repository is pinned, not re-derived", () => {
  it("resolves a repository from a PR URL and addresses it for REST", () => {
    assert.deepEqual(restIdentityFor("github.com/o/r"), { host: "github.com", owner: "o", repo: "r" })
    assert.deepEqual(restIdentityFor("ghe.corp/o/r"), { host: "ghe.corp", owner: "o", repo: "r" })
    assert.equal(restIdentityFor("path:/srv/git/btrain"), null, "a local remote is no GitHub repository")
    assert.equal(restIdentityFor("o/r"), null, "an identity without a host cannot be addressed")
    assert.deepEqual(ghRepoArgs("github.com/o/r"), ["--repo", "github.com/o/r"])
    assert.deepEqual(ghRepoArgs("path:/srv/git/btrain"), [], "gh keeps its own default when there is nothing to name")
  })

  it("pins the repository gh opened the PR on, and asks that one afterwards", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      const root = path.dirname(repo)
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base })).code, 0)
      const gh = await installFakeGh(root, prOn(base, headA))

      // This repo's base remote is a local path, so nothing names a GitHub
      // repository until gh prints the URL of the PR it opened. The create
      // succeeds and the bot-review gate then refuses, because the approval
      // was read in the local path remote rather than in `github.com/o/r` —
      // and that refusal is the proof the view reached the created PR.
      await withPath(gh.binDir, async () => {
        await assert.rejects(
          runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha" }),
          /was read in `path:.*`, but the revision is bound for `github.com\/o\/r`/,
        )
      })

      const views = (await gh.invocations()).filter((line) => line.startsWith("pr view"))
      assert.deepEqual(views, ["pr view --repo github.com/o/r"], "the view followed the URL gh printed")

      const [file] = await prAssociationFiles(repo)
      const record = JSON.parse(await fs.readFile(file, "utf8"))
      assert.equal(record.repo, "github.com/o/r")
      assert.equal(record.pr, "7")
      assert.equal(record.lane, "a")
    })
  })

  it("pins once when two commands race, and both act on the same repository", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await addGitHubBaseRemote(repo)
      await linkApprovedPr(repo, home, { headA, base })

      // Both derive a repository before either has written one. Exactly one
      // record may result, and the loser must adopt the winner's answer
      // rather than carrying its own into the calls it is about to make.
      const racers = { laneId: "a", prNumber: "7", linked: true }
      const [first, second] = await Promise.all([
        resolvePrRepository(repo, racers),
        resolvePrRepository(repo, racers),
      ])
      assert.equal(first, "github.com/o/r")
      assert.equal(second, first)
      assert.equal((await prAssociationFiles(repo)).length, 1, "one lane, one claim, one PR, one record")
    })
  })

  it("refuses the loser of a race between two conflicting explicit repositories", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await addGitHubBaseRemote(repo)
      await linkApprovedPr(repo, home, { headA, base })

      // Two commands name #7 in two different repositories at once, with no
      // association yet to tell them apart. One pins; the other must be
      // refused rather than quietly carrying its own repository forward.
      const race = (host) => resolvePrRepository(repo, {
        laneId: "a",
        prNumber: "7",
        linked: true,
        url: `https://${host}/pull/7`,
      })
      const settled = await Promise.allSettled([race("github.com/o/r"), race(OTHER_DEFAULT_REPO)])

      const won = settled.filter((result) => result.status === "fulfilled")
      const lost = settled.filter((result) => result.status === "rejected")
      assert.equal(won.length, 1, JSON.stringify(settled, null, 2))
      assert.equal(lost.length, 1)
      assert.match(lost[0].reason.message, /is associated with PR #7 in/)
      assert.match(lost[0].reason.message, /refusing to act on/)

      const [file] = await prAssociationFiles(repo)
      assert.equal((await prAssociationFiles(repo)).length, 1, "one record, not one per racer")
      const record = JSON.parse(await fs.readFile(file, "utf8"))
      assert.equal(record.repo, won[0].value, "the winner is what was pinned")

      // Whichever won, the file it published was complete when it appeared.
      assert.equal(record.version, 1)
      assert.equal(record.pr, "7")
    })
  })

  it("reports an unreadable association instead of quietly re-deriving one", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await addGitHubBaseRemote(repo)
      await linkApprovedPr(repo, home, { headA, base })
      await resolvePrRepository(repo, { laneId: "a", prNumber: "7", linked: true })

      const [file] = await prAssociationFiles(repo)
      await fs.writeFile(file, "{ this is not json")
      await assert.rejects(
        resolvePrRepository(repo, { laneId: "a", prNumber: "7", linked: true }),
        (error) => {
          assert.match(error.message, /cannot be read/)
          assert.match(error.message, new RegExp(`Delete ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
          return true
        },
      )
    })
  })

  it("does not pin a --pr the lane never linked", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      const root = path.dirname(repo)
      await addGitHubBaseRemote(repo)
      await handOff(repo, home)
      assert.equal((await approve(repo, home, { sha: headA, base: ghBase(base) })).code, 0)
      const gh = await installFakeGh(root, prOn(base, headA))

      // The lane has no PR of its own, so looking at #7 is a look. Pinning it
      // would bind the lane to a PR nobody adopted for it.
      await withPath(gh.binDir, async () => {
        await runPrRequestReview(repo, { lane: "a", bots: "all", pr: "7" })
      })
      assert.deepEqual(await prAssociationFiles(repo), [])
    })
  })

  it("keeps the association when the remote and the shell both move to another repository", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      const root = path.dirname(repo)
      await addGitHubBaseRemote(repo)
      await linkApprovedPr(repo, home, { headA, base })
      const gh = await installFakeGh(root, prOn(base, headA))

      await withEnv({ GH_REPO: OTHER_DEFAULT_REPO }, async () => {
        await withPath(gh.binDir, async () => {
          assert.ok((await runPrRequestReview(repo, { lane: "a", bots: "all" })).length > 0)

          // `other/elsewhere` has a #7 too. Repointing the remote at it used
          // to be enough to make the next command act on it instead.
          await git(repo, "remote", "set-url", "upstream", `https://${OTHER_DEFAULT_REPO}.git`)
          assert.ok((await runPrRequestReview(repo, { lane: "a", bots: "all" })).length > 0)
        })
      })

      const invocations = await gh.invocations()
      assert.ok(invocations.length >= 4, invocations.join("\n"))
      for (const line of invocations) {
        assert.match(line, /--repo github\.com\/o\/r/, `a call left the lane's repository:\n${line}`)
      }
      assert.match(await gh.posted(), new RegExp(`head=${headA}`))
    })
  })

  it("refuses an explicit --pr that is this number in another repository", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      const root = path.dirname(repo)
      await addGitHubBaseRemote(repo)
      await linkApprovedPr(repo, home, { headA, base })
      const gh = await installFakeGh(root, prOn(base, headA))

      await withPath(gh.binDir, async () => {
        assert.ok((await runPrRequestReview(repo, { lane: "a", bots: "all" })).length > 0)
        await assert.rejects(
          runPrRequestReview(repo, { lane: "a", bots: "all", pr: `https://${OTHER_DEFAULT_REPO}/pull/7` }),
          (error) => {
            assert.match(error.message, /associated with PR #7 in `github\.com\/o\/r`/)
            assert.match(error.message, new RegExp(`refusing to act on \`${OTHER_DEFAULT_REPO}\``))
            return true
          },
        )
      })
      assert.ok(
        !(await gh.invocations()).some((line) => line.includes(OTHER_DEFAULT_REPO)),
        "the redirect was refused before any gh call",
      )
    })
  })

  it("sends REST reads to the repository's own host", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      const root = path.dirname(repo)
      await addGitHubBaseRemote(repo, "https://ghe.corp/o/r.git")
      await linkApprovedPr(repo, home, { headA, base })
      const gh = await installFakeGh(root, {
        ...prOn(base, headA),
        number: 7,
        title: "lane a",
        state: "OPEN",
        isDraft: false,
        mergedAt: null,
      }, { host: "ghe.corp/o/r" })

      await withEnv({ GH_REPO: OTHER_DEFAULT_REPO }, async () => {
        await withPath(gh.binDir, async () => {
          await runPrPoll(repo, { lane: "a" })
        })
      })

      const api = (await gh.invocations()).filter((line) => line.startsWith("api "))
      assert.ok(api.length > 0, "the REST comment fetch ran")
      for (const line of api) {
        assert.match(line, /^api repos\/o\/r\//, `a REST read left the lane's repository:\n${line}`)
        assert.match(line, /--hostname ghe\.corp/, `a REST read went to the wrong GitHub:\n${line}`)
      }
    })
  })
})
