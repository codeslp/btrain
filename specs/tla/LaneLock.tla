------------------------------ MODULE LaneLock ------------------------------
\* Bounded model of the designated btrain lane/lock contract (spec 014
\* Phase 1). The model encodes INTENDED behavior only: transitions that the
\* designated prose forbids (final-resolve bypass, unaudited release,
\* close-without-merge to repair-needed, repair resolution before FR-18
\* escalation) do not exist here. The FR-6 harness (test/formal/) compares
\* the implementation against the same contract and ledgers the known drift.
\*
\* Actor authority is explicit: every agent-driven action takes the acting
\* agent and guards on the actor the contract designates, so the authority
\* rule is a reviewable predicate rather than an omission. Actions driven by
\* GitHub or the watchdog stay actor-free -- spec 014 abstracts those as
\* external events. peerApproved records that a non-owner reviewer approved,
\* which makes PrFlowNeedsPeerApproval checkable. lastActor records the most
\* recent canonical workflow actor (spec 006 FR-7); RepairEnter copies it
\* into repairOwner, and only that actor may clear the repair (FR-15).
\* Rescoping a repair-needed lane is a guardian or human act (FR-20) that the
\* agent pool cannot perform, so the model has no such action; the FR-6
\* harness transcription rejects it the same way.
\*
\* Pinned to: specs/014-specula-formal-verification-pilot.md § Normative-source prerequisite
\* Pinned to: specs/002-multi-lane-handoffs.md § Lock Enforcement
\* Pinned to: specs/002-multi-lane-handoffs.md § PR-flow states and actors
\* Pinned to: specs/002-multi-lane-handoffs.md § Force-release override
\* Pinned to: specs/002-multi-lane-handoffs.md § CLI Commands
\* Pinned to: specs/005-review-findings-rework-loop.md § Proposed Status Model
\* Pinned to: specs/006-workflow-resilience-and-guardian.md § FR-2c: Explicit audited override path
\* Pinned to: specs/006-workflow-resilience-and-guardian.md § FR-2d: Human-confirmed override authority
\* Pinned to: specs/006-workflow-resilience-and-guardian.md § FR-4: `repair-needed` state
\* Pinned to: specs/006-workflow-resilience-and-guardian.md § FR-5: Lane-local freeze by default
\* Pinned to: specs/006-workflow-resilience-and-guardian.md § FR-7: Responsible actor assignment
\* Pinned to: specs/006-workflow-resilience-and-guardian.md § FR-15: Clearing `repair-needed`
\* Pinned to: specs/006-workflow-resilience-and-guardian.md § FR-18: One retry budget before human escalation
\* Pinned to: specs/006-workflow-resilience-and-guardian.md § FR-20: Lock retention during `repair-needed`
\* Pinned-hash: 90cb75546bfdf3d0874a2bbc616fdca16624a48fb356e30daf66f6c63fd613ed
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

\* FR-18 one-attempt budget: 0 = never repaired, 1 = first repair, 2 = a
\* repeat entry that exhausted the budget and escalated to a human.
MaxRepair == 2

VARIABLES
  status,      \* lane -> status string
  owner,       \* lane -> agent or NoAgent
  reviewer,    \* lane -> agent or NoAgent
  locked,      \* lane -> handoff locked-file record (SUBSET Paths)
  registry,    \* lane -> lock-registry entries (SUBSET Paths)
  uncovered,   \* lane -> TRUE after an audited force-release
  prLinked,    \* lane -> TRUE once a PR is linked
  repairCount, \* lane -> 0..MaxRepair repair entries (2 = escalated)
  peerApproved, \* lane -> TRUE after a peer reviewer approved this lane
  lastActor,   \* lane -> most recent canonical workflow actor (FR-7)
  repairOwner, \* lane -> responsible repair actor while repair-needed (FR-7/FR-15)
  approver     \* lane -> the agent whose PeerResolve admitted the lane to the PR flow

vars == <<status, owner, reviewer, locked, registry, uncovered, prLinked,
          repairCount, peerApproved, lastActor, repairOwner, approver>>

