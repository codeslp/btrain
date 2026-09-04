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
    try {
      const badLimit = await runHelper(["search", "query", "--limit", "0"], {
        cwd: tmpDir,
        env: { ...process.env, PATH: "/usr/bin:/bin" },
      })
      assert.equal(badLimit.code, 64)
      assert.match(badLimit.stderr, /--limit must be an integer from 1 to 20/)

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
})
