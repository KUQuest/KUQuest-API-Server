import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import { readResourceVersion } from '@/shared/resource-version';
import type { ApiResponse } from '@/shared/api-response';
import { ImageTooLargeError, ImageUploadError, UnsupportedImageTypeError } from '@/shared/image-storage';

import type { Static } from 'elysia';

import type {
  portfolioCreateSchema,
  portfolioImageParamSchema,
  portfolioImageUploadSchema,
  portfolioListRespondSchema,
  portfolioParamSchema,
  portfolioUpdateSchema,
} from './portfolio.schema';
import {
  createPortfolio,
  deletePortfolio,
  listPortfolio,
  markPortfolioImageDeleted,
  deletePortfolioImage,
  replacePortfolioImage,
  updatePortfolio,
} from './portfolio.service';
import type { PortfolioImage, PortfolioItem } from './portfolio.service';
import { portfolioStorage } from './portfolio.storage';
import type { StoredPortfolioImage } from './portfolio.storage';

type PortfolioListItem = Static<typeof portfolioListRespondSchema>['data'][number];

const portfolioNotFound = (set: AuthedContext['set']) => {
  set.status = 404;

  return apiError('PORTFOLIO_NOT_FOUND', 'Portfolio item not found');
};

const discardUploadedImages = async (images: StoredPortfolioImage[]): Promise<void> => {
  await Promise.all(
    images.map(async (image) => {
      try {
        await portfolioStorage.delete(image.bucket, image.objectKey);
      } catch (error) {
        console.error('[portfolio-upload] Compensating object deletion failed', {
          bucket: image.bucket,
          error,
          objectKey: image.objectKey,
        });
      }
    }),
  );
};

const buildImage = (image: PortfolioImage): PortfolioListItem['images'][number] | undefined => {
  try {
    return { fileId: image.fileId, position: image.position, url: portfolioStorage.linkFor(image) };
  } catch (error) {
    console.error('Building the portfolio image link failed', error);

    return undefined;
  }
};

export const serializePortfolioItem = (item: PortfolioItem): PortfolioListItem => ({
  id: item.id,
  version: item.version,
  title: item.title,
  description: item.description,
  createdAt: item.createdAt.toISOString(),
  images: item.images
    .map(buildImage)
    .filter((image): image is NonNullable<typeof image> => image !== undefined),
});

export const listOwnPortfolio = async ({
  session,
}: AuthedContext): Promise<ApiResponse<PortfolioListItem[]>> => {
  const items = await listPortfolio(session.user.id);

  return apiSuccess(items.map(serializePortfolioItem));
};

export const createOwnPortfolio = async ({
  body,
  session,
  set,
}: AuthedContext & { body: Static<typeof portfolioCreateSchema> }): Promise<
  ApiResponse<{ id: string }>
> => {
  const uploaded: StoredPortfolioImage[] = [];

  try {
    for (const image of body.images) {
      uploaded.push(await portfolioStorage.upload(session.user.id, image));
    }
  } catch (error) {
    await discardUploadedImages(uploaded);

    if (error instanceof ImageTooLargeError) {
      set.status = 413;
      return apiError('IMAGE_TOO_LARGE', error.message);
    }
    if (error instanceof UnsupportedImageTypeError) {
      set.status = 415;
      return apiError('UNSUPPORTED_IMAGE_TYPE', error.message);
    }
    if (error instanceof ImageUploadError) {
      set.status = 502;
      return apiError('IMAGE_UPLOAD_FAILED', 'Image upload failed');
    }
    throw error;
  }

  try {
    const created = await createPortfolio(session.user.id, {
      title: body.title,
      description: body.description,
      images: uploaded,
    });

    return apiSuccess({ id: created.id });
  } catch (error) {
    await discardUploadedImages(uploaded);
    throw error;
  }
};

export const updateOwnPortfolio = async ({
  params,
  body,
  request,
  session,
  set,
}: AuthedContext & {
  params: Static<typeof portfolioParamSchema>;
  body: Static<typeof portfolioUpdateSchema>;
}): Promise<ApiResponse> => {
  const versionHeader = readResourceVersion(request);
  if (versionHeader.invalid) {
    set.status = 400;
    return apiError('INVALID_VERSION', 'Resource version must be a positive integer');
  }

  const outcome = await updatePortfolio(
    session.user.id,
    params.portfolioId,
    body,
    versionHeader.value,
  );

  if (outcome === 'not-found') return portfolioNotFound(set);
  if (outcome === 'conflict') {
    set.status = 409;
    return apiError('CONFLICT', 'Portfolio was changed by another request');
  }

  return apiSuccess();
};

