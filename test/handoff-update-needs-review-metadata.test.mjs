// spec 015 row 19 on a `needs-review` lane (Option 1, chosen by Brian Farish
// on 2026-09-30). A metadata-only `handoff update` (no --status, --files,
// --owner, or --reviewer) leaves the lane where row 2 put it, so row 2's
// reviewable-diff and code-simplifier checks and the cgraph review packet and
// audit stay with the transition into `needs-review`. Only an edit to the
// reviewer context or its base re-checks that the context is still complete.
// patchHandoff used to gate on the resulting status, so every later `--pr` or
// `--next` on a lane whose work lives in a separate git worktree re-ran the
// diff check in the shared checkout and failed until --no-diff was added. The
// formal harness cannot see this: its repos are plain directories, so the
// base never resolves and the diff check is skipped.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { claimHandoff, patchHandoff, readLockRegistry } from "../src/brain_train/core.mjs"

const exec = promisify(execFile)

const REVIEW_CONTEXT = {
  preflight: "read the locked files and the worktree branch diff",
  changed: "src/a/feature.mjs - lane x work, committed on branch lane-x-work",
  verification: "node --test passed in the lane worktree",
  gap: "none",
  why: "lane x work is ready for review",
  "review-ask": "check src/a/feature.mjs",
}

function projectToml({ lanes, cgraph }) {
  return [
    "[project]",
    'name = "needs-review-metadata"',
    "",
    "[agents]",
    'active = ["alpha", "beta"]',
    "",
    ...(lanes
      ? ["[lanes]", "enabled = true", 'ids = ["x"]', "", "[lanes.x]", 'handoff_path = ".claude/collab/HANDOFF_X.md"', ""]
      : []),
    "[pr_flow]",
    "enabled = true",
    'base = "main"',
    'required_bots = ["codex"]',
    "",
    ...(cgraph ? ["[cgraph]", `bin_path = ${JSON.stringify(cgraph.bin)}`, `socket_path = ${JSON.stringify(cgraph.socket)}`, ""] : []),
  ].join("\n")
}

async function git(cwd, ...args) {
  const { stdout } = await exec("git", ["-C", cwd, ...args])
  return stdout.trim()
}

async function asAgent(agent, fn) {
  const previous = process.env.BTRAIN_AGENT
  process.env.BTRAIN_AGENT = agent
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.BTRAIN_AGENT
    else process.env.BTRAIN_AGENT = previous
  }
}

