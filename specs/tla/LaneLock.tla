------------------------------ MODULE LaneLock ------------------------------
\* Bounded model of the designated btrain lane/lock contract (spec 014
\* Phase 1). The model encodes INTENDED behavior only: transitions that the
\* designated prose forbids (final-resolve bypass, unaudited release,
\* close-without-merge to repair-needed) do not exist here. The FR-6
\* harness (test/formal/) compares the implementation against the same
\* contract and ledgers the known drift.
\*
\* Actor authority is encoded by construction: each action exists only for
\* the actor the contract designates, so every behavior TLC explores is an
\* authorized one.
\*
\* Pinned to: specs/014-specula-formal-verification-pilot.md § Normative-source prerequisite
\* Pinned-hash: 69c5e8953670eb60a608ac0966b0e9b092db89f91b95d99f3c37059115035d8d
EXTENDS Naturals

\* Pilot bounds (tla-author: small by design; widen only after this passes).
Lanes == {"x", "y"}
Agents == {"alpha", "beta", "gamma"}
NoAgent == "none"

\* Abstract lock paths. "pa" nests under "pnested", so they conflict; "pb"
\* is disjoint (spec 002 Lock Enforcement: prefix overlap conflicts).
Paths == {"pa", "pnested", "pb"}
Conflicts(p, q) == p = q \/ {p, q} = {"pa", "pnested"}

\* Lock sets a claim or rescope may request (non-empty by construction).
FileSets == {{"pa"}, {"pnested"}, {"pb"}, {"pa", "pb"}}

Statuses == {"idle", "in-progress", "needs-review", "changes-requested",
             "ready-for-pr", "pr-review", "ready-to-merge", "repair-needed",
             "resolved"}
ActiveStatuses == Statuses \ {"idle", "resolved"}
PrFlowStatuses == {"ready-for-pr", "pr-review", "ready-to-merge"}
TerminalStatuses == {"idle", "resolved"}

VARIABLES
  status,     \* lane -> status string
  owner,      \* lane -> agent or NoAgent
  reviewer,   \* lane -> agent or NoAgent
  locked,     \* lane -> handoff locked-file record (SUBSET Paths)
  registry,   \* lane -> lock-registry entries (SUBSET Paths)
  uncovered,  \* lane -> TRUE after an audited force-release (coverage suspended)
  prLinked    \* lane -> TRUE once a PR is linked

vars == <<status, owner, reviewer, locked, registry, uncovered, prLinked>>

NoConflictWithOthers(l, fs) ==
  \A m \in Lanes \ {l} : \A p \in fs, q \in registry[m] : ~Conflicts(p, q)

Init ==
  /\ status = [l \in Lanes |-> "idle"]
  /\ owner = [l \in Lanes |-> NoAgent]
  /\ reviewer = [l \in Lanes |-> NoAgent]
  /\ locked = [l \in Lanes |-> {}]
  /\ registry = [l \in Lanes |-> {}]
  /\ uncovered = [l \in Lanes |-> FALSE]
  /\ prLinked = [l \in Lanes |-> FALSE]

\* spec 002 CLI Commands: claim requires an idle or resolved lane, files,
\* exclusive locks, and a peer reviewer distinct from the owner.
Claim(l, o, r, fs) ==
  /\ status[l] \in TerminalStatuses
  /\ r # o
  /\ NoConflictWithOthers(l, fs)
  /\ status' = [status EXCEPT ![l] = "in-progress"]
  /\ owner' = [owner EXCEPT ![l] = o]
  /\ reviewer' = [reviewer EXCEPT ![l] = r]
  /\ locked' = [locked EXCEPT ![l] = fs]
  /\ registry' = [registry EXCEPT ![l] = fs]
  /\ uncovered' = [uncovered EXCEPT ![l] = FALSE]
  /\ prLinked' = [prLinked EXCEPT ![l] = FALSE]

\* spec 005 status model / FR-7: the owner hands off from in-progress or,
\* after rework, from changes-requested. Locks are retained.
ToNeedsReview(l) ==
  /\ status[l] \in {"in-progress", "changes-requested"}
  /\ status' = [status EXCEPT ![l] = "needs-review"]
  /\ UNCHANGED <<owner, reviewer, locked, registry, uncovered, prLinked>>

