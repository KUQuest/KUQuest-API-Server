# Quest Chat Continuity and Realtime Plan

## Goal

Keep one private conversation between a Hirer and a Member for the same Quest
as the Member moves from Prospective Worker to Worker. Use server WebSocket
events to keep server-owned mobile data current without relying on polling or
manual refresh. Hide Work Conversation membership notices from Members.

## Domain decision

- A Candidate Inquiry Conversation is a private pair conversation identified
  by `(questId, memberId)`. Assignment changes its lifecycle, not its identity
  or Message history.
- A `SINGLE` Quest uses that same conversation for Work Messages and KU bot
  workflow Messages after the Member receives an `ASSIGNMENT_ACTIVE` Assignment.
- A `GROUP` Quest keeps each private conversation for Hirer-to-Worker messages
  and keeps one shared Work Conversation for the Hirer and all Active Workers.
  Private pre-assignment Messages remain visible only to the original pair.
- Other unselected Prospective Workers lose access when the Quest is assigned;
  cancellation closes all private conversations.
- Do not create new `ACCEPTED_PARTICIPANT_JOINED` or `WORKER_DEPARTED`
  Messages. Keep membership changes in the Quest and Chat records; hide legacy
  membership Messages in the mobile client.

## Realtime audit

Already covered by WebSockets: Quest Board, individual Quest snapshots,
Candidate rosters, Hirer Quest summaries, and the open Conversation page.

The audit found these live-update gaps in the mobile source:

- Worker assignment snapshots used by Worker Home, Work Management, and the
  notification coordinator.
- Worker Candidate Application decisions used by foreground notifications,
  which still poll every thirty seconds.

Profile screens and one-time forms keep their explicit refresh/retry behavior;
they do not have a shared server event source or continuous status to stream.
Pull-to-refresh remains available as recovery for the live lists above.

## Implementation sequence

1. Update the API Rulebook, Conversation contract, CONTEXT, and ADR to replace
   the separate-on-assignment rule with the continuity and group privacy rules.
2. Update the API database constraint and Quest-owned membership transition so
   an assigned Member's private conversation keeps its ID and history. Keep
   group Work Conversation membership separate and atomic with Assignment
   creation.
3. Update Candidate Inquiry and Work Chat APIs, WebSocket authorization,
   schemas, OpenAPI/AsyncAPI, and mobile query/route mapping for the transition.
4. Stop writing membership-notice System Messages on the backend and suppress
   old membership notices in the mobile conversation renderer.
5. Add server WebSocket invalidations for Worker assignment changes, Chat inbox
   changes, and Wallet/Top-up changes. Subscribe from the owning mobile query
   modules and invalidate only the affected server state.
6. Review all remaining refresh and polling call sites. Keep refresh controls
   for recovery, remove status polling when an equivalent event stream is
   active, and document screens that have no server event source.
7. Run backend and mobile static checks, focused behavioral tests, and the
   required native development-build smoke flow.

## Implementation status

The first implementation pass on `feat/continuous-quest-chat` adds chat inbox,
Worker Assignment, Wallet, and Top-up invalidation events; chat-screen back
navigation to the inbox; and suppression of legacy join/departure notices. The
backend no longer writes those membership notices for new Membership changes.

The same-Conversation transition remains a schema and API migration. The
current database constraint, Candidate Inquiry write rules, Work Chat
membership model, workflow System Messages, and unread cursors still separate
Candidate Inquiry from Work Chat. The target behavior above must not be treated
as shipped until those contracts and transitions are implemented together.

The audit's remaining polling gap is Worker Candidate Application decisions,
which still poll every thirty seconds because the current recipient event
contract does not address the applicant for every decision transition. Wallet
and Top-up data now resync after commit notifications. Pull-to-refresh remains
available on the live lists as a recovery action.

## Acceptance criteria

- Pressing a visible or Android hardware Back action from a Conversation returns
  to Chat Inbox rather than the main tab.
- For one Quest, a private chat opened before assignment remains the same
  conversation after assignment, with its Message history and unread state.
- A different Quest always has a different private conversation with the same
  Member.
- A newly accepted Worker cannot read another Worker’s private conversation.
- A `GROUP` Quest retains its shared Work Conversation without copying private
  Messages into it.
- New and legacy join/leave membership notices do not appear in Member chat.
- Worker assignment, inbox, and Wallet views update after authorized server
  events without a timed polling loop; manual refresh remains a recovery path.