\* Authority predicates (spec 002 PR-flow actors; spec 006 FR-7 responsible
\* actor). Named once so the authority rule is reviewable in one place
\* instead of being restated inside each action.
IsOwner(l, a) == a = owner[l]
IsReviewer(l, a) == a = reviewer[l]
IsLaneAgent(l, a) == a \in {owner[l], reviewer[l]}
IsRepairOwner(l, a) == a = repairOwner[l]

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
  /\ repairCount = [l \in Lanes |-> 0]
  /\ peerApproved = [l \in Lanes |-> FALSE]
  /\ lastActor = [l \in Lanes |-> NoAgent]
  /\ repairOwner = [l \in Lanes |-> NoAgent]
  /\ approver = [l \in Lanes |-> NoAgent]

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
  /\ repairCount' = [repairCount EXCEPT ![l] = 0]
  /\ peerApproved' = [peerApproved EXCEPT ![l] = FALSE]
  /\ lastActor' = [lastActor EXCEPT ![l] = o]
  /\ repairOwner' = [repairOwner EXCEPT ![l] = NoAgent]
  /\ approver' = [approver EXCEPT ![l] = NoAgent]

\* spec 005 status model / FR-7: the owner hands off from in-progress or,
\* after rework, from changes-requested. Locks are retained.
ToNeedsReview(l, a) ==
  /\ IsOwner(l, a)
  /\ status[l] \in {"in-progress", "changes-requested"}
  /\ status' = [status EXCEPT ![l] = "needs-review"]
  /\ lastActor' = [lastActor EXCEPT ![l] = a]
  /\ UNCHANGED <<owner, reviewer, locked, registry, uncovered, prLinked,
                 repairCount, peerApproved, repairOwner, approver>>

\* spec 005 FR-2/FR-3/FR-5/FR-10: the reviewer returns findings; the lane
\* stays active with the same owner, reviewer, and locks.
RequestChanges(l, a) ==
  /\ IsReviewer(l, a)
  /\ status[l] = "needs-review"
  /\ status' = [status EXCEPT ![l] = "changes-requested"]
  /\ peerApproved' = [peerApproved EXCEPT ![l] = FALSE]
  /\ approver' = [approver EXCEPT ![l] = NoAgent]
  /\ lastActor' = [lastActor EXCEPT ![l] = a]
  /\ UNCHANGED <<owner, reviewer, locked, registry, uncovered, prLinked,
                 repairCount, repairOwner>>

\* spec 002 v1.1.2: peer resolve at needs-review is local approval — the
\* reviewer advances the lane to nonterminal ready-for-pr; locks retained.
PeerResolve(l, a) ==
  /\ IsReviewer(l, a)
  /\ a # owner[l]
  /\ status[l] = "needs-review"
  /\ status' = [status EXCEPT ![l] = "ready-for-pr"]
  /\ peerApproved' = [peerApproved EXCEPT ![l] = TRUE]
  /\ approver' = [approver EXCEPT ![l] = a]
  /\ lastActor' = [lastActor EXCEPT ![l] = a]
  /\ UNCHANGED <<owner, reviewer, locked, registry, uncovered, prLinked,
                 repairCount, repairOwner>>

\* spec 002 PR-flow actors: the owner creates or links the PR.
LinkPr(l, a) ==
  /\ IsOwner(l, a)
  /\ status[l] = "ready-for-pr"
  /\ status' = [status EXCEPT ![l] = "pr-review"]
  /\ prLinked' = [prLinked EXCEPT ![l] = TRUE]
  /\ lastActor' = [lastActor EXCEPT ![l] = a]
  /\ UNCHANGED <<owner, reviewer, locked, registry, uncovered, repairCount,
                 peerApproved, repairOwner, approver>>

\* btrain pr poll --apply outcomes (spec 002 PR-flow states).
PrClear(l) ==
  /\ status[l] = "pr-review"
  /\ status' = [status EXCEPT ![l] = "ready-to-merge"]
  /\ UNCHANGED <<owner, reviewer, locked, registry, uncovered, prLinked,
                 repairCount, peerApproved, lastActor, repairOwner, approver>>

