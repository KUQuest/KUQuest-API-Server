/* oxlint-disable typescript/no-unsafe-type-assertion -- SQL rows are validated at this boundary. */
import type { Sql, TransactionSql } from 'postgres';

import { MoneyError } from '@/modules/money/money.errors';
import { sha256, stableJson } from '@/modules/money/money.crypto';

import type {
  PaymentsRepository,
  Payout,
  PayoutAccount,
  PayoutAccountInput,
  PayoutQuote,
  TopUp,
  TopUpQuote,
  XenditClient,
} from './payments.types';

type Database = Sql | TransactionSql<Record<string, never>>;
type Json = Record<string, unknown>;

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const integer = (value: string | number, name: string): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error(`${name} is outside the safe integer range.`);
  return result;
};
const object = (value: unknown): Json | null => {
  if (typeof value === 'string') {
    try {
      return object(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
};
const string = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

interface ParsedWebhook {
  data: Json;
  eventType: string;
  status: string;
  providerReference: string | null;
  reference: string | null;
}

const parseWebhook = (payload: unknown): ParsedWebhook => {
  const root = object(payload);
  const data = object(root?.data) ?? root;
  if (!data) throw new Error('Webhook data is missing.');

  const providerReference =
    string(data.payment_request_id) ??
    string(data.payout_id) ??
    string(data.id);
  const reference = string(data.reference_id);
  if (!providerReference && !reference) {
    throw new Error('Webhook reference is missing.');
  }

  return {
    data,
    eventType: (string(root?.event) ?? 'unknown').toLowerCase(),
    status: (string(data.status) ?? string(root?.status) ?? '').toUpperCase(),
    providerReference,
    reference,
  };
};

interface PolicyRow {
  id: string;
  minimum_top_up: string;
  maximum_top_up: string;
  minimum_payout: string;
  maximum_payout: string;
  quote_seconds: string;
  topup_fee: string;
  topup_tax_bps: string;
  payout_fee: string;
  payout_tax_bps: string;
}

interface TopUpRow {
  id: string;
  internal_reference: string;
  credit_baht: string;
  payment_total_baht: string;
  status: string;
  qr_payload: string | null;
  qr_expires_at: Date | string | null;
  provider_reference: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AccountRow {
  id: string;
  given_name: string;
  surname: string;
  account_holder_name: string;
  account_number: string;
  bank_code: string;
  masked_last_four: string;
  created_at: Date | string;
}

interface PayoutRow {
  id: string;
  provider_reference: string | null;
  principal_baht: string;
  maximum_debit_baht: string;
  status: string;
  destination_bank_code: string;
  destination_account_number: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PayoutQuoteRow extends PayoutAccountInput {
  id: string;
  payout_account_id: string;
  receipt_baht: string;
  maximum_fee_baht: string;
  maximum_tax_baht: string;
  maximum_debit_baht: string;
  consumed_at: Date | string | null;
  expires_at: Date | string;
}

interface TopUpQuoteRow {
  id: string;
  credit_baht: string;
  charged_fee_baht: string;
  charged_tax_baht: string;
  payment_total_baht: string;
  provider_fee_satang: string;
  provider_tax_satang: string;
  provider_total_satang: string;
  consumed_at: Date | string | null;
  expires_at: Date | string;
}

interface TopUpWebhookRow {
  id: string;
  user_id: string;
  internal_reference: string;
  provider_reference: string | null;
  credit_baht: string;
  payment_total_baht: string;
  status: string;
  credited_ledger_transaction_id: string | null;
}

interface PayoutWebhookRow {
  id: string;
  user_id: string;
  provider_reference: string | null;
  principal_baht: string;
  maximum_debit_baht: string;
  quoted_fee_satang: string;
  quoted_tax_satang: string;
  actual_debit_satang: string | null;
  status: string;
  final_ledger_transaction_id: string | null;
}

const validateTopUpWebhook = (
  webhook: ParsedWebhook,
  topUpRow: TopUpWebhookRow,
): void => {
  if (webhook.reference !== topUpRow.internal_reference) {
    throw new Error('Webhook reference does not match the top-up.');
  }
  if (
    !webhook.providerReference ||
    webhook.providerReference !== topUpRow.provider_reference
  ) {
    throw new Error('Webhook provider identifier does not match the top-up.');
  }

  const receivedAmount =
    typeof webhook.data.request_amount === 'number'
      ? webhook.data.request_amount
      : typeof webhook.data.amount === 'number'
        ? webhook.data.amount
        : null;
  if (
    receivedAmount !== integer(topUpRow.payment_total_baht, 'payment_total')
  ) {
    throw new Error('Webhook amount does not match the top-up.');
  }
  if (webhook.data.currency !== 'THB') {
    throw new Error('Webhook currency does not match the top-up.');
  }
};

const validatePayoutWebhook = (
  webhook: ParsedWebhook,
  payoutRow: PayoutWebhookRow,
): void => {
  if (webhook.reference !== `kuquest-payout-${payoutRow.id}`) {
    throw new Error('Webhook reference does not match the payout.');
  }
  if (
    !webhook.providerReference ||
    webhook.providerReference !== payoutRow.provider_reference
  ) {
    throw new Error('Webhook provider identifier does not match the payout.');
  }

  const expectedPrincipal = integer(payoutRow.principal_baht, 'principal_baht');
  const receivedMajor =
    typeof webhook.data.amount === 'number' ? webhook.data.amount : null;
  const receivedMinor =
    typeof webhook.data.source_amount === 'number'
      ? webhook.data.source_amount
      : null;
  if (receivedMajor === null && receivedMinor === null) {
    throw new Error('Webhook payout amount is missing.');
  }
  if (
    (receivedMajor !== null && receivedMajor !== expectedPrincipal) ||
    (receivedMinor !== null && receivedMinor !== expectedPrincipal * 100)
  ) {
    throw new Error('Webhook amount does not match the payout.');
  }

  const currency =
    string(webhook.data.currency) ?? string(webhook.data.source_currency);
  if (currency !== 'THB') {
    throw new Error('Webhook currency does not match the payout.');
  }
  if (
    webhook.eventType.startsWith('v3_payout') &&
    (webhook.data.destination_currency !== 'THB' ||
      webhook.data.destination_amount !== expectedPrincipal * 100)
  ) {
    throw new Error(
      'Webhook destination amount or currency does not match the payout.',
    );
  }
};

interface IdempotencyRow<T> {
  request_hash: string;
  response_status: number | null;
  response_body: T | null;
}

interface IdempotencyCommand {
  userId: string;
  scope: 'TOP_UP_CREATE' | 'PAYOUT_CREATE';
  key: string;
  requestHash: string;
  providerRejectionMessage: string;
  inProgressMessage: string;
}

type IdempotencyClaim<T> = { id: string } | { replay: T };

const topUp = (row: TopUpRow): TopUp => ({
  id: row.id,
  reference: row.internal_reference,
  credit_baht: integer(row.credit_baht, 'credit_baht'),
  payment_total_baht: integer(row.payment_total_baht, 'payment_total_baht'),
  currency: 'THB',
  status: row.status,
  qr_string: row.qr_payload,
  qr_expires_at: row.qr_expires_at ? iso(row.qr_expires_at) : null,
  provider_reference: row.provider_reference,
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
});

const account = (row: AccountRow): PayoutAccount => ({
  id: row.id,
  given_name: row.given_name,
  surname: row.surname,
  account_holder_name: row.account_holder_name,
  bank_code: row.bank_code,
  masked_account_number: `••••${row.masked_last_four}`,
  created_at: iso(row.created_at),
});

const payout = (row: PayoutRow): Payout => ({
  id: row.id,
  reference: `payout:${row.id}`,
  principal_baht: integer(row.principal_baht, 'principal_baht'),
  maximum_debit_baht: integer(row.maximum_debit_baht, 'maximum_debit_baht'),
  currency: 'THB',
  status: row.status,
  destination: {
    bank_code: row.destination_bank_code,
    masked_account_number: `••••${row.destination_account_number.slice(-4)}`,
  },
  provider_reference: row.provider_reference,
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
});

export class PostgresPaymentsRepository implements PaymentsRepository {
  constructor(
    private readonly database: Sql,
    private readonly xendit: XenditClient,
  ) {}

  private async claimIdempotency<T>(
    transaction: Database,
    command: IdempotencyCommand,
  ): Promise<IdempotencyClaim<T>> {
    const id = crypto.randomUUID();
    const inserted = await transaction`
      INSERT INTO idempotency_keys (
        id, principal_user_id, operation_scope, key, request_hash, expires_at
      ) VALUES (
        ${id}, ${command.userId}, ${command.scope}, ${command.key},
        ${command.requestHash}, now() + interval '24 hours'
      )
      ON CONFLICT DO NOTHING RETURNING id
    `;
    if (inserted.length > 0) return { id };

    const [existing] = (await transaction`
      SELECT request_hash, response_status, response_body
      FROM idempotency_keys
      WHERE principal_user_id = ${command.userId}
        AND operation_scope = ${command.scope}
        AND key = ${command.key}
      FOR UPDATE
    `) as unknown as Array<IdempotencyRow<T>>;
    if (!existing || existing.request_hash !== command.requestHash) {
      throw new MoneyError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'The idempotency key was reused with another request.',
      );
    }
    if (existing.response_status === 422) {
      throw new MoneyError(
        422,
        'VALIDATION_FAILED',
        command.providerRejectionMessage,
      );
    }
    if (existing.response_body) return { replay: existing.response_body };
    throw new MoneyError(
      409,
      'IDEMPOTENCY_CONFLICT',
      command.inProgressMessage,
    );
  }

  private async policy(database: Database = this.database): Promise<PolicyRow> {
    const [row] = (await database`
      SELECT id::text, minimum_top_up_baht::text AS minimum_top_up,
        maximum_top_up_baht::text AS maximum_top_up,
        minimum_payout_baht::text AS minimum_payout,
        maximum_payout_baht::text AS maximum_payout,
        quote_lifetime_seconds::text AS quote_seconds,
        top_up_provider_fee_satang::text AS topup_fee,
        top_up_provider_tax_bps::text AS topup_tax_bps,
        payout_provider_fee_satang::text AS payout_fee,
        payout_provider_tax_bps::text AS payout_tax_bps
      FROM money_policy_revisions
      WHERE effective_from <= now() AND (effective_until IS NULL OR effective_until > now())
      ORDER BY revision DESC LIMIT 1
    `) as unknown as PolicyRow[];
    if (!row) throw new Error('Money policy is not configured.');
    return row;
  }

  async createTopUpQuote(
    userId: string,
    creditBaht: number,
  ): Promise<TopUpQuote> {
    const policy = await this.policy();
    const minimum = integer(policy.minimum_top_up, 'minimum_top_up');
    const maximum = integer(policy.maximum_top_up, 'maximum_top_up');
    if (
      !Number.isSafeInteger(creditBaht) ||
      creditBaht < minimum ||
      creditBaht > maximum
    ) {
      throw new MoneyError(
        422,
        'VALIDATION_FAILED',
        `Amount must be between ${minimum} and ${maximum} THB.`,
      );
    }
    const feeSatang = integer(policy.topup_fee, 'topup_fee');
    const taxSatang = Math.ceil(
      (feeSatang * integer(policy.topup_tax_bps, 'topup_tax_bps')) / 10_000,
    );
    const feeBaht = Math.ceil(feeSatang / 100);
    const taxBaht = Math.ceil(taxSatang / 100);
    const total = creditBaht + feeBaht + taxBaht;
    const id = crypto.randomUUID();
    const expiresAt = new Date(
      Date.now() + integer(policy.quote_seconds, 'quote_seconds') * 1000,
    ).toISOString();
    await this.database`
      INSERT INTO top_up_quotes (
        id, user_id, policy_revision_id, credit_baht, charged_fee_baht,
        charged_tax_baht, payment_total_baht, provider_fee_satang,
        provider_tax_satang, provider_total_satang, expires_at
      ) VALUES (
        ${id}, ${userId}, ${policy.id}, ${creditBaht}, ${feeBaht}, ${taxBaht},
        ${total}, ${feeSatang}, ${taxSatang}, ${total * 100}, ${expiresAt}
      )
    `;
    return {
      id,
      credit_baht: creditBaht,
      fee_baht: feeBaht,
      tax_baht: taxBaht,
      payment_total_baht: total,
      currency: 'THB',
      expires_at: expiresAt,
    };
  }

  async createTopUp(
    userId: string,
    quoteId: string,
    idempotencyKey: string,
  ): Promise<TopUp> {
    const requestHash = await sha256(stableJson({ quote_id: quoteId }));
    const prepared = await this.database.begin(async (transaction) => {
      const claim = await this.claimIdempotency<TopUp>(transaction, {
        userId,
        scope: 'TOP_UP_CREATE',
        key: idempotencyKey,
        requestHash,
        providerRejectionMessage: 'Xendit rejected this top-up request.',
        inProgressMessage: 'This top-up request is still being reconciled.',
      });
      if ('replay' in claim) return claim;
      const idempotencyId = claim.id;
      const [quote] = (await transaction`
        SELECT *, id::text, policy_revision_id::text
        FROM top_up_quotes WHERE id=${quoteId} AND user_id=${userId} FOR UPDATE
      `) as unknown as TopUpQuoteRow[];
      if (!quote)
        throw new MoneyError(
          404,
          'NOT_FOUND',
          'The top-up quote was not found.',
        );
      if (
        quote.consumed_at ||
        new Date(quote.expires_at) <= new Date()
      ) {
        throw new MoneyError(
          422,
          'VALIDATION_FAILED',
          'The top-up quote has expired or was already used.',
        );
      }
      const id = crypto.randomUUID();
      const reference = `kuquest-topup-${id}`;
      await transaction`
        INSERT INTO top_ups (
          id, internal_reference, user_id, quote_id, provider, credit_baht,
          charged_fee_baht, charged_tax_baht, payment_total_baht,
          provider_fee_satang, provider_tax_satang, provider_total_satang, status
        ) VALUES (${id},${reference},${userId},${quoteId},'XENDIT',${quote.credit_baht},
          ${quote.charged_fee_baht},${quote.charged_tax_baht},${quote.payment_total_baht},
          ${quote.provider_fee_satang},${quote.provider_tax_satang},${quote.provider_total_satang},'CREATING')
      `;
      await transaction`UPDATE top_up_quotes SET consumed_at=now() WHERE id=${quoteId}`;
      await transaction`INSERT INTO top_up_status_history(top_up_id,to_status,source)
        VALUES (${id},'CREATING','USER')`;
      return {
        id,
        reference,
        amount: integer(quote.payment_total_baht, 'payment_total'),
        idempotencyId,
      };
    });
    if ('replay' in prepared) return prepared.replay;
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    try {
      const provider = await this.xendit.createPromptPay({
        reference: prepared.reference,
        amountBaht: prepared.amount,
        expiresAt,
      });
      return await this.database.begin(async (transaction) => {
        await transaction`UPDATE top_ups SET provider_reference=${provider.paymentRequestId},
          qr_payload=${provider.qrString}, qr_expires_at=${provider.expiresAt},
          status='REQUIRES_ACTION', updated_at=now() WHERE id=${prepared.id}`;
        await transaction`INSERT INTO top_up_status_history(top_up_id,from_status,to_status,provider_status,source)
          VALUES (${prepared.id},'CREATING','REQUIRES_ACTION',${provider.status},'PROVIDER_RESPONSE')`;
        const result = await this.getTopUpIn(transaction, userId, prepared.id);
        await transaction`UPDATE idempotency_keys SET resource_type='TOP_UP', resource_id=${prepared.id},
          response_status=201,response_body=${JSON.stringify(result)}::text::jsonb WHERE id=${prepared.idempotencyId}`;
        return result;
      });
    } catch (error) {
      const next =
        error instanceof MoneyError && error.status === 422
          ? 'FAILED'
          : 'AWAITING_RECONCILIATION';
      await this.database.begin(async (transaction) => {
        await transaction`UPDATE top_ups SET status=${next},updated_at=now() WHERE id=${prepared.id}`;
        await transaction`INSERT INTO top_up_status_history(top_up_id,from_status,to_status,source,reason)
          VALUES(${prepared.id},'CREATING',${next},'PROVIDER_RESPONSE','Xendit did not create an actionable payment request')`;
        if (next === 'FAILED')
          await transaction`UPDATE idempotency_keys SET resource_type='TOP_UP',resource_id=${prepared.id},
          response_status=422,response_body=${JSON.stringify({ error_code: 'PROVIDER_REJECTED' })}::text::jsonb
          WHERE id=${prepared.idempotencyId}`;
      });
      throw error;
    }
  }

  private async getTopUpIn(
    database: Database,
    userId: string,
    topUpId: string,
  ): Promise<TopUp> {
    const [row] =
      (await database`SELECT id::text,internal_reference,credit_baht::text,
      payment_total_baht::text,status,qr_payload,qr_expires_at,provider_reference,created_at,updated_at
      FROM top_ups WHERE id=${topUpId} AND user_id=${userId}`) as unknown as TopUpRow[];
    if (!row)
      throw new MoneyError(404, 'NOT_FOUND', 'The top-up was not found.');
    return topUp(row);
  }
  getTopUp(userId: string, topUpId: string) {
    return this.getTopUpIn(this.database, userId, topUpId);
  }
  async listTopUps(userId: string): Promise<TopUp[]> {
    const rows = (await this
      .database`SELECT id::text,internal_reference,credit_baht::text,
      payment_total_baht::text,status,qr_payload,qr_expires_at,provider_reference,created_at,updated_at
      FROM top_ups WHERE user_id=${userId} ORDER BY created_at DESC LIMIT 50`) as unknown as TopUpRow[];
    return rows.map(topUp);
  }
  async simulateTopUp(userId: string, topUpId: string): Promise<TopUp> {
    const current = await this.getTopUp(userId, topUpId);
    if (!current.provider_reference)
      throw new MoneyError(
        409,
        'PROVIDER_UNAVAILABLE',
        'The top-up has no Xendit reference.',
      );
    await this.xendit.simulatePayment(
      current.provider_reference,
      current.payment_total_baht,
    );
    return this.getTopUp(userId, topUpId);
  }

  async savePayoutAccount(
    userId: string,
    input: PayoutAccountInput,
  ): Promise<PayoutAccount> {
    if (!input.account_number.trim() || !input.bank_code.trim()) {
      throw new MoneyError(
        422,
        'VALIDATION_FAILED',
        'Bank code and account number are required.',
      );
    }
    return this.database.begin(async (transaction) => {
      await transaction`UPDATE payout_accounts SET retired_at=now() WHERE user_id=${userId} AND retired_at IS NULL`;
      const id = crypto.randomUUID();
      const [row] = (await transaction`
        INSERT INTO payout_accounts (id,user_id,recipient_type,given_name,surname,relationship,
          bank_code,account_number,account_holder_name,routing_type,routing_value,masked_last_four)
        VALUES (${id},${userId},'INDIVIDUAL',${input.given_name},${input.surname},'CUSTOMER',
          ${input.bank_code},${input.account_number},${input.account_holder_name},'BANK',${input.bank_code},
          ${input.account_number.slice(-4)})
        RETURNING id::text,given_name,surname,account_holder_name,account_number,bank_code,masked_last_four,created_at
      `) as unknown as AccountRow[];
      if (!row) throw new Error('Payout account was not stored.');
      return account(row);
    });
  }
  private async accountRow(
    userId: string,
    database: Database = this.database,
  ): Promise<AccountRow | null> {
    const [row] =
      (await database`SELECT id::text,given_name,surname,account_holder_name,account_number,
      bank_code,masked_last_four,created_at FROM payout_accounts
      WHERE user_id=${userId} AND retired_at IS NULL`) as unknown as AccountRow[];
    return row ?? null;
  }
  async getPayoutAccount(userId: string): Promise<PayoutAccount | null> {
    const row = await this.accountRow(userId);
    return row ? account(row) : null;
  }

  async createPayoutQuote(
    userId: string,
    receiptBaht: number,
  ): Promise<PayoutQuote> {
    const policy = await this.policy();
    const minimum = integer(policy.minimum_payout, 'minimum_payout');
    const maximum = integer(policy.maximum_payout, 'maximum_payout');
    if (
      !Number.isSafeInteger(receiptBaht) ||
      receiptBaht < minimum ||
      receiptBaht > maximum
    ) {
      throw new MoneyError(
        422,
        'VALIDATION_FAILED',
        `Amount must be between ${minimum} and ${maximum} THB.`,
      );
    }
    const payoutAccount = await this.accountRow(userId);
    if (!payoutAccount)
      throw new MoneyError(
        422,
        'VALIDATION_FAILED',
        'Save a payout account first.',
      );
    const feeSatang = integer(policy.payout_fee, 'payout_fee');
    const taxSatang = Math.ceil(
      (feeSatang * integer(policy.payout_tax_bps, 'payout_tax_bps')) / 10_000,
    );
    const feeBaht = Math.ceil(feeSatang / 100);
    const taxBaht = Math.ceil(taxSatang / 100);
    const maximumDebit = receiptBaht + feeBaht + taxBaht;
    const id = crypto.randomUUID();
    const expiresAt = new Date(
      Date.now() + integer(policy.quote_seconds, 'quote_seconds') * 1000,
    ).toISOString();
    await this
      .database`INSERT INTO payout_quotes(id,user_id,payout_account_id,policy_revision_id,
      receipt_baht,maximum_fee_baht,maximum_tax_baht,maximum_debit_baht,
      quoted_fee_satang,quoted_tax_satang,quoted_debit_satang,expires_at)
      VALUES (${id},${userId},${payoutAccount.id},${policy.id},${receiptBaht},${feeBaht},${taxBaht},
        ${maximumDebit},${feeSatang},${taxSatang},${maximumDebit * 100},${expiresAt})`;
    return {
      id,
      payout_account_id: payoutAccount.id,
      receipt_baht: receiptBaht,
      maximum_fee_baht: feeBaht,
      maximum_tax_baht: taxBaht,
      maximum_debit_baht: maximumDebit,
      currency: 'THB',
      expires_at: expiresAt,
    };
  }

  async createPayout(
    userId: string,
    quoteId: string,
    idempotencyKey: string,
  ): Promise<Payout> {
    const requestHash = await sha256(stableJson({ quote_id: quoteId }));
    const prepared = await this.database.begin(async (transaction) => {
      const claim = await this.claimIdempotency<Payout>(transaction, {
        userId,
        scope: 'PAYOUT_CREATE',
        key: idempotencyKey,
        requestHash,
        providerRejectionMessage: 'Xendit rejected this payout request.',
        inProgressMessage: 'This payout is still being reconciled.',
      });
      if ('replay' in claim) return claim;
      const idempotencyId = claim.id;
      const [quote] =
        (await transaction`SELECT q.*,q.id::text,a.given_name,a.surname,a.account_holder_name,
        a.account_number,a.bank_code FROM payout_quotes q JOIN payout_accounts a ON a.id=q.payout_account_id
        WHERE q.id=${quoteId} AND q.user_id=${userId} FOR UPDATE OF q`) as unknown as PayoutQuoteRow[];
      if (!quote)
        throw new MoneyError(
          404,
          'NOT_FOUND',
          'The payout quote was not found.',
        );
      if (quote.consumed_at || new Date(quote.expires_at) <= new Date()) {
        throw new MoneyError(
          422,
          'VALIDATION_FAILED',
          'The payout quote has expired or was already used.',
        );
      }
      const [wallet] =
        (await transaction`SELECT id::text,status,earnings_balance_baht::text AS earnings
        FROM wallets WHERE user_id=${userId} FOR UPDATE`) as unknown as Array<{
          id: string;
          status: string;
          earnings: string;
        }>;
      if (!wallet) throw new Error('Wallet is not provisioned.');
      if (wallet.status !== 'ACTIVE')
        throw new MoneyError(423, 'WALLET_FROZEN', 'The wallet is frozen.');
      const debit = integer(quote.maximum_debit_baht, 'maximum_debit');
      if (integer(wallet.earnings, 'earnings') < debit)
        throw new MoneyError(
          422,
          'INSUFFICIENT_EARNINGS_BALANCE',
          'The wallet does not have enough available earnings.',
        );
      const accounts =
        (await transaction`SELECT id::text,type FROM ledger_accounts WHERE wallet_id=${wallet.id}
        AND type IN ('EARNINGS','PAYOUT_RESERVED')`) as unknown as Array<{
          id: string;
          type: string;
        }>;
      const earnings = accounts.find((a) => a.type === 'EARNINGS')?.id;
      const reserved = accounts.find((a) => a.type === 'PAYOUT_RESERVED')?.id;
      if (!earnings || !reserved)
        throw new Error('Payout ledger accounts are not provisioned.');
      const id = crypto.randomUUID();
      const ledgerId = crypto.randomUUID();
      await transaction`INSERT INTO ledger_transactions(id,business_reference,event_type,idempotency_key_id,created_by_user_id,description)
        VALUES(${ledgerId},${`payout-reserve:${id}`},'PAYOUT_RESERVE',${idempotencyId},${userId},'Reserve worker earnings for payout')`;
      await transaction`INSERT INTO ledger_postings(transaction_id,account_id,amount_baht) VALUES
        (${ledgerId},${earnings},${-debit}),(${ledgerId},${reserved},${debit})`;
      await transaction`UPDATE ledger_transactions SET sealed_at=now() WHERE id=${ledgerId}`;
      await transaction`INSERT INTO payouts(id,user_id,quote_id,payout_account_id,destination_recipient_type,
        destination_given_name,destination_surname,destination_relationship,destination_account_country,
        destination_account_currency,destination_bank_code,destination_account_number,destination_account_holder_name,
        destination_routing_type,destination_routing_value,provider,principal_baht,maximum_fee_baht,
        maximum_tax_baht,maximum_debit_baht,status,reserve_ledger_transaction_id)
        VALUES(${id},${userId},${quoteId},${quote.payout_account_id},'INDIVIDUAL',${quote.given_name},${quote.surname},
          'CUSTOMER','TH','THB',${quote.bank_code},${quote.account_number},${quote.account_holder_name},'BANK',${quote.bank_code},
          'XENDIT',${quote.receipt_baht},${quote.maximum_fee_baht},${quote.maximum_tax_baht},${debit},'CREATING',${ledgerId})`;
      await transaction`UPDATE payout_quotes SET consumed_at=now() WHERE id=${quoteId}`;
      await transaction`INSERT INTO payout_status_history(payout_id,to_status,actor_user_id,source)
        VALUES(${id},'CREATING',${userId},'USER')`;
      await transaction`INSERT INTO wallet_activities(user_id,type,status,earnings_delta_baht,payout_reserved_delta_baht,resource_type,resource_id)
        VALUES(${userId},'PAYOUT','PENDING',${-debit},${debit},'PAYOUT',${id})`;
      const payoutDestination: PayoutAccountInput = {
        given_name: quote.given_name,
        surname: quote.surname,
        account_holder_name: quote.account_holder_name,
        account_number: quote.account_number,
        bank_code: quote.bank_code,
      };
      return {
        id,
        idemId: idempotencyId,
        debit,
        principal: integer(quote.receipt_baht, 'receipt_baht'),
        account: payoutDestination,
      };
    });
    if ('replay' in prepared) return prepared.replay;
    try {
      const provider = await this.xendit.createPayout({
        reference: `kuquest-payout-${prepared.id}`,
        amountSatang: prepared.principal * 100,
        account: prepared.account,
      });
      return this.database.begin(async (transaction) => {
        await transaction`UPDATE payouts SET provider_reference=${provider.payoutId},status='PENDING',updated_at=now() WHERE id=${prepared.id}`;
        await transaction`INSERT INTO payout_status_history(payout_id,from_status,to_status,provider_status,source)
          VALUES(${prepared.id},'CREATING','PENDING',${provider.status},'PROVIDER_RESPONSE')`;
        const result = await this.getPayoutIn(transaction, userId, prepared.id);
        await transaction`UPDATE idempotency_keys SET resource_type='PAYOUT',resource_id=${prepared.id},response_status=201,
          response_body=${JSON.stringify(result)}::text::jsonb WHERE id=${prepared.idemId}`;
        return result;
      });
    } catch (error) {
      if (error instanceof MoneyError && error.status === 422)
        await this.releaseRejectedPayout(
          userId,
          prepared.id,
          prepared.idemId,
          prepared.debit,
        );
      else
        await this
          .database`UPDATE payouts SET status='AWAITING_RECONCILIATION',updated_at=now() WHERE id=${prepared.id}`;
      throw error;
    }
  }

  private async releaseRejectedPayout(
    userId: string,
    payoutId: string,
    idempotencyId: string,
    amount: number,
  ): Promise<void> {
    await this.database.begin(async (transaction) => {
      const [wallet] =
        (await transaction`SELECT id::text FROM wallets WHERE user_id=${userId} FOR UPDATE`) as unknown as Array<{
          id: string;
        }>;
      const accounts =
        (await transaction`SELECT id::text,type FROM ledger_accounts WHERE wallet_id=${wallet?.id}
        AND type IN ('EARNINGS','PAYOUT_RESERVED')`) as unknown as Array<{
          id: string;
          type: string;
        }>;
      const earnings = accounts.find((item) => item.type === 'EARNINGS')?.id;
      const reserved = accounts.find(
        (item) => item.type === 'PAYOUT_RESERVED',
      )?.id;
      if (!earnings || !reserved)
        throw new Error('Payout release accounts are not provisioned.');
      const ledgerId = crypto.randomUUID();
      await transaction`INSERT INTO ledger_transactions(id,business_reference,event_type,description)
        VALUES(${ledgerId},${`payout-create-rejected:${payoutId}`},'PAYOUT_RELEASE','Release payout rejected before provider acceptance')`;
      await transaction`INSERT INTO ledger_postings(transaction_id,account_id,amount_baht) VALUES
        (${ledgerId},${reserved},${-amount}),(${ledgerId},${earnings},${amount})`;
      await transaction`UPDATE ledger_transactions SET sealed_at=now() WHERE id=${ledgerId}`;
      await transaction`UPDATE payouts SET status='FAILED',final_ledger_transaction_id=${ledgerId},updated_at=now() WHERE id=${payoutId}`;
      await transaction`INSERT INTO payout_status_history(payout_id,from_status,to_status,source,reason)
        VALUES(${payoutId},'CREATING','FAILED','PROVIDER_RESPONSE','Xendit rejected payout creation')`;
      await transaction`INSERT INTO wallet_activities(user_id,type,status,earnings_delta_baht,payout_reserved_delta_baht,resource_type,resource_id)
        VALUES(${userId},'PAYOUT_RELEASE','FAILED',${amount},${-amount},'PAYOUT',${payoutId})`;
      await transaction`UPDATE idempotency_keys SET resource_type='PAYOUT',resource_id=${payoutId},
        response_status=422,response_body=${JSON.stringify({ error_code: 'PROVIDER_REJECTED' })}::text::jsonb
        WHERE id=${idempotencyId}`;
    });
  }

  private async getPayoutIn(
    database: Database,
    userId: string,
    payoutId: string,
  ): Promise<Payout> {
    const [row] =
      (await database`SELECT id::text,provider_reference,principal_baht::text,maximum_debit_baht::text,
      status,destination_bank_code,destination_account_number,created_at,updated_at FROM payouts
      WHERE id=${payoutId} AND user_id=${userId}`) as unknown as PayoutRow[];
    if (!row)
      throw new MoneyError(404, 'NOT_FOUND', 'The payout was not found.');
    return payout(row);
  }
  getPayout(userId: string, payoutId: string) {
    return this.getPayoutIn(this.database, userId, payoutId);
  }
  async listPayouts(userId: string): Promise<Payout[]> {
    const rows = (await this
      .database`SELECT id::text,provider_reference,principal_baht::text,maximum_debit_baht::text,
      status,destination_bank_code,destination_account_number,created_at,updated_at FROM payouts
      WHERE user_id=${userId} ORDER BY created_at DESC LIMIT 50`) as unknown as PayoutRow[];
    return rows.map(payout);
  }

  async processStoredWebhooks(limit = 20): Promise<number> {
    const events = (await this
      .database`SELECT id::text,kind,payload FROM provider_webhook_events
      WHERE status IN ('RECEIVED','RETRYABLE') AND attempts < 5
      ORDER BY received_at LIMIT ${limit}`) as unknown as Array<{
      id: string;
      kind: string;
      payload: unknown;
    }>;
    const results = await Promise.all(
      events.map(async (event) => {
        try {
          const family =
            event.kind === 'payout' || event.kind.includes('payout')
              ? 'payout'
              : 'payment';
          await this.processWebhook(event.id, event.payload, family);
          return true;
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : 'Unknown processing failure';
          await this.database.begin(async (transaction) => {
            const [current] =
              (await transaction`SELECT status,attempts FROM provider_webhook_events WHERE id=${event.id} FOR UPDATE`) as unknown as Array<{
                status: string;
                attempts: number;
              }>;
            if (!current) return;
            const next =
              current.attempts + 1 >= 5 ? 'DEAD_LETTER' : 'RETRYABLE';
            await transaction`UPDATE provider_webhook_events SET status=${next},last_error=${message.slice(0, 500)},attempts=attempts+1 WHERE id=${event.id}`;
            await transaction`INSERT INTO provider_webhook_event_status_history(event_id,from_status,to_status,reason,error)
            VALUES(${event.id},${current.status},${next},'Webhook processing failed',${message.slice(0, 500)})`;
          });
          return false;
        }
      }),
    );
    return results.filter(Boolean).length;
  }

  private async processWebhook(
    eventId: string,
    payload: unknown,
    family: 'payment' | 'payout',
  ): Promise<void> {
    await this.database.begin(async (transaction) => {
      const [claimed] =
        (await transaction`UPDATE provider_webhook_events SET status='PROCESSING',claimed_at=now(),attempts=attempts+1
        WHERE id=${eventId} AND status IN ('RECEIVED','RETRYABLE') RETURNING id`) as unknown as Array<{
          id: string;
        }>;
      if (!claimed) return;
      const webhook = parseWebhook(payload);
      const [topup] =
        family === 'payment'
          ? ((await transaction`SELECT id::text,user_id,internal_reference,provider_reference,credit_baht::text,payment_total_baht::text,currency,status,credited_ledger_transaction_id
            FROM top_ups WHERE provider_reference=${webhook.providerReference} OR internal_reference=${webhook.reference} FOR UPDATE`) as unknown as TopUpWebhookRow[])
          : [];
      if (topup) {
        validateTopUpWebhook(webhook, topup);
        await this.applyTopUpWebhook(transaction, topup, webhook.status);
      } else {
        if (family !== 'payout') {
          throw new Error('Payment webhook does not match a KUQuest top-up.');
        }
        const [out] =
          (await transaction`SELECT payout.id::text,payout.user_id,payout.provider_reference,
          payout.principal_baht::text,payout.maximum_debit_baht::text,payout.currency,payout.status,
          payout.actual_debit_satang::text,payout.final_ledger_transaction_id,
          quote.quoted_fee_satang::text,quote.quoted_tax_satang::text
          FROM payouts payout JOIN payout_quotes quote ON quote.id=payout.quote_id
          WHERE payout.provider_reference=${webhook.providerReference} OR ${webhook.reference}=${`kuquest-payout-`}||payout.id::text
          FOR UPDATE OF payout`) as unknown as PayoutWebhookRow[];
        if (!out)
          throw new Error('Webhook does not match a KUQuest operation.');
        validatePayoutWebhook(webhook, out);
        await this.applyPayoutWebhook(transaction, out, webhook.status);
      }
      await transaction`UPDATE provider_webhook_events SET status='PROCESSED',processed_at=now(),last_error=NULL WHERE id=${eventId}`;
      await transaction`INSERT INTO provider_webhook_event_status_history(event_id,from_status,to_status,reason)
        VALUES(${eventId},'PROCESSING','PROCESSED','Applied to the matching money operation')`;
    });
  }

  private async applyTopUpWebhook(
    transaction: TransactionSql<Record<string, never>>,
    row: TopUpWebhookRow,
    status: string,
  ) {
    const failed =
      status === 'FAILED' || status === 'EXPIRED' || status === 'CANCELLED';
    if (failed) {
      if (
        row.credited_ledger_transaction_id ||
        row.status === 'SUCCEEDED' ||
        row.status === status
      )
        return;
      const next = status === 'EXPIRED' ? 'EXPIRED' : 'FAILED';
      await transaction`UPDATE top_ups SET status=${next},updated_at=now() WHERE id=${row.id}`;
      await transaction`INSERT INTO top_up_status_history(top_up_id,from_status,to_status,provider_status,source)
        VALUES(${row.id},${row.status},${next},${status},'WEBHOOK')`;
      return;
    }
    if (status !== 'SUCCEEDED' && status !== 'COMPLETED' && status !== 'PAID')
      return;
    if (row.credited_ledger_transaction_id) return;
    const [wallet] =
      (await transaction`SELECT id::text FROM wallets WHERE user_id=${row.user_id}`) as unknown as Array<{
        id: string;
      }>;
    const accounts =
      (await transaction`SELECT id::text,type FROM ledger_accounts WHERE
      (wallet_id=${wallet?.id} AND type='SPENDING') OR code='SYSTEM:PROVIDER_ASSET'`) as unknown as Array<{
        id: string;
        type: string;
      }>;
    const spending = accounts.find((a) => a.type === 'SPENDING')?.id;
    const asset = accounts.find((a) => a.type === 'PROVIDER_ASSET')?.id;
    if (!spending || !asset)
      throw new Error('Top-up ledger accounts are missing.');
    const amount = integer(row.credit_baht, 'credit');
    const ledgerId = crypto.randomUUID();
    await transaction`INSERT INTO ledger_transactions(id,business_reference,event_type,description)
      VALUES(${ledgerId},${`topup-credit:${row.id}`},'TOP_UP_CREDIT','Credit confirmed PromptPay top-up')`;
    await transaction`INSERT INTO ledger_postings(transaction_id,account_id,amount_baht) VALUES
      (${ledgerId},${spending},${amount}),(${ledgerId},${asset},${-amount})`;
    await transaction`UPDATE ledger_transactions SET sealed_at=now() WHERE id=${ledgerId}`;
    await transaction`UPDATE top_ups SET status='SUCCEEDED',credited_ledger_transaction_id=${ledgerId},updated_at=now() WHERE id=${row.id}`;
    await transaction`INSERT INTO top_up_status_history(top_up_id,from_status,to_status,provider_status,source)
      VALUES(${row.id},${row.status},'SUCCEEDED',${status},'WEBHOOK')`;
    await transaction`INSERT INTO wallet_activities(user_id,type,status,spending_delta_baht,resource_type,resource_id)
      VALUES(${row.user_id},'TOP_UP','SUCCEEDED',${amount},'TOP_UP',${row.id})`;
  }

  private async applyPayoutWebhook(
    transaction: TransactionSql<Record<string, never>>,
    row: PayoutWebhookRow,
    status: string,
  ) {
    const success = status === 'SUCCEEDED' || status === 'COMPLETED';
    const failure = ['FAILED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(
      status,
    );
    const reversed = status === 'REVERSED';
    if (!success && !failure && !reversed) return;
    if (reversed && row.status === 'REVERSED') return;
    if (reversed && row.status !== 'SUCCEEDED')
      throw new Error('Payout reversal arrived before a successful payout.');
    if (row.final_ledger_transaction_id && !reversed) return;
    const [wallet] =
      (await transaction`SELECT id::text FROM wallets WHERE user_id=${row.user_id}`) as unknown as Array<{
        id: string;
      }>;
    const accounts =
      (await transaction`SELECT id::text,type FROM ledger_accounts WHERE
      (wallet_id=${wallet?.id} AND type IN ('EARNINGS','PAYOUT_RESERVED')) OR code='SYSTEM:PAYOUT_CLEARING'`) as unknown as Array<{
        id: string;
        type: string;
      }>;
    const earnings = accounts.find((a) => a.type === 'EARNINGS')?.id;
    const reserved = accounts.find((a) => a.type === 'PAYOUT_RESERVED')?.id;
    const clearing = accounts.find((a) => a.type === 'PAYOUT_CLEARING')?.id;
    if (!earnings || !reserved || !clearing)
      throw new Error('Payout ledger accounts are missing.');
    const maximumDebit = integer(row.maximum_debit_baht, 'maximum_debit');
    const quotedFeeSatang = integer(row.quoted_fee_satang, 'quoted_fee_satang');
    const quotedTaxSatang = integer(row.quoted_tax_satang, 'quoted_tax_satang');
    const exactDebitSatang =
      integer(row.principal_baht, 'principal_baht') * 100 +
      quotedFeeSatang +
      quotedTaxSatang;
    const actualDebitBaht = reversed
      ? Math.ceil(
          integer(
            row.actual_debit_satang ?? String(exactDebitSatang),
            'actual_debit_satang',
          ) / 100,
        )
      : success
        ? Math.ceil(exactDebitSatang / 100)
        : 0;
    const unusedReserve = success ? maximumDebit - actualDebitBaht : 0;
    const ledgerId = crypto.randomUUID();
    await transaction`INSERT INTO ledger_transactions(id,business_reference,event_type,description)
      VALUES(${ledgerId},${`payout-${status.toLowerCase()}:${row.id}`},${`PAYOUT_${status}`},'Finalize provider payout status')`;
    if (success) {
      await transaction`INSERT INTO ledger_postings(transaction_id,account_id,amount_baht) VALUES
        (${ledgerId},${reserved},${-maximumDebit}),(${ledgerId},${clearing},${actualDebitBaht})`;
      if (unusedReserve > 0)
        await transaction`INSERT INTO ledger_postings(transaction_id,account_id,amount_baht)
        VALUES(${ledgerId},${earnings},${unusedReserve})`;
    } else if (failure) {
      await transaction`INSERT INTO ledger_postings(transaction_id,account_id,amount_baht) VALUES
        (${ledgerId},${reserved},${-maximumDebit}),(${ledgerId},${earnings},${maximumDebit})`;
    } else {
      await transaction`INSERT INTO ledger_postings(transaction_id,account_id,amount_baht) VALUES
        (${ledgerId},${clearing},${-actualDebitBaht}),(${ledgerId},${earnings},${actualDebitBaht})`;
    }
    await transaction`UPDATE ledger_transactions SET sealed_at=now() WHERE id=${ledgerId}`;
    const next = success ? 'SUCCEEDED' : reversed ? 'REVERSED' : 'FAILED';
    await transaction`UPDATE payouts SET status=${next},final_ledger_transaction_id=${ledgerId},
      actual_fee_satang=CASE WHEN ${success} THEN ${quotedFeeSatang} ELSE actual_fee_satang END,
      actual_tax_satang=CASE WHEN ${success} THEN ${quotedTaxSatang} ELSE actual_tax_satang END,
      actual_debit_satang=CASE WHEN ${success} THEN ${exactDebitSatang} ELSE actual_debit_satang END,
      updated_at=now() WHERE id=${row.id}`;
    await transaction`INSERT INTO payout_status_history(payout_id,from_status,to_status,provider_status,source)
      VALUES(${row.id},${row.status},${next},${status},'WEBHOOK')`;
    await transaction`INSERT INTO wallet_activities(user_id,type,status,earnings_delta_baht,payout_reserved_delta_baht,resource_type,resource_id)
      VALUES(${row.user_id},${failure ? 'PAYOUT_RELEASE' : 'PAYOUT'},${next},
        ${failure ? maximumDebit : reversed ? actualDebitBaht : unusedReserve},
        ${success || failure ? -maximumDebit : 0},'PAYOUT',${row.id})`;
  }
}
