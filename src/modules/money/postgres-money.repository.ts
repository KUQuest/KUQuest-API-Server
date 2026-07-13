/* oxlint-disable typescript/no-unsafe-type-assertion -- Bun SQL rows are typed at this database boundary. */
import { SQL, type TransactionSQL } from 'bun';

import { MoneyError } from './money.errors';
import type {
  ActivityPage,
  ConvertEarningsCommand,
  EarningsConversion,
  ListActivitiesQuery,
  MoneyPolicy,
  MoneyRepository,
  ProviderWebhook,
  WalletActivity,
  WalletSummary,
} from './money.types';

interface WalletRow {
  id: string;
  spending_balance: number;
  earnings_balance: number;
  held_for_jobs: number;
  reserved_for_payouts: number;
  status: 'ACTIVE' | 'FROZEN';
  updated_at: Date | string;
}

interface PolicyRow {
  revision: number;
  platform_fee_bps: 200;
  high_value_resolution_threshold: number;
  top_up_min: number;
  top_up_max: number;
  funded_job_min: number;
  funded_job_max: number;
  earnings_conversion_min: number;
  earnings_conversion_max: number;
  payout_min: number;
  payout_max: number;
  effective_at: Date | string;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const walletSummary = (row: WalletRow): WalletSummary => ({
  id: row.id,
  currency: 'THB',
  spending_balance: row.spending_balance,
  earnings_balance: row.earnings_balance,
  held_for_jobs: row.held_for_jobs,
  reserved_for_payouts: row.reserved_for_payouts,
  status: row.status,
  as_of: iso(row.updated_at),
});

const earningsConversionFromJson = (value: unknown): EarningsConversion => {
  const candidate =
    typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !('id' in candidate) ||
    typeof candidate.id !== 'string' ||
    !('amount' in candidate) ||
    typeof candidate.amount !== 'number' ||
    !('currency' in candidate) ||
    candidate.currency !== 'THB' ||
    !('earnings_balance_after' in candidate) ||
    typeof candidate.earnings_balance_after !== 'number' ||
    !('spending_balance_after' in candidate) ||
    typeof candidate.spending_balance_after !== 'number' ||
    !('created_at' in candidate) ||
    typeof candidate.created_at !== 'string'
  ) {
    throw new Error('Stored idempotency response is invalid.');
  }

  return {
    id: candidate.id,
    amount: candidate.amount,
    currency: 'THB',
    earnings_balance_after: candidate.earnings_balance_after,
    spending_balance_after: candidate.spending_balance_after,
    created_at: candidate.created_at,
  };
};

export class PostgresMoneyRepository implements MoneyRepository {
  constructor(private readonly database: SQL) {}

  async getWallet(userId: string): Promise<WalletSummary> {
    await this.database`
      INSERT INTO wallets (id, user_id)
      VALUES (${`wal_${crypto.randomUUID()}`}, ${userId})
      ON CONFLICT (user_id) DO NOTHING
    `;
    const [wallet] = (await this.database`
      SELECT id, spending_balance, earnings_balance, held_for_jobs,
             reserved_for_payouts, status, updated_at
      FROM wallets WHERE user_id = ${userId}
    `) as WalletRow[];
    if (!wallet) throw new Error('Failed to create or load wallet.');
    return walletSummary(wallet);
  }

  async getPolicy(): Promise<MoneyPolicy> {
    const [row] = (await this.database`
      SELECT * FROM money_policies ORDER BY revision DESC LIMIT 1
    `) as PolicyRow[];
    if (!row) throw new Error('Money policy is not configured.');

    return {
      revision: row.revision,
      currency: 'THB',
      platform_fee_bps: row.platform_fee_bps,
      fee_rounding: 'UP_TO_WHOLE_BAHT',
      quote_ttl_seconds: 300,
      review_window_seconds: 86400,
      default_application_window_seconds: 604800,
      high_value_resolution_threshold: row.high_value_resolution_threshold,
      limits: {
        top_up: { minimum: row.top_up_min, maximum: row.top_up_max },
        funded_job: {
          minimum: row.funded_job_min,
          maximum: row.funded_job_max,
        },
        earnings_conversion: {
          minimum: row.earnings_conversion_min,
          maximum: row.earnings_conversion_max,
        },
        payout: { minimum: row.payout_min, maximum: row.payout_max },
      },
      effective_at: iso(row.effective_at),
    };
  }

  async listActivities(
    userId: string,
    query: ListActivitiesQuery,
  ): Promise<ActivityPage> {
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new MoneyError(422, 'VALIDATION_FAILED', 'Cursor is invalid.');
    }

