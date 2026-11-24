import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { checkHandoff } from "../src/brain_train/core.mjs"
import {
  fetchPrMergeState,
  ghRepoArgs,
  ghRepoFlagFor,
  prCreateHeadSpec,
  redactRemoteUrl,
  resolvePrRepository,
  restIdentityFor,
  runPrCreate,
  runPrPoll,
  runPrRequestReview,
} from "../src/brain_train/pr-flow.mjs"

const exec = promisify(execFile)
const CLI_PATH = path.resolve("src/brain_train/cli.mjs")

function cliEnv(home, agent) {
  const env = { ...process.env }
  for (const key of ["BTRAIN_AGENT", "BRAIN_TRAIN_AGENT", "BTRAIN_LANE", "BTRAIN_LANE_LOCKED", "BTRAIN_REPO", "BTRAIN_LOOP_ACTIVE"]) {
    delete env[key]
  }
  return { ...env, BRAIN_TRAIN_HOME: home, BTRAIN_NO_REVIEW_DISPATCH: "1", CI: "true", BTRAIN_AGENT: agent }
}

async function btrain(args, { cwd, home, agent = "alpha" }) {
  try {
    const result = await exec("node", [CLI_PATH, ...args], { cwd, env: cliEnv(home, agent), maxBuffer: 5 * 1024 * 1024 })
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: 0 }
  } catch (error) {
    return { stdout: error.stdout?.trim() || "", stderr: error.stderr?.trim() || "", code: typeof error.code === "number" ? error.code : 1 }
  }
}

async function git(cwd, ...args) {
  const { stdout } = await exec("git", ["-C", cwd, ...args])
  return stdout.trim()
}

const REVIEW_CONTEXT = [
  "--preflight", "read the lane files",
  "--changed", "src/a/feature.mjs - the change",
  "--verification", "node --test",
  "--verification", "- [X] code-simplifier passed",
  "--gap", "none",
  "--why", "exercise the PR target",
  "--review-ask", "check the gate",
]

async function commit(repo, text) {
  await fs.writeFile(path.join(repo, "src", "a", "feature.mjs"), text)
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", `change: ${text.length}`)
  return git(repo, "rev-parse", "HEAD")
}

