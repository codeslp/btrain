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
// line that is exactly `}` at column 0. Leading JSDoc and the blank line
// between functions are excluded.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

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
    } else if (cur && /^\}/.test(lines[i])) {
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
  const unknown = [...stage.keys()].filter((n) => !spans.some((f) => f.name === n))

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

  const rows = doc.order.map((mod, i) => {
    const fns = doc.modules[mod]
    return {
      n: i + 1,
      mod,
      fns: fns.length,
      lines: fns.reduce((a, f) => a + (lines.get(f) || 0), 0),
      imports: [...(deps.get(mod) || [])].sort((x, y) => x - y),
    }
  })
  return { rows, violations, missing, unknown }
}

function main() {
  const args = process.argv.slice(2)
  const { spans, fileLines } = readFunctionSpans(target)

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
    const { rows, violations, missing, unknown } = checkStages(spans, buildCallGraph(target, spans))
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
