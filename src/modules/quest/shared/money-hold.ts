/** Admin Rulebook: returned Quest funding stays in the Funding Reservation for 7 days. */
export const moneyHoldDurationMs = 7 * 24 * 60 * 60 * 1000;

/**
 * True when the Quest ended with returned funding under the 7-day hold: every
 * `QUEST_FAILED` Quest, and a `QUEST_COMPLETED` Quest with an unpaid slot. The
 * Dispute Case windows and the hold release start at `moneyHoldStartedAt`.
 */
export const isMoneyHoldOpen = <T extends { moneyHoldStartedAt: Date | null }>(
  quest: T
): quest is T & { moneyHoldStartedAt: Date } => quest.moneyHoldStartedAt !== null;
