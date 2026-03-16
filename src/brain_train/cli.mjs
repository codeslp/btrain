#!/usr/bin/env node

import path from "node:path"
import {
  acquireLocks,
  checkHandoff,
  claimHandoff,
  doctor,
  forceReleaseLock,
  getBrainTrainHome,
  getReviewStatus,
  getStatus,
  initRepo,
  installPreCommitHook,
  listLocks,
  listRepos,
  patchHandoff,
  registerRepo,
  releaseLocks,
  resolveHandoff,
  resolveRepoRoot,
  runReview,
  runLoop,
  syncTemplates,
} from "./core.mjs"

function printHelp() {
  console.log(`btrain

Usage:
  btrain init <repo-path> [--hooks]                                              Bootstrap a repo (--hooks installs pre-commit guard)
  btrain handoff [--repo <path>]                                                 Check whose turn it is and what to do
  btrain handoff claim --task <text> --owner <name> --reviewer <name> [options] Claim a new task
  btrain handoff update [options]                                                Update the current handoff state
  btrain handoff resolve [--summary <text>] [--next <text>] [--actor <name>]    Resolve the current handoff
  btrain loop [--repo <path>] [--dry-run] [--max-rounds <n>] [--timeout <sec>]  Relay handoffs between configured agent runners
  btrain review run [--repo <path>] [--mode <manual|parallel|hybrid>] [--base <ref>]   Run the configured review workflow
  btrain review status [--repo <path>]                                           Show review mode and latest review artifact
  btrain locks [--repo <path>]                                                   List all active file locks
  btrain locks release --path <path> [--repo <path>]                             Force-release a file lock
  btrain locks release-lane --lane <id> [--repo <path>]                          Release all locks for a lane
  btrain register <repo-path>                                                    Register an existing repo without bootstrapping it
  btrain sync-templates [--repo <path>] [--dry-run]                              Sync managed AGENTS/CLAUDE blocks from templates
  btrain status [--repo <path>]                                                  Show handoff state across repos
  btrain doctor [--repo <path>]                                                  Check registry and repo health
  btrain hooks [--repo <path>]                                                   Install the pre-commit guard hook
  btrain dashboard [--port <number>]                                              Open a live lane monitor in your browser
  btrain repos                                                                   List registered repos

Handoff/Lane Options:
  --lane <id>       Target a specific lane (a, b). Auto-selects if omitted.
  --files <list>    Comma-separated list of files/dirs to lock for this lane.

Environment:
  BRAIN_TRAIN_HOME overrides the default global directory (~/.brain_train).

Notes:
  - \`init\` is safe to re-run. It only updates the managed btrain blocks.
  - \`handoff claim\` resets the reviewer context and review response sections for a new task.
  - Use \`handoff claim|update|resolve\` to keep handoff headers consistent.
  - \`loop\` uses \`[agents.runners]\` in \`.btrain/project.toml\` and dispatches the prompt \`bth\`.
  - \`review run\` automates \`parallel\` and \`hybrid\` modes. \`manual\` mode reports a no-op.
  - \`sync-templates\` only updates the managed blocks in \`AGENTS.md\` and \`CLAUDE.md\`.
  - When \`[lanes]\` is configured in project.toml, agents can work concurrently on separate lanes.
`)
}

function parseOptions(args) {
  const options = { _: [] }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token.startsWith("--")) {
      options._.push(token)
      continue
    }

    const key = token.slice(2)
    const nextToken = args[index + 1]
    if (!nextToken || nextToken.startsWith("--")) {
      options[key] = true
      continue
    }

    options[key] = nextToken
    index += 1
  }

  return options
}

function formatRepoStatus(status) {
  const updatedLine = status.staleness
    ? `${status.current.lastUpdated || "(unknown)"} ${status.staleness.label}`
    : `${status.current.lastUpdated || "(unknown)"}`

  const lines = [
    `- ${status.name}`,
    `  path: ${status.path}`,
  ]

  if (status.lanes) {
    for (const lane of status.lanes) {
      lines.push(`  lane ${lane._laneId}: ${lane.status} — ${lane.task || "(no task)"}${lane.owner ? ` (${lane.owner})` : ""}`)
    }
    if (status.locks && status.locks.length > 0) {
      lines.push(`  locks: ${status.locks.map((l) => `${l.lane}:${l.path}`).join(", ")}`)
    }
  } else {
    lines.push(`  task: ${status.current.task || "(none)"}`)
    lines.push(`  owner: ${status.current.owner || "(unassigned)"}`)
    lines.push(`  reviewer: ${status.current.reviewer || "(unassigned)"}`)
    lines.push(`  review mode: ${status.current.reviewMode || "manual"}`)
    lines.push(`  status: ${status.current.status || "(unknown)"}`)
    lines.push(`  next: ${status.current.nextAction || "(none)"}`)
  }

  lines.push(`  updated: ${updatedLine}`)
  lines.push(`  handoffs: ${status.previousHandoffs ?? 0}`)
  lines.push(`  drift: ${status.templateDrift ? (status.templateDrift.any ? "yes" : "no") : "unknown"}`)

  return lines.join("\n")
}

