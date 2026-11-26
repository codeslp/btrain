// Spec 025 T015: the check behind the listener's `poll-pr` verb. A
// `changes-requested` lane qualifies only when `btrain pr poll --apply`
// entered that status, not a local request for changes. This is the same
// predicate as `enteredChangesRequestedViaPrPoll` in core.mjs, which is
// private: the newest event that moved the lane into `changes-requested` from
// another status decides, by its `details.transitionEvent`. `cli.mjs` passes
// it to `slack/cli.mjs` over the lane's own event log. Pure.

/** Whether `lane` is a `changes-requested` lane that `pr poll` put there. */
export function enteredByPrPoll(events, lane) {
  if (lane?.status !== "changes-requested") return false
  const entry = [...(Array.isArray(events) ? events : [])]
    .reverse()
    .find((event) => event?.after?.status === "changes-requested" && event?.before?.status !== "changes-requested")
  return entry?.details?.transitionEvent === "pr-poll"
}
