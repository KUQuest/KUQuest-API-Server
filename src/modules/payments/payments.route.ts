import { Elysia, t } from 'elysia';

import { apiFailureSchema, apiSuccess, apiSuccessSchema } from '@/http/api-response';
import { assertTrustedBrowserOrigin, type SessionResolver } from '@/modules/auth';
import { MoneyError } from '@/modules/money/money.errors';

import type { PaymentsRepository } from './payments.types';

const topUpSchema=t.Object({id:t.String(),reference:t.String(),credit_baht:t.Integer(),payment_total_baht:t.Integer(),
  currency:t.Literal('THB'),status:t.String(),qr_string:t.Nullable(t.String()),qr_expires_at:t.Nullable(t.String()),
  provider_reference:t.Nullable(t.String()),created_at:t.String(),updated_at:t.String()});
const topUpQuoteSchema=t.Object({id:t.String(),credit_baht:t.Integer(),fee_baht:t.Integer(),tax_baht:t.Integer(),
  payment_total_baht:t.Integer(),currency:t.Literal('THB'),expires_at:t.String()});
const accountSchema=t.Object({id:t.String(),given_name:t.String(),surname:t.String(),account_holder_name:t.String(),
  bank_code:t.String(),masked_account_number:t.String(),created_at:t.String()});
const payoutQuoteSchema=t.Object({id:t.String(),payout_account_id:t.String(),receipt_baht:t.Integer(),
  maximum_fee_baht:t.Integer(),maximum_tax_baht:t.Integer(),maximum_debit_baht:t.Integer(),
  currency:t.Literal('THB'),expires_at:t.String()});
const payoutSchema=t.Object({id:t.String(),reference:t.String(),principal_baht:t.Integer(),maximum_debit_baht:t.Integer(),
  currency:t.Literal('THB'),status:t.String(),destination:t.Object({bank_code:t.String(),masked_account_number:t.String()}),
  provider_reference:t.Nullable(t.String()),created_at:t.String(),updated_at:t.String()});

