import { db } from '@/database/client';
import { profileCertificate } from '@/database/schema/profile.schema';

import { and, desc, eq } from 'drizzle-orm';
import type { Static } from 'elysia';

import type { certificateCreateSchema } from './certificate.schema';

// Explicit projection so `userId` never reaches a response body.
const certificateColumns = {
  id: profileCertificate.id,
  name: profileCertificate.name,
  issuer: profileCertificate.issuer,
  issuedAt: profileCertificate.issuedAt,
  verifyUrl: profileCertificate.verifyUrl,
  createdAt: profileCertificate.createdAt,
  updatedAt: profileCertificate.updatedAt,
};

// Derived from the request schema so the accepted fields cannot drift from what
// the route validates.
export type CertificateInput = Static<typeof certificateCreateSchema>;

// One name for a certificate row as callers receive it — inferred from the query
// so it tracks the `certificateColumns` projection, and so excludes `userId`.
export type Certificate = Awaited<ReturnType<typeof listCertificates>>[number];

// Every query is scoped by `userId`, so a certificate belonging to another
// Student is indistinguishable from one that does not exist — ownership is
// enforced by the query itself rather than by a separate read-then-check.
const ownedBy = (userId: string, certificateId: string) =>
  and(eq(profileCertificate.id, certificateId), eq(profileCertificate.userId, userId));

export const listCertificates = async (userId: string) =>
  db
    .select(certificateColumns)
    .from(profileCertificate)
    .where(eq(profileCertificate.userId, userId))
    .orderBy(desc(profileCertificate.issuedAt), desc(profileCertificate.createdAt));

export const findCertificate = async (userId: string, certificateId: string) => {
  const [certificate] = await db
    .select(certificateColumns)
    .from(profileCertificate)
    .where(ownedBy(userId, certificateId))
    .limit(1);

  return certificate;
};

export const createCertificate = async (userId: string, data: CertificateInput) => {
  const [certificate] = await db
    .insert(profileCertificate)
    .values({ ...data, userId })
    .returning(certificateColumns);

  return certificate;
};

export const updateCertificate = async (
  userId: string,
  certificateId: string,
  data: Partial<CertificateInput>,
) => {
  // Drizzle rejects an empty `set`, and an empty patch has nothing to write —
  // fall back to a plain read so the caller still gets the current record.
  if (Object.keys(data).length === 0) return findCertificate(userId, certificateId);

  const [certificate] = await db
    .update(profileCertificate)
    .set({ ...data, updatedAt: new Date() })
    .where(ownedBy(userId, certificateId))
    .returning(certificateColumns);

  return certificate;
};

export const deleteCertificate = async (userId: string, certificateId: string) => {
  const [certificate] = await db
    .delete(profileCertificate)
    .where(ownedBy(userId, certificateId))
    .returning({ id: profileCertificate.id });

  return certificate;
};