// A PR-flow repo with lane a claimed by alpha and reviewed by beta, and a
// real bare `origin` carrying `main`. The gate reads the base off the remote
// on every path, so a repo without one cannot exercise it.
async function withRepo(fn) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-pr-target-")))
  const home = path.join(root, "home")
  const repo = path.join(root, "repo")
  const bare = path.join(root, "remote.git")
  try {
    await exec("git", ["init", "-q", "-b", "main", repo])
    await git(repo, "config", "user.email", "test@example.com")
    await git(repo, "config", "user.name", "Test Bot")
    await git(repo, "config", "commit.gpgsign", "false")
    await fs.mkdir(path.join(repo, "src", "a"), { recursive: true })
    const init = await btrain(["init", repo, "--tracked", "--agent", "alpha", "--agent", "beta", "--core-only", "--no-hooks"], { cwd: repo, home })
    assert.equal(init.code, 0, init.stderr)
    await fs.appendFile(path.join(repo, ".btrain", "project.toml"), '\n[pr_flow]\nenabled = true\nbase = "main"\n')
    await commit(repo, "export const feature = 0\n")
    await exec("git", ["init", "-q", "--bare", "-b", "main", bare])
    await git(repo, "remote", "add", "origin", bare)
    await git(repo, "push", "-q", "origin", "main")
    // The lane works on a branch so `--base main` sees a real diff, which is
    // what the needs-review evidence gate requires.
    await git(repo, "checkout", "-q", "-b", "feat/gate")

    const claim = await btrain(["handoff", "claim", "--lane", "a", "--task", "gate lane", "--owner", "alpha", "--reviewer", "beta", "--files", "src/a/"], { cwd: repo, home })
    assert.equal(claim.code, 0, `${claim.stdout}\n${claim.stderr}`)
    const headA = await commit(repo, "export const feature = 1\n")

    await fn({ repo, home, headA, bare, base: await baseTarget(bare) })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

// What the gate should compute for a bare remote: `path:<dir>` without the
// `.git`, the base ref, and the object that ref is at on the remote itself.
async function baseTarget(bare, ref = "main") {
  return {
    repo: `path:${bare.replace(/\.git$/, "")}`,
    ref,
    sha: await git(bare, "rev-parse", `refs/heads/${ref}`),
  }
}

async function handOff(repo, home) {
  const review = await btrain(
    ["handoff", "update", "--lane", "a", "--status", "needs-review", "--actor", "alpha", "--base", "main", "--no-dispatch", ...REVIEW_CONTEXT],
    { cwd: repo, home },
  )
  assert.equal(review.code, 0, `${review.stdout}\n${review.stderr}`)
}

async function laneA(repo) {
  const handoff = await checkHandoff(repo)
  return handoff.lanes ? handoff.lanes.find((lane) => lane._laneId === "a") : handoff.current
}

async function installFakeGh(root, pr, { host = "github.com/o/r" } = {}) {
  const binDir = path.join(root, "fakebin")
  const statePath = path.join(root, "gh-head.json")
  const authoritativePath = path.join(root, "gh-authoritative.json")
  const reviewsPath = path.join(root, "gh-reviews.json")
  const postedPath = path.join(root, "gh-posted.log")
  const invokedPath = path.join(root, "gh-invoked.log")
  await fs.mkdir(binDir, { recursive: true })
  const write = (next) => fs.writeFile(statePath, JSON.stringify({ url: `https://${host}/pull/7`, ...next }))
  await write(pr)
  const q = (value) => JSON.stringify(value)
  await fs.writeFile(
    path.join(binDir, "gh"),
    `#!/bin/sh
repo=""
line="$1 $2"
prev=""
for arg in "$@"; do
  case "$prev" in
    --repo) repo="$arg"; line="$line --repo $arg" ;;
    --hostname) line="$line --hostname $arg" ;;
  esac
  prev="$arg"
done
echo "$line" >> ${q(invokedPath)}
if [ "$1" = "--version" ]; then echo "gh version 2.0.0 (fake)"; exit 0; fi
# A REST read names its repository in the endpoint, never with --repo.
if [ "$1" = "api" ]; then
  case "$2" in
    repos/${host.split("/").slice(1).join("/")}/pulls/*/reviews)
      if [ -f ${q(reviewsPath)} ]; then cat ${q(reviewsPath)}; else echo "[]"; fi
      exit 0 ;;
    repos/${host.split("/").slice(1).join("/")}/*) echo "[]"; exit 0 ;;
    *) echo "fake gh: no such repository: $2" >&2; exit 1 ;;
  esac
fi
[ -n "$repo" ] || repo="\${GH_REPO:-${host}}"
# A PR is opened wherever gh resolved, and its URL says where that was.
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo "https://$repo/pull/7"
  exit 0
fi
if [ "$repo" != ${q(host)} ]; then
  echo "fake gh: no such pull request in $repo" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  case "$*" in
    *headRepository*) if [ -f ${q(authoritativePath)} ]; then cat ${q(authoritativePath)}; exit 0; fi ;;
  esac
  cat ${q(statePath)}
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  echo "$@" >> ${q(postedPath)}
  echo "https://${host}/pull/7#issuecomment-1"
  exit 0
fi
echo "fake gh: unsupported: $@" >&2
exit 1
`,
    { mode: 0o755 },
  )
  return {
    binDir,
    setPr: write,
    setAuthoritativePr: (next) => fs.writeFile(authoritativePath, JSON.stringify(next)),
    setReviews: (reviews) => fs.writeFile(reviewsPath, JSON.stringify(reviews)),
    async posted() {
      return fs.readFile(postedPath, "utf8").catch(() => "")
    },
    async invocations() {
      const log = await fs.readFile(invokedPath, "utf8").catch(() => "")
      return log.split("\n").filter(Boolean)
    },
  }
}

// `gh pr create` opens the PR on the repository the gate authorized, but
// nothing afterwards knows which one that was unless it is carried: the
// alternate default below is what the plain `gh pr view <number>` of the old
// code would have asked about.
const OTHER_DEFAULT_REPO = "github.com/other/elsewhere"

async function withEnv(vars, fn) {
  const previous = {}
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key]
    process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// A remote that names a GitHub repository rather than the test's bare path,
// so the lane resolves a repository `gh --repo` can be pointed at. The bot
// paths never contact it: they read its URL and ask GitHub everything else.
async function addGitHubBaseRemote(repo, url = "https://github.com/o/r.git") {
  await git(repo, "remote", "add", "upstream", url)
}

// One file per lane, PR and claim, so counting them is how a test sees
// whether an association was written and how many times.
async function prAssociationFiles(repo) {
  const dir = path.join(repo, ".btrain", "pr-flow")
  const names = await fs.readdir(dir).catch(() => [])
  return names.sort().map((name) => path.join(dir, name))
}

// A lane sitting at `pr-review` on PR #7, with peer review complete.
async function linkPr(repo, home) {
  await handOff(repo, home)
  await finishPeerReview(repo, home)
  const link = await btrain(
    ["handoff", "update", "--lane", "a", "--status", "pr-review", "--pr", "7", "--actor", "alpha"],
    { cwd: repo, home },
  )
  assert.equal(link.code, 0, `${link.stdout}\n${link.stderr}`)
}

async function withPath(binDir, fn) {
  const previous = process.env.PATH
  process.env.PATH = `${binDir}${path.delimiter}${previous}`
  try {
    return await fn()
  } finally {
    process.env.PATH = previous
  }
}

const GH_REPO = "github.com/o/r"

async function finishPeerReview(repo, home) {
  const result = await btrain(["handoff", "resolve", "--lane", "a", "--summary", "Peer checks passed"], { cwd: repo, home, agent: "beta" })
  assert.equal(result.code, 0, result.stderr)
}

function prOn(base, headRefOid) {
  return {
    headRefOid,
    headRefName: "feat/gate",
    baseRefName: "main",
    baseRefOid: base.sha,
    url: "https://github.com/o/r/pull/7",
  }
}

describe("PR publication", () => {
  it("refuses --no-push when the branch is absent from the destination", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await handOff(repo, home)
      await finishPeerReview(repo, home)

      await assert.rejects(
        runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha", "no-push": true }),
        (error) => {
          assert.match(error.message, /does not have the branch/)
          assert.match(error.message, /git push origin [0-9a-f]{40}:refs\/heads\/feat\/gate/)
          return true
        },
      )
    })

  })

  it("refuses --no-push when the published revision is different from the selected one", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await handOff(repo, home)
      await finishPeerReview(repo, home)
      // Someone publishes a different revision on the branch.
      const headB = await commit(repo, "export const feature = 6\n")
      await git(repo, "push", "-q", "origin", `${headB}:refs/heads/feat/gate`)
      await git(repo, "reset", "-q", "--hard", headA)

      await assert.rejects(
        runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha", "no-push": true }),
        (error) => {
          assert.match(error.message, new RegExp(`is at ${headB}`))
          assert.match(error.message, new RegExp(`this command selected ${headA}`))
          assert.match(error.message, /would open a PR on a different revision/)
          return true
        },
      )
    })

  })

  it("pushes the selected object by name rather than the branch tip", async () => {
    await withRepo(async ({ repo, home, headA, base, bare }) => {
      await handOff(repo, home)
      await finishPeerReview(repo, home)

      const gh = await installFakeGh(path.dirname(repo), prOn(base, headA))
      await withPath(gh.binDir, () => runPrCreate(repo, { lane: "a", bots: "none", actor: "alpha" }))

      const published = await git(bare, "rev-parse", "refs/heads/feat/gate")
      assert.equal(published, headA, "the selected object is what reached the remote")
    })

  })

  it("verifies the destination the push writes to, not the fetch URL", async () => {
    await withRepo(async ({ repo, home, headA, base, bare }) => {
      // origin fetches from `bare` and pushes to `pushBare`. A check that
      // read the fetch URL would look at the wrong repository entirely.
      const pushBare = path.join(path.dirname(bare), "push-remote.git")
      await exec("git", ["init", "-q", "--bare", "-b", "main", pushBare])
      await git(repo, "remote", "set-url", "--push", "origin", pushBare)

      await handOff(repo, home)
      await finishPeerReview(repo, home)
      const gh = await installFakeGh(path.dirname(repo), prOn(base, headA))
      await withPath(gh.binDir, () => runPrCreate(repo, { lane: "a", bots: "none", actor: "alpha" }))

      assert.equal(
        await git(pushBare, "rev-parse", "refs/heads/feat/gate"),
        headA,
        "the push went to the push URL",
      )
      await assert.rejects(
        git(bare, "rev-parse", "refs/heads/feat/gate"),
        "the fetch URL never received the branch, which is what makes the check meaningful",
      )
    })

  })

  it("refuses when a second push URL carries a different revision", async () => {
    await withRepo(async ({ repo, home, headA, base, bare }) => {
      // Two push URLs: git pushes to both, so both have to carry the
      // selected revision before a PR may be opened on the branch.
      const mirror = path.join(path.dirname(bare), "mirror.git")
      await exec("git", ["init", "-q", "--bare", "-b", "main", mirror])
      await git(repo, "remote", "set-url", "--push", "origin", bare)
      await git(repo, "remote", "set-url", "--push", "--add", "origin", mirror)
      // The first destination has the selected revision; the mirror already
      // holds someone else's work on the same branch.
      await git(repo, "push", "-q", bare, `${headA}:refs/heads/feat/gate`)
      const foreign = await commit(repo, "export const feature = 99\n")
      await git(repo, "push", "-q", mirror, `${foreign}:refs/heads/feat/gate`)
      await git(repo, "reset", "-q", "--hard", headA)

      await handOff(repo, home)
      await finishPeerReview(repo, home)

      await assert.rejects(
        runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha", "no-push": true }),
        (error) => {
          assert.match(error.message, new RegExp(`is at ${foreign}`))
          assert.match(error.message, new RegExp(`this command selected ${headA}`))
          assert.match(error.message, /mirror/, "the failing destination is named")
          return true
        },
      )
    })

  })

  it("stops PR creation if the published base changes during push", async () => {
    await withRepo(async ({ repo, home, headA, base, bare }) => {
      await handOff(repo, home)
      await finishPeerReview(repo, home)
      await git(repo, "push", "-q", "origin", `${headA}:refs/heads/future-base`)
      await fs.writeFile(path.join(repo, ".git", "hooks", "pre-push"),
        `#!/bin/sh\nexec git --git-dir=${JSON.stringify(bare)} update-ref refs/heads/main ${headA}\n`, { mode: 0o755 })
      const gh = await installFakeGh(path.dirname(repo), prOn(base, headA))
      await withPath(gh.binDir, async () => {
        await assert.rejects(runPrCreate(repo, { lane: "a", actor: "alpha" }), /base main changed before PR creation/)
      })
      assert.deepEqual(await gh.invocations(), [])
    })
  })

  it("never prints the credentials a push URL may carry", () => {
    assert.equal(
      redactRemoteUrl("https://octocat:ghp_SECRETTOKEN@github.com/codeslp/btrain.git"),
      "https://***@github.com/codeslp/btrain.git",
    )
    assert.equal(redactRemoteUrl("https://github.com/codeslp/btrain.git"), "https://github.com/codeslp/btrain.git")
    assert.equal(redactRemoteUrl("git@github.com:codeslp/btrain.git"), "github.com:codeslp/btrain.git")
    assert.equal(redactRemoteUrl("/srv/git/btrain.git"), "/srv/git/btrain.git")
    assert.equal(redactRemoteUrl(""), "")

  })

  it("names the repository gh must open on, and qualifies a fork head", () => {
    assert.equal(ghRepoFlagFor("github.com/codeslp/btrain"), "github.com/codeslp/btrain")
    assert.equal(ghRepoFlagFor("ghe.internal/codeslp/btrain"), "ghe.internal/codeslp/btrain")
    assert.equal(ghRepoFlagFor("path:/srv/git/btrain"), "", "a local remote is no GitHub repository")
    assert.equal(ghRepoFlagFor("codeslp/btrain"), "", "an identity without a host is not usable")
    assert.equal(ghRepoFlagFor(""), "")

    const upstream = "github.com/codeslp/btrain"
    assert.equal(prCreateHeadSpec("feat/gate", upstream, upstream), "feat/gate", "a same-repository head stays bare")
    assert.equal(
      prCreateHeadSpec("feat/gate", "github.com/contributor/btrain", upstream),
      "contributor:feat/gate",
      "a fork head is qualified with its owner",
    )
    assert.equal(prCreateHeadSpec("feat/gate", "", upstream), "feat/gate", "an unknown head repository changes nothing")
  })
})

