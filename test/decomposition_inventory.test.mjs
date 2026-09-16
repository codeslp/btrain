import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  readFunctionSpans,
  stronglyConnectedComponents,
  checkExportSurface,
  findModuleEvaluationCalls,
} from "../scripts/decomposition_inventory.mjs"

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

describe("decomposition inventory, export surface", () => {
  // The plan's hard constraint is that all 69 exported names stay resolvable
  // from core.mjs after every stage, so the surface is the thing most worth
  // checking mechanically rather than by eye. Two members are exactly the ones
  // a function inventory misses.

  it("accounts for every exported name, including the inline and non-function ones", async () => {
    const core = path.join(process.cwd(), "src", "brain_train", "core.mjs")
    const { spans } = readFunctionSpans(core)
    const surface = await checkExportSurface(spans)

    assert.equal(surface.exported.length, 69, "the public surface is 69 names")
    assert.deepEqual(surface.unassigned, [], "every exported name must have a home")
    assert.equal(surface.placed.length + surface.reexported.length, 69)
  })

  it("sees the inline export the export block does not list", async () => {
    // buildReviewArtifactId is declared `export function` at core.mjs:7677
    // rather than listed in the block at 10685. An extraction that edits the
    // block alone drops it from the surface with no syntax error.
    const core = path.join(process.cwd(), "src", "brain_train", "core.mjs")
    const { spans } = readFunctionSpans(core)
    const surface = await checkExportSurface(spans)

    assert.deepEqual(surface.inline, ["buildReviewArtifactId"])
    assert.equal(surface.blockNames.length, 68)
    assert.equal(surface.blockNames.includes("buildReviewArtifactId"), false)
    assert.equal(surface.blockNames.length + surface.inline.length, 69)
  })

  it("gives BtrainError a home even though it is a class", async () => {
    // It appears in no function inventory, and it is instantiated at 80 sites
    // inside core.mjs, so a missed placement breaks the first extraction.
    const core = path.join(process.cwd(), "src", "brain_train", "core.mjs")
    const { spans } = readFunctionSpans(core)
    const surface = await checkExportSurface(spans)

    const row = surface.rows.find((r) => r.name === "BtrainError")
    assert.ok(row, "BtrainError is part of the surface")
    assert.equal(row.isFunction, false)
    assert.equal(row.assigned, "fsx")
  })
})

describe("decomposition inventory, export baseline", () => {
  it("matches the committed baseline exactly", async () => {
    const core = path.join(process.cwd(), "src", "brain_train", "core.mjs")
    const { spans } = readFunctionSpans(core)
    const surface = await checkExportSurface(spans)

    assert.ok(surface.baseline, "a baseline must be committed for the check to mean anything")
    assert.equal(surface.baseline.length, 69)
    assert.deepEqual(surface.added, [], "no name may appear that the baseline does not have")
    assert.deepEqual(surface.removed, [], "no baseline name may disappear")
  })
})

describe("decomposition inventory, module-evaluation calls", () => {
  // The staging order has to respect these strictly: importing a binding from a
  // module that has not finished evaluating is a ReferenceError at load, not a
  // warning, so nothing that imports core.mjs would run at all.

  it("finds exactly the calls that run while core.mjs is evaluating", async () => {
    const core = path.join(process.cwd(), "src", "brain_train", "core.mjs")
    const { spans } = readFunctionSpans(core)
    const calls = findModuleEvaluationCalls(spans)

    assert.deepEqual(
      [...calls.keys()].sort(),
      ["claudeBashPermissions", "renderPreCommitHook", "renderPrePushHook"],
    )
    assert.deepEqual(calls.get("claudeBashPermissions"), [286, 322, 326, 330])
    assert.deepEqual(calls.get("renderPreCommitHook"), [1955])
    assert.deepEqual(calls.get("renderPrePushHook"), [1956])
  })

  it("does not count comments, strings, the export block or deferred callbacks", async () => {
    // Each of these produced a false positive in a first pass: a comment
    // mentioning releaseLocks, a help string containing "btrain doctor", the
    // export block naming almost everything, and an arrow callback in a
    // module-level object literal that is defined now but runs later.
    const core = path.join(process.cwd(), "src", "brain_train", "core.mjs")
    const { spans } = readFunctionSpans(core)
    const calls = findModuleEvaluationCalls(spans)

    for (const name of ["releaseLocks", "doctor", "patchHandoff", "checkHandoff", "runLoop",
      "shouldSkipBundledAgentchattrPath"]) {
      assert.equal(calls.has(name), false, `${name} is not called during module evaluation`)
    }
  })
})
