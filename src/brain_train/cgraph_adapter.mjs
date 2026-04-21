/**
 * cgraph_adapter.mjs — btrain ↔ cgraph integration adapter
 *
 * Single integration point between btrain lane workflows and cgraph.
 * CLI-first, fail-open, optional.
 *
 * Design constraints (from Spec 005):
 *   - btrain owns all lane state and workflow-state writes
 *   - cgraph is a pure analysis service, never parses HANDOFF_*.md
 *   - If cgraph is missing, slow, or broken, btrain continues with degraded messaging
 *   - Daemon is an optimization, not a prerequisite
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs/promises"
import path from "node:path"
import net from "node:net"

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Timeout budgets (ms) — tuned for interactive lane workflows
// ---------------------------------------------------------------------------
const TIMEOUTS = {
  manifest:       3_000,
  blast_radius:   2_000,
  review_packet:  5_000,
  audit:         15_000,
  advise:           200,
  drift_check:    2_000,
  sync_check:     5_000,
  health:         5_000,
}
const DEFAULT_TIMEOUT = 10_000
const DAEMON_CONNECT_TIMEOUT = 1_000
const STDERR_MAX_CHARS = 500
const MAX_BUFFER = 10 * 1024 * 1024 // 10 MB

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the cgraph binary path.
 *   1. [cgraph].bin_path from project config
 *   2. "cgc" on PATH
 *   3. Compatibility fallbacks: "cgraph", "kkg", "codegraphcontext"
 */
async function resolveBinary(config) {
  const cgraphConfig = config?.cgraph || {}

  if (cgraphConfig.bin_path) {
    if (await isExecutable(cgraphConfig.bin_path)) {
      return cgraphConfig.bin_path
    }
    return null
  }

  for (const name of ["cgc", "cgraph", "kkg", "codegraphcontext"]) {
    const resolved = await whichBinary(name)
    if (resolved) return resolved
  }

  return null
}

async function whichBinary(name) {
  try {
    const { stdout } = await execFileAsync("which", [name], { timeout: 2_000 })
    const p = stdout.trim()
    return p || null
  } catch {
    return null
  }
}

