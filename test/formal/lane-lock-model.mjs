// Executable transcription of the designated lane/lock contract for the
// spec 014 FR-6 validation harness.
//
// Contract sources (spec 014 v0.1.9, Exact normative ranges):
//   - spec 002 v1.1.2: Lock Enforcement, PR-flow states and actors,
//     Force-release override, CLI Commands.
//   - spec 005 v0.1.0: Proposed Status Model, FR-1..FR-8, FR-10, FR-11
//     (FR-9 excluded as conflicting prose; spec 002 supersedes it).
//   - spec 006 v0.1.0: FR-2c, FR-2d, FR-4, FR-5, FR-7, FR-15, FR-18, FR-20.
//
// The model encodes the CONTRACT, not the implementation. Where the
// implementation is designated as drift, `mode: "implementation"` mirrors the
// drifted behavior instead, so the harness can hunt for undesignated
// divergences without tripping on the known ones.

export const KNOWN_DRIFTS = Object.freeze({
  // spec 002 v1.1.2: close-without-merge is terminal resolved + lock release.
  // pr-flow.mjs applyPrStatusToHandoff routes it to repair-needed instead.
  closeWithoutMerge: "close-without-merge-routes-to-repair-needed",
  // spec 002 Force-release override + spec 006 FR-2c/FR-2d: coverage may be
  // suspended only after a verified audited override. `releaseLocks` (the
  // `btrain locks release-lane` path) drops registry entries unaudited.
  unauditedRelease: "unaudited-release-lane-suspends-coverage",
  // spec 002 `handoff resolve --final`: not a reviewer bypass of ready-for-pr.
  // `--final` from needs-review or a PR-flow status is drift. Current
  // resolveHandoff honors it as terminal resolved.
  finalFromPrFlow: "final-from-pr-flow-is-drift",
})

const PR_FLOW_STATUSES = new Set(["ready-for-pr", "pr-review", "ready-to-merge"])
const ACTIVE_STATUSES = new Set([
  "in-progress",
  "needs-review",
  "changes-requested",
  "ready-for-pr",
  "pr-review",
  "ready-to-merge",
  "repair-needed",
])

function normalizePath(p) {
  return String(p).trim()
}

// spec 002 Lock Enforcement: a lock covers the exact path and everything
// under it; two paths conflict when either is a prefix directory of the other.
export function pathsConflict(a, b) {
  const aDir = a.endsWith("/") ? a : a + "/"
  const bDir = b.endsWith("/") ? b : b + "/"
  return a === b || a.startsWith(bDir) || b.startsWith(aDir)
}

function emptyLane() {
  return {
    status: "idle",
    owner: "",
    reviewer: "",
    lockedFiles: [],
    prNumber: "",
    // Whether a handoff file exists for the lane. patchHandoff crashes on a
    // never-claimed lane, so the implementation mirror needs this.
    fileExists: false,
    // FR-18 tracking: every workflow-integrity reason seen (the
    // implementation counts history per reason) and whether the contract
    // now expects human escalation (same-reason re-entry).
    repairReasonsSeen: [],
    escalationExpected: false,
    // Canonical reason code carried by the lane (spec 005/006 taxonomies).
    reasonCode: "",
    // spec 006 FR-7: repair responsibility goes to the most recent canonical
    // workflow actor recorded BEFORE the repair transition.
    repairOwner: "",
    lastActor: "",
  }
}

export class LaneLockModel {
  constructor({ lanes, agents, prFlowEnabled = true, mode = "contract" }) {
    this.mode = mode
    this.agents = [...agents]
    this.prFlowEnabled = prFlowEnabled
    this.lanes = new Map(lanes.map((id) => [id, emptyLane()]))
    // registry: [{ path, lane }] — mirrors .btrain/locks.json
    this.registry = []
  }

  lane(id) {
    return this.lanes.get(id)
  }

  registryPaths(laneId) {
    return this.registry
      .filter((l) => l.lane === laneId)
      .map((l) => l.path)
      .sort()
  }

