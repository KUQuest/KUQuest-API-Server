import { db } from '@/database/client';
import { file } from '@/database/schema/file.schema';
import { profileCertificate } from '@/database/schema/profile.schema';

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Static } from 'elysia';

import type { certificateCreateSchema } from './certificate.schema';
import type { StoredCertificateImage } from './certificate.storage';

// Explicit projection so `userId` never reaches a response body. The image is
// resolved via a left join against `file`, filtered to non-tombstoned rows, so a
// deleted image reads as no image rather than a dangling reference.
const certificateColumns = {
  id: profileCertificate.id,
  version: profileCertificate.version,
  name: profileCertificate.name,
  issuer: profileCertificate.issuer,
  issuedAt: profileCertificate.issuedAt,
  createdAt: profileCertificate.createdAt,
  updatedAt: profileCertificate.updatedAt,
  imageFileId: file.id,
  imageBucket: file.bucket,
  imageObjectKey: file.objectKey,
};

const selectCertificates = () =>
  db
    .select(certificateColumns)
    .from(profileCertificate)
    .leftJoin(
      file,
      and(eq(profileCertificate.imageFileId, file.id), isNull(file.deletedAt)),
    );

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
  selectCertificates()
    .where(eq(profileCertificate.userId, userId))
    .orderBy(desc(profileCertificate.issuedAt), desc(profileCertificate.createdAt));

export const findCertificate = async (userId: string, certificateId: string) => {
  const [certificate] = await selectCertificates().where(ownedBy(userId, certificateId)).limit(1);

  return certificate;
};

export const createCertificate = async (userId: string, data: CertificateInput) => {
  const [created] = await db
    .insert(profileCertificate)
    .values({ ...data, userId })
    .returning({ id: profileCertificate.id });

  return findCertificate(userId, created.id);
};

export function updateCertificate(
  userId: string,
  certificateId: string,
  data: Partial<CertificateInput>,
): Promise<Certificate | undefined>;
export function updateCertificate(
  userId: string,
  certificateId: string,
  data: Partial<CertificateInput>,
  expectedVersion: number,
): Promise<Certificate | { outcome: 'conflict' } | undefined>;
export async function updateCertificate(
  userId: string,
  certificateId: string,
  data: Partial<CertificateInput>,
  expectedVersion?: number,
): Promise<Certificate | { outcome: 'conflict' } | undefined> {
  // Drizzle rejects an empty `set`, and an empty patch has nothing to write —
  // fall back to a plain read so the caller still gets the current record.
  if (Object.keys(data).length === 0) {
    const current = await findCertificate(userId, certificateId);
    if (!current || expectedVersion === undefined || current.version === expectedVersion) return current;
    return { outcome: 'conflict' };
  }

  const [updated] = await db
    .update(profileCertificate)
    .set({ ...data, updatedAt: new Date(), version: sql`${profileCertificate.version} + 1` })
    .where(
      expectedVersion === undefined
        ? ownedBy(userId, certificateId)
        : and(ownedBy(userId, certificateId), eq(profileCertificate.version, expectedVersion)),
    )
    .returning({ id: profileCertificate.id });

  if (!updated) return expectedVersion === undefined ? undefined : { outcome: 'conflict' as const };

  return findCertificate(userId, updated.id);
};

export function deleteCertificate(
  userId: string,
  certificateId: string,
): Promise<{ id: string } | undefined>;
export function deleteCertificate(
  userId: string,
  certificateId: string,
  expectedVersion: number,
): Promise<{ id: string; version?: number } | { outcome: 'conflict' } | undefined>;
export async function deleteCertificate(
  userId: string,
  certificateId: string,
  expectedVersion?: number,
): Promise<{ id: string; version?: number } | { outcome: 'conflict' } | undefined> {
  const [current] = await db
    .select({ version: profileCertificate.version })
    .from(profileCertificate)
    .where(ownedBy(userId, certificateId))
    .limit(1);
  if (!current) return undefined;
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    return { outcome: 'conflict' as const };
  }

  const [certificate] = await db
    .delete(profileCertificate)
    .where(
      expectedVersion === undefined
        ? ownedBy(userId, certificateId)
        : and(ownedBy(userId, certificateId), eq(profileCertificate.version, expectedVersion)),
    )
    .returning({ id: profileCertificate.id });

  return certificate ? { id: certificate.id, version: current.version + 1 } : { outcome: 'conflict' as const };
};

