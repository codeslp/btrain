import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { listFiles, parseFrontmatter } from "./helpers/skill-files.mjs"

// Reverse-engineering skills that btrain bundles. `btrain init` and
// `btrain sync-skills` copy both surfaces, so a skill that differs between
// them reaches Claude and Codex as two different instructions.
// `reverse-engineer-anything` is vendored from morluto/rea under MIT;
// `clean-room-rebuild` is btrain's own and builds on it.
const SKILLS = ["reverse-engineer-anything", "clean-room-rebuild"]
const SURFACES = [".claude/skills", ".agents/skills"]

// Git blob SHA-1 of each vendored file in morluto/rea at c9aecde (the tree
// object, fetched from the GitHub API). VENDORED.md says not to edit these
// files; a matching edit on both surfaces would pass the surface check, so
// pin them to upstream directly. Upstream's SKILL.md ships verbatim as
// references/upstream-SKILL.md behind a btrain-owned SKILL.md that excludes
// rebuilds, so an agent that asks to "reverse engineer X and rebuild it"
// reaches clean-room-rebuild's legal gate instead of this skill.
const UPSTREAM_SKILL = "references/upstream-SKILL.md"
const VENDORED_BLOBS = {
  [UPSTREAM_SKILL]: "63f16b9780979e9ecf4beae4b5de510d355e23a1",
  "LICENSE": "2d476d24fa5a9ae2ab35e5fd121494049eb2ee5d",
  "references/android-applications.md": "896f15f85efaa03503eacfd598bed7db6bf791ea",
  "references/connection-and-recovery.md": "ed8393bd9a020f7a31adfa050e47b3d673db7580",
  "references/evidence-workflows.md": "c651287f3e8f7aa5b368c2ec9356b0c6f4a8807e",
  "references/javascript-applications.md": "29b4718fefdc0abcba74910199be83b8f7242393",
  "references/native-and-artifacts.md": "e2f3230dbc9f7b0ce14754453ca7cca69a69697b",
  "references/runtime-observation.md": "3e16a3e19e0957a5c4cf3660e2bca96f78062290",
}

// Files btrain writes itself inside the vendored directory.
const BTRAIN_OWNED = ["SKILL.md", "VENDORED.md"]

