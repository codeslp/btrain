#!/usr/bin/env node
// Inventory for the Workstream 2 decomposition plan (spec 020).
//
// Every figure the plan states about `core.mjs` comes from here, so a reviewer
// can re-derive the table instead of trusting it. An earlier draft of the plan
// carried several hand-written figures that did not reproduce, including a
// stage whose stated line total was smaller than five of its own members.
//
//   node scripts/decomposition_inventory.mjs            # summary
//   node scripts/decomposition_inventory.mjs --json     # machine-readable
//   node scripts/decomposition_inventory.mjs --fns a b  # measure named fns
//
// Measurement rule, stated because it is the thing two counts disagreed on: a
// top-level function spans its `function` declaration line through the next
// line that is exactly `}` -- nothing before it, nothing after it. Leading
// JSDoc and the blank line between functions are excluded.
//
// "Starts with }" is not good enough and got this wrong once. A line of `})`
// or `}, {` at column 0 closes an argument list or an object literal in the
// middle of a function body, not the function. Accepting those truncated 12
// of the 352 spans, `runLoop` from 422 lines to 9, and under-counted the file
// by 1,094 lines.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const target = path.join(repoRoot, "src", "brain_train", "core.mjs")

export function readFunctionSpans(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n")
  const spans = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/)
    if (m) {
      // A declaration opening while one is still unclosed would mean the
      // column-0 rule missed a closing brace; surface it rather than guess.
      if (cur) throw new Error(`unclosed function ${cur.name} at line ${cur.start}`)
      cur = { name: m[1], start: i + 1 }
    } else if (cur && /^\}\s*$/.test(lines[i])) {
      spans.push({ ...cur, end: i + 1, lines: i + 1 - cur.start + 1 })
      cur = null
    }
  }
  if (cur) throw new Error(`unclosed function ${cur.name} at line ${cur.start}`)
  // A trailing newline makes split() yield one empty element; `wc -l` does
  // not count it and neither does the plan.
  const fileLines = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length
  return { spans, fileLines }
}

// Call graph from call expressions, not from a word-boundary regex. The plan
// records why: a regex graph reports `doctor` with 11 callers, all of them the
// string "btrain doctor" inside error-message text, and invents a 22-module
// cycle from it.
export function buildCallGraph(file, spans) {
  const names = new Set(spans.map((f) => f.name))
  const owner = (line) => spans.find((f) => line >= f.start && line <= f.end)?.name || null
  const edges = new Map()
  const add = (from, to) => {
    if (!from || !to || from === to || !names.has(to)) return
    if (!edges.has(from)) edges.set(from, new Set())
    edges.get(from).add(to)
  }

  const hits = JSON.parse(execFileSync(
    "ast-grep", ["run", "-p", "$F($$$A)", "-l", "js", "--json", file],
    { maxBuffer: 1 << 28, encoding: "utf8" },
  ))
  for (const hit of hits) add(owner(hit.range.start.line + 1), hit.metaVariables?.single?.F?.text)

  // Function values passed as callbacks are calls too, and ast-grep's call
  // pattern does not see them.
  const lines = fs.readFileSync(file, "utf8").split("\n")
  const cb = /\.(map|filter|sort|some|every|find|findIndex|flatMap|reduce|forEach)\(\s*([A-Za-z0-9_$]+)\s*[,)]/g
  for (let i = 0; i < lines.length; i++) {
    let m
    while ((m = cb.exec(lines[i]))) add(owner(i + 1), m[2])
  }
  return edges
}

// Tarjan, so the plan's acyclicity claims are checked rather than asserted.
export function stronglyConnectedComponents(nodes, edges) {
  let idx = 0
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [], out = []
  const visit = (v) => {
    index.set(v, idx); low.set(v, idx); idx++
    stack.push(v); onStack.add(v)
    for (const w of edges.get(v) || []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))) }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)))
    }
    if (low.get(v) === index.get(v)) {
      const comp = []
      let w
      do { w = stack.pop(); onStack.delete(w); comp.push(w) } while (w !== v)
      out.push(comp)
    }
  }
  for (const n of nodes) if (!index.has(n)) visit(n)
  return out
}