describe("Head validation", () => {
  it("holds the checkout to GitHub's head only for the PR's own head repository", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      const root = path.dirname(repo)
      await addGitHubBaseRemote(repo)
      // This checkout's `feat/gate` is the branch of `github.com/o/r`.
      await git(repo, "update-ref", "refs/remotes/upstream/feat/gate", headA)
      await git(repo, "branch", "--set-upstream-to=upstream/feat/gate", "feat/gate")

      // GitHub reports a revision that this checkout does not have.
      const ghHead = "c".repeat(40)
      await handOff(repo, home)
      await finishPeerReview(repo, home)
      const link = await btrain(["handoff", "update", "--lane", "a", "--status", "pr-review", "--pr", "7", "--actor", "alpha"], { cwd: repo, home })
      assert.equal(link.code, 0, `${link.stdout}\n${link.stderr}`)

      const headIn = (owner) => ({ headRepository: { name: "r" }, headRepositoryOwner: { login: owner } })
      const gh = await installFakeGh(root, { ...prOn(base, ghHead), ...headIn("o") })
      await withPath(gh.binDir, async () => {
        await assert.rejects(
          runPrRequestReview(repo, { lane: "a", bots: "all" }),
          new RegExp(`GitHub has PR #7 at ${ghHead}`),
          "the checkout holds the PR's own head branch, so the two must agree",
        )
      })
      assert.equal(await gh.posted(), "")

      // The same branch name in another repository: an adopted fork PR. The
      // local `feat/gate` is a different branch, so its revision says nothing
      // about whether the PR head is the selected one.
      await gh.setPr({ ...prOn(base, ghHead), ...headIn("fork") })
      await withPath(gh.binDir, async () => {
        assert.ok(
          (await runPrRequestReview(repo, { lane: "a", bots: "all" })).length > 0,
          "a matching name in another repository does not stand in for the fork",
        )
      })
      assert.match(await gh.posted(), new RegExp(`head=${ghHead}`))
    })
  })
})