export function replaceCertificateImage(
  userId: string,
  certificateId: string,
  storedImage: StoredCertificateImage,
): Promise<{ fileId: string; previousFileId: string | null } | undefined>;
export function replaceCertificateImage(
  userId: string,
  certificateId: string,
  storedImage: StoredCertificateImage,
  expectedVersion: number,
): Promise<
  | { fileId: string; previousFileId: string | null; version: number }
  | { outcome: 'conflict' }
  | undefined
>;
export async function replaceCertificateImage(
  userId: string,
  certificateId: string,
  storedImage: StoredCertificateImage,
  expectedVersion?: number,
): Promise<
  | { fileId: string; previousFileId: string | null }
  | { fileId: string; previousFileId: string | null; version: number }
  | { outcome: 'conflict' }
  | undefined
> {
  return db.transaction(async (transaction) => {
    const [certificate] = await transaction
      .select({
        id: profileCertificate.id,
        previousFileId: profileCertificate.imageFileId,
        version: profileCertificate.version,
      })
      .from(profileCertificate)
      .where(ownedBy(userId, certificateId))
      .limit(1)
      .for('update');

    if (!certificate) return undefined;
    if (expectedVersion !== undefined && certificate.version !== expectedVersion) {
      return { outcome: 'conflict' };
    }

    const [createdFile] = await transaction
      .insert(file)
      .values({
        ...storedImage,
        uploadedByUserId: userId,
      })
      .returning({ fileId: file.id });

    await transaction
      .update(profileCertificate)
      .set({
        imageFileId: createdFile.fileId,
        updatedAt: new Date(),
        version: sql`${profileCertificate.version} + 1`,
      })
      .where(
        expectedVersion === undefined
          ? ownedBy(userId, certificateId)
          : and(ownedBy(userId, certificateId), eq(profileCertificate.version, expectedVersion)),
      );

    return {
      ...createdFile,
      previousFileId: certificate.previousFileId,
      version: certificate.version + 1,
    };
  });
}

export const getPreviousCertificateImageFile = async (
  userId: string,
  fileId: string,
): Promise<{ bucket: string; objectKey: string } | undefined> => {
  const [previousFile] = await db
    .select({
      bucket: file.bucket,
      objectKey: file.objectKey,
    })
    .from(file)
    .where(
      and(
        eq(file.id, fileId),
        eq(file.uploadedByUserId, userId),
        isNull(file.deletedAt),
      ),
    )
    .limit(1);

  return previousFile;
};

export const deleteCertificateImage = async (
  userId: string,
  certificateId: string,
  expectedVersion?: number,
): Promise<
  | { version: number; bucket: string; objectKey: string }
  | { outcome: 'not-found' }
  | { outcome: 'conflict' }
> =>
  db.transaction(async (transaction) => {
    const [certificate] = await transaction
      .select({
        version: profileCertificate.version,
        fileId: profileCertificate.imageFileId,
        bucket: file.bucket,
        objectKey: file.objectKey,
      })
      .from(profileCertificate)
      .leftJoin(file, and(eq(profileCertificate.imageFileId, file.id), isNull(file.deletedAt)))
      .where(ownedBy(userId, certificateId))
      .limit(1)
      .for('update', { of: profileCertificate });
    if (!certificate) return { outcome: 'not-found' };
    if (expectedVersion !== undefined && certificate.version !== expectedVersion) {
      return { outcome: 'conflict' };
    }
    if (!certificate.fileId || !certificate.bucket || !certificate.objectKey) {
      return { outcome: 'not-found' };
    }

    await transaction
      .update(profileCertificate)
      .set({ imageFileId: null, version: sql`${profileCertificate.version} + 1`, updatedAt: new Date() })
      .where(
        expectedVersion === undefined
          ? ownedBy(userId, certificateId)
          : and(ownedBy(userId, certificateId), eq(profileCertificate.version, expectedVersion)),
      );
    await transaction.update(file).set({ deletedAt: new Date() }).where(eq(file.id, certificate.fileId));

    return { version: certificate.version + 1, bucket: certificate.bucket, objectKey: certificate.objectKey };
  });

export const markCertificateImageDeleted = async (
  userId: string,
  fileId: string,
): Promise<void> => {
  await db
    .update(file)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(file.id, fileId),
        eq(file.uploadedByUserId, userId),
      ),
    );
};
