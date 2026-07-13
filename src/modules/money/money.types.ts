export type WalletStatus = 'ACTIVE' | 'FROZEN';

export interface WalletSummary {
  id: string;
  currency: 'THB';
  spending_balance: number;
  earnings_balance: number;
  held_for_jobs: number;
  reserved_for_payouts: number;
  status: WalletStatus;
  as_of: string;
}

export interface AmountRange {
  minimum: number;
  maximum: number;
}

export interface MoneyPolicy {
  revision: number;
  currency: 'THB';
  platform_fee_bps: number;
  fee_rounding: 'UP_TO_WHOLE_BAHT';
  quote_ttl_seconds: number;
  review_window_seconds: number;
  default_application_window_seconds: number;
  high_value_resolution_threshold: number;
  limits: {
    top_up: AmountRange;
    funded_job: AmountRange;
    earnings_conversion: AmountRange;
    payout: AmountRange;
  };
  effective_at: string;
}

export type WalletActivityType =
  | 'TOP_UP'
  | 'JOB_FUNDING'
  | 'JOB_RETURN'
  | 'JOB_SETTLEMENT'
  | 'PLATFORM_FEE'
  | 'EARNINGS_CONVERSION'
  | 'PAYOUT'
  | 'PAYOUT_RELEASE'
  | 'WALLET_ADJUSTMENT';

export interface WalletActivity {
  id: string;
  type: WalletActivityType;
  title: string;
  status: string;
  spending_delta: number;
  earnings_delta: number;
  held_jobs_delta: number;
  reserved_payouts_delta: number;
  currency: 'THB';
  occurred_at: string;
  resource: {
    type: 'TOP_UP' | 'JOB' | 'CONVERSION' | 'PAYOUT' | 'ADJUSTMENT';
    id: string;
  };
}

export interface ActivityPage {
  items: WalletActivity[];
  next_cursor: string | null;
}

export interface EarningsConversion {
  id: string;
  amount: number;
  currency: 'THB';
  earnings_balance_after: number;
  spending_balance_after: number;
  created_at: string;
}

export interface ConvertEarningsCommand {
  userId: string;
  amount: number;
  idempotencyKey: string;
  requestHash: string;
}

export interface ListActivitiesQuery {
  cursor?: string;
  limit: number;
  type?: WalletActivityType;
  status?: string;
}

export interface ProviderWebhook {
  provider: 'XENDIT';
  eventKey: string;
  payloadHash: string;
  eventType: string;
  objectId: string | null;
  payload: unknown;
  receivedAt: string;
}

export interface MoneyRepository {
  getWallet(userId: string): Promise<WalletSummary>;
  getPolicy(): Promise<MoneyPolicy>;
  listActivities(userId: string, query: ListActivitiesQuery): Promise<ActivityPage>;
  convertEarnings(command: ConvertEarningsCommand): Promise<EarningsConversion>;
  storeWebhook(webhook: ProviderWebhook): Promise<{ duplicate: boolean }>;
}
