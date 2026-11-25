// Spec 024 task T027: the repository is public, so no real Slack token,
// workspace ID, channel ID, or user ID may appear in any tracked file. Test
// values must be obviously fake: an ID that contains FAKE, TEST, EXAMPLE,
// XXXX, or 0000, or repeats one character after its prefix (C0AAAAAAAA); a
// token that says fake, test, example, dummy, or placeholder, or has xxxx.
//
// A finding names the file, the line, and the kind, with the value masked,
// so a real token never reaches a CI log.
//
// Every tracked file is read, whatever its size, as latin1, so a large or
// binary file cannot hide a token. A file with a NUL byte is scanned for
// tokens only: random bytes in an image or a sound often look like IDs. This file builds its own real-looking examples by concatenation,
// so the scan never finds them here.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// Slack IDs are opaque: a type letter (team, user, enterprise user, channel,
// group, DM, enterprise), then eight or more uppercase letters and digits,
// with no length cap. One assumption stays: the ID has a digit after its
// type letter, or every long uppercase word would be a finding.
const ID = /\b[TUWCGDE][A-Z0-9]{8,}\b/g
const HAS_DIGIT = /^.[A-Z]*[0-9]/
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

/**
 * Findings in one text: `{ line, kind, masked }` for each real-looking value.
 * `ids: false` skips the ID check (binary content).
 */
function scanText(text, { ids = true } = {}) {
  const findings = []
  text.split("\n").forEach((content, index) => {
    for (const [match] of content.matchAll(TOKEN)) {
      if (!isObviouslyFakeToken(match)) findings.push({ line: index + 1, kind: "token", masked: mask(match) })
    }
    if (!ids) return
    for (const [match] of content.matchAll(ID)) {
      if (HAS_DIGIT.test(match) && !isObviouslyFakeId(match)) findings.push({ line: index + 1, kind: "id", masked: mask(match) })
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

/** The whole file as latin1, or null when it is not a regular file here. */
function readText(target) {
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch {
    return null // listed by git but deleted in this checkout
  }
  if (!stat.isFile()) return null // a symlink or a submodule entry
  return fs.readFileSync(target, "latin1")
}

describe("no real Slack values in the repository (spec 024 T027)", () => {
  it("finds no real-looking Slack token or ID in any tracked text file", () => {
    const files = trackedFiles()
    assert.ok(files.length > 50, `expected the repository's files, found ${files.length}`)
    const findings = []
    for (const relative of files) {
      const text = readText(path.join(REPO_ROOT, relative))
      if (text === null) continue
      for (const finding of scanText(text, { ids: !text.includes("\0") })) findings.push(`${relative}:${finding.line} ${finding.kind} ${finding.masked}`)
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
    // Built by concatenation too, so the repository's secret rule does not
    // read these fakes as tokens.
    const fakeTokens = ["-fake-token-value", "-test-0000000000", "-EXAMPLE-123456789", "-xxxx-xxxx-xxxx"].map((rest, i) => (i === 2 ? "xoxp" : "xoxb") + rest)
    for (const token of fakeTokens) assert.equal(isObviouslyFakeToken(token), true, token)
    assert.deepEqual(scanText(fakeTokens.join("\n")), [])
  })

  it("never puts a whole value in a finding", () => {
    const realToken = "xoxb" + "-1234567890-0987654321-AbCdEfGhIjKlMnOp"
    const [finding] = scanText(realToken)
    assert.equal(finding.masked.includes(realToken.slice(5)), false)
    assert.match(finding.masked, /^xoxb-…\(\d+ chars\)$/)
  })

  it("ignores uppercase words with no digit and values too short to be IDs", () => {
    assert.deepEqual(scanText("DOCUMENTATION CHANGELOG MAX_PAGES C12 U1 C1234567 xoxb- xoxb-short"), [])
  })

  it("treats Slack IDs as opaque: no digit position and no length cap (codex-reviewer on ac21f1d)", () => {
    const noLeadingDigit = "C" + "AB12CD34E"
    const long = "C" + "01ABCD2EFGHI"
    const veryLong = "U" + "1ABCDEFGHIJKLMNOPQRS"
    assert.deepEqual(scanText([noLeadingDigit, long, veryLong].join("\n")).map(({ line, kind }) => `${line}:${kind}`), ["1:id", "2:id", "3:id"])
    // The price of the digit rule: an uppercase name with a digit is a
    // finding too, so such names are built by concatenation in tests.
    assert.equal(scanText("U" + "INT8ARRAY").length, 1)
  })

  it("reads a file larger than 2 MiB, and one with NUL bytes, to its end", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "btrain-slack-scan-"))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const token = "xoxb" + "-1234567890-0987654321-AbCdEfGhIjKlMnOp"
    const large = path.join(dir, "large.txt")
    fs.writeFileSync(large, `${"a".repeat(2 * 1024 * 1024)}\n${token}\n`)
    assert.deepEqual(scanText(readText(large)).map(({ line, kind }) => `${line}:${kind}`), ["2:token"])
    const binary = path.join(dir, "binary.bin")
    fs.writeFileSync(binary, Buffer.concat([Buffer.from([0, 0, 255, 0]), Buffer.from(`\n${token}\n`, "latin1")]))
    const binaryText = readText(binary)
    assert.deepEqual(scanText(binaryText, { ids: false }).map(({ kind }) => kind), ["token"])
    assert.deepEqual(scanText(`${"U" + "1ABCDEFGHI"}\n${token}`, { ids: false }).map(({ kind }) => kind), ["token"], "binary content skips IDs, never tokens")
    assert.equal(readText(path.join(dir, "missing.txt")), null)
    fs.symlinkSync(large, path.join(dir, "link.txt"))
    assert.equal(readText(path.join(dir, "link.txt")), null, "a symlink is its target's business")
  })
})
