import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import {
  parseConcatenatedJsonArrays,
  shapeComments,
  filterDeltas,
  advanceCursor,
  countUnread,
  formatComment,
  readCursors,
  writeCursors,
  appendComments,
  readComments,
  getPrCommentsLogPath,
  getPrCommentsCursorsPath,
  getCursorKey,
} from "../src/brain_train/handoff/pr-comments.mjs"

describe("parseConcatenatedJsonArrays", () => {
  it("returns [] on empty input", () => {
    assert.deepEqual(parseConcatenatedJsonArrays(""), [])
    assert.deepEqual(parseConcatenatedJsonArrays("   \n"), [])
  })

  it("parses a single JSON array as-is", () => {
    assert.deepEqual(parseConcatenatedJsonArrays('[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }])
  })

  it("parses multiple concatenated JSON arrays (gh --paginate output)", () => {
    const input = '[{"a":1}][{"a":2},{"a":3}]'
    assert.deepEqual(parseConcatenatedJsonArrays(input), [{ a: 1 }, { a: 2 }, { a: 3 }])
  })

  it("handles arrays separated by whitespace", () => {
    const input = '[{"a":1}]\n[{"a":2}]'
    assert.deepEqual(parseConcatenatedJsonArrays(input), [{ a: 1 }, { a: 2 }])
  })

  it("wraps a non-array JSON value in an array", () => {
    assert.deepEqual(parseConcatenatedJsonArrays('{"a":1}'), [{ a: 1 }])
  })
})

describe("shapeComments", () => {
  it("shapes issue, inline, and review surfaces uniformly", () => {
    const raw = {
      issueComments: [
        { id: 1, user: { login: "alice" }, body: "ship it", html_url: "u1", created_at: "2026-05-01T00:00:00Z" },
      ],
      reviewComments: [
        {
          id: 10,
          user: { login: "bob" },
          body: "nit: fix typo",
          html_url: "u2",
          created_at: "2026-05-02T00:00:00Z",
          path: "src/foo.ts",
          line: 42,
          pull_request_review_id: 99,
        },
      ],
      reviews: [
        { id: 100, user: { login: "carol" }, body: "blocking", state: "CHANGES_REQUESTED", html_url: "u3", submitted_at: "2026-05-03T00:00:00Z" },
      ],
    }
    const out = shapeComments(raw)
    assert.equal(out.length, 3)
    assert.deepEqual(
      out.map((c) => ({ surface: c.surface, author: c.author })),
      [
        { surface: "issue", author: "alice" },
        { surface: "inline", author: "bob" },
        { surface: "review", author: "carol" },
      ],
    )
    assert.equal(out[1].file, "src/foo.ts")
    assert.equal(out[1].line, 42)
    assert.equal(out[2].state, "CHANGES_REQUESTED")
  })

  it("sorts by timestamp ascending, then by id", () => {
    const raw = {
      issueComments: [
        { id: 2, user: { login: "a" }, body: "later", html_url: "u", created_at: "2026-05-02T00:00:00Z" },
        { id: 1, user: { login: "a" }, body: "earlier", html_url: "u", created_at: "2026-05-01T00:00:00Z" },
      ],
      reviewComments: [],
      reviews: [],
    }
    const out = shapeComments(raw)
    assert.equal(out[0].id, 1)
    assert.equal(out[1].id, 2)
  })

  it("drops empty-body COMMENTED reviews (line comments carry the content)", () => {
    const raw = {
      issueComments: [],
      reviewComments: [
        { id: 1, user: { login: "a" }, body: "real comment", html_url: "u", created_at: "2026-05-01T00:00:00Z" },
      ],
      reviews: [
        { id: 100, user: { login: "a" }, body: "", state: "COMMENTED", html_url: "u", submitted_at: "2026-05-01T00:00:00Z" },
        { id: 101, user: { login: "a" }, body: "real review body", state: "COMMENTED", html_url: "u", submitted_at: "2026-05-02T00:00:00Z" },
      ],
    }
    const out = shapeComments(raw)
    // Only the inline + the review-with-body should survive
    assert.equal(out.length, 2)
    assert.equal(out.find((c) => c.surface === "review").id, 101)
  })

  it("keeps CHANGES_REQUESTED and APPROVED reviews even with empty bodies", () => {
    const raw = {
      issueComments: [],
      reviewComments: [],
      reviews: [
        { id: 100, user: { login: "a" }, body: "", state: "CHANGES_REQUESTED", html_url: "u", submitted_at: "2026-05-01T00:00:00Z" },
        { id: 101, user: { login: "a" }, body: "", state: "APPROVED", html_url: "u", submitted_at: "2026-05-02T00:00:00Z" },
      ],
    }
    const out = shapeComments(raw)
    assert.equal(out.length, 2)
    assert.equal(out[0].state, "CHANGES_REQUESTED")
    assert.equal(out[1].state, "APPROVED")
  })

  it("handles missing user gracefully", () => {
    const raw = {
      issueComments: [{ id: 1, user: null, body: "x", html_url: "u", created_at: "2026-05-01T00:00:00Z" }],
      reviewComments: [],
      reviews: [],
    }
    const out = shapeComments(raw)
    assert.equal(out[0].author, "unknown")
  })
})

describe("filterDeltas", () => {
  const comments = [
    { surface: "issue", at: "2026-05-01T00:00:00Z" },
    { surface: "issue", at: "2026-05-03T00:00:00Z" },
    { surface: "review", at: "2026-05-02T00:00:00Z" },
  ]

  it("returns all comments when no cursor exists", () => {
    assert.equal(filterDeltas(comments, {}).length, 3)
    assert.equal(filterDeltas(comments, undefined).length, 3)
    assert.equal(filterDeltas(comments, null).length, 3)
  })

  it("filters per-surface — only newer than the surface's cursor", () => {
    const cursors = { issue: "2026-05-01T00:00:00Z" }
    const out = filterDeltas(comments, cursors)
    // issue at 05-01 is NOT strictly newer; issue at 05-03 IS; review has no cursor → returned
    assert.equal(out.length, 2)
    assert.ok(out.some((c) => c.surface === "issue" && c.at === "2026-05-03T00:00:00Z"))
    assert.ok(out.some((c) => c.surface === "review"))
  })

  it("returns nothing when all surfaces' cursors are at-or-after every comment", () => {
    const cursors = {
      issue: "2026-05-03T00:00:00Z",
      review: "2026-05-02T00:00:00Z",
    }
    assert.equal(filterDeltas(comments, cursors).length, 0)
  })
})

describe("advanceCursor", () => {
  it("seeds new surfaces from the comments", () => {
    const out = advanceCursor({}, [
      { surface: "issue", at: "2026-05-01T00:00:00Z" },
      { surface: "review", at: "2026-05-02T00:00:00Z" },
    ])
    assert.deepEqual(out, {
      issue: "2026-05-01T00:00:00Z",
      review: "2026-05-02T00:00:00Z",
    })
  })

  it("only advances forward (never backwards)", () => {
    const before = { issue: "2026-05-05T00:00:00Z" }
    const out = advanceCursor(before, [{ surface: "issue", at: "2026-05-01T00:00:00Z" }])
    assert.equal(out.issue, "2026-05-05T00:00:00Z")
  })

  it("advances to the max timestamp per surface", () => {
    const out = advanceCursor({}, [
      { surface: "issue", at: "2026-05-01T00:00:00Z" },
      { surface: "issue", at: "2026-05-03T00:00:00Z" },
      { surface: "issue", at: "2026-05-02T00:00:00Z" },
    ])
    assert.equal(out.issue, "2026-05-03T00:00:00Z")
  })

  it("preserves cursors for surfaces not in the delta", () => {
    const out = advanceCursor({ inline: "2026-04-01T00:00:00Z" }, [
      { surface: "issue", at: "2026-05-01T00:00:00Z" },
    ])
    assert.equal(out.inline, "2026-04-01T00:00:00Z")
    assert.equal(out.issue, "2026-05-01T00:00:00Z")
  })
})

describe("countUnread", () => {
  it("counts everything when no cursor is set", () => {
    const comments = [
      { surface: "issue", at: "2026-05-01T00:00:00Z" },
      { surface: "review", state: "CHANGES_REQUESTED", at: "2026-05-02T00:00:00Z" },
    ]
    const r = countUnread(comments, {})
    assert.equal(r.unread, 2)
    assert.equal(r.changesRequested, 1)
  })

  it("counts only new-since-cursor", () => {
    const comments = [
      { surface: "issue", at: "2026-05-01T00:00:00Z" },
      { surface: "issue", at: "2026-05-03T00:00:00Z" },
      { surface: "review", state: "APPROVED", at: "2026-05-02T00:00:00Z" },
    ]
    const r = countUnread(comments, { issue: "2026-05-01T00:00:00Z" })
    // Only the 05-03 issue is unread; review has no cursor → unread; APPROVED doesn't bump CR
    assert.equal(r.unread, 2)
    assert.equal(r.changesRequested, 0)
  })

  it("flags CHANGES_REQUESTED only on review surface", () => {
    const comments = [
      { surface: "review", state: "CHANGES_REQUESTED", at: "2026-05-01T00:00:00Z" },
      { surface: "review", state: "APPROVED", at: "2026-05-02T00:00:00Z" },
      { surface: "review", state: "CHANGES_REQUESTED", at: "2026-05-03T00:00:00Z" },
    ]
    const r = countUnread(comments, {})
    assert.equal(r.unread, 3)
    assert.equal(r.changesRequested, 2)
  })
})

describe("formatComment", () => {
  it("formats an issue-level comment", () => {
    const out = formatComment({
      surface: "issue",
      author: "alice",
      at: "2026-05-01T12:34:56Z",
      url: "https://github.com/x/y/issues/1#c",
      body: "ship it",
    })
    assert.match(out, /\[issue\] alice/)
    assert.match(out, /ship it/)
    assert.match(out, /https:\/\/github\.com\/x\/y\/issues\/1#c/)
  })

  it("includes file:line for inline comments", () => {
    const out = formatComment({
      surface: "inline",
      author: "bob",
      at: "2026-05-02T00:00:00Z",
      url: "u",
      body: "nit",
      file: "src/foo.ts",
      line: 42,
    })
    assert.match(out, /\[inline\] bob/)
    assert.match(out, /src\/foo\.ts:42/)
  })

  it("includes review state for review surface", () => {
    const out = formatComment({
      surface: "review",
      state: "CHANGES_REQUESTED",
      author: "carol",
      at: "2026-05-03T00:00:00Z",
      url: "u",
      body: "blocking",
    })
    assert.match(out, /\[review:CHANGES_REQUESTED\] carol/)
  })

  it("indents multi-line body bodies under the header", () => {
    const out = formatComment({
      surface: "issue",
      author: "a",
      at: "2026-05-01T00:00:00Z",
      url: "u",
      body: "line one\nline two",
    })
    assert.match(out, /  line one/)
    assert.match(out, /  line two/)
  })
})

describe("getCursorKey", () => {
  it("composes lane id and PR number", () => {
    assert.equal(getCursorKey("a", "3"), "lane-a-3")
    assert.equal(getCursorKey("d", "42"), "lane-d-42")
  })
})

describe("cursor I/O round-trip", () => {
  let tmpRoot
  before(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-pr-comments-"))
  })
  after(async () => {
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it("readCursors returns {} when the cursors file does not exist", async () => {
    const out = await readCursors(tmpRoot)
    assert.deepEqual(out, {})
  })

  it("write then read returns the same shape", async () => {
    const cursors = {
      "lane-a-3": { issue: "2026-05-01T00:00:00Z", review: "2026-05-02T00:00:00Z" },
      "lane-b-4": { inline: "2026-05-03T00:00:00Z" },
    }
    await writeCursors(tmpRoot, cursors)
    const back = await readCursors(tmpRoot)
    assert.deepEqual(back, cursors)
  })

  it("writes atomically (no leftover .tmp files)", async () => {
    await writeCursors(tmpRoot, { "lane-c-5": { issue: "2026-05-04T00:00:00Z" } })
    const cursorsPath = getPrCommentsCursorsPath(tmpRoot)
    const tmpPath = `${cursorsPath}.tmp`
    const tmpExists = await fs.access(tmpPath).then(() => true).catch(() => false)
    assert.equal(tmpExists, false, "cursor write should clean up its .tmp file")
  })
})

describe("comment log append + read round-trip", () => {
  let tmpRoot
  before(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-pr-comments-log-"))
  })
  after(async () => {
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it("readComments returns [] when the log does not exist", async () => {
    const out = await readComments(tmpRoot, "a", "1")
    assert.deepEqual(out, [])
  })

  it("appends and reads back JSONL records", async () => {
    const records = [
      { surface: "issue", id: 1, author: "alice", body: "hello", url: "u1", at: "2026-05-01T00:00:00Z" },
      { surface: "review", id: 2, author: "bob", state: "APPROVED", body: "", url: "u2", at: "2026-05-02T00:00:00Z" },
    ]
    await appendComments(tmpRoot, "a", "1", records)
    const back = await readComments(tmpRoot, "a", "1")
    assert.deepEqual(back, records)
  })

  it("appends additional records without truncating prior log content", async () => {
    await appendComments(tmpRoot, "a", "1", [
      { surface: "inline", id: 3, author: "carol", body: "nit", url: "u3", at: "2026-05-03T00:00:00Z", file: "f", line: 1 },
    ])
    const all = await readComments(tmpRoot, "a", "1")
    assert.equal(all.length, 3)
    assert.equal(all[2].id, 3)
  })

  it("appendComments is a no-op when given an empty array", async () => {
    const before = await readComments(tmpRoot, "a", "1")
    const appended = await appendComments(tmpRoot, "a", "1", [])
    const after = await readComments(tmpRoot, "a", "1")
    assert.equal(before.length, after.length)
    assert.deepEqual(appended, [])
  })

  it("dedups on (surface, id) — re-appending the same records is a no-op", async () => {
    const records = [
      { surface: "issue", id: 1, author: "alice", body: "first", url: "u", at: "2026-05-01T00:00:00Z" },
      { surface: "review", id: 2, author: "bob", state: "APPROVED", body: "", url: "u", at: "2026-05-02T00:00:00Z" },
    ]
    // Use a fresh path so we're not entangled with the prior tests in this suite.
    await appendComments(tmpRoot, "dedup", "9", records)
    const beforeLen = (await readComments(tmpRoot, "dedup", "9")).length
    const appended = await appendComments(tmpRoot, "dedup", "9", records)
    const afterLen = (await readComments(tmpRoot, "dedup", "9")).length
    assert.deepEqual(appended, [])
    assert.equal(beforeLen, afterLen)
  })

  it("dedups partial overlaps and returns only the actually-appended records", async () => {
    const first = [
      { surface: "issue", id: 1, author: "a", body: "x", url: "u", at: "2026-05-01T00:00:00Z" },
    ]
    const overlap = [
      { surface: "issue", id: 1, author: "a", body: "x", url: "u", at: "2026-05-01T00:00:00Z" },
      { surface: "issue", id: 2, author: "a", body: "y", url: "u", at: "2026-05-02T00:00:00Z" },
      { surface: "review", id: 1, author: "a", state: "APPROVED", body: "", url: "u", at: "2026-05-03T00:00:00Z" },
    ]
    await appendComments(tmpRoot, "dedup", "10", first)
    const appended = await appendComments(tmpRoot, "dedup", "10", overlap)
    // (issue, 1) was already present; (issue, 2) and (review, 1) are new.
    assert.equal(appended.length, 2)
    const ids = appended.map((c) => `${c.surface}:${c.id}`).sort()
    assert.deepEqual(ids, ["issue:2", "review:1"])
  })

  it("uses the lane-id + pr-number naming convention", async () => {
    await appendComments(tmpRoot, "z", "99", [
      { surface: "issue", id: 1, author: "a", body: "x", url: "u", at: "2026-05-01T00:00:00Z" },
    ])
    const expectedPath = getPrCommentsLogPath(tmpRoot, "z", "99")
    const exists = await fs.access(expectedPath).then(() => true).catch(() => false)
    assert.equal(exists, true)
    assert.match(expectedPath, /lane-z-99\.jsonl$/)
  })
})