PrFeedback(l) ==
  /\ status[l] \in {"pr-review", "ready-to-merge"}
  /\ status' = [status EXCEPT ![l] = "changes-requested"]
  /\ peerApproved' = [peerApproved EXCEPT ![l] = FALSE]
  /\ approver' = [approver EXCEPT ![l] = NoAgent]
  /\ UNCHANGED <<owner, reviewer, locked, registry, uncovered, prLinked,
                 repairCount, lastActor, repairOwner>>

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
  /\ repairCount' = [repairCount EXCEPT ![l] = 0]
  /\ peerApproved' = [peerApproved EXCEPT ![l] = FALSE]
  /\ repairOwner' = [repairOwner EXCEPT ![l] = NoAgent]
  /\ approver' = [approver EXCEPT ![l] = NoAgent]
  /\ UNCHANGED <<owner, reviewer, lastActor>>

\* Terminal resolve outside the review/PR flow: the owner or reviewer
\* abandons or supersedes the lane. Terminal resolved releases locks. Once a
\* PR is linked the lane belongs to the PR flow even while GitHub feedback
\* has it in changes-requested; it then terminates only through PrTerminal
\* (spec 002 PR-flow states and actors), never by direct abandonment.
AbandonResolve(l, a) ==
  /\ IsLaneAgent(l, a)
  /\ ~prLinked[l]
  /\ status[l] \in {"in-progress", "changes-requested"}
  /\ status' = [status EXCEPT ![l] = "resolved"]
  /\ locked' = [locked EXCEPT ![l] = {}]
  /\ registry' = [registry EXCEPT ![l] = {}]
  /\ prLinked' = [prLinked EXCEPT ![l] = FALSE]
  /\ uncovered' = [uncovered EXCEPT ![l] = FALSE]
  /\ repairCount' = [repairCount EXCEPT ![l] = 0]
  /\ peerApproved' = [peerApproved EXCEPT ![l] = FALSE]
  /\ lastActor' = [lastActor EXCEPT ![l] = a]
  /\ repairOwner' = [repairOwner EXCEPT ![l] = NoAgent]
  /\ approver' = [approver EXCEPT ![l] = NoAgent]
  /\ UNCHANGED <<owner, reviewer>>

\* spec 006 FR-4/FR-20 with the spec 014 designation: repair-needed enters
\* only from an active status, for a workflow-integrity failure; locks are
\* retained. FR-18: each entry consumes budget; the second entry for the
\* same unresolved problem escalates to a human (repairCount = MaxRepair).
\* FR-7: repair responsibility goes to the most recent canonical workflow
\* actor recorded BEFORE the repair transition, never to the watchdog.
RepairEnter(l) ==
  /\ status[l] \in ActiveStatuses \ {"repair-needed"}
  /\ lastActor[l] # NoAgent
  /\ status' = [status EXCEPT ![l] = "repair-needed"]
  /\ repairCount' = [repairCount EXCEPT
       ![l] = IF repairCount[l] >= MaxRepair THEN MaxRepair
              ELSE repairCount[l] + 1]
  /\ repairOwner' = [repairOwner EXCEPT ![l] = lastActor[l]]
  /\ UNCHANGED <<owner, reviewer, locked, registry, uncovered, prLinked,
                 peerApproved, lastActor, approver>>

\* spec 006 FR-15 with the spec 014 designation: the responsible repair
\* actor (FR-7) clears the repair and same-lane work continues. The other
\* lane agent may not. The budget count persists so a same-problem re-entry
\* escalates.
RepairClear(l, a) ==
  /\ IsRepairOwner(l, a)
  /\ status[l] = "repair-needed"
  /\ status' = [status EXCEPT ![l] = "in-progress"]
  /\ lastActor' = [lastActor EXCEPT ![l] = a]
  /\ repairOwner' = [repairOwner EXCEPT ![l] = NoAgent]
  /\ UNCHANGED <<owner, reviewer, locked, registry, uncovered, prLinked,
                 repairCount, peerApproved, approver>>

\* spec 014 designation: repair may exit to resolved only as a terminal
\* disposition AFTER the FR-18 escalation decides the lane will not
\* continue. The escalation is a human decision; either lane agent may
\* carry out the terminal disposition (the FR-6 transcription accepts the
\* same actors, lane-lock-model.mjs resolve()). Terminal release applies.
RepairResolve(l, a) ==
  /\ IsLaneAgent(l, a)
  /\ status[l] = "repair-needed"
  /\ repairCount[l] >= MaxRepair
  /\ status' = [status EXCEPT ![l] = "resolved"]
  /\ locked' = [locked EXCEPT ![l] = {}]
  /\ registry' = [registry EXCEPT ![l] = {}]
  /\ prLinked' = [prLinked EXCEPT ![l] = FALSE]
  /\ uncovered' = [uncovered EXCEPT ![l] = FALSE]
  /\ repairCount' = [repairCount EXCEPT ![l] = 0]
  /\ peerApproved' = [peerApproved EXCEPT ![l] = FALSE]
  /\ lastActor' = [lastActor EXCEPT ![l] = a]
  /\ repairOwner' = [repairOwner EXCEPT ![l] = NoAgent]
  /\ approver' = [approver EXCEPT ![l] = NoAgent]
  /\ UNCHANGED <<owner, reviewer>>

