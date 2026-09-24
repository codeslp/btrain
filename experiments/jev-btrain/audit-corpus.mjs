#!/usr/bin/env node

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

function hash(value) {
  return createHash("sha256").update(value).digest("hex")
}

function coreText(body) {
  const standardFooter = /<details>\s*<summary>\s*ℹ️ About Codex in GitHub\s*<\/summary>[\s\S]*?<\/details>/gi
  return body
    .replace(standardFooter, "")
    .replace(/\b[a-f0-9]{7,40}\b/gi, "<commit>")
    .replace(/https?:\/\/[^\s)]+/g, "<url>")
    .replace(/\s+/g, " ")
    .trim()
}

function parseArgs(argv) {
  const repos = []
  const authors = []
  let before = null
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--repo" && argv[i + 1]) {
      const separator = argv[++i].indexOf("=")
      if (separator < 1) throw new Error("--repo requires name=/absolute/path")
      repos.push({ name: argv[i].slice(0, separator), root: argv[i].slice(separator + 1) })
    } else if (argv[i] === "--author" && argv[i + 1]) {
      authors.push(argv[++i].toLowerCase())
    } else if (argv[i] === "--before" && argv[i + 1]) {
      before = argv[++i]
    } else {
      throw new Error(`Unexpected argument: ${argv[i]}`)
    }
  }
  if (!repos.length || !authors.length) {
    throw new Error("Usage: node audit-corpus.mjs --author reviewer[bot] --repo name=/absolute/path [--repo ...]")
  }
  if (new Set(repos.map((repo) => repo.name)).size !== repos.length) {
    throw new Error("Repository names must be unique")
  }
  return { repos, authors, before }
}

function counts(rows, authors) {
  const allIds = new Set()
  const eligibleSurfaceIds = new Set()
  const exactBodies = new Set()
  const families = new Map()
  const bySurface = {}
  const byAuthor = {}
  let reviewerBotRows = 0
  let textSurfaceRows = 0
  let structuredReviewStateRows = 0
  let structuredCommitRows = 0

  for (const row of rows) {
    allIds.add(`${row.repo}:${row.surface}:${row.id}`)
    if (!authors.includes(String(row.author).toLowerCase())) continue
    reviewerBotRows += 1
    bySurface[row.surface] = (bySurface[row.surface] || 0) + 1
    byAuthor[row.author] = (byAuthor[row.author] || 0) + 1
    if (!["issue", "review"].includes(row.surface) || !String(row.body || "").trim()) continue

    textSurfaceRows += 1
    eligibleSurfaceIds.add(`${row.repo}:${row.surface}:${row.id}`)
    exactBodies.add(String(row.body).replace(/\s+/g, " ").trim())
    const family = coreText(String(row.body))
    const key = hash(family)
    families.set(key, (families.get(key) || 0) + 1)
    if (row.state) structuredReviewStateRows += 1
    if (row.commit_id || row.commitId || row.reviewedCommit) structuredCommitRows += 1
  }

  return {
    rows: rows.length,
    uniqueCommentIds: allIds.size,
    reviewerBotRows,
    byAuthor,
    bySurface,
    textSurfaceRows,
    uniqueTextCommentIds: eligibleSurfaceIds.size,
    uniqueExactBodies: exactBodies.size,
    coreMessageFamilies: families.size,
    largestFamilyRows: [...families.values()].sort((a, b) => b - a).slice(0, 5),
    structuredReviewStateRows,
    structuredCommitRows,
  }
}

export async function audit(repos, authors, { before = null } = {}) {
  const beforeMs = before === null ? null : Date.parse(before)
  if (before !== null && !Number.isFinite(beforeMs)) throw new Error("--before requires an ISO timestamp")
  const all = []
  const perRepo = {}
  const fingerprints = []
  for (const repo of repos) {
    const directory = path.join(repo.root, ".btrain", "pr-comments")
    const files = (await fs.readdir(directory)).filter((file) => file.endsWith(".jsonl")).sort()
    const rows = []
    let includedFiles = 0
    for (const file of files) {
      const previousCount = rows.length
      const lines = (await fs.readFile(path.join(directory, file), "utf8")).split("\n").filter(Boolean)
      for (const [index, line] of lines.entries()) {
        const record = JSON.parse(line)
        if (beforeMs !== null) {
          const atMs = Date.parse(record.at)
          if (!Number.isFinite(atMs)) throw new Error(`Invalid comment timestamp at ${repo.name}/${file}:${index + 1}`)
          if (atMs >= beforeMs) continue
        }
        if (!record.id || !record.surface || !record.author) {
          throw new Error(`Missing comment identity at ${repo.name}/${file}:${index + 1}`)
        }
        rows.push({ ...record, repo: repo.name })
        fingerprints.push(`${repo.name}/${file}:${index + 1}:${hash(line)}`)
      }
      if (rows.length > previousCount) includedFiles += 1
    }
    perRepo[repo.name] = { files: includedFiles, ...counts(rows, authors) }
    all.push(...rows)
  }
  return {
    schemaVersion: 1,
    scope: "Reviewer-bot issue and review text only; upper bound before head, state, and deterministic filters",
    before,
    authors,
    sourceFingerprint: hash(`${before || ""}\n${fingerprints.join("\n")}`),
    overall: counts(all, authors),
    repos: perRepo,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { repos, authors, before } = parseArgs(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(await audit(repos, authors, { before }), null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
