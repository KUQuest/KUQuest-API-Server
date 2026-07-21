/* oxlint-disable typescript/no-unsafe-type-assertion -- SQL rows are validated at this database boundary. */
import type { Sql, TransactionSql } from 'postgres';

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

type Database = Sql | TransactionSql<Record<string, never>>;

interface WalletRow {
  id: string;
  spending_balance: string;
  earnings_balance: string;
  held_for_jobs: string;
  reserved_for_payouts: string;
  status: 'ACTIVE' | 'FROZEN';
  updated_at: Date | string;
}

interface PolicyRow {
  revision: string;
  platform_fee_bps: string;
  dispute_two_person_threshold_baht: string;
  minimum_top_up_baht: string;
  maximum_top_up_baht: string;
  minimum_funded_job_baht: string;
  maximum_funded_job_baht: string;
  minimum_earnings_conversion_baht: string;
  maximum_earnings_conversion_baht: string;
  minimum_payout_baht: string;
  maximum_payout_baht: string;
  quote_lifetime_seconds: string;
  review_window_seconds: string;
  default_application_window_seconds: string;
  effective_from: Date | string;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const safeInteger = (value: string, field: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${field} exceeds the API safe-integer range.`);
  }
  return parsed;
};

const walletSummary = (row: WalletRow): WalletSummary => ({
  id: row.id,
  currency: 'THB',
  spending_balance: safeInteger(row.spending_balance, 'spending_balance_baht'),
  earnings_balance: safeInteger(row.earnings_balance, 'earnings_balance_baht'),
  held_for_jobs: safeInteger(row.held_for_jobs, 'held_for_jobs_baht'),
  reserved_for_payouts: safeInteger(
    row.reserved_for_payouts,
    'reserved_for_payouts_baht',
  ),
  status: row.status,
  as_of: iso(row.updated_at),
});

const earningsConversionFromJson = (value: unknown): EarningsConversion => {
  const candidate = typeof value === 'string' ? JSON.parse(value) : value;
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

  return candidate as EarningsConversion;
};

export class PostgresMoneyRepository implements MoneyRepository {
  constructor(private readonly database: Sql) {}

  async getWallet(userId: string): Promise<WalletSummary> {
    const [wallet] = (await this.database`
      SELECT wallet.id,
             wallet.spending_balance_baht::text AS spending_balance,
             wallet.earnings_balance_baht::text AS earnings_balance,
             wallet.held_for_jobs_baht::text AS held_for_jobs,
             wallet.reserved_for_payouts_baht::text AS reserved_for_payouts,
             wallet.status, wallet.updated_at
      FROM wallets wallet
      WHERE wallet.user_id = ${userId}
    `) as unknown as WalletRow[];
    if (!wallet) throw new Error('The authenticated user wallet is not provisioned.');
    return walletSummary(wallet);
  }

  async getPolicy(): Promise<MoneyPolicy> {
    return this.getPolicyFrom(this.database);
  }

  private async getPolicyFrom(database: Database): Promise<MoneyPolicy> {
    const [row] = (await database`
      SELECT revision::text AS revision,
             platform_fee_bps::text AS platform_fee_bps,
             dispute_two_person_threshold_baht::text AS dispute_two_person_threshold_baht,
             minimum_top_up_baht::text AS minimum_top_up_baht,
             maximum_top_up_baht::text AS maximum_top_up_baht,
             minimum_funded_job_baht::text AS minimum_funded_job_baht,
             maximum_funded_job_baht::text AS maximum_funded_job_baht,
             minimum_earnings_conversion_baht::text AS minimum_earnings_conversion_baht,
             maximum_earnings_conversion_baht::text AS maximum_earnings_conversion_baht,
             minimum_payout_baht::text AS minimum_payout_baht,
             maximum_payout_baht::text AS maximum_payout_baht,
             quote_lifetime_seconds::text AS quote_lifetime_seconds,
             review_window_seconds::text AS review_window_seconds,
             default_application_window_seconds::text AS default_application_window_seconds,
             effective_from
      FROM money_policy_revisions
      WHERE effective_from <= now()
        AND (effective_until IS NULL OR effective_until > now())
      ORDER BY revision DESC LIMIT 1
    `) as unknown as PolicyRow[];
    if (!row) throw new Error('Money policy is not configured.');
    return this.policyFromRow(row);
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
      SELECT id::text, type,
             spending_delta_baht::text AS spending_delta,
             earnings_delta_baht::text AS earnings_delta,
             job_held_delta_baht::text AS held_jobs_delta,
             payout_reserved_delta_baht::text AS reserved_payouts_delta,
             status, occurred_at, resource_type, resource_id
      FROM wallet_activities
      WHERE user_id = ${userId}
        AND (${query.type ?? null}::text IS NULL OR type = ${query.type ?? null})
        AND (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${query.limit + 1} OFFSET ${offset}
    `) as unknown as Array<{
      id: string;
      type: WalletActivity['type'];
      spending_delta: string;
      earnings_delta: string;
      held_jobs_delta: string;
      reserved_payouts_delta: string;
      status: string;
      occurred_at: Date | string;
      resource_type: WalletActivity['resource']['type'];
      resource_id: string;
    }>;
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.type === 'EARNINGS_CONVERSION'
          ? 'Earnings converted to spending'
          : row.type.toLowerCase().replaceAll('_', ' '),
        status: row.status,
        spending_delta: safeInteger(row.spending_delta, 'spending_delta_baht'),
        earnings_delta: safeInteger(row.earnings_delta, 'earnings_delta_baht'),
        held_jobs_delta: safeInteger(row.held_jobs_delta, 'job_held_delta_baht'),
        reserved_payouts_delta: safeInteger(
          row.reserved_payouts_delta,
          'payout_reserved_delta_baht',
        ),
        currency: 'THB',
        occurred_at: iso(row.occurred_at),
        resource: { type: row.resource_type, id: row.resource_id },
      })),
      next_cursor: rows.length > query.limit ? String(offset + query.limit) : null,
    };
  }

  async convertEarnings(command: ConvertEarningsCommand): Promise<EarningsConversion> {
    return this.database.begin(async (transaction) => {
      const idempotencyId = crypto.randomUUID();
      const inserted = await transaction`
        INSERT INTO idempotency_keys (
          id, principal_user_id, operation_scope, key, request_hash, expires_at
        ) VALUES (
          ${idempotencyId}, ${command.userId}, 'EARNINGS_CONVERSION',
          ${command.idempotencyKey}, ${command.requestHash}, now() + interval '24 hours'
        )
        ON CONFLICT DO NOTHING RETURNING id
      `;
      if (inserted.length === 0) {
        const [existing] = (await transaction`
          SELECT request_hash, response_body
          FROM idempotency_keys
          WHERE principal_user_id = ${command.userId}
            AND operation_scope = 'EARNINGS_CONVERSION'
            AND key = ${command.idempotencyKey}
          FOR UPDATE
        `) as unknown as Array<{ request_hash: string; response_body: unknown }>;
        if (!existing || existing.request_hash !== command.requestHash) {
          throw new MoneyError(409, 'IDEMPOTENCY_CONFLICT',
            'The idempotency key was already used with a different request.');
        }
        if (!existing.response_body) {
          throw new Error('An idempotent operation did not store its response.');
        }
        return earningsConversionFromJson(existing.response_body);
      }

      const [wallet] = (await transaction`
        SELECT id::text,
               spending_balance_baht::text AS spending_balance,
               earnings_balance_baht::text AS earnings_balance,
               held_for_jobs_baht::text AS held_for_jobs,
               reserved_for_payouts_baht::text AS reserved_for_payouts,
               status, updated_at
        FROM wallets WHERE user_id = ${command.userId} FOR UPDATE
      `) as unknown as WalletRow[];
      if (!wallet) throw new Error('The authenticated user wallet is not provisioned.');
      if (wallet.status === 'FROZEN') {
        throw new MoneyError(423, 'WALLET_FROZEN', 'The wallet is frozen.');
      }

      const policy = await this.getPolicyFrom(transaction);
      const range = policy.limits.earnings_conversion;
      if (command.amount < range.minimum || command.amount > range.maximum) {
        throw new MoneyError(422, 'VALIDATION_FAILED',
          `Amount must be between ${range.minimum} and ${range.maximum} THB.`);
      }
      if (safeInteger(wallet.earnings_balance, 'earnings_balance_baht') < command.amount) {
        throw new MoneyError(422, 'INSUFFICIENT_EARNINGS_BALANCE',
          'The wallet does not have enough available earnings.');
      }

      const accounts = (await transaction`
        SELECT id::text, type FROM ledger_accounts
        WHERE wallet_id = ${wallet.id} AND type IN ('SPENDING', 'EARNINGS')
      `) as unknown as Array<{ id: string; type: 'SPENDING' | 'EARNINGS' }>;
      const spendingId = accounts.find((account) => account.type === 'SPENDING')?.id;
      const earningsId = accounts.find((account) => account.type === 'EARNINGS')?.id;
      if (!spendingId || !earningsId) throw new Error('Wallet ledger accounts are not provisioned.');

      const conversionId = crypto.randomUUID();
      const transactionId = crypto.randomUUID();
      const now = new Date().toISOString();
      await transaction`
        INSERT INTO ledger_transactions (
          id, business_reference, event_type, idempotency_key_id,
          created_by_user_id, description
        ) VALUES (
          ${transactionId}, ${`earnings-conversion:${conversionId}`},
          'EARNINGS_CONVERSION', ${idempotencyId}, ${command.userId},
          'Earnings converted to spending balance'
        )
      `;
      await transaction`
        INSERT INTO ledger_postings (transaction_id, account_id, amount_baht)
        VALUES
          (${transactionId}, ${earningsId}, ${-command.amount}),
          (${transactionId}, ${spendingId}, ${command.amount})
      `;
      await transaction`
        UPDATE ledger_transactions SET sealed_at = now() WHERE id = ${transactionId}
      `;
      await transaction`
        INSERT INTO earnings_conversions (
          id, user_id, amount_baht, ledger_transaction_id, created_at
        ) VALUES (${conversionId}, ${command.userId}, ${command.amount}, ${transactionId}, ${now})
      `;
      const [updated] = (await transaction`
        SELECT spending_balance_baht::text AS spending_balance,
               earnings_balance_baht::text AS earnings_balance,
               updated_at
        FROM wallets WHERE id = ${wallet.id}
      `) as unknown as Array<{
        spending_balance: string;
        earnings_balance: string;
        updated_at: Date | string;
      }>;
      if (!updated) throw new Error('Wallet projection update failed.');

      const response: EarningsConversion = {
        id: conversionId,
        amount: command.amount,
        currency: 'THB',
        earnings_balance_after: safeInteger(
          updated.earnings_balance,
          'earnings_balance_baht',
        ),
        spending_balance_after: safeInteger(
          updated.spending_balance,
          'spending_balance_baht',
        ),
        created_at: iso(updated.updated_at),
      };
      await transaction`
        INSERT INTO wallet_activities (
          user_id, type, status, spending_delta_baht, earnings_delta_baht,
          resource_type, resource_id, occurred_at
        ) VALUES (
          ${command.userId}, 'EARNINGS_CONVERSION', 'SUCCEEDED',
          ${command.amount}, ${-command.amount}, 'CONVERSION', ${conversionId}, ${now}
        )
      `;
      await transaction`
        UPDATE idempotency_keys
        SET resource_type = 'CONVERSION', resource_id = ${conversionId},
            response_status = 201, response_body = ${JSON.stringify(response)}::text::jsonb
        WHERE id = ${idempotencyId}
      `;
      return response;
    });
  }

  async storeWebhook(webhook: ProviderWebhook): Promise<{ duplicate: boolean }> {
    const inserted = await this.database`
      INSERT INTO provider_webhook_events (
        provider, provider_event_id, kind, authenticated_at,
        payload, payload_hash, received_at
      ) VALUES (
        ${webhook.provider}, ${webhook.eventKey}, ${webhook.family},
        ${webhook.receivedAt}, ${JSON.stringify(webhook.payload)}::text::jsonb,
        ${webhook.payloadHash}, ${webhook.receivedAt}
      )
      ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id
    `;
    if (inserted.length > 0) return { duplicate: false };

    const [existing] = await this.database`
      SELECT payload_hash FROM provider_webhook_events
      WHERE provider = ${webhook.provider}
        AND provider_event_id = ${webhook.eventKey}
    `;
    if (!existing || existing.payload_hash !== webhook.payloadHash) {
      throw new MoneyError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'The provider event identifier was reused with a different payload.',
      );
    }
    return { duplicate: true };
  }

  private policyFromRow(row: PolicyRow): MoneyPolicy {
    return {
      revision: safeInteger(row.revision, 'revision'),
      currency: 'THB',
      platform_fee_bps: safeInteger(row.platform_fee_bps, 'platform_fee_bps'),
      fee_rounding: 'UP_TO_WHOLE_BAHT',
      quote_ttl_seconds: safeInteger(row.quote_lifetime_seconds, 'quote_lifetime_seconds'),
      review_window_seconds: safeInteger(row.review_window_seconds, 'review_window_seconds'),
      default_application_window_seconds: safeInteger(
        row.default_application_window_seconds,
        'default_application_window_seconds',
      ),
      high_value_resolution_threshold: safeInteger(
        row.dispute_two_person_threshold_baht,
        'dispute_two_person_threshold_baht',
      ),
      limits: {
        top_up: {
          minimum: safeInteger(row.minimum_top_up_baht, 'minimum_top_up_baht'),
          maximum: safeInteger(row.maximum_top_up_baht, 'maximum_top_up_baht'),
        },
        funded_job: {
          minimum: safeInteger(row.minimum_funded_job_baht, 'minimum_funded_job_baht'),
          maximum: safeInteger(row.maximum_funded_job_baht, 'maximum_funded_job_baht'),
        },
        earnings_conversion: {
          minimum: safeInteger(
            row.minimum_earnings_conversion_baht,
            'minimum_earnings_conversion_baht',
          ),
          maximum: safeInteger(
            row.maximum_earnings_conversion_baht,
            'maximum_earnings_conversion_baht',
          ),
        },
        payout: {
          minimum: safeInteger(row.minimum_payout_baht, 'minimum_payout_baht'),
          maximum: safeInteger(row.maximum_payout_baht, 'maximum_payout_baht'),
        },
      },
      effective_at: iso(row.effective_from),
    };
  }
}
