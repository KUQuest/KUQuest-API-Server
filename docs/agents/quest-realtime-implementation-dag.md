# Quest real-time implementation DAG

## Scope and current gate

Source: [Spec: Real-time Quest updates for Hirer and Workers](https://github.com/KUQuest/KUQuest-API-Server/issues/631).

This plan covers API-server implementation and verification with real WebSocket clients. It does not deliver the mobile Quest screen. Business commands stay on REST. Both Quest modes, SINGLE/GROUP, and both required-work paths remain in scope. In `QUEST_OPEN`, only the Hirer and existing `ASSIGNMENT_ACTIVE` Workers receive `ASSIGNMENT_ROSTER_UPDATED`; Candidates and all other open-state updates remain out of scope.

Decision issues #627–#630 are resolved. The #632–#639 API-server changes are implemented in the current working tree. Focused producer and regression checks pass, and independent review is complete. A `ready-for-agent` label does not override the resolved contract.

## Dependency DAG

The table is an adjacency list: every entry in **Required predecessor** must complete before the named ticket starts. These are verified native GitHub dependencies, not new dependencies proposed by this plan.

| Ticket                                                                                                                            | Required predecessor                                                  |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [Define Quest events and recipient-visible data](https://github.com/KUQuest/KUQuest-API-Server/issues/626)                        | None                                                                  |
| [Define Quest stream access and terminal transition rules](https://github.com/KUQuest/KUQuest-API-Server/issues/627)              | None                                                                  |
| [Define Quest reconnect and missed-update recovery](https://github.com/KUQuest/KUQuest-API-Server/issues/628)                     | None                                                                  |
| [Choose Quest delivery architecture and Work Chat boundary](https://github.com/KUQuest/KUQuest-API-Server/issues/629)             | All three decisions above                                             |
| [Finalize the Quest Backend–Frontend contract and acceptance scenarios](https://github.com/KUQuest/KUQuest-API-Server/issues/630) | Choose Quest delivery architecture and Work Chat boundary             |
| [Connect, recover, and deliver roster-only Assignment updates](https://github.com/KUQuest/KUQuest-API-Server/issues/632)          | Finalize the Quest Backend–Frontend contract and acceptance scenarios |
| [Deliver live Start Work updates](https://github.com/KUQuest/KUQuest-API-Server/issues/633)                                       | Connect and recover an authorized Quest view                          |
| [Notify the Hirer when Proof Submission is sent](https://github.com/KUQuest/KUQuest-API-Server/issues/634)                        | Connect and recover an authorized Quest view                          |
| [Deliver Hirer Proof review outcomes](https://github.com/KUQuest/KUQuest-API-Server/issues/635)                                   | Connect and recover an authorized Quest view                          |
| [Deliver automatic Proof approval outcomes](https://github.com/KUQuest/KUQuest-API-Server/issues/636)                             | Connect and recover an authorized Quest view                          |
| [Deliver completion-confirmation updates without Proof](https://github.com/KUQuest/KUQuest-API-Server/issues/637)                 | Connect and recover an authorized Quest view                          |
| [Deliver Quest Edit request and outcome updates](https://github.com/KUQuest/KUQuest-API-Server/issues/638)                        | Connect and recover an authorized Quest view                          |
| [Deliver cancellation and missed-deadline outcomes](https://github.com/KUQuest/KUQuest-API-Server/issues/639)                     | Connect and recover an authorized Quest view                          |

Read the graph in five stages:

1. Event, access, and recovery decisions (#626–#628) are resolved.
2. Delivery architecture (#629) and final contract (#630) are resolved.
3. Parent specification #631 links the final contract.
4. Implement and verify authorized connection, REST recovery, and open-Quest roster-only Assignment updates (#632).
5. Implement and verify the seven source-update tickets (#633–#639) in the coordinated lanes.

The resolved contract in #630, linked from #631, is the implementation source.

## Execution lanes

The implementation followed three coordinated lanes on one working tree. The lanes reduced shared-file edits; they did not change the GitHub dependency graph.

| Lane                 | Suggested sequence                                                       | Ownership                                                                                |
| -------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Proof and completion | Proof sent → Hirer review → automatic approval → completion confirmation | One owner for the shared Proof service and its behavior tests                            |
| Quest lifecycle      | Start Work → cancellation and missed deadlines                           | One owner for lifecycle orchestration, shared transitions, and terminal settlement edits |
| Quest Edit           | Request, response, and expiry updates                                    | One owner for the Quest Edit service and its focused tests                               |

**The three lanes ran concurrently. Do not start seven uncoordinated agents.**

Start Work, Proof, Quest Edit, cancellation, deadline, and roster-only Assignment updates are implemented in the current working tree.

One integration owner controlled changes to the agreed delivery interface, route composition, shared event schemas, and shared fixtures. No new interfaces were added only to simplify parallel work.

### Shared-file rules

Current code evidence:

- `quest-proof-v2.service.ts` contains `submitQuestV2ProofSubmission`, `reviewQuestV2ProofSubmission`, `autoApproveDueQuestV2Proofs`, `confirmQuestV2Completion`, and `failDueAtQuestV2Proofs`. Proof send, review, automatic approval, completion confirmation, and deadline failure can collide here.
- `quest-lifecycle.worker.ts` handles start scheduling, automatic approval, deadline processing, and Quest Edit expiry. All three lanes can need this file.
- `quest-settlement.service.ts` and `quest-transition.service.ts` are shared by completion and terminal outcomes.
- Lifecycle integration tests and Proof behavior tests also have shared ownership risk.

Coordinate these boundaries before concurrent edits:

1. The Proof owner applies deadline-related edits inside the Proof service requested by the lifecycle lane.
2. The lifecycle owner applies worker-orchestration edits requested by the Proof and Quest Edit lanes.
3. Shared settlement and transition edits have one owner. Other lanes request a bounded change rather than modifying the same helper concurrently.
4. The integration owner serializes mutations to shared delivery contracts and shared fixtures. Producer-specific edits can continue in parallel.
5. Isolated branches prevent accidental overwrites but do not remove merge or semantic conflicts. Review overlapping changes before merging.

These are short coordination boundaries, not requirements to finish an entire unrelated ticket first. Reassess exact ownership after the architecture decision; the selected design may remove some overlap.

## Acceptance gates

### Connection and recovery gate

The connection-and-recovery gate is met in the current working tree: the composed application has a real authorized REST recovery path, and focused integration tests cover initial load, reconnect, session/access changes, and API restart. The final contract and shared-file ownership were frozen before producer changes.

### For each producer ticket

- Exercise the real REST command or existing lifecycle-worker entry point.
- Observe the permitted update with real WebSocket clients and confirm the result through authorized REST reads.
- Verify committed-only delivery, recipient privacy, retries, and applicable terminal-access/recovery behavior.
- Keep existing business rules, Work Chat behavior, and REST commands intact.
- Run focused checks on a stable change before closing its ticket. Keep concurrent validation isolated by database fixtures or separate test databases; do not run project-wide suites against a shared, changing checkout.

### Before declaring the feature complete

The integration owner verifies the combined result after all seven producer slices are present on one stable tree. This is a completion gate, not a new issue or a replacement for each slice's verification.

Cover cross-producer races: Hirer review versus automatic approval; completion versus cancellation and dueAt failure; concurrent Quest Edit expiry versus Start Work. Also exercise disconnected terminal transitions, stale or duplicate delivery, privacy, and both modes and participation shapes.

Run the applicable combined checks, formatting/type checks, and independent review on the stable integrated tree. Do not report mobile UI completion from API-client checks.

## Verification status

The stable integrated API tree passed the focused integration checks and independent review.

The API-server implementation is not merged or released. The mobile Quest screen remains out of scope.