function formatDoctorResult(result) {
  const lines = [
    `- ${result.repoRoot}`,
    `  healthy: ${result.healthy ? "yes" : "no"}`,
  ]

  if (result.issues.length > 0) {
    lines.push(`  issues: ${result.issues.join(" | ")}`)
  }

  if (result.warnings.length > 0) {
    lines.push(`  warnings: ${result.warnings.join(" | ")}`)
  }

  if (result.issues.length === 0 && result.warnings.length === 0) {
    lines.push("  notes: no issues detected")
  }

  return lines.join("\n")
}

function formatSyncResult(result) {
  const lines = [
    `- ${result.name}`,
    `  path: ${result.path}`,
    `  status: ${result.status}`,
  ]

  if (result.reason) {
    lines.push(`  reason: ${result.reason}`)
  }

  for (const fileResult of result.files) {
    lines.push(`  ${path.basename(fileResult.path)}: ${fileResult.status}`)
    if (fileResult.reason) {
      lines.push(`  ${path.basename(fileResult.path)} reason: ${fileResult.reason}`)
    }
  }

  return lines.join("\n")
}

function summarizeError(errorText) {
  if (!errorText) {
    return ""
  }

  return errorText
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || ""
}

function formatReviewRunResult(result) {
  const lines = [
    `repo: ${result.repoName}`,
    `path: ${result.repoRoot}`,
    `mode: ${result.mode} (${result.modeSource})`,
    `status: ${result.status}`,
    `base: ${result.base}`,
    `head: ${result.head}`,
  ]

  if (result.status === "skipped") {
    lines.push("reason: manual review mode does not launch automation")
    return lines.join("\n")
  }

  if (result.artifact) {
    lines.push(`report: ${result.artifact.reportPath}`)
    lines.push(`metadata: ${result.artifact.metadataPath}`)
    lines.push(`started: ${result.artifact.startedAt}`)
    lines.push(`completed: ${result.artifact.completedAt}`)
    if (result.artifact.error) {
      lines.push(`error: ${summarizeError(result.artifact.error)}`)
    }
  }

  return lines.join("\n")
}

function formatReviewStatus(result) {
  const lines = [
    `repo: ${result.repoName}`,
    `path: ${result.repoRoot}`,
    `handoff mode: ${result.handoffMode}`,
    `effective mode: ${result.mode} (${result.modeSource})`,
    `parallel enabled: ${result.reviewConfig.parallelEnabled ? "yes" : "no"}`,
    `sequential enabled: ${result.reviewConfig.sequentialEnabled ? "yes" : "no"}`,
    `sequential triggers: ${
      result.reviewConfig.sequentialTriggers.length > 0
        ? result.reviewConfig.sequentialTriggers.join(", ")
        : "(none)"
    }`,
    `review runs: ${result.runCount}`,
  ]

  if (!result.latest) {
    lines.push("latest run: none")
    return lines.join("\n")
  }

  lines.push(`latest run: ${result.latest.status}`)
  lines.push(`latest report: ${result.latest.reportPath}`)
  lines.push(`latest metadata: ${result.latest.metadataPath}`)
  lines.push(`latest started: ${result.latest.startedAt}`)
  lines.push(`latest completed: ${result.latest.completedAt}`)
  lines.push(`latest base: ${result.latest.base}`)
  lines.push(`latest head: ${result.latest.head}`)
  if (result.latest.error) {
    lines.push(`latest error: ${summarizeError(result.latest.error)}`)
  }

  return lines.join("\n")
}

function formatLoopResult(result) {
  return [
    `repo: ${result.repoName}`,
    `path: ${result.repoRoot}`,
    `status: ${result.status}`,
    `initial handoff: ${result.initialCurrent.status}`,
    `final handoff: ${result.finalCurrent.status}`,
    `rounds: ${result.roundsCompleted}/${result.maxRounds}`,
    `dispatches: ${result.history.length}`,
    `reason: ${result.stopReason}`,
  ].join("\n")
}