  #reject(reason) {
    return { ok: false, reason }
  }

  #accept() {
    return { ok: true }
  }

  #conflicts(laneId, files) {
    return this.registry.some(
      (lock) => lock.lane !== laneId && files.some((f) => pathsConflict(f, lock.path)),
    )
  }

  #setRegistry(laneId, files) {
    this.registry = this.registry.filter((l) => l.lane !== laneId)
    for (const f of files) this.registry.push({ path: f, lane: laneId })
  }

  #releaseRegistry(laneId) {
    this.registry = this.registry.filter((l) => l.lane !== laneId)
  }

  // In implementation mode the handoff locked-file record and the registry
  // can drift apart (unaudited release). patchHandoff rejects active-status
  // updates while they disagree; requestChanges and peer resolve re-acquire.
  #coverageMismatch(laneId) {
    const s = this.lane(laneId)
    const expected = JSON.stringify([...s.lockedFiles].sort())
    return ACTIVE_STATUSES.has(s.status) && expected !== JSON.stringify(this.registryPaths(laneId))
  }

  #reacquireFromHandoff(laneId) {
    const s = this.lane(laneId)
    if (this.#conflicts(laneId, s.lockedFiles)) return false
    this.#setRegistry(laneId, s.lockedFiles)
    return true
  }

  // Shared effects of an accepted status update: reason-code taxonomy
  // (cleared on non-reason statuses), FR-7 repair-owner assignment (the most
  // recent canonical actor BEFORE the repair transition), and the canonical
  // actor record itself.
  #applyUpdateEffects(s, status, actor, reason) {
    if (status === "repair-needed") {
      s.reasonCode = reason || "invalid-handoff"
      s.repairOwner = s.lastActor || s.owner || actor
    } else {
      s.reasonCode = ""
      s.repairOwner = ""
      if (status === "in-progress") s.escalationExpected = false
    }
    s.lastActor = actor
  }

  // Mirrors inferPeerReviewer's candidate order when the acting agent would
  // otherwise be its own reviewer: explicit > current (≠ actor) > owner >
  // first configured agent ≠ actor.
  #reassignReviewer(s, actor) {
    if (s.reviewer && s.reviewer !== actor) return
    const candidates = [s.owner, ...this.agents]
    s.reviewer = candidates.find((a) => a && a !== actor) || ""
  }

  // spec 002 CLI Commands: claim requires an idle or resolved lane, files,
  // and exclusive locks. A reviewer equal to the owner is not designated as
  // invalid: btrain resolves a distinct peer (inferPeerReviewer), so the
  // model mirrors that reassignment in both modes.
  claim({ lane, owner, reviewer, files }) {
    const s = this.lane(lane)
    if (!["idle", "resolved"].includes(s.status)) return this.#reject("lane-not-claimable")
    const normalized = files.map(normalizePath).filter(Boolean)
    if (normalized.length === 0) return this.#reject("files-required")
    if (this.#conflicts(lane, normalized)) return this.#reject("lock-conflict")
    const effectiveReviewer =
      reviewer && reviewer !== owner ? reviewer : this.agents.find((a) => a !== owner) || ""
    if (!effectiveReviewer) return this.#reject("no-distinct-reviewer")
    Object.assign(s, {
      status: "in-progress",
      owner,
      reviewer: effectiveReviewer,
      lockedFiles: [...normalized].sort(),
      prNumber: "",
      fileExists: true,
      // repairReasonsSeen deliberately NOT reset: the implementation counts
      // repair history from the lane's event log, which spans re-claims.
      // Whether the FR-18 budget should span tasks is a designation question
      // recorded in the README ledger.
      escalationExpected: false,
      reasonCode: "",
      repairOwner: "",
      lastActor: owner,
    })
    this.#setRegistry(lane, normalized)
    return this.#accept()
  }

  // spec 002 PR-flow states and actors + spec 005 FR-7 / FR-11.
  update({ lane, actor, status, pr, reason }) {
    const s = this.lane(lane)
    if (status === "resolved") return this.#reject("resolved-via-update-forbidden")
    if (this.mode === "implementation" && this.#coverageMismatch(lane)) {
      return this.#reject("lock-state-mismatch")
    }

    // Implementation mirror: patchHandoff validates the target status name,
    // the lock-state sync, and reason codes — but not the source status and
    // not the acting agent. Any modeled target is accepted from any status.
    // On a never-claimed lane it crashes reading the missing handoff file.
    if (this.mode === "implementation") {
      if (!s.fileExists) return this.#reject("no-handoff-file")
      if (this.#coverageMismatch(lane)) return this.#reject("lock-state-mismatch")
      // Every modeled update target is an active status: patchHandoff
      // requires locked files and re-acquires them from the handoff record.
      if (s.lockedFiles.length === 0) return this.#reject("active-status-needs-locks")
      if (this.#conflicts(lane, s.lockedFiles)) return this.#reject("lock-conflict")
      this.#setRegistry(lane, s.lockedFiles)
      s.status = status
      if (status === "needs-review") this.#reassignReviewer(s, actor)
      this.#applyUpdateEffects(s, status, actor, reason)
      if (pr) s.prNumber = String(pr)
      return this.#accept()
    }

    if (status === "needs-review") {
      // Writer hands off: from in-progress (spec 005 status model) or from
      // changes-requested (FR-7 clean re-handoff). Owner acts.
      if (!["in-progress", "changes-requested"].includes(s.status)) {
        return this.#reject("needs-review-from-invalid-status")
      }
      if (actor !== s.owner) return this.#reject("needs-review-requires-owner")
      s.status = "needs-review"
      this.#applyUpdateEffects(s, status, actor, reason)
      return this.#accept()
    }

    if (status === "pr-review") {
      // Owner links or creates the PR after local approval (spec 002).
      if (s.status !== "ready-for-pr") return this.#reject("pr-review-from-invalid-status")
      if (actor !== s.owner) return this.#reject("pr-review-requires-owner")
      s.status = "pr-review"
      this.#applyUpdateEffects(s, status, actor, reason)
      if (pr) s.prNumber = String(pr)
      return this.#accept()
    }

    if (status === "ready-to-merge") {
      // spec 002: entered when required bot feedback is clear, applied by
      // `btrain pr poll --apply` — not by a direct manual update.
      return this.#reject("ready-to-merge-requires-clear-bots")
    }

    if (status === "repair-needed") {
      // spec 006 FR-4: workflow-integrity failures move an active lane to
      // repair-needed. FR-20: locks are retained. FR-18 with the spec 014
      // designation: re-entering for the same unresolved reason exhausts the
      // one-attempt budget, so the contract expects human escalation.
      if (!ACTIVE_STATUSES.has(s.status)) return this.#reject("repair-from-inactive")
      if (reason && s.repairReasonsSeen.includes(reason)) {
        s.escalationExpected = true
      } else if (reason) {
        s.repairReasonsSeen = [...s.repairReasonsSeen, reason]
      }
      s.status = "repair-needed"
      this.#applyUpdateEffects(s, status, actor, reason)
      return this.#accept()
    }

    if (status === "in-progress") {
      // spec 006 FR-15: the responsible actor clears repair-needed.
      if (!["repair-needed", "in-progress", "changes-requested"].includes(s.status)) {
        return this.#reject("in-progress-from-invalid-status")
      }
      if (s.status === "repair-needed") {
        // spec 006 FR-15: the responsible repair actor clears the repair.
        const responsible = s.repairOwner || s.owner
        if (actor !== responsible) return this.#reject("repair-clear-requires-repair-owner")
      } else if (actor !== s.owner) {
        return this.#reject("in-progress-requires-owner")
      }
      s.status = "in-progress"
      // The FR-18 expectation is checked at the escalating re-entry itself;
      // clearing the repair resets it (the reason memory persists).
      this.#applyUpdateEffects(s, status, actor, reason)
      return this.#accept()
    }

    return this.#reject("status-not-modeled")
  }

  // spec 005 FR-2/FR-3/FR-5/FR-10: reviewer returns findings; lane stays
  // active with the same owner, reviewer, and locks; writer acts next.
  requestChanges({ lane, actor }) {
    const s = this.lane(lane)
    if (s.status !== "needs-review") return this.#reject("request-changes-requires-needs-review")
    if (actor !== s.reviewer) return this.#reject("request-changes-requires-reviewer")
    if (this.mode === "implementation" && this.#coverageMismatch(lane)) {
      if (!this.#reacquireFromHandoff(lane)) return this.#reject("reacquire-conflict")
    }
    s.status = "changes-requested"
    // spec 005 FR-4/FR-15: the reviewer's findings and reason code persist
    // in the canonical record. The harness submits a fixed reason.
    s.reasonCode = "spec-mismatch"
    s.lastActor = actor
    return this.#accept()
  }

  // spec 002 v1.1.2: with PR flow enabled, peer resolve at needs-review is
  // local approval — the reviewer advances the lane to nonterminal
  // ready-for-pr and locks are retained. Terminal resolved releases locks.
  resolve({ lane, actor, final }) {
    const s = this.lane(lane)
    // Implementation mirror: resolveHandoff never checks the acting agent
    // against the lane and resolves from any status, including idle.
    if (this.mode === "contract" && s.status === "idle") {
      return this.#reject("resolve-from-idle")
    }

    // spec 002: `--final` from needs-review or PR-flow statuses is drift.
    // Contract rejects it. Implementation still honors it as terminal resolve.
    const prFlowHeld = s.status === "needs-review" || PR_FLOW_STATUSES.has(s.status)
    if (this.mode === "contract" && this.prFlowEnabled && final && prFlowHeld) {
      return this.#reject(KNOWN_DRIFTS.finalFromPrFlow)
    }

    // spec 002 v1.1.2 PR-flow retention: a PR-flow lane terminates through
    // merge or closure, not through a direct plain resolve that would
    // release retained locks early.
    if (this.mode === "contract" && PR_FLOW_STATUSES.has(s.status)) {
      return this.#reject("resolve-from-pr-flow-status")
    }

    if (this.prFlowEnabled && s.status === "needs-review" && !final) {
      if (this.mode === "contract" && actor !== s.reviewer) {
        return this.#reject("ready-for-pr-entry-requires-reviewer")
      }
      if (this.mode === "implementation" && this.#coverageMismatch(lane)) {
        if (!this.#reacquireFromHandoff(lane)) return this.#reject("reacquire-conflict")
      }
      s.status = "ready-for-pr"
      s.fileExists = true
      s.reasonCode = ""
      s.lastActor = actor
      return this.#accept()
    }

    if (this.mode === "contract" && actor !== s.owner && actor !== s.reviewer) {
      return this.#reject("resolve-requires-lane-actor")
    }
    // spec 014 designation: repair-needed exits to resolved only as a
    // terminal disposition after the FR-18 escalation decides the lane will
    // not continue. A premature resolve releases contained locks early.
    if (this.mode === "contract" && s.status === "repair-needed" && !s.escalationExpected) {
      return this.#reject("repair-resolve-before-escalation")
    }
    s.status = "resolved"
    s.lockedFiles = []
    s.fileExists = true
    s.escalationExpected = false
    s.reasonCode = ""
    s.repairOwner = ""
    s.lastActor = actor
    this.#releaseRegistry(lane)
    return this.#accept()
  }

  // spec 002 PR-flow states and actors: outcomes applied from GitHub state.
  prOutcome({ lane, outcome, pr }) {
    const s = this.lane(lane)
    // An explicitly supplied PR (`--pr`) satisfies the linked precondition —
    // the real entry point accepts it. Only the outcomes that route through
    // patchHandoff carrying the PR (feedback, clear, waiting) persist the
    // supplied number on the lane; merged and closed leave the stored link
    // unchanged.
    const suppliedPr = pr ? String(pr) : ""
    if (this.mode === "contract") {
      if (!s.prNumber && !suppliedPr) return this.#reject("no-linked-pr")
      if (!PR_FLOW_STATUSES.has(s.status) && s.status !== "changes-requested") {
        return this.#reject("pr-outcome-from-invalid-status")
      }
    }

    if (outcome === "merged") {
      s.status = "resolved"
      s.lockedFiles = []
      s.fileExists = true
      s.reasonCode = ""
      s.repairOwner = ""
      s.lastActor = s.owner || s.lastActor
      this.#releaseRegistry(lane)
      return this.#accept()
    }

    if (this.mode === "implementation") {
      // Non-merged outcomes route through patchHandoff and inherit its
      // guards: crash on a missing handoff file, rejection while the handoff
      // record and registry disagree, locked files required for every active
      // target, and re-acquisition of the lane's locks.
      if (!s.fileExists) return this.#reject("no-handoff-file")
      if (this.#coverageMismatch(lane)) return this.#reject("lock-state-mismatch")
      if (s.lockedFiles.length === 0) return this.#reject("active-status-needs-locks")
      if (this.#conflicts(lane, s.lockedFiles)) return this.#reject("lock-conflict")
      this.#setRegistry(lane, s.lockedFiles)
    }

    if (outcome === "closed") {
      if (this.mode === "implementation") {
        // KNOWN_DRIFTS.closeWithoutMerge: routed to repair-needed, locks kept.
        s.status = "repair-needed"
        s.reasonCode = "invalid-handoff"
        s.repairOwner = s.lastActor || s.owner
        s.lastActor = s.owner || s.lastActor
        return this.#accept()
      }
      // Contract: close without merge is terminal resolved plus lock release.
      s.status = "resolved"
      s.lockedFiles = []
      s.reasonCode = ""
      s.repairOwner = ""
      s.lastActor = s.owner || s.lastActor
      this.#releaseRegistry(lane)
      return this.#accept()
    }
    if (outcome === "feedback") {
      s.status = "changes-requested"
      s.reasonCode = "pr-review-feedback"
      s.lastActor = s.owner || s.lastActor
      if (suppliedPr && !s.prNumber) s.prNumber = suppliedPr
      return this.#accept()
    }
    if (outcome === "clear") {
      s.status = "ready-to-merge"
      s.reasonCode = ""
      s.lastActor = s.owner || s.lastActor
      if (suppliedPr && !s.prNumber) s.prNumber = suppliedPr
      return this.#accept()
    }
    // waiting
    s.status = "pr-review"
    s.reasonCode = ""
    s.lastActor = s.owner || s.lastActor
    if (suppliedPr && !s.prNumber) s.prNumber = suppliedPr
    return this.#accept()
  }

  // spec 014 rescope designation: `handoff update --files` replaces the
  // lock set. Contract: owner only, during in-progress or changes-requested
  // (guardian or human during repair per spec 006 FR-20 — the agent pool has
  // no guardian, so generated repair rescopes are contract-rejected).
  // Implementation mirror: patchHandoff with --files skips the lock-mismatch
  // guard, requires a non-empty set for active lanes, re-acquires with a
  // conflict check, and updates both records regardless of the actor.
  rescope({ lane, actor, files }) {
    const s = this.lane(lane)
    const normalized = files.map(normalizePath).filter(Boolean)
    if (this.mode === "implementation") {
      if (!s.fileExists) return this.#reject("no-handoff-file")
      if (s.status === "resolved") {
        // patchHandoff computes nextStatus from the current status when
        // --status is absent, and rejects resolved outright.
        return this.#reject("resolved-via-update-forbidden")
      }
      if (!ACTIVE_STATUSES.has(s.status)) {
        // patchHandoff's inactive branch releases both records.
        s.lockedFiles = []
        this.#releaseRegistry(lane)
        return this.#accept()
      }
      if (normalized.length === 0) return this.#reject("active-status-needs-locks")
      if (this.#conflicts(lane, normalized)) return this.#reject("lock-conflict")
      s.lockedFiles = [...normalized].sort()
      this.#setRegistry(lane, normalized)
      return this.#accept()
    }
    if (s.status === "repair-needed") return this.#reject("repair-rescope-requires-guardian")
    if (!["in-progress", "changes-requested"].includes(s.status)) {
      return this.#reject("rescope-from-invalid-status")
    }
    if (actor !== s.owner) return this.#reject("rescope-requires-owner")
    if (normalized.length === 0) return this.#reject("files-required")
    if (this.#conflicts(lane, normalized)) return this.#reject("lock-conflict")
    s.lockedFiles = [...normalized].sort()
    s.lastActor = actor
    this.#setRegistry(lane, normalized)
    return this.#accept()
  }

  // `btrain locks release-lane` without an override grant/consume.
  // Contract: invalid for active lanes (spec 002 Force-release override,
  // spec 006 FR-2c/FR-2d). Implementation: succeeds and leaves the handoff
  // locked-file record behind (KNOWN_DRIFTS.unauditedRelease).
  releaseLane({ lane }) {
    const s = this.lane(lane)
    if (this.mode === "implementation") {
      this.#releaseRegistry(lane)
      return this.#accept()
    }
    if (ACTIVE_STATUSES.has(s.status)) return this.#reject("unaudited-release-forbidden")
    this.#releaseRegistry(lane)
    return this.#accept()
  }

  // Adopt the real system's observed state for one lane after a known,
  // ledgered divergence, so a contract run can keep hunting for unknown
  // divergences on the other lanes (harness tainting).
  adoptReal(laneId, real) {
    const s = this.lane(laneId)
    s.status = real.status
    s.owner = real.owner
    s.reviewer = real.reviewer
    s.lockedFiles = [...real.lockedFiles]
    s.fileExists = true
    this.#setRegistry(laneId, real.registry)
  }

  // Invariants from the designated contract, checked over model state.
  // Lanes in `skip` carry adopted drift and are excluded.
  invariantViolations(skip = new Set()) {
    const violations = []
    for (let i = 0; i < this.registry.length; i++) {
      for (let j = i + 1; j < this.registry.length; j++) {
        const a = this.registry[i]
        const b = this.registry[j]
        if (skip.has(a.lane) || skip.has(b.lane)) continue
        if (a.lane !== b.lane && pathsConflict(a.path, b.path)) {
          violations.push(`exclusivity: ${a.lane}:${a.path} overlaps ${b.lane}:${b.path}`)
        }
      }
    }
    for (const [id, s] of this.lanes) {
      if (skip.has(id)) continue
      const registryPaths = this.registryPaths(id)
      if (ACTIVE_STATUSES.has(s.status) && this.mode === "contract") {
        const expected = JSON.stringify([...s.lockedFiles].sort())
        if (expected !== JSON.stringify(registryPaths)) {
          violations.push(`coverage: lane ${id} ${s.status} lockedFiles != registry`)
        }
      }
      if (["idle", "resolved"].includes(s.status) && registryPaths.length > 0) {
        violations.push(`terminal-clean: lane ${id} ${s.status} still holds registry locks`)
      }
      if (s.status === "needs-review" && (!s.reviewer || s.reviewer === s.owner)) {
        violations.push(`reviewer-separation: lane ${id} reviewer invalid`)
      }
    }
    return violations
  }

  snapshot() {
    const lanes = {}
    for (const [id, s] of this.lanes) {
      lanes[id] = {
        status: s.status,
        owner: s.owner,
        reviewer: s.reviewer,
        reasonCode: s.reasonCode,
        prLinked: Boolean(s.prNumber),
        lockedFiles: [...s.lockedFiles].sort(),
        registry: this.registryPaths(id),
      }
    }
    return lanes
  }
}
