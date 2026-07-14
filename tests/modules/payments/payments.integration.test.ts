import {describe,expect,it} from 'bun:test';
import {Elysia} from 'elysia';

import {createPaymentsRoute} from '@/modules/payments/payments.route';
import type {PaymentsRepository,PayoutAccountInput,TopUp,Payout} from '@/modules/payments/payments.types';
import {errorHandlerPlugin} from '@/plugins/error-handler';

const now='2026-07-14T10:00:00.000Z';
const topup:TopUp={id:'00000000-0000-4000-8000-000000000001',reference:'topup:test',credit_baht:100,
  payment_total_baht:100,currency:'THB',status:'REQUIRES_ACTION',qr_string:'provider-qr',qr_expires_at:now,
  provider_reference:'pr-test',created_at:now,updated_at:now};
const payout:Payout={id:'00000000-0000-4000-8000-000000000002',reference:'payout:test',principal_baht:100,
  maximum_debit_baht:100,currency:'THB',status:'PENDING',destination:{bank_code:'BBL',masked_account_number:'••••3456'},
  provider_reference:'po-test',created_at:now,updated_at:now};
class FakePayments implements PaymentsRepository{
  createTopUpQuote=async()=>({id:'00000000-0000-4000-8000-000000000003',credit_baht:100,fee_baht:0,tax_baht:0,payment_total_baht:100,currency:'THB' as const,expires_at:now});
  createTopUp=async()=>topup; getTopUp=async()=>topup; listTopUps=async()=>[topup]; simulateTopUp=async()=>topup;
  savePayoutAccount=async(_userId:string,input:PayoutAccountInput)=>({id:'00000000-0000-4000-8000-000000000004',
    given_name:input.given_name,surname:input.surname,account_holder_name:input.account_holder_name,bank_code:input.bank_code,
    masked_account_number:'••••3456',created_at:now});
  getPayoutAccount=async()=>null;
  createPayoutQuote=async()=>({id:'00000000-0000-4000-8000-000000000005',payout_account_id:'00000000-0000-4000-8000-000000000004',
    receipt_baht:100,maximum_fee_baht:0,maximum_tax_baht:0,maximum_debit_baht:100,currency:'THB' as const,expires_at:now});
  createPayout=async()=>payout;getPayout=async()=>payout;listPayouts=async()=>[payout];processStoredWebhooks=async()=>0;
}
const app=new Elysia().use(errorHandlerPlugin).use(createPaymentsRoute(new FakePayments(),async()=>({user:{id:'user-1'}}),['http://localhost:5000'],true));
const request=(path:string,method:'POST',body?:unknown,key?:string,origin='http://localhost:5000')=>{
  const headers=new Headers({'content-type':'application/json',origin});
  if(key)headers.set('idempotency-key',key);
  return new Request(`http://localhost${path}`,{method,headers,
    body:body===undefined?undefined:JSON.stringify(body)});
};

describe('payment HTTP contract',()=>{
  it('creates a quote and provider top-up in canonical envelopes',async()=>{
    const quote=await app.handle(request('/v1/wallet/top-up-quotes','POST',{credit_baht:100}));
    expect(quote.status).toBe(201);expect((await quote.json()).data.payment_total_baht).toBe(100);
    const created=await app.handle(request('/v1/wallet/top-ups','POST',{quote_id:'00000000-0000-4000-8000-000000000003'},'topup-http-0001'));
    expect(created.status).toBe(201);expect((await created.json()).data.provider_reference).toBe('pr-test');
  });
  it('rejects cross-site mutation and accepts payout creation',async()=>{
    const rejected=await app.handle(request('/v1/wallet/top-up-quotes','POST',{credit_baht:100},undefined,'https://attacker.example'));
    expect(rejected.status).toBe(403);
    const created=await app.handle(request('/v1/wallet/payouts','POST',{quote_id:'00000000-0000-4000-8000-000000000005'},'payout-http-0001'));
    expect(created.status).toBe(201);expect((await created.json()).data.destination.masked_account_number).toBe('••••3456');
  });
});
