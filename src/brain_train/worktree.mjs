import fs from "node:fs"
import path from "node:path"

// Lane state (handoff files, locks, history, overrides, events) belongs to a
// repository, not to one checkout of it. A linked git worktree carries its own
// copy of every tracked file but none of the ignored state, so running btrain
// there used to read a stale or empty lane set and diff the wrong checkout.
//
// resolveStateRoot maps a checkout to the directory whose `.btrain/` and
// handoff files every worktree of that repository shares: the main worktree.
// Git operations (diff gates, branch names, pushes) stay on the checkout
// btrain was pointed at; only state paths move.
//
// Resolution reads the same files git does, synchronously, so path builders
// can call it without an await:
//   <root>/.git is a directory            -> primary checkout, root is the state root
//   <root>/.git is "gitdir: <dir>" and
//     <dir>/commondir exists              -> linked worktree, state root is the
//                                            parent of the common dir
//   anything else (submodule pointer with no commondir, not a git checkout,
//   bare common dir)                      -> root is the state root
const cache = new Map()

export function resolveStateRoot(repoRoot) {
  const root = path.resolve(repoRoot)
  if (cache.has(root)) return cache.get(root)
  const resolved = computeStateRoot(root)
  cache.set(root, resolved)
  return resolved
}

export function isLinkedWorktree(repoRoot) {
  return resolveStateRoot(repoRoot) !== path.resolve(repoRoot)
}

// A checkout whose `.git` pointer names a worktree gitdir (it has a
// `commondir`) that is not a main checkout's `.git`: a worktree of a bare
// repository, or a worktree of a submodule. Lane state stays per checkout
// there, which is the split the state root exists to remove, so doctor names
// it instead of letting it happen quietly. A plain submodule checkout (pointer
// without `commondir`) is a repository of its own and is not reported.
export function hasUnsharedGitPointer(repoRoot) {
  return classifyGitEntry(path.resolve(repoRoot)).kind === "unshared-worktree"
}

// Tests create and delete worktrees under one process; let them drop entries.
export function clearStateRootCache() {
  cache.clear()
}

function computeStateRoot(root) {
  const entry = classifyGitEntry(root)
  return entry.kind === "linked-worktree" ? entry.mainRoot : root
}

// What `<root>/.git` is:
//   "directory"          a primary checkout (or no .git at all: "none")
//   "pointer"            a gitdir pointer without commondir: a submodule checkout
//   "linked-worktree"    a pointer whose commondir is a main checkout's .git
//   "unshared-worktree"  a pointer whose commondir is not a working tree's .git
//                        (bare repository or submodule worktree)
function classifyGitEntry(root) {
  const gitEntry = path.join(root, ".git")
  let stats
  try {
    stats = fs.statSync(gitEntry)
  } catch {
    return { kind: "none" }
  }
  if (stats.isDirectory()) return { kind: "directory" }

  let pointer
  try {
    pointer = fs.readFileSync(gitEntry, "utf8")
  } catch {
    return { kind: "none" }
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer)
  if (!match) return { kind: "none" }

  const gitDir = path.resolve(root, match[1].trim())
  let commonDir
  try {
    commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim())
  } catch {
    return { kind: "pointer" }
  }
  // A linked worktree's common dir is the primary checkout's `.git`. Anything
  // else (a bare repository) has no working tree whose state could be shared.
  if (path.basename(commonDir) !== ".git") return { kind: "unshared-worktree" }
  const mainRoot = path.dirname(commonDir)
  try {
    if (!fs.statSync(mainRoot).isDirectory()) return { kind: "unshared-worktree" }
  } catch {
    return { kind: "unshared-worktree" }
  }
  return { kind: "linked-worktree", mainRoot }
}
