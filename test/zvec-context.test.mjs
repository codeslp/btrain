import assert from "node:assert/strict"
import { execFile } from "node:child_process"
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
    const result = await execFileAsync("/bin/bash", [HELPER_PATH, ...args], {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 1024 * 1024,
    })
    return { code: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || "",
    }
  }
}

async function writeFakeZg(binDir) {
  const fakePath = path.join(binDir, "zg")
  await fs.writeFile(fakePath, `#!/usr/bin/env bash
set -u
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
