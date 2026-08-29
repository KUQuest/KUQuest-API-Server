UPDATE "payment_payouts" AS payout
SET
  "destination_masked_last_four" = account."masked_last_four",
  "destination_masked_routing_value" = account."masked_routing_value"
FROM "payment_payout_accounts" AS account
WHERE payout."payout_account_id" = account."id";
