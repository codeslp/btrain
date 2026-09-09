import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formal-advisory-test-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, "repo")
  const bin = path.join(directory, "bin")
  fs.mkdirSync(root)
  fs.mkdirSync(bin)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TLC_JAR: path.join(directory, "tool.jar"), FORMAL_TEST_LOG: path.join(directory, "calls") }
  for (const key of ["BTRAIN_AGENT", "BTRAIN_LANE", "BTRAIN_LANE_LOCKED", "BTRAIN_REPO", "BRAIN_TRAIN_AGENT", "BTRAIN_LOOP_ACTIVE", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH", "TLA_LIBRARY"]) delete env[key]
  function run(executable, args) {
    return spawnSync(executable, args, { cwd: root, env, encoding: "utf8", timeout: 30000 })
  }
  function write(file, content) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  function git(...args) {
    const result = run("git", args)
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  function commit() {
    git("add", ".")
    git("-c", "user.name=Formal Test", "-c", "user.email=formal@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture")
  }
  git("init", "-q")
  for (const file of ["scripts/formal_advisory.mjs", "scripts/formal_cache.mjs", "scripts/formal_contracts.json", "scripts/tla_pin.py"]) {
    if (fs.existsSync(path.join(source, file))) write(file, fs.readFileSync(path.join(source, file)))
  }
  write("specs/002-multi-lane-handoffs.md", "# Contract\n## Rule\nKeep locks exclusive.\n## Notes\nNotes.\n")
  write("specs/tla/LaneLock.tla", "\\* Pinned to: specs/002-multi-lane-handoffs.md § Rule\n\\* Pinned-hash: UNPINNED\n---- MODULE LaneLock ----\nEXTENDS Naturals, Helper\n====\n")
  write("specs/tla/LaneLock.cfg", "SPECIFICATION Spec\n")
  write("specs/tla/Helper.tla", "---- MODULE Helper ----\n====\n")
  write("package.json", JSON.stringify({ scripts: { "test:formal": "node harness.mjs" } }))
  write("harness.mjs", 'import fs from "node:fs"; fs.appendFileSync(process.env.FORMAL_TEST_LOG, "harness\\n"); if (process.env.FORMAL_TEST_MISMATCH) { console.error("validation_mismatch"); process.exit(1) }\n')
  fs.writeFileSync(env.TLC_JAR, "pinned tool")
  fs.writeFileSync(path.join(bin, "java"), `#!/usr/bin/env node\nconst fs = require('node:fs'); if (process.argv.includes('-version')) { console.error('test java 17'); process.exit(0) } fs.appendFileSync(process.env.FORMAL_TEST_LOG, 'tlc\\n'); if (process.env.FORMAL_TEST_TLC_FAIL) { console.error('Error: Invariant Safety is violated.'); process.exit(1) } console.log('Model checking completed. No error has been found.');\n`, { mode: 0o755 })
  assert.equal(run("python3", ["scripts/tla_pin.py", "--repin", "specs/tla/LaneLock.tla"]).status, 0)
  commit()
  const base = git("rev-parse", "HEAD")
  function advisory(classifyOnly = false, extraArgs = []) {
    const output = path.join(directory, "result.json")
    fs.rmSync(output, { force: true })
    const result = run("node", ["scripts/formal_advisory.mjs", "--base", base, "--cache-dir", path.join(directory, "cache"), "--output", output, ...(classifyOnly ? ["--classify-only"] : []), ...extraArgs])
    assert.ok(fs.existsSync(output), result.stderr)
    return { ...JSON.parse(fs.readFileSync(output)), processStatus: result.status }
  }
  function calls(name) {
    return fs.existsSync(env.FORMAL_TEST_LOG) ? fs.readFileSync(env.FORMAL_TEST_LOG, "utf8").split("\n").filter(line => line === name).length : 0
  }
  return { root, directory, env, write, commit, advisory, calls, git, run }
}

test("TLC cache survives implementation edits while validation reruns and can fail", t => {
  const f = fixture(t)
  f.write("specs/tla/LaneLock.cfg", "SPECIFICATION Spec\n\\* changed bounds\n")
  f.commit()
  const first = f.advisory()
  assert.equal(first.verdict, "pass", JSON.stringify(first))
  assert.equal(first.checks.find(c => c.name === "tlc:LaneLock").cache.hit, false)
  assert.equal(f.calls("tlc"), 1)
  f.write("src/brain_train/transitions.mjs", "// implementation change\n")
  f.commit()
  f.env.FORMAL_TEST_MISMATCH = "1"
  const second = f.advisory()
  assert.equal(second.checks.find(c => c.name === "tlc:LaneLock").cache.hit, true)
  assert.equal(second.checks.find(c => c.name === "fast-check").verdict, "validation_mismatch")
  assert.equal(second.processStatus, 1)
  assert.equal(f.calls("tlc"), 1)
  assert.equal(f.calls("harness"), 2)
  assert.notEqual(first.head, second.head)
})

test("TLC cache invalidates imports, configuration, and tool bytes and ignores corrupt records", t => {
  const f = fixture(t)
  f.write("specs/tla/LaneLock.cfg", "SPECIFICATION Spec\n\\* first\n")
  f.commit()
  f.advisory()
  f.write("specs/tla/Helper.tla", "---- MODULE Helper ----\n\\* changed import\n====\n")
  f.commit()
  f.advisory()
  assert.equal(f.calls("tlc"), 2)
  f.write("specs/tla/LaneLock.cfg", "SPECIFICATION OtherSpec\n")
  f.commit()
  f.advisory()
  assert.equal(f.calls("tlc"), 3)
  fs.appendFileSync(f.env.TLC_JAR, "changed tool")
  const result = f.advisory()
  assert.equal(f.calls("tlc"), 4)
  const key = result.checks.find(c => c.name === "tlc:LaneLock").cache.key
  fs.writeFileSync(path.join(f.directory, "cache", `${key}.json`), "broken json")
  f.advisory()
  assert.equal(f.calls("tlc"), 5)
  const prepare = f.advisory(false, ["--cache-key-only"])
  assert.equal(prepare.cacheKey, key)
  assert.equal(f.calls("tlc"), 5)
  f.write("specs/tla/LaneLock.tla", fs.readFileSync(path.join(f.root, "specs/tla/LaneLock.tla"), "utf8") + "\\* model changed\n")
  f.commit()
  f.advisory()
  assert.equal(f.calls("tlc"), 6)
})

test("a real bounded TLC run produces reusable model evidence", { skip: !process.env.TLC_JAR || !fs.existsSync(process.env.TLC_JAR) }, t => {
  const f = fixture(t)
  f.env.TLC_JAR = process.env.TLC_JAR
  f.env.PATH = process.env.PATH
  const manifest = JSON.parse(fs.readFileSync(path.join(f.root, "scripts/formal_contracts.json")))
  manifest.contracts[0].config = "config/alternate.cfg"
  f.write("scripts/formal_contracts.json", JSON.stringify(manifest))
  f.write("specs/tla/LaneLock.tla", "\\* Pinned to: specs/002-multi-lane-handoffs.md § Rule\n\\* Pinned-hash: UNPINNED\n---- MODULE LaneLock ----\nEXTENDS Naturals\nVARIABLE x\nInit == x = 0\nNext == x' = 1 - x\nSpec == Init /\\ [][Next]_x\nSafe == x \\in {0, 1}\n====\n")
  f.write("specs/tla/LaneLock.cfg", "SPECIFICATION Spec\nINVARIANT Safe\n")
  f.write("config/alternate.cfg", "SPECIFICATION Spec\nINVARIANT Safe\n")
  assert.equal(f.run("python3", ["scripts/tla_pin.py", "--repin", "specs/tla/LaneLock.tla"]).status, 0)
  f.commit()
  const first = f.advisory()
  assert.equal(first.checks.find(c => c.name === "tlc:LaneLock").verdict, "pass", JSON.stringify(first))
  const second = f.advisory()
  assert.equal(second.checks.find(c => c.name === "tlc:LaneLock").cache.hit, true)
  assert.equal(f.calls("harness"), 2)
  f.write("config/alternate.cfg", "SPECIFICATION Spec\nINVARIANT MissingInvariant\n")
  f.commit()
  const changed = f.advisory().checks.find(c => c.name === "tlc:LaneLock")
  assert.equal(changed.cache.hit, false)
  assert.equal(changed.verdict, "infrastructure_failure")
  assert.match(changed.stdout + changed.stderr, /MissingInvariant/)
})

test("cache keys include the verifier, manifest, and execution policy", t => {
  const f = fixture(t)
  let key = f.advisory(false, ["--cache-key-only"]).cacheKey
  assert.match(key, /^[0-9a-f]{64}$/)
  for (const file of ["scripts/formal_advisory.mjs", "scripts/formal_cache.mjs", "scripts/formal_contracts.json"]) {
    fs.appendFileSync(path.join(f.root, file), "\n")
    f.commit()
    const next = f.advisory(false, ["--cache-key-only"]).cacheKey
    assert.notEqual(key, next, `${file} invalidates the cache`)
    key = next
  }
  assert.equal(f.calls("tlc"), 0)
})

test("TLC executes and hashes the declared configuration outside the model directory", t => {
  const f = fixture(t)
  const manifest = JSON.parse(fs.readFileSync(path.join(f.root, "scripts/formal_contracts.json")))
  manifest.contracts[0].config = "config/alternate.cfg"
  f.write("scripts/formal_contracts.json", JSON.stringify(manifest))
  f.write("config/alternate.cfg", "SPECIFICATION Spec\n")
  f.commit()
  // Make configuration changes the only selection trigger.
  f.git("branch", "config-base")
  f.write("config/alternate.cfg", "SPECIFICATION OtherSpec\n")
  f.commit()
  const first = f.advisory(false, ["--base", "config-base"])
  const check = first.checks.find(c => c.name === "tlc:LaneLock")
  assert.ok(check, JSON.stringify(first))
  assert.match(check.command, /-config \.\.\/\.\.\/config\/alternate\.cfg /)
  assert.equal(check.verdict, "pass")
  assert.equal(f.advisory(false, ["--base", "config-base"]).checks.find(c => c.name === "tlc:LaneLock").cache.hit, true)
  const key = f.advisory(false, ["--cache-key-only"]).cacheKey
  assert.equal(key, check.cache.key)
  f.write("config/alternate.cfg", "SPECIFICATION ThirdSpec\n")
  f.commit()
  const next = f.advisory(false, ["--base", "config-base"]).checks.find(c => c.name === "tlc:LaneLock")
  assert.notEqual(next.cache.key, key)
  assert.equal(next.cache.hit, false)
  assert.equal(f.calls("tlc"), 2)
  fs.rmSync(path.join(f.root, "config/alternate.cfg"))
  f.commit()
  const missing = f.advisory(false, ["--base", "config-base"]).checks.find(c => c.name === "tlc:LaneLock")
  assert.equal(missing.verdict, "infrastructure_failure")
  assert.match(missing.detail, /config\/alternate.cfg is missing/)
  assert.equal(f.calls("tlc"), 2)
})

test("external JVM configuration disables reuse without suppressing checks", t => {
  const f = fixture(t)
  f.write("specs/tla/LaneLock.cfg", "SPECIFICATION Spec\n\\* first\n")
  f.commit()
  f.advisory()
  f.env.JAVA_TOOL_OPTIONS = "-Xmx512m"
  const result = f.advisory()
  assert.equal(result.checks.find(c => c.name === "tlc:LaneLock").cache.hit, false)
  assert.match(result.checks.find(c => c.name === "tlc:LaneLock").cache.gap, /JAVA_TOOL_OPTIONS/)
  assert.equal(f.calls("tlc"), 2)
})

test("failed TLC and stale pins never become reusable passes", t => {
  const f = fixture(t)
  f.write("specs/tla/LaneLock.cfg", "SPECIFICATION Spec\n\\* first\n")
  f.commit()
  f.env.FORMAL_TEST_TLC_FAIL = "1"
  assert.equal(f.advisory().processStatus, 1)
  assert.equal(f.advisory().processStatus, 1)
  assert.equal(f.calls("tlc"), 2)
  delete f.env.FORMAL_TEST_TLC_FAIL
  f.advisory()
  f.write("specs/002-multi-lane-handoffs.md", "# Contract\n## Rule\nChanged rule.\n")
  f.commit()
  const stale = f.advisory()
  assert.equal(stale.processStatus, 1)
  assert.equal(stale.checks.some(c => c.name.startsWith("tlc:")), false)
  assert.equal(f.calls("tlc"), 3)
})

test("selection excludes unpinned documentation but includes transitions and unknown runtime modules", t => {
  const f = fixture(t)
  f.write("specs/002-multi-lane-handoffs.md", "# Contract\n## Rule\nKeep locks exclusive.\n## Notes\nRevised notes.\n")
  f.write("specs/tla/README.md", "Setup documentation.\n")
  f.commit()
  let selection = f.advisory(true).selection
  assert.equal(selection.pin, true)
  assert.equal(selection.tlc, false)
  assert.equal(selection.harness, false)
  f.write("src/brain_train/transitions.mjs", "// changed transition\n")
  f.commit()
  selection = f.advisory(true).selection
  assert.equal(selection.harness, true)
  assert.equal(selection.tlc, false)
  f.git("reset", "--hard", "HEAD~1")
  f.write("src/brain_train/new-dependency.mjs", "// unknown dependency\n")
  f.commit()
  assert.equal(f.advisory(true).selection.harness, true)
})
