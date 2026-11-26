// Spec 024 FR-7 (the merge announcement's PR link) and the plan's WS5 step 2
// through src/brain_train/slack/remote.mjs (task T023). The module is pure:
// these tests pass it the text `git config --get-regexp` prints. Every owner
// and repository name here is an obvious placeholder.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  REMOTE_CONFIG_PATTERN,
  parseGitRemoteConfig,
  parseRemoteUrl,
  pickBaseRemote,
  pullRequestLink,
} from "../src/brain_train/slack/remote.mjs"
import { classifyWorkflowEvent } from "../src/brain_train/slack/events.mjs"
import { renderReply } from "../src/brain_train/slack/render.mjs"

const config = (...lines) => `${lines.join("\n")}\n`

describe("parseRemoteUrl", () => {
  it("parses the three forms the plan names", () => {
    const expected = { host: "github.com", owner: "example-owner", repo: "example-repo" }
    for (const url of [
      "https://github.com/example-owner/example-repo.git",
      "https://github.com/example-owner/example-repo",
      "https://github.com/example-owner/example-repo/",
      "https://user@github.com/example-owner/example-repo.git",
      "https://github.com:443/example-owner/example-repo.git",
      "ssh://git@github.com/example-owner/example-repo.git",
      "ssh://git@github.com:22/example-owner/example-repo",
      "git@github.com:example-owner/example-repo.git",
      "github.com:example-owner/example-repo",
      "  git@GitHub.COM:example-owner/example-repo.git  ",
    ]) {
      assert.deepEqual(parseRemoteUrl(url), expected, url)
    }
  })

  it("keeps a host that is not github.com, lowercased", () => {
    assert.deepEqual(parseRemoteUrl("git@gitlab.example.test:team/app.git"), { host: "gitlab.example.test", owner: "team", repo: "app" })
    assert.deepEqual(parseRemoteUrl("https://Git.Example.Test/team/app"), { host: "git.example.test", owner: "team", repo: "app" })
  })

  it("returns null for anything that is not owner and repository on a host", () => {
    for (const url of [
      "",
      "   ",
      null,
      undefined,
      42,
      "/srv/git/app.git",
      "../app",
      "file:///srv/git/app.git",
      "http://github.com/example-owner/example-repo",
      "https://github.com/example-owner",
      "https://github.com/a/b/c",
      "https://github.com//example-repo",
      "git@github.com:/example-owner/example-repo.git",
      "git@github.com:example-owner",
      "ssh://git@github.com/example-owner",
      "https://github.com/example-owner/.git",
    ]) {
      assert.equal(parseRemoteUrl(url), null, String(url))
    }
  })
})

describe("parseGitRemoteConfig", () => {
  it("reads remote names in first-seen order, their URLs, and the gh-resolved mark", () => {
    const parsed = parseGitRemoteConfig(config(
      "remote.origin.url git@github.com:fork-owner/example-repo.git",
      "remote.upstream.url https://github.com/example-owner/example-repo.git",
      "remote.upstream.gh-resolved base",
      "remote.my.fork.url git@github.com:other/example-repo.git",
      "",
      "garbage line",
    ))
    assert.deepEqual(parsed.names, ["origin", "upstream", "my.fork"])
    assert.equal(parsed.urls.get("my.fork"), "git@github.com:other/example-repo.git")
    assert.equal(parsed.marked, "upstream")
  })

  it("keeps a remote's first URL when it has several", () => {
    const parsed = parseGitRemoteConfig(config(
      "remote.origin.url git@github.com:example-owner/example-repo.git",
      "remote.origin.url git@gitlab.example.test:team/app.git",
    ))
    assert.equal(parsed.urls.get("origin"), "git@github.com:example-owner/example-repo.git")
  })

  it("matches only url and gh-resolved keys", () => {
    assert.ok(REMOTE_CONFIG_PATTERN.includes("url|gh-resolved"))
    const parsed = parseGitRemoteConfig(config("remote.origin.fetch +refs/heads/*:refs/remotes/origin/*", "remote.origin.url git@github.com:o/r.git"))
    assert.deepEqual(parsed.names, ["origin"])
    assert.deepEqual(parseGitRemoteConfig(undefined), { names: [], urls: new Map(), marked: "" })
  })
})

