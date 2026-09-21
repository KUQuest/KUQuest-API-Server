import {
  platformFeeForReservation,
  positiveSatang,
  readFundingReservation,
  satang,
  settleFundingReservation,
  type Satang,
  type WalletTransaction,
} from '@/modules/wallet';

/** Reads the Quest Escrow of one Quest, hiding that it is a Funding Reservation under the 'quest' caller scope. */
export const readQuestEscrow = (
  tx: WalletTransaction,
  input: { ownerUserId: string; questId: string }
) =>
  readFundingReservation(tx, {
    ownerUserId: input.ownerUserId,
    callerScope: 'quest',
    callerReference: input.questId,
  });

/** Settles each Worker from the Quest Escrow, hiding the Funding Reservation settlement and its lock order. */
export const settleQuestWorkers = async (
  tx: WalletTransaction,
  ownerUserId: string,
  reservationId: string,
  workers: { workerId: string; amountSatang: number }[],
  feeFor: (amount: number, workerId?: string) => Promise<Satang | 0>,
  reference: string
) => {
  let remainingSatang: Satang = satang(0);
  for (const [index, worker] of workers.entries()) {
    const amount = positiveSatang(worker.amountSatang);
    const fee = await feeFor(worker.amountSatang, worker.workerId);
    const settlement = await settleFundingReservation(tx, {
      ownerUserId,
      reservationId,
      settlementReference: `${reference}:${index}:${worker.workerId}`,
      recipientUserId: worker.workerId,
      recipientAmountSatang: amount,
      platformFeeSatang: fee || undefined,
      platformFeeValidation: 'QUEST_ESCROW_SNAPSHOT',
    });
    remainingSatang = settlement.remainingSatang;
  }
  return remainingSatang;
};

/** Releases what remains of the Quest Escrow. The Wallet verb is idempotent and takes the Funding Reservation lock. */
export { releaseFundingReservation as releaseQuestEscrow } from '@/modules/wallet';

/** Answers whether the Hirer can fund the Quest, from the Wallet Spending Balance capacity verdict. */
export { fundingCapacityFor as questFundingCapacity } from '@/modules/wallet';

/** Quotes the per-slot Platform Fee, falling back to the Funding Reservation Money Policy when publish stored none. */
export const platformFeeForQuest = (
  tx: WalletTransaction,
  current: { platformFeePerWorkerSatang: number | null },
  reservation: { reservationId: string },
  rewardSatang: number
) =>
  current.platformFeePerWorkerSatang === null
    ? platformFeeForReservation(tx, {
        reservationId: reservation.reservationId,
        rewardSatang,
      })
    : satang(current.platformFeePerWorkerSatang);
