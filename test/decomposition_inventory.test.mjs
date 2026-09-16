import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { readFunctionSpans, stronglyConnectedComponents } from "../scripts/decomposition_inventory.mjs"

async function withSource(source, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-inventory-"))
  const file = path.join(dir, "sample.mjs")
  await fs.writeFile(file, source, "utf8")
  try {
    return await fn(file)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe("decomposition inventory, function spans", () => {
  it("does not end a span on a line that merely starts with a brace", async () => {
    // The defect this pins. `})` and `}, {` at column 0 close an argument list
    // or an object literal inside a body, not the function. Accepting them
    // truncated 12 of core.mjs's 352 spans -- `runLoop` read as 9 lines
    // instead of 422 -- and under-counted the file by 1,094 lines.
    const source = [
      "function multilineCall() {",
      "  doSomething(",
      "    first,",
      "    second,",
      "  )",
      "  withCallback(() => {",
      "    inner()",
      "  })",                    // starts with } but does not end the function
      "  const shape = { a: 1,",
      "    b: 2,",
      "  }, other = 3",          // starts with } but does not end the function
      "  return shape.a + other",
      "}",
      "",
      "function after() {",
      "  return 1",
      "}",
      "",
    ].join("\n")

    await withSource(source, async (file) => {
      const { spans } = readFunctionSpans(file)
      assert.deepEqual(spans.map((s) => s.name), ["multilineCall", "after"])
      assert.equal(spans[0].lines, 13, "the span runs to the real closing brace")
      assert.equal(spans[1].lines, 3)
    })
  })

  it("handles a multiline parameter list", async () => {
    const source = [
      "export async function wide(",
      "  alpha,",
      "  beta = { nested: true },",
      ") {",
      "  return alpha + beta",
      "}",
      "",
    ].join("\n")

    await withSource(source, async (file) => {
      const { spans } = readFunctionSpans(file)
      assert.deepEqual(spans.map((s) => s.name), ["wide"])
      assert.equal(spans[0].lines, 6)
    })
  })

  it("refuses to guess when a function never closes at column 0", async () => {
    // Silence here would be the dangerous outcome: an unclosed span would
    // swallow every function after it and the totals would still look sane.
    const source = ["function broken() {", "  return 1", "  // no closing brace", ""].join("\n")
    await withSource(source, async (file) => {
      await assert.rejects(async () => readFunctionSpans(file), /unclosed function broken/)
    })
  })

  it("counts the real core.mjs at its established figures", async () => {
    // A guard on the numbers the spec quotes, so a future change to the
    // scanner cannot silently move them.
    const core = path.join(process.cwd(), "src", "brain_train", "core.mjs")
    const { spans, fileLines } = readFunctionSpans(core)
    assert.equal(fileLines, 10_754)
    assert.equal(spans.length, 352)
    assert.equal(spans.reduce((a, f) => a + f.lines, 0), 9_729)
    assert.equal(spans.find((f) => f.name === "patchHandoff").lines, 579)
    assert.equal(spans.find((f) => f.name === "runLoop").lines, 422)
  })
})

describe("decomposition inventory, cycle detection", () => {
  it("finds a cycle when there is one", async () => {
    const edges = new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]], ["d", ["a"]]])
    const comps = stronglyConnectedComponents(["a", "b", "c", "d"], edges)
    const cycles = comps.filter((c) => c.length > 1)
    assert.equal(cycles.length, 1)
    assert.deepEqual([...cycles[0]].sort(), ["a", "b", "c"])
  })

  it("reports every node separately when the graph is acyclic", async () => {
    const edges = new Map([["a", ["b"]], ["b", ["c"]]])
    const comps = stronglyConnectedComponents(["a", "b", "c"], edges)
    assert.equal(comps.length, 3)
    assert.equal(comps.filter((c) => c.length > 1).length, 0)
  })
})
