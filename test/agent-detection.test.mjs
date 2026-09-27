import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { collectRuntimeAgentHints } from "../src/brain_train/runtime_agent_hints.mjs"
import { withoutAgentIdentity, withoutLaneScope } from "./helpers/runner-scope.mjs"

const exec = promisify(execFile)
const CLI_PATH = fileURLToPath(new URL("../src/brain_train/cli.mjs", import.meta.url))

// The PATH path_helper gives every macOS login shell: /etc/paths plus
// /etc/paths.d/10-cryptex. codex.system is an Apple system cryptex, not the
// Codex CLI.
const MACOS_PATH = [
  "/usr/local/bin",
  "/System/Cryptexes/App/usr/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin",
  "/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin",
  "/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/appleinternal/bin",
].join(":")

const THREAD_ID = "00000000-0000-7000-8000-000000000000"
const NO_HINTS = "agent check: unknown (no runtime hints; set BTRAIN_AGENT to pin it if needed)"

function macosEnv(extra = {}) {
  return { PATH: MACOS_PATH, HOME: "/Users/dev", SHELL: "/bin/zsh", ...extra }
}

describe("collectRuntimeAgentHints", () => {
  it("finds no hint in a plain macOS shell, whose PATH holds the codex.system cryptex", () => {
    assert.deepEqual(collectRuntimeAgentHints(macosEnv()), [])
  })

  it("finds claude, and only claude, in a Claude Code shell on macOS", () => {
    assert.deepEqual(
      collectRuntimeAgentHints(macosEnv({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" })),
      ["claude"],
    )
  })

  it("finds codex from each variable Codex sets for the commands it runs", () => {
    for (const [key, value] of Object.entries({
      CODEX_THREAD_ID: THREAD_ID,
      CODEX_CI: "1",
      CODEX_SHELL: "1",
      CODEX_SANDBOX: "seatbelt",
      CODEX_SANDBOX_NETWORK_DISABLED: "1",
      CODEX_MANAGED_BY_NPM: "1",
    })) {
      assert.deepEqual(collectRuntimeAgentHints(macosEnv({ [key]: value })), ["codex"], key)
    }
  })

  it("finds gemini from GEMINI_CLI", () => {
    assert.deepEqual(collectRuntimeAgentHints(macosEnv({ GEMINI_CLI: "1" })), ["gemini"])
  })

  it("ignores a lone PATH or HOME that contains an agent name", () => {
    for (const env of [
      { PATH: "/Users/x/claude-notes/bin:/usr/bin:/bin" },
      { PATH: "/opt/codex-tools/bin:/usr/bin:/bin" },
      { PATH: MACOS_PATH },
      { HOME: "/Users/claude" },
      { HOME: "/home/codex" },
    ]) {
      assert.deepEqual(collectRuntimeAgentHints(env), [], JSON.stringify(env))
    }
  })

  it("ignores other variables whose names or values mention an agent", () => {
    const env = {
      // Claude Code's TMPDIR puts "claude" in every temp path.
      TMPDIR: "/private/tmp/claude-502/",
      PWD: "/Users/dev/claude-notes",
      // GitHub Actions exports the pull request's head branch and actor.
      GITHUB_HEAD_REF: "codex/fix-ci",
      GITHUB_ACTOR: "claude-bot",
      OPUS_LIB_DIR: "/opt/homebrew/opt/opus/lib",
      ANTHROPIC_MODEL: "claude-opus-4-6",
      // User configuration, present whichever agent runs.
      CODEX_HOME: "/Users/dev/.codex",
      CLAUDE_CONFIG_DIR: "/Users/dev/.claude",
      GEMINI_API_KEY: "test-key",
    }
    assert.deepEqual(collectRuntimeAgentHints(env), [])
  })

  it("treats an empty marker as unset", () => {
    assert.deepEqual(collectRuntimeAgentHints({ CLAUDECODE: "", CODEX_THREAD_ID: "  " }), [])
  })

  it("reports both agents when one agent CLI runs inside the other", () => {
    // A Codex reviewer started from a Claude Code shell inherits CLAUDECODE.
    // Only BTRAIN_AGENT settles that, and btrain's own dispatcher sets it.
    assert.deepEqual(
      collectRuntimeAgentHints(macosEnv({ CLAUDECODE: "1", CODEX_THREAD_ID: THREAD_ID })),
      ["claude", "codex"],
    )
  })
})

describe("btrain handoff agent check", () => {
  let tmpDir
  let baseEnv
  let pairRepo
  let legacyRepo

  async function initRepo(name, agents) {
    const repo = path.join(tmpDir, name)
    await fs.mkdir(repo)
    await exec("git", ["init", "-q", repo], { env: baseEnv })
    const agentArgs = agents.flatMap((agent) => ["--agent", agent])
    await exec(process.execPath, [CLI_PATH, "init", repo, ...agentArgs], { cwd: repo, env: baseEnv })
    return repo
  }

  async function agentCheck(repo, extraEnv) {
    const { stdout } = await exec(process.execPath, [CLI_PATH, "handoff", "--repo", repo], {
      cwd: repo,
      env: { ...baseEnv, ...extraEnv },
    })
    return stdout.split("\n").find((line) => line.startsWith("agent check:"))
  }

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-agent-detection-"))
    // No inherited variables: only what a macOS login shell would have.
    baseEnv = {
      PATH: MACOS_PATH,
      HOME: tmpDir,
      BRAIN_TRAIN_HOME: path.join(tmpDir, ".btrain-test-home"),
      BTRAIN_NO_REVIEW_DISPATCH: "1",
    }
    pairRepo = await initRepo("pair", ["claude", "codex"])
    // init gives these the runners "claude -p" and "codex".
    legacyRepo = await initRepo("legacy", ["Opus 4.6", "GPT-5 Codex"])
  })

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it("names claude in a Claude Code shell on macOS instead of reporting ambiguous", async () => {
    assert.equal(await agentCheck(pairRepo, { CLAUDECODE: "1" }), "agent check: claude (runtime hints (claude))")
  })

  it("names codex from the variables Codex sets", async () => {
    assert.equal(
      await agentCheck(pairRepo, { CODEX_THREAD_ID: THREAD_ID, CODEX_CI: "1", CODEX_SHELL: "1" }),
      "agent check: codex (runtime hints (codex))",
    )
  })

  it("finds no runtime hints when only PATH and HOME mention an agent", async () => {
    const home = path.join(tmpDir, "codex-home")
    await fs.mkdir(home)
    assert.equal(
      await agentCheck(pairRepo, { PATH: `/Users/x/claude-notes/bin:${MACOS_PATH}`, HOME: home }),
      NO_HINTS,
    )
  })

  it("keeps BTRAIN_AGENT as the override inside another agent's shell", async () => {
    assert.equal(
      await agentCheck(pairRepo, { CLAUDECODE: "1", BTRAIN_AGENT: "codex" }),
      "agent check: codex (env override (codex))",
    )
  })

  it("names an Opus-named agent through its claude runner", async () => {
    assert.equal(await agentCheck(legacyRepo, { CLAUDECODE: "1" }), "agent check: Opus 4.6 (runtime hints (claude))")
  })

  it("does not name an Opus-named agent from an OPUS_* library variable", async () => {
    assert.equal(await agentCheck(legacyRepo, { OPUS_LIB_DIR: "/opt/homebrew/opt/opus/lib" }), NO_HINTS)
  })
})

describe("test harness environment", () => {
  it("strips the running agent's markers from test subprocess environments", () => {
    const clean = withoutLaneScope(macosEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CODEX_THREAD_ID: THREAD_ID,
      CODEX_CI: "1",
      GEMINI_CLI: "1",
    }))
    assert.deepEqual(collectRuntimeAgentHints(clean), [])
    assert.equal(clean.PATH, MACOS_PATH)
    // Whichever agent runs this suite, its subprocesses must not detect it.
    assert.deepEqual(collectRuntimeAgentHints(withoutLaneScope()), [])
  })

  it("hides the running agent from in-process detection, then restores it", async () => {
    const saved = { CLAUDECODE: process.env.CLAUDECODE, BTRAIN_AGENT: process.env.BTRAIN_AGENT }
    process.env.CLAUDECODE = "1"
    process.env.BTRAIN_AGENT = "claude"
    try {
      const inside = await withoutAgentIdentity(() => ({
        hints: collectRuntimeAgentHints(),
        pin: process.env.BTRAIN_AGENT,
      }))
      assert.deepEqual(inside, { hints: [], pin: undefined })
      assert.equal(process.env.CLAUDECODE, "1")
      assert.equal(process.env.BTRAIN_AGENT, "claude")
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