// Validate the committed stage assignment against the live call graph. The
// plan's whole staging rule is "at stage k every callee already lives in an
// extracted file", which is checkable only against a membership list.
export function checkStages(spans, edges) {
  const assignmentPath = path.join(repoRoot, "specs", "020-ws2-module-assignment.json")
  const doc = JSON.parse(fs.readFileSync(assignmentPath, "utf8"))
  const stage = new Map()
  for (const [mod, fns] of Object.entries(doc.modules)) {
    for (const fn of fns) stage.set(fn, { mod, n: doc.order.indexOf(mod) + 1 })
  }

  const missing = spans.filter((f) => !stage.has(f.name)).map((f) => f.name)
  // A name assigned but absent is normally an error. The exception is a
  // function that lands with an unmerged PR: the assignment has to be correct
  // against the tree extraction will start from, not only against main, and
  // making that wait for a merge means someone has to remember to come back.
  const pending = new Set(Object.entries(doc.pending || {})
    .filter(([k]) => k !== "note").flatMap(([, v]) => v))
  const absent = [...stage.keys()].filter((n) => !spans.some((f) => f.name === n))
  const unknown = absent.filter((n) => !pending.has(n))
  const notYetLanded = absent.filter((n) => pending.has(n))

  const lines = new Map(spans.map((f) => [f.name, f.lines]))
  const deps = new Map(), violations = []
  for (const [from, tos] of edges) {
    const a = stage.get(from)
    for (const to of tos) {
      const b = stage.get(to)
      if (!a || !b || a.mod === b.mod) continue
      if (!deps.has(a.mod)) deps.set(a.mod, new Set())
      deps.get(a.mod).add(b.n)
      // A stage may only call into earlier stages.
      if (b.n >= a.n) violations.push(`${a.mod}(${a.n}) -> ${b.mod}(${b.n}) via ${from} -> ${to}`)
    }
  }

  // Count what is on this tree. A pending function has no span here, so
  // including it would report a total the tree cannot substantiate.
  const onTree = new Set(spans.map((f) => f.name))
  const rows = doc.order.map((mod, i) => {
    const fns = doc.modules[mod].filter((f) => onTree.has(f))
    return {
      n: i + 1,
      mod,
      fns: fns.length,
      lines: fns.reduce((a, f) => a + (lines.get(f) || 0), 0),
      pending: doc.modules[mod].filter((f) => !onTree.has(f)).length,
      imports: [...(deps.get(mod) || [])].sort((x, y) => x - y),
    }
  })
  return { rows, violations, missing, unknown, notYetLanded }
}

/**
 * Check the whole public surface against the committed assignment.
 *
 * The plan's hard constraint is that all 69 exported names stay resolvable from
 * `core.mjs` after every stage, so the surface is the thing most worth checking
 * mechanically. Two of its members are exactly the ones a function inventory
 * misses: `buildReviewArtifactId`, declared `export function` inline rather
 * than listed in the export block, and `BtrainError`, which is a class.
 */
