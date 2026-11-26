// Spec 023 WS4 (T017-T019): reviewer choice by lab. A claim with no reviewer
// takes the first other-lab candidate; an explicit same-lab or lab-less
// reviewer is refused (FR-3) while an other-lab agent with a cli runner is
// configured, unless a same-lab-review override for the lane is consumed.
import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { checkHandoff, listActiveOverrides } from "../src/brain_train/core.mjs"

const exec = promisify(execFile)
const CLI_PATH = path.resolve("src/brain_train/cli.mjs")

const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

function cliEnv(home) {
  const env = { ...process.env }
  for (const key of ["BTRAIN_AGENT", "BRAIN_TRAIN_AGENT", "BTRAIN_LANE", "BTRAIN_LANE_LOCKED", "BTRAIN_REPO", "BTRAIN_LOOP_ACTIVE", "CLAUDECODE", "CODEX_SANDBOX"]) delete env[key]
  return { ...env, BRAIN_TRAIN_HOME: home, BTRAIN_NO_REVIEW_DISPATCH: "1", CI: "true" }
}

// Owner claude (anthropic); codex-reviewer (openai, cli); claude-reviewer
// (anthropic, cli); human (notify runner, no lab).
async function withRepo({ agents = ["claude", "claude-reviewer", "codex-reviewer", "human"], lanes = true } = {}, fn) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-lab-claim-")))
  roots.push(root)
  const home = path.join(root, "home")
  const repo = path.join(root, "repo")
  await exec("git", ["init", "-q", "-b", "main", repo])
  const run = async (args, agent = "claude") => {
    try {
      const result = await exec("node", [CLI_PATH, ...args], { cwd: repo, env: { ...cliEnv(home), BTRAIN_AGENT: agent }, maxBuffer: 5 * 1024 * 1024 })
      return { code: 0, stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout || "", stderr: error.stderr || "" }
    }
  }
  const init = await run(["init", repo, "--tracked", ...agents.flatMap((agent) => ["--agent", agent]), "--core-only", "--no-hooks"])
  assert.equal(init.code, 0, init.stderr)
  if (!lanes) {
    const tomlPath = path.join(repo, ".btrain", "project.toml")
    const toml = await fs.readFile(tomlPath, "utf8")
    await fs.writeFile(tomlPath, toml.replace("[lanes]\nenabled = true", "[lanes]\nenabled = false"))
  }
  const reviewerOf = async (laneId = "a") => {
    const state = await checkHandoff(repo)
    return (state.lanes ? state.lanes.find((lane) => lane._laneId === laneId) : state.current).reviewer
  }
  const claim = (extra = [], laneArgs = ["--lane", "a"]) => run(["handoff", "claim", ...(lanes ? laneArgs : []), "--task", "change", "--owner", "claude", "--files", "src/", ...extra])
  const grant = (laneArgs = ["--lane", "a"]) => run(["override", "grant", "--action", "same-lab-review", ...(lanes ? laneArgs : []), "--requested-by", "claude", "--confirmed-by", "human", "--reason", "only Anthropic reviewers are reachable today"])
  await fn({ repo, run, reviewerOf, claim, grant })
}

const FR3 = /same-lab[\s\S]*codex-reviewer[\s\S]*--reviewer any-other[\s\S]*btrain override grant --action same-lab-review/

describe("reviewer choice at claim (spec 023 T017)", () => {
  it("records the other-lab reviewer for owner claude when no reviewer is named", async () => {
    await withRepo({}, async ({ claim, reviewerOf }) => {
      const result = await claim()
      assert.equal(result.code, 0, result.stderr)
      assert.equal(await reviewerOf(), "codex-reviewer")
    })
  })

  it("takes the other-lab reviewer for --reviewer any-other, and keeps a valid explicit one", async () => {
    await withRepo({}, async ({ claim, reviewerOf }) => {
      assert.equal((await claim(["--reviewer", "any-other"])).code, 0)
      assert.equal(await reviewerOf(), "codex-reviewer")
    })
    await withRepo({ agents: ["claude", "claude-reviewer", "codex-reviewer", "codex-second"] }, async ({ claim, reviewerOf }) => {
      assert.equal((await claim(["--reviewer", "codex-second"])).code, 0, "an explicit other-lab reviewer")
      assert.equal(await reviewerOf(), "codex-second", "is never replaced by inference")
    })
  })
})