async function isExecutable(filePath) {
  try {
    await fs.access(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Manifest probe — discover available commands
// ---------------------------------------------------------------------------

/** @returns {import("./cgraph_adapter.mjs").AdapterResult} */
async function probeManifest(binPath, project) {
  const args = ["manifest", "--json"]
  if (project) args.push("--project", project)
  return execCommand(binPath, args, "manifest")
}

/**
 * Check whether a specific command is available in the manifest.
 * @param {object} manifest - Parsed manifest payload
 * @param {string} commandName - Command to check (e.g. "review-packet")
 */
function hasCommand(manifest, commandName) {
  if (!manifest?.commands) return false
  return manifest.commands.some((c) => c.name === commandName)
}

// ---------------------------------------------------------------------------
// Daemon communication
// ---------------------------------------------------------------------------

const DEFAULT_SOCKET = path.join(
  process.env.HOME || "/tmp",
  ".cache", "cgraph", "ipc.sock",
)

/**
 * Try to send a command to the warm daemon via Unix socket.
 * Returns null if the daemon is unreachable (fail-open).
 */
async function tryDaemon(socketPath, command, args) {
  socketPath = socketPath || DEFAULT_SOCKET

  return new Promise((resolve) => {
    const client = net.createConnection({ path: socketPath }, () => {
      const request = JSON.stringify({ command, args })
      client.write(request + "\n")
    })

    let data = ""
    const timer = setTimeout(() => {
      client.destroy()
      resolve(null) // fail-open on timeout
    }, DAEMON_CONNECT_TIMEOUT)

    client.on("data", (chunk) => { data += chunk.toString() })
    client.on("end", () => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(data))
      } catch {
        resolve(null)
      }
    })
    client.on("error", () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

// ---------------------------------------------------------------------------
// Command execution — daemon-first with subprocess fallback
// ---------------------------------------------------------------------------

/**
 * Execute a cgraph command. Tries daemon first, falls back to subprocess.
 *
 * @param {string} binPath - Resolved cgraph binary path
 * @param {string[]} args - CLI arguments (e.g. ["audit", "--scope", "lane"])
 * @param {string} kind - Command kind for timeout lookup
 * @param {object} [opts]
 * @param {string} [opts.socketPath] - Override daemon socket path
 * @param {boolean} [opts.skipDaemon] - Force subprocess-only
 * @param {string} [opts.cwd] - Working directory
 * @param {object} [opts.env] - Extra environment variables
 * @returns {AdapterResult}
 */
async function execCommand(binPath, args, kind, opts = {}) {
  const timeout = TIMEOUTS[kind] || DEFAULT_TIMEOUT
  const start = Date.now()

  // Try daemon first unless skipped
  if (!opts.skipDaemon) {
    const daemonResult = await tryDaemon(opts.socketPath, args[0], args.slice(1))
    if (daemonResult !== null) {
      const latency = Date.now() - start
      const ok = daemonResult.ok !== false
      return {
        ok,
        kind,
        payload: daemonResult,
        timed_out: false,
        unavailable: false,
        stderr_summary: "",
        latency_ms: latency,
        source: "daemon",
      }
    }
  }

  // Subprocess fallback
  try {
    const { stdout, stderr } = await execFileAsync(binPath, args, {
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, ...opts.env },
      timeout,
      maxBuffer: MAX_BUFFER,
    })

    const latency = Date.now() - start
    let payload = null
    try {
      payload = JSON.parse(stdout)
    } catch {
      // stdout wasn't valid JSON
    }

    // Malformed stdout (no parseable JSON) is a failure, not ok
    const ok = payload !== null && payload.ok !== false
    return {
      ok,
      kind,
      payload,
      timed_out: false,
      unavailable: false,
      stderr_summary: (stderr || "").slice(0, STDERR_MAX_CHARS),
      latency_ms: latency,
      source: "subprocess",
    }
  } catch (error) {
    const latency = Date.now() - start
    const timedOut = error.killed || /timed out/i.test(error.message || "")

    // Try to parse stdout even on non-zero exit (cgraph returns JSON on command failures)
    let payload = null
    if (error.stdout) {
      try { payload = JSON.parse(error.stdout) } catch { /* ignore */ }
    }

    // unavailable = binary not found (ENOENT) or spawn failure, NOT a non-zero exit
    // Non-zero exit with valid JSON payload is a normal command failure (e.g. audit hard violations)
    const isSpawnFailure = error.code === "ENOENT" || error.code === "EACCES"
    return {
      ok: false,
      kind,
      payload,
      timed_out: timedOut,
      unavailable: isSpawnFailure,
      stderr_summary: (error.stderr || error.message || "").slice(0, STDERR_MAX_CHARS),
      latency_ms: latency,
      source: "subprocess",
    }
  }
}

// ---------------------------------------------------------------------------
// High-level adapter API
// ---------------------------------------------------------------------------

/**
 * Create an adapter instance bound to a repo.
 *
 * @param {string} repoRoot - Absolute path to the repo
 * @param {object} config - Parsed .btrain/project.toml config
 * @returns {CgraphAdapter | null} - null if cgraph is not available
 */
async function createAdapter(repoRoot, config) {
  const cgraphConfig = config?.cgraph || {}
  if (cgraphConfig.enabled === false) return null

  const binPath = await resolveBinary(config)
  if (!binPath) return null

  const manifestResult = await probeManifest(binPath, cgraphConfig.project)
  if (!manifestResult.ok) return null

  return new CgraphAdapter(repoRoot, config, binPath, manifestResult.payload)
}

class CgraphAdapter {
  constructor(repoRoot, config, binPath, manifest) {
    this.repoRoot = repoRoot
    this.config = config
    this.cgraphConfig = config?.cgraph || {}
    this.binPath = binPath
    this.manifest = manifest
    this._socketPath = this.cgraphConfig.socket_path || DEFAULT_SOCKET
  }

  // ---- Capability checks ----

  supports(commandName) {
    return hasCommand(this.manifest, commandName)
  }

  // ---- Core commands ----

  async blastRadius(files, laneId, locksJson = null) {
    const args = ["blast-radius", "--files", files.join(",")]
    if (laneId) args.push("--lane", laneId)
    if (locksJson) args.push("--locks-json", JSON.stringify(locksJson))
    return this._exec(args, "blast_radius")
  }

  async reviewPacket(opts = {}) {
    const args = ["review-packet"]
    if (opts.base) args.push("--base", opts.base)
    if (opts.head) args.push("--head", opts.head)
    if (opts.files?.length) args.push("--files", opts.files.join(","))
    if (opts.maxNodes) args.push("--max-nodes", String(opts.maxNodes))
    if (opts.project) args.push("--project", opts.project)
    return this._exec(args, "review_packet")
  }

  async audit(opts = {}) {
    const args = ["audit", "--format", "json"]
    if (opts.scope) args.push("--scope", opts.scope)
    if (opts.files?.length) args.push("--files", opts.files.join(","))
    if (opts.profile) args.push("--profile", opts.profile)
    if (opts.requireHardZero) args.push("--require-hard-zero")
    if (opts.project) args.push("--project", opts.project)
    return this._exec(args, "audit")
  }

  async advise(situation, laneId, context = null) {
    const args = ["advise", situation]
    if (context && typeof context === "object" && !Array.isArray(context) && Object.keys(context).length > 0) {
      args.push("--context", JSON.stringify(context))
    }
    if (laneId) args.push("--lane", laneId)
    return this._exec(args, "advise")
  }

  async driftCheck(opts = {}, legacyLaneId = "", legacySince = "") {
    const normalized = Array.isArray(opts)
      ? { files: opts, laneId: legacyLaneId, since: legacySince }
      : (opts || {})
    const args = ["drift-check"]
    if (normalized.files?.length) args.push("--files", normalized.files.join(","))
    if (normalized.since) args.push("--since", normalized.since)
    if (normalized.laneId) args.push("--lane", normalized.laneId)
    return this._exec(args, "drift_check")
  }

  async syncCheck(opts = {}) {
    const args = ["sync-check"]
    if (opts.sourceDir) args.push("--source-dir", String(opts.sourceDir))
    return this._exec(args, "sync_check")
  }

  async health() {
    return this._exec(["health"], "health")
  }

  // ---- Artifact persistence ----

  /**
   * Persist a review-packet artifact for a lane's needs-review transition.
   * Returns the relative artifact path or null on failure.
   */
  async persistReviewPacket(laneId, payload) {
    return this._persistArtifact("review-packets", laneId, payload)
  }

  /**
   * Persist an audit summary artifact for a lane's needs-review transition.
   * Returns the relative artifact path or null on failure.
   */
  async persistAuditSummary(laneId, payload) {
    return this._persistArtifact("audits", laneId, payload)
  }

  /**
   * Build the structured event metadata object for a handoff event.
   * @param {object} results - { reviewPacket, audit, blastRadius }
   * @param {string} graphMode - e.g. "working/a", "shared-working"
   * @returns {object} - Event metadata conforming to adapter-event-metadata.json
   */
  buildEventMetadata(results, graphMode) {
    const meta = { status: "ok", latency_ms: {} }

    if (results.reviewPacket) {
      const r = results.reviewPacket
      if (r.unavailable || r.timed_out) {
        meta.status = "degraded"
        meta.degraded_reason = r.timed_out ? "review-packet timed out" : "review-packet unavailable"
      } else if (r.ok && r.payload) {
        meta.review_packet = {
          path: results.reviewPacketArtifact || "",
          source: r.payload.source || "unknown",
          touched_nodes: Array.isArray(r.payload.touched_nodes) ? r.payload.touched_nodes.length : 0,
          advisory_count: Array.isArray(r.payload.advisories) ? r.payload.advisories.length : 0,
          truncated: r.payload.truncated || false,
        }
      }
      meta.latency_ms.review_packet = r.latency_ms
    }

    if (results.audit) {
      const a = results.audit
      if (a.ok && a.payload) {
        meta.audit = {
          path: results.auditArtifact || "",
          warn: a.payload.counts?.warn || 0,
          hard: a.payload.counts?.hard || 0,
          standards_evaluated: a.payload.standards_evaluated || 0,
        }
      } else if (!a.ok && meta.status === "ok") {
        meta.status = "degraded"
        meta.degraded_reason = a.timed_out ? "audit timed out" : "audit failed"
      }
      meta.latency_ms.audit = a.latency_ms
    }

    if (results.blastRadius) {
      const b = results.blastRadius
      if (b.ok && b.payload?.summary) {
        meta.blast_radius = {
          nodes_in_scope: b.payload.summary.nodes_in_scope || 0,
          transitive_callers: b.payload.summary.transitive_callers || 0,
          transitive_callees: b.payload.summary.transitive_callees || 0,
          lock_overlaps: b.payload.summary.lock_overlaps || 0,
        }
      }
      meta.latency_ms.blast_radius = b.latency_ms
    }

    if (Array.isArray(results.freshAdvisories) && results.freshAdvisories.length > 0) {
      meta.fresh_advisories = results.freshAdvisories
    }

    if (Array.isArray(results.resolvedAdvisories) && results.resolvedAdvisories.length > 0) {
      meta.resolved_advisories = results.resolvedAdvisories
    }

    if (graphMode) meta.graph_mode = graphMode

    return meta
  }

  // ---- Doctor / health summary ----

  /**
   * Produce a compact health summary for `btrain doctor`.
   * Does NOT require KùzuDB access.
   */
  async doctorSummary() {
    const issues = []
    const info = []

    info.push(`cgraph binary: ${this.binPath}`)
    info.push(`commands: ${this.manifest.total_commands}`)
    if (this.cgraphConfig.project) {
      info.push(`project: ${this.cgraphConfig.project}`)
    }
    if (this.cgraphConfig.source_checkout) {
      try {
        await fs.access(this.cgraphConfig.source_checkout)
        info.push(`source checkout: ${this.cgraphConfig.source_checkout}`)
      } catch {
        issues.push(`source checkout missing: ${this.cgraphConfig.source_checkout}`)
      }
    }

    // Check daemon reachability
    const daemonResult = await tryDaemon(this._socketPath, "ping", [])
    if (daemonResult) {
      info.push("daemon: reachable")
    } else {
      info.push("daemon: not running (subprocess fallback active)")
    }

    // Check artifact directory is writable
    const artifactRoot = path.join(this.repoRoot, ".btrain", "artifacts", "cgraph")
    try {
      await fs.mkdir(artifactRoot, { recursive: true })
      info.push("artifact dir: writable")
    } catch {
      issues.push(`artifact dir not writable: ${artifactRoot}`)
    }

    if (this.supports("sync-check")) {
      const syncResult = await this.syncCheck({ sourceDir: this.cgraphConfig.source_checkout })
      if (syncResult.ok && syncResult.payload) {
        if (syncResult.payload.skipped) {
          info.push(`sync-check: skipped (${syncResult.payload.reason || "not applicable"})`)
        } else {
          info.push(`upstream lag: ${Number(syncResult.payload.behind_by) || 0} commit(s)`)
          if (Array.isArray(syncResult.payload.new_commits) && syncResult.payload.new_commits.length > 0) {
            const latestCommit = syncResult.payload.new_commits[0]
            info.push(`latest upstream commit: ${latestCommit.subject || latestCommit.sha || "(unknown)"}`)
          }
        }
      } else if (syncResult.timed_out) {
        issues.push("sync-check timed out")
      } else if (!syncResult.unavailable) {
        issues.push("sync-check failed")
      }
    }

    return { ok: issues.length === 0, issues, info }
  }

  // ---- Startup summary ----

  /**
   * Produce a compact cgraph summary for `btrain startup`.
   * Returns null if nothing notable to report.
   */
  async startupSummary() {
    const lines = []

    // Quick health check
    const healthResult = this.supports("health") ? await this.health() : null
    if (healthResult?.ok && healthResult.payload) {
      const grade = healthResult.payload.grade
      if (grade) lines.push(`graph health: ${grade}`)
      if (healthResult.payload.stale_index) {
        lines.push("⚠ graph index may be stale")
      }
    }

    if (this.supports("sync-check")) {
      const syncResult = await this.syncCheck({ sourceDir: this.cgraphConfig.source_checkout })
      if (syncResult?.ok && syncResult.payload) {
        if (syncResult.payload.skipped) {
          lines.push(`sync-check: skipped (${syncResult.payload.reason || "not applicable"})`)
        } else {
          const behindBy = Number(syncResult.payload.behind_by) || 0
          const upstream = syncResult.payload.upstream || "upstream"
          lines.push(
            behindBy > 0
              ? `sync-check: ${behindBy} commit${behindBy === 1 ? "" : "s"} behind ${upstream}`
              : `sync-check: up to date with ${upstream}`,
          )
        }
      } else if (syncResult && !syncResult.ok) {
        lines.push("sync-check: unavailable")
      }
    }

    return lines.length > 0 ? lines : null
  }

  // ---- Internal helpers ----

  async _exec(args, kind) {
    const project = this.cgraphConfig.project
    if (project && !args.includes("--project")) {
      args.push("--project", project)
    }
    return execCommand(this.binPath, args, kind, {
      socketPath: this._socketPath,
      cwd: this.repoRoot,
    })
  }

  async _persistArtifact(category, laneId, payload) {
    if (!payload) return null
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1)
      const dir = path.join(
        this.repoRoot, ".btrain", "artifacts", "cgraph",
        category, `lane-${laneId}`,
      )
      await fs.mkdir(dir, { recursive: true })
      const filename = `${ts}-needs-review.json`
      const filePath = path.join(dir, filename)
      await fs.writeFile(filePath, JSON.stringify(payload, null, 2))
      return path.relative(this.repoRoot, filePath)
    } catch {
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: fail-open wrapper for integration points
// ---------------------------------------------------------------------------

/**
 * Run an adapter operation, returning a degraded result on any failure.
 * Never throws. btrain commands should wrap cgraph calls in this.
 */
async function failOpen(fn) {
  try {
    return await fn()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  CgraphAdapter,
  createAdapter,
  execCommand,
  failOpen,
  hasCommand,
  probeManifest,
  resolveBinary,
  tryDaemon,
  // Constants for testing
  DEFAULT_TIMEOUT,
  DAEMON_CONNECT_TIMEOUT,
  STDERR_MAX_CHARS,
  TIMEOUTS,
}

/**
 * @typedef {object} AdapterResult
 * @property {boolean} ok
 * @property {string} kind
 * @property {object|null} payload
 * @property {boolean} timed_out
 * @property {boolean} unavailable
 * @property {string} stderr_summary
 * @property {number} latency_ms
 * @property {"daemon"|"subprocess"} source
 */
