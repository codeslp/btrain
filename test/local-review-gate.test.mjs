import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { checkHandoff, getRepoPaths, listActiveOverrides, readProjectConfig } from "../src/brain_train/core.mjs"
import { enforceLocalReview, readLaneEvents } from "../src/brain_train/local_review.mjs"
import { runPrCreate, runPrPoll, runPrRequestReview } from "../src/brain_train/pr-flow.mjs"

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
  "--why", "exercise local peer review",
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
async function withRepo(fn, { single = false } = {}) {
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
    if (single) {
      const configPath = path.join(repo, ".btrain", "project.toml")
      await fs.writeFile(configPath, (await fs.readFile(configPath, "utf8")).replace("[lanes]\nenabled = true", "[lanes]\nenabled = false"))
    }
    await commit(repo, "export const feature = 0\n")
    await exec("git", ["init", "-q", "--bare", "-b", "main", bare])
    await git(repo, "remote", "add", "origin", bare)
    await git(repo, "push", "-q", "origin", "main")
    // The lane works on a branch so `--base main` sees a real diff, which is
    // what the needs-review evidence gate requires.
    await git(repo, "checkout", "-q", "-b", "feat/gate")

    const claim = await btrain(["handoff", "claim", ...(single ? [] : ["--lane", "a"]), "--task", "gate lane", "--owner", "alpha", "--reviewer", "beta", "--files", "src/a/"], { cwd: repo, home })
    assert.equal(claim.code, 0, `${claim.stdout}\n${claim.stderr}`)
    const headA = await commit(repo, "export const feature = 1\n")

    await fn({ repo, home, headA, bare, baseSha: await git(bare, "rev-parse", "refs/heads/main") })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

// What the gate should compute for a bare remote: `path:<dir>` without the
// `.git`, the base ref, and the object that ref is at on the remote itself.
async function handOff(repo, home) {
  const review = await btrain(
    ["handoff", "update", "--lane", "a", "--status", "needs-review", "--actor", "alpha", "--base", "main", "--no-dispatch", ...REVIEW_CONTEXT],
    { cwd: repo, home },
  )
  assert.equal(review.code, 0, `${review.stdout}\n${review.stderr}`)
}

async function laneA(repo) {
  const handoff = await checkHandoff(repo)
  return handoff.lanes ? handoff.lanes.find((lane) => lane._laneId === "a") : handoff.current
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

async function finishPeerReview(repo, home) {
  const result = await btrain(["handoff", "resolve", "--lane", "a", "--summary", "Peer checks passed"], { cwd: repo, home, agent: "beta" })
  assert.equal(result.code, 0, result.stderr)
}


async function linkPr(repo, home) {
  const result = await btrain(["handoff", "update", "--lane", "a", "--status", "pr-review", "--pr", "7"], { cwd: repo, home })
  assert.equal(result.code, 0, result.stderr)
}

async function withGitHub(repo, headA, baseSha, fn) {
  const root = path.dirname(repo)
  const bin = path.join(root, "bin")
  const posted = path.join(root, "posted")
  const reviews = path.join(root, "reviews.json")
  const pullFile = path.join(root, "pull.json")
  const pull = JSON.stringify({
    number: 7, url: "https://github.com/o/r/pull/7", headRefName: "feat/gate",
    headRefOid: headA, baseRefName: "main", baseRefOid: baseSha,
  })
  await fs.writeFile(pullFile, pull)
  await fs.mkdir(bin)
  await fs.writeFile(reviews, "[]")
  await fs.writeFile(path.join(bin, "gh"), `#!/bin/sh
case "$1 $2" in
  "--version ") echo "gh version 2";;
  "pr view") cat ${JSON.stringify(pullFile)};;
  "pr create") echo "https://github.com/o/r/pull/7";;
  "pr comment") printf '%s\\n' "$*" >> ${JSON.stringify(posted)};;
  "api repos/o/r/pulls/7/reviews") cat ${JSON.stringify(reviews)};;
  "api "*) echo "[]";;
  *) exit 1;;
esac
`, { mode: 0o755 })

  const setReview = (state) => fs.writeFile(reviews, JSON.stringify(
    ["chatgpt-codex-connector[bot]", "unblocked[bot]"].map((login, index) => ({
      id: index + 1, state, commit_id: headA, user: { login }, submitted_at: "2026-11-20T09:00:00Z",
    })),
  ))
  return withPath(bin, () => fn({
    setReview,
    setState: (state) => fs.writeFile(pullFile, JSON.stringify({ ...JSON.parse(pull), state })),
    posts: () => fs.readFile(posted, "utf8").catch(() => ""),
  }))
}

const request = (repo) => runPrRequestReview(repo, { lane: "a", actor: "alpha", bots: "all" })
const poll = (repo, options) => runPrPoll(repo, { lane: "a", actor: "alpha", ...options })
const noPeerReview = /needs a current local peer review/

describe("local peer-review workflow", () => {
  it("creates a PR after the assigned peer approves with a plain summary", async () => {
    await withRepo(async ({ repo, home, headA, baseSha }) => {
      await handOff(repo, home)
      await finishPeerReview(repo, home)
      await withGitHub(repo, headA, baseSha, async ({ posts }) => {
        const result = await runPrCreate(repo, { lane: "a", actor: "alpha", bots: "all" })
        assert.equal(result.number, "7")
        assert.match(await posts(), /@codex review/)
      })
    })
  })

  for (const stage of ["create", "request", "clearance"]) {
    it(`refuses ${stage} when peer approval covers a different head`, async () => {
      await withRepo(async ({ repo, home, headA, baseSha, bare }) => {
        await handOff(repo, home)
        await finishPeerReview(repo, home)
        const headB = await commit(repo, "export const feature = 2\n")
        if (stage !== "create") {
          await git(repo, "remote", "add", "upstream", "https://github.com/o/r.git")
          await linkPr(repo, home)
        }
        await withGitHub(repo, headB, baseSha, async ({ posts, setReview }) => {
          await setReview("APPROVED")
          const act = () => {
            if (stage === "create") return runPrCreate(repo, { lane: "a", actor: "alpha", bots: "all" })
            if (stage === "request") return request(repo)
            return poll(repo, { apply: true })
          }
          await assert.rejects(act, (error) => {
            assert.ok(error.message.includes(headA), error.message)
            assert.ok(error.message.includes(headB), error.message)
            assert.match(error.message, /hand.*back for review/i)
            return true
          })
          assert.equal(await posts(), "")
          assert.equal((await laneA(repo)).status, stage === "create" ? "ready-for-pr" : "pr-review")
          if (stage === "create") await assert.rejects(git(bare, "show-ref", "--verify", "refs/heads/feat/gate"))
        })
      })
    })
  }

  for (const reviewHead of ["", undefined]) {
    it(`refuses peer approval with ${reviewHead === "" ? "empty" : "missing"} reviewHead`, async () => {
      await withRepo(async ({ repo, home, headA }) => {
        await handOff(repo, home)
        await finishPeerReview(repo, home)
        await assert.rejects(enforceLocalReview(repo, await readProjectConfig(repo), {
          lane: { ...await laneA(repo), reviewHead }, laneId: "a", stage: "Creating a PR", headSha: headA,
        }), /hand.*back for review/i)
      })
    })
  }

  it("lets a pending override authorize a head after the peer-approved one", async () => {
    await withRepo(async ({ repo, home, headA }) => {
      await handOff(repo, home)
      await finishPeerReview(repo, home)
      const headB = await commit(repo, "export const feature = 2\n")
      const enforce = async (stage) => enforceLocalReview(repo, await readProjectConfig(repo), {
        lane: await laneA(repo), laneId: "a", stage, headSha: headB,
      })
      // Without a grant, the new head still needs another peer review.
      await assert.rejects(enforce("Creating a PR"), (error) => {
        assert.ok(error.message.includes(headA) && error.message.includes(headB), error.message)
        return true
      })
      await grantLocalReview(repo, home)
      assert.equal((await laneA(repo)).reviewHead, headA)
      for (const stage of ["Creating a PR", "Requesting bot review", "Applying bot clearance"]) await enforce(stage)
      assert.equal((await listActiveOverrides(repo)).length, 0)
      const consumed = (await readLaneEvents(repo, "a")).filter((event) => event.type === "override-consumed")
      assert.equal(consumed.length, 1)
    })
  })

  for (const reviewHead of ["", undefined, "bad-head", "a".repeat(39), "a".repeat(41), "a".repeat(65), "g".repeat(40)]) {
    it(`lets a pending override replace peer approval with invalid reviewHead ${reviewHead}`, async () => {
      await withRepo(async ({ repo, home, headA }) => {
        await handOff(repo, home)
        await finishPeerReview(repo, home)
        const enforce = async () => enforceLocalReview(repo, await readProjectConfig(repo), {
          lane: { ...await laneA(repo), reviewHead }, laneId: "a", stage: "Creating a PR",
          headSha: reviewHead || headA,
        })
        await assert.rejects(enforce(), /peer approval covers .*but the PR head is/)
        await grantLocalReview(repo, home)
        await enforce()
        await enforce()
        assert.equal((await listActiveOverrides(repo)).length, 0)
        const consumed = (await readLaneEvents(repo, "a")).filter((event) => event.type === "override-consumed")
        assert.equal(consumed.length, 1)
        assert.equal(consumed[0].details.action, "local-review")
      })
    })
  }

  for (const scope of ["another lane", "repo"]) {
    it(`keeps a peer head mismatch refused with a pending grant for ${scope}`, async () => {
      await withRepo(async ({ repo, home, headA }) => {
        await handOff(repo, home)
        await finishPeerReview(repo, home)
        const headB = await commit(repo, "export const feature = 2\n")
        if (scope === "another lane") await grantLocalReview(repo, home, "b")
        else {
          // Simulate an older repo grant, which the multi-lane CLI no longer issues.
          await fs.mkdir(getRepoPaths(repo).overridesDir, { recursive: true })
          await fs.writeFile(path.join(getRepoPaths(repo).overridesDir, "repo-scope.json"), JSON.stringify({
            id: "repo-scope", action: "local-review", scope: "repo", laneId: "",
            requestedBy: "alpha", confirmedBy: "human", reason: "Old repo grant",
          }))
        }
        const pending = await listActiveOverrides(repo)
        for (const stage of ["Creating a PR", "Requesting bot review", "Applying bot clearance"]) {
          await assert.rejects(enforceLocalReview(repo, await readProjectConfig(repo), {
            lane: await laneA(repo), laneId: "a", stage, headSha: headB,
          }), (error) => {
            assert.match(error.message, /peer approval covers .*but the PR head is/)
            assert.ok(error.message.includes(headA) && error.message.includes(headB), error.message)
            return true
          })
        }
        assert.deepEqual(await listActiveOverrides(repo), pending)
        assert.equal((await readLaneEvents(repo, "a")).filter((event) => event.type === "override-consumed").length, 0)
      })
    })
  }

  it("refuses an owner advisory resolve before creating or pushing a PR", async () => {
    await withRepo(async ({ repo, home, bare }) => {
      await handOff(repo, home)
      const resolve = await btrain(["handoff", "resolve", "--lane", "a", "--summary", "Owner update"], { cwd: repo, home })
      assert.equal(resolve.code, 0, resolve.stderr)
      assert.equal((await laneA(repo)).status, "ready-for-pr")
      await assert.rejects(runPrCreate(repo, { lane: "a", actor: "alpha" }), noPeerReview)
      await assert.rejects(git(bare, "show-ref", "--verify", "refs/heads/feat/gate"))
    })
  })

  it("blocks both ways to request bots when the PR was linked without local approval", async () => {
    await withRepo(async ({ repo, home, headA, baseSha }) => {
      await git(repo, "remote", "add", "upstream", "https://github.com/o/r.git")
      await linkPr(repo, home)
      await withGitHub(repo, headA, baseSha, async ({ posts }) => {
        await assert.rejects(request(repo), noPeerReview)
        await assert.rejects(poll(repo, { "request-review": true }), noPeerReview)
        assert.equal(await posts(), "")
      })
    })
  })

  it("requires fresh local review after bot feedback before requests or clearance", async () => {
    await withRepo(async ({ repo, home, headA, baseSha }) => {
      await git(repo, "remote", "add", "upstream", "https://github.com/o/r.git")
      await handOff(repo, home)
      await finishPeerReview(repo, home)
      await linkPr(repo, home)
      await withGitHub(repo, headA, baseSha, async ({ setReview, posts }) => {
        await setReview("CHANGES_REQUESTED")
        await poll(repo, { apply: true })
        assert.equal((await laneA(repo)).status, "changes-requested")

        await linkPr(repo, home)
        await assert.rejects(request(repo), noPeerReview)
        assert.equal(await posts(), "")
        await setReview("APPROVED")
        await assert.rejects(poll(repo, { apply: true }), noPeerReview)
        assert.equal((await laneA(repo)).status, "pr-review")

        await handOff(repo, home)
        await finishPeerReview(repo, home)
        await linkPr(repo, home)
        await request(repo)
        assert.match(await posts(), /@codex review/)
        await poll(repo, { apply: true })
        assert.equal((await laneA(repo)).status, "ready-to-merge")
      })
    })
  })

  it("refuses all three stages even with a legacy disabled feature setting", async () => {
    await withRepo(async ({ repo, home, headA, baseSha }) => {
      const configPath = path.join(repo, ".btrain", "project.toml")
      const config = await fs.readFile(configPath, "utf8")
      await fs.writeFile(configPath, config.includes("[features]")
        ? config.replace("[features]", "[features]\nlocal_review = false")
        : config + "\n[features]\nlocal_review = false\n")
      assert.equal((await readProjectConfig(repo)).features.local_review, false)
      await handOff(repo, home)
      const resolve = await btrain(["handoff", "resolve", "--lane", "a", "--summary", "Owner update"], { cwd: repo, home })
      assert.equal(resolve.code, 0, resolve.stderr)
      await assert.rejects(runPrCreate(repo, { lane: "a", actor: "alpha" }), noPeerReview)
      await git(repo, "remote", "add", "upstream", "https://github.com/o/r.git")
      await linkPr(repo, home)
      await withGitHub(repo, headA, baseSha, async ({ posts, setReview }) => {
        await assert.rejects(request(repo), noPeerReview)
        await assert.rejects(poll(repo, { "request-review": true }), noPeerReview)
        await setReview("APPROVED")
        await assert.rejects(poll(repo, { apply: true }), noPeerReview)
        assert.equal((await laneA(repo)).status, "pr-review")
        assert.equal(await posts(), "")
      })
    })
  })

  it("consumes one audited override for creation, requests, and clearance in one PR cycle", async () => {
    await withRepo(async ({ repo, home, headA, baseSha }) => {
      await handOff(repo, home)
      const resolve = await btrain(["handoff", "resolve", "--lane", "a", "--summary", "Owner update"], { cwd: repo, home })
      assert.equal(resolve.code, 0, resolve.stderr)
      await grantLocalReview(repo, home)
      const headB = await commit(repo, "export const feature = 2\n")
      assert.equal((await laneA(repo)).reviewHead, headA)
      await withGitHub(repo, headB, baseSha, async ({ posts, setReview }) => {
        await runPrCreate(repo, { lane: "a", actor: "alpha", bots: "all" })
        assert.equal((await listActiveOverrides(repo)).length, 0)
        await request(repo)
        await setReview("APPROVED")
        await poll(repo, { apply: true })
        assert.equal((await laneA(repo)).status, "ready-to-merge")
        assert.match(await posts(), /@codex review/)
      })
      const consumed = (await readLaneEvents(repo, "a")).filter((event) => event.type === "override-consumed")
      assert.equal(consumed.length, 1)
      assert.equal(consumed[0].laneId, "a")
      assert.equal(consumed[0].details.action, "local-review")
      assert.equal(consumed[0].details.scope, "lane")
      assert.equal(consumed[0].details.requestedBy, "alpha")
      assert.equal(consumed[0].details.confirmedBy, "human")
      assert.equal(consumed[0].details.reason, "Reviewer unavailable for this cycle")
      assert.equal((await readLaneEvents(repo)).filter((event) => event.type === "override-consumed").length, 0)
    })
  })

  for (const status of ["in-progress", "needs-review"]) {
    for (const target of ["ready-for-pr", "pr-review"]) {
      it(`rejects an override consumed during ${status} after a direct update to ${target}`, async () => {
        await withRepo(async ({ repo, home }) => {
          if (status === "needs-review") await handOff(repo, home)
          await grantLocalReview(repo, home)
          const consumed = await btrain(["override", "consume", "--action", "local-review", "--lane", "a"], { cwd: repo, home })
          assert.equal(consumed.code, 0, consumed.stderr)
          const update = await btrain([
            "handoff", "update", "--lane", "a", "--status", target,
            ...(target === "pr-review" ? ["--pr", "7"] : []),
          ], { cwd: repo, home })
          assert.equal((await listActiveOverrides(repo)).length, 0)
          if (status === "needs-review" && target === "pr-review") {
            // The status-update guard rejects this route before the gate runs.
            assert.equal(update.code, 1, update.stderr)
            assert.match(update.stderr, /Local peer review must finish before linking a PR\./)
            assert.equal((await laneA(repo)).status, status)
            return
          }
          assert.equal(update.code, 0, update.stderr)
          assert.equal((await laneA(repo)).status, target)
          // These CLI routes still reach the event fold, preserving coverage
          // of overrides consumed before the lane entered its PR cycle.
          await assert.rejects(gate(repo), noPeerReview)
        })
      })
    }
  }

  for (const withdrawal of ["claim", "request-changes", "watchdog-repair", "resolved", "missing-grant"]) {
    it(`retires a pending grant after ${withdrawal} without authorizing the owner`, async () => {
      await withRepo(async ({ repo, home }) => {
        if (withdrawal === "request-changes") await handOff(repo, home)
        await grantLocalReview(repo, home)
        const [pending] = await listActiveOverrides(repo)
        const log = path.join(getRepoPaths(repo).eventsDir, "lane-a.jsonl")
        if (withdrawal === "claim") {
          const abandon = await btrain(["handoff", "update", "--lane", "a", "--status", "idle"], { cwd: repo, home })
          assert.equal(abandon.code, 0, abandon.stderr)
          const result = await btrain(["handoff", "claim", "--lane", "a", "--task", "unrelated work",
            "--owner", "alpha", "--reviewer", "beta", "--files", "src/a/"], { cwd: repo, home })
          assert.equal(result.code, 0, result.stderr)
        } else if (withdrawal === "request-changes") {
          const result = await btrain(["handoff", "request-changes", "--lane", "a", "--summary", "Fix it",
            "--reason-code", "regression-risk"], { cwd: repo, home, agent: "beta" })
          assert.equal(result.code, 0, result.stderr)
        } else if (withdrawal === "missing-grant") {
          const events = (await readLaneEvents(repo, "a")).filter((event) => event.type !== "override-granted")
          await fs.writeFile(log, events.map(JSON.stringify).join("\n") + "\n")
        } else {
          // No status and reversed clocks must not hide a withdrawal.
          await fs.appendFile(log, JSON.stringify({ type: withdrawal === "resolved" ? "resolve" : withdrawal,
            laneId: "a", at: "1900-01-01T00:00:00Z",
            ...(withdrawal === "resolved" ? { after: { status: "resolved" } } : {}),
          }) + "\n")
        }
        await handOff(repo, home)
        const ownerResolve = await btrain(["handoff", "resolve", "--lane", "a", "--summary", "Owner route"], { cwd: repo, home })
        assert.equal(ownerResolve.code, 0, ownerResolve.stderr)
        assert.equal((await laneA(repo)).status, "ready-for-pr")
        await assert.rejects(gate(repo), /grant.*(predates|missing).*new grant/i)
        assert.equal((await listActiveOverrides(repo)).length, 0)
        const events = await readLaneEvents(repo, "a")
        assert.equal(events.filter((event) => event.type === "override-consumed").length, 0)
        assert.ok(events.some((event) => event.type === "override-retired" && event.details.overrideId === pending.id))
        await assert.rejects(gate(repo), noPeerReview)
        await grantLocalReview(repo, home)
        await gate(repo)
      })
    })
  }

  for (const status of ["idle", "in-progress", "needs-review", "changes-requested", "repair-needed", "resolved", "ready-for-pr", "pr-review", "ready-to-merge"]) {
    it(`checks hand-run consumption at ${status}`, async () => {
      await withRepo(async ({ repo, home }) => {
        await setFixtureStatus(repo, home, status)
        await grantLocalReview(repo, home)
        const consumed = await btrain(["override", "consume", "--action", "local-review", "--lane", "a"], { cwd: repo, home })
        assert.equal(consumed.code, 0, consumed.stderr)
        if (["ready-for-pr", "pr-review", "ready-to-merge"].includes(status)) await gate(repo)
        else {
          await assert.rejects(gate(repo), noPeerReview)
          const ready = await btrain(["handoff", "update", "--lane", "a", "--status", "ready-for-pr", "--files", "src/a/"], { cwd: repo, home })
          assert.equal(ready.code, 0, ready.stderr)
          await linkPr(repo, home)
          await assert.rejects(gate(repo), noPeerReview)
        }
      })
    })

    it(`retires a stale hand-run grant at ${status}`, async () => {
      await withRepo(async ({ repo, home }) => {
        await setFixtureStatus(repo, home, status)
        await grantLocalReview(repo, home)
        await fs.appendFile(path.join(getRepoPaths(repo).eventsDir, "lane-a.jsonl"), JSON.stringify({ type: "claim", laneId: "a" }) + "\n")
        const consumed = await btrain(["override", "consume", "--action", "local-review", "--lane", "a"], { cwd: repo, home })
        assert.equal(consumed.code, 1, consumed.stderr)
        assert.match(consumed.stderr, /stale grant was retired without authorization/)
        assert.equal((await listActiveOverrides(repo)).length, 0)
        const ready = await btrain(["handoff", "update", "--lane", "a", "--status", "ready-for-pr", "--files", "src/a/"], { cwd: repo, home })
        assert.equal(ready.code, 0, ready.stderr)
        await linkPr(repo, home)
        await assert.rejects(gate(repo), noPeerReview)
      })
    })
  }

  it("rejects an idle-lane grant after the lane is claimed", async () => {
    await withRepo(async ({ repo, home }) => {
      const idle = await btrain(["handoff", "update", "--lane", "a", "--status", "idle"], { cwd: repo, home })
      assert.equal(idle.code, 0, idle.stderr)
      await grantLocalReview(repo, home)
      const claim = await btrain(["handoff", "claim", "--lane", "a", "--task", "new work", "--owner", "alpha", "--reviewer", "beta", "--files", "src/a/"], { cwd: repo, home })
      assert.equal(claim.code, 0, claim.stderr)
      await linkPr(repo, home)
      await assert.rejects(gate(repo), /new grant is needed/)
    })
  })

  for (const field of ["owner", "reviewer"]) {
    it(`keeps a same-claim work grant after ${field} reassignment during pr-review`, async () => {
      await withRepo(async ({ repo, home }) => {
        await linkPr(repo, home)
        await grantLocalReview(repo, home)
        const update = await btrain(["handoff", "update", "--lane", "a", `--${field}`, field === "owner" ? "beta" : "alpha"], { cwd: repo, home })
        assert.equal(update.code, 0, update.stderr)
        await gate(repo)
        await gate(repo)
        assert.equal((await readLaneEvents(repo, "a")).filter((event) => event.type === "override-consumed").length, 1)
      })
    })
  }

  for (const status of ["in-progress", "needs-review"]) {
    for (const field of ["owner", "reviewer"]) {
      it(`retires a pending grant after ${field} reassignment during ${status}`, async () => {
        await withRepo(async ({ repo, home }) => {
          await setFixtureStatus(repo, home, status)
          await grantLocalReview(repo, home)
          const [pending] = await listActiveOverrides(repo)
          const update = await btrain(["handoff", "update", "--lane", "a", `--${field}`,
            field === "owner" ? "beta" : "alpha"], { cwd: repo, home })
          assert.equal(update.code, 0, update.stderr)
          const ready = await btrain(["handoff", "update", "--lane", "a", "--status", "ready-for-pr"], { cwd: repo, home })
          assert.equal(ready.code, 0, ready.stderr)
          await assert.rejects(gate(repo), (error) => {
            assert.match(error.message, /new claim, change request, watchdog repair, or any non-PR status after the grant/)
            assert.match(error.message, /missing grant event/)
            assert.match(error.message, /Grant from a PR status/)
            return true
          })
          assert.equal((await listActiveOverrides(repo)).length, 0)
          const events = await readLaneEvents(repo, "a")
          assert.ok(events.some((event) => event.type === "override-retired" && event.details.overrideId === pending.id))
          assert.equal(events.filter((event) => event.type === "override-consumed").length, 0)
          await assert.rejects(gate(repo), noPeerReview)
        })
      })
    }
  }

  // M1. Earlier claim/status events masked a fail-open initial state when only the grant event was removed.
  it("retires and denies a pending grant when the entire lane event log is absent", async () => {
    await withRepo(async ({ repo, home }) => {
      await linkPr(repo, home)
      await grantLocalReview(repo, home)
      const [pending] = await listActiveOverrides(repo)
      await fs.rm(path.join(getRepoPaths(repo).eventsDir, "lane-a.jsonl"))
      await assert.rejects(gate(repo), /stale grant was retired without authorization/)
      assert.equal((await listActiveOverrides(repo)).length, 0)
      const events = await readLaneEvents(repo, "a")
      assert.ok(events.some((event) => event.type === "override-retired" && event.details.overrideId === pending.id))
      assert.equal(events.filter((event) => event.type === "override-consumed").length, 0)
      await assert.rejects(gate(repo), noPeerReview)
    })
  })

  it("allows only one pending grant even with concurrent requests", async () => {
    await withRepo(async ({ repo, home }) => {
      const args = ["override", "grant", "--action", "local-review", "--lane", "a", "--requested-by", "alpha", "--confirmed-by", "human", "--reason", "Same work"]
      const results = await Promise.all([btrain(args, { cwd: repo, home }), btrain(args, { cwd: repo, home })])
      assert.deepEqual(results.map((result) => result.code).sort(), [0, 1])
      assert.match(results.find((result) => result.code === 1).stderr, /active override already exists/)
      assert.equal((await listActiveOverrides(repo)).length, 1)
    })
  })

  it("uses and withdraws a repo-scoped grant in a single-lane repository", async () => {
    await withRepo(async ({ repo, home }) => {
      const update = await btrain(["handoff", "update", "--status", "ready-for-pr", "--files", "src/a/"], { cwd: repo, home })
      assert.equal(update.code, 0, update.stderr)
      const grant = await btrain(["override", "grant", "--action", "local-review", "--requested-by", "alpha", "--confirmed-by", "human", "--reason", "Single work"], { cwd: repo, home })
      assert.equal(grant.code, 0, grant.stderr)
      const singleGate = async () => enforceLocalReview(repo, await readProjectConfig(repo), { lane: await laneA(repo), laneId: "", stage: "Create PR" })
      await singleGate()
      await singleGate()
      const events = await readLaneEvents(repo)
      assert.ok(events.some((event) => event.type === "override-granted" && event.details.scope === "repo"))
      await fs.appendFile(path.join(getRepoPaths(repo).eventsDir, "repo.jsonl"), JSON.stringify({ type: "request-changes" }) + "\n")
      await assert.rejects(singleGate(), noPeerReview)
    }, { single: true })
  })

  for (const transition of ["needs-review"]) {
    it(`checks a consumed grant after ${transition}`, async () => {
      await withRepo(async ({ repo, home }) => {
        await linkPr(repo, home)
        await grantLocalReview(repo, home)
        await gate(repo)
        if (transition === "needs-review") await handOff(repo, home)
        const ready = await btrain(["handoff", "update", "--lane", "a", "--status", "ready-for-pr", "--files", "src/a/"], { cwd: repo, home })
        assert.equal(ready.code, 0, ready.stderr)
        await linkPr(repo, home)
        await assert.rejects(gate(repo), noPeerReview)
      })
    })
  }

  for (const consumed of [false, true]) {
    it(`withdraws a ${consumed ? "consumed" : "pending"} grant after PR close and re-claim`, async () => {
      await withRepo(async ({ repo, home, headA, baseSha }) => {
        await git(repo, "remote", "add", "upstream", "https://github.com/o/r.git")
        await linkPr(repo, home)
        await grantLocalReview(repo, home)
        if (consumed) await gate(repo)
        await withGitHub(repo, headA, baseSha, async ({ setState }) => {
          await setState("CLOSED")
          await poll(repo, { apply: true })
          assert.equal((await laneA(repo)).status, "resolved")
          await setState("OPEN")
          const claim = await btrain(["handoff", "claim", "--lane", "a", "--task", "Reopened work", "--owner", "alpha", "--reviewer", "beta", "--files", "src/a/"], { cwd: repo, home })
          assert.equal(claim.code, 0, claim.stderr)
          await linkPr(repo, home)
          await assert.rejects(gate(repo), consumed ? noPeerReview : /new grant is needed/)
        })
      })
    })
  }

  it("requires a lane when granting a local-review override in a multi-lane repo", async () => {
    await withRepo(async ({ repo, home }) => {
      const result = await btrain(["override", "grant", "--action", "local-review", "--requested-by", "alpha",
        "--confirmed-by", "human", "--reason", "Reviewer unavailable"], { cwd: repo, home })
      assert.notEqual(result.code, 0)
      assert.match(result.stderr, /requires --lane/)
    })
  })

  it("does not consume an override for another lane or at repo scope", async () => {
    await withRepo(async ({ repo, home }) => {
      await linkPr(repo, home)
      await grantLocalReview(repo, home, "b")
      // Simulate a pre-existing repo-scoped grant. The CLI must reject new ones.
      await fs.writeFile(path.join(getRepoPaths(repo).overridesDir, "repo-scope.json"), JSON.stringify({
        id: "repo-scope", action: "local-review", scope: "repo", laneId: "",
        requestedBy: "alpha", confirmedBy: "human", reason: "Old repo grant",
      }))
      await assert.rejects(gate(repo), noPeerReview)
      assert.equal((await listActiveOverrides(repo)).length, 2)
      assert.equal((await readLaneEvents(repo, "a")).filter((event) => event.type === "override-consumed").length, 0)
    })
  })

  for (const withdrawal of ["claim", "request-changes", "watchdog-repair", "status"]) {
    it(`withdraws a consumed override after ${withdrawal}`, async () => {
      await withRepo(async ({ repo, home }) => {
        await linkPr(repo, home)
        await grantLocalReview(repo, home)
        await gate(repo)
        // Keep the current PR status to prove the event history withdraws approval.
        await fs.appendFile(path.join(getRepoPaths(repo).eventsDir, "lane-a.jsonl"), JSON.stringify({
          type: withdrawal, laneId: "a", ...(withdrawal === "status" ? { after: { status: "in-progress" } } : {}),
        }) + "\n")
        await assert.rejects(gate(repo), noPeerReview)
        assert.equal((await listActiveOverrides(repo)).length, 0)
      })
    })
  }
})

async function grantLocalReview(repo, home, lane = "a") {
  const result = await btrain(["override", "grant", "--action", "local-review", "--lane", lane,
    "--requested-by", "alpha", "--confirmed-by", "human", "--reason", "Reviewer unavailable for this cycle"], { cwd: repo, home })
  assert.equal(result.code, 0, result.stderr)
}

async function gate(repo) {
  return enforceLocalReview(repo, await readProjectConfig(repo), {
    lane: await laneA(repo), laneId: "a", stage: "Requesting bot review", headSha: await git(repo, "rev-parse", "HEAD"),
  })
}

async function setFixtureStatus(repo, home, status) {
  if (status === "needs-review") return handOff(repo, home)
  const result = await btrain(status === "resolved"
    ? ["handoff", "resolve", "--lane", "a", "--final", "--summary", "Abandoned work"]
    : ["handoff", "update", "--lane", "a", "--status", status,
      ...(["changes-requested", "repair-needed"].includes(status) ? ["--reason-code", status === "repair-needed" ? "state-conflict" : "regression-risk"] : []),
      ...(status === "pr-review" ? ["--pr", "7"] : [])], { cwd: repo, home })
  assert.equal(result.code, 0, result.stderr)
}