function printHandoffState(result) {
  console.log(`repo: ${result.repoName}`)

  if (result.lanes) {
    // Multi-lane output
    for (const lane of result.lanes) {
      console.log("")
      console.log(`--- lane ${lane._laneId} ---`)
      console.log(`task: ${lane.task || "(none)"}`)
      console.log(`status: ${lane.status}`)
      console.log(`owner: ${lane.owner || "(unassigned)"}`)
      console.log(`reviewer: ${lane.reviewer || "(unassigned)"}`)
      console.log(`mode: ${lane.reviewMode || "manual"}`)
      console.log(`next: ${lane.nextAction || "(none)"}`)
    }
    if (result.locks && result.locks.length > 0) {
      console.log("")
      console.log("active locks:")
      for (const lock of result.locks) {
        console.log(`  lane ${lock.lane}: ${lock.path} (${lock.owner})`)
      }
    }
  } else {
    // Single-lane output
    console.log(`task: ${result.current.task || "(none)"}`)
    console.log(`status: ${result.current.status}`)
    console.log(`owner: ${result.current.owner || "(unassigned)"}`)
    console.log(`reviewer: ${result.current.reviewer || "(unassigned)"}`)
    console.log(`mode: ${result.current.reviewMode || "manual"}`)
    console.log(`next: ${result.current.nextAction || "(none)"}`)
  }

  console.log("")
  console.log(result.guidance)
  console.log("")
  console.log(`handoff file: ${result.handoffPath}`)
}