export async function checkExportSurface(spans) {
  const mod = await import(pathToFileURL(target).href)
  const exported = Object.keys(mod).sort()
  const doc = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "specs", "020-ws2-module-assignment.json"), "utf8"))

  // The committed baseline is the actual gate: "the same 69 names as before"
  // is only checkable against a recorded before.
  const baselinePath = path.join(repoRoot, "specs", "020-ws2-export-baseline.json")
  let baseline = null, added = [], removed = []
  if (fs.existsSync(baselinePath)) {
    baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")).names
    added = exported.filter((n) => !baseline.includes(n))
    removed = baseline.filter((n) => !exported.includes(n))
  }

  const home = new Map()
  for (const [m, fns] of Object.entries(doc.modules)) for (const fn of fns) home.set(fn, m)
  const nonFn = doc.nonFunctionExports || {}

  const fnNames = new Set(spans.map((f) => f.name))
  const rows = exported.map((name) => {
    const isFunction = fnNames.has(name)
    const assigned = isFunction ? home.get(name) : nonFn[name]
    return { name, isFunction, assigned: assigned || null }
  })

  const unassigned = rows.filter((r) => !r.assigned)
  const reexported = rows.filter((r) => (r.assigned || "").startsWith("("))
  const placed = rows.filter((r) => r.assigned && !r.assigned.startsWith("("))

  // The export block lists names; an inline `export function` does not appear
  // there. Both are part of the surface and both must be accounted for.
  const src = fs.readFileSync(target, "utf8").split("\n")
  const inline = src
    .map((l) => l.match(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/))
    .filter(Boolean).map((m) => m[1])
  const blockStart = src.findIndex((l) => /^export\s*\{/.test(l))
  const blockNames = blockStart === -1 ? [] : src.slice(blockStart)
    .join("\n").split("}")[0].replace(/^export\s*\{/, "")
    .split(",").map((t) => t.trim()).filter((t) => t && !t.startsWith("//"))

  return { exported, rows, unassigned, reexported, placed, inline, blockNames, order: doc.order, baseline, added, removed }
}

/**
 * Bindings actually *called* while the module is evaluating.
 *
 * These are the ones the staging order has to respect strictly: an import from
 * a not-yet-evaluated module is a temporal-dead-zone ReferenceError at load,
 * not a warning, and no test that imports `core.mjs` would survive it.
 *
 * Three things have to be excluded or the answer is noise: the `export { }`
 * block, which mentions almost every name without calling anything; comments
 * and string literals; and callbacks inside module-level object literals,
 * which are defined now but run later.
 */
export function findModuleEvaluationCalls(spans) {
  const raw = fs.readFileSync(target, "utf8").split("\n")
  const inFunction = new Array(raw.length + 2).fill(false)
  for (const s of spans) for (let i = s.start; i <= s.end; i++) inFunction[i] = true

  const blockStart = raw.findIndex((l) => /^export\s*\{/.test(l))
  const names = new Set(spans.map((f) => f.name))

  const calls = new Map()
  for (let i = 1; i <= raw.length; i++) {
    if (inFunction[i]) continue
    if (blockStart !== -1 && i > blockStart) continue
    let line = raw[i - 1]
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
    // Strip string and template literals, then inline comments.
    line = line.replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``")
      .replace(/\/\/.*$/, "")
    // An arrow body defers execution, so a call inside one is not evaluated now.
    if (/=>/.test(line)) continue
    for (const m of line.matchAll(/([A-Za-z0-9_$]+)\s*\(/g)) {
      if (names.has(m[1])) {
        if (!calls.has(m[1])) calls.set(m[1], [])
        calls.get(m[1]).push(i)
      }
    }
  }
  return calls
}

/**
 * Module-level constants: where each belongs, and which ones an extraction
 * would break.
 *
 * Three things the function-level checks structurally cannot see, each of which
 * shipped in this plan as a wrong or missing claim:
 *
 * 1. A constant whose initializer CALLS a function. That is a module-evaluation
 *    edge between the constant's home and the callee's home, and it appears in
 *    no function-to-function graph.
 * 2. A constant derived from `import.meta.url`. Its value depends on the file's
 *    own depth on disk, so moving it to `internal/` silently changes it. This
 *    is the one hazard that makes an extraction not a pure move.
 * 3. A constant read by functions in more than one target module, which needs a
 *    home low enough for every reader.
 */
export function analyseConstants(spans, assignment) {
  const raw = fs.readFileSync(target, "utf8").split("\n")
  const inFunction = new Array(raw.length + 2).fill(false)
  for (const s of spans) for (let i = s.start; i <= s.end; i++) inFunction[i] = true
  const blockStart = raw.findIndex((l) => /^export\s*\{/.test(l))

  const home = new Map()
  for (const [mod, fns] of Object.entries(assignment.modules)) for (const fn of fns) home.set(fn, mod)
  const stageOf = (mod) => assignment.order.indexOf(mod) + 1
  const fnNames = new Set(spans.map((f) => f.name))

  // Declarations at column 0, with their initializer text.
  const consts = []
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i].match(/^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/)
    if (!m) continue
    let text = raw[i], j = i
    // A multi-line initializer runs until a line closing at column 0.
    while (j + 1 < raw.length && !/^[)}\]]/.test(raw[j + 1]) && /^\s/.test(raw[j + 1] || "")) {
      j += 1
      text += "\n" + raw[j]
    }
    if (j + 1 < raw.length && /^[)}\]]/.test(raw[j + 1])) text += "\n" + raw[j + 1]
    consts.push({ name: m[1], line: i + 1, text })
  }

  const rows = consts.map((c) => {
    const readers = new Set()
    const re = new RegExp(`\\b${c.name}\\b`)
    for (let i = 1; i <= raw.length; i++) {
      if (i === c.line || (blockStart !== -1 && i > blockStart)) continue
      if (!inFunction[i]) continue
      if (re.test(raw[i - 1])) {
        const owner = spans.find((f) => i >= f.start && i <= f.end)
        if (owner && home.has(owner.name)) readers.add(home.get(owner.name))
      }
    }
    // Calls made while building the value.
    const calls = new Set()
    for (const m of c.text.matchAll(/([A-Za-z0-9_$]+)\s*\(/g)) if (fnNames.has(m[1])) calls.add(m[1])
    return {
      name: c.name,
      line: c.line,
      readers: [...readers].sort((a, b) => stageOf(a) - stageOf(b)),
      calls: [...calls].sort(),
      pathDerived: /import\.meta\.url/.test(c.text),
    }
  })

  // A constant derived from another path-derived constant inherits the hazard.
  const derived = new Set(rows.filter((r) => r.pathDerived).map((r) => r.name))
  let grew = true
  while (grew) {
    grew = false
    for (const r of rows) {
      if (derived.has(r.name)) continue
      if ([...derived].some((d) => new RegExp(`\\b${d}\\b`).test(r.text || "") || new RegExp(`\\b${d}\\b`).test(
        consts.find((c) => c.name === r.name)?.text || ""))) {
        derived.add(r.name); grew = true
      }
    }
  }
  for (const r of rows) r.pathDerived = derived.has(r.name)

  const shared = rows.filter((r) => r.readers.length > 1)
  const orphaned = rows.filter((r) => r.readers.length === 0)
  const initializerEdges = []
  for (const r of rows) {
    if (!r.calls.length) continue
    const constHome = r.readers[0] || null
    for (const callee of r.calls) {
      const calleeHome = home.get(callee)
      if (!constHome || !calleeHome || constHome === calleeHome) continue
      initializerEdges.push({ constant: r.name, from: constHome, to: calleeHome, callee })
    }
  }
  return { rows, shared, orphaned, initializerEdges, pathDerived: rows.filter((r) => r.pathDerived), stageOf }
}

