import { MoneyError } from '@/modules/money/money.errors';

import type {
  PayoutAccountInput,
  XenditClient,
  XenditPaymentRequest,
  XenditPayoutRequest,
} from './payments.types';

interface XenditAction { descriptor?: unknown; value?: unknown }

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export class HttpXenditClient implements XenditClient {
  constructor(
    private readonly secretKey: string | undefined,
    private readonly baseUrl = 'https://api.xendit.co',
  ) {}

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    if (!this.secretKey) {
      throw new MoneyError(503, 'PROVIDER_UNAVAILABLE', 'Xendit is not configured.');
    }
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Basic ${btoa(`${this.secretKey}:`)}`);
      headers.set('content-type', 'application/json');
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
      });
    } catch {
      throw new MoneyError(503, 'PROVIDER_UNAVAILABLE', 'Xendit could not be reached.');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const providerCode = payload && typeof payload === 'object' && 'error_code' in payload
        ? text(payload.error_code)
        : null;
      throw new MoneyError(
        response.status >= 500 ? 503 : 422,
        response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'VALIDATION_FAILED',
        providerCode ? `Xendit rejected the request (${providerCode}).` : 'Xendit rejected the request.',
      );
    }
    return payload as Record<string, unknown>;
  }

  async createPromptPay(input: {
    reference: string;
    amountBaht: number;
    expiresAt: string;
  }): Promise<XenditPaymentRequest> {
    const payload = await this.request('/v3/payment_requests', {
      method: 'POST',
      headers: { 'api-version': '2024-11-11' },
      body: JSON.stringify({
        reference_id: input.reference,
        type: 'PAY',
        country: 'TH',
        currency: 'THB',
        request_amount: input.amountBaht,
        capture_method: 'AUTOMATIC',
        channel_code: 'QRPROMPTPAY',
        channel_properties: { expires_at: input.expiresAt, qr_string_type: 'DYNAMIC' },
        description: 'KUQuest wallet top-up',
        metadata: { kuquest_reference: input.reference },
      }),
    });
    const actions = Array.isArray(payload.actions) ? payload.actions as XenditAction[] : [];
    const qr = actions.find((action) => action.descriptor === 'QR_STRING');
    const paymentRequestId = text(payload.payment_request_id);
    if (!paymentRequestId) throw new Error('Xendit response did not contain a payment request ID.');
    return {
      paymentRequestId,
      status: text(payload.status) ?? 'REQUIRES_ACTION',
      qrString: text(qr?.value),
      expiresAt: input.expiresAt,
    };
  }

  async simulatePayment(paymentRequestId: string): Promise<{ status: string }> {
    const payload = await this.request(`/v3/payment_requests/${encodeURIComponent(paymentRequestId)}/simulate`, {
      method: 'POST',
      headers: { 'api-version': '2024-11-11' },
      body: '{}',
    });
    return { status: text(payload.status) ?? 'PENDING' };
  }

  async createPayout(input: {
    reference: string;
    amountSatang: number;
    account: PayoutAccountInput;
  }): Promise<XenditPayoutRequest> {
    const channelCode = input.account.bank_code.startsWith('TH_')
      ? input.account.bank_code
      : `TH_${input.account.bank_code}`;
    const payload = await this.request('/v2/payouts', {
      method: 'POST',
      headers: { 'idempotency-key': input.reference },
      body: JSON.stringify({
        reference_id: input.reference,
        channel_code: channelCode,
        channel_properties: {
          account_holder_name: input.account.account_holder_name,
          account_number: input.account.account_number,
        },
        amount: input.amountSatang / 100,
        currency: 'THB',
        description: 'KUQuest worker earnings payout',
      }),
    });
    const payoutId = text(payload.payout_id) ?? text(payload.id);
    if (!payoutId) throw new Error('Xendit response did not contain a payout ID.');
    return { payoutId, status: text(payload.status) ?? 'ACCEPTED' };
  }
}
