import { authAccount, authAdmin, authSession, authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import {
  paymentPayoutAccounts,
  paymentPayoutCancellationAttempts,
  paymentPayoutQuotes,
  paymentPayouts,
  paymentPayoutStatusHistory,
  paymentTopUpQuote,
  paymentTopUpStatusHistory,
  paymentTopUp,
} from '@/database/schema/payment.schema';
import {
  profileCertificate,
  profilePortfolioItem,
  profileWorkExperience,
} from '@/database/schema/profile.schema';
import {
  proofSubmission,
  quest,
  questApplication,
  questAssignment,
  questEditHistory,
  questEditRequest,
  questEditRequestResponse,
  questTeam,
  questTeamMember,
  review,
} from '@/database/schema/quest.schema';
import {
  paymentMoneyPolicyRevision,
  walletActivity,
  walletEarningsConversion,
  walletFundingReservation,
  walletFundingReservationSettlement,
  walletIdempotencyKey,
  walletLedgerTransaction,
  walletStatusHistory,
  walletWallet,
} from '@/database/schema/wallet.schema';

import { describe, expect, it } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';

describe('identity columns use native UUID storage', () => {
  it('stores auth_user.id and auth_admin.id as native UUID primary keys', () => {
    expect(getTableColumns(authUser).id.columnType).toBe('PgUUID');
    expect(getTableColumns(authAdmin).id.columnType).toBe('PgUUID');
  });

  it('stores shared better-auth table identity references as native UUIDs', () => {
    const sessionColumns = getTableColumns(authSession);
    const accountColumns = getTableColumns(authAccount);

    expect(sessionColumns.userId.columnType).toBe('PgUUID');
    expect(sessionColumns.adminId.columnType).toBe('PgUUID');
    expect(accountColumns.userId.columnType).toBe('PgUUID');
    expect(accountColumns.adminId.columnType).toBe('PgUUID');
  });

  it('stores every auth_user/auth_admin foreign key as a native UUID', () => {
    const references: Record<string, unknown> = {
      'file.uploaded_by_user_id': getTableColumns(file).uploadedByUserId,
      'profile_certificate.user_id': getTableColumns(profileCertificate).userId,
      'profile_portfolio_item.user_id': getTableColumns(profilePortfolioItem).userId,
      'profile_work_experience.user_id': getTableColumns(profileWorkExperience).userId,
      'quest.hirer_id': getTableColumns(quest).hirerId,
      'quest.cancelled_by_user_id': getTableColumns(quest).cancelledByUserId,
      'quest.cancelled_by_admin_id': getTableColumns(quest).cancelledByAdminId,
      'quest.hidden_by_admin_id': getTableColumns(quest).hiddenByAdminId,
      'review.reviewer_id': getTableColumns(review).reviewerId,
      'review.reviewee_id': getTableColumns(review).revieweeId,
      'quest_edit_request.requested_by_user_id': getTableColumns(questEditRequest).requestedByUserId,
      'quest_edit_request_response.user_id': getTableColumns(questEditRequestResponse).userId,
      'quest_edit_history.edited_by_user_id': getTableColumns(questEditHistory).editedByUserId,
      'quest_edit_history.edited_by_admin_id': getTableColumns(questEditHistory).editedByAdminId,
      'quest_team.leader_id': getTableColumns(questTeam).leaderId,
      'quest_team_member.user_id': getTableColumns(questTeamMember).userId,
      'quest_application.worker_id': getTableColumns(questApplication).workerId,
      'quest_assignment.worker_id': getTableColumns(questAssignment).workerId,
      'proof_submission.worker_id': getTableColumns(proofSubmission).workerId,
      'proof_submission.submitted_by_user_id': getTableColumns(proofSubmission).submittedByUserId,
      'wallet_wallets.user_id': getTableColumns(walletWallet).userId,
      'wallet_status_history.actor_user_id': getTableColumns(walletStatusHistory).actorUserId,
      'wallet_status_history.actor_admin_id': getTableColumns(walletStatusHistory).actorAdminId,
      'wallet_idempotency_keys.principal_user_id': getTableColumns(walletIdempotencyKey).principalUserId,
      'wallet_ledger_transactions.created_by_user_id': getTableColumns(walletLedgerTransaction).createdByUserId,
      'wallet_earnings_conversions.principal_user_id': getTableColumns(walletEarningsConversion).principalUserId,
      'payment_money_policy_revisions.authored_by_admin_id': getTableColumns(paymentMoneyPolicyRevision).authoredByAdminId,
      'wallet_funding_reservations.owner_user_id': getTableColumns(walletFundingReservation).ownerUserId,
      'wallet_funding_reservation_settlements.recipient_user_id': getTableColumns(walletFundingReservationSettlement).recipientUserId,
      'wallet_activities.user_id': getTableColumns(walletActivity).userId,
      'payment_top_up_quotes.user_id': getTableColumns(paymentTopUpQuote).userId,
      'payment_top_ups.user_id': getTableColumns(paymentTopUp).userId,
      'payment_top_up_status_history.actor_user_id': getTableColumns(paymentTopUpStatusHistory).actorUserId,
      'payment_top_up_status_history.actor_admin_id': getTableColumns(paymentTopUpStatusHistory).actorAdminId,
      'payment_payout_accounts.user_id': getTableColumns(paymentPayoutAccounts).userId,
      'payment_payout_quotes.user_id': getTableColumns(paymentPayoutQuotes).userId,
      'payment_payouts.user_id': getTableColumns(paymentPayouts).userId,
      'payment_payout_status_history.actor_user_id': getTableColumns(paymentPayoutStatusHistory).actorUserId,
      'payment_payout_status_history.actor_admin_id': getTableColumns(paymentPayoutStatusHistory).actorAdminId,
      'payment_payout_cancellation_attempts.admin_id': getTableColumns(paymentPayoutCancellationAttempts).adminId,
    };

    for (const [name, column] of Object.entries(references)) {
      expect((column as { columnType: string }).columnType, name).toBe('PgUUID');
    }
  });
});