const gitBlobSha = (content) =>
  createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex")

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
      const fields = parseFrontmatter(await read(name))
      assert.ok(fields, "SKILL.md must open with a --- frontmatter block")
      assert.equal(fields.name?.value, name, "name must match the skill directory")
      assert.ok(fields.description?.value, "description must not be empty")
      if (!/^["'>|]/.test(fields.description.raw)) {
        // A plain YAML scalar cannot hold ": " or " #"; the harness would drop the skill.
        assert.doesNotMatch(fields.description.value, /: | #/, "quote the description or reword it")
      }
    })

    it(`${name} links only to files it ships`, async () => {
      const dir = path.resolve(SURFACES[0], name)
      const skillLinks = [...(await read(name)).matchAll(/\]\((?:\.\/)?(references\/[^)#\s]+)\)/g)]
      assert.ok(skillLinks.length > 0, `${name}/SKILL.md must link its references`)
      for (const file of (await listFiles(dir)).filter((f) => f.endsWith(".md"))) {
        const text = await fs.readFile(path.join(dir, file), "utf8")
        // Relative links only; skip URLs and in-page anchors. The verbatim
        // upstream SKILL.md keeps its links relative to the skill root.
        const base = file === UPSTREAM_SKILL ? dir : path.dirname(path.join(dir, file))
        for (const [, target] of text.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)\)/g)) {
          const resolved = path.resolve(base, target)
          await assert.doesNotReject(fs.access(resolved), `${name}/${file} links to missing ${target}`)
        }
      }
    })
  }

  // MIT requires the copyright and permission notice to travel with every copy.
  it("reverse-engineer-anything matches upstream rea at the pinned commit", async () => {
    const dir = path.resolve(SURFACES[0], "reverse-engineer-anything")
    const shipped = (await listFiles(dir)).filter((file) => !BTRAIN_OWNED.includes(file))
    assert.deepEqual(shipped, Object.keys(VENDORED_BLOBS).sort(), "vendored file set changed")
    for (const [file, sha] of Object.entries(VENDORED_BLOBS)) {
      assert.equal(gitBlobSha(await fs.readFile(path.join(dir, file))), sha, `${file} differs from rea@c9aecde; do not edit vendored files`)
    }
  })

  it("reverse-engineer-anything keeps the upstream MIT notice and pinned commit", async () => {
    assert.match(await read("reverse-engineer-anything", "LICENSE"), /^MIT License\n\nCopyright \(c\) 2026 morluto/)
    const vendored = await read("reverse-engineer-anything", "VENDORED.md")
    assert.match(vendored, /commit\s+`[0-9a-f]{40}`/)
    assert.match(vendored, /`references\/upstream-SKILL\.md`/, "VENDORED.md must say where the upstream SKILL.md now lives")
    assert.match(vendored, /rea-agents@\d+\.\d+\.\d+/, "pin the npm version; @latest runs whatever npm serves")
    assert.doesNotMatch(vendored, /rea-agents@latest/)
    assert.match(vendored, /btrain sync-skills --force --skill reverse-engineer-anything/)
  })

  // Review P2: the upstream description triggers on "guide a reconstruction"
  // and its close-out says to build with normal coding tools, so an ungated
  // "reverse engineer X and rebuild it" could skip clean-room-rebuild's legal
  // gate. The btrain-owned SKILL.md is what the harness reads when it picks a
  // skill, so the exclusion has to live in its frontmatter.
  describe("reverse-engineer-anything is study-only", () => {
    it("excludes rebuilding in its description and points at clean-room-rebuild", async () => {
      const fields = parseFrontmatter(await read("reverse-engineer-anything"))
      const description = fields.description.value
      assert.match(description, /\bNot for\b.*\b(rebuild|reimplement)/i, "description must exclude rebuilding or reimplementing")
      assert.match(description, /clean-room-rebuild/, "description must send rebuild requests to clean-room-rebuild")
      assert.doesNotMatch(description, /guide a reconstruction/)
    })

    it("states the authorization scope before deferring to the upstream text", async () => {
      const text = await read("reverse-engineer-anything")
      const scope = text.search(/authorized to (study|analyze)/)
      const upstream = text.indexOf(`](${UPSTREAM_SKILL})`)
      assert.ok(scope !== -1, "SKILL.md must say the skill is for software you are authorized to analyze")
      assert.ok(upstream !== -1, "SKILL.md must link the pinned upstream text")
      assert.ok(scope < upstream, "the authorization scope must come before the upstream link")
      assert.match(text, /clean-room-rebuild/)
    })
  })

  describe("clean-room-rebuild keeps the wall", () => {
    it("separates the study side from the build side", async () => {
      const text = await read("clean-room-rebuild")
      assert.match(text, /One agent may not hold both roles for the same target/)
      assert.match(text, /The build session must not see the target/)
    })

    it("gates on the terms of service before any observation", async () => {
      const text = await read("clean-room-rebuild")
      const gate = text.indexOf("](references/legal-gate.md)")
      const observe = text.indexOf("### Phase 1.")
      assert.ok(gate !== -1, "SKILL.md must link the legal gate")
      assert.ok(observe !== -1, "SKILL.md must have a Phase 1 heading")
      assert.ok(gate < observe, "the legal gate must come before observation")
      assert.match(await read("clean-room-rebuild", "references/legal-gate.md"), /forbid reverse engineering/)
    })

    it("forbids circumvention and never commits a raw capture", async () => {
      const text = await read("clean-room-rebuild")
      assert.match(text, /Never bypass auth/)
      assert.match(text, /Never commit a raw HAR/)
    })

    it("keeps circumvention a hard stop that no human decision overrides", async () => {
      assert.match(await read("clean-room-rebuild"), /A human decision never unlocks the circumvention rule/)
      assert.match(await read("clean-room-rebuild", "references/legal-gate.md"), /No human decision overrides it/)
      assert.match(await read("clean-room-rebuild", "references/legal-gate.md"), /auth, rate limits, bot detection, DRM, or a license check\? \| \| \*\*hard stop\*\* if yes \|/)
    })

    it("gives the study and build sides lock sets that do not overlap", async () => {
      const text = await read("clean-room-rebuild")
      assert.match(text, /research\/rebuilds\/<target>-build\//)
      assert.doesNotMatch(text, /except `build\/`/)
    })

    it("does not count unknown evidence as a pass", async () => {
      assert.match(await read("clean-room-rebuild"), /Unknown, skipped, truncated, or contradictory evidence never counts as a pass/)
    })
  })
})
