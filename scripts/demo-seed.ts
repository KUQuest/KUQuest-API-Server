import { env } from '@/config/env';
import { db } from '@/database/client';
import { file } from '@/database/schema/file.schema';
import { isValidAdminPassword } from '@/modules/auth/admin-auth.policy';

import { and, eq } from 'drizzle-orm';

export const assertDemoSeedEnvironment = (): void => {
  const development = env.nodeEnv === 'development' && env.deploymentEnv === 'development';
  const staging = env.nodeEnv === 'production' && env.deploymentEnv === 'staging';
  if (!development && !staging) {
    throw new Error(
      'The demo seed is allowed only in development/development or production/staging.'
    );
  }
  // Keep the old finance seed's production-provider protection for the unified flow.
  if (env.xenditSecretKey && !env.xenditSecretKey.startsWith('xnd_development_')) {
    throw new Error(
      'The demo seed requires an Xendit Development API key when Xendit is configured.'
    );
  }
};

export const demoPassword = (): string => {
  const password = env.stagingTestAuthPassword;
  if (!password || !isValidAdminPassword(password)) {
    throw new Error('Set STAGING_TEST_AUTH_PASSWORD to a compliant demo login password.');
  }
  return password;
};

export const storeDemoImage = async (
  userId: string,
  objectKey: string,
  assetName: string
): Promise<string> => {
  if (
    !env.s3Bucket ||
    !env.s3Endpoint ||
    !env.s3AccessKeyId ||
    !env.s3SecretAccessKey ||
    !env.s3Region
  ) {
    throw new Error(
      'S3 storage configuration is incomplete. Demo pictures require object storage.'
    );
  }
  const [existing] = await db
    .select({ id: file.id })
    .from(file)
    .where(and(eq(file.bucket, env.s3Bucket), eq(file.objectKey, objectKey)))
    .limit(1);
  if (existing) return existing.id;
  const contentType = 'image/jpeg';
  const bytes = await Bun.file(
    new URL(`./demo-assets/${assetName}`, import.meta.url)
  ).arrayBuffer();
  if (new Uint8Array(bytes)[0] !== 0xff || new Uint8Array(bytes)[1] !== 0xd8)
    throw new Error(`Invalid demo JPEG: ${assetName}`);
  if (bytes.byteLength > 5 * 1024 * 1024) throw new Error('Demo picture exceeds 5 MB.');
  const storage = new Bun.S3Client({
    accessKeyId: env.s3AccessKeyId,
    secretAccessKey: env.s3SecretAccessKey,
    bucket: env.s3Bucket,
    endpoint: env.s3Endpoint,
    region: env.s3Region,
  });
  const written = await storage.write(objectKey, new Uint8Array(bytes), { type: contentType });
  if (written !== bytes.byteLength) throw new Error('Demo picture upload was incomplete.');
  const [stored] = await db
    .insert(file)
    .values({
      bucket: env.s3Bucket,
      objectKey,
      contentType,
      sizeBytes: bytes.byteLength,
      uploadedByUserId: userId,
    })
    .onConflictDoUpdate({
      target: [file.bucket, file.objectKey],
      set: { contentType, sizeBytes: bytes.byteLength, deletedAt: null },
    })
    .returning({ id: file.id });
  if (!stored) throw new Error('Demo picture metadata was not stored.');
  return stored.id;
};