async function readEvents(repo, lanes) {
  const file = path.join(repo, ".btrain", "events", lanes ? "lane-x.jsonl" : "repo.jsonl")
  return (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

async function lastUpdateEvent(repo, lanes) {
  return (await readEvents(repo, lanes)).reverse().find((event) => event.type === "update")
}

// A stand-in cgraph binary: review-packet and audit only, one JSON line per
// call in a log, and a flag file that turns the audit into a hard violation.
async function writeFakeCgraph(dir) {
  const bin = path.join(dir, "fake-cgc")
  const log = path.join(dir, "cgc-calls.jsonl")
  const hardFlag = path.join(dir, "cgc-hard")
  const manifest = {
    ok: true,
    kind: "manifest",
    schema_version: "1.0",
    commands: [{ name: "review-packet" }, { name: "audit" }],
    total_commands: 2,
  }
  const script = [
    "#!/usr/bin/env node",
    "const fs = require('fs')",
    "const [cmd = '', ...rest] = process.argv.slice(2)",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cmd, argv: rest }) + '\\n')`,
    `const hard = fs.existsSync(${JSON.stringify(hardFlag)}) ? 1 : 0`,
    "const replies = {",
    `  manifest: ${JSON.stringify(manifest)},`,
    "  'review-packet': { source: 'locked_files', touched_nodes: [{ uid: 'n1' }], advisories: [], truncated: false },",
    "  audit: {",
    "    ok: true, kind: 'audit', counts: { warn: 0, hard }, standards_evaluated: 1, scope_source: 'explicit_files',",
    "    advisories: hard ? [{ severity: 'hard', standard_id: 'C99', kind: 'forbidden_pattern',",
    "      suggestion: 'Remove the forbidden call.', offenders: [{ path: 'src/a/feature.mjs' }] }] : [],",
    "  },",
    "}",
    "process.stdout.write(JSON.stringify(replies[cmd] || { ok: true, kind: cmd }))",
  ].join("\n")
  await fs.writeFile(bin, script, "utf8")
  await fs.chmod(bin, 0o755)
  return {
    bin,
    socket: path.join(dir, "no-cgraph-daemon.sock"),
    async gateCalls() {
      const content = await fs.readFile(log, "utf8").catch(() => "")
      return content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).cmd)
        .filter((cmd) => cmd === "review-packet" || cmd === "audit")
    },
    reportHardViolation: () => fs.writeFile(hardFlag, "1"),
  }
}

// A real repository whose lane work lives only on a branch checked out in a
// separate git worktree. The shared checkout, where btrain runs, stays on
// main with a clean tree, so `<base>...HEAD` there is empty and the lane
// enters review with --no-diff, as worktree lanes do today.
async function withWorktreeLaneInReview(fn, { lanes = true, cgraph = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-needs-review-metadata-"))
  const repo = path.join(root, "repo")
  const worktree = path.join(root, "lane-x-worktree")
  const previousHome = process.env.BRAIN_TRAIN_HOME
  process.env.BRAIN_TRAIN_HOME = path.join(root, "home")
  try {
    await exec("git", ["init", "-q", "-b", "main", repo])
    await git(repo, "config", "user.email", "test@example.com")
    await git(repo, "config", "user.name", "Test Bot")
    await git(repo, "config", "commit.gpgsign", "false")
    await fs.mkdir(path.join(repo, "src", "a"), { recursive: true })
    await fs.writeFile(path.join(repo, "src", "a", "base.mjs"), "export const base = 1\n")
    await fs.writeFile(path.join(repo, ".gitignore"), ".btrain/\n.claude/\n")
    await git(repo, "add", "-A")
    await git(repo, "commit", "-q", "-m", "base")
    const baseSha = await git(repo, "rev-parse", "HEAD")
    await git(repo, "worktree", "add", "-q", "-b", "lane-x-work", worktree, baseSha)
    await fs.writeFile(path.join(worktree, "src", "a", "feature.mjs"), "export const feature = true\n")
    await git(worktree, "add", "-A")
    await git(worktree, "commit", "-q", "-m", "lane x work")
    const headSha = await git(worktree, "rev-parse", "HEAD")

    const fakeCgraph = cgraph ? await writeFakeCgraph(root) : null
    await fs.mkdir(path.join(repo, ".btrain"), { recursive: true })
    await fs.mkdir(path.join(repo, ".claude", "collab"), { recursive: true })
    await fs.writeFile(path.join(repo, ".btrain", "project.toml"), projectToml({ lanes, cgraph: fakeCgraph }))

    const lane = lanes ? { lane: "x" } : {}
    await asAgent("alpha", () =>
      claimHandoff(repo, { ...lane, task: "worktree lane", owner: "alpha", reviewer: "beta", files: "src/a/" }),
    )
    await asAgent("alpha", () =>
      patchHandoff(repo, {
        ...lane,
        actor: "alpha",
        status: "needs-review",
        base: `${baseSha}..${headSha} on branch lane-x-work (worktree ${worktree})`,
        ...REVIEW_CONTEXT,
        "no-diff": true,
        "no-dispatch": true,
      }),
    )
    await fn({ repo, lane, fakeCgraph })
  } finally {
    if (previousHome === undefined) delete process.env.BRAIN_TRAIN_HOME
    else process.env.BRAIN_TRAIN_HOME = previousHome
    await fs.rm(root, { recursive: true, force: true })
  }
}

describe("metadata-only update on a needs-review lane (spec 015 row 19)", () => {
  it("accepts --pr and --next from either lane agent without --no-diff when the diff lives on a worktree branch", async () => {
    await withWorktreeLaneInReview(async ({ repo, lane }) => {
      const linked = await asAgent("alpha", () =>
        patchHandoff(repo, { ...lane, actor: "alpha", pr: "84", "no-dispatch": true }),
      )
      assert.equal(linked.status, "needs-review")
      assert.equal(String(linked.prNumber), "84")

      const noted = await asAgent("beta", () =>
        patchHandoff(repo, { ...lane, actor: "beta", next: "reviewing branch lane-x-work", "no-dispatch": true }),
      )
      assert.equal(noted.status, "needs-review")
      assert.equal(noted.nextAction, "reviewing branch lane-x-work")

      const event = await lastUpdateEvent(repo, true)
      assert.equal(event.details.transitionEvent, "handoff update --metadata")
      assert.equal(event.details["transition-advisory"], undefined, "a lane agent's metadata update is row 19")
      const registry = await readLockRegistry(repo)
      assert.deepEqual(registry.locks.filter((lock) => lock.lane === "x").map((lock) => lock.path), ["src/a/"])
    })
  })

  it("re-checks the reviewer context when an update edits it or the base, without the diff check", async () => {
    await withWorktreeLaneInReview(async ({ repo, lane }) => {
      // The whole field list is matched: a trailing "reviewable diff in
      // locked files" would mean the diff check ran as well.
      await assert.rejects(
        asAgent("alpha", () => patchHandoff(repo, { ...lane, actor: "alpha", verification: "pending", "no-dispatch": true })),
        /Missing or placeholder fields: Verification run\./,
      )
      await assert.rejects(
        asAgent("alpha", () => patchHandoff(repo, { ...lane, actor: "alpha", base: "", "no-dispatch": true })),
        /Missing or placeholder fields: Base\./,
      )

      const edited = await asAgent("alpha", () =>
        patchHandoff(repo, {
          ...lane,
          actor: "alpha",
          verification: "node --test passed again after rebasing lane-x-work",
          "no-dispatch": true,
        }),
      )
      assert.equal(edited.status, "needs-review")
      const rebased = await asAgent("alpha", () =>
        patchHandoff(repo, { ...lane, actor: "alpha", base: "main (lane-x-work rebased)", "no-dispatch": true }),
      )
      assert.equal(rebased.status, "needs-review")
    })
  })

  it("keeps the full needs-review gate for an explicit --status needs-review", async () => {
    await withWorktreeLaneInReview(async ({ repo, lane }) => {
      await assert.rejects(
        asAgent("alpha", () =>
          patchHandoff(repo, { ...lane, actor: "alpha", status: "needs-review", "no-dispatch": true }),
        ),
        /Missing or placeholder fields: reviewable diff in locked files\./,
      )
    })
  })
})

describe("cgraph on a needs-review lane (spec 015 row 19)", () => {
  it("keeps the transition's review packet and audit, so a later hard violation cannot reject a metadata update", async () => {
    await withWorktreeLaneInReview(async ({ repo, lane, fakeCgraph }) => {
      assert.deepEqual(await fakeCgraph.gateCalls(), ["review-packet", "audit"], "entering review runs the packet and the audit")
      await fakeCgraph.reportHardViolation()

      const linked = await asAgent("alpha", () =>
        patchHandoff(repo, { ...lane, actor: "alpha", pr: "84", "no-dispatch": true }),
      )
      assert.equal(linked.status, "needs-review")
      assert.deepEqual(await fakeCgraph.gateCalls(), ["review-packet", "audit"], "a metadata update runs neither again")

      const events = await readEvents(repo, true)
      assert.equal(events.at(-1).details.cgraph, undefined)
      const latestCgraph = [...events].reverse().find((event) => event.details?.cgraph)
      assert.equal(latestCgraph.details.requestedStatus, "needs-review", "the transition's packet stays the lane's latest")

      await assert.rejects(
        asAgent("alpha", () =>
          patchHandoff(repo, { ...lane, actor: "alpha", status: "needs-review", "no-diff": true, "no-dispatch": true }),
        ),
        /hard violation/i,
      )
    }, { cgraph: true })
  })
})

describe("single-handoff mode (spec 015 row 19)", () => {
  it("applies the same rule without [lanes]", async () => {
    await withWorktreeLaneInReview(async ({ repo, lane, fakeCgraph }) => {
      await fakeCgraph.reportHardViolation()

      const linked = await asAgent("alpha", () =>
        patchHandoff(repo, { ...lane, actor: "alpha", pr: "84", "no-dispatch": true }),
      )
      assert.equal(linked.status, "needs-review")
      assert.equal(String(linked.prNumber), "84")
      assert.deepEqual(await fakeCgraph.gateCalls(), ["review-packet", "audit"])
      assert.equal((await lastUpdateEvent(repo, false)).details.cgraph, undefined)

      await assert.rejects(
        asAgent("alpha", () => patchHandoff(repo, { ...lane, actor: "alpha", gap: "pending", "no-dispatch": true })),
        /Missing or placeholder fields: Remaining gaps\./,
      )
      await assert.rejects(
        asAgent("alpha", () =>
          patchHandoff(repo, { ...lane, actor: "alpha", status: "needs-review", "no-dispatch": true }),
        ),
        /hard violation/i,
      )
    }, { lanes: false, cgraph: true })
  })
})
