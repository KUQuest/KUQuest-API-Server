import { env } from '@/config/env';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import {
  profileCertificate,
  profilePortfolioItem,
  profilePortfolioItemImage,
} from '@/database/schema/profile.schema';

import { eq, inArray } from 'drizzle-orm';

const DEMO_EMAILS = [
  'nattapong.srisawat@ku.th',
  'warisara.boonmee@ku.th',
  'thanakrit.chaiyasit@ku.th',
  'supitcha.wongsakul@ku.th',
  'kritchapon.phromma@ku.th',
  'aphinya.sukjai@ku.th',
  'pattarapon.ruangrit@ku.th',
  'chutimon.thepsuriya@ku.th',
  'ekkapop.wattana@ku.th',
  'nichakan.kaewmanee@ku.th',
] as const;

const downloadImage = async (url: string): Promise<{ bytes: Uint8Array; contentType: 'image/jpeg' }> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image download failed with HTTP ${response.status}: ${url}`);

  const contentType = response.headers.get('content-type')?.split(';')[0];
  if (contentType !== 'image/jpeg') {
    throw new Error(`Expected a JPEG image but received ${contentType ?? 'unknown'}: ${url}`);
  }

  return { bytes: new Uint8Array(await response.arrayBuffer()), contentType };
};

const s3 = new Bun.S3Client({
  accessKeyId: env.s3AccessKeyId,
  secretAccessKey: env.s3SecretAccessKey,
  bucket: env.s3Bucket,
  endpoint: env.s3Endpoint,
  region: env.s3Region,
});

const storeImage = async (
  userId: string,
  objectKey: string,
  image: { bytes: Uint8Array; contentType: 'image/jpeg' },
): Promise<string> => {
  const fileBytes = new ArrayBuffer(image.bytes.byteLength);
  new Uint8Array(fileBytes).set(image.bytes);
  const writtenBytes = await s3.write(
    objectKey,
    new File([fileBytes], objectKey.split('/').pop() ?? 'demo.jpg', {
      type: image.contentType,
    }),
    { type: image.contentType },
  );
  if (writtenBytes !== image.bytes.length) {
    throw new Error(`Image upload wrote ${writtenBytes} bytes instead of ${image.bytes.length}`);
  }

  const [storedFile] = await db
    .insert(file)
    .values({
      bucket: env.s3Bucket!,
      objectKey,
      contentType: image.contentType,
      sizeBytes: image.bytes.length,
      uploadedByUserId: userId,
      deletedAt: null,
    })
    .onConflictDoUpdate({
      target: [file.bucket, file.objectKey],
      set: {
        contentType: image.contentType,
        sizeBytes: image.bytes.length,
        uploadedByUserId: userId,
        deletedAt: null,
      },
    })
    .returning({ id: file.id });

  if (!storedFile) throw new Error(`Failed to store file metadata for ${objectKey}`);
  return storedFile.id;
};

const main = async (): Promise<void> => {
  if (!env.s3Bucket || !env.s3Endpoint || !env.s3AccessKeyId || !env.s3SecretAccessKey || !env.s3Region) {
    throw new Error('S3 storage configuration is incomplete');
  }

  const demoUsers = await db
    .select({ id: authUser.id, email: authUser.email })
    .from(authUser)
    .where(inArray(authUser.email, DEMO_EMAILS));
  if (demoUsers.length !== DEMO_EMAILS.length) {
    throw new Error('Run db:seed-demo-users and db:seed-frontend-demo first');
  }

  let avatarCount = 0;
  let portfolioImageCount = 0;
  let certificateImageCount = 0;

  for (const [index, user] of demoUsers.entries()) {
    const avatar = await downloadImage(`https://i.pravatar.cc/512?img=${(index % 70) + 1}`);
    const avatarFileId = await storeImage(
      user.id,
      `avatars/${user.id}/demo-avatar.jpg`,
      avatar,
    );
    await db.update(authUser).set({ imageFileId: avatarFileId }).where(eq(authUser.id, user.id));
    avatarCount += 1;

    const [portfolio] = await db
      .select({ id: profilePortfolioItem.id })
      .from(profilePortfolioItem)
      .where(eq(profilePortfolioItem.userId, user.id))
      .limit(1);
    if (portfolio) {
      const image = await downloadImage(
        `https://picsum.photos/seed/kuquest-portfolio-${index}/1200/800`,
      );
      const imageFileId = await storeImage(
        user.id,
        `portfolio/${user.id}/demo-portfolio.jpg`,
        image,
      );
      await db.delete(profilePortfolioItemImage).where(eq(profilePortfolioItemImage.portfolioItemId, portfolio.id));
      await db.insert(profilePortfolioItemImage).values({
        portfolioItemId: portfolio.id,
        fileId: imageFileId,
        position: 0,
      });
      portfolioImageCount += 1;
    }

    const certificates = await db
      .select({ id: profileCertificate.id })
      .from(profileCertificate)
      .where(eq(profileCertificate.userId, user.id));
    for (const [certificateIndex, certificate] of certificates.entries()) {
      const image = await downloadImage(
        `https://picsum.photos/seed/kuquest-certificate-${index}-${certificateIndex}/1200/800`,
      );
      const imageFileId = await storeImage(
        user.id,
        `certificates/${user.id}/demo-certificate-${certificateIndex}.jpg`,
        image,
      );
      await db
        .update(profileCertificate)
        .set({ imageFileId })
        .where(eq(profileCertificate.id, certificate.id));
      certificateImageCount += 1;
    }
  }

  console.log(`Uploaded ${avatarCount} avatars.`);
  console.log(`Uploaded ${portfolioImageCount} Portfolio images.`);
  console.log(`Uploaded ${certificateImageCount} Certificate images.`);
};

try {
  await main();
} finally {
  await sql.end();
}
