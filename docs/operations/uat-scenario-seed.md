# UAT scenario seed

`scripts/seed-uat-scenario.ts` fills a UAT database with realistic activity for Admin review
and demos. It calls the same domain services as the HTTP controllers, so every Quest, Wallet,
and Admin record follows the normal rules. It only adds data.

## What it creates

- 40 Members on `@uat-demo.kubits.org` with KU Departments, Occupations, bios, and some
  avatars. They have no credential Account, so nobody can sign in as them.
- About 48 PromptPay Top-ups through the Xendit **Development** API: the seed creates the
  Payment Request, simulates payment in Xendit Test Mode, then processes the callback or
  reconciles with Xendit. Three stay `PENDING`.
- 58 v2 Quests in every state: completed (SINGLE, GROUP FCFS, Candidate, proof-free), failed by
  `PROOF_NOT_APPROVED` and by `dueAt`, cancelled, proof pending, in progress, assigned, open
  with Candidate applications, and drafts. Work Chat messages and both-way Reviews are included.
- Admin work: Report Cases, Dispute Cases, Conduct Reports in pending and decided states,
  Earnings Conversions, Payouts waiting for approval and one cancelled, and one frozen Wallet.

All timestamps are the run time. Real Xendit records cannot be backdated.

## Guards

The seed runs only in `development`, or in `production/uat` with
`UAT_SEED_CONFIRM='seed UAT scenario data'`. It needs an `xnd_development_` key. The same
confirmation lets only this process use Xendit payment simulation on UAT; the running API
process never sets it, so the HTTP simulate route stays closed on UAT.

## Run on UAT

Run it once, after a UAT deploy of an image that contains the script, inside the API container:

```bash
pct exec 122 -- docker exec -e UAT_SEED_CONFIRM='seed UAT scenario data' \
  kuquest-uat-api bun scripts/seed-uat-scenario.ts
```

It takes about 15 minutes. Most of the time is Top-up callback waiting (30 seconds each, six
at a time) and Quest start times a few seconds ahead.

## Re-running

A repeat run skips Members, Top-ups, and Quests that exist and repeats no money command.
Admin cases are created only for Quests made in the same run. If a run stops in the middle of a
Quest, that Quest stays in its partial state and later runs skip it.
