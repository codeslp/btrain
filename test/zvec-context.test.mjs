import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const HELPER_PATH = path.resolve(".claude/scripts/zvec-context.sh")

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-zvec-context-"))
}

async function runHelper(args, options = {}) {
  try {
    const execution = execFileAsync("/bin/bash", [HELPER_PATH, ...args], {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 1024 * 1024,
      timeout: options.timeout,
      killSignal: options.killSignal,
    })
    options.onSpawn?.(execution.child)
    const result = await execution
    return { code: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || "",
    }
  }
}

async function writeFakeZg(binDir, { withNode = true } = {}) {
  if (withNode) await fs.symlink(process.execPath, path.join(binDir, "node"))
  const fakePath = path.join(binDir, "zg")
  await fs.writeFile(fakePath, `#!/usr/bin/env bash
set -u
if [ -n "\${ZVEC_TEST_PID_LOG:-}" ]; then
  printf '%s\\n' "$$" >> "$ZVEC_TEST_PID_LOG"
fi
if [ -n "\${ZVEC_TEST_READY_RECORD:-}" ]; then
  for capture in "$TMPDIR"/zvec-context.*; do
    case "$capture" in *.ready|*.timeout|*.cancel) continue ;; esac
    [ -f "$capture" ] && printf '%s\\n' "$ZVEC_TEST_READY_RECORD" > "$capture.ready"
  done
fi
printf 'CALL\\n' >> "$ZVEC_TEST_LOG"
printf '%s\\n' "$@" >> "$ZVEC_TEST_LOG"
if [ "\${1:-}" = "status" ]; then
  if [ -n "\${ZVEC_TEST_STATUS_SLEEP:-}" ]; then
    exec sleep "$ZVEC_TEST_STATUS_SLEEP"
  fi
  if [ "\${ZVEC_TEST_STATUS_RC:-0}" -ne 0 ]; then
    printf 'index unavailable\\n' >&2
    exit "$ZVEC_TEST_STATUS_RC"
  fi
  printf 'Workspace index is ready\\n'
  exit 0
fi
if [ -n "\${ZVEC_TEST_CWD_LOG:-}" ]; then
  printf '%s\\n' "$PWD" > "$ZVEC_TEST_CWD_LOG"
fi
if [ "\${ZVEC_TEST_QUERY_RC:-0}" -ne 0 ]; then
  printf 'query failed safely\\n' >&2
  exit "$ZVEC_TEST_QUERY_RC"
fi
if [ -n "\${ZVEC_TEST_QUERY_SLEEP:-}" ]; then
  # A background child keeps the inherited stdout open past the parent's death,
  # the shape that defeats a pipe-based capture.
  sleep "$ZVEC_TEST_QUERY_SLEEP" &
  sleep "$ZVEC_TEST_QUERY_SLEEP"
  wait
  exit 0
fi
if [ -n "\${ZVEC_TEST_IGNORE_TERM:-}" ]; then
  trap '' TERM
  sleep "$ZVEC_TEST_IGNORE_TERM"
  printf 'survived\\n'
  exit 0
fi
printf 'freshness: fresh\\nspecs/example.md:10-14\\n'
`, "utf8")
  await fs.chmod(fakePath, 0o755)
  return fakePath
}