\* spec 005 FR-2/FR-3/FR-5/FR-10: the reviewer returns findings; the lane
\* stays active with the same owner, reviewer, and locks.
RequestChanges(l) ==
  /\ status[l] = "needs-review"
  /\ status' = [status EXCEPT ![l] = "changes-requested"]
  /\ UNCHANGED <<owner, reviewer, locked, registry, uncovered, prLinked>>

\* spec 002 v1.1.2: peer resolve at needs-review is local approval — the
\* reviewer advances the lane to nonterminal ready-for-pr; locks retained.
PeerResolve(l) ==
  /\ status[l] = "needs-review"
  /\ status' = [status EXCEPT ![l] = "ready-for-pr"]
  /\ UNCHANGED <<owner, reviewer, locked, registry, uncovered, prLinked>>

\* spec 002 PR-flow actors: the owner creates or links the PR.
LinkPr(l) ==
  /\ status[l] = "ready-for-pr"
  /\ status' = [status EXCEPT ![l] = "pr-review"]
  /\ prLinked' = [prLinked EXCEPT ![l] = TRUE]
  /\ UNCHANGED <<owner, reviewer, locked, registry, uncovered>>

\* btrain pr poll --apply outcomes (spec 002 PR-flow states).
PrClear(l) ==
  /\ status[l] = "pr-review"
  /\ status' = [status EXCEPT ![l] = "ready-to-merge"]
  /\ UNCHANGED <<owner, reviewer, locked, registry, uncovered, prLinked>>

PrFeedback(l) ==
  /\ status[l] \in {"pr-review", "ready-to-merge"}
  /\ status' = [status EXCEPT ![l] = "changes-requested"]
  /\ UNCHANGED <<owner, reviewer, locked, registry, uncovered, prLinked>>

\* Terminal PR outcomes: merge and close-without-merge are both terminal
\* resolved plus lock release (spec 002 v1.1.2; close is NOT repair-needed).
PrTerminal(l) ==
  /\ prLinked[l]
  /\ status[l] \in PrFlowStatuses \union {"changes-requested"}
  /\ status' = [status EXCEPT ![l] = "resolved"]
  /\ locked' = [locked EXCEPT ![l] = {}]
  /\ registry' = [registry EXCEPT ![l] = {}]
  /\ prLinked' = [prLinked EXCEPT ![l] = FALSE]
  /\ uncovered' = [uncovered EXCEPT ![l] = FALSE]
  /\ UNCHANGED <<owner, reviewer>>

\* Terminal resolve outside the review/PR flow: the owner or reviewer
\* abandons or supersedes the lane. Terminal resolved releases locks.
AbandonResolve(l) ==
  /\ status[l] \in {"in-progress", "changes-requested"}
  /\ status' = [status EXCEPT ![l] = "resolved"]
  /\ locked' = [locked EXCEPT ![l] = {}]
  /\ registry' = [registry EXCEPT ![l] = {}]
  /\ prLinked' = [prLinked EXCEPT ![l] = FALSE]
  /\ uncovered' = [uncovered EXCEPT ![l] = FALSE]
  /\ UNCHANGED <<owner, reviewer>>

\* spec 006 FR-4/FR-20 with the spec 014 designation: repair-needed enters
\* only from an active status, for a workflow-integrity failure; locks are
\* retained.
RepairEnter(l) ==
  /\ status[l] \in ActiveStatuses \ {"repair-needed"}
  /\ status' = [status EXCEPT ![l] = "repair-needed"]
  /\ UNCHANGED <<owner, reviewer, locked, registry, uncovered, prLinked>>

\* spec 006 FR-15 with the spec 014 designation: the responsible actor
\* clears the repair and same-lane work continues.
RepairClear(l) ==
  /\ status[l] = "repair-needed"
  /\ status' = [status EXCEPT ![l] = "in-progress"]
  /\ UNCHANGED <<owner, reviewer, locked, registry, uncovered, prLinked>>

\* spec 014 designation: repair may exit to resolved as a terminal
\* disposition after FR-18 escalation. Terminal release applies.
RepairResolve(l) ==
  /\ status[l] = "repair-needed"
  /\ status' = [status EXCEPT ![l] = "resolved"]
  /\ locked' = [locked EXCEPT ![l] = {}]
  /\ registry' = [registry EXCEPT ![l] = {}]
  /\ prLinked' = [prLinked EXCEPT ![l] = FALSE]
  /\ uncovered' = [uncovered EXCEPT ![l] = FALSE]
  /\ UNCHANGED <<owner, reviewer>>

