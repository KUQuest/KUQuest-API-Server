import { describe,expect,it } from 'bun:test';
import postgres from 'postgres';

import { PostgresJobRepository } from '@/modules/jobs/postgres-job.repository';
import { sha256,stableJson } from '@/modules/money/money.crypto';

const databaseUrl=Bun.env.TEST_DATABASE_URL;
const databaseDescribe=databaseUrl?describe:describe.skip;
const identity=async(userId:string,key:string,payload:unknown)=>({userId,idempotencyKey:key,
  requestHash:await sha256(stableJson(payload))});

databaseDescribe('PostgreSQL funded job settlement',()=>{
  it('moves spending through held value into worker earnings with a zero-fee policy',async()=>{
    const database=postgres(databaseUrl!,{prepare:false});
    const repository=new PostgresJobRepository(database);
    const employer=`employer-${crypto.randomUUID()}`; const worker=`worker-${crypto.randomUUID()}`;
    try{
      for(const [id,name] of [[employer,'Employer'],[worker,'Worker']]){
        await database`INSERT INTO "user"(user_id,name,email,email_verified,first_name,last_name,updated_at)
          VALUES(${id},${name},${`${id}@ku.th`},true,${name},'Test',now())`;
      }
      const [wallet]=await database`SELECT id::text FROM wallets WHERE user_id=${employer}`;
      const [spending]=await database`SELECT id::text FROM ledger_accounts WHERE wallet_id=${wallet!.id} AND type='SPENDING'`;
      const [adjustment]=await database`SELECT id::text FROM ledger_accounts WHERE code='SYSTEM:ADJUSTMENTS'`;
      const seed=crypto.randomUUID();
      await database.begin(async transaction=>{
        await transaction`INSERT INTO ledger_transactions(id,business_reference,event_type) VALUES(${seed},${`test-job:${seed}`},'TEST_SEED')`;
        await transaction`INSERT INTO ledger_postings(transaction_id,account_id,amount_baht) VALUES
          (${seed},${spending!.id},300),(${seed},${adjustment!.id},-300)`;
        await transaction`UPDATE ledger_transactions SET sealed_at=now() WHERE id=${seed}`;
      });
      const createPayload={title:'Test a KUQuest flow',description:'Complete the text-only MVP task.',amount:200,
        applicationDeadline:new Date(Date.now()+60_000).toISOString(),workDeadline:new Date(Date.now()+3_600_000).toISOString()};
      const job=await repository.createFundedJob({...await identity(employer,'job-create-postgres-0001',createPayload),...createPayload});
      expect(job).toMatchObject({status:'OPEN',platform_fee_amount:0,worker_net_amount:200});
      const applyPayload={jobId:job.id,message:'I can do this.'};
      const application=await repository.createApplication({...await identity(worker,'job-apply-postgres-0001',applyPayload),...applyPayload});
      await repository.selectWorker({...await identity(employer,'job-select-postgres-0001',{jobId:job.id,applicationId:application.id}),
        jobId:job.id,applicationId:application.id});
      await repository.submitWork({...await identity(worker,'job-submit-postgres-0001',{jobId:job.id,summary:'Done.'}),jobId:job.id,summary:'Done.'});
      const settled=await repository.approveWork({...await identity(employer,'job-approve-postgres-0001',{jobId:job.id}),jobId:job.id});
      expect(settled.status).toBe('SETTLED');
      const [balances]=await database`SELECT
        (SELECT spending_balance_baht FROM wallets WHERE user_id=${employer})::integer AS spending,
        (SELECT held_for_jobs_baht FROM wallets WHERE user_id=${employer})::integer AS held,
        (SELECT earnings_balance_baht FROM wallets WHERE user_id=${worker})::integer AS earnings`;
      expect(balances).toMatchObject({spending:100,held:0,earnings:200});
      const [ledger]=await database`SELECT count(*)::integer AS postings,coalesce(sum(p.amount_baht),0)::integer AS balance,
        t.sealed_at FROM ledger_transactions t JOIN ledger_postings p ON p.transaction_id=t.id
        WHERE t.business_reference=${`job-settlement:${job.id}`} GROUP BY t.sealed_at`;
      expect(ledger).toMatchObject({postings:2,balance:0});
      expect(ledger!.sealed_at).not.toBeNull();
    }finally{await database.end({timeout:1});}
  },20_000);
});
