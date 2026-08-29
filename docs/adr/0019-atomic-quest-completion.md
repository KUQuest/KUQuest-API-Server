# Complete a Quest atomically with payment

When the final required Proof Submission is approved, Quest completion settles all Worker earnings, completes the active Assignments, moves the Quest to `QUEST_COMPLETED`, and makes the Work Conversation read-only in one database transaction. If Wallet settlement or the Work Conversation transition fails, the approval and all other changes roll back together so the Quest cannot appear complete without payment or access closure.
