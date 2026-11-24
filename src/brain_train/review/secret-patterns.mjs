// The secret patterns of `btrain review code` (rule `hardcoded-secret`), in a
// module with no imports, so the Slack text pipeline (spec 024 FR-8) can scrub
// with the same list without importing code-rules.mjs, which imports core.mjs.
// code-rules.mjs imports this list and re-exports it as SECRET_PATTERNS.
//
// Each entry: { id, regex, label }. The regex matches a key inside a longer
// line and has no `g` flag; a caller that replaces every match builds its own
// global copy (see `globalSecretRegexes`).

export const SECRET_PATTERNS = Object.freeze([
  { id: "aws-access-key-id", regex: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key ID" },
  { id: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/, label: "GitHub token" },
  // Spec 024 FR-8: fine-grained personal access tokens, github_pat_<22>_<59>.
  { id: "github-fine-grained-token", regex: /\bgithub_pat_[A-Za-z0-9_]{36,}\b/, label: "GitHub fine-grained token" },
  { id: "stripe-key", regex: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/, label: "Stripe key" },
  { id: "openai-key", regex: /\bsk-[A-Za-z0-9]{40,}\b/, label: "OpenAI-style key" },
  { id: "anthropic-key", regex: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/, label: "Anthropic key" },
  { id: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, label: "Slack token" },
  // Spec 024 FR-8: an incoming-webhook URL is a credential on its own. The
  // scheme is optional so a URL pasted without it is still caught.
  {
    id: "slack-webhook-url",
    regex: /(?:\bhttps?:\/\/)?\bhooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{8,}/,
    label: "Slack webhook URL",
  },
  { id: "bearer-token", regex: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}\b/, label: "Bearer token" },
].map((pattern) => Object.freeze(pattern)))

/**
 * A global copy of every pattern's regex, for replacing every match in a text.
 *
 * With `boundaries: false` the `\b` anchors are dropped, so a secret glued to
 * a word character (`xghp_…`, `id=github_pat_…` with no space) still matches.
 * The Slack scrub uses that form: redacting a little too much is harmless
 * there, and a missed secret is not. The code review keeps the anchors to
 * avoid false positives.
 */
export function globalSecretRegexes({ boundaries = true } = {}) {
  return SECRET_PATTERNS.map((pattern) => {
    const source = boundaries ? pattern.regex.source : pattern.regex.source.replaceAll("\\b", "")
    return new RegExp(source, `${pattern.regex.flags.replace("g", "")}g`)
  })
}