describe("the lane's PR repository is pinned, not re-derived", () => {
  it("resolves a repository from a PR URL and addresses it for REST", () => {
    assert.deepEqual(restIdentityFor("github.com/o/r"), { host: "github.com", owner: "o", repo: "r" })
    assert.deepEqual(restIdentityFor("ghe.corp/o/r"), { host: "ghe.corp", owner: "o", repo: "r" })
    assert.equal(restIdentityFor("path:/srv/git/btrain"), null, "a local remote is no GitHub repository")
    assert.equal(restIdentityFor("o/r"), null, "an identity without a host cannot be addressed")
    assert.deepEqual(ghRepoArgs("github.com/o/r"), ["--repo", "github.com/o/r"])
    assert.deepEqual(ghRepoArgs("path:/srv/git/btrain"), [], "gh keeps its own default when there is nothing to name")
  })

  it("pins the repository gh opened the PR on, and asks that one afterwards", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      const root = path.dirname(repo)
      await handOff(repo, home)
      await finishPeerReview(repo, home)
      const gh = await installFakeGh(root, prOn(base, headA))

      // A local remote has no GitHub identity. Later calls follow the PR URL
      // that gh returns at creation.
      await withPath(gh.binDir, async () => {
        const created = await runPrCreate(repo, { lane: "a", bots: "all", actor: "alpha" })
        assert.equal(created.url, `https://${GH_REPO}/pull/7`)
      })

      const views = (await gh.invocations()).filter((line) => line.startsWith("pr view"))
      assert.deepEqual(views, ["pr view --repo github.com/o/r"], "the view followed the URL gh printed")

      const [file] = await prAssociationFiles(repo)
      const record = JSON.parse(await fs.readFile(file, "utf8"))
      assert.equal(record.repo, "github.com/o/r")
      assert.equal(record.pr, "7")
      assert.equal(record.lane, "a")
    })
  })

  it("pins once when two commands race, and both act on the same repository", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await addGitHubBaseRemote(repo)
      await linkPr(repo, home)

      // Both derive a repository before either has written one. Exactly one
      // record may result, and the loser must adopt the winner's answer
      // rather than carrying its own into the calls it is about to make.
      const racers = { laneId: "a", prNumber: "7", linked: true }
      const [first, second] = await Promise.all([
        resolvePrRepository(repo, racers),
        resolvePrRepository(repo, racers),
      ])
      assert.equal(first, "github.com/o/r")
      assert.equal(second, first)
      assert.equal((await prAssociationFiles(repo)).length, 1, "one lane, one claim, one PR, one record")
    })
  })

  it("refuses the loser of a race between two conflicting explicit repositories", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await addGitHubBaseRemote(repo)
      await linkPr(repo, home)

      // Two commands name #7 in two different repositories at once, with no
      // association yet to tell them apart. One pins; the other must be
      // refused rather than quietly carrying its own repository forward.
      const race = (host) => resolvePrRepository(repo, {
        laneId: "a",
        prNumber: "7",
        linked: true,
        url: `https://${host}/pull/7`,
      })
      const settled = await Promise.allSettled([race("github.com/o/r"), race(OTHER_DEFAULT_REPO)])

      const won = settled.filter((result) => result.status === "fulfilled")
      const lost = settled.filter((result) => result.status === "rejected")
      assert.equal(won.length, 1, JSON.stringify(settled, null, 2))
      assert.equal(lost.length, 1)
      assert.match(lost[0].reason.message, /is associated with PR #7 in/)
      assert.match(lost[0].reason.message, /refusing to act on/)

      const [file] = await prAssociationFiles(repo)
      assert.equal((await prAssociationFiles(repo)).length, 1, "one record, not one per racer")
      const record = JSON.parse(await fs.readFile(file, "utf8"))
      assert.equal(record.repo, won[0].value, "the winner is what was pinned")

      // Whichever won, the file it published was complete when it appeared.
      assert.equal(record.version, 1)
      assert.equal(record.pr, "7")
    })
  })

  it("reports an unreadable association instead of quietly re-deriving one", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await addGitHubBaseRemote(repo)
      await linkPr(repo, home)
      await resolvePrRepository(repo, { laneId: "a", prNumber: "7", linked: true })

      const [file] = await prAssociationFiles(repo)
      await fs.writeFile(file, "{ this is not json")
      await assert.rejects(
        resolvePrRepository(repo, { laneId: "a", prNumber: "7", linked: true }),
        (error) => {
          assert.match(error.message, /cannot be read/)
          assert.match(error.message, new RegExp(`Delete ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
          return true
        },
      )
    })
  })

  it("pins the explicit repository before poll applies a PR adoption", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await addGitHubBaseRemote(repo, `https://${OTHER_DEFAULT_REPO}.git`)
      await handOff(repo, home)
      await finishPeerReview(repo, home)
      const gh = await installFakeGh(path.dirname(repo), prOn(base, headA))
      const options = { lane: "a", pr: `https://${GH_REPO}/pull/7`, actor: "alpha" }

      await withPath(gh.binDir, async () => {
        await runPrPoll(repo, options)
        assert.deepEqual(await prAssociationFiles(repo), [])
        assert.equal((await laneA(repo)).status, "ready-for-pr")

        await runPrPoll(repo, { ...options, apply: true })
        assert.equal((await laneA(repo)).prNumber, "7")
        const [file] = await prAssociationFiles(repo)
        assert.ok(file, "apply should persist the repository for later polls")
        assert.equal(JSON.parse(await fs.readFile(file, "utf8")).repo, GH_REPO)
        await runPrPoll(repo, { lane: "a" })
      })
    })
  })

  it("does not pin a --pr the lane never linked", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      const root = path.dirname(repo)
      await addGitHubBaseRemote(repo)
      await handOff(repo, home)
      await finishPeerReview(repo, home)
      const gh = await installFakeGh(root, prOn(base, headA))

      // The lane has no PR of its own, so looking at #7 is a look. Pinning it
      // would bind the lane to a PR nobody adopted for it.
      await withPath(gh.binDir, async () => {
        await runPrRequestReview(repo, { lane: "a", bots: "all", pr: "7" })
      })
      assert.deepEqual(await prAssociationFiles(repo), [])
    })
  })

  it("keeps the association when the remote and the shell both move to another repository", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      const root = path.dirname(repo)
      await addGitHubBaseRemote(repo)
      await linkPr(repo, home)
      const gh = await installFakeGh(root, prOn(base, headA))

      await withEnv({ GH_REPO: OTHER_DEFAULT_REPO }, async () => {
        await withPath(gh.binDir, async () => {
          assert.ok((await runPrRequestReview(repo, { lane: "a", bots: "all" })).length > 0)

          // `other/elsewhere` has a #7 too. Repointing the remote at it used
          // to be enough to make the next command act on it instead.
          await git(repo, "remote", "set-url", "upstream", `https://${OTHER_DEFAULT_REPO}.git`)
          assert.ok((await runPrRequestReview(repo, { lane: "a", bots: "all" })).length > 0)
        })
      })

      const invocations = await gh.invocations()
      assert.ok(invocations.length >= 4, invocations.join("\n"))
      for (const line of invocations) {
        assert.match(line, /--repo github\.com\/o\/r/, `a call left the lane's repository:\n${line}`)
      }
      assert.match(await gh.posted(), new RegExp(`head=${headA}`))
    })
  })

  it("refuses an explicit --pr that is this number in another repository", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      const root = path.dirname(repo)
      await addGitHubBaseRemote(repo)
      await linkPr(repo, home)
      const gh = await installFakeGh(root, prOn(base, headA))

      await withPath(gh.binDir, async () => {
        assert.ok((await runPrRequestReview(repo, { lane: "a", bots: "all" })).length > 0)
        await assert.rejects(
          runPrRequestReview(repo, { lane: "a", bots: "all", pr: `https://${OTHER_DEFAULT_REPO}/pull/7` }),
          (error) => {
            assert.match(error.message, /associated with PR #7 in `github\.com\/o\/r`/)
            assert.match(error.message, new RegExp(`refusing to act on \`${OTHER_DEFAULT_REPO}\``))
            return true
          },
        )
      })
      assert.ok(
        !(await gh.invocations()).some((line) => line.includes(OTHER_DEFAULT_REPO)),
        "the redirect was refused before any gh call",
      )
    })
  })

  it("keeps the lane's repository for a merge-state probe that carries no lane", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      const root = path.dirname(repo)
      await addGitHubBaseRemote(repo)
      await linkPr(repo, home)
      assert.equal(await resolvePrRepository(repo, { laneId: "a", prNumber: "7", linked: true }), GH_REPO)
      const gh = await installFakeGh(root, prOn(base, headA))

      // `btrain go` asks for the merge state with the number alone. The
      // remote and the shell have both moved to another repository that has
      // a #7 of its own, which is what the association has to outrank.
      await git(repo, "remote", "set-url", "upstream", `https://${OTHER_DEFAULT_REPO}.git`)
      await withEnv({ GH_REPO: OTHER_DEFAULT_REPO }, async () => {
        await withPath(gh.binDir, async () => {
          const state = await fetchPrMergeState(repo, "7")
          assert.equal(state.url, `https://${GH_REPO}/pull/7`)
        })
      })

      const invocations = await gh.invocations()
      assert.ok(invocations.length > 0, "the probe reached gh")
      for (const line of invocations) {
        assert.match(line, /--repo github\.com\/o\/r/, `the probe left the lane's repository:\n${line}`)
      }
    })
  })

  it("refuses a lane-less probe for a number two lanes hold in two repositories", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await addGitHubBaseRemote(repo)
      await linkPr(repo, home)
      assert.equal(await resolvePrRepository(repo, { laneId: "a", prNumber: "7", linked: true }), GH_REPO)
      const claim = await btrain(
        ["handoff", "claim", "--lane", "b", "--task", "Other PR", "--owner", "alpha", "--reviewer", "beta", "--files", "src/b/", "--pr", "7"],
        { cwd: repo, home },
      )
      assert.equal(claim.code, 0, claim.stderr)
      assert.equal(
        await resolvePrRepository(repo, {
          laneId: "b",
          prNumber: "7",
          linked: true,
          url: `https://${OTHER_DEFAULT_REPO}/pull/7`,
        }),
        OTHER_DEFAULT_REPO,
      )

      // Neither association may answer for the other, so the number alone is
      // refused rather than resolved to whichever lane was read first.
      await assert.rejects(fetchPrMergeState(repo, "7"), (error) => {
        assert.match(error.message, /associated with more than one repository/)
        assert.match(error.message, /lane a/)
        assert.match(error.message, /lane b/)
        return true
      })
    })
  })

  it("sends REST reads to the repository's own host", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      const root = path.dirname(repo)
      await addGitHubBaseRemote(repo, "https://ghe.corp/o/r.git")
      await linkPr(repo, home)
      const gh = await installFakeGh(root, {
        ...prOn(base, headA),
        url: "https://ghe.corp/o/r/pull/7",
        number: 7,
        title: "lane a",
        state: "OPEN",
        isDraft: false,
        mergedAt: null,
      }, { host: "ghe.corp/o/r" })

      await withEnv({ GH_REPO: OTHER_DEFAULT_REPO }, async () => {
        await withPath(gh.binDir, async () => {
          await runPrPoll(repo, { lane: "a" })
        })
      })

      const api = (await gh.invocations()).filter((line) => line.startsWith("api "))
      assert.ok(api.length > 0, "the REST comment fetch ran")
      for (const line of api) {
        assert.match(line, /^api repos\/o\/r\//, `a REST read left the lane's repository:\n${line}`)
        assert.match(line, /--hostname ghe\.corp/, `a REST read went to the wrong GitHub:\n${line}`)
      }
    })
  })
})