describe("an explicit same-lab reviewer needs a reason (spec 023 FR-3, T018, T019)", () => {
  it("refuses a same-lab reviewer with the FR-3 text, and a notify reviewer with no lab", async () => {
    await withRepo({}, async ({ claim, reviewerOf }) => {
      const sameLab = await claim(["--reviewer", "claude-reviewer"])
      assert.notEqual(sameLab.code, 0)
      assert.match(sameLab.stderr, FR3)
      const noLab = await claim(["--reviewer", "human"])
      assert.notEqual(noLab.code, 0)
      assert.match(noLab.stderr, FR3)
      assert.notEqual(await reviewerOf(), "claude-reviewer")
    })
  })

  it("accepts it with a same-lab-review override for the lane, which is then spent", async ({ skip }) => {
    await withRepo({}, async ({ repo, run, claim, grant, reviewerOf }) => {
      const granted = await grant()
      assert.equal(granted.code, 0, granted.stderr)
      const result = await claim(["--reviewer", "claude-reviewer"])
      assert.equal(result.code, 0, result.stderr)
      assert.equal(await reviewerOf(), "claude-reviewer")
      assert.deepEqual((await listActiveOverrides(repo)).filter((record) => record.action === "same-lab-review"), [], "the override is spent")
      // The next claim needs a new override.
      assert.equal((await run(["handoff", "resolve", "--lane", "a", "--summary", "abandon", "--actor", "claude"])).code, 0)
      assert.notEqual((await claim(["--reviewer", "claude-reviewer"])).code, 0)
    })
  })

  it("requires --lane for a same-lab-review grant in a repository with lanes", async () => {
    await withRepo({}, async ({ grant }) => {
      const result = await grant([])
      assert.notEqual(result.code, 0)
      assert.match(result.stderr, /requires --lane/)
    })
  })

  it("accepts a same-lab reviewer with no override when no other-lab agent is configured", async () => {
    await withRepo({ agents: ["claude", "claude-reviewer"] }, async ({ claim, reviewerOf }) => {
      const result = await claim(["--reviewer", "claude-reviewer"])
      assert.equal(result.code, 0, result.stderr)
      assert.equal(await reviewerOf(), "claude-reviewer")
    })
  })
})

describe("the same rule for a reassignment (spec 023 T018)", () => {
  it("refuses handoff update --reviewer <same-lab>, accepts it with the override, and still refuses a lane author", async () => {
    await withRepo({}, async ({ repo, run, claim, grant, reviewerOf }) => {
      assert.equal((await claim()).code, 0)
      const refused = await run(["handoff", "update", "--lane", "a", "--reviewer", "claude-reviewer", "--actor", "claude"])
      assert.notEqual(refused.code, 0)
      assert.match(refused.stderr, FR3)
      assert.equal(await reviewerOf(), "codex-reviewer")

      assert.equal((await grant()).code, 0)
      const allowed = await run(["handoff", "update", "--lane", "a", "--reviewer", "claude-reviewer", "--actor", "claude"])
      assert.equal(allowed.code, 0, allowed.stderr)
      assert.equal(await reviewerOf(), "claude-reviewer")
      assert.deepEqual((await listActiveOverrides(repo)).filter((record) => record.action === "same-lab-review"), [])

      const author = await run(["handoff", "update", "--lane", "a", "--reviewer", "claude", "--actor", "claude"])
      assert.notEqual(author.code === 0 && (await reviewerOf()) === "claude", true, "a lane author never becomes the reviewer")
    })
  })

  it("refuses it in a repository without lanes too", async () => {
    await withRepo({ lanes: false }, async ({ run, claim, reviewerOf }) => {
      assert.equal((await claim()).code, 0)
      const refused = await run(["handoff", "update", "--reviewer", "claude-reviewer", "--actor", "claude"])
      assert.notEqual(refused.code, 0)
      assert.match(refused.stderr, FR3)
      assert.equal(await reviewerOf(), "codex-reviewer")
    })
  })
})