\* spec 014 rescope designation: the owner replaces the lock set during
\* in-progress or changes-requested (guardian or human during repair per
\* spec 006 FR-20). The new set is non-empty, exclusive, and both records
\* reflect it; a rescope also restores coverage after a force-release.
Rescope(l, fs) ==
  /\ status[l] \in {"in-progress", "changes-requested", "repair-needed"}
  /\ NoConflictWithOthers(l, fs)
  /\ locked' = [locked EXCEPT ![l] = fs]
  /\ registry' = [registry EXCEPT ![l] = fs]
  /\ uncovered' = [uncovered EXCEPT ![l] = FALSE]
  /\ UNCHANGED <<status, owner, reviewer, prLinked>>

\* spec 002 Force-release override + spec 006 FR-2c/FR-2d: an audited,
\* human-confirmed override suspends matching lock coverage. The handoff
\* record keeps its paths; the registry empties; the lane is flagged.
ForceRelease(l) ==
  /\ status[l] \in ActiveStatuses
  /\ ~uncovered[l]
  /\ registry' = [registry EXCEPT ![l] = {}]
  /\ uncovered' = [uncovered EXCEPT ![l] = TRUE]
  /\ UNCHANGED <<status, owner, reviewer, locked, prLinked>>

Next ==
  \/ \E l \in Lanes : \E o \in Agents, r \in Agents, fs \in FileSets : Claim(l, o, r, fs)
  \/ \E l \in Lanes : ToNeedsReview(l)
  \/ \E l \in Lanes : RequestChanges(l)
  \/ \E l \in Lanes : PeerResolve(l)
  \/ \E l \in Lanes : LinkPr(l)
  \/ \E l \in Lanes : PrClear(l)
  \/ \E l \in Lanes : PrFeedback(l)
  \/ \E l \in Lanes : PrTerminal(l)
  \/ \E l \in Lanes : AbandonResolve(l)
  \/ \E l \in Lanes : RepairEnter(l)
  \/ \E l \in Lanes : RepairClear(l)
  \/ \E l \in Lanes : RepairResolve(l)
  \/ \E l \in Lanes : \E fs \in FileSets : Rescope(l, fs)
  \/ \E l \in Lanes : ForceRelease(l)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* Invariants. Each name maps to designated prose (see the mapping table in
\* specs/tla/README.md).

TypeOK ==
  /\ status \in [Lanes -> Statuses]
  /\ owner \in [Lanes -> Agents \union {NoAgent}]
  /\ reviewer \in [Lanes -> Agents \union {NoAgent}]
  /\ locked \in [Lanes -> SUBSET Paths]
  /\ registry \in [Lanes -> SUBSET Paths]
  /\ uncovered \in [Lanes -> BOOLEAN]
  /\ prLinked \in [Lanes -> BOOLEAN]

\* spec 002 Lock Enforcement: no two lanes hold conflicting paths.
Exclusivity ==
  \A l1 \in Lanes : \A l2 \in Lanes \ {l1} :
    \A p \in registry[l1], q \in registry[l2] : ~Conflicts(p, q)

\* spec 002/014: an active lane's registry matches its handoff record,
\* except after a verified audited force-release.
CoverageForActive ==
  \A l \in Lanes :
    (status[l] \in ActiveStatuses /\ ~uncovered[l]) => registry[l] = locked[l]

\* spec 002 v1.1.2: terminal resolved (and idle) hold no registry locks.
TerminalClean ==
  \A l \in Lanes : status[l] \in TerminalStatuses => registry[l] = {}

\* Pilot scope: owner and reviewer separation on active lanes.
ReviewerSeparation ==
  \A l \in Lanes :
    status[l] \in ActiveStatuses =>
      (owner[l] \in Agents /\ reviewer[l] \in Agents /\ reviewer[l] # owner[l])

\* Active lanes require file locks (patchHandoff guard, designated).
ActiveHasLocks ==
  \A l \in Lanes : status[l] \in ActiveStatuses => locked[l] # {}

\* spec 002 v1.1.2 PR-flow retention: locks held through the PR states.
PrFlowRetention ==
  \A l \in Lanes :
    status[l] \in PrFlowStatuses =>
      (locked[l] # {} /\ (~uncovered[l] => registry[l] = locked[l]))

=============================================================================
