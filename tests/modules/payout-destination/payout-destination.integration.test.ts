import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  paymentPayoutAccounts,
  paymentPayoutQuotes,
  paymentPayouts,
} from '@/database/schema/payment.schema';
import { paymentMoneyPolicyRevision, walletLedgerTransaction } from '@/database/schema/wallet.schema';
import {
  createPayoutDestinationEncryption,
  getPayoutDestination,
  retirePayoutDestination,
  savePayoutDestination,
} from '@/modules/payout-destination';
import { getPayoutDestinationForProvider } from '@/modules/payout-destination/payout-destination.provider';
import { ensureInitialMoneyPolicy } from '@/modules/wallet';

import { beforeAll, describe, expect, it } from 'bun:test';
import { and, eq, isNull } from 'drizzle-orm';

const studentA = `be114-a-${crypto.randomUUID()}`;
const studentB = `be114-b-${crypto.randomUUID()}`;
const crossOwnerPayoutReference = `be114-cross-owner-payout-${crypto.randomUUID()}`;
const encryption = createPayoutDestinationEncryption({
  activeKeyVersion: 'v1',
  keys: { v1: 'a'.repeat(32) },
});

const destinationInput = (principalUserId: string, suffix = '') => ({
  principalUserId,
  recipientType: 'SELF' as const,
  givenName: 'Payout',
  surname: `Student${suffix}`,
  relationship: 'SELF',
  accountCountry: 'TH' as const,
  accountCurrency: 'THB' as const,
  bankCode: 'KBANK',
  accountNumber: `123456789${suffix ? '1' : '0'}`,
  accountHolderName: 'Payout Student',
  routingType: 'BANK_ACCOUNT' as const,
  routingValue: '1234567890',
});

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();
  await db.insert(authUser).values([
    { id: studentA, email: `${studentA}@ku.th`, firstName: 'Payout', lastName: 'A' },
    { id: studentB, email: `${studentB}@ku.th`, firstName: 'Payout', lastName: 'B' },
  ]);
});

