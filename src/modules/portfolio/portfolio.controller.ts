import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { ImageTooLargeError, ImageUploadError, UnsupportedImageTypeError } from '@/shared/image-storage';

import type { Static } from 'elysia';

import type {
  portfolioCreateSchema,
  portfolioListRespondSchema,
  portfolioParamSchema,
  portfolioUpdateSchema,
} from './portfolio.schema';
import {
  createPortfolio,
  deletePortfolio,
  listPortfolio,
  markPortfolioImageDeleted,
  updatePortfolio,
} from './portfolio.service';
import type { PortfolioImage } from './portfolio.service';
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

export const listOwnPortfolio = async ({
  session,
}: AuthedContext): Promise<ApiResponse<PortfolioListItem[]>> => {
  const items = await listPortfolio(session.user.id);

  return apiSuccess(
    items.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      createdAt: item.createdAt.toISOString(),
      images: item.images
        .map(buildImage)
        .filter((image): image is NonNullable<typeof image> => image !== undefined),
    })),
  );
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
  session,
  set,
}: AuthedContext & {
  params: Static<typeof portfolioParamSchema>;
  body: Static<typeof portfolioUpdateSchema>;
}): Promise<ApiResponse> => {
  const outcome = await updatePortfolio(session.user.id, params.portfolioId, body);

  if (outcome === 'not-found') return portfolioNotFound(set);

  return apiSuccess();
};

export const deleteOwnPortfolio = async ({
  params,
  session,
  set,
}: AuthedContext & { params: Static<typeof portfolioParamSchema> }): Promise<ApiResponse> => {
  const result = await deletePortfolio(session.user.id, params.portfolioId);

  if (result.outcome === 'not-found') return portfolioNotFound(set);

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

  return apiSuccess();
};