async function run() {
  const [, , command, ...rest] = process.argv

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp()
    return
  }

  if (command === "init") {
    const options = parseOptions(rest)
    const targetPath = options._[0]
    if (!targetPath) {
      throw new Error("`btrain init` requires a repo path.")
    }

    const result = await initRepo(targetPath, { hooks: !!options.hooks })
    console.log(`Initialized ${result.repoName}`)
    console.log(`repo: ${result.repoRoot}`)
    console.log(`home: ${result.homeDir}`)
    console.log(`handoff: ${result.repoPaths.handoffPath}`)

    if (result.hookResult) {
      if (result.hookResult.installed) {
        console.log(`pre-commit hook: ${result.hookResult.reason}`)
      } else if (result.hookResult.reason === "existing-hook") {
        console.log("pre-commit hook: skipped (existing hook found — use `btrain hooks` to install manually)")
      } else if (result.hookResult.reason === "not-a-git-repo") {
        console.log("pre-commit hook: skipped (not a git repo)")
      }
    }
    return
  }

  if (command === "handoff") {
    const subcommand = ["claim", "update", "resolve"].includes(rest[0]) ? rest[0] : null
    const options = parseOptions(subcommand ? rest.slice(1) : rest)

    if (options.help || options.h) {
      printHelp()
      return
    }

    const repoRoot = await resolveRepoRoot(options.repo)

    if (subcommand === "claim") {
      await claimHandoff(repoRoot, options)
      const result = await checkHandoff(repoRoot)
      printHandoffState(result)
      return
    }

    if (subcommand === "update") {
      await patchHandoff(repoRoot, options)
      const result = await checkHandoff(repoRoot)
      printHandoffState(result)
      return
    }

    if (subcommand === "resolve") {
      await resolveHandoff(repoRoot, options)
      const result = await checkHandoff(repoRoot)
      printHandoffState(result)
      return
    }

    const result = await checkHandoff(repoRoot)
    printHandoffState(result)
    return
  }

  if (command === "register") {
    const options = parseOptions(rest)
    const targetPath = options._[0]
    if (!targetPath) {
      throw new Error("`btrain register` requires a repo path.")
    }

    const result = await registerRepo(targetPath)
    console.log(`Registered ${result.repoName}`)
    console.log(`repo: ${result.repoRoot}`)
    console.log(`home: ${result.homeDir}`)
    if (result.warnings.length > 0) {
      console.log("warnings:")
      for (const warning of result.warnings) {
        console.log(`- ${warning}`)
      }
    }
    return
  }

  if (command === "review") {
    const subcommand = ["run", "status"].includes(rest[0]) ? rest[0] : null
    if (!subcommand) {
      throw new Error("`btrain review` requires a subcommand: run or status.")
    }

    const options = parseOptions(rest.slice(1))
    const repoRoot = await resolveRepoRoot(options.repo)

    if (subcommand === "run") {
      const result = await runReview({
        repoRoot,
        mode: options.mode,
        base: options.base,
        head: options.head,
      })
      console.log(formatReviewRunResult(result))
      if (result.status === "failed") {
        process.exitCode = 1
      }
      return
    }

    const result = await getReviewStatus(repoRoot)
    console.log(formatReviewStatus(result))
    return
  }

  if (command === "loop") {
    const options = parseOptions(rest)
    const repoRoot = await resolveRepoRoot(options.repo)
    const result = await runLoop({
      repoRoot,
      dryRun: !!options["dry-run"],
      maxRounds: options["max-rounds"],
      timeout: options.timeout,
      pollInterval: options["poll-interval"],
      onEvent: (line) => console.log(line),
    })
    console.log("")
    console.log(formatLoopResult(result))
    if (result.status === "failed" || result.status === "timed-out" || result.status === "max-rounds-exceeded") {
      process.exitCode = 1
    }
    return
  }

  if (command === "sync-templates") {
    const options = parseOptions(rest)
    const repoRoot = options.repo ? path.resolve(options.repo) : null
    const result = await syncTemplates({
      repoRoot,
      dryRun: !!options["dry-run"],
    })

    if (result.results.length === 0) {
      console.log("No repos registered yet.")
      return
    }

    console.log(result.results.map(formatSyncResult).join("\n\n"))
    return
  }

  if (command === "status") {
    const options = parseOptions(rest)
    const repoRoot = options.repo ? path.resolve(options.repo) : null
    const statuses = await getStatus({ repoRoot })
    console.log(`btrain home: ${getBrainTrainHome()}`)
    console.log("")
    if (statuses.length === 0) {
      console.log("No repos registered yet.")
      return
    }
    console.log(statuses.map(formatRepoStatus).join("\n\n"))
    return
  }

  if (command === "doctor") {
    const options = parseOptions(rest)
    const repoRoot = options.repo ? path.resolve(options.repo) : null
    const results = await doctor({ repoRoot })
    console.log(`btrain home: ${getBrainTrainHome()}`)
    console.log("")
    if (results.length === 0) {
      console.log("No repos registered yet.")
      return
    }
    console.log(results.map(formatDoctorResult).join("\n\n"))
    if (results.some((result) => !result.healthy)) {
      process.exitCode = 1
    }
    return
  }

  if (command === "hooks") {
    const options = parseOptions(rest)
    const repoRoot = await resolveRepoRoot(options.repo)
    const result = await installPreCommitHook(repoRoot)

    if (result.installed) {
      console.log(`pre-commit hook ${result.reason}: ${repoRoot}`)
    } else if (result.reason === "existing-hook") {
      console.log("A pre-commit hook already exists and wasn't created by btrain.")
      console.log("Remove it manually or add the btrain check to your existing hook.")
    } else if (result.reason === "not-a-git-repo") {
      console.log("Not a git repo — nothing to install.")
    }
    return
  }

  if (command === "repos") {
    const repos = await listRepos()
    if (repos.length === 0) {
      console.log("No repos registered yet.")
      return
    }

    for (const repo of repos) {
      console.log(`- ${repo.name}: ${repo.path}`)
    }
    return
  }

  if (command === "locks") {
    const subcommand = ["release", "release-lane"].includes(rest[0]) ? rest[0] : null
    const options = parseOptions(subcommand ? rest.slice(1) : rest)
    const repoRoot = await resolveRepoRoot(options.repo)

    if (subcommand === "release") {
      if (!options.path) {
        throw new Error("`btrain locks release` requires --path.")
      }
      const removed = await forceReleaseLock(repoRoot, options.path)
      console.log(removed > 0 ? `Released lock: ${options.path}` : `No lock found: ${options.path}`)
      return
    }

    if (subcommand === "release-lane") {
      if (!options.lane) {
        throw new Error("`btrain locks release-lane` requires --lane.")
      }
      const released = await releaseLocks(repoRoot, options.lane)
      console.log(`Released ${released.length} lock(s) for lane ${options.lane}`)
      for (const lock of released) {
        console.log(`  ${lock.path} (${lock.owner})`)
      }
      return
    }

    // Default: list locks
    const locks = await listLocks(repoRoot)
    if (locks.length === 0) {
      console.log("No active locks.")
      return
    }

    console.log(`Active locks (${locks.length}):`)
    for (const lock of locks) {
      console.log(`  lane ${lock.lane}: ${lock.path} (${lock.owner}, ${lock.acquired_at})`)
    }
    return
  }

  if (command === "dashboard") {
    const options = parseOptions(rest)
    const port = options.port ? Number(options.port) : 3456
    const { startDashboard } = await import("./dashboard.mjs")
    const { url } = await startDashboard({ port })
    console.log(`btrain dashboard running at ${url}`)
    console.log("Press Ctrl+C to stop.")
    return new Promise(() => {}) // keep alive
  }

  throw new Error(`Unknown command: ${command}`)
}

run().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
