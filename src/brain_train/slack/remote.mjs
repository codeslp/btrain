// Spec 024 FR-7 and the plan's WS5 step 2 (task T023): the PR link of the
// `ready-to-merge` reply. Pure: the caller runs
//
//   git config --get-regexp '<REMOTE_CONFIG_PATTERN>'
//
// in the repository and passes its output. Imports nothing from core.mjs.
//
// The link names the repository PR flow opens the PR on, which in a fork is
// not `origin`. The remote is picked in the order `resolveBaseRemote` in
// pr-flow.mjs uses: the remote `gh repo set-default` marked
// (`remote.<name>.gh-resolved`), else `upstream`, `github`, `origin`, else
// the first. pr-flow.mjs keeps its own copy; sharing one parser is a plan
// follow-up. Only a `github.com` host gets a link, and only in the shape
// `render.mjs` accepts, so a remote it would refuse gets no link here either.

export const REMOTE_CONFIG_PATTERN = "^remote\\..+\\.(url|gh-resolved)$"

const PREFERRED_REMOTES = ["upstream", "github", "origin"]
const CONFIG_LINE = /^remote\.(\S+)\.(url|gh-resolved)\s+(.*)$/
const URL_FORMS = [
  /^https:\/\/(?:[^@/\s]+@)?([^/:@\s]+)(?::\d+)?\/(.+)$/i,
  /^ssh:\/\/(?:[^@/\s]+@)?([^/:@\s]+)(?::\d+)?\/(.+)$/i,
  // scp-style `git@host:owner/repo.git`. A URL such as `http://host/a/b`
  // also matches here, with an empty first segment, and is refused below.
  /^(?:[^@/\s:]+@)?([^/:@\s]+):(.+)$/,
]
// The owner and repository shapes of render.mjs's GITHUB_PR_URL.
const GITHUB_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/
const PR_NUMBER = /^[1-9]\d{0,8}$/

/**
 * `{ host, owner, repo }` for an `https://`, `ssh://`, or `git@host:` remote
 * whose path is exactly an owner and a repository, or null.
 */
export function parseRemoteUrl(url) {
  if (typeof url !== "string") return null
  const text = url.trim()
  for (const form of URL_FORMS) {
    const match = form.exec(text)
    if (!match) continue
    const segments = match[2].replace(/\/$/, "").replace(/\.git$/, "").split("/")
    if (segments.length !== 2 || segments.some((segment) => segment === "")) return null
    return { host: match[1].toLowerCase(), owner: segments[0], repo: segments[1] }
  }
  return null
}

/**
 * The remotes in `git config --get-regexp` output: `{ names, urls, marked }`,
 * names in first-seen order, each remote's first URL, and the remote whose
 * `gh-resolved` key is set.
 */
export function parseGitRemoteConfig(text) {
  const names = []
  const urls = new Map()
  let marked = ""
  for (const line of String(text ?? "").split("\n")) {
    const match = CONFIG_LINE.exec(line.trim())
    if (!match) continue
    const [, name, key, value] = match
    if (!names.includes(name)) names.push(name)
    if (key === "url" && !urls.has(name)) urls.set(name, value.trim())
    if (key === "gh-resolved" && !marked) marked = name
  }
  return { names, urls, marked }
}

/** The remote PR flow opens PRs on, in `resolveBaseRemote`'s order, or "". */
export function pickBaseRemote({ names = [], marked = "" } = {}) {
  if (marked && names.includes(marked)) return marked
  return PREFERRED_REMOTES.find((name) => names.includes(name)) || names[0] || ""
}

function prNumberText(prNumber) {
  return typeof prNumber === "number" || typeof prNumber === "string" ? String(prNumber).trim() : ""
}

/**
 * `https://github.com/<owner>/<repo>/pull/<n>` for the picked remote, or ""
 * when that remote is not on github.com, does not parse, or the PR number is
 * not a positive integer of at most nine digits.
 */
export function pullRequestLink(remoteConfigText, prNumber) {
  const number = prNumberText(prNumber)
  if (!PR_NUMBER.test(number)) return ""
  const remotes = parseGitRemoteConfig(remoteConfigText)
  const parsed = parseRemoteUrl(remotes.urls.get(pickBaseRemote(remotes)))
  if (!parsed || parsed.host !== "github.com") return ""
  if (!GITHUB_OWNER.test(parsed.owner) || !GITHUB_REPO.test(parsed.repo)) return ""
  return `https://github.com/${parsed.owner}/${parsed.repo}/pull/${number}`
}
