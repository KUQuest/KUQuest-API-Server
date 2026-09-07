import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import { readResourceVersion } from '@/shared/resource-version';
import type { ApiResponse } from '@/shared/api-response';
import {
  ImageTooLargeError,
  ImageUploadError,
  UnsupportedImageTypeError,
  createDebugLogger,
} from '@/shared/image-storage';

import type { Static } from 'elysia';

import type {
  certificateCreateSchema,
  certificateImageUploadSchema,
  certificateUpdateSchema,
} from './certificate.schema';
import type { Certificate } from './certificate.service';
import {
  createCertificate,
  deleteCertificate,
  findCertificate,
  deleteCertificateImage,
  getPreviousCertificateImageFile,
  listCertificates,
  markCertificateImageDeleted,
  replaceCertificateImage,
  updateCertificate,
} from './certificate.service';
import { certificateStorage } from './certificate.storage';

type CertificateParams = { params: { certificateId: string } };

const notFound = apiError('CERTIFICATE_NOT_FOUND', 'Certificate not found');

const debugCertificateImageUpload = createDebugLogger('certificate-image-upload');

type CertificateImage = { fileId: string; url: string } | null;

// A tombstoned or absent image reads as `null`; a link that fails to build
// (storage misconfiguration) degrades to `null` rather than a 500.
const describeImage = (certificate: Certificate): CertificateImage => {
  const { imageFileId, imageBucket, imageObjectKey } = certificate;
  if (!imageFileId || !imageBucket || !imageObjectKey) return null;

  try {
    return {
      fileId: imageFileId,
      url: certificateStorage.linkFor({ bucket: imageBucket, objectKey: imageObjectKey }),
    };
  } catch (error) {
    console.error('Building the certificate image link failed', error);

    return null;
  }
};

