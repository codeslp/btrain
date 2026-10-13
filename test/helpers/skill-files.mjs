import fs from "node:fs/promises"
import path from "node:path"

// Shared by the bundled-skill suites (review-skills, reverse-engineering-skills)
// so every suite walks a skill directory and parses its frontmatter the same way.

// Every file under `dir`, as a sorted path relative to it. The walk is explicit
// because readdir's `recursive` option needs Node 18.17 and Dirent.parentPath
// needs Node 18.20, and the README advertises Node.js 18+.
export async function listFiles(dir) {
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

// Enough of YAML frontmatter for `key: value` lines, plus indented
// continuation lines for folded (`>`) values.
export function parseFrontmatter(text) {
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
