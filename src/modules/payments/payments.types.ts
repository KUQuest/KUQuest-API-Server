export interface TopUpQuote {
  id: string;
  credit_baht: number;
  fee_baht: number;
  tax_baht: number;
  payment_total_baht: number;
  currency: 'THB';
  expires_at: string;
}

export interface TopUp {
  id: string;
  reference: string;
  credit_baht: number;
  payment_total_baht: number;
  currency: 'THB';
  status: string;
  qr_string: string | null;
  qr_expires_at: string | null;
  provider_reference: string | null;
  created_at: string;
  updated_at: string;
}

export interface PayoutAccountInput {
  given_name: string;
  surname: string;
  account_holder_name: string;
  account_number: string;
  bank_code: string;
}

export interface PayoutAccount extends Omit<PayoutAccountInput, 'account_number'> {
  id: string;
  masked_account_number: string;
  created_at: string;
}

export interface PayoutQuote {
  id: string;
  payout_account_id: string;
  receipt_baht: number;
  maximum_fee_baht: number;
  maximum_tax_baht: number;
  maximum_debit_baht: number;
  currency: 'THB';
  expires_at: string;
}

export interface Payout {
  id: string;
  reference: string;
  principal_baht: number;
  maximum_debit_baht: number;
  currency: 'THB';
  status: string;
  destination: { bank_code: string; masked_account_number: string };
  provider_reference: string | null;
  created_at: string;
  updated_at: string;
}

export interface XenditPaymentRequest {
  paymentRequestId: string;
  status: string;
  qrString: string | null;
  expiresAt: string | null;
}

export interface XenditPayoutRequest {
  payoutId: string;
  status: string;
}

export interface XenditClient {
  createPromptPay(input: {
    reference: string;
    amountBaht: number;
    expiresAt: string;
  }): Promise<XenditPaymentRequest>;
  simulatePayment(paymentRequestId: string): Promise<{ status: string }>;
  createPayout(input: {
    reference: string;
    amountSatang: number;
    account: PayoutAccountInput;
  }): Promise<XenditPayoutRequest>;
}

export interface PaymentsRepository {
  createTopUpQuote(userId: string, creditBaht: number): Promise<TopUpQuote>;
  createTopUp(userId: string, quoteId: string, idempotencyKey: string): Promise<TopUp>;
  getTopUp(userId: string, topUpId: string): Promise<TopUp>;
  listTopUps(userId: string): Promise<TopUp[]>;
  simulateTopUp(userId: string, topUpId: string): Promise<TopUp>;
  savePayoutAccount(userId: string, input: PayoutAccountInput): Promise<PayoutAccount>;
  getPayoutAccount(userId: string): Promise<PayoutAccount | null>;
  createPayoutQuote(userId: string, receiptBaht: number): Promise<PayoutQuote>;
  createPayout(userId: string, quoteId: string, idempotencyKey: string): Promise<Payout>;
  getPayout(userId: string, payoutId: string): Promise<Payout>;
  listPayouts(userId: string): Promise<Payout[]>;
  processStoredWebhooks(limit?: number): Promise<number>;
}
