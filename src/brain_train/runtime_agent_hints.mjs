// Runtime hints for detectCurrentAgent (core.mjs): which agent CLI is running
// this process, read from the environment.
//
// The variables each agent CLI sets in the environment of the commands it
// runs, checked against Claude Code 2.1, Codex 0.115-0.154 and Gemini CLI 0.41.
// Only these produce hints. Matching "claude"/"codex" anywhere in the
// environment was wrong: every macOS PATH holds the codex.system cryptex
// (/var/run/com.apple.security.cryptexd/codex.system/...), Claude Code's
// TMPDIR puts "claude" in every temp path, and GitHub Actions exports the head
// branch. PATH is never a signal, because an installed CLI is not necessarily
// the running one. No CLI names its model, so there is no opus hint: an
// Opus-named agent matches through its claude runner.
const RUNTIME_AGENT_SIGNALS = [
  // Claude Code adds CLAUDECODE=1 to its shell and hook environments and
  // exports CLAUDE_CODE_ENTRYPOINT (cli, sdk-ts, claude-desktop, ...).
  { hint: "claude", keys: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"] },
  // Codex sets CODEX_THREAD_ID and CODEX_CI for shell commands (releases up to
  // 0.146 also set CODEX_SHELL), CODEX_SANDBOX* inside its sandbox, and its npm
  // launcher sets CODEX_MANAGED_BY_<package manager>. CODEX_HOME is user
  // configuration, present whichever agent runs, so it is not a marker.
  {
    hint: "codex",
    keys: [
      "CODEX_THREAD_ID",
      "CODEX_CI",
      "CODEX_SHELL",
      "CODEX_SANDBOX",
      "CODEX_SANDBOX_NETWORK_DISABLED",
      "CODEX_MANAGED_BY_NPM",
      "CODEX_MANAGED_BY_BUN",
      "CODEX_MANAGED_BY_PNPM",
      "CODEX_MANAGED_BY_VITE_PLUS",
    ],
  },
  // Gemini CLI sets GEMINI_CLI=1 for shell commands.
  { hint: "gemini", keys: ["GEMINI_CLI"] },
]

/**
 * Every variable that produces a runtime hint. The test harness strips these
 * so a suite run from inside an agent CLI does not detect that agent.
 */
export function runtimeAgentSignalKeys() {
  return RUNTIME_AGENT_SIGNALS.flatMap(({ keys }) => keys)
}

/**
 * The agents whose markers are set (non-empty) in `env`, in a fixed order.
 *
 * An agent CLI started from another one's shell inherits the outer markers, so
 * both hints appear and detection reports ambiguous. BTRAIN_AGENT settles
 * that; buildLoopRunnerEnv sets it for every runner btrain dispatches.
 */
export function collectRuntimeAgentHints(env = process.env) {
  const source = env || {}
  return RUNTIME_AGENT_SIGNALS
    .filter(({ keys }) => keys.some((key) => String(source[key] ?? "").trim() !== ""))
    .map(({ hint }) => hint)
}
