/* oxlint-disable typescript/no-unsafe-type-assertion -- diagnostic SQL rows are normalized at this boundary. */
import { Elysia, t } from 'elysia';
import type { Sql } from 'postgres';

import { apiFailureSchema,apiSuccess,apiSuccessSchema } from '@/http/api-response';
import type { SessionResolver } from '@/modules/auth';
import { MoneyError } from '@/modules/money/money.errors';

const time=(value:Date|string|null):string|null=>value?(value instanceof Date?value.toISOString():new Date(value).toISOString()):null;

export const createMoneyDiagnosticsRoute=(database:Sql,resolveSession:SessionResolver,enabled:boolean)=>
  new Elysia({name:'development-money-diagnostics',prefix:'/v1/development'})
    .get('/money-diagnostics',async({request})=>{
      if(!enabled)throw new MoneyError(404,'NOT_FOUND','The requested resource was not found.');
      const session=await resolveSession(request.headers);
      if(!session?.user.id)throw new MoneyError(401,'UNAUTHORIZED','A valid session is required.');
      const userId=session.user.id;
      const ledgerRows=(await database`
        SELECT transaction.id::text AS transaction_id,transaction.business_reference,
          transaction.event_type,transaction.description,transaction.created_at,transaction.sealed_at,
          account.code AS account_code,account.type AS account_type,posting.amount_baht::text AS amount_baht
        FROM ledger_transactions transaction
        JOIN ledger_postings posting ON posting.transaction_id=transaction.id
        JOIN ledger_accounts account ON account.id=posting.account_id
        WHERE transaction.id IN (
          SELECT DISTINCT p.transaction_id FROM ledger_postings p
          JOIN ledger_accounts a ON a.id=p.account_id WHERE a.user_id=${userId}
        ) ORDER BY transaction.created_at DESC,transaction.id,account.code LIMIT 200
      `) as unknown as Array<{transaction_id:string;business_reference:string;event_type:string;description:string|null;
        created_at:Date|string;sealed_at:Date|string|null;account_code:string;account_type:string;amount_baht:string}>;
      const grouped=new Map<string,{transaction_id:string;business_reference:string;event_type:string;description:string|null;
        created_at:string;sealed_at:string|null;balanced:boolean;postings:Array<{account_code:string;account_type:string;amount_baht:number}>}>();
      for(const row of ledgerRows){
        const current=grouped.get(row.transaction_id)??{transaction_id:row.transaction_id,business_reference:row.business_reference,
          event_type:row.event_type,description:row.description,created_at:time(row.created_at)!,sealed_at:time(row.sealed_at),balanced:false,postings:[]};
        current.postings.push({account_code:row.account_code,account_type:row.account_type,amount_baht:Number(row.amount_baht)});
        grouped.set(row.transaction_id,current);
      }
      for(const transaction of grouped.values())transaction.balanced=transaction.postings.reduce((sum,item)=>sum+item.amount_baht,0)===0;
      const webhookRows=(await database`
        SELECT id::text,kind,status,attempts,received_at,processed_at,last_error
        FROM provider_webhook_events ORDER BY received_at DESC LIMIT 50
      `) as unknown as Array<{id:string;kind:string;status:string;attempts:number;received_at:Date|string;
        processed_at:Date|string|null;last_error:string|null}>;
      return apiSuccess({actor_user_id:userId,ledger_transactions:[...grouped.values()],provider_webhooks:webhookRows.map(row=>({
        id:row.id,kind:row.kind,status:row.status,attempts:row.attempts,received_at:time(row.received_at)!,
        processed_at:time(row.processed_at),last_error:row.last_error,
      }))},request);
    },{response:{200:apiSuccessSchema(t.Object({actor_user_id:t.String(),ledger_transactions:t.Array(t.Object({
      transaction_id:t.String(),business_reference:t.String(),event_type:t.String(),description:t.Nullable(t.String()),
      created_at:t.String(),sealed_at:t.Nullable(t.String()),balanced:t.Boolean(),postings:t.Array(t.Object({account_code:t.String(),account_type:t.String(),amount_baht:t.Integer()}))
    })),provider_webhooks:t.Array(t.Object({id:t.String(),kind:t.String(),status:t.String(),attempts:t.Integer(),received_at:t.String(),
      processed_at:t.Nullable(t.String()),last_error:t.Nullable(t.String())}))})),401:apiFailureSchema,404:apiFailureSchema},
      detail:{tags:['Development test'],summary:'Inspect sanitized ledger and webhook processing evidence',security:[{betterAuthSession:[]}]}});
