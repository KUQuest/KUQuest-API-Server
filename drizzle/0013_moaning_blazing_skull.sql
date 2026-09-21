ALTER TABLE "payment_money_policy_revisions" ALTER COLUMN "platform_fee_bps" SET DATA TYPE smallint;--> statement-breakpoint
ALTER TABLE "payment_money_policy_revisions" ALTER COLUMN "top_up_provider_tax_bps" SET DATA TYPE smallint;--> statement-breakpoint
ALTER TABLE "payment_money_policy_revisions" ALTER COLUMN "payout_provider_tax_bps" SET DATA TYPE smallint;