\* spec 014 rescope designation: the owner replaces the lock set during
\* in-progress or changes-requested. During repair-needed only a guardian
\* or human may rescope (spec 006 FR-20); the agent pool has no such actor,
\* so no repair rescope exists in the model, matching the FR-6 transcription
\* (lane-lock-model.mjs rescope() rejects repair-rescope-requires-guardian).
\* The new set is non-empty, exclusive, and both records reflect it; a
\* rescope also restores coverage after a force-release.
Rescope(l, a, fs) ==
  /\ IsOwner(l, a)
  /\ status[l] \in {"in-progress", "changes-requested"}
  /\ NoConflictWithOthers(l, fs)
  /\ locked' = [locked EXCEPT ![l] = fs]
  /\ registry' = [registry EXCEPT ![l] = fs]
  /\ uncovered' = [uncovered EXCEPT ![l] = FALSE]
  /\ lastActor' = [lastActor EXCEPT ![l] = a]
  /\ UNCHANGED <<status, owner, reviewer, prLinked, repairCount,
                 peerApproved, repairOwner, approver>>

\* spec 002 Force-release override + spec 006 FR-2c/FR-2d: an audited,
\* human-confirmed override suspends matching lock coverage. The handoff
\* record keeps its paths; the registry empties; the lane is flagged.
ForceRelease(l, a) ==
  /\ a \in Agents
  /\ status[l] \in ActiveStatuses
  /\ ~uncovered[l]
  /\ registry' = [registry EXCEPT ![l] = {}]
  /\ uncovered' = [uncovered EXCEPT ![l] = TRUE]
  \* An audited override is not a canonical workflow action (FR-7), so the
  \* requester does not become the responsible actor.
  /\ UNCHANGED <<status, owner, reviewer, locked, prLinked, repairCount,
                 peerApproved, lastActor, repairOwner, approver>>

\* Agent-driven actions quantify over the acting agent; the action's own
\* guard decides whether that agent is authorized. GitHub and watchdog
\* events (PrClear, PrFeedback, PrTerminal, RepairEnter) carry no actor.
Next ==
  \/ \E l \in Lanes : \E o \in Agents, r \in Agents, fs \in FileSets : Claim(l, o, r, fs)
  \/ \E l \in Lanes : \E a \in Agents : ToNeedsReview(l, a)
  \/ \E l \in Lanes : \E a \in Agents : RequestChanges(l, a)
  \/ \E l \in Lanes : \E a \in Agents : PeerResolve(l, a)
  \/ \E l \in Lanes : \E a \in Agents : LinkPr(l, a)
  \/ \E l \in Lanes : PrClear(l)
  \/ \E l \in Lanes : PrFeedback(l)
  \/ \E l \in Lanes : PrTerminal(l)
  \/ \E l \in Lanes : \E a \in Agents : AbandonResolve(l, a)
  \/ \E l \in Lanes : RepairEnter(l)
  \/ \E l \in Lanes : \E a \in Agents : RepairClear(l, a)
  \/ \E l \in Lanes : \E a \in Agents : RepairResolve(l, a)
  \/ \E l \in Lanes : \E a \in Agents, fs \in FileSets : Rescope(l, a, fs)
  \/ \E l \in Lanes : \E a \in Agents : ForceRelease(l, a)

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
  /\ repairCount \in [Lanes -> 0..MaxRepair]
  /\ peerApproved \in [Lanes -> BOOLEAN]
  /\ lastActor \in [Lanes -> Agents \union {NoAgent}]
  /\ repairOwner \in [Lanes -> Agents \union {NoAgent}]
  /\ approver \in [Lanes -> Agents \union {NoAgent}]

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

