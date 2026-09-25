// Spec 022 made local storage the default for `btrain init`. Suites written
// against the tracked layout (.claude/collab, AGENTS.md managed blocks) opt
// into it explicitly; local-mode coverage lives in test/local-init.test.mjs.
const STORAGE_FLAGS = new Set(["--tracked", "--shared", "--local", "--exclude-local"])

export function withTrackedInit(args) {
  if (!Array.isArray(args) || args[0] !== "init") return args
  if (args.some((arg) => STORAGE_FLAGS.has(arg))) return args
  return [...args, "--tracked"]
}
