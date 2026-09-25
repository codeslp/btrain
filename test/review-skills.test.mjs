import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"

// Review skills that btrain bundles for reviewers. `btrain init` and
// `btrain sync-skills` copy every directory under both surfaces, so a skill
// that exists on only one surface, or differs between them, reaches Claude
// and Codex reviewers as two different instructions.
const REVIEW_SKILLS = ["red-team", "mutation-round"]
const SURFACES = [".claude/skills", ".agents/skills"]

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort()
}

// Enough of YAML frontmatter for `key: value` lines, plus indented
// continuation lines for folded (`>`) values.
function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!match) return null
  const fields = {}
  let key = null
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (field) {
      key = field[1]
      fields[key] = { raw: field[2], value: /^[>|]-?$/.test(field[2]) ? "" : field[2] }
    } else if (key && /^\s+\S/.test(line)) {
      fields[key].value = `${fields[key].value} ${line.trim()}`.trim()
    }
  }
  return fields
}

describe("bundled review skills", () => {
  for (const name of REVIEW_SKILLS) {
    it(`${name} ships on both skill surfaces`, async () => {
      for (const surface of SURFACES) {
        await assert.doesNotReject(
          fs.access(path.resolve(surface, name, "SKILL.md")),
          `${surface}/${name}/SKILL.md must exist`,
        )
      }
    })

    it(`${name} is byte-identical on both surfaces`, async () => {
      const [claudeDir, agentsDir] = SURFACES.map((surface) => path.resolve(surface, name))
      const claudeFiles = await listFiles(claudeDir)
      assert.deepEqual(await listFiles(agentsDir), claudeFiles, `${name} must ship the same files on both surfaces`)
      for (const file of claudeFiles) {
        const [claude, agents] = await Promise.all([
          fs.readFile(path.join(claudeDir, file)),
          fs.readFile(path.join(agentsDir, file)),
        ])
        assert.ok(claude.equals(agents), `${name}/${file} differs between ${SURFACES.join(" and ")}`)
      }
    })

    it(`${name} frontmatter has its name and a description`, async () => {
      const text = await fs.readFile(path.resolve(SURFACES[0], name, "SKILL.md"), "utf8")
      const fields = parseFrontmatter(text)

      assert.ok(fields, "SKILL.md must open with a --- frontmatter block")
      assert.equal(fields.name?.value, name, "name must match the skill directory")
      assert.ok(fields.description?.value, "description must not be empty")
      if (!/^["']/.test(fields.description.raw)) {
        // A plain YAML scalar cannot hold ": " or " #"; the harness would drop the skill.
        assert.doesNotMatch(fields.description.value, /: | #/, "quote the description or reword it")
      }
    })
  }

  it("red-team files a break with the reason code and tag btrain accepts", async () => {
    const text = await fs.readFile(path.resolve(SURFACES[0], "red-team", "SKILL.md"), "utf8")

    assert.match(text, /--reason-code regression-risk/)
    assert.match(text, /--reason-tag red-team/)
  })

  it("mutation-round has authors label each pinning test with its mutant", async () => {
    const text = await fs.readFile(path.resolve(SURFACES[0], "mutation-round", "SKILL.md"), "utf8")

    assert.match(text, /\/\/ M\d+\. /)
  })

  // Review P2-3: a mutant re-applied, a file restored or a repro written in the
  // author's tree destroys or buries their uncommitted work. Both skills must
  // send that work to a throwaway worktree, and their commands must run as written.
  describe("keeps mutants and repros out of the author's tree", () => {
    const read = (name) => fs.readFile(path.resolve(SURFACES[0], name, "SKILL.md"), "utf8")

    it("mutation-round revert-checks in a throwaway worktree at the pin commit", async () => {
      assert.match(await read("mutation-round"), /git worktree add --detach "\$\{TMPDIR:-\/tmp\}\/[^"]+" <pin-sha>/)
    })

    it("mutation-round scopes every checkout-restore to the throwaway worktree", async () => {
      const lines = (await read("mutation-round")).split("\n").filter((line) => line.includes("git checkout --"))
      assert.ok(lines.length > 0)
      for (const line of lines) {
        assert.match(line, /throwaway worktree/, line)
        assert.match(line, /author's tree/, line)
      }
    })

    it("red-team attacks from a throwaway worktree and hands over a file or a patch", async () => {
      const text = await read("red-team")
      assert.match(text, /git worktree add --detach "\$\{TMPDIR:-\/tmp\}\/[^"]+" <lane-head-sha>/)
      assert.match(text, /Never write untracked files into the author's tree/)
    })

    for (const name of REVIEW_SKILLS) {
      it(`${name} commands run as written`, async () => {
        const text = await read(name)
        assert.doesNotMatch(text, /\$TMPDIR/, "use ${TMPDIR:-/tmp}; TMPDIR is unset on many Linux hosts")
        for (const [, dir] of text.matchAll(/tar -x -C "([^"]+)"/g)) {
          assert.ok(text.includes(`mkdir -p "${dir}"`), `tar -x -C "${dir}" needs mkdir -p "${dir}" first`)
        }
      })
    }
  })
})
