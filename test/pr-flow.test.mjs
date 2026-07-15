import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import {
  applyPrStatusToHandoff,
  classifyPrReviewState,
  formatPrStatusSummary,
  selectReviewRequestHeadSha,
} from "../src/brain_train/pr-flow.mjs"
import {
  checkHandoff,
  claimHandoff,
  initRepo,
  patchHandoff,
} from "../src/brain_train/core.mjs"

const execFileAsync = promisify(execFile)

const prFlowConfig = {
  enabled: true,
  base: "main",
  requiredBots: ["codex", "unblocked"],
  bots: {
    codex: {
      id: "codex",
      aliases: ["chatgpt-codex-connector[bot]", "chatgpt-codex-connector"],
      requestBody: "@codex review",
    },
    unblocked: {
      id: "unblocked",
      aliases: ["unblocked[bot]", "unblocked"],
      requestBody: "@unblocked review again",
    },
  },
}

describe("PR review request head selection", () => {
  it("uses a pushed local head when the PR API still reports the previous commit", () => {
    assert.equal(selectReviewRequestHeadSha({
      prHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      prHeadRefName: "feature",
      localBranch: "feature",
      localHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      remoteHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }), "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
  })

  it("does not mark an unpushed local commit for review", () => {
    assert.equal(selectReviewRequestHeadSha({
      prHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      prHeadRefName: "feature",
      localBranch: "feature",
      localHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      remoteHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
  })
})

describe("PR review flow classification", () => {
  it("classifies Codex current-head feedback and Unblocked stale feedback from ai_sales#143 shape", () => {
    const status = classifyPrReviewState({
      pr: {
        number: 143,
        title: "015 Phase 1: tablet binding backend (T010-T015)",
        state: "OPEN",
        headRefOid: "28320d5b6009ff6cff9746b158f8387fc1f8f29b",
        url: "https://github.com/Rapid-Agency/ai_sales/pull/143",
      },
      prFlowConfig,
      rawComments: {
        reviewComments: [
          {
            id: 1,
            user: { login: "unblocked[bot]" },
            body: "requireAppAccess blocks pre-bind tablet routes",
            commit_id: "da6ad5a439efc49ffccebb6968ed7e92860594cf",
            path: "src/api/server.ts",
            original_line: 445,
            html_url: "https://example.test/unblocked-1",
            created_at: "2026-05-04T19:01:18Z",
          },
          {
            id: 2,
            user: { login: "chatgpt-codex-connector[bot]" },
            body: "**P1** Remove access-gate middleware from pre-bind tablet routes",
            commit_id: "da6ad5a439efc49ffccebb6968ed7e92860594cf",
            path: "src/api/server.ts",
            original_line: 445,
            html_url: "https://example.test/codex-old",
            created_at: "2026-05-04T19:03:48Z",
          },
          {
            id: 3,
            user: { login: "chatgpt-codex-connector[bot]" },
            body: "**P1** Check provisioning before scanning all pairing-code hashes",
            commit_id: "28320d5b6009ff6cff9746b158f8387fc1f8f29b",
            path: "src/api/services/tablet-pairing.ts",
            line: 121,
            html_url: "https://example.test/codex-new",
            created_at: "2026-05-04T19:26:49Z",
          },
        ],
        reviews: [
          {
            id: 10,
            user: { login: "unblocked" },
            body: "### This PR has been reviewed by Unblocked Code Review\n\n2 issues found.",
            state: "COMMENTED",
            commit_id: "da6ad5a439efc49ffccebb6968ed7e92860594cf",
            submitted_at: "2026-05-04T19:01:18Z",
          },
          {
            id: 11,
            user: { login: "chatgpt-codex-connector" },
            body: "### 💡 Codex Review\n\n**Reviewed commit:** `28320d5b60`",
            state: "COMMENTED",
            commit_id: "28320d5b6009ff6cff9746b158f8387fc1f8f29b",
            submitted_at: "2026-05-04T19:26:49Z",
          },
        ],
      },
    })

    assert.equal(status.overall, "feedback")
    assert.equal(status.bots.find((bot) => bot.id === "codex").state, "feedback")
    assert.equal(status.bots.find((bot) => bot.id === "unblocked").state, "waiting")
    assert.equal(status.bots.find((bot) => bot.id === "unblocked").staleFeedbackCount, 1)
    assert.match(formatPrStatusSummary(status), /chatgpt|codex|pairing-code/i)
  })

  it("classifies ready-to-merge only when every required bot is clear on the latest head", () => {
    const status = classifyPrReviewState({
      pr: {
        number: 12,
        state: "OPEN",
        headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      prFlowConfig,
      rawComments: {
        reviewComments: [],
        reviews: [
          {
            id: 1,
            user: { login: "unblocked[bot]" },
            body: "0 issues found.",
            state: "APPROVED",
            commit_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            submitted_at: "2026-05-04T20:00:00Z",
          },
          {
            id: 2,
            user: { login: "chatgpt-codex-connector[bot]" },
            body: "No suggestions.",
            state: "APPROVED",
            commit_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            submitted_at: "2026-05-04T20:01:00Z",
          },
        ],
      },
    })

    assert.equal(status.overall, "ready-to-merge")
    assert.deepEqual(status.bots.map((bot) => bot.state), ["clear", "clear"])
  })

  it("classifies a Codex thumbs-up reaction on a marked review request as clear for that head", () => {
    const head = "cccccccccccccccccccccccccccccccccccccccc"
    const status = classifyPrReviewState({
      pr: {
        number: 13,
        state: "OPEN",
        headRefOid: head,
      },
      prFlowConfig,
      rawComments: {
        issueComments: [
          {
            id: 100,
            user: { login: "bfaris96" },
            body: `@codex review\n\n<!-- btrain-pr-review bot=codex lane=a head=${head} -->`,
            created_at: "2026-05-04T20:00:00Z",
          },
        ],
        issueCommentReactions: {
          100: [
            {
              content: "+1",
              user: { login: "chatgpt-codex-connector[bot]" },
              created_at: "2026-05-04T20:01:00Z",
            },
          ],
        },
        reviewComments: [],
        reviews: [
          {
            id: 1,
            user: { login: "unblocked[bot]" },
            body: "0 issues found.",
            state: "APPROVED",
            commit_id: head,
            submitted_at: "2026-05-04T20:02:00Z",
          },
        ],
      },
    })

    assert.equal(status.overall, "ready-to-merge")
    assert.equal(status.bots.find((bot) => bot.id === "codex").state, "clear")
  })

  it("classifies a matching-head Codex clear issue comment as clear", () => {
    const head = "dddddddddddddddddddddddddddddddddddddddd"
    const status = classifyPrReviewState({
      pr: {
        number: 14,
        state: "OPEN",
        headRefOid: head,
      },
      prFlowConfig,
      rawComments: {
        issueComments: [
          {
            id: 101,
            user: { login: "chatgpt-codex-connector[bot]" },
            body: `Codex Review: Didn't find any major issues. Chef's kiss.\n\n**Reviewed commit:** \`dddddddddd\``,
            created_at: "2026-07-14T21:12:35Z",
          },
        ],
        reviewComments: [],
        reviews: [],
      },
    })

    const codexState = status.bots.find((bot) => bot.id === "codex")
    assert.equal(codexState.state, "clear")
    assert.equal(codexState.reviewedCommit, "dddddddddd")
  })

  it("treats inline comments auto-anchored by GitHub to a new HEAD as stale, not current-head feedback", () => {
    const oldHead = "84e9bc6ba23cb233b7feab954e0b6fdb331895d9"
    const newHead = "0fac59295ce98ebd540cee314251671cf588acd5"
    const status = classifyPrReviewState({
      pr: {
        number: 12,
        state: "OPEN",
        headRefOid: newHead,
      },
      prFlowConfig,
      rawComments: {
        reviewComments: [
          {
            id: 1,
            user: { login: "chatgpt-codex-connector[bot]" },
            body: "**P1** Old finding GitHub re-anchored to the new head",
            commit_id: newHead,
            original_commit_id: oldHead,
            path: "src/brain_train/pr-flow.mjs",
            line: 610,
            original_line: 601,
            created_at: "2026-05-04T23:17:13Z",
          },
        ],
        reviews: [
          {
            id: 10,
            user: { login: "chatgpt-codex-connector[bot]" },
            body: "### 💡 Codex Review",
            state: "COMMENTED",
            commit_id: oldHead,
            submitted_at: "2026-05-04T23:17:12Z",
          },
        ],
      },
    })

    const codexState = status.bots.find((bot) => bot.id === "codex")
    assert.equal(codexState.state, "waiting")
    assert.equal(codexState.feedbackCount, 0)
    assert.equal(codexState.staleFeedbackCount, 1)
  })

  it("classifies merged PRs as merged regardless of outstanding old feedback", () => {
    const status = classifyPrReviewState({
      pr: {
        number: 12,
        state: "MERGED",
        mergedAt: "2026-05-04T21:00:00Z",
        headRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      prFlowConfig,
      rawComments: {
        reviewComments: [
          {
            id: 1,
            user: { login: "chatgpt-codex-connector[bot]" },
            body: "old finding",
            commit_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            created_at: "2026-05-04T20:00:00Z",
          },
        ],
        reviews: [],
      },
    })

    assert.equal(status.overall, "merged")
  })
})

describe("PR review flow handoff application", () => {
  it("infers the pinned runner identity when applying PR feedback", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-pr-apply-"))
    const previousHome = process.env.BRAIN_TRAIN_HOME
    const previousAgent = process.env.BTRAIN_AGENT

    try {
      process.env.BRAIN_TRAIN_HOME = path.join(repoRoot, ".btrain-test-home")
      process.env.BTRAIN_AGENT = "Codex"
      await execFileAsync("git", ["init", repoRoot])
      await initRepo(repoRoot, { agent: ["Codex", "Claude"] })
      await fs.writeFile(path.join(repoRoot, "README.md"), "# PR apply test\n", "utf8")
      await claimHandoff(repoRoot, {
        lane: "a",
        task: "Apply bot feedback",
        owner: "Codex",
        reviewer: "Claude",
        files: "README.md",
      })
      await patchHandoff(repoRoot, {
        lane: "a",
        actor: "Codex",
        status: "pr-review",
        pr: "22",
      })

      await applyPrStatusToHandoff(repoRoot, { lane: "a" }, {
        overall: "feedback",
        bots: [{ id: "codex", state: "feedback" }],
        pr: { number: 22 },
      })

      const handoff = await checkHandoff(repoRoot)
      const lane = handoff.lanes.find((candidate) => candidate._laneId === "a")
      assert.equal(lane.status, "changes-requested")
      assert.match(lane.lastUpdated, /^Codex /)
    } finally {
      if (previousHome === undefined) delete process.env.BRAIN_TRAIN_HOME
      else process.env.BRAIN_TRAIN_HOME = previousHome
      if (previousAgent === undefined) delete process.env.BTRAIN_AGENT
      else process.env.BTRAIN_AGENT = previousAgent
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })
})
