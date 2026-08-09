import { db } from '@/database/client';
import { file } from '@/database/schema/file.schema';
import { profileCertificate } from '@/database/schema/profile.schema';

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Static } from 'elysia';

import type { certificateCreateSchema } from './certificate.schema';
import type { StoredCertificateImage } from './certificate.storage';

// Explicit projection so `userId` never reaches a response body. The image is
// resolved via a left join against `file`, filtered to non-tombstoned rows, so a
// deleted image reads as no image rather than a dangling reference.
const certificateColumns = {
  id: profileCertificate.id,
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

export const updateCertificate = async (
  userId: string,
  certificateId: string,
  data: Partial<CertificateInput>,
) => {
  // Drizzle rejects an empty `set`, and an empty patch has nothing to write —
  // fall back to a plain read so the caller still gets the current record.
  if (Object.keys(data).length === 0) return findCertificate(userId, certificateId);

  const [updated] = await db
    .update(profileCertificate)
    .set({ ...data, updatedAt: new Date() })
    .where(ownedBy(userId, certificateId))
    .returning({ id: profileCertificate.id });

  if (!updated) return undefined;

  return findCertificate(userId, updated.id);
};

export const deleteCertificate = async (userId: string, certificateId: string) => {
  const [certificate] = await db
    .delete(profileCertificate)
    .where(ownedBy(userId, certificateId))
    .returning({ id: profileCertificate.id });

  return certificate;
};

export const replaceCertificateImage = async (
  userId: string,
  certificateId: string,
  storedImage: StoredCertificateImage,
): Promise<{ fileId: string; previousFileId: string | null } | undefined> =>
  db.transaction(async (transaction) => {
    const [certificate] = await transaction
      .select({
        id: profileCertificate.id,
        previousFileId: profileCertificate.imageFileId,
      })
      .from(profileCertificate)
      .where(ownedBy(userId, certificateId))
      .limit(1)
      .for('update');

    if (!certificate) return undefined;

    const [createdFile] = await transaction
      .insert(file)
      .values({
        ...storedImage,
        uploadedByUserId: userId,
      })
      .returning({ fileId: file.id });

    await transaction
      .update(profileCertificate)
      .set({ imageFileId: createdFile.fileId, updatedAt: new Date() })
      .where(ownedBy(userId, certificateId));

    return {
      ...createdFile,
      previousFileId: certificate.previousFileId,
    };
  });

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