function main() {
  const args = process.argv.slice(2)
  const { spans, fileLines } = readFunctionSpans(target)

  if (args.includes("--constants")) {
    const { spans } = readFunctionSpans(target)
    const assignment = JSON.parse(fs.readFileSync(
      path.join(repoRoot, "specs", "020-ws2-module-assignment.json"), "utf8"))
    const { rows, shared, orphaned, initializerEdges, pathDerived, stageOf } = analyseConstants(spans, assignment)

    console.log(`module-level constants: ${rows.length}`)
    console.log(`\nread by functions in more than one module: ${shared.length}`)
    for (const r of shared) {
      console.log(`  ${r.name.padEnd(34)} home ${String(stageOf(r.readers[0])).padStart(2)} ${r.readers[0].padEnd(15)} read by ${r.readers.join(", ")}`)
    }
    console.log(`\nno function reader at all: ${orphaned.length}`)
    for (const r of orphaned) console.log(`  ${r.name} (line ${r.line})`)

    console.log(`\npath-derived (value depends on the file's own depth on disk): ${pathDerived.length}`)
    for (const r of pathDerived) console.log(`  ${r.name} (line ${r.line})`)
    if (pathDerived.length) {
      console.log("  -> moving any of these into a subdirectory changes its value silently.")
      process.exitCode = 1
    }

    console.log(`\nmodule-evaluation edges from constant initializers: ${initializerEdges.length}`)
    for (const e of initializerEdges) {
      console.log(`  ${e.constant}: ${e.from}(${stageOf(e.from)}) -> ${e.to}(${stageOf(e.to)}) via ${e.callee}`)
      if (stageOf(e.to) >= stageOf(e.from)) process.exitCode = 1
    }
    return
  }

  if (args.includes("--module-level")) {
    const { spans } = readFunctionSpans(target)
    const calls = findModuleEvaluationCalls(spans)
    const doc = JSON.parse(fs.readFileSync(
      path.join(repoRoot, "specs", "020-ws2-module-assignment.json"), "utf8"))
    const home = new Map()
    for (const [m, fns] of Object.entries(doc.modules)) for (const fn of fns) home.set(fn, m)

    console.log(`functions called during module evaluation: ${calls.size}`)
    for (const [name, lines] of [...calls].sort()) {
      const mod = home.get(name) || "(unassigned)"
      console.log(`  ${name.padEnd(26)} stage ${String(doc.order.indexOf(mod) + 1).padStart(2)} ${mod.padEnd(12)} lines ${lines.join(", ")}`)
    }
    const stages = new Set([...calls.keys()].map((n) => home.get(n)))
    console.log(`\nmodules they live in: ${[...stages].join(", ") || "none"}`)
    console.log("Every one must be evaluated before core.mjs's own module body runs.")
    return
  }

  if (args.includes("--exports")) {
    const { spans } = readFunctionSpans(target)
    checkExportSurface(spans).then(({ exported, rows, unassigned, reexported, placed, inline, blockNames, order, baseline, added, removed }) => {
      console.log(`export surface: ${exported.length} names`)
      console.log(`  export { } block: ${blockNames.length}`)
      console.log(`  inline export function: ${inline.length} (${inline.join(", ") || "none"})`)
      console.log(`  assigned to a module: ${placed.length}`)
      console.log(`  re-exported from a sibling: ${reexported.length}`)
      const byStage = new Map()
      for (const r of placed) byStage.set(r.assigned, (byStage.get(r.assigned) || 0) + 1)
      for (const m of order) if (byStage.get(m)) console.log(`    ${String(order.indexOf(m) + 1).padStart(2)} ${m.padEnd(19)} ${byStage.get(m)}`)
      if (baseline) {
        console.log(`  baseline (${baseline.length} names): ${added.length === 0 && removed.length === 0 ? "matches" : "DRIFTED"}`)
        if (added.length) console.log(`    added: ${added.join(", ")}`)
        if (removed.length) console.log(`    removed: ${removed.join(", ")}`)
        if (added.length || removed.length) process.exitCode = 1
      } else {
        console.log("  baseline: MISSING — specs/020-ws2-export-baseline.json not found")
        process.exitCode = 1
      }
      if (unassigned.length) {
        console.log(`\nUNASSIGNED EXPORTS (${unassigned.length}): ${unassigned.map((r) => r.name).join(", ")}`)
        process.exitCode = 1
      } else {
        console.log("\nevery exported name has a home")
      }
    })
    return
  }

  if (args.includes("--cli")) {
    // The cli.mjs half of the workstream. Generated for the same reason the
    // core table is: the prose figures for this file were wrong twice.
    const cliPath = path.join(repoRoot, "src", "brain_train", "cli.mjs")
    const { spans: cliSpans, fileLines: cliLines } = readFunctionSpans(cliPath)
    const run = cliSpans.find((f) => f.name === "run")
    // Exactly the set the prose names: format*, print*, and build*Lines.
    const presentation = cliSpans.filter((f) =>
      /^format/.test(f.name) || /^print/.test(f.name) || /^build.*Lines$/.test(f.name))
    const presentationLines = presentation.reduce((a, f) => a + f.lines, 0)
    const body = fs.readFileSync(cliPath, "utf8").split("\n").slice(run.start - 1, run.end)
    const comparisons = body.filter((l) => /command ===/.test(l)).length
    const branches = body.filter((l) => /^ {2}(\} )?else if \(|^ {2}if \(/.test(l)).length

    console.log(`src/brain_train/cli.mjs: ${cliLines} lines`)
    console.log(`  top-level functions:     ${cliSpans.length}`)
    console.log(`  run:                     ${run.lines} lines (${(run.lines / cliLines * 100).toFixed(1)}% of file)`)
    console.log(`  command === comparisons: ${comparisons} across ${branches} top-level branches`)
    console.log(`  format*/print*/build*Lines: ${presentation.length} fns, ${presentationLines} lines`)
    console.log(`  after extracting them:   ${cliLines - presentationLines} lines`)
    return
  }

  const named = args.indexOf("--fns")
  if (named !== -1) {
    const want = args.slice(named + 1)
    let total = 0
    for (const n of want) {
      const f = spans.find((s) => s.name === n)
      console.log(n.padEnd(30), f ? f.lines : "NOT FOUND")
      total += f?.lines || 0
    }
    console.log("TOTAL".padEnd(30), total)
    return
  }

  if (args.includes("--stages")) {
    const { rows, violations, missing, unknown, notYetLanded } = checkStages(spans, buildCallGraph(target, spans))
    console.log("| # | Module | Fns | ~Lines | Imports |")
    console.log("|---:|---|---:|---:|---|")
    for (const r of rows) {
      console.log(`| ${r.n} | \`internal/${r.mod}.mjs\` | ${r.fns} | ${r.lines.toLocaleString("en-US")} | ${r.imports.join(",") || "—"} |`)
    }
    const totF = rows.reduce((a, r) => a + r.fns, 0)
    const totL = rows.reduce((a, r) => a + r.lines, 0)
    console.log(`\ntotals: ${totF} functions, ${totL.toLocaleString("en-US")} lines`)
    const biggest = [...rows].sort((a, b) => b.lines - a.lines)[0]
    console.log(`largest module: ${biggest.mod} at ${biggest.lines.toLocaleString("en-US")} lines`)
    if (notYetLanded.length) console.log(`\npending, not on this tree yet (${notYetLanded.length}): ${notYetLanded.join(", ")}`)
    if (missing.length) console.log(`\nUNASSIGNED (${missing.length}): ${missing.join(", ")}`)
    if (unknown.length) console.log(`\nASSIGNED BUT ABSENT (${unknown.length}): ${unknown.join(", ")}`)
    console.log(`\nstage-order violations: ${violations.length}`)
    for (const v of violations) console.log("  " + v)
    if (violations.length || missing.length || unknown.length) process.exitCode = 1
    return
  }

  const edges = buildCallGraph(target, spans)
  const nodes = spans.map((f) => f.name)
  const sccs = stronglyConnectedComponents(nodes, edges)
  const cycles = sccs.filter((c) => c.length > 1)
  const callers = new Map()
  for (const [from, tos] of edges) for (const to of tos) callers.set(to, (callers.get(to) || 0) + 1)

  const report = {
    file: path.relative(repoRoot, target),
    fileLines,
    functions: spans.length,
    functionLines: spans.reduce((a, f) => a + f.lines, 0),
    callEdges: [...edges.values()].reduce((a, s) => a + s.size, 0),
    functionLevelCycles: cycles.length,
    largest: [...spans].sort((a, b) => b.lines - a.lines).slice(0, 5)
      .map((f) => ({ name: f.name, lines: f.lines })),
    uncalled: spans.filter((f) => !callers.has(f.name)).map((f) => f.name).sort(),
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ...report, spans, edges: Object.fromEntries([...edges].map(([k, v]) => [k, [...v].sort()])) }, null, 1))
    return
  }

  console.log(`${report.file}: ${report.fileLines} lines`)
  console.log(`  top-level functions: ${report.functions}`)
  console.log(`  lines inside them:   ${report.functionLines}`)
  console.log(`  call edges:          ${report.callEdges}`)
  console.log(`  function-level cycles: ${report.functionLevelCycles}`)
  console.log("  largest:")
  for (const f of report.largest) console.log(`    ${f.name.padEnd(28)} ${f.lines}`)
  console.log(`  never called inside core.mjs: ${report.uncalled.length}`)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main()
