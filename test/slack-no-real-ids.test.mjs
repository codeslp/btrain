// Spec 024 task T027: the repository is public, so no real Slack token,
// workspace ID, channel ID, or user ID may appear in any tracked file. Test
// values must be obviously fake: an ID that contains FAKE, TEST, EXAMPLE,
// XXXX, or 0000, or repeats one character after its prefix (C0AAAAAAAA); a
// token that says fake, test, example, dummy, or placeholder, or has xxxx.
//
// A finding names the file, the line, and the kind, with the value masked,
// so a real token never reaches a CI log.
//
// This file builds its own real-looking examples by concatenation, so the
// scan never finds them here.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const MAX_BYTES = 2 * 1024 * 1024

// Slack IDs: a type letter (team, user, enterprise user, channel, group, DM,
// enterprise) and a digit, then uppercase letters and digits.
const ID = /\b[TUWCGDE][0-9][A-Z0-9]{7,10}\b/g
const TOKEN = /\b(?:xox[abposr]|xapp)-[A-Za-z0-9-]{10,}/g
const FAKE_ID = /FAKE|TEST|EXAMPLE|XXXX|0000/
const REPEATED_ID = /^[A-Z]0?([A-Z0-9])\1{4,}$/
const FAKE_TOKEN = /fake|test|example|dummy|placeholder|xxxx/i

function isObviouslyFakeId(id) {
  return FAKE_ID.test(id) || REPEATED_ID.test(id)
}

function isObviouslyFakeToken(token) {
  return FAKE_TOKEN.test(token)
}

function mask(value) {
  return `${value.slice(0, 5)}…(${value.length} chars)`
}

/** Findings in one text: `{ line, kind, masked }` for each real-looking value. */
function scanText(text) {
  const findings = []
  text.split("\n").forEach((content, index) => {
    for (const [match] of content.matchAll(TOKEN)) {
      if (!isObviouslyFakeToken(match)) findings.push({ line: index + 1, kind: "token", masked: mask(match) })
    }
    for (const [match] of content.matchAll(ID)) {
      if (!isObviouslyFakeId(match)) findings.push({ line: index + 1, kind: "id", masked: mask(match) })
    }
  })
  return findings
}

function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\0")
      .filter(Boolean)
  } catch {
    // Not a git checkout (an unpacked tarball): walk the tree instead.
    const files = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
        if ([".git", "node_modules"].includes(entry.name)) continue
        const relative = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(relative)
        else if (entry.isFile()) files.push(relative)
      }
    }
    walk("")
    return files
  }
}

function readText(relative) {
  const target = path.join(REPO_ROOT, relative)
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch {
    return null // listed by git but deleted in this checkout
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return null
  const buffer = fs.readFileSync(target)
  if (buffer.subarray(0, 8192).includes(0)) return null // binary
  return buffer.toString("utf8")
}

describe("no real Slack values in the repository (spec 024 T027)", () => {
  it("finds no real-looking Slack token or ID in any tracked text file", () => {
    const files = trackedFiles()
    assert.ok(files.length > 50, `expected the repository's files, found ${files.length}`)
    const findings = []
    for (const relative of files) {
      const text = readText(relative)
      if (text === null) continue
      for (const finding of scanText(text)) findings.push(`${relative}:${finding.line} ${finding.kind} ${finding.masked}`)
    }
    assert.deepEqual(findings, [], `Replace these with obviously fake values (FAKE, TEST, EXAMPLE, XXXX, or 0000 in an ID):\n${findings.join("\n")}`)
  })

  it("flags real-looking IDs and tokens and passes obvious fakes", () => {
    const realId = "U" + "024BE7LH"
    const realChannel = "C" + "01ABCD2EFG"
    const realTeam = "T" + "9TK3CUKW1"
    const realToken = "xoxb" + "-1234567890-0987654321-AbCdEfGhIjKlMnOp"
    const appToken = "xapp" + "-1-A0123456789-0123456789-abcdef"
    const text = [`user ${realId}`, `channel ${realChannel} and team ${realTeam}`, `token=${realToken}`, appToken].join("\n")
    assert.deepEqual(scanText(text).map(({ line, kind }) => `${line}:${kind}`), ["1:id", "2:id", "2:id", "3:token", "4:token"])

    const fakes = ["U0000FAKE", "C0000FAKE", "T0000FAKE", "W0000FAKE", "C0FAKE0001", "C0000AAAA", "C0AAAAAAAAA", "C0BBBBBBBBB", "U0XXXXXXXXX", "U0TEST1234", "C0EXAMPLE1"]
    for (const id of fakes) assert.equal(isObviouslyFakeId(id), true, id)
    assert.deepEqual(scanText(fakes.join(" ")), [])
    const fakeTokens = ["xoxb-fake-token-value", "xoxb-test-0000000000", "xoxp-EXAMPLE-123456789", "xoxb-xxxx-xxxx-xxxx"]
    for (const token of fakeTokens) assert.equal(isObviouslyFakeToken(token), true, token)
    assert.deepEqual(scanText(fakeTokens.join("\n")), [])
  })

  it("never puts a whole value in a finding", () => {
    const realToken = "xoxb" + "-1234567890-0987654321-AbCdEfGhIjKlMnOp"
    const [finding] = scanText(realToken)
    assert.equal(finding.masked.includes(realToken.slice(5)), false)
    assert.match(finding.masked, /^xoxb-…\(\d+ chars\)$/)
  })

  it("ignores identifiers that are not Slack-shaped", () => {
    assert.deepEqual(scanText("UINT8ARRAY GH_TOKEN TEMP1234567 C12 U1 xoxb- xoxb-short"), [])
  })
})
