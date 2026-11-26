// Spec 023 FR-1, FR-3, FR-4 doctor findings through
// src/brain_train/review/doctor.mjs (part of task T007).
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { collectReviewDoctorFindings } from "../src/brain_train/review/doctor.mjs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

const config = (agents) => ({ agents })

describe("collectReviewDoctorFindings", () => {
  it("lists every agent's lab and where it came from, with no warning when each owner has an other-lab reviewer", () => {
    const findings = collectReviewDoctorFindings(config({
      active: ["claude", "codex", "cursor"],
      runners: { claude: "claude -p", codex: "codex exec", cursor: "agent -p" },
      labs: { cursor: "google" },
    }))
    assert.deepEqual(findings.labs, [
      "claude: anthropic (from the claude runner)",
      "codex: openai (from the codex runner)",
      "cursor: google (from [agents.labs])",
    ])
    assert.deepEqual(findings.errors, [])
    // agent has no fresh-session entry, so it is never a same-lab reviewer.
    assert.deepEqual(findings.warnings, [
      'Agent "cursor" runs "agent", which has no fresh-session entry in the runner table, so it is never dispatched as a same-lab reviewer.',
    ])
  })

  it("warns for an agent with no lab, and names the no-other-lab owner", () => {
    const { labs, warnings } = collectReviewDoctorFindings(config({
      active: ["claude", "claude-reviewer", "cursor", "human"],
      runners: { claude: "claude -p", "claude-reviewer": "claude -p", cursor: "agent -p", human: "notify" },
    }))
    assert.ok(labs.includes("cursor: no lab"))
    assert.ok(labs.includes("human: no lab"))
    assert.ok(warnings.some((line) => line.startsWith('Agent "cursor" has no lab')))
    assert.ok(warnings.some((line) => line.startsWith('Agent "human" has no lab')))
    assert.ok(warnings.some((line) => line.includes('review "claude"\'s lanes')))
    assert.ok(warnings.some((line) => line.includes('review "claude-reviewer"\'s lanes')))
    assert.ok(!warnings.some((line) => line.includes('review "human"\'s lanes')), "a notify agent is not an owner that dispatches")
  })

  it("warns about an invalid [agents.labs] value and an unknown reviewer_order name", () => {
    const { warnings } = collectReviewDoctorFindings({
      agents: { active: ["claude", "codex"], runners: { claude: "claude -p", codex: "codex exec" }, labs: { codex: "Open AI" } },
      review: { reviewer_order: ["codex", "nobody"] },
    })
    assert.ok(warnings.some((line) => line.includes('[agents.labs] "codex" = "Open AI" is not a lowercase lab name')))
    assert.ok(warnings.some((line) => line.includes('reviewer_order names "nobody"')))
  })

  it("reports a review setting that does not parse as an error", () => {
    const { errors } = collectReviewDoctorFindings({
      agents: { active: ["claude"], runners: { claude: "claude -p" } },
      review: { silence_limit: "soon" },
    })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /silence_limit = "soon" is not a duration/)
  })

  it("never turns a missing lab into an error", () => {
    const { errors } = collectReviewDoctorFindings(config({ active: ["a", "b"], runners: { a: "agent -p", b: "./review.sh" } }))
    assert.deepEqual(errors, [])
  })
})

// The rest of T007: `btrain doctor` appends these findings for each repository.
describe("btrain doctor shows the review findings (spec 023 T007)", () => {
  const CLI_PATH = path.resolve("src/brain_train/cli.mjs")

  function cliEnv(home) {
    const env = { ...process.env }
    for (const key of ["BTRAIN_AGENT", "BRAIN_TRAIN_AGENT", "BTRAIN_LANE", "BTRAIN_LANE_LOCKED", "BTRAIN_REPO", "BTRAIN_LOOP_ACTIVE"]) delete env[key]
    return { ...env, BRAIN_TRAIN_HOME: home, BTRAIN_NO_REVIEW_DISPATCH: "1", CI: "true" }
  }

  async function btrain(args, { cwd, home }) {
    try {
      const result = await exec("node", [CLI_PATH, ...args], { cwd, env: cliEnv(home), maxBuffer: 5 * 1024 * 1024 })
      return { stdout: result.stdout, code: 0 }
    } catch (error) {
      return { stdout: error.stdout || "", stderr: error.stderr || "", code: typeof error.code === "number" ? error.code : 1 }
    }
  }

  async function withRepo(agents, fn) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-review-doctor-")))
    const home = path.join(root, "home")
    const repo = path.join(root, "repo")
    try {
      await exec("git", ["init", "-q", "-b", "main", repo])
      const init = await btrain(["init", repo, "--tracked", ...agents.flatMap((agent) => ["--agent", agent]), "--core-only", "--no-hooks"], { cwd: repo, home })
      assert.equal(init.code, 0, init.stderr)
      await fn({ repo, home, doctor: () => btrain(["doctor", "--repo", repo], { cwd: repo, home }) })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }

  // The doctor lines of one repository's result.
  const line = (stdout, label) => stdout.split("\n").find((text) => text.startsWith(`  ${label}: `)) || ""

  it("lists every agent's lab, and warns without changing the exit code for an agent with none", async () => {
    await withRepo(["claude", "codex", "alpha"], async ({ doctor, repo }) => {
      const before = await doctor()
      assert.equal(line(before.stdout, "labs"), "  labs: claude: anthropic (from the claude runner) | codex: openai (from the codex runner) | alpha: no lab")
      assert.match(line(before.stdout, "warnings"), /Agent "alpha" has no lab/)
      assert.doesNotMatch(line(before.stdout, "issues"), /lab/)

      // A clean repository with labs for everyone: same exit code, no lab warning.
      const toml = path.join(repo, ".btrain", "project.toml")
      await fs.appendFile(toml, '\n[agents.labs]\nalpha = "google"\n')
      const after = await doctor()
      assert.equal(after.code, before.code, "a missing lab never changes the exit code")
      assert.match(line(after.stdout, "labs"), /alpha: google \(from \[agents\.labs\]\)/)
      assert.doesNotMatch(line(after.stdout, "warnings"), /has no lab/)
    })
  })

  it("warns when an owner has no other-lab agent with a cli runner", async () => {
    await withRepo(["claude", "claude-reviewer"], async ({ doctor }) => {
      const { stdout } = await doctor()
      assert.match(line(stdout, "warnings"), /No other-lab agent with a cli runner can review "claude"'s lanes/)
    })
  })

  it("reports a review setting that does not parse as an issue", async () => {
    await withRepo(["claude", "codex"], async ({ doctor, repo }) => {
      const clean = await doctor()
      await fs.appendFile(path.join(repo, ".btrain", "project.toml"), '\n[review]\nsilence_limit = "soon"\n')
      const result = await doctor()
      assert.match(line(result.stdout, "issues"), /silence_limit = "soon" is not a duration/)
      assert.equal(line(result.stdout, "healthy"), "  healthy: no")
      assert.notEqual(result.code, 0)
      assert.equal(line(clean.stdout, "issues"), "", "the clean repository had no issue")
    })
  })
})
