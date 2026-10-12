import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"

// Reverse-engineering skills that btrain bundles. `btrain init` and
// `btrain sync-skills` copy both surfaces, so a skill that differs between
// them reaches Claude and Codex as two different instructions.
// `reverse-engineer-anything` is vendored from morluto/rea under MIT;
// `clean-room-rebuild` is btrain's own and builds on it.
const SKILLS = ["reverse-engineer-anything", "clean-room-rebuild"]
const SURFACES = [".claude/skills", ".agents/skills"]

// Explicit walk: readdir's `recursive` option needs Node 18.17, and the
// README advertises Node.js 18+.
async function listFiles(dir) {
  const files = []
  async function walk(current, relative) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryRelative = path.join(relative, entry.name)
      if (entry.isDirectory()) await walk(path.join(current, entry.name), entryRelative)
      else if (entry.isFile()) files.push(entryRelative)
    }
  }
  await walk(dir, "")
  return files.sort()
}

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!match) return null
  const fields = {}
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (field) fields[field[1]] = field[2]
  }
  return fields
}

const read = (name, file = "SKILL.md") => fs.readFile(path.resolve(SURFACES[0], name, file), "utf8")

describe("bundled reverse-engineering skills", () => {
  for (const name of SKILLS) {
    it(`${name} is byte-identical on both surfaces`, async () => {
      const [claudeDir, agentsDir] = SURFACES.map((surface) => path.resolve(surface, name))
      const claudeFiles = await listFiles(claudeDir)
      assert.ok(claudeFiles.includes("SKILL.md"), `${name}/SKILL.md must exist`)
      assert.deepEqual(await listFiles(agentsDir), claudeFiles, `${name} must ship the same files on both surfaces`)
      for (const file of claudeFiles) {
        const [claude, agents] = await Promise.all([
          fs.readFile(path.join(claudeDir, file)),
          fs.readFile(path.join(agentsDir, file)),
        ])
        assert.ok(claude.equals(agents), `${name}/${file} differs between ${SURFACES.join(" and ")}`)
      }
    })

    it(`${name} frontmatter has its name and a parseable description`, async () => {
      const fields = frontmatter(await read(name))
      assert.ok(fields, "SKILL.md must open with a --- frontmatter block")
      assert.equal(fields.name, name, "name must match the skill directory")
      assert.ok(fields.description, "description must not be empty")
      if (!/^["']/.test(fields.description)) {
        // A plain YAML scalar cannot hold ": " or " #"; the harness would drop the skill.
        assert.doesNotMatch(fields.description, /: | #/, "quote the description or reword it")
      }
    })

    it(`${name} links only to files it ships`, async () => {
      const text = await read(name)
      for (const [, target] of text.matchAll(/\]\((references\/[^)#]+)\)/g)) {
        await assert.doesNotReject(fs.access(path.resolve(SURFACES[0], name, target)), `${name} links to missing ${target}`)
      }
    })
  }

  // MIT requires the copyright and permission notice to travel with every copy.
  it("reverse-engineer-anything keeps the upstream MIT notice and pinned commit", async () => {
    assert.match(await read("reverse-engineer-anything", "LICENSE"), /^MIT License\n\nCopyright \(c\) 2026 morluto/)
    assert.match(await read("reverse-engineer-anything", "VENDORED.md"), /commit\s+`[0-9a-f]{40}`/)
  })

  describe("clean-room-rebuild keeps the wall", () => {
    it("separates the study side from the build side", async () => {
      const text = await read("clean-room-rebuild")
      assert.match(text, /One agent may not hold both roles for the same target/)
      assert.match(text, /The build session must not see the target/)
    })

    it("gates on the terms of service before any observation", async () => {
      const text = await read("clean-room-rebuild")
      assert.ok(
        text.indexOf("legal-gate.md") < text.indexOf("### Phase 1."),
        "the legal gate must come before observation",
      )
      assert.match(await read("clean-room-rebuild", "references/legal-gate.md"), /forbid reverse engineering/)
    })

    it("forbids circumvention and never commits a raw capture", async () => {
      const text = await read("clean-room-rebuild")
      assert.match(text, /Never bypass auth/)
      assert.match(text, /Never commit a raw HAR/)
    })

    it("does not count unknown evidence as a pass", async () => {
      assert.match(await read("clean-room-rebuild"), /Unknown, skipped, truncated, or contradictory evidence never counts as a pass/)
    })
  })
})
