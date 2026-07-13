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
  WalletStatus,
  WalletSummary,
} from './money.types';

const defaultPolicy: MoneyPolicy = {
  revision: 1,
  currency: 'THB',
  platform_fee_bps: 200,
  fee_rounding: 'UP_TO_WHOLE_BAHT',
  quote_ttl_seconds: 300,
  review_window_seconds: 86400,
  default_application_window_seconds: 604800,
  high_value_resolution_threshold: 10_000,
  limits: {
    top_up: { minimum: 1, maximum: 700_000 },
    funded_job: { minimum: 1, maximum: 700_000 },
    earnings_conversion: { minimum: 1, maximum: 700_000 },
    payout: { minimum: 1, maximum: 700_000 },
  },
  effective_at: '2026-07-13T00:00:00.000Z',
};

interface StoredWallet {
  id: string;
  spending: number;
  earnings: number;
  status: WalletStatus;
}

export class InMemoryMoneyRepository implements MoneyRepository {
  private readonly wallets = new Map<string, StoredWallet>();
  private readonly activities = new Map<string, WalletActivity[]>();
  private readonly idempotency = new Map<
    string,
    { requestHash: string; response: EarningsConversion }
  >();
  private readonly webhooks = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly policy: MoneyPolicy = defaultPolicy) {}

  seedWallet(
    userId: string,
    balances: { spending?: number; earnings?: number; status?: WalletStatus },
  ): void {
    this.wallets.set(userId, {
      id: `wal_${userId}`,
      spending: balances.spending ?? 0,
      earnings: balances.earnings ?? 0,
      status: balances.status ?? 'ACTIVE',
    });
  }

  async getWallet(userId: string): Promise<WalletSummary> {
    const wallet = this.ensureWallet(userId);
    return this.toSummary(wallet);
  }

  async getPolicy(): Promise<MoneyPolicy> {
    return structuredClone(this.policy);
  }

  async listActivities(
    userId: string,
    query: ListActivitiesQuery,
  ): Promise<ActivityPage> {
    let items = [...(this.activities.get(userId) ?? [])];
    if (query.type) items = items.filter((item) => item.type === query.type);
    if (query.status) items = items.filter((item) => item.status === query.status);

    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
    const page = items.slice(offset, offset + query.limit);
    const nextOffset = offset + page.length;

    return {
      items: structuredClone(page),
      next_cursor: nextOffset < items.length ? String(nextOffset) : null,
    };
  }

  async convertEarnings(
    command: ConvertEarningsCommand,
  ): Promise<EarningsConversion> {
    return this.exclusive(async () => {
      const idempotencyId = `${command.userId}:earnings-conversion:${command.idempotencyKey}`;
      const previous = this.idempotency.get(idempotencyId);
      if (previous) {
        if (previous.requestHash !== command.requestHash) {
          throw new MoneyError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'The idempotency key was already used with a different request.',
          );
        }
        return structuredClone(previous.response);
      }

      const wallet = this.ensureWallet(command.userId);
      if (wallet.status === 'FROZEN') {
        throw new MoneyError(423, 'WALLET_FROZEN', 'The wallet is frozen.');
      }

      const range = this.policy.limits.earnings_conversion;
      if (command.amount < range.minimum || command.amount > range.maximum) {
        throw new MoneyError(
          422,
          'VALIDATION_FAILED',
          `Amount must be between ${range.minimum} and ${range.maximum} THB.`,
        );
      }
      if (wallet.earnings < command.amount) {
        throw new MoneyError(
          422,
          'INSUFFICIENT_EARNINGS_BALANCE',
          'The wallet does not have enough available earnings.',
        );
      }

      wallet.earnings -= command.amount;
      wallet.spending += command.amount;
      const now = new Date().toISOString();
      const conversion: EarningsConversion = {
        id: `cnv_${crypto.randomUUID()}`,
        amount: command.amount,
        currency: 'THB',
        earnings_balance_after: wallet.earnings,
        spending_balance_after: wallet.spending,
        created_at: now,
      };

      const activity: WalletActivity = {
        id: `act_${crypto.randomUUID()}`,
        type: 'EARNINGS_CONVERSION',
        title: 'Earnings converted to spending',
        status: 'SUCCEEDED',
        spending_delta: command.amount,
        earnings_delta: -command.amount,
        held_jobs_delta: 0,
        reserved_payouts_delta: 0,
        currency: 'THB',
        occurred_at: now,
        resource: { type: 'CONVERSION', id: conversion.id },
      };
      this.activities.set(command.userId, [
        activity,
        ...(this.activities.get(command.userId) ?? []),
      ]);
      this.idempotency.set(idempotencyId, {
        requestHash: command.requestHash,
        response: structuredClone(conversion),
      });

      return conversion;
    });
  }

  async storeWebhook(
    webhook: ProviderWebhook,
  ): Promise<{ duplicate: boolean }> {
    const id = `${webhook.provider}:${webhook.eventKey}`;
    const storedHash = this.webhooks.get(id);
    if (storedHash) {
      if (storedHash !== webhook.payloadHash) {
        throw new MoneyError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'The provider event identifier was reused with a different payload.',
        );
      }
      return { duplicate: true };
    }
    this.webhooks.set(id, webhook.payloadHash);
    return { duplicate: false };
  }

  get storedWebhookCount(): number {
    return this.webhooks.size;
  }

  private ensureWallet(userId: string): StoredWallet {
    const existing = this.wallets.get(userId);
    if (existing) return existing;

    const created: StoredWallet = {
      id: `wal_${userId}`,
      spending: 0,
      earnings: 0,
      status: 'ACTIVE',
    };
    this.wallets.set(userId, created);
    return created;
  }

  private toSummary(wallet: StoredWallet): WalletSummary {
    return {
      id: wallet.id,
      currency: 'THB',
      spending_balance: wallet.spending,
      earnings_balance: wallet.earnings,
      held_for_jobs: 0,
      reserved_for_payouts: 0,
      status: wallet.status,
      as_of: new Date().toISOString(),
    };
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