describe("optional zvec-grep context helper", () => {
  for (const [failure, code] of [["missing executable", 127], ["denied executable", 126], ["command signal", 143]]) {
    it(`preserves the exit code for a ${failure}`, async () => {
      const tmpDir = await makeTmpDir()
      const binDir = path.join(tmpDir, "bin")
      await fs.mkdir(binDir)
      await writeFakeZg(binDir)
      const action = failure === "missing executable" ? 'rm -- "$0"'
        : failure === "denied executable" ? 'chmod 644 -- "$0"' : ":"
      await fs.writeFile(path.join(binDir, "zg"), `#!/bin/bash
if [ "$1" = "status" ]; then
  ${action}
  exit 0
fi
kill -TERM "$$"
`, { mode: 0o755 })
      try {
        const result = await runHelper(["search", "query", "--root", tmpDir], {
          cwd: tmpDir, timeout: 5000, killSignal: "SIGKILL",
          env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` },
        })
        assert.equal(result.code, code, `${result.stdout}\n${result.stderr}`)
        assert.doesNotMatch(result.stdout, /zvec-context: skipped/)
        if (failure !== "command signal") assert.match(result.stderr, failure === "missing executable" ? /ENOENT/ : /EACCES/)
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true })
      }
    })
  }
  it("requests graceful TERM before escalating a timed-out command", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const termLog = path.join(tmpDir, "term")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir)
    await fs.writeFile(path.join(binDir, "zg"), `#!/bin/bash
if [ "$1" = "status" ]; then exit 0; fi
trap 'printf "TERM\\n" > "$ZVEC_TEST_TERM_LOG"; exit 0' TERM
while :; do /bin/sleep 0.01; done
`, { mode: 0o755 })
    try {
      const result = await runHelper(["search", "query", "--root", tmpDir], {
        cwd: tmpDir, timeout: 5000, killSignal: "SIGKILL",
        env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, ZVEC_CONTEXT_TIMEOUT: "1", ZVEC_TEST_TERM_LOG: termLog },
      })
      assert.equal(result.code, 0)
      assert.match(result.stdout, /zvec-context: skipped/)
      assert.equal(await fs.readFile(termLog, "utf8"), "TERM\n")
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
  it("does not let an inherited subshell signal cancel the parent's running executor", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const bashEnv = path.join(tmpDir, "bash-env")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir)
    // The command substitution inherits the parent's live job table. Cleanup
    // ownership alone cannot prevent it from signalling those parent jobs.
    await fs.writeFile(bashEnv, `set -T
subshell_signal() {
  if [ "$BASH_SUBSHELL" -eq 0 ] && [[ "$1" == 'wait "$pid"'* ]]; then
    trap - DEBUG
    ignored=$(on_signal 15)
  fi
}
trap 'subshell_signal "$BASH_COMMAND"' DEBUG
`)
    try {
      const result = await runHelper(["search", "failing query", "--root", tmpDir], {
        cwd: tmpDir, timeout: 5000, killSignal: "SIGKILL",
        env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, BASH_ENV: bashEnv,
          ZVEC_TEST_LOG: path.join(tmpDir, "zg.log"), ZVEC_TEST_QUERY_RC: "7" },
      })
      assert.equal(result.code, 7, `${result.stdout}\n${result.stderr}`)
      assert.match(result.stderr, /query failed safely/)
      assert.doesNotMatch(result.stderr, /No such file/)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
  it("soft-skips before launching zg when the existing Node runtime is unavailable", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir, { withNode: false })
    try {
      const result = await runHelper(["search", "query", "--root", tmpDir], {
        cwd: tmpDir, env: { ...process.env, PATH: binDir, ZVEC_TEST_LOG: path.join(tmpDir, "zg.log") },
      })
      assert.equal(result.code, 0)
      assert.match(result.stdout, /node CLI is not installed/)
      assert.equal(result.stderr, "")
      await assert.rejects(fs.access(path.join(tmpDir, "zg.log")), { code: "ENOENT" })
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
  it("leaves no capture or cancellation artifact when signalled before mktemp", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const bashEnv = path.join(tmpDir, "bash-env")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir)
    await fs.writeFile(bashEnv, `set -T
before_capture() {
  if [ "$BASH_SUBSHELL" -eq 0 ] && [[ "$1" == 'out=$(mktemp '* ]]; then
    trap - DEBUG
    on_signal 2
  fi
}
trap 'before_capture "$BASH_COMMAND"' DEBUG
`)
    const before = (await fs.readdir(tmpDir)).sort()
    try {
      const result = await runHelper(["search", "query", "--root", tmpDir], {
        cwd: tmpDir, timeout: 5000, killSignal: "SIGKILL",
        env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, BASH_ENV: bashEnv, TMPDIR: tmpDir,
          ZVEC_TEST_LOG: path.join(tmpDir, "zg.log") },
      })
      assert.equal(result.code, 130)
      assert.deepEqual((await fs.readdir(tmpDir)).sort(), before)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
  it("keeps capture evidence until a cancelled executor has actually exited", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const scratch = path.join(tmpDir, "scratch")
    const running = path.join(tmpDir, "running")
    const exiting = path.join(tmpDir, "exiting")
    const release = path.join(tmpDir, "release")
    await fs.mkdir(binDir)
    await fs.mkdir(scratch)
    await writeFakeZg(binDir)
    await fs.unlink(path.join(binDir, "node"))
    // A controlled executor delays its exit after TERM. The helper must
    // await that exit rather than deleting evidence as soon as it signals.
    await fs.writeFile(path.join(binDir, "node"), `#!/bin/bash
trap ': > "$ZVEC_TEST_EXITING"; while [ ! -e "$ZVEC_TEST_RELEASE" ]; do /bin/sleep 0.01; done; exit 143' TERM
printf '%s\\n' "$$" > "$ZVEC_TEST_RUNNING"
while :; do /bin/sleep 0.01; done
`, { mode: 0o755 })
    let helper
    let completed = false
    const resultPromise = runHelper(["search", "query", "--root", tmpDir], {
      cwd: tmpDir, timeout: 5000, killSignal: "SIGKILL", onSpawn: (process) => { helper = process },
      env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, TMPDIR: scratch,
        ZVEC_TEST_RUNNING: running, ZVEC_TEST_EXITING: exiting, ZVEC_TEST_RELEASE: release,
        ZVEC_TEST_LOG: path.join(tmpDir, "zg.log") },
    }).then((result) => { completed = true; return result })
    async function waitForFile(file) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await fs.access(file).then(() => true, () => false)) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.fail(`executor never reached ${path.basename(file)}`)
    }
    try {
      await waitForFile(running)
      helper.kill("SIGINT")
      await waitForFile(exiting)
      // Hold the executor barrier while observing the actual helper process.
      // A single immediate assertion can run before a missing wait lets it exit.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        assert.equal(helper.exitCode, null, "helper must stay alive until executor exit")
        assert.equal(helper.signalCode, null, "helper must stay alive until executor exit")
        assert.doesNotThrow(() => process.kill(helper.pid, 0), "helper must still exist while the executor barrier is held")
        assert.equal(completed, false, "helper must not exit before its executor")
      }
      assert.ok((await fs.readdir(scratch)).some((file) => /^zvec-context\.[^.]+$/.test(file)), "capture must remain until executor exit")
      await fs.writeFile(release, "")
      const result = await resultPromise
      assert.equal(result.code, 130)
      assert.deepEqual(await fs.readdir(scratch), [])
    } finally {
      await fs.writeFile(release, "")
      const executorPid = Number(await fs.readFile(running, "utf8").catch(() => ""))
      if (executorPid) {
        const command = await execFileAsync("/bin/ps", ["-o", "args=", "-p", String(executorPid)]).catch(() => ({ stdout: "" }))
        if (command.stdout.includes(path.join(binDir, "node"))) {
          try { process.kill(executorPid, "SIGTERM") } catch (error) { if (error.code !== "ESRCH") throw error }
        }
      }
      await resultPromise
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
  it("ignores stale and malformed PID records without signalling unrelated processes", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const scratch = path.join(tmpDir, "scratch")
    await fs.mkdir(binDir)
    await fs.mkdir(scratch)
    await writeFakeZg(binDir)
    const unrelated = spawn("/bin/sleep", ["30"], { stdio: "ignore" })
    const exited = new Promise((resolve) => unrelated.once("exit", resolve))
    try {
      for (const record of [String(unrelated.pid), "0", "-1", "not-a-pid"]) {
        const result = await runHelper(["search", "failing query", "--root", tmpDir], {
          cwd: tmpDir, timeout: 5000, killSignal: "SIGKILL",
          env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, TMPDIR: scratch,
            ZVEC_TEST_LOG: path.join(tmpDir, "zg.log"), ZVEC_TEST_QUERY_RC: "7", ZVEC_TEST_READY_RECORD: record },
        })
        assert.equal(result.code, 7, `${result.stdout}\n${result.stderr}`)
        assert.match(result.stderr, /query failed safely/)
        assert.equal(unrelated.signalCode, null, "ready-file data must never become a signal target")
        assert.equal(unrelated.exitCode, null)
        assert.deepEqual(await fs.readdir(scratch), [])
      }
    } finally {
      unrelated.kill("SIGKILL")
      await exited
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
  it("reaps its executor when signalled before the PID assignment", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const scratch = path.join(tmpDir, "scratch")
    const event = path.join(tmpDir, "watchdog-pid")
    const bashEnv = path.join(tmpDir, "bash-env")
    const marker = String(7000 + process.pid % 2000)
    await fs.mkdir(binDir)
    await fs.mkdir(scratch)
    await writeFakeZg(binDir)
    await fs.writeFile(bashEnv, `set -T
early_interrupt() {
  if [ "$BASH_SUBSHELL" -eq 0 ] && [ "$1" = 'pid=$!' ]; then
    trap - DEBUG
    printf '%s\\n' "$!" > "$ZVEC_TEST_EVENTS"
    on_signal 2
  fi
}
trap 'early_interrupt "$BASH_COMMAND"' DEBUG
`)
    let watchdogPid
    try {
      const result = await runHelper(["search", "query", "--root", tmpDir], {
        cwd: tmpDir, timeout: 5000, killSignal: "SIGKILL",
        env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, TMPDIR: scratch, BASH_ENV: bashEnv,
          ZVEC_TEST_EVENTS: event, ZVEC_TEST_LOG: path.join(tmpDir, "zg.log"), ZVEC_CONTEXT_TIMEOUT: marker,
          ZVEC_TEST_STATUS_SLEEP: "30" },
      })
      watchdogPid = Number(await fs.readFile(event, "utf8"))
      assert.equal(result.code, 130)
      const state = await execFileAsync("/bin/ps", ["-o", "stat=", "-p", String(watchdogPid)]).catch(() => ({ stdout: "" }))
      assert.equal(state.stdout.trim(), "", "early interruption must reap the already-forked executor")
      assert.deepEqual(await fs.readdir(scratch), [], "early interruption must leave no late ready/timeout files")
    } finally {
      if (watchdogPid) {
        const ps = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,args="])
        for (const line of ps.stdout.split("\n")) {
          const child = line.trim().match(new RegExp(`^(\\d+)\\s+${watchdogPid}\\s+sleep (?:${marker}|30)$`))
          if (child) { try { process.kill(Number(child[1]), "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error } }
        }
        try { process.kill(watchdogPid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
      }
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
  it("waits for the owned command to exit when the helper is cancelled", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const scratch = path.join(tmpDir, "scratch")
    const pidLog = path.join(tmpDir, "command-pid")
    await fs.mkdir(binDir)
    await fs.mkdir(scratch)
    await writeFakeZg(binDir)
    let helper
    let commandPid
    const resultPromise = runHelper(["status", "--root", tmpDir], {
      cwd: tmpDir, timeout: 5000, killSignal: "SIGKILL", onSpawn: (process) => { helper = process },
      env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, TMPDIR: scratch,
        ZVEC_TEST_LOG: path.join(tmpDir, "zg.log"), ZVEC_TEST_PID_LOG: pidLog,
        ZVEC_TEST_STATUS_SLEEP: "30", ZVEC_CONTEXT_TIMEOUT: "60" },
    })
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const pid = await fs.readFile(pidLog, "utf8").catch(() => "")
        if (pid.trim()) { commandPid = Number(pid.trim()); break }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.ok(commandPid, "the command must be alive before cancellation")
      helper.kill("SIGINT")
      const result = await resultPromise
      assert.equal(result.code, 130)
      const state = await execFileAsync("/bin/ps", ["-o", "stat=", "-p", String(commandPid)]).catch(() => ({ stdout: "" }))
      assert.equal(state.stdout.trim(), "", "the executor must reap its command before returning")
      assert.deepEqual(await fs.readdir(scratch), [])
    } finally {
      if (commandPid) {
        const command = await execFileAsync("/bin/ps", ["-o", "args=", "-p", String(commandPid)]).catch(() => ({ stdout: "" }))
        if (/^(?:\/bin\/)?sleep 30$/.test(command.stdout.trim())) {
          try { process.kill(commandPid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
        }
      }
      helper?.kill("SIGTERM")
      await resultPromise
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
  it("returns success for an explicit help request", async () => {
    const result = await runHelper(["--help"], {
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    })

    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /^Usage: zvec-context\.sh/m)
  })

  it("rejects an inaccessible root before checking zg", async () => {
    const missingRoot = path.join(os.tmpdir(), "btrain-zvec-context-missing-root")

    for (const args of [
      ["search", "query", "--root", missingRoot],
      ["status", "--root", missingRoot],
    ]) {
      const result = await runHelper(args, {
        env: { ...process.env, PATH: "/usr/bin:/bin" },
      })

      assert.equal(result.code, 64, result.stdout)
      assert.match(result.stderr, /--root must name an accessible directory/)
      assert.doesNotMatch(result.stdout, /zvec-context: skipped/)
    }
  })

  it("soft-skips when the zg CLI is unavailable", async () => {
    const tmpDir = await makeTmpDir()
    try {
      const result = await runHelper(["search", "unknown workflow concept"], {
        cwd: tmpDir,
        env: { ...process.env, PATH: "/usr/bin:/bin" },
      })

      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /^zvec-context: skipped/m)
      assert.match(result.stdout, /zg CLI is not installed/)
      assert.match(result.stdout, /does not install it or create an index/)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("soft-skips without searching when the workspace index is not ready", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const logPath = path.join(tmpDir, "zg.log")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir)

    try {
      const result = await runHelper(["search", "unknown workflow concept", "--root", tmpDir], {
        cwd: tmpDir,
        env: {
          ...process.env,
          PATH: `${binDir}:/usr/bin:/bin`,
          ZVEC_TEST_LOG: logPath,
          ZVEC_TEST_STATUS_RC: "4",
        },
      })

      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /^zvec-context: skipped/m)
      assert.match(result.stdout, /ready index was not found/)
      const log = await fs.readFile(logPath, "utf8")
      assert.match(log, /status/)
      assert.doesNotMatch(log, /query/)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("runs one eventual semantic query with argv-safe scope", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const logPath = path.join(tmpDir, "zg.log")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir)

    try {
      const query = "where reviewer context is checked; no shell expansion"
      const result = await runHelper([
        "search",
        query,
        "--root",
        tmpDir,
        "--limit",
        "7",
        "--glob",
        "src/**",
        "--glob",
        "specs/**",
      ], {
        cwd: tmpDir,
        env: {
          ...process.env,
          PATH: `${binDir}:/usr/bin:/bin`,
          ZVEC_TEST_LOG: logPath,
        },
      })

      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /^zvec-context: ok/m)
      assert.match(result.stdout, /freshness-policy: eventual/)
      assert.match(result.stdout, /specs\/example\.md:10-14/)

      const log = await fs.readFile(logPath, "utf8")
      const realTmpDir = await fs.realpath(tmpDir)
      assert.match(log, new RegExp(`status\\n${realTmpDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n--mode\\ndirect\\n--check-ready`))
      assert.match(log, /query\n--hybrid\nwhere reviewer context is checked; no shell expansion/)
      assert.match(log, /--refresh\noff/)
      assert.match(log, /--preview\nshort/)
      assert.match(log, /--limit\n7/)
      assert.match(log, /--glob\nsrc\/\*\*/)
      assert.match(log, /--glob\nspecs\/\*\*/)
      assert.doesNotMatch(log, /--allow-remote/)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("runs the query from --root when the caller directory differs", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const caller = path.join(tmpDir, "caller directory")
    const root = path.join(tmpDir, "indexed workspace")
    const cwdLog = path.join(tmpDir, "query.cwd")
    await fs.mkdir(binDir)
    await fs.mkdir(caller)
    await fs.mkdir(root)
    await writeFakeZg(binDir)
    try {
      const result = await runHelper(["search", "query", "--root", root], {
        cwd: caller, timeout: 5000, killSignal: "SIGKILL",
        env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`,
          ZVEC_TEST_LOG: path.join(tmpDir, "zg.log"), ZVEC_TEST_CWD_LOG: cwdLog },
      })
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /^zvec-context: ok/m)
      assert.equal((await fs.readFile(cwdLog, "utf8")).trim(), await fs.realpath(root))
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("waits for freshness only when strict freshness is explicit", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const logPath = path.join(tmpDir, "zg.log")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir)

    try {
      const result = await runHelper([
        "search",
        "formal evidence for the current implementation",
        "--root",
        tmpDir,
        "--freshness",
        "strict",
      ], {
        cwd: tmpDir,
        env: {
          ...process.env,
          PATH: `${binDir}:/usr/bin:/bin`,
          ZVEC_TEST_LOG: logPath,
        },
      })

      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /freshness-policy: strict/)
      assert.match(await fs.readFile(logPath, "utf8"), /--refresh\nwait/)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("preserves a real zvec-grep query failure", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const logPath = path.join(tmpDir, "zg.log")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir)

    try {
      const result = await runHelper(["search", "failing query", "--root", tmpDir], {
        cwd: tmpDir,
        env: {
          ...process.env,
          PATH: `${binDir}:/usr/bin:/bin`,
          ZVEC_TEST_LOG: logPath,
          ZVEC_TEST_QUERY_RC: "7",
        },
      })

      assert.equal(result.code, 7)
      assert.match(result.stderr, /^zvec-context: error/m)
      assert.match(result.stderr, /query failed safely/)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  for (const mode of ["legacy", "modern-before-counter"]) {
    for (const handler of ["signal", "exit"]) {
      it(`keeps capture ownership during inherited ${handler} cleanup (${mode})`, async (t) => {
        if (mode === "modern-before-counter") {
          const capability = await execFileAsync("/bin/bash", ["-c", 'printf "%s" "${BASHPID:-}"'])
          if (!capability.stdout) { t.skip("Bash 3.2 uses the legacy subshell guard"); return }
        }
        const tmpDir = await makeTmpDir()
        const binDir = path.join(tmpDir, "bin")
        const scratch = path.join(tmpDir, "scratch")
        const bashEnv = path.join(tmpDir, "bash-env")
        await fs.mkdir(binDir)
        await fs.mkdir(scratch)
        await writeFakeZg(binDir)
        // M1/M2/M3: isolate the pre-counter PID guard, Bash 3.2 fallback,
        // and inherited EXIT cleanup instead of letting them mask each other.
        await fs.writeFile(bashEnv, `set -T
inherited_cleanup() {
  if [ "$BASH_SUBSHELL" -gt 0 ] && [[ "$1" == 'exec node '* ]]; then
    trap - DEBUG
    ${mode === "legacy" ? "unset BASHPID" : "BASH_SUBSHELL=0"}
    ${handler === "signal" ? "on_signal 15" : "cleanup_tmp"}
  fi
}
trap 'inherited_cleanup "$BASH_COMMAND"' DEBUG
`)
        try {
          const result = await runHelper(["search", "failing query", "--root", tmpDir], {
            cwd: tmpDir, timeout: 5000, killSignal: "SIGKILL",
            env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, BASH_ENV: bashEnv, TMPDIR: scratch,
              ZVEC_TEST_LOG: path.join(tmpDir, "zg.log"), ZVEC_TEST_QUERY_RC: "7" },
          })
          if (handler === "signal") {
            assert.equal(result.code, 0)
            assert.match(result.stdout, /zvec-context: skipped/)
            assert.equal(result.stderr, "", "a child signal must not delete its parent's capture")
          } else {
            assert.equal(result.code, 7, `${result.stdout}\n${result.stderr}`)
            assert.match(result.stderr, /query failed safely/)
            assert.doesNotMatch(result.stderr, /No such file/)
          }
          assert.deepEqual(await fs.readdir(scratch), [])
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true })
        }
      })
    }
  }

  it("preserves query errors across repeated bounded calls", { skip: process.env.BTRAIN_ZVEC_STRESS !== "1" }, async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const logPath = path.join(tmpDir, "zg.log")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir)
    const marker = String(7000 + process.pid % 2000)
    async function watchdogSleeps() {
      const ps = await execFileAsync("/bin/ps", ["-axo", "pid=,args="])
      return ps.stdout.split("\n").flatMap((line) => {
        const match = line.trim().match(new RegExp(`^(\\d+)\\s+sleep ${marker}$`))
        return match ? [Number(match[1])] : []
      })
    }
    const previousSleeps = new Set(await watchdogSleeps())
    try {
      // Short calls repeatedly stop the watchdog during its startup window.
      // Run small parallel batches to expose that window under CI scheduling.
      for (let batch = 0; batch < 10; batch += 1) {
        const results = await Promise.all(Array.from({ length: 10 }, () => runHelper(
          ["search", "failing query", "--root", tmpDir], {
            cwd: tmpDir,
            env: {
              ...process.env,
              PATH: `${binDir}:/usr/bin:/bin`,
              ZVEC_TEST_LOG: logPath,
              ZVEC_TEST_QUERY_RC: "7",
              ZVEC_CONTEXT_TIMEOUT: marker,
            },
            timeout: 5000,
          },
        )))
        for (const result of results) {
          assert.equal(result.code, 7, `${result.stdout}\n${result.stderr}`)
          assert.match(result.stderr, /query failed safely/)
          assert.doesNotMatch(result.stderr, /No such file/)
        }
      }
      assert.deepEqual((await watchdogSleeps()).filter((pid) => !previousSleeps.has(pid)), [], "stopped watchdogs must reap their sleepers")
    } finally {
      for (const pid of (await watchdogSleeps()).filter((pid) => !previousSleeps.has(pid))) {
        try { process.kill(pid, "SIGTERM") } catch (error) { if (error.code !== "ESRCH") throw error }
      }
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("rejects invalid limits and freshness policies before invoking zg", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const logPath = path.join(tmpDir, "zg.log")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir)
    try {
      for (const limit of ["0", "21", "007", "5x", "999999999999999999999999999999"]) {
        const badLimit = await runHelper(["search", "query", "--root", tmpDir, "--limit", limit], {
          cwd: tmpDir,
          env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, ZVEC_TEST_LOG: logPath },
        })
        assert.equal(badLimit.code, 64, `limit ${limit}: ${badLimit.stdout}`)
        assert.match(badLimit.stderr, /--limit must be an integer from 1 to 20/)
        assert.doesNotMatch(badLimit.stderr, /integer expression expected/)
        assert.doesNotMatch(badLimit.stdout, /zvec-context: (ok|skipped)/)
      }
      await assert.rejects(fs.access(logPath), "zg must not be invoked for an invalid --limit")

      const badFreshness = await runHelper(["search", "query", "--freshness", "latest"], {
        cwd: tmpDir,
        env: { ...process.env, PATH: "/usr/bin:/bin" },
      })
      assert.equal(badFreshness.code, 64)
      assert.match(badFreshness.stderr, /--freshness must be eventual or strict/)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("rejects hyphen-leading query and option values instead of forwarding them to zg", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const logPath = path.join(tmpDir, "zg.log")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir)
    try {
      for (const args of [
        ["search", "--refresh wait vs off", "--root", tmpDir],
        ["search", "-x", "--root", tmpDir],
        ["search", "query", "--root", tmpDir, "--glob", "-x"],
        ["search", "query", "--root", tmpDir, "--glob", "--allow-remote"],
        ["search", "query", "--root", tmpDir, "--limit", "-1"],
      ]) {
        const result = await runHelper(args, {
          cwd: tmpDir,
          env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, ZVEC_TEST_LOG: logPath },
        })
        assert.equal(result.code, 64, `${args.join(" ")}: ${result.stdout}`)
        assert.match(result.stderr, /must not start with -|requires a value that does not start with -/)
      }
      await assert.rejects(fs.access(logPath), "zg must not be invoked for hyphen-leading values")
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("reports a ready index under the zvec-context contract header", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const logPath = path.join(tmpDir, "zg.log")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir)
    try {
      const result = await runHelper(["status", "--root", tmpDir], {
        cwd: tmpDir,
        env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, ZVEC_TEST_LOG: logPath },
      })
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /^zvec-context: ok/m)
      assert.match(result.stdout, /^root: /m)
      assert.match(result.stdout, /Workspace index is ready/)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("soft-skips instead of blocking when zg exceeds the time bound", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const logPath = path.join(tmpDir, "zg.log")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir)
    try {
      const started = Date.now()
      const result = await runHelper(["search", "slow query", "--root", tmpDir, "--freshness", "strict"], {
        cwd: tmpDir,
        env: {
          ...process.env,
          PATH: `${binDir}:/usr/bin:/bin`,
          ZVEC_TEST_LOG: logPath,
          ZVEC_TEST_QUERY_SLEEP: "4",
          ZVEC_CONTEXT_TIMEOUT: "1",
        },
      })
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /^zvec-context: skipped/m)
      assert.match(result.stdout, /did not finish within 1s/)
      assert.ok(Date.now() - started < 10_000, "the bound must hold even when a zg descendant keeps stdout open")
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("escalates to KILL when zg ignores TERM", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const logPath = path.join(tmpDir, "zg.log")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir)
    try {
      const started = Date.now()
      const result = await runHelper(["search", "stubborn query", "--root", tmpDir], {
        cwd: tmpDir,
        env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, ZVEC_TEST_LOG: logPath, ZVEC_TEST_IGNORE_TERM: "20", ZVEC_CONTEXT_TIMEOUT: "1" },
      })
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /did not finish within 1s/)
      assert.doesNotMatch(result.stdout, /survived/)
      assert.ok(Date.now() - started < 10_000, "KILL must follow TERM within the grace period")
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("bounds the readiness probe too and validates the timeout for status", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const logPath = path.join(tmpDir, "zg.log")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir)
    try {
      const env = { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, ZVEC_TEST_LOG: logPath }
      const started = Date.now()
      const slowStatus = await runHelper(["status", "--root", tmpDir], {
        cwd: tmpDir, env: { ...env, ZVEC_TEST_STATUS_SLEEP: "4", ZVEC_CONTEXT_TIMEOUT: "1" },
      })
      assert.equal(slowStatus.code, 0, slowStatus.stderr)
      assert.match(slowStatus.stdout, /^zvec-context: skipped/m)
      assert.match(slowStatus.stdout, /zg status did not finish within 1s/)
      assert.equal(slowStatus.stderr, "", "a soft skip must leave stderr clean")

      const slowProbe = await runHelper(["search", "query", "--root", tmpDir], {
        cwd: tmpDir, env: { ...env, ZVEC_TEST_STATUS_SLEEP: "4", ZVEC_CONTEXT_TIMEOUT: "1" },
      })
      assert.equal(slowProbe.code, 0, slowProbe.stderr)
      assert.match(slowProbe.stdout, /zg status did not finish within 1s/)
      assert.equal(slowProbe.stderr, "", "no bash job diagnostic may leak onto stderr")
      assert.doesNotMatch(await fs.readFile(logPath, "utf8"), /query/)
      assert.ok(Date.now() - started < 15_000, "both probes must be cut short")

      for (const args of [["status", "--root", tmpDir], ["search", "query", "--root", tmpDir]]) {
        const bad = await runHelper(args, { cwd: tmpDir, env: { ...env, ZVEC_CONTEXT_TIMEOUT: "abc" } })
        assert.equal(bad.code, 64, `${args[0]}: ${bad.stdout}`)
        assert.match(bad.stderr, /ZVEC_CONTEXT_TIMEOUT must be an integer/)
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("does not mistake a real exit 143 from zg for a timeout", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const logPath = path.join(tmpDir, "zg.log")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir)
    try {
      const result = await runHelper(["search", "failing query", "--root", tmpDir], {
        cwd: tmpDir,
        env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, ZVEC_TEST_LOG: logPath, ZVEC_TEST_QUERY_RC: "143" },
      })
      assert.equal(result.code, 143)
      assert.match(result.stderr, /^zvec-context: error/m)
      assert.match(result.stderr, /query failed safely/)
      assert.doesNotMatch(result.stdout, /skipped/)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("soft-skips with a clear reason when no temp file can be created", async (t) => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      t.skip("root ignores directory modes")
      return
    }
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const readOnly = path.join(tmpDir, "ro")
    const logPath = path.join(tmpDir, "zg.log")
    await fs.mkdir(binDir)
    await fs.mkdir(readOnly, { mode: 0o500 })
    await writeFakeZg(binDir)
    try {
      for (const args of [["search", "query", "--root", tmpDir], ["status", "--root", tmpDir]]) {
        const result = await runHelper(args, {
          cwd: tmpDir,
          env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, ZVEC_TEST_LOG: logPath, TMPDIR: readOnly },
        })
        assert.equal(result.code, 0, `${args[0]}: ${result.stderr}`)
        assert.match(result.stdout, /^zvec-context: skipped/m)
        assert.match(result.stdout, /could not create a temp file/)
        assert.doesNotMatch(result.stderr, /mktemp/)
      }
    } finally {
      await fs.chmod(readOnly, 0o700)
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("removes its temp files when the helper itself is killed mid-call", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const scratch = path.join(tmpDir, "scratch")
    const logPath = path.join(tmpDir, "zg.log")
    await fs.mkdir(binDir)
    await fs.mkdir(scratch)
    await writeFakeZg(binDir)
    try {
      const { spawn } = await import("node:child_process")
      const child = spawn("/bin/bash", [HELPER_PATH, "status", "--root", tmpDir], {
        cwd: tmpDir,
        env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, ZVEC_TEST_LOG: logPath, ZVEC_TEST_STATUS_SLEEP: "30", ZVEC_CONTEXT_TIMEOUT: "60", TMPDIR: scratch },
        stdio: "ignore",
      })
      await new Promise((resolve) => setTimeout(resolve, 1000))
      assert.ok((await fs.readdir(scratch)).some((name) => name.startsWith("zvec-context.")), "temp file should exist while zg runs")
      child.kill("SIGINT")
      const code = await new Promise((resolve) => child.on("exit", resolve))
      assert.equal(code, 130, "SIGINT must exit 128+2")
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.deepEqual(await fs.readdir(scratch), [], "temp files must be removed on a signal")
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("leaves no watchdog sleep behind after a fast call", async () => {
    const tmpDir = await makeTmpDir()
    const binDir = path.join(tmpDir, "bin")
    const logPath = path.join(tmpDir, "zg.log")
    await fs.mkdir(binDir)
    await writeFakeZg(binDir)
    try {
      const marker = "7351"
      const result = await runHelper(["search", "fast query", "--root", tmpDir], {
        cwd: tmpDir,
        env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, ZVEC_TEST_LOG: logPath, ZVEC_CONTEXT_TIMEOUT: marker },
      })
      assert.equal(result.code, 0, result.stderr)
      const ps = await execFileAsync("/bin/ps", ["-axo", "command"])
      assert.doesNotMatch(ps.stdout, new RegExp(`^sleep ${marker}$`, "m"), "watchdog sleep must be reaped")
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
