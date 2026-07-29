import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { profileCertificate } from '@/database/schema/profile.schema';
import {
  createCertificate,
  deleteCertificate,
  findCertificate,
  listCertificates,
  updateCertificate,
} from '@/modules/certificate/certificate.service';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { inArray } from 'drizzle-orm';

// Ownership isolation is the security-critical half of this module and can only be
// exercised against a migrated database. CI currently runs `bun test` before it
// applies migrations, so this suite skips there rather than failing; run it locally
// with `docker compose up -d postgres && bun run db:migrate` against DATABASE_URL.
const databaseIsMigrated = await db
  .select()
  .from(profileCertificate)
  .limit(1)
  .then(() => true)
  .catch(() => false);

const OWNER = 'certificate-test-owner';
const OTHER = 'certificate-test-other';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

const certificate = {
  name: 'AWS Certified Cloud Practitioner',
  issuer: 'Amazon Web Services',
  issuedAt: '2024-05-01',
};

describe.skipIf(!databaseIsMigrated)('certificate service against the database', () => {
  const removeFixtures = async () => {
    await db.delete(profileCertificate).where(inArray(profileCertificate.userId, [OWNER, OTHER]));
    await db.delete(authUser).where(inArray(authUser.id, [OWNER, OTHER]));
  };

  beforeAll(async () => {
    await removeFixtures();

    const student = (id: string, email: string) => ({
      id,
      email,
      firstName: 'Test',
      lastName: 'Student',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db
      .insert(authUser)
      .values([
        student(OWNER, 'certificate-owner@ku.th'),
        student(OTHER, 'certificate-other@ku.th'),
      ]);
  });

  afterAll(removeFixtures);

  it('returns an empty collection for a Student with no certificates', async () => {
    expect(await listCertificates(OWNER)).toEqual([]);
  });

  it('creates a certificate owned by the Student, without exposing userId', async () => {
    const created = await createCertificate(OWNER, certificate);

    expect(created.name).toBe(certificate.name);
    expect(created.issuer).toBe(certificate.issuer);
    expect(created.issuedAt).toBe(certificate.issuedAt);
    expect(created.verifyUrl).toBeNull();
    expect(created).not.toHaveProperty('userId');
  });

  it('persists an optional verifyUrl and orders the collection by issue date', async () => {
    await createCertificate(OWNER, {
      name: 'Certified Kubernetes Administrator',
      issuer: 'CNCF',
      issuedAt: '2023-01-15',
      verifyUrl: 'https://verify.example.com/cka',
    });

    const certificates = await listCertificates(OWNER);

    expect(certificates).toHaveLength(2);
    expect(certificates.map((record) => record.issuedAt)).toEqual(['2024-05-01', '2023-01-15']);
    expect(certificates[1]!.verifyUrl).toBe('https://verify.example.com/cka');
  });

  it('never returns another Student’s certificates', async () => {
    expect(await listCertificates(OTHER)).toEqual([]);
  });

  it('reads a single owned certificate', async () => {
    const [owned] = await listCertificates(OWNER);

    expect((await findCertificate(OWNER, owned!.id))?.id).toBe(owned!.id);
  });

  it('hides another Student’s certificate behind the missing-record result', async () => {
    const [owned] = await listCertificates(OWNER);

    expect(await findCertificate(OTHER, owned!.id)).toBeUndefined();
  });

  it('returns nothing for a certificate that does not exist', async () => {
    expect(await findCertificate(OWNER, MISSING_ID)).toBeUndefined();
  });

  it('updates only the supplied fields and bumps updatedAt', async () => {
    const [owned] = await listCertificates(OWNER);
    const patched = await updateCertificate(OWNER, owned!.id, { name: 'Renamed certificate' });

    expect(patched?.name).toBe('Renamed certificate');
    expect(patched?.issuer).toBe(owned!.issuer);
    expect(patched?.issuedAt).toBe(owned!.issuedAt);
    expect(patched!.updatedAt > owned!.updatedAt).toBe(true);
  });

  it('clears verifyUrl when it is explicitly set to null', async () => {
    const withUrl = (await listCertificates(OWNER)).find((record) => record.verifyUrl !== null);
    const patched = await updateCertificate(OWNER, withUrl!.id, { verifyUrl: null });

    expect(patched?.verifyUrl).toBeNull();
  });

  it('returns the current record for an empty patch', async () => {
    const [owned] = await listCertificates(OWNER);

    expect((await updateCertificate(OWNER, owned!.id, {}))?.id).toBe(owned!.id);
  });

  it('does not update another Student’s certificate', async () => {
    const [owned] = await listCertificates(OWNER);

    expect(await updateCertificate(OTHER, owned!.id, { name: 'Taken over' })).toBeUndefined();
    expect((await findCertificate(OWNER, owned!.id))?.name).toBe(owned!.name);
  });

  it('does not delete another Student’s certificate', async () => {
    const [owned] = await listCertificates(OWNER);

    expect(await deleteCertificate(OTHER, owned!.id)).toBeUndefined();
    expect(await findCertificate(OWNER, owned!.id)).toBeDefined();
  });

  it('deletes an owned certificate exactly once', async () => {
    const [owned] = await listCertificates(OWNER);

    expect((await deleteCertificate(OWNER, owned!.id))?.id).toBe(owned!.id);
    expect(await findCertificate(OWNER, owned!.id)).toBeUndefined();
    expect(await deleteCertificate(OWNER, owned!.id)).toBeUndefined();
  });
});