describe("Clearance applies to the classified target", () => {
  it("refuses a changed head or base and accepts the unchanged target", async () => {
    await withRepo(async ({ repo, home, headA, base }) => {
      await addGitHubBaseRemote(repo)
      await linkPr(repo, home)
      const gh = await installFakeGh(path.dirname(repo), prOn(base, headA))
      await gh.setReviews(["chatgpt-codex-connector[bot]", "unblocked[bot]"].map((login, index) => ({
        id: index + 1,
        state: "APPROVED",
        commit_id: headA,
        submitted_at: "2026-11-20T09:00:00Z",
        user: { login },
      })))
      const poll = () => runPrPoll(repo, { lane: "a", actor: "alpha", apply: true })
      await withPath(gh.binDir, async () => {
        await gh.setAuthoritativePr(prOn(base, "a".repeat(40)))
        await assert.rejects(poll, /head changed since bot review was checked/)
        assert.equal((await laneA(repo)).status, "pr-review")

        await gh.setAuthoritativePr(prOn({ ...base, sha: "b".repeat(40) }, headA))
        await assert.rejects(poll, /base changed since bot review was checked/)
        assert.equal((await laneA(repo)).status, "pr-review")

        await gh.setAuthoritativePr(prOn(base, headA))
        await poll()
        assert.equal((await laneA(repo)).status, "ready-to-merge")
      })
    })
  })
})