\* spec 002 v1.1.2 review routing: a lane reaches the PR flow only through
\* PeerResolve, which requires the reviewer to act and to differ from the
\* owner. No lane may sit in the PR flow without that peer approval.
PrFlowNeedsPeerApproval ==
  \A l \in Lanes :
    status[l] \in PrFlowStatuses =>
      /\ peerApproved[l]
      /\ approver[l] = reviewer[l]
      /\ approver[l] # owner[l]

\* Active lanes require file locks (patchHandoff guard, designated).
ActiveHasLocks ==
  \A l \in Lanes : status[l] \in ActiveStatuses => locked[l] # {}

\* spec 002 v1.1.2 PR-flow retention: locks held through the PR states.
PrFlowRetention ==
  \A l \in Lanes :
    status[l] \in PrFlowStatuses =>
      (locked[l] # {} /\ (~uncovered[l] => registry[l] = locked[l]))

\* spec 014 designation of spec 006 FR-18: a repair-needed lane resolves
\* only after the escalation budget is exhausted. Every reachable resolved
\* lane therefore has repairCount 0 (reset on the terminal transition), and
\* no RepairResolve fires below MaxRepair — encoded structurally by the
\* action guard; this invariant pins the count's bounds after resets.
RepairBudgetBounded ==
  \A l \in Lanes : status[l] \in TerminalStatuses => repairCount[l] = 0

\* spec 006 FR-7: a repair-needed lane always has a responsible actor, and
\* that actor is one of the lane's agents (the canonical actors are the
\* owner and reviewer; GitHub, the watchdog, and override requesters never
\* become responsible). Outside repair no actor is assigned.
RepairOwnerAssigned ==
  \A l \in Lanes :
    IF status[l] = "repair-needed"
      THEN repairOwner[l] \in {owner[l], reviewer[l]}
      ELSE repairOwner[l] = NoAgent

\* spec 002 PR-flow states and actors: once a PR is linked, the lane stays
\* active until a GitHub outcome (PrTerminal) or a post-escalation repair
\* disposition (RepairResolve) terminates it and clears the link. No plain
\* agent resolve may abandon a linked lane, so a linked lane is never found in
\* a terminal status. (A linked lane may pass through repair-needed and back:
\* workflow-integrity repair does not unlink the PR.)
LinkedLaneStaysActive ==
  \A l \in Lanes : prLinked[l] => status[l] \in ActiveStatuses

-----------------------------------------------------------------------------
\* Action properties (checked as PROPERTY in LaneLock.cfg). State invariants
\* cannot see a guard that was removed when every terminal action also resets
\* the fields it reads, so these constrain the transitions themselves.

\* spec 014 designation of spec 006 FR-18: a repair-needed lane may only
\* become resolved when the escalation budget was exhausted before the step.
RepairResolveNeedsEscalation ==
  [][\A l \in Lanes :
       (status[l] = "repair-needed" /\ status'[l] = "resolved")
         => repairCount[l] >= MaxRepair]_vars

\* spec 006 FR-15: only the responsible repair actor clears repair-needed;
\* the actor who cleared is the recorded lastActor after the step.
RepairClearByResponsibleActor ==
  [][\A l \in Lanes :
       (status[l] = "repair-needed" /\ status'[l] = "in-progress")
         => lastActor'[l] = repairOwner[l]]_vars

\* spec 006 FR-7: entering repair assigns the most recent canonical actor.
RepairEnterAssignsLastActor ==
  [][\A l \in Lanes :
       (status[l] # "repair-needed" /\ status'[l] = "repair-needed")
         => repairOwner'[l] = lastActor[l]]_vars

\* spec 002 v1.1.2: entry into the PR flow happens only by the assigned
\* reviewer, distinct from the owner, acting on a needs-review lane.
PrFlowEntryByReviewer ==
  [][\A l \in Lanes :
       (status[l] # "ready-for-pr" /\ status'[l] = "ready-for-pr")
         => /\ status[l] = "needs-review"
            /\ approver'[l] = reviewer[l]
            /\ approver'[l] # owner[l]]_vars

\* Every active lane records a canonical actor, and it is a lane agent.
LastActorIsLaneAgent ==
  \A l \in Lanes :
    status[l] \in ActiveStatuses => lastActor[l] \in {owner[l], reviewer[l]}

=============================================================================
