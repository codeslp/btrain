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

// Tests create and delete worktrees under one process; let them drop entries.
export function clearStateRootCache() {
  cache.clear()
}

function computeStateRoot(root) {
  const gitEntry = path.join(root, ".git")
  let stats
  try {
    stats = fs.statSync(gitEntry)
  } catch {
    return root
  }
  if (stats.isDirectory()) return root

  let pointer
  try {
    pointer = fs.readFileSync(gitEntry, "utf8")
  } catch {
    return root
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer)
  if (!match) return root

  const gitDir = path.resolve(root, match[1].trim())
  let commonDir
  try {
    commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim())
  } catch {
    return root
  }
  // A linked worktree's common dir is the primary checkout's `.git`. Anything
  // else (a bare repository) has no working tree whose state could be shared.
  if (path.basename(commonDir) !== ".git") return root
  const mainRoot = path.dirname(commonDir)
  try {
    if (!fs.statSync(mainRoot).isDirectory()) return root
  } catch {
    return root
  }
  return mainRoot
}