    const rows = (await this.database`
      SELECT id, type, title, status, spending_delta, earnings_delta,
             held_jobs_delta, reserved_payouts_delta, currency,
             occurred_at, resource_type, resource_id
      FROM wallet_activities
      WHERE user_id = ${userId}
        AND (${query.type ?? null}::text IS NULL OR type = ${query.type ?? null})
        AND (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${query.limit + 1} OFFSET ${offset}
    `) as Array<{
      id: string;
      type: WalletActivity['type'];
      title: string;
      status: string;
      spending_delta: number;
      earnings_delta: number;
      held_jobs_delta: number;
      reserved_payouts_delta: number;
      currency: 'THB';
      occurred_at: Date | string;
      resource_type: WalletActivity['resource']['type'];
      resource_id: string;
    }>;

    const hasNext = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        status: row.status,
        spending_delta: row.spending_delta,
        earnings_delta: row.earnings_delta,
        held_jobs_delta: row.held_jobs_delta,
        reserved_payouts_delta: row.reserved_payouts_delta,
        currency: 'THB',
        occurred_at: iso(row.occurred_at),
        resource: { type: row.resource_type, id: row.resource_id },
      })),
      next_cursor: hasNext ? String(offset + query.limit) : null,
    };
  }

  async convertEarnings(
    command: ConvertEarningsCommand,
  ): Promise<EarningsConversion> {
    return this.database.begin(async (transaction) => {
      const insertedIdempotency = await transaction`
        INSERT INTO idempotency_records (
          actor_id, operation, idempotency_key, request_hash
        ) VALUES (
          ${command.userId}, 'EARNINGS_CONVERSION',
          ${command.idempotencyKey}, ${command.requestHash}
        )
        ON CONFLICT DO NOTHING
        RETURNING idempotency_key
      `;

      if (insertedIdempotency.length === 0) {
        const [existing] = (await transaction`
          SELECT request_hash, response_body
          FROM idempotency_records
          WHERE actor_id = ${command.userId}
            AND operation = 'EARNINGS_CONVERSION'
            AND idempotency_key = ${command.idempotencyKey}
          FOR UPDATE
        `) as Array<{ request_hash: string; response_body: unknown }>;

        if (!existing || existing.request_hash !== command.requestHash) {
          throw new MoneyError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'The idempotency key was already used with a different request.',
          );
        }
        if (!existing.response_body) {
          throw new Error('An idempotent operation did not store its response.');
        }
        return earningsConversionFromJson(existing.response_body);
      }

      await transaction`
        INSERT INTO wallets (id, user_id)
        VALUES (${`wal_${crypto.randomUUID()}`}, ${command.userId})
        ON CONFLICT (user_id) DO NOTHING
      `;
      const [wallet] = (await transaction`
        SELECT id, spending_balance, earnings_balance, held_for_jobs,
               reserved_for_payouts, status, updated_at
        FROM wallets WHERE user_id = ${command.userId}
        FOR UPDATE
      `) as WalletRow[];
      if (!wallet) throw new Error('Failed to create or lock wallet.');
      if (wallet.status === 'FROZEN') {
        throw new MoneyError(423, 'WALLET_FROZEN', 'The wallet is frozen.');
      }

      const policy = await this.getPolicyInTransaction(transaction);
      const range = policy.limits.earnings_conversion;
      if (command.amount < range.minimum || command.amount > range.maximum) {
        throw new MoneyError(
          422,
          'VALIDATION_FAILED',
          `Amount must be between ${range.minimum} and ${range.maximum} THB.`,
        );
      }
      if (wallet.earnings_balance < command.amount) {
        throw new MoneyError(
          422,
          'INSUFFICIENT_EARNINGS_BALANCE',
          'The wallet does not have enough available earnings.',
        );
      }

      const spendingAccountId = `lac_${crypto.randomUUID()}`;
      const earningsAccountId = `lac_${crypto.randomUUID()}`;
      await transaction`
        INSERT INTO ledger_accounts (id, user_id, compartment)
        VALUES (${spendingAccountId}, ${command.userId}, 'SPENDING')
        ON CONFLICT (user_id, compartment) DO NOTHING
      `;
      await transaction`
        INSERT INTO ledger_accounts (id, user_id, compartment)
        VALUES (${earningsAccountId}, ${command.userId}, 'EARNINGS')
        ON CONFLICT (user_id, compartment) DO NOTHING
      `;
      const accounts = (await transaction`
        SELECT id, compartment FROM ledger_accounts
        WHERE user_id = ${command.userId}
          AND compartment IN ('SPENDING', 'EARNINGS')
      `) as Array<{ id: string; compartment: 'SPENDING' | 'EARNINGS' }>;
      const spendingId = accounts.find(
        (account) => account.compartment === 'SPENDING',
      )?.id;
      const earningsId = accounts.find(
        (account) => account.compartment === 'EARNINGS',
      )?.id;
      if (!spendingId || !earningsId) throw new Error('Ledger accounts are missing.');

      const conversionId = `cnv_${crypto.randomUUID()}`;
      const ledgerTransactionId = `ltx_${crypto.randomUUID()}`;
      await transaction`
        INSERT INTO ledger_transactions (
          id, type, actor_user_id, resource_type, resource_id
        ) VALUES (
          ${ledgerTransactionId}, 'EARNINGS_CONVERSION', ${command.userId},
          'CONVERSION', ${conversionId}
        )
      `;
      await transaction`
        INSERT INTO ledger_postings (id, transaction_id, account_id, amount)
        VALUES
          (${`lpo_${crypto.randomUUID()}`}, ${ledgerTransactionId}, ${earningsId}, ${-command.amount}),
          (${`lpo_${crypto.randomUUID()}`}, ${ledgerTransactionId}, ${spendingId}, ${command.amount})
      `;

      const [updated] = (await transaction`
        UPDATE wallets
        SET earnings_balance = earnings_balance - ${command.amount},
            spending_balance = spending_balance + ${command.amount},
            updated_at = now()
        WHERE user_id = ${command.userId}
        RETURNING id, spending_balance, earnings_balance, held_for_jobs,
                  reserved_for_payouts, status, updated_at
      `) as WalletRow[];
      if (!updated) throw new Error('Wallet projection update failed.');

      const now = iso(updated.updated_at);
      const response: EarningsConversion = {
        id: conversionId,
        amount: command.amount,
        currency: 'THB',
        earnings_balance_after: updated.earnings_balance,
        spending_balance_after: updated.spending_balance,
        created_at: now,
      };
      await transaction`
        INSERT INTO wallet_activities (
          id, user_id, type, title, status, spending_delta,
          earnings_delta, resource_type, resource_id, occurred_at
        ) VALUES (
          ${`act_${crypto.randomUUID()}`}, ${command.userId},
          'EARNINGS_CONVERSION', 'Earnings converted to spending', 'SUCCEEDED',
          ${command.amount}, ${-command.amount}, 'CONVERSION', ${conversionId},
          ${now}
        )
      `;
      await transaction`
        UPDATE idempotency_records
        SET response_status = 201,
            response_body = ${JSON.stringify(response)}::text::jsonb,
            completed_at = now()
        WHERE actor_id = ${command.userId}
          AND operation = 'EARNINGS_CONVERSION'
          AND idempotency_key = ${command.idempotencyKey}
      `;

      return response;
    });
  }

  async storeWebhook(
    webhook: ProviderWebhook,
  ): Promise<{ duplicate: boolean }> {
    const inserted = await this.database`
      INSERT INTO provider_webhook_inbox (
        id, provider, event_key, payload_hash, event_type, object_id, payload,
        received_at
      ) VALUES (
        ${`whi_${crypto.randomUUID()}`}, ${webhook.provider}, ${webhook.eventKey},
        ${webhook.payloadHash}, ${webhook.eventType}, ${webhook.objectId},
        ${JSON.stringify(webhook.payload)}::text::jsonb, ${webhook.receivedAt}
      )
      ON CONFLICT (provider, event_key) DO NOTHING
      RETURNING id
    `;
    return { duplicate: inserted.length === 0 };
  }

  private async getPolicyInTransaction(
    transaction: TransactionSQL,
  ): Promise<MoneyPolicy> {
    const [row] = (await transaction`
      SELECT * FROM money_policies ORDER BY revision DESC LIMIT 1
    `) as PolicyRow[];
    if (!row) throw new Error('Money policy is not configured.');

    return {
      revision: row.revision,
      currency: 'THB',
      platform_fee_bps: row.platform_fee_bps,
      fee_rounding: 'UP_TO_WHOLE_BAHT',
      quote_ttl_seconds: 300,
      review_window_seconds: 86400,
      default_application_window_seconds: 604800,
      high_value_resolution_threshold: row.high_value_resolution_threshold,
      limits: {
        top_up: { minimum: row.top_up_min, maximum: row.top_up_max },
        funded_job: {
          minimum: row.funded_job_min,
          maximum: row.funded_job_max,
        },
        earnings_conversion: {
          minimum: row.earnings_conversion_min,
          maximum: row.earnings_conversion_max,
        },
        payout: { minimum: row.payout_min, maximum: row.payout_max },
      },
      effective_at: iso(row.effective_at),
    };
  }
}
