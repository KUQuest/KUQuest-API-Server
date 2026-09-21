# Rating Review Contract

Part of the [Quest and Work Chat Rulebook](quest-work-chat-rulebook.md). Defines accepted policy for post-terminal Rating Reviews between Hirers and Workers.

## Availability and eligibility

- A Review becomes available after the Quest enters any Terminal State: `QUEST_COMPLETED`, `QUEST_FAILED`, or `QUEST_CANCELLED`.
- A Review is optional and does not delay or change the terminal Quest result, Assignment state, or money settlement.
- **Review pairs**:
  - The Hirer may review each Worker who has an Assignment.
  - Each Worker may review the Hirer.
  - In a `GROUP` Quest, Reviews are strictly per Hirer/Worker pair; Workers do not review each other.
- **Failed Quest coverage**: Applies equally to a failed Quest after `PROOF_NOT_APPROVED` and after an Admin Review Item is created. A Review does not change the `QUEST_FAILED` result or Admin Review Item.

## Rules and lifecycle

- Each direction is allowed at most once per Quest.
- The author may edit the Review until seven days after the Quest becomes Terminal.
- Reviews cannot be deleted.
- Approved Reviews contribute to the reviewed Member's Reputation.
- In a `GROUP` Quest, the Rating Review page is not shown until the Quest itself becomes Terminal.

## Access points

- A terminal System Message and Push Notification include a Rating Review action link for eligible participants.
- Any eligible Hirer or Worker can open the Rating Review page from Quest Detail or Quest History during the seven-day edit window.