export const replaceOwnPortfolioImage = async ({
  body,
  params,
  request,
  session,
  set,
}: AuthedContext & {
  params: Static<typeof portfolioImageParamSchema>;
  body: Static<typeof portfolioImageUploadSchema>;
}): Promise<ApiResponse<{ version: number }>> => {
  const versionHeader = readResourceVersion(request);
  if (versionHeader.invalid) {
    set.status = 400;
    return apiError('INVALID_VERSION', 'Resource version must be a positive integer');
  }
  let uploaded: StoredPortfolioImage;
  try {
    uploaded = await portfolioStorage.upload(session.user.id, body.image);
  } catch (error) {
    if (error instanceof ImageTooLargeError) {
      set.status = 413;
      return apiError('IMAGE_TOO_LARGE', error.message);
    }
    if (error instanceof UnsupportedImageTypeError) {
      set.status = 415;
      return apiError('UNSUPPORTED_IMAGE_TYPE', error.message);
    }
    if (error instanceof ImageUploadError) {
      set.status = 502;
      return apiError('IMAGE_UPLOAD_FAILED', 'Image upload failed');
    }
    throw error;
  }
  try {
    const result = await replacePortfolioImage(
      session.user.id,
      params.portfolioId,
      uploaded,
      params.fileId,
      versionHeader.value,
    );
    if ('outcome' in result) {
      await portfolioStorage.delete(uploaded.bucket, uploaded.objectKey);
      if (result.outcome === 'conflict') {
        set.status = 409;
        return apiError('CONFLICT', 'Portfolio was changed by another request');
      }
      return portfolioNotFound(set);
    }
    try {
      await portfolioStorage.delete(result.previousBucket, result.previousObjectKey);
      await markPortfolioImageDeleted(session.user.id, result.previousFileId);
    } catch (error) {
      console.error('[portfolio-image-replacement] Previous image cleanup failed', {
        error,
        fileId: result.previousFileId,
      });
    }

    return apiSuccess({ version: result.version });
  } catch (error) {
    await portfolioStorage.delete(uploaded.bucket, uploaded.objectKey).catch(() => undefined);
    throw error;
  }
};

export const deleteOwnPortfolioImage = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & { params: Static<typeof portfolioImageParamSchema> }): Promise<ApiResponse<{ version: number }>> => {
  const versionHeader = readResourceVersion(request);
  if (versionHeader.invalid) {
    set.status = 400;
    return apiError('INVALID_VERSION', 'Resource version must be a positive integer');
  }
  const result = await deletePortfolioImage(session.user.id, params.portfolioId, params.fileId, versionHeader.value);
  if (result.outcome === 'not-found') return portfolioNotFound(set);
  if (result.outcome === 'conflict') {
    set.status = 409;
    return apiError('CONFLICT', 'Portfolio was changed by another request');
  }
  await portfolioStorage.delete(result.bucket, result.objectKey).catch(() => undefined);
  return apiSuccess({ version: result.version });
};

export const deleteOwnPortfolio = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & { params: Static<typeof portfolioParamSchema> }): Promise<ApiResponse<{ version: number }>> => {
  const versionHeader = readResourceVersion(request);
  if (versionHeader.invalid) {
    set.status = 400;
    return apiError('INVALID_VERSION', 'Resource version must be a positive integer');
  }

  const result = await deletePortfolio(session.user.id, params.portfolioId, versionHeader.value);

  if (result.outcome === 'not-found') return portfolioNotFound(set);
  if (result.outcome === 'conflict') {
    set.status = 409;
    return apiError('CONFLICT', 'Portfolio was changed by another request');
  }

  await Promise.all(
    result.images.map(async (image) => {
      try {
        await portfolioStorage.delete(image.bucket, image.objectKey);
        await markPortfolioImageDeleted(session.user.id, image.fileId);
      } catch (error) {
        console.error('[portfolio-delete] Image cleanup failed', {
          error,
          fileId: image.fileId,
        });
      }
    }),
  );

  return apiSuccess({ version: result.version });
};