describe('Payout Destination application services', () => {
  it('saves an owned destination and exposes only masked values', async () => {
    const created = await savePayoutDestination(destinationInput(studentA), encryption);

    expect(created).toMatchObject({
      principalUserId: studentA,
      recipientType: 'SELF',
      routingType: 'BANK_ACCOUNT',
      maskedLastFour: '7890',
      maskedRoutingValue: '****7890',
      retiredAt: null,
    });
    expect(created).not.toHaveProperty('accountNumber');
    expect(created).not.toHaveProperty('routingValue');

    const [stored] = await db
      .select()
      .from(paymentPayoutAccounts)
      .where(eq(paymentPayoutAccounts.id, created.id));
    expect(stored).toBeDefined();
    expect(stored?.accountNumberCiphertext).not.toBe('1234567890');
    expect(stored?.routingValueCiphertext).not.toBe('1234567890');
    expect(stored).not.toHaveProperty('accountNumber');
    expect(stored).not.toHaveProperty('routingValue');

    expect(await getPayoutDestination(studentA, created.id)).toEqual(created);
    expect(await getPayoutDestinationForProvider(studentA, created.id, encryption)).toMatchObject({
      id: created.id,
      accountNumber: '1234567890',
      routingValue: '1234567890',
    });
  });

  it('accepts a Thai PromptPay destination', async () => {
    const promptPay = await savePayoutDestination({
      ...destinationInput(studentA),
      bankCode: 'PROMPTPAY',
      accountNumber: '0000000000',
      routingType: 'PROMPTPAY',
      routingValue: '0812345678',
    }, encryption);

    expect(promptPay).toMatchObject({
      routingType: 'PROMPTPAY',
      maskedLastFour: '0000',
    });
    expect(await getPayoutDestinationForProvider(studentA, promptPay.id, encryption)).toMatchObject({
      accountNumber: '0000000000',
      routingValue: '0812345678',
    });
  });

  it('retires the previous destination when saving a replacement', async () => {
    const previous = await getPayoutDestination(studentA);
    if (!previous) throw new Error('Missing initial Payout Destination');

    const replacement = await savePayoutDestination(destinationInput(studentA, 'replacement'), encryption);

    expect(replacement.id).not.toBe(previous.id);
    expect(replacement.retiredAt).toBeNull();
    expect(await getPayoutDestination(studentA)).toMatchObject({ id: replacement.id });

    const rows = await db
      .select({ id: paymentPayoutAccounts.id, retiredAt: paymentPayoutAccounts.retiredAt })
      .from(paymentPayoutAccounts)
      .where(eq(paymentPayoutAccounts.userId, studentA));
    expect(rows).toHaveLength(3);
    expect(rows.find(({ id }) => id === previous.id)?.retiredAt).toBeInstanceOf(Date);
    expect(rows.find(({ id }) => id === replacement.id)?.retiredAt).toBeNull();
  });

  it('retires an active destination without deleting its historical row', async () => {
    const active = await getPayoutDestination(studentA);
    if (!active) throw new Error('Missing active Payout Destination');

    const retired = await retirePayoutDestination(studentA, active.id);

    expect(retired).toMatchObject({ id: active.id });
    expect(retired?.retiredAt).toBeInstanceOf(Date);
    expect(await getPayoutDestination(studentA)).toBeUndefined();
    expect(await db.select().from(paymentPayoutAccounts).where(eq(paymentPayoutAccounts.id, active.id))).toHaveLength(1);
  });

  it('does not expose or change another Student\'s destination', async () => {
    const destination = await savePayoutDestination(destinationInput(studentB), encryption);

    expect(await getPayoutDestination(studentA, destination.id)).toBeUndefined();
    expect(await retirePayoutDestination(studentA, destination.id)).toBeUndefined();
    expect(await getPayoutDestination(studentB, destination.id)).toMatchObject({ id: destination.id });
  });

  it('serializes replacements so concurrent saves leave one active destination', async () => {
    const replacements = await Promise.all([
      savePayoutDestination(destinationInput(studentB, 'one'), encryption),
      savePayoutDestination(destinationInput(studentB, 'two'), encryption),
      savePayoutDestination(destinationInput(studentB, 'three'), encryption),
    ]);

    const active = await db
      .select({ id: paymentPayoutAccounts.id })
      .from(paymentPayoutAccounts)
      .where(and(eq(paymentPayoutAccounts.userId, studentB), isNull(paymentPayoutAccounts.retiredAt)));
    expect(active).toHaveLength(1);
    expect(replacements.map(({ id }) => id)).toContain(active[0]!.id);
  });

  it('rolls back retirement when the replacement insert fails', async () => {
    const activeBefore = await getPayoutDestination(studentB);
    if (!activeBefore) throw new Error('Missing active Payout Destination');

    await sql`CREATE OR REPLACE FUNCTION be114_fail_payout_destination_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'BE-114 forced insert failure';
      END;
    $$`;
    await sql`CREATE TRIGGER be114_fail_payout_destination_insert_trigger
      BEFORE INSERT ON payment_payout_accounts
      FOR EACH ROW EXECUTE FUNCTION be114_fail_payout_destination_insert()`;

    try {
      await expect(savePayoutDestination(destinationInput(studentB, 'atomicity'), encryption))
        .rejects.toMatchObject({ code: 'PAYOUT_DESTINATION_PERSISTENCE_FAILED' });
      expect(await getPayoutDestination(studentB)).toMatchObject({ id: activeBefore.id });
      expect(await db.select().from(paymentPayoutAccounts).where(eq(paymentPayoutAccounts.id, activeBefore.id)))
        .toHaveLength(1);
      expect((await getPayoutDestination(studentB, activeBefore.id))?.retiredAt).toBeNull();
    } finally {
      await sql`DROP TRIGGER IF EXISTS be114_fail_payout_destination_insert_trigger ON payment_payout_accounts`;
      await sql`DROP FUNCTION IF EXISTS be114_fail_payout_destination_insert()`;
    }
  });

  it('leaves an existing destination active when encryption fails', async () => {
    const activeBefore = await getPayoutDestination(studentB);
    if (!activeBefore) throw new Error('Missing active Payout Destination');
    const failingEncryption = {
      encrypt: () => {
        throw new Error('encryption failed');
      },
      decrypt: encryption.decrypt,
    };

    await expect(savePayoutDestination(destinationInput(studentB, 'failed'), failingEncryption)).rejects.toMatchObject({
      code: 'PAYOUT_DESTINATION_ENCRYPTION_FAILED',
    });
    expect(await getPayoutDestination(studentB)).toMatchObject({ id: activeBefore.id });
  });

  it('rejects third-party and non-Thai destinations before persistence', async () => {
    await expect(savePayoutDestination({
      ...destinationInput(studentA, 'third-party'),
      recipientType: 'THIRD_PARTY',
    }, encryption)).rejects.toMatchObject({ code: 'PAYOUT_DESTINATION_INVALID' });

    await expect(savePayoutDestination({
      ...destinationInput(studentA, 'foreign'),
      accountCountry: 'SG',
    }, encryption)).rejects.toMatchObject({ code: 'PAYOUT_DESTINATION_INVALID' });

    await expect(savePayoutDestination({
      ...destinationInput(studentA, 'unsupported-bank'),
      bankCode: 'UNKNOWN_BANK',
    }, encryption)).rejects.toMatchObject({ code: 'PAYOUT_DESTINATION_INVALID' });

    await expect(savePayoutDestination({
      ...destinationInput(studentA, 'invalid-promptpay'),
      bankCode: 'PROMPTPAY',
      routingType: 'PROMPTPAY',
      routingValue: 'not-a-promptpay-value',
    }, encryption)).rejects.toMatchObject({ code: 'PAYOUT_DESTINATION_INVALID' });

    await expect(savePayoutDestination({
      ...destinationInput(studentA, 'wrong-relationship'),
      relationship: 'FRIEND',
    }, encryption)).rejects.toMatchObject({ code: 'PAYOUT_DESTINATION_INVALID' });
  });

  it('rejects cross-Student Payout Quote and Payout relationships in PostgreSQL', async () => {
    const destination = await savePayoutDestination(destinationInput(studentB, 'owner'), encryption);
    const [policy] = await db
      .select({ id: paymentMoneyPolicyRevision.id })
      .from(paymentMoneyPolicyRevision)
      .where(eq(paymentMoneyPolicyRevision.revision, 1));
    if (!policy) throw new Error('Missing initial Money Policy');

    await expect(db.insert(paymentPayoutQuotes).values({
      userId: studentA,
      payoutAccountId: destination.id,
      policyRevisionId: policy.id,
      receiptSatang: 100,
      maximumFeeSatang: 0,
      maximumTaxSatang: 0,
      maximumDebitSatang: 100,
      expiresAt: new Date(Date.now() + 60_000),
    }).execute()).rejects.toThrow();

    const [quote] = await db.insert(paymentPayoutQuotes).values({
      userId: studentB,
      payoutAccountId: destination.id,
      policyRevisionId: policy.id,
      receiptSatang: 100,
      maximumFeeSatang: 0,
      maximumTaxSatang: 0,
      maximumDebitSatang: 100,
      expiresAt: new Date(Date.now() + 60_000),
    }).returning();

    const accountNumber = encryption.encrypt('1234567890');
    const routingValue = encryption.encrypt('1234567890');
    await db.insert(walletLedgerTransaction).values({
      businessReference: crossOwnerPayoutReference,
      eventType: 'PAYOUT',
    });
    const [ledgerTransaction] = await db
      .select({ id: walletLedgerTransaction.id })
      .from(walletLedgerTransaction)
      .where(eq(walletLedgerTransaction.businessReference, crossOwnerPayoutReference));

    await expect(db.insert(paymentPayouts).values({
      internalReference: `be114-cross-owner-payout-${crypto.randomUUID()}`,
      userId: studentA,
      quoteId: quote.id,
      payoutAccountId: destination.id,
      destinationRecipientType: 'SELF',
      destinationGivenName: 'Payout',
      destinationSurname: 'Student',
      destinationRelationship: 'SELF',
      destinationAccountCountry: 'TH',
      destinationAccountCurrency: 'THB',
      destinationBankCode: 'KBANK',
      destinationAccountNumberKeyVersion: accountNumber.keyVersion,
      destinationAccountNumberNonce: accountNumber.nonce,
      destinationAccountNumberCiphertext: accountNumber.ciphertext,
      destinationAccountNumberAuthTag: accountNumber.authTag,
      destinationAccountHolderName: 'Payout Student',
      destinationRoutingType: 'BANK_ACCOUNT',
      destinationRoutingValueKeyVersion: routingValue.keyVersion,
      destinationRoutingValueNonce: routingValue.nonce,
      destinationRoutingValueCiphertext: routingValue.ciphertext,
      destinationRoutingValueAuthTag: routingValue.authTag,
      provider: 'TEST',
      principalSatang: 100,
      maximumFeeSatang: 0,
      maximumTaxSatang: 0,
      maximumDebitSatang: 100,
      payoutStatus: 'CREATING',
      reserveLedgerTransactionId: ledgerTransaction.id,
    }).execute()).rejects.toThrow();
  });
});