describe("pickBaseRemote", () => {
  it("prefers the remote gh repo set-default marked", () => {
    assert.equal(pickBaseRemote({ names: ["origin", "upstream", "mine"], marked: "mine" }), "mine")
  })

  it("ignores a mark that names no remote", () => {
    assert.equal(pickBaseRemote({ names: ["origin", "upstream"], marked: "gone" }), "upstream")
  })

  it("prefers upstream, then github, then origin, then the first remote", () => {
    assert.equal(pickBaseRemote({ names: ["origin", "github", "upstream"], marked: "" }), "upstream")
    assert.equal(pickBaseRemote({ names: ["origin", "github"], marked: "" }), "github")
    assert.equal(pickBaseRemote({ names: ["zeta", "origin"], marked: "" }), "origin")
    // `git remote` lists names sorted, so "the first remote" is the first by
    // name, not by config order (codex-reviewer's repro on 1b0353e).
    assert.equal(pickBaseRemote({ names: ["zeta", "alpha"], marked: "" }), "alpha")
    assert.equal(pickBaseRemote({ names: ["b-remote", "B-remote", "a"], marked: "" }), "B-remote")
    assert.equal(pickBaseRemote({ names: [], marked: "" }), "")
    assert.equal(pickBaseRemote({}), "")
  })
})

describe("pullRequestLink", () => {
  const fork = config(
    "remote.origin.url git@github.com:fork-owner/example-repo.git",
    "remote.upstream.url https://github.com/example-owner/example-repo.git",
  )

  it("links the base repository, not a fork's origin", () => {
    assert.equal(pullRequestLink(fork, 114), "https://github.com/example-owner/example-repo/pull/114")
  })

  it("links the marked remote over upstream", () => {
    const marked = config(fork.trim(), "remote.origin.gh-resolved base")
    assert.equal(pullRequestLink(marked, "7"), "https://github.com/fork-owner/example-repo/pull/7")
  })

  it("links the first remote by name when none is preferred, as git remote orders them", () => {
    const text = config(
      "remote.zeta.url https://github.com/example-zeta/repo.git",
      "remote.alpha.url https://github.com/example-alpha/repo.git",
    )
    assert.equal(pullRequestLink(text, 7), "https://github.com/example-alpha/repo/pull/7")
  })

  it("links an SSH remote", () => {
    assert.equal(pullRequestLink(config("remote.origin.url ssh://git@github.com/example-owner/example-repo.git"), 3), "https://github.com/example-owner/example-repo/pull/3")
  })

  it("gives no link for a host that is not github.com", () => {
    assert.equal(pullRequestLink(config("remote.origin.url git@gitlab.example.test:team/app.git"), 5), "")
    assert.equal(pullRequestLink(config("remote.origin.url https://github.example.test/team/app.git"), 5), "")
  })

  it("gives no link for a picked remote that does not parse, even when another would", () => {
    const text = config("remote.upstream.url /srv/git/app.git", "remote.origin.url git@github.com:example-owner/example-repo.git")
    assert.equal(pullRequestLink(text, 5), "")
  })

  it("gives no link without a usable PR number or remote", () => {
    for (const prNumber of [0, -1, 1.5, "12a", "", null, undefined, "1e3", 1_000_000_000]) {
      assert.equal(pullRequestLink(fork, prNumber), "", String(prNumber))
    }
    assert.equal(pullRequestLink("", 5), "")
  })

  it("gives no link for names the reply renderer would refuse", () => {
    assert.equal(pullRequestLink(config("remote.origin.url git@github.com:-owner/example-repo.git"), 5), "")
    assert.equal(pullRequestLink(config(`remote.origin.url git@github.com:${"a".repeat(40)}/example-repo.git`), 5), "")
    assert.equal(pullRequestLink(config("remote.origin.url git@github.com:owner/re po.git"), 5), "")
  })

  it("composes with the ready-to-merge reply: the link renders as the PR link", () => {
    const LANE = { task: "t", owner: "claude", reviewer: "codex-reviewer", lockedFiles: [] }
    const ready = classifyWorkflowEvent({
      type: "update", actor: "claude", laneId: "e",
      before: { ...LANE, status: "pr-review", prNumber: "114" },
      after: { ...LANE, status: "ready-to-merge", prNumber: "114" },
    })
    const prUrl = pullRequestLink(fork, 114)
    const reply = renderReply(ready, { repoName: "example-repo", label: "dev", mention: [], channel: "C0000FAKE", prUrl })
    assert.ok(reply.endsWith(` · <${prUrl}|PR #114>`), reply)
    const none = renderReply(ready, { repoName: "example-repo", label: "dev", mention: [], channel: "C0000FAKE", prUrl: pullRequestLink(config("remote.origin.url git@gitlab.example.test:team/app.git"), 114) })
    assert.equal(none, "example-repo · dev: dev · PR #114 clear · ready to merge")
  })
})