const userId=async(headers:Headers,resolver:SessionResolver)=>{
  const session=await resolver(headers);
  if(!session?.user.id)throw new MoneyError(401,'UNAUTHORIZED','A valid session is required.');
  return session.user.id;
};
const mutate=async(headers:Headers,resolver:SessionResolver,origins:readonly string[])=>{
  assertTrustedBrowserOrigin(headers,origins); return userId(headers,resolver);
};
const idempotency=(headers:Record<string,string|undefined>)=>{
  const value=headers['idempotency-key'];
  if(!value||value.length<8||value.length>128)throw new MoneyError(422,'VALIDATION_FAILED','A valid Idempotency-Key header is required.');
  return value;
};
export const createPaymentsRoute=(repository:PaymentsRepository,resolver:SessionResolver,
  trustedOrigins:readonly string[],development:boolean)=>new Elysia({name:'payments-route',prefix:'/v1/wallet'})
  .post('/top-up-quotes',async({body,request,set})=>{set.status=201;return apiSuccess(await repository.createTopUpQuote(
    await mutate(request.headers,resolver,trustedOrigins),body.credit_baht),request);},{body:t.Object({credit_baht:t.Integer({minimum:1})}),
    response:{201:apiSuccessSchema(topUpQuoteSchema),401:apiFailureSchema,403:apiFailureSchema,422:apiFailureSchema},detail:{tags:['Top-ups'],summary:'Quote a PromptPay wallet top-up',security:[{betterAuthSession:[]}]}})
  .post('/top-ups',async({body,headers,request,set})=>{set.status=201;return apiSuccess(await repository.createTopUp(
    await mutate(request.headers,resolver,trustedOrigins),body.quote_id,idempotency(headers)),request);},{
    body:t.Object({quote_id:t.String({format:'uuid'})}),headers:t.Object({'idempotency-key':t.String()}),response:{201:apiSuccessSchema(topUpSchema),401:apiFailureSchema,403:apiFailureSchema,404:apiFailureSchema,409:apiFailureSchema,422:apiFailureSchema,503:apiFailureSchema},
    detail:{tags:['Top-ups'],summary:'Create a real Xendit PromptPay request',security:[{betterAuthSession:[]}]}})
  .get('/top-ups',async({request})=>apiSuccess(await repository.listTopUps(await userId(request.headers,resolver)),request),{
    response:{200:apiSuccessSchema(t.Array(topUpSchema)),401:apiFailureSchema},detail:{tags:['Top-ups'],summary:'List top-ups',security:[{betterAuthSession:[]}]}})
  .get('/top-ups/:id',async({params,request})=>apiSuccess(await repository.getTopUp(await userId(request.headers,resolver),params.id),request),{
    params:t.Object({id:t.String({format:'uuid'})}),response:{200:apiSuccessSchema(topUpSchema),401:apiFailureSchema,404:apiFailureSchema},detail:{tags:['Top-ups'],summary:'Get top-up status',security:[{betterAuthSession:[]}]}})
  .post('/top-ups/:id/simulate',async({params,request})=>{
    if(!development)throw new MoneyError(404,'NOT_FOUND','The requested resource was not found.');
    return apiSuccess(await repository.simulateTopUp(await mutate(request.headers,resolver,trustedOrigins),params.id),request);
  },{params:t.Object({id:t.String({format:'uuid'})}),response:{200:apiSuccessSchema(topUpSchema),401:apiFailureSchema,403:apiFailureSchema,404:apiFailureSchema,409:apiFailureSchema,503:apiFailureSchema},detail:{tags:['Development money testing'],summary:'Ask Xendit test mode to simulate payment',security:[{betterAuthSession:[]}]}})
  .get('/payout-account',async({request})=>apiSuccess(await repository.getPayoutAccount(await userId(request.headers,resolver)),request),{
    response:{200:apiSuccessSchema(t.Nullable(accountSchema)),401:apiFailureSchema},detail:{tags:['Payouts'],summary:'Get the active payout account',security:[{betterAuthSession:[]}]}})
  .post('/payout-account',async({body,request,set})=>{set.status=201;return apiSuccess(await repository.savePayoutAccount(
    await mutate(request.headers,resolver,trustedOrigins),body),request);},{body:t.Object({given_name:t.String({minLength:1,maxLength:50}),
      surname:t.String({minLength:1,maxLength:50}),account_holder_name:t.String({minLength:1,maxLength:100}),
      account_number:t.String({minLength:6,maxLength:32}),bank_code:t.String({minLength:2,maxLength:30})}),
    response:{201:apiSuccessSchema(accountSchema),401:apiFailureSchema,403:apiFailureSchema,422:apiFailureSchema},detail:{tags:['Payouts'],summary:'Replace the active payout destination',security:[{betterAuthSession:[]}]}})
  .post('/payout-quotes',async({body,request,set})=>{set.status=201;return apiSuccess(await repository.createPayoutQuote(
    await mutate(request.headers,resolver,trustedOrigins),body.receipt_baht),request);},{body:t.Object({receipt_baht:t.Integer({minimum:1})}),
    response:{201:apiSuccessSchema(payoutQuoteSchema),401:apiFailureSchema,403:apiFailureSchema,422:apiFailureSchema},detail:{tags:['Payouts'],summary:'Quote an earnings payout',security:[{betterAuthSession:[]}]}})
  .post('/payouts',async({body,headers,request,set})=>{set.status=201;return apiSuccess(await repository.createPayout(
    await mutate(request.headers,resolver,trustedOrigins),body.quote_id,idempotency(headers)),request);},{
    body:t.Object({quote_id:t.String({format:'uuid'})}),headers:t.Object({'idempotency-key':t.String()}),response:{201:apiSuccessSchema(payoutSchema),401:apiFailureSchema,403:apiFailureSchema,404:apiFailureSchema,409:apiFailureSchema,422:apiFailureSchema,503:apiFailureSchema},
    detail:{tags:['Payouts'],summary:'Reserve earnings and submit a real Xendit test payout',security:[{betterAuthSession:[]}]}})
  .get('/payouts',async({request})=>apiSuccess(await repository.listPayouts(await userId(request.headers,resolver)),request),{
    response:{200:apiSuccessSchema(t.Array(payoutSchema)),401:apiFailureSchema},detail:{tags:['Payouts'],summary:'List payouts',security:[{betterAuthSession:[]}]}})
  .get('/payouts/:id',async({params,request})=>apiSuccess(await repository.getPayout(await userId(request.headers,resolver),params.id),request),{
    params:t.Object({id:t.String({format:'uuid'})}),response:{200:apiSuccessSchema(payoutSchema),401:apiFailureSchema,404:apiFailureSchema},detail:{tags:['Payouts'],summary:'Get payout status',security:[{betterAuthSession:[]}]}});
