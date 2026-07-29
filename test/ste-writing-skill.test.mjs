import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

const CLAUDE_DIR = path.resolve(".claude/skills/ste-writing")
const AGENTS_DIR = path.resolve(".agents/skills/ste-writing")

describe("ste-writing skill distribution", () => {
  it("keeps the Claude and Codex skill surfaces identical", async () => {
    for (const file of ["SKILL.md", "NOTICE"]) {
      const claudeCopy = await fs.readFile(path.join(CLAUDE_DIR, file), "utf8")
      const agentsCopy = await fs.readFile(path.join(AGENTS_DIR, file), "utf8")
      assert.equal(agentsCopy, claudeCopy, `${file} must match across skill surfaces`)
    }
  })

  it("retains the upstream MIT notice on both surfaces", async () => {
    for (const dir of [CLAUDE_DIR, AGENTS_DIR]) {
      const notice = await fs.readFile(path.join(dir, "NOTICE"), "utf8")
      assert.match(notice, /MIT License/)
      assert.match(notice, /Copyright \(c\) 2026 Ege Çelebi/)
    }
    const skill = await fs.readFile(path.join(CLAUDE_DIR, "SKILL.md"), "utf8")
    assert.match(skill, /NOTICE/, "SKILL.md must point readers at the NOTICE file")
  })

  it("ships the advisory linter next to the canonical skill", async () => {
    await assert.doesNotReject(fs.access(path.join(CLAUDE_DIR, "scripts", "ste-lint.py")))
    await assert.doesNotReject(fs.access(path.join(CLAUDE_DIR, "scripts", "test_ste_lint.py")))
  })

  it("passes the linter regression suite", (t) => {
    const result = spawnSync("python3", [path.join(CLAUDE_DIR, "scripts", "test_ste_lint.py")], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    })
    if (result.error && result.error.code === "ENOENT") {
      t.skip("python3 not available")
      return
    }
    assert.equal(result.status, 0, `linter regression suite failed:\n${result.stdout}\n${result.stderr}`)
  })
})