// Drizzle returns `createdAt`/`updatedAt` as `Date` instances; the response schema
// documents them as ISO date-time strings, so serialize before they reach a response.
export const serializeCertificate = (certificate: Certificate) => {
  const {
    imageFileId: _imageFileId,
    imageBucket: _imageBucket,
    imageObjectKey: _imageObjectKey,
    createdAt,
    updatedAt,
    ...rest
  } = certificate;

  return {
    ...rest,
    image: describeImage(certificate),
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
};

const discardUploadedImage = async (bucket: string, objectKey: string): Promise<void> => {
  try {
    await certificateStorage.delete(bucket, objectKey);
  } catch (error) {
    console.error('[certificate-image-upload] Compensating object deletion failed', {
      bucket,
      error,
      objectKey,
    });
  }
};

export const getCertificates = async ({
  session,
}: AuthedContext): Promise<
  ApiResponse<{ certificates: ReturnType<typeof serializeCertificate>[] }>
> => {
  const certificates = await listCertificates(session.user.id);

  return apiSuccess({ certificates: certificates.map(serializeCertificate) });
};

export const getCertificate = async ({
  session,
  params,
  set,
}: AuthedContext & CertificateParams): Promise<
  ApiResponse<{ certificate: ReturnType<typeof serializeCertificate> }>
> => {
  const certificate = await findCertificate(session.user.id, params.certificateId);

  if (!certificate) {
    set.status = 404;
    return notFound;
  }

  return apiSuccess({ certificate: serializeCertificate(certificate) });
};

export const postCertificate = async ({
  session,
  body,
}: AuthedContext & { body: Static<typeof certificateCreateSchema> }): Promise<
  ApiResponse<{ certificate: ReturnType<typeof serializeCertificate> }>
> => {
  const certificate = await createCertificate(session.user.id, body);

  return apiSuccess({ certificate: serializeCertificate(certificate) });
};

export const patchCertificate = async ({
  session,
  params,
  body,
  request,
  set,
}: AuthedContext &
  CertificateParams & { body: Static<typeof certificateUpdateSchema> }): Promise<
  ApiResponse<{ certificate: ReturnType<typeof serializeCertificate> }>
> => {
  const versionHeader = readResourceVersion(request);
  if (versionHeader.invalid) {
    set.status = 400;
    return apiError('INVALID_VERSION', 'Resource version must be a positive integer');
  }
  const expectedVersion = versionHeader.value;
  const certificate =
    expectedVersion === undefined
      ? await updateCertificate(session.user.id, params.certificateId, body)
      : await updateCertificate(session.user.id, params.certificateId, body, expectedVersion);

  if (!certificate) {
    set.status = 404;
    return notFound;
  }
  if ('outcome' in certificate) {
    set.status = 409;
    return apiError('CONFLICT', 'Certificate was changed by another request');
  }

  return apiSuccess({ certificate: serializeCertificate(certificate) });
};

export const removeCertificate = async ({
  session,
  params,
  request,
  set,
}: AuthedContext & CertificateParams): Promise<ApiResponse<{ version: number }>> => {
  const versionHeader = readResourceVersion(request);
  if (versionHeader.invalid) {
    set.status = 400;
    return apiError('INVALID_VERSION', 'Resource version must be a positive integer');
  }
  const expectedVersion = versionHeader.value;
  const deleted =
    expectedVersion === undefined
      ? await deleteCertificate(session.user.id, params.certificateId)
      : await deleteCertificate(session.user.id, params.certificateId, expectedVersion);

  if (!deleted) {
    set.status = 404;
    return notFound;
  }
  if ('outcome' in deleted && deleted.outcome === 'conflict') {
    set.status = 409;
    return apiError('CONFLICT', 'Certificate was changed by another request');
  }

  const version = 'version' in deleted && typeof deleted.version === 'number' ? deleted.version : 1;
  return apiSuccess({ version });
};

export const deleteCertificateImageController = async ({
  session,
  params,
  request,
  set,
}: AuthedContext & CertificateParams): Promise<ApiResponse<{ version: number }>> => {
  const versionHeader = readResourceVersion(request);
  if (versionHeader.invalid) {
    set.status = 400;
    return apiError('INVALID_VERSION', 'Resource version must be a positive integer');
  }
  const result = await deleteCertificateImage(
    session.user.id,
    params.certificateId,
    versionHeader.value,
  );
  if ('outcome' in result) {
    if (result.outcome === 'conflict') {
      set.status = 409;
      return apiError('CONFLICT', 'Certificate was changed by another request');
    }
    set.status = 404;
    return notFound;
  }
  try {
    await certificateStorage.delete(result.bucket, result.objectKey);
  } catch (error) {
    console.error('[certificate-image-delete] Object cleanup failed', error);
  }
  return apiSuccess({ version: result.version });
};

export const setCertificateImage = async ({
  body,
  session,
  params,
  request,
  set,
}: AuthedContext &
  CertificateParams & { body: Static<typeof certificateImageUploadSchema> }): Promise<
  ApiResponse<{ image: { fileId: string; url: string }; version?: number }>
> => {
  let storedImage;

  debugCertificateImageUpload('Request received', {
    certificateId: params.certificateId,
    declaredContentType: body.image.type,
    sizeBytes: body.image.size,
    userId: session.user.id,
  });

  try {
    storedImage = await certificateStorage.upload(session.user.id, body.image);
  } catch (error) {
    if (error instanceof ImageTooLargeError) {
      set.status = 413;
      return apiError('CERTIFICATE_IMAGE_TOO_LARGE', error.message);
    }
    if (error instanceof UnsupportedImageTypeError) {
      set.status = 415;
      return apiError('UNSUPPORTED_CERTIFICATE_IMAGE_TYPE', error.message);
    }
    if (error instanceof ImageUploadError) {
      set.status = 502;
      return apiError('CERTIFICATE_IMAGE_UPLOAD_FAILED', 'Certificate image upload failed');
    }
    throw error;
  }

  try {
    const versionHeader = readResourceVersion(request);
    if (versionHeader.invalid) {
      await discardUploadedImage(storedImage.bucket, storedImage.objectKey);
      set.status = 400;
      return apiError('INVALID_VERSION', 'Resource version must be a positive integer');
    }
    const expectedVersion = versionHeader.value;
    const result = (expectedVersion === undefined
      ? await replaceCertificateImage(session.user.id, params.certificateId, storedImage)
      : await replaceCertificateImage(
          session.user.id,
          params.certificateId,
          storedImage,
          expectedVersion,
        )) as
      | { fileId: string; previousFileId: string | null; version?: number }
      | { outcome: 'conflict' }
      | undefined;

    if (!result) {
      debugCertificateImageUpload('Certificate not found or not owned', {
        certificateId: params.certificateId,
        userId: session.user.id,
      });
      await discardUploadedImage(storedImage.bucket, storedImage.objectKey);
      set.status = 404;
      return notFound;
    }

    if ('outcome' in result) {
      await discardUploadedImage(storedImage.bucket, storedImage.objectKey);
      set.status = 409;
      return apiError('CONFLICT', 'Certificate was changed by another request');
    }

    debugCertificateImageUpload('Database pointer updated', {
      fileId: result.fileId,
      previousFileId: result.previousFileId,
      userId: session.user.id,
    });

    if (result.previousFileId) {
      try {
        const previousFile = await getPreviousCertificateImageFile(
          session.user.id,
          result.previousFileId,
        );
        if (previousFile) {
          await certificateStorage.delete(previousFile.bucket, previousFile.objectKey);
          await markCertificateImageDeleted(session.user.id, result.previousFileId);
          debugCertificateImageUpload('Previous certificate image cleanup completed', {
            previousFileId: result.previousFileId,
            userId: session.user.id,
          });
        }
      } catch (error) {
        console.error('Previous certificate image cleanup failed', error);
      }
    }

    return apiSuccess({
      image: { fileId: result.fileId, url: certificateStorage.linkFor(storedImage) },
      version: result.version ?? 1,
    });
  } catch (error) {
    await discardUploadedImage(storedImage.bucket, storedImage.objectKey);
    throw error;
  }
};